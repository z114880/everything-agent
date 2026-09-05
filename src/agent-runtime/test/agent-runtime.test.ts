import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentRuntime, type AgentRuntime } from "../index.ts";
import type { ModelRequest, ModelResponse } from "../../agent-loop/agent-loop.ts";

const { create } = vi.hoisted(() => ({ create: vi.fn<(request: ModelRequest) => Promise<ModelResponse>>() }));
vi.mock("../../model/model-client.ts", () => ({ createModelClient: () => ({ messages: { create } }) }));
const runtimes: AgentRuntime[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
  vi.unstubAllEnvs();
  create.mockReset();
});
async function setup() {
  const home = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  homes.push(home);
  const paths = { home, envPath: join(home, ".env"), defaultSystemPromptPath: join(home, "default.md") };
  await writeFile(paths.defaultSystemPromptPath, "你是个人助理");
  await writeFile(paths.envPath, 'EVERYTHING_PROVIDER="openai-compatible"\nEVERYTHING_MODEL="test"\nOPENAI_API_KEY="test-key"\n');
  const runtime = createAgentRuntime(paths);
  runtimes.push(runtime);
  return runtime;
}
const response = (text: string): ModelResponse => ({ content: [{ type: "text", text }], stop_reason: "end_turn" });
function model(reply = "你好") {
  create.mockImplementation(async (request) => response((Array.isArray(request.tools) && request.tools.length > 0) ? reply : '{"intent":"none"}'));
}
const options = () => ({ observer: () => {}, signal: new AbortController().signal });

describe("个人助理 Runtime", () => {
  it("独立实例隔离会话、规则与密钥，保存不修改进程环境", async () => {
    vi.stubEnv("OPENAI_API_KEY", "inherited");
    const first = await setup(); const second = await setup();
    first.createSession();
    await first.saveSystemPrompt("新规则");
    await first.clearProviderApiKey("openai-compatible");
    expect(first.memory.listSessions()).toHaveLength(1);
    expect(second.memory.listSessions()).toHaveLength(0);
    expect(await first.readSystemPrompt()).toBe("新规则\n");
    expect(await second.readSystemPrompt()).toBe("你是个人助理");
    expect((await first.getSettings()).keyConfigured).toBe(false);
    expect((await second.getSettings()).keyConfigured).toBe(true);
    expect(process.env.OPENAI_API_KEY).toBe("inherited");
  });

  it("通过公开接口执行回合，保存工作记忆并关联可观察事件", async () => {
    model();
    const runtime = await setup(); const session = await runtime.createSession();
    const events: Array<{ kind: string; event: Record<string, unknown> }> = [];
    const result = await runtime.run({ sessionId: session.id, prompt: "你好" }, {
      ...options(), observer: (kind, event) => { events.push({ kind, event }); },
    });
    expect(result).toMatchObject({ reply: "你好", model: "test", provider: "openai-compatible", toolCallCount: 0 });
    expect(runtime.memory.getWorkingMemory(session.id)).toHaveLength(2);
    const kinds = events.map(({ kind }) => kind);
    expect(kinds.indexOf("gate_start")).toBeLessThan(kinds.indexOf("gate_end"));
    expect(kinds.indexOf("context_assembled")).toBeLessThan(kinds.indexOf("model_request"));
    expect(kinds.indexOf("model_request")).toBeLessThan(kinds.indexOf("model_response"));
    expect(events.every(({ event }) => event.runId === result.runId && event.sessionId === session.id)).toBe(true);
  });

  it("活动回合阻止清理和关闭，同会话排队后读取前一回合结果", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let calls = 0;
    create.mockImplementation(async (request) => {
      if (!(Array.isArray(request.tools) && request.tools.length > 0)) return response('{"intent":"none"}');
      if (++calls === 1) { entered.resolve(); await release.promise; }
      return response("完成");
    });
    const runtime = await setup(); const session = await runtime.createSession();
    const first = runtime.run({ sessionId: session.id, prompt: "第一问" }, options());
    await entered.promise;
    const second = runtime.run({ sessionId: session.id, prompt: "第二问" }, options());
    await expect(runtime.clearLocalAgentData()).rejects.toThrow("仍有 Agent 回合正在运行");
    await expect(runtime.close()).rejects.toThrow("仍有任务正在运行");
    release.resolve();
    await Promise.all([first, second]);
    const requests = create.mock.calls.map(([request]) => request).filter((request) => (Array.isArray(request.tools) && request.tools.length > 0));
    expect(requests[1]?.messages).toEqual(expect.arrayContaining([{ role: "user", content: "第一问" }]));
    expect(runtime.memory.getWorkingMemory(session.id)).toHaveLength(4);
    await runtime.saveSystemPrompt("保留规则");
    await runtime.clearLocalAgentData();
    expect(runtime.memory.listSessions()).toEqual([]);
    expect(await runtime.readSystemPrompt()).toBe("保留规则\n");
  });

  it("失败回合释放会话锁，后续回合仍能完成；关闭后拒绝重新创建资源", async () => {
    const runtime = await setup(); const session = await runtime.createSession();
    await expect(runtime.run({ sessionId: session.id, prompt: "" }, options())).rejects.toThrow("不能为空");
    model();
    await expect(runtime.run({ sessionId: session.id, prompt: "失败回合" }, {
      ...options(), observer: (kind) => { if (kind === "model_request") throw new Error("事件接收失败"); },
    })).rejects.toThrow("事件接收失败");
    expect(runtime.memory.getWorkingMemory(session.id)).toEqual([]);
    await runtime.run({ sessionId: session.id, prompt: "继续" }, options());
    await runtime.close();
    expect(() => runtime.createSession()).toThrow("已关闭");
    await expect(runtime.run({ sessionId: session.id, prompt: "继续" }, options())).rejects.toThrow("已关闭");
  });
});

describe("Runtime 配置与维护", () => {
  it("保存完整配置、恢复预算并安全公开密钥状态", async () => {
    const runtime = await setup();
    const { settings } = await runtime.saveAgentSettings({
      provider: "openai-compatible", model: "main", smallModel: "small", apiKey: "new-secret",
      baseUrl: "https://example.com/v1", force: true,
      sessionSearchWindow: 3, sessionScrollStep: 4, sessionRecallMessageLimit: 20,
      sessionRecallTokenLimit: 1024, modelContextWindow: 8192,
      retrievalMode: "lexical_only", embeddingBaseUrl: "https://example.com/v1",
      embeddingApiKey: "embedding-key", embeddingModel: "embedding",
      embeddingQueryTemplate: "问题：{text}", embeddingDocumentTemplate: "文档：{text}",
      embeddingMinimumSimilarity: 0.5,
    });
    expect(settings).toMatchObject({ model: "main", smallModel: "small", keyLast4: "cret", embeddingKeyConfigured: true, sessionSearchWindow: 3 });
    expect(JSON.stringify(settings)).not.toContain("new-secret");
    expect((await runtime.resetRuntimeSettings()).settings.sessionSearchWindow).toBe(5);
    expect((await runtime.clearEmbeddingApiKey()).settings).toMatchObject({ retrievalMode: "lexical_only", embeddingKeyConfigured: false });
    expect(runtime.cancelEmbeddingIndexRebuild()).toEqual({ cancelled: false });
    await runtime.prepareMemory();
    expect(await runtime.readTraces()).toEqual(expect.any(Array));
    await runtime.start();
    await runtime.start();
  });

  it("探测模型连接，失败时允许显式强制保存并隐藏密钥", async () => {
    const runtime = await setup();
    const fetchMock = vi.spyOn(globalThis, "fetch");
    try {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "a" }, {}] })));
      expect((await runtime.saveAgentSettings({ provider: "anthropic", model: "a", apiKey: "anthropic-secret" })).models).toEqual(["a"]);
      fetchMock.mockResolvedValueOnce(new Response("invalid secret-123", { status: 401 }));
      await expect(runtime.saveAgentSettings({ provider: "openai-compatible", model: "b", apiKey: "secret-123" })).rejects.toMatchObject({ canForce: true, message: "连接测试失败（HTTP 401）：invalid ***" });
      await runtime.saveAgentSettings({ provider: "openai-compatible", model: "b", apiKey: "secret-123", force: true });
      await runtime.saveAgentSettings({ provider: "openai-compatible", model: "b", clearApiKey: true, clearEmbeddingApiKey: true });
      expect((await runtime.getSettings()).keyConfigured).toBe(false);
      await expect(runtime.run({ sessionId: "s", prompt: "你好" }, options())).rejects.toThrow("OPENAI_API_KEY");
    } finally { fetchMock.mockRestore(); }
  });

  it.each([
    [{ sessionSearchWindow: 0 }, "Session Search Window"],
    [{ sessionScrollStep: 51 }, "Session Scroll Step"],
    [{ sessionRecallMessageLimit: 0 }, "Session Recall Message Limit"],
    [{ sessionRecallTokenLimit: 1 }, "Session Recall Token Limit"],
    [{ modelContextWindow: 1 }, "Model Context Window"],
    [{ embeddingMinimumSimilarity: 2 }, "Minimum Similarity"],
    [{ embeddingQueryTemplate: "缺少占位符" }, "Query Template"],
    [{ embeddingDocumentTemplate: "{text}{text}" }, "Document Template"],
    [{ embeddingBaseUrl: "file:///tmp/test" }, "HTTP"],
    [{ baseUrl: "file:///tmp/test" }, "HTTP"],
    [{ retrievalMode: "dense_only" as const }, "必须完整配置"],
    [{ model: "" }, "Model 不能为空"],
    [{ model: "x".repeat(201) }, "小于 200"],
  ])("拒绝无效运行配置 %j", async (patch, error) => {
    const runtime = await setup();
    await expect(runtime.saveAgentSettings({ provider: "openai-compatible", model: "test", ...patch })).rejects.toThrow(error);
  });
});

it("独立 Embedding 配置可重建空索引，并在更换模型后继续使用活动索引", async () => {
  const runtime = await setup();
  const input = { provider: "openai-compatible" as const, model: "test", retrievalMode: "hybrid" as const,
    embeddingApiKey: "embedding", embeddingBaseUrl: "https://example.com/v1", embeddingModel: "embed-a" };
  await runtime.saveAgentSettings(input);
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ data: [{ embedding: [1, 0, 0] }] })));
  try {
    await runtime.rebuildEmbeddingIndex();
    expect((await runtime.getSettings()).embeddingIndex.ready).toBe(true);
    await runtime.saveAgentSettings({ ...input, embeddingModel: "embed-b" });
    expect((await runtime.getSettings()).embeddingIndex.ready).toBe(false);
    await runtime.prepareMemory();
  } finally { fetchMock.mockRestore(); }
});

it("聊天记忆使用配置的小模型与当前证据，事件和工具摘要不暴露记忆正文", async () => {
  const runtime = await setup();
  await runtime.saveAgentSettings({ provider: "openai-compatible", model: "main", smallModel: "memory-small" });
  const session = await runtime.createSession();
  let mainCalls = 0;
  create.mockImplementation(async (request) => {
    if (request.system?.includes("你是个人助理的记忆管理模型")) {
      expect(request.model).toBe("memory-small");
      const payload = JSON.parse(String(request.messages[0]?.content));
      expect(payload.evidence[0].text).toBe("请记住我喜欢红茶");
      return response(JSON.stringify({ action: "create", reason: "私人理由：喜欢红茶", evidenceMessageIds: payload.candidate.evidenceMessageIds, subject: "饮品偏好", content: "喜欢红茶", category: "preference", stable: true, futureUseful: true }));
    }
    if (Array.isArray(request.tools) && request.tools.length > 0) {
      expect(request.model).toBe("main");
      if (++mainCalls === 1) return { content: [{ type: "tool_use", id: "memory-tool", name: "manage_memory", input: { action: "submit", intent: "remember", subject: "用户", attribute: "饮品偏好", content: "喜欢红茶" } }], stop_reason: "tool_use" };
      return response("已记住");
    }
    return response('{"intent":"none"}');
  });
  const events: Array<{ kind: string; event: Record<string, unknown> }> = [];
  await runtime.run({ sessionId: session.id, prompt: "请记住我喜欢红茶" }, { ...options(), observer: (kind, event) => { events.push({ kind, event }) } });
  expect(runtime.memory.listSemantic()).toMatchObject([{ content: "喜欢红茶" }]);
  const memoryEvents = events.filter((item) => item.kind.startsWith("memory_") || item.kind === "tool_completed");
  expect(memoryEvents.some((item) => item.kind === "memory_change_completed")).toBe(true);
  expect(JSON.stringify(memoryEvents)).not.toContain("红茶");
  const traces = (await runtime.readTraces()).flatMap((file) => file.records).filter((record) => record.type.startsWith("memory_") || record.type === "tool_completed");
  expect(traces.find((record) => record.type === "memory_model_completed")?.payload).toMatchObject({ model: "memory-small" });
  expect(traces.find((record) => record.type === "memory_change_completed")?.payload).toMatchObject({ action: "create", reasonCode: "new_fact", targetId: expect.any(Number) });
  expect(JSON.stringify(traces)).not.toContain("红茶");
});
