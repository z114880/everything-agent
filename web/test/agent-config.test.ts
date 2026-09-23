import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createAgentRuntime, type AgentRuntime } from "../../src/agent-runtime/index.ts";

const state = vi.hoisted(() => ({ runtime: null as AgentRuntime | null }));
vi.mock("../../src/index.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/index.ts")>(),
  createAgentRuntime: () => state.runtime!,
}));

it("Web 配置不再暴露或保存 Session 整理间隔", async () => {
  const home = await mkdtemp(join(tmpdir(), "web-agent-config-"));
  const paths = { home, defaultSystemPromptPath: join(home, "default.md") };
  const runtime = state.runtime = createAgentRuntime(paths);
  let reopened: AgentRuntime | undefined;
  try {
    const { saveAgentSettings } = await import("../server/agent-service.ts");
    const result = await saveAgentSettings({
      agentModel: { provider: "openai-compatible", model: "agent", baseUrl: "https://agent.example/v1" },
      smallModel: { provider: "anthropic", model: "small", baseUrl: "https://small.example" },
      force: true,
      maxTokens: 24_576, maxIterations: 100,
    });
    expect(result.settings).toMatchObject({ maxTokens: 24_576, maxIterations: 100 });
    expect(result.settings).not.toHaveProperty("consolidationSessionInterval");
    expect(await readFile(join(home, ".env"), "utf8")).not.toContain("CONSOLIDATION_SESSION_INTERVAL");
    reopened = createAgentRuntime(paths);
    expect(await reopened.getSettings()).toMatchObject({ maxTokens: 24_576, maxIterations: 100 });
    expect(await reopened.getSettings()).not.toHaveProperty("consolidationSessionInterval");
  } finally {
    await reopened?.close();
    await runtime.close();
    state.runtime = null;
    await rm(home, { recursive: true, force: true });
  }
});

it("Web 空库的每日与手动入口都不创建后台任务或占用每日配额", async () => {
  const home = await mkdtemp(join(tmpdir(), "web-consolidate-"));
  const runtime = state.runtime = createAgentRuntime({ home, defaultSystemPromptPath: join(home, "default.md") });
  try {
    await writeFile(join(home, "default.md"), "测试助手");
    vi.resetModules();
    const { handleMemoryAction, loadAgentBootstrap } = await import("../server/agent-service.ts");
    expect(await loadAgentBootstrap()).toMatchObject({ semanticCount: 0 });
    expect(await handleMemoryAction({ action: "semantic_count" })).toBe(0);
    expect(runtime.memory.listBackgroundTasks()).toEqual([]);
    expect(await handleMemoryAction({ action: "consolidate", trigger: "daily" })).toBeNull();
    await expect(handleMemoryAction({ action: "consolidate" })).rejects.toThrow("请先配置模型");
    await runtime.saveAgentSettings({
      agentModel: { provider: "openai-compatible", model: "agent", apiKey: "agent-key" },
      smallModel: { provider: "anthropic", model: "small", apiKey: "small-key" },
      force: true,
    });
    const first = await handleMemoryAction({ action: "consolidate", trigger: "daily" });
    expect(first).toEqual({ status: "skipped", reason: "no_semantic_memory" });
    await runtime.memory.waitForBackgroundTasks();
    expect(await handleMemoryAction({ action: "consolidate", trigger: "daily" })).toEqual({ status: "skipped", reason: "no_semantic_memory" });
    expect(await handleMemoryAction({ action: "consolidate", trigger: "manual" })).toEqual({ status: "skipped", reason: "no_semantic_memory" });
    await runtime.memory.waitForBackgroundTasks();
    expect(await handleMemoryAction({ action: "consolidation_status" })).toBeNull();
    expect(runtime.memory.listBackgroundTasks()).toEqual([]);
    await handleMemoryAction({ action: "create_semantic", subject: "偏好", content: "偏好喝茶" });
    expect(await handleMemoryAction({ action: "semantic_count" })).toBe(1);
  } finally { await runtime.close(); state.runtime = null; await rm(home, { recursive: true, force: true }); }
});

it("Web 保存入口接收 Gemini 双模型与独立 Embedding Provider，并拒绝 Anthropic 向量配置", async () => {
  const home = await mkdtemp(join(tmpdir(), "web-gemini-provider-"));
  const runtime = state.runtime = createAgentRuntime({ home, defaultSystemPromptPath: join(home, "default.md") });
  try {
    vi.resetModules();
    const { saveAgentSettings } = await import("../server/agent-service.ts");
    const connection = { provider: "gemini", model: "gemini-test", apiKey: "gemini-test-secret" };
    const input = { agentModel: connection, smallModel: connection, embeddingProvider: "gemini", force: true };
    const result = await saveAgentSettings(input);
    expect(result.settings).toMatchObject({ agentModel: { provider: "gemini" }, smallModel: { provider: "gemini" }, embeddingProvider: "gemini" });
    expect(JSON.stringify(result)).not.toContain("gemini-test-secret");
    await expect(async () => saveAgentSettings({ ...input, embeddingProvider: "anthropic" })).rejects.toThrow("Embedding Provider");
  } finally { await runtime.close(); state.runtime = null; await rm(home, { recursive: true, force: true }); }
});
