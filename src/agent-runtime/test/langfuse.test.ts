import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { createAgentRuntime } from "../index.ts";
import { startMockProvider } from "../../../mock-data/mock-provider.ts";

const homes: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))); });

it.each([false, true])("Runtime 同时记录前台和后台，导出故障=%s 不改变任务结果", async (failExport) => {
  // 配置读取是 { ...langfuse.env 文件, ...process.env }，process.env 优先。只 stub ENABLED 时，
  // 宿主里真实的 BASE_URL 与密钥会覆盖下面文件里的 langfuse.invalid，导出请求会绕过 fetch stub
  // 打向真实地址，在 5 秒网络超时与 5 秒退避之间耗尽用例超时。这里把整套变量固定住。
  vi.stubEnv("LANGFUSE_ENABLED", "true");
  vi.stubEnv("LANGFUSE_BASE_URL", "http://langfuse.invalid");
  vi.stubEnv("LANGFUSE_PUBLIC_KEY", "p");
  vi.stubEnv("LANGFUSE_SECRET_KEY", "s");
  vi.stubEnv("LANGFUSE_PROJECT_ID", undefined);
  vi.stubEnv("LANGFUSE_CAPTURE_CONTENT", undefined);
  const home = await mkdtemp(join(tmpdir(), "runtime-langfuse-")); homes.push(home);
  const provider = await startMockProvider({ plan: () => ({ reply: "完成", toolCalls: [{ name: "read_skill", input: { name: "demo" } }, { name: "manage_memory", input: { action: "submit", intent: "remember", subject: "用户", attribute: "颜色", content: "喜欢蓝色" } }] }) });
  const requests: string[] = [];
  const originalFetch = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    if (String(url).startsWith("http://langfuse.invalid")) { requests.push(String(init?.body)); return new Response("{}", { status: failExport ? 503 : 200 }); }
    return originalFetch(url, init);
  }));
  await writeFile(join(home, "langfuse.env"), "LANGFUSE_ENABLED=true\nLANGFUSE_BASE_URL=http://langfuse.invalid\nLANGFUSE_PUBLIC_KEY=p\nLANGFUSE_SECRET_KEY=s\n");
  await writeFile(join(home, ".env"), `EVERYTHING_AGENT_API_KEY=fixture\nEVERYTHING_SMALL_API_KEY=fixture\n`);
  const model = { provider: "openai-compatible", model: "mock-agent", baseUrl: provider.baseUrl };
  await writeFile(join(home, "config.json"), JSON.stringify({ models: { agent: model, small: model } }));
  await writeFile(join(home, "EVERYTHING.md"), "你是合成测试助理");
  await mkdir(join(home, "skills/demo"), { recursive: true });
  await writeFile(join(home, "skills/demo/SKILL.md"), "---\nname: demo\ndescription: 示例\n---\n秘密技能正文");
  const runtime = createAgentRuntime({ home, defaultSystemPromptPath: join(home, "EVERYTHING.md") });
  try {
    await runtime.start(); const session = runtime.memory.createSession();
    const result = await runtime.run({ sessionId: session.id, prompt: "我喜欢蓝色，请记住" }, { signal: new AbortController().signal, observer: () => {} });
    await runtime.memory.waitForBackgroundTasks();
    expect(result.reply).toBe("完成"); expect(runtime.memory.listSemantic()).not.toHaveLength(0);
    await runtime.close();
    expect(requests).not.toHaveLength(0);
    expect(requests.join()).not.toContain("秘密技能正文"); expect(requests.join()).not.toContain("我喜欢蓝色");
    const traces = await runtime.readTraces();
    expect(traces.flatMap((file) => file.records).some((record) => record.type === "langfuse_export_failed")).toBe(failExport);
    const records = traces.flatMap(file => file.records);
    for (const type of ["gate_end", "memory_model_completed"]) {
      expect(records.find(record => record.type === type)?.payload?.tokenUsage).toMatchObject({ inputTokens: expect.any(Number), outputTokens: expect.any(Number) });
    }
    const loadedSkill = records.find(record => record.type === "skill_loaded")!;
    expect(records.some(record => record.type === "tool_started" && record.toolCallId === loadedSkill.toolCallId)).toBe(true);
    const recordedSkills = records.filter(record => record.type === "skill_loaded");
    expect(recordedSkills[0]?.payload?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(join(home, "langfuse.env"), "utf8")).toContain("LANGFUSE_SECRET_KEY=s");
  } finally { await runtime.close(); await provider.close(); }
}, 15000);
