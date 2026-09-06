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
  const paths = { home, envPath: join(home, ".env"), defaultSystemPromptPath: join(home, "default.md") };
  const runtime = state.runtime = createAgentRuntime(paths);
  let reopened: AgentRuntime | undefined;
  try {
    const { saveAgentSettings } = await import("../server/agent-service.ts");
    const result = await saveAgentSettings({ provider: "openai-compatible", model: "test", force: true });
    expect(result.settings).not.toHaveProperty("consolidationSessionInterval");
    expect(await readFile(paths.envPath, "utf8")).not.toContain("CONSOLIDATION_SESSION_INTERVAL");
    reopened = createAgentRuntime(paths);
    expect(await reopened.getSettings()).not.toHaveProperty("consolidationSessionInterval");
  } finally {
    await reopened?.close();
    await runtime.close();
    state.runtime = null;
    await rm(home, { recursive: true, force: true });
  }
});

it("Web 每日入口与手动入口复用后台任务，首屏只读加载不占每日配额", async () => {
  const home = await mkdtemp(join(tmpdir(), "web-consolidate-"));
  const runtime = state.runtime = createAgentRuntime({ home, envPath: join(home, ".env"), defaultSystemPromptPath: join(home, "default.md") });
  try {
    await writeFile(join(home, "default.md"), "测试助手");
    vi.resetModules();
    const { handleMemoryAction, loadAgentBootstrap } = await import("../server/agent-service.ts");
    await loadAgentBootstrap();
    expect(runtime.memory.listBackgroundTasks()).toEqual([]);
    expect(await handleMemoryAction({ action: "consolidate", trigger: "daily" })).toBeNull();
    await expect(handleMemoryAction({ action: "consolidate" })).rejects.toThrow("请先配置模型");
    await runtime.saveAgentSettings({ provider: "openai-compatible", model: "test", apiKey: "test-key", force: true });
    const first = await handleMemoryAction({ action: "consolidate", trigger: "daily" });
    expect(first).toMatchObject({ status: "queued" });
    await runtime.memory.waitForBackgroundTasks();
    expect(await handleMemoryAction({ action: "consolidate", trigger: "daily" })).toMatchObject({ status: "already_ran" });
    expect(await handleMemoryAction({ action: "consolidate", trigger: "manual" })).toMatchObject({ status: "queued" });
    await runtime.memory.waitForBackgroundTasks();
    expect(await handleMemoryAction({ action: "consolidation_status" })).toMatchObject({ status: "completed" });
  } finally { await runtime.close(); state.runtime = null; await rm(home, { recursive: true, force: true }); }
});
