import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRuntime, type SessionRecallSettings } from "../../memory/index.ts";
import { ManageMemoryTool } from "../manage-memory.ts";
import { LocalToolRegistry } from "../tool-registry.ts";

const memories: MemoryRuntime[] = [];
const recall: SessionRecallSettings = {
  searchWindow: 5, scrollStep: 10, messageLimit: 100, tokenLimit: 50_000,
  tokenEstimator: { estimateText(text: string) { return text.length } },
};
afterEach(() => memories.splice(0).forEach((memory) => memory.close()));

describe("本地记忆工具", () => {
  it("提交缺少字段时明确指出字段，避免把有效 content 报为记忆文本错误", async () => {
    const runtime = await memory(); const session = runtime.createSession();
    const evidence = runtime.startRun(session.id, "r1", "我喜欢布偶猫");
    const tool = new ManageMemoryTool(runtime, {
      currentSessionId: session.id, runId: "r1", evidenceMessageId: evidence.id, model: "small",
      client: { messages: { create: () => { throw new Error("无效提交不得调用模型"); } } },
    });
    expect(() => tool.execute({ action: "submit", content: "用户喜欢布偶猫" })).toThrow("submit 缺少必填字段：intent、subject、attribute");
    expect(() => tool.execute({ action: "submit", content: "用户喜欢布偶猫", intent: "remember", subject: "宠物偏好" })).toThrow("submit 缺少必填字段：attribute");
    const schemas = new LocalToolRegistry(runtime, tool).schemas() as Array<{ name: string; input_schema: unknown }>;
    expect(schemas.find((schema) => schema.name === "manage_memory")?.input_schema).toMatchObject({
      anyOf: [
        { properties: { action: { enum: ["search"] } }, required: ["query"] },
        { properties: { action: { enum: ["submit"] } }, required: ["intent", "subject", "attribute", "content"] },
      ],
    });
  });

  it("submit 绑定当前用户证据并由小模型选择写入，search 仍只读", async () => {
    const runtime = await memory(); const session = runtime.createSession();
    const evidence = runtime.startRun(session.id, "r1", "我喜欢红茶");
    const tool = new ManageMemoryTool(runtime, {
      currentSessionId: session.id, runId: "r1", evidenceMessageId: evidence.id, model: "small",
      client: { messages: { create: () => ({ content: [{ type: "text", text: JSON.stringify({ action: "create", reason: "新偏好", evidenceMessageIds: [evidence.id], subject: "饮品偏好", content: "喜欢红茶", category: "preference", stable: true, futureUseful: true }) }], stop_reason: "end_turn" }) } },
    });
    const registry = new LocalToolRegistry(runtime, tool);
    await expect(registry.execute("manage_memory", { action: "submit", intent: "remember", subject: "用户", attribute: "饮品偏好", content: "喜欢红茶" }, () => {}, { signal: new AbortController().signal, deadline: null, iteration: 1, toolUseId: "t1" })).toMatchObject({ status: "queued" });
    await runtime.waitForBackgroundTasks();
    await expect(tool.execute({ action: "search", query: "红茶" })).resolves.toHaveLength(1);
    expect(runtime.listSemantic()[0]?.sources).toEqual([{ sessionId: session.id, messageId: evidence.id, createdAt: evidence.createdAt }]);
  });

  it("提交忘记意图后直接删除，不需要确认令牌", async () => {
    const runtime = await memory(); const item = await runtime.createSemantic("饮品偏好", "喜欢红茶");
    const session = runtime.createSession(); const evidence = runtime.startRun(session.id, "r1", "忘记我的饮品偏好");
    const tool = new ManageMemoryTool(runtime, { currentSessionId: session.id, runId: "r1", evidenceMessageId: evidence.id, model: "small",
      client: { messages: { create: () => ({ content: [{ type: "text", text: JSON.stringify({ action: "delete", targetId: item.id, reason: "用户明确要求忘记", evidenceMessageIds: [evidence.id] }) }], stop_reason: "end_turn" }) } },
    });
    expect(tool.execute({ action: "submit", intent: "forget", subject: "用户", attribute: "饮品偏好", content: "忘记饮品偏好" })).toMatchObject({ status: "queued" });
    await runtime.waitForBackgroundTasks();
    expect(runtime.listSemantic()).toEqual([]);
  });

  it("拒绝绕过检索的旧操作、伪造证据及未绑定模型的提交", async () => {
    const tool = new ManageMemoryTool(await memory());
    expect(() => tool.execute(null)).toThrow("参数必须是对象");
    expect(() => tool.execute({ action: "create" })).toThrow("未知");
    expect(() => tool.execute({ action: "request_delete" })).toThrow("未知");
    expect(() => tool.execute({ action: "submit", evidenceMessageIds: [1] })).toThrow("不支持");
    expect(() => tool.execute({ action: "submit" })).toThrow("模型与证据");
    expect(() => tool.execute({ action: "search", query: " " })).toThrow("query");
  });

  it("注册 Session Search 与 Session Read，并绑定当前 Session 排除规则", async () => {
    const runtime = await memory(); const current = runtime.createSession("当前"); const historical = runtime.createSession("历史");
    await addRun(runtime, current.id, "r1", "发布方案", "当前方案");
    await addRun(runtime, historical.id, "r2", "发布方案", "历史方案");
    const registry = new LocalToolRegistry(runtime, undefined, { currentSessionId: current.id, settings: recall });
    const schemas = registry.schemas() as Array<{ name: string }>;
    expect(schemas.map((item) => item.name)).toEqual(["get_current_time", "manage_memory", "session_search", "session_read"]);
    const context = { signal: undefined, deadline: null, iteration: 1, toolUseId: "t1" };
    const result = await registry.execute("session_search", { query: "发布方案" }, async () => {}, context) as { sessions: Array<{ session: { id: string } }> };
    expect(result.sessions.map((item) => item.session.id)).toEqual([historical.id]);
    const recent = await registry.execute("session_search", { recent: true }, async () => {}, context) as { sessions: unknown[] };
    expect(recent.sessions).toHaveLength(1);
    const read = await registry.execute("session_read", { sessionId: historical.id }, async () => {}, context) as { entries: unknown[] };
    expect(read.entries).not.toHaveLength(0);
    await expect(registry.execute("session_read", { sessionId: current.id }, async () => {}, context)).rejects.toThrow("当前 Session");
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
async function addRun(memory: MemoryRuntime, sessionId: string, runId: string, prompt: string, reply: string): Promise<void> {
  memory.startRun(sessionId, runId, prompt);
  await memory.completeRun(sessionId, runId, [{ role: "assistant", content: reply }]);
}
