import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRuntime, type SessionRecallSettings } from "../../memory/index.ts";
import { ManageMemoryTool } from "../manage-memory.ts";
import { LocalToolRegistry } from "../tool-registry.ts";

const memories: MemoryRuntime[] = [];
const recall: SessionRecallSettings = { searchWindow: 5, scrollStep: 10, messageLimit: 100, characterLimit: 50_000 };
afterEach(() => memories.splice(0).forEach((memory) => memory.close()));

describe("本地记忆工具", () => {
  it("manage_memory 只管理 Semantic Memory 并校验长期价值声明", async () => {
    const tool = new ManageMemoryTool(await memory());
    expect(() => tool.execute({ action: "create", subject: "当前时间", content: "七点" })).toThrow("category");
    expect(tool.execute({
      action: "create", category: "preference", stable: true, futureUseful: true,
      subject: "用户", content: "喜欢茶",
    })).toMatchObject({ subject: "用户", content: "喜欢茶" });
    expect(tool.execute({ action: "search", query: "喜欢茶" })).toHaveLength(1);
  });

  it("删除 Semantic Memory 前必须取得同一目标的确认令牌", async () => {
    const runtime = await memory(); const item = runtime.createSemantic("用户", "喜欢茶"); const tool = new ManageMemoryTool(runtime);
    const pending = tool.execute({ action: "request_delete", id: item.id }) as { confirmation: string };
    expect(tool.execute({ action: "delete", id: item.id, confirmation: pending.confirmation })).toEqual({ deleted: true, id: item.id });
    expect(runtime.listSemantic()).toEqual([]);
    expect(() => tool.execute({ action: "delete", id: item.id, confirmation: "wrong" })).toThrow("确认无效");
  });

  it("支持更新并拒绝无效 Semantic 操作参数", async () => {
    const runtime = await memory(); const item = runtime.createSemantic("用户", "喜欢茶"); const tool = new ManageMemoryTool(runtime);
    expect(tool.execute({
      action: "update", id: item.id, category: "preference", stable: true, futureUseful: true,
      subject: "用户", content: "喜欢绿茶",
    })).toMatchObject({ content: "喜欢绿茶" });
    expect(() => tool.execute(null)).toThrow("参数必须是对象");
    expect(() => tool.execute({ action: "unknown" })).toThrow("未知");
    expect(() => tool.execute({ action: "update", id: 0, category: "preference", stable: true, futureUseful: true, subject: "x", content: "y" })).toThrow("正整数");
    expect(() => tool.execute({ action: "create", category: "unknown", stable: true, futureUseful: true, subject: "x", content: "y" })).toThrow("category");
    expect(() => tool.execute({ action: "create", category: "preference", stable: false, futureUseful: true, subject: "x", content: "y" })).toThrow("stable");
  });

  it("注册 Session Search 与 Session Read，并绑定当前 Session 排除规则", async () => {
    const runtime = await memory(); const current = runtime.createSession("当前"); const historical = runtime.createSession("历史");
    addRun(runtime, current.id, "r1", "发布方案", "当前方案");
    addRun(runtime, historical.id, "r2", "发布方案", "历史方案");
    const registry = new LocalToolRegistry(runtime, undefined, { currentSessionId: current.id, settings: recall });
    const schemas = registry.schemas() as Array<{ name: string }>;
    expect(schemas.map((item) => item.name)).toEqual(["get_current_time", "manage_memory", "session_search", "session_read"]);
    const context = { signal: undefined, deadline: null, iteration: 1, toolUseId: "t1" };
    const result = registry.execute("session_search", { query: "发布方案" }, async () => {}, context) as { sessions: Array<{ session: { id: string } }> };
    expect(result.sessions.map((item) => item.session.id)).toEqual([historical.id]);
    const recent = registry.execute("session_search", { recent: true }, async () => {}, context) as { sessions: unknown[] };
    expect(recent.sessions).toHaveLength(1);
    const read = registry.execute("session_read", { sessionId: historical.id }, async () => {}, context) as { entries: unknown[] };
    expect(read.entries).not.toHaveLength(0);
    expect(() => registry.execute("session_read", { sessionId: current.id }, async () => {}, context)).toThrow("当前 Session");
    expect(() => registry.execute("session_search", null, async () => {}, context)).toThrow("参数必须是对象");
  });

  it("无 Memory 时只开放时间工具，并统一校验取消和未知工具", async () => {
    const plain = new LocalToolRegistry();
    const context = { signal: undefined, deadline: null, iteration: 1, toolUseId: "t1" };
    expect(plain.schemas()).toHaveLength(1);
    expect(plain.execute("get_current_time", {}, async () => {}, context)).toMatchObject({ timeZone: expect.any(String) });
    expect(() => plain.execute("unknown", {}, async () => {}, context)).toThrow("工具未注册");
    const controller = new AbortController(); controller.abort(new Error("已取消"));
    expect(() => plain.execute("get_current_time", {}, async () => {}, { ...context, signal: controller.signal })).toThrow("已取消");
  });
});

async function memory(): Promise<MemoryRuntime> {
  const runtime = new MemoryRuntime(await mkdtemp(join(tmpdir(), "everything-manage-memory-"))); memories.push(runtime); return runtime;
}
function addRun(memory: MemoryRuntime, sessionId: string, runId: string, prompt: string, reply: string) {
  memory.startRun(sessionId, runId, prompt);
  memory.completeRun(sessionId, runId, [{ role: "assistant", content: reply }]);
}
