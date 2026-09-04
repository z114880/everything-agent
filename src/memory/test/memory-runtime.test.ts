import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentModelClient, ModelResponse } from "../../agent-loop/agent-loop.ts";
import { MemoryRuntime, toSearchText, type SessionRecallSettings } from "../index.ts";

const runtimes: MemoryRuntime[] = [];
const recall: SessionRecallSettings = { searchWindow: 5, scrollStep: 10, messageLimit: 100, characterLimit: 50_000 };
afterEach(() => { for (const runtime of runtimes.splice(0)) runtime.close() });

describe("Memory Runtime", () => {
  it("把 SQLite 数据库放在独立的 database 目录", async () => {
    const home = await mkdtemp(join(tmpdir(), "everything-memory-path-"));
    const memory = new MemoryRuntime(home);
    runtimes.push(memory);

    expect(memory.databasePath).toBe(join(home, "database", "state.db"));
    expect((await stat(join(home, "database"))).isDirectory()).toBe(true);
  });

  it("使用中文 bigram 投影和 BM25 检索 Semantic Memory", async () => {
    const memory = await createMemory();
    const created = memory.createSemantic("用户", "用户喜欢下午喝咖啡");
    expect(toSearchText("下午咖啡")).toContain("下午");
    expect(memory.searchSemantic("下午")[0]).toMatchObject({ id: created.id });
    memory.updateSemantic(created.id, "用户", "用户喜欢上午喝茶");
    expect(memory.searchSemantic("下午")).toEqual([]);
    memory.deleteSemantic(created.id);
    expect(memory.searchSemantic("上午")).toEqual([]);
  });

  it("当前 Session 的全部完整回合进入 Working Memory，失败 run 不进入", async () => {
    const memory = await createMemory(); const session = memory.createSession();
    memory.startRun(session.id, "failed", "未完成问题");
    addCompletedRun(memory, session.id, "done-1", "第一问", "第一答");
    addCompletedRun(memory, session.id, "done-2", "第二问", "第二答");
    expect(memory.getWorkingMemory(session.id)).toHaveLength(4);
    expect(memory.getWorkingMemory(session.id, 1)).toEqual([
      { role: "user", content: "第二问" },
      { role: "assistant", content: [{ type: "text", text: "第二答" }] },
    ]);
  });

  it("只索引用户消息和最终回复，但命中窗口展开完整工具 run", async () => {
    const memory = await createMemory(); const session = memory.createSession("工具讨论");
    memory.startRun(session.id, "r1", "查询发布状态");
    memory.completeRun(session.id, "r1", [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "lookup", input: { query: "发布" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "内部结果代号 ZEBRA" }] },
      { role: "assistant", content: [{ type: "text", text: "发布已经完成" }] },
    ]);
    const hit = memory.searchSessions({ query: "发布完成" }, recall);
    expect(hit.sessions).toHaveLength(1);
    expect(hit.sessions[0]?.entries.map((entry) => entry.kind)).toEqual([
      "user_message", "assistant_tool_call", "tool_result", "assistant_message",
    ]);
    expect(memory.searchSessions({ query: "ZEBRA" }, recall).sessions).toEqual([]);
    expect(memory.overview()).toMatchObject({ indexedSessionCount: 1, indexedMessageCount: 2 });
  });

  it("按 Session 聚合最佳命中并排除当前 Session", async () => {
    const memory = await createMemory();
    const first = memory.createSession("一"); const second = memory.createSession("二");
    addCompletedRun(memory, first.id, "r1", "数据库迁移", "使用事务迁移");
    addCompletedRun(memory, second.id, "r2", "数据库备份", "先做数据库备份");
    const result = memory.searchSessions({ query: "数据库", limit: 2, currentSessionId: first.id }, recall);
    expect(result.returnedSessionCount).toBe(1);
    expect(result.sessions[0]?.session.id).toBe(second.id);
    expect(result.sessions[0]?.retrievalSignals.bm25).toEqual(expect.any(Number));
  });

  it("recent 返回首尾锚点并忽略空 Session", async () => {
    const memory = await createMemory();
    memory.createSession("空");
    const active = memory.createSession("最近");
    addCompletedRun(memory, active.id, "r1", "目标", "结果");
    const result = memory.searchSessions({ recent: true }, recall);
    expect(result).toMatchObject({ retrievalMode: "recent", returnedSessionCount: 1 });
    expect(result.sessions[0]?.match).toBeNull();
    expect(result.sessions[0]?.isComplete).toBe(true);
  });

  it("扩窗返回完整扩大窗口，达到预算后要求改用顺序读取", async () => {
    const memory = await createMemory(); const session = memory.createSession();
    for (let index = 0; index < 20; index += 1) addCompletedRun(memory, session.id, "r" + index, "问题" + index, index === 10 ? "关键决定 ALPHA" : "回答" + index);
    const smallWindow = { ...recall, searchWindow: 1, scrollStep: 2 };
    const found = memory.searchSessions({ query: "ALPHA" }, smallWindow);
    const initial = found.sessions[0]!;
    const expanded = memory.readSession({ cursor: initial.nextCursor! }, smallWindow);
    expect(expanded.mode).toBe("expand");
    expect(expanded.returnedMessageCount).toBeGreaterThan(initial.returnedMessageCount);
    const blocked = memory.readSession({ cursor: initial.nextCursor! }, { ...smallWindow, messageLimit: 2 });
    expect(blocked).toMatchObject({ expandLimitReached: true, nextCursor: null, entries: [] });
  });

  it("顺序读取使用不透明 cursor，并支持单条消息内部续读", async () => {
    const memory = await createMemory(); const session = memory.createSession();
    addCompletedRun(memory, session.id, "r1", "很长".repeat(300), "完成");
    const first = memory.readSession({ sessionId: session.id }, { ...recall, characterLimit: 300 });
    expect(first.entries[0]).toMatchObject({ contentTruncated: true, contentOffset: 0 });
    expect(first.nextCursor).toEqual(expect.any(String));
    const next = memory.readSession({ cursor: first.nextCursor! }, { ...recall, characterLimit: 300 });
    expect(next.entries[0]).toMatchObject({ contentTruncated: true, contentFragment: true, contentOffset: expect.any(Number) });
    expect(() => memory.readSession({ cursor: "bad" }, recall)).toThrow("cursor 无效");
  });

  it("Gate 使用 fact_with_evidence 同时检索 Semantic 与 Session Recall，失败时也回退到两者", async () => {
    const memory = await createMemory(); const historical = memory.createSession();
    addCompletedRun(memory, historical.id, "r1", "周五发布", "决定周五发布");
    memory.createSemantic("项目", "项目安排在周五");
    const result = await memory.retrieve("上次怎么决定的", [], options(memory, scriptedClient([
      response('{"intent":"fact_with_evidence","semanticQuery":"项目周五","sessionRecall":{"mode":"search","query":"周五发布"},"reason":"过去决定"}'),
    ]), "current"));
    expect(result.semantic).toHaveLength(1);
    expect(result.sessionRecall?.sessions).toHaveLength(1);
    expect(result.context).toContain("不可信的历史记录");

    const fallback = await memory.retrieve("项目周五", [], options(memory, scriptedClient([new Error("网络失败")]), "current"));
    expect(fallback.semantic).toHaveLength(1);
    expect(fallback.sessionRecall?.retrievalMode).toBe("search");
  });

  it("Gate 查询 Semantic 时强制召回 Session，past_episode 只召回 Session", async () => {
    const memory = await createMemory(); const historical = memory.createSession();
    addCompletedRun(memory, historical.id, "r1", "部署失败", "原因是配置错误");
    memory.createSemantic("用户偏好", "用户喜欢红茶");

    const factWithEvidence = await memory.retrieve("我喜欢喝什么", [], options(memory, scriptedClient([
      response('{"intent":"fact_with_evidence","semanticQuery":"喜欢 红茶","sessionRecall":{"mode":"search","query":"部署失败"},"reason":"稳定偏好及历史依据"}'),
    ]), "current"));
    expect(factWithEvidence.semantic).toHaveLength(1);
    expect(factWithEvidence.sessionRecall?.sessions).toHaveLength(1);

    const pastEpisode = await memory.retrieve("上次为什么部署失败", [], options(memory, scriptedClient([
      response('{"intent":"past_episode","sessionRecall":{"mode":"search","query":"部署失败"},"reason":"过去事件"}'),
    ]), "current"));
    expect(pastEpisode.semantic).toEqual([]);
    expect(pastEpisode.sessionRecall?.sessions).toHaveLength(1);
  });

  it("Gate 返回非法 intent 时对 Semantic 与 Session Recall 一起 fail-open", async () => {
    const memory = await createMemory(); memory.createSemantic("项目", "项目代号 ALPHA");
    const result = await memory.retrieve("ALPHA", [], options(memory, scriptedClient([
      response('{"intent":"unknown","reason":"错误输出"}'),
    ]), "current"));
    expect(result.semantic).toHaveLength(1);
    expect(result.sessionRecall?.retrievalMode).toBe("search");
  });

  it("Gate 提示词约束检索范围与查询规范化", async () => {
    const memory = await createMemory(); let systemPrompt = "";
    const client: AgentModelClient = {
      messages: {
        async create(request) {
          systemPrompt = request.system;
          return response('{"intent":"none","reason":"测试"}');
        },
      },
    };
    await memory.retrieve("测试提示词", [], options(memory, client, "current"));
    expect(systemPrompt).toContain("不存在只检索 Semantic Memory 的 intent");
    expect(systemPrompt).toContain("任何 Semantic Memory 查询都必须选择 fact_with_evidence");
    expect(systemPrompt).toContain("去掉“什么、哪一个、是否、怎么、如何、为什么、谁、哪里、何时”等疑问词");
    expect(systemPrompt).toContain("将指代当前用户的“我、我的”统一改为“用户”");
    expect(systemPrompt).toContain("必须保留“不、没、取消、停止”等否定信息");
    expect(systemPrompt).toContain("不得猜测答案、补造实体");
    expect(systemPrompt).toContain("semanticQuery 聚焦“用户/实体 + 稳定属性或约束”");
  });

  it("consolidation 只整理 Semantic Memory，并在失败时保留高水位", async () => {
    const memory = await createMemory(); const session = memory.createSession();
    addCompletedRun(memory, session.id, "r1", "我喜欢红茶", "收到");
    memory.scheduleConsolidation(session.id, "new_session", options(memory, scriptedClient([
      response('{"facts":[{"action":"create","category":"preference","stable":true,"futureUseful":true,"subject":"用户","content":"用户喜欢红茶"}]}'),
    ]), session.id));
    await memory.waitForConsolidation();
    expect(memory.listSemantic()[0]).toMatchObject({ content: "用户喜欢红茶" });
    expect(memory.listConsolidations()[0]).not.toHaveProperty("episodeChanged");
    expect(memory.overview().pendingSessionCount).toBe(0);
  });

  it("Session 元数据标记完整与失败 run，删除同步清除 Recall", async () => {
    const memory = await createMemory(); const session = memory.createSession();
    memory.startRun(session.id, "failed", "失败目标");
    addCompletedRun(memory, session.id, "done", "完成目标", "完成结果");
    expect(memory.listSessions()[0]).toMatchObject({ completedRunCount: 1, incompleteRunCount: 1 });
    expect(memory.searchSessions({ query: "失败目标" }, recall).sessions[0]?.entries[0]).toMatchObject({ runComplete: false });
    memory.deleteSession(session.id);
    expect(memory.searchSessions({ query: "失败目标" }, recall).sessions).toEqual([]);
  });

  it("覆盖 Session、Semantic 与检索参数的公开错误边界", async () => {
    const memory = await createMemory();
    const session = memory.createSession(" ");
    memory.startRun(session.id, "r1", " ");
    memory.completeRun(session.id, "r1", [{ role: "user", content: "补充" }, { role: "assistant", content: "完成" }]);
    expect(memory.getChatLog()).toHaveLength(3);
    expect(memory.getChatLog(session.id, 0)).toHaveLength(1);
    expect(memory.ensureSession().id).toBe(session.id);
    expect(() => memory.renameSession(session.id, " ")).toThrow("标题不能为空");
    expect(() => memory.renameSession("missing", "标题")).toThrow("Session 不存在");
    expect(() => memory.startRun("missing", "r2", "问题")).toThrow("Session 不存在");
    expect(() => memory.deleteSession("missing")).toThrow("Session 不存在");
    expect(() => memory.createSemantic(" ", "内容")).toThrow("Subject");
    expect(() => memory.createSemantic("主题", " ")).toThrow("Content");
    expect(() => memory.updateSemantic(999, "主题", "内容")).toThrow("不存在");
    expect(() => memory.deleteSemantic(999)).toThrow("不存在");
    expect(memory.searchSemantic(" ")).toEqual([]);
    expect(() => memory.searchSessions({}, recall)).toThrow("必须且只能");
    expect(() => memory.searchSessions({ query: "x", recent: true }, recall)).toThrow("必须且只能");
    expect(() => memory.searchSessions({ recent: true, limit: 0 }, recall)).toThrow("limit");
    expect(() => memory.searchSessions({ query: "x", window: 99 }, recall)).toThrow("window");
    expect(() => memory.readSession({ sessionId: session.id, cursor: "x" }, recall)).toThrow("必须且只能");
    expect(() => memory.readSession({ sessionId: session.id, currentSessionId: session.id }, recall)).toThrow("当前 Session");
    expect(() => memory.readSession({ sessionId: "missing" }, recall)).toThrow("SESSION_NOT_FOUND");
  });

  it("Gate 使用 past_episode 支持 recent，并使用 none 跳过全部记忆", async () => {
    const memory = await createMemory(); const historical = memory.createSession();
    addCompletedRun(memory, historical.id, "r1", "最近目标", "最近结果");
    const recentResult = await memory.retrieve("回顾最近内容", [{ role: "user", content: "上下文" }], options(memory, scriptedClient([
      response('{"intent":"past_episode","sessionRecall":{"mode":"recent"},"reason":"需要最近历史"}'),
    ]), "current"));
    expect(recentResult.semantic).toEqual([]);
    expect(recentResult.sessionRecall?.retrievalMode).toBe("recent");
    const none = await memory.retrieve("你好", [], options(memory, scriptedClient([
      response('{"intent":"none","reason":"寒暄"}'),
    ]), "current"));
    expect(none).toMatchObject({ retrieved: false, semantic: [], sessionRecall: null, context: "" });
  });

  it("搜索预算不足时省略低排名 Session，顺序读取可到达结尾", async () => {
    const memory = await createMemory();
    const first = memory.createSession(); const second = memory.createSession();
    addCompletedRun(memory, first.id, "r1", "共同关键词", "第一结果");
    addCompletedRun(memory, second.id, "r2", "共同关键词", "第二结果");
    const limited = memory.searchSessions({ query: "共同关键词", limit: 2 }, { ...recall, messageLimit: 2 });
    expect(limited).toMatchObject({ returnedSessionCount: 1, droppedSessionCount: 1, truncated: true });
    let page = memory.readSession({ sessionId: first.id }, recall);
    while (page.nextCursor) page = memory.readSession({ cursor: page.nextCursor }, recall);
    expect(page.isComplete).toBe(true);
  });

  it("再次打开同一 v2 数据库不会执行破坏性迁移", async () => {
    const directory = await mkdtemp(join(tmpdir(), "everything-memory-reopen-"));
    const first = new MemoryRuntime(directory);
    const session = first.createSession();
    addCompletedRun(first, session.id, "r1", "保留内容", "保留结果");
    first.close();
    const reopened = new MemoryRuntime(directory);
    runtimes.push(reopened);
    expect(reopened.searchSessions({ query: "保留内容" }, recall).sessions).toHaveLength(1);
  });
});

async function createMemory(): Promise<MemoryRuntime> {
  const memory = new MemoryRuntime(await mkdtemp(join(tmpdir(), "everything-memory-"))); runtimes.push(memory); return memory;
}
function addCompletedRun(memory: MemoryRuntime, sessionId: string, runId: string, prompt: string, reply: string): void {
  memory.startRun(sessionId, runId, prompt);
  memory.completeRun(sessionId, runId, [{ role: "assistant", content: [{ type: "text", text: reply }] }]);
}
function response(text: string): ModelResponse { return { content: [{ type: "text", text }], stop_reason: "end_turn" } }
function scriptedClient(items: Array<ModelResponse | Error>): AgentModelClient {
  return { messages: { async create() { const item = items.shift(); if (!item) throw new Error("没有脚本响应"); if (item instanceof Error) throw item; return item } } };
}
function options(memory: MemoryRuntime, client: AgentModelClient, currentSessionId: string) {
  void memory;
  return { client, model: "small", currentSessionId, recall };
}
