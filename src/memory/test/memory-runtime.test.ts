import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentModelClient, ModelResponse } from "../../agent-loop/agent-loop.ts";
import { MemoryRuntime, toSearchText, type SessionReadResult, type SessionRecallSettings } from "../index.ts";

const runtimes: MemoryRuntime[] = [];
const tokenEstimator = { estimateText(text: string) { return text.length } };
const recall: SessionRecallSettings = { searchWindow: 5, entryTokenLimit: 4_000, tokenLimit: 50_000, tokenEstimator };
afterEach(() => { for (const runtime of runtimes.splice(0)) runtime.close() });

describe("Memory Runtime", () => {
  it("把 SQLite 数据库放在独立的 database 目录", async () => {
    const home = await mkdtemp(join(tmpdir(), "everything-memory-path-"));
    const memory = new MemoryRuntime(home);
    runtimes.push(memory);

    expect(memory.databasePath).toBe(join(home, "database", "state.db"));
    expect((await stat(join(home, "database"))).isDirectory()).toBe(true);
  });

  it("使用 jieba 搜索投影和 BM25 检索 Semantic Memory", async () => {
    const memory = await createMemory();
    const created = await memory.createSemantic("用户", "用户喜欢下午喝咖啡");
    expect(toSearchText("下午咖啡")).toContain("下午");
    expect((await memory.searchSemantic("下午"))[0]).toMatchObject({ id: created.id });
    await memory.updateSemantic(created.id, "用户", "用户喜欢上午喝茶");
    expect(await memory.searchSemantic("下午")).toEqual([]);
    memory.deleteSemantic(created.id);
    expect(await memory.searchSemantic("上午")).toEqual([]);
  });

  it("当前 Session 的全部完整回合进入 Working Memory，失败 run 不进入", async () => {
    const memory = await createMemory(); const session = memory.createSession();
    memory.startRun(session.id, "failed", "未完成问题");
    await addCompletedRun(memory, session.id, "done-1", "第一问", "第一答");
    await addCompletedRun(memory, session.id, "done-2", "第二问", "第二答");
    expect(memory.getWorkingMemory(session.id)).toHaveLength(4);
    expect(memory.getWorkingMemory(session.id, 1)).toEqual([
      { role: "user", content: "第二问" },
      { role: "assistant", content: [{ type: "text", text: "第二答" }] },
    ]);
  });

  it("只索引用户消息和最终回复，但命中窗口展开完整工具 run", async () => {
    const memory = await createMemory(); const session = memory.createSession("工具讨论");
    memory.startRun(session.id, "r1", "查询发布状态");
    await memory.completeRun(session.id, "r1", [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "lookup", input: { query: "发布" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "内部结果代号 ZEBRA" }] },
      { role: "assistant", content: [{ type: "text", text: "发布已经完成" }] },
    ]);
    const hit = await memory.searchSessions({ query: "发布完成" }, recall);
    expect(hit.sessions).toHaveLength(1);
    expect(hit.sessions[0]?.entries.map((entry) => entry.kind)).toEqual([
      "user_message", "assistant_tool_call", "tool_result", "assistant_message",
    ]);
    expect((await memory.searchSessions({ query: "ZEBRA" }, recall)).sessions).toEqual([]);
    expect(memory.overview()).toMatchObject({ indexedSessionCount: 1, indexedMessageCount: 2 });
  });

  it("按 Session 聚合最佳命中并排除当前 Session", async () => {
    const memory = await createMemory();
    const first = memory.createSession("一"); const second = memory.createSession("二");
    await addCompletedRun(memory, first.id, "r1", "数据库迁移", "使用事务迁移");
    await addCompletedRun(memory, second.id, "r2", "数据库备份", "先做数据库备份");
    const result = await memory.searchSessions({ query: "数据库", limit: 2, currentSessionId: first.id }, recall);
    expect(result.returnedSessionCount).toBe(1);
    expect(result.sessions[0]?.session.id).toBe(second.id);
    expect(result.sessions[0]?.retrievalSignals.bm25).toEqual(expect.any(Number));
  });

  it("recent 返回首尾锚点并忽略空 Session", async () => {
    const memory = await createMemory();
    memory.createSession("空");
    const active = memory.createSession("最近");
    await addCompletedRun(memory, active.id, "r1", "目标", "结果");
    const result = await memory.searchSessions({ recent: true }, recall);
    expect(result).toMatchObject({ retrievalMode: "recent", returnedSessionCount: 1 });
    expect(result.sessions[0]?.match).toBeNull();
    expect(result.sessions[0]?.isComplete).toBe(true);
  });

  it("search cursor 从锚点窗口右边界续读，返回不重复的新内容", async () => {
    const memory = await createMemory(); const session = memory.createSession();
    for (let index = 0; index < 20; index += 1) await addCompletedRun(memory, session.id, "r" + index, "问题" + index, index === 10 ? "关键决定 ALPHA" : "回答" + index);
    const smallWindow = { ...recall, searchWindow: 1 };
    const found = await memory.searchSessions({ query: "ALPHA" }, smallWindow);
    const initial = found.sessions[0]!;
    const anchorId = initial.match!.messageId;
    const next = await memory.readSession({ cursor: initial.nextCursor! }, smallWindow);
    // 续读起点在锚点之后：锚点窗口及其之前的内容不会被重复返回。
    expect(next.entries.length).toBeGreaterThan(0);
    expect(Math.min(...next.entries.map((entry) => entry.id))).toBeGreaterThan(anchorId);
    // 必须带来 search 未给过的新内容；与 search 的尾部语境片段重叠是预期的，
    // 顺序读到 Session 末尾必然再次经过它们。
    const already = new Set(initial.entries.map((entry) => entry.id));
    expect(next.entries.some((entry) => !already.has(entry.id))).toBe(true);
    // 未覆盖 Session 全部行，isComplete 必须如实为 false。
    expect(next.isComplete).toBe(false);
    expect(next.totalMessageCount).toBeGreaterThan(next.returnedMessageCount);
  });

  it("窗口结构决定返回量，token 充足时每个 Session 都拿到完整窗口", async () => {
    const memory = await createMemory();
    for (let session = 0; session < 4; session += 1) {
      const created = memory.createSession("会话" + session);
      for (let index = 0; index < 12; index += 1) {
        await addCompletedRun(memory, created.id, `s${session}r${index}`, "问题" + index, index === 6 ? "关键决定 ALPHA" : "回答" + index);
      }
    }
    const found = await memory.searchSessions({ query: "ALPHA", limit: 4 }, { ...recall, searchWindow: 2 });
    expect(found).toMatchObject({ returnedSessionCount: 4, droppedSessionCount: 0, droppedReason: null, truncated: false });
    for (const item of found.sessions) {
      // 首 3 + 命中前后各 2 + 尾 3，按 run 展开后每条都完整，没有被预算切过。
      expect(item.entries.map((entry) => entry.id)).toContain(item.match!.messageId);
      expect(item.truncated).toBe(false);
      expect(item.entries.some((entry) => entry.contentTruncated)).toBe(false);
    }
    expect(found.estimatedTokens).toBeGreaterThan(0);
  });

  it("session_search 截断超长单条，contentCursor 经 session_read 能读回完整正文", async () => {
    const memory = await createMemory(); const session = memory.createSession();
    const long = "超长记录".repeat(2_000);
    await addCompletedRun(memory, session.id, "r1", "ALPHA 的完整日志", long);
    const settings = { ...recall, entryTokenLimit: 200 };
    const found = await memory.searchSessions({ query: "ALPHA" }, settings);
    const entry = found.sessions[0]!.entries.find((item) => item.contentTruncated)!;
    expect(entry.contentLength).toBeGreaterThan(entry.contentOffset!);
    expect(entry.contentCursor).toEqual(expect.any(String));
    expect(found.sessions[0]?.isComplete).toBe(false);

    // session_read 不受单条上限约束：从 contentCursor 续读即可拼回与原文一致的完整正文。
    let text = String(entry.content);
    let cursor: string | null = entry.contentCursor!;
    for (let page = 0; cursor && page < 20; page += 1) {
      const result: SessionReadResult = await memory.readSession({ cursor }, settings);
      const first = result.entries[0]!;
      if (first.id !== entry.id) break;
      text += String(first.content);
      cursor = result.nextCursor;
    }
    expect(JSON.parse(text)).toEqual([{ type: "text", text: long }]);
  });

  it("总额不足时整个 Session 一起丢弃，不切碎已经给出的窗口", async () => {
    const memory = await createMemory();
    for (let session = 0; session < 3; session += 1) {
      const created = memory.createSession("会话" + session);
      await addCompletedRun(memory, created.id, "r" + session, "ALPHA 的排期", "回答".repeat(200));
    }
    const found = await memory.searchSessions({ query: "ALPHA", limit: 3 }, { ...recall, tokenLimit: 1_200 });
    expect(found.returnedSessionCount).toBeLessThan(3);
    expect(found).toMatchObject({ droppedReason: "token_budget", truncated: true });
    expect(found.estimatedTokens).toBeLessThanOrEqual(1_200);
    // 返回的 Session 都是完整窗口，被丢的那些一条都不给。
    for (const item of found.sessions) expect(item.truncated).toBe(false);
  });

  it("排名第一的 Session 超额时按 run 收缩兜底，始终带着命中返回", async () => {
    const memory = await createMemory(); const session = memory.createSession();
    for (let index = 0; index < 12; index += 1) {
      await addCompletedRun(memory, session.id, "r" + index, "问题" + index, index === 6 ? "关键决定 ALPHA" : "回答".repeat(100));
    }
    const found = await memory.searchSessions({ query: "ALPHA" }, { ...recall, tokenLimit: 800 });
    const hit = found.sessions[0]!;
    expect(hit.entries.length).toBeGreaterThan(0);
    expect(hit.entries.map((entry) => entry.id)).toContain(hit.match!.messageId);
    expect(hit.truncated).toBe(true);
    expect(found.estimatedTokens).toBeLessThanOrEqual(800);
    // 收缩结果前后都有缺口，续读必须从 Session 开头开始。
    expect(hit.nextCursor).toEqual(expect.any(String));
  });

  it("recent 模式同样应用单条正文上限", async () => {
    const memory = await createMemory(); const session = memory.createSession("最近");
    await addCompletedRun(memory, session.id, "r1", "问题", "超长记录".repeat(2_000));
    const found = await memory.searchSessions({ recent: true }, { ...recall, entryTokenLimit: 200 });
    const entry = found.sessions[0]!.entries.find((item) => item.contentTruncated)!;
    expect(entry.contentCursor).toEqual(expect.any(String));
    expect(entry.contentLength).toEqual(expect.any(Number));
  });

  it("续读始终有产出，逐页推进直到 nextCursor 为空", async () => {
    const memory = await createMemory(); const session = memory.createSession();
    for (let index = 0; index < 20; index += 1) await addCompletedRun(memory, session.id, "r" + index, "问题" + index, index === 10 ? "关键决定 ALPHA" : "回答" + index);
    const tightBudget = { ...recall, searchWindow: 1, tokenLimit: 800 };
    const found = await memory.searchSessions({ query: "ALPHA" }, tightBudget);
    let cursor = found.sessions[0]!.nextCursor;
    const seen = new Set<number>();
    let pages = 0;
    while (cursor && pages < 50) {
      const page: SessionReadResult = await memory.readSession({ cursor }, tightBudget);
      // 预算再紧也不会空手返回，不存在需要改用从头分页的死路。
      expect(page.entries.length).toBeGreaterThan(0);
      page.entries.forEach((entry) => seen.add(entry.id));
      cursor = page.nextCursor; pages += 1;
    }
    expect(cursor).toBeNull();
    expect(seen.size).toBeGreaterThan(0);
  });

  it("顺序读取使用不透明 cursor，并支持单条消息内部续读", async () => {
    const memory = await createMemory(); const session = memory.createSession();
    await addCompletedRun(memory, session.id, "r1", "很长".repeat(300), "完成");
    const first = await memory.readSession({ sessionId: session.id }, { ...recall, tokenLimit: 300 });
    expect(first.entries[0]).toMatchObject({ contentTruncated: true, contentOffset: 0 });
    expect(first.nextCursor).toEqual(expect.any(String));
    const next = await memory.readSession({ cursor: first.nextCursor! }, { ...recall, tokenLimit: 300 });
    expect(next.entries[0]).toMatchObject({ contentTruncated: true, contentFragment: true, contentOffset: expect.any(Number) });
    await expect(memory.readSession({ cursor: "bad" }, recall)).rejects.toThrow("cursor 无效");
  });

  it("检索开始在 Gate 后和阶段事件前，完成事件包含命中结果", async () => {
    const memory = await createMemory();
    const created = await memory.createSemantic("项目", "项目安排在周五");
    const events: { kind: string; data: Record<string, unknown> }[] = [];
    await memory.retrieve("项目周五", [], {
      ...options(memory, scriptedClient([
        response('{"intent":"fact_with_evidence","denseQuery":"项目周五","lexicalQuery":"项目周五","sessionRecall":{"mode":"search","query":"周五"},"reason":"测试"}'),
      ]), "current"),
      observer: (kind, data) => { events.push({ kind, data }) },
    });
    for (const [startKind, endKind] of [["gate_start", "gate_end"], ["retrieval_start", "retrieval_completed"]]) {
      const start = events.find(event => event.kind === startKind)!.data;
      const end = events.find(event => event.kind === endKind)!.data;
      expect(start.operationId).toEqual(expect.any(String));
      expect(end.operationId).toBe(start.operationId);
    }
    expect(events.find(event => event.kind === "gate_start")!.data.model).toEqual(expect.any(String));
    const kinds = events.map((event) => event.kind);
    expect(kinds).not.toContain("retrieval");
    expect(kinds.filter((kind) => kind === "retrieval_start")).toHaveLength(1);
    expect(kinds.indexOf("retrieval_start")).toBe(kinds.indexOf("gate_end") + 1);
    expect(kinds.indexOf("lexical_retrieval_completed")).toBeGreaterThan(kinds.indexOf("retrieval_start"));
    expect(events.at(-1)).toMatchObject({
      kind: "retrieval_completed",
      data: { semanticCount: 1, sessionCount: 0, mode: "lexical_only",
        semantic: { hits: [{ id: created.id, bm25: expect.any(Number) }] },
        sessionRecall: { sessions: [] } },
    });
  });

  it("Gate 使用 fact_with_evidence 同时检索 Semantic 与 Session Recall，失败时也回退到两者", async () => {
    const memory = await createMemory(); const historical = memory.createSession();
    await addCompletedRun(memory, historical.id, "r1", "周五发布", "决定周五发布");
    await memory.createSemantic("项目", "项目安排在周五");
    const result = await memory.retrieve("上次怎么决定的", [], options(memory, scriptedClient([
      response('{"intent":"fact_with_evidence","denseQuery":"项目周五","lexicalQuery":"项目周五","sessionRecall":{"mode":"search","query":"周五发布"},"reason":"过去决定"}'),
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
    await addCompletedRun(memory, historical.id, "r1", "部署失败", "原因是配置错误");
    await memory.createSemantic("用户偏好", "用户喜欢红茶");

    const factWithEvidence = await memory.retrieve("我喜欢喝什么", [], options(memory, scriptedClient([
      response('{"intent":"fact_with_evidence","denseQuery":"喜欢 红茶","lexicalQuery":"喜欢 红茶","sessionRecall":{"mode":"search","query":"部署失败"},"reason":"稳定偏好及历史依据"}'),
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
    const memory = await createMemory(); await memory.createSemantic("项目", "项目代号 ALPHA");
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
    expect(systemPrompt).toContain("删除“用户、我、我的、本人、自己”等主体词");
    expect(systemPrompt).toContain("必须保留“不、没、取消、停止”等否定信息");
    expect(systemPrompt).toContain("不得猜测答案、补造实体");
    expect(systemPrompt).toContain("denseQuery 聚焦“用户/实体 + 稳定属性或约束”");
  });

  it("Session 元数据标记完整与失败 run，删除同步清除 Recall", async () => {
    const memory = await createMemory(); const session = memory.createSession();
    memory.startRun(session.id, "failed", "失败独有代号 ZEBRA");
    await addCompletedRun(memory, session.id, "done", "完成目标", "完成结果");
    expect(memory.listSessions()[0]).toMatchObject({ completedRunCount: 1, incompleteRunCount: 1 });
    expect((await memory.searchSessions({ query: "ZEBRA" }, recall)).sessions).toEqual([]);
    memory.deleteSession(session.id);
    expect((await memory.searchSessions({ query: "ZEBRA" }, recall)).sessions).toEqual([]);
  });

  it("覆盖 Session、Semantic 与检索参数的公开错误边界", async () => {
    const memory = await createMemory();
    const session = memory.createSession(" ");
    memory.startRun(session.id, "r1", " ");
    await memory.completeRun(session.id, "r1", [{ role: "user", content: "补充" }, { role: "assistant", content: "完成" }]);
    expect(memory.getChatLog()).toHaveLength(3);
    expect(memory.getChatLog(session.id, 0)).toHaveLength(1);
    expect(memory.ensureSession().id).toBe(session.id);
    expect(() => memory.renameSession(session.id, " ")).toThrow("标题不能为空");
    expect(() => memory.renameSession("missing", "标题")).toThrow("Session 不存在");
    expect(() => memory.startRun("missing", "r2", "问题")).toThrow("Session 不存在");
    expect(() => memory.deleteSession("missing")).toThrow("Session 不存在");
    await expect(memory.createSemantic(" ", "内容")).rejects.toThrow("Subject");
    await expect(memory.createSemantic("主题", " ")).rejects.toThrow("Content");
    await expect(memory.updateSemantic(999, "主题", "内容")).rejects.toThrow("不存在");
    expect(() => memory.deleteSemantic(999)).toThrow("不存在");
    expect(await memory.searchSemantic(" ")).toEqual([]);
    await expect(memory.searchSessions({}, recall)).rejects.toThrow("必须且只能");
    await expect(memory.searchSessions({ query: "x", recent: true }, recall)).rejects.toThrow("必须且只能");
    await expect(memory.searchSessions({ recent: true, limit: 0 }, recall)).rejects.toThrow("limit");
    await expect(memory.readSession({ sessionId: session.id, cursor: "x" }, recall)).rejects.toThrow("必须且只能");
    await expect(memory.readSession({ sessionId: session.id, currentSessionId: session.id }, recall)).rejects.toThrow("当前 Session");
    await expect(memory.readSession({ sessionId: "missing" }, recall)).rejects.toThrow("SESSION_NOT_FOUND");
  });

  it("Gate 使用 past_episode 支持 recent，并使用 none 跳过全部记忆", async () => {
    const memory = await createMemory(); const historical = memory.createSession();
    await addCompletedRun(memory, historical.id, "r1", "最近目标", "最近结果");
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

  it("token 预算不足时省略低排名 Session，顺序读取可到达结尾", async () => {
    const memory = await createMemory();
    const first = memory.createSession(); const second = memory.createSession();
    await addCompletedRun(memory, first.id, "r1", "共同关键词", "第一结果");
    await addCompletedRun(memory, second.id, "r2", "共同关键词", "第二结果");
    const limited = await memory.searchSessions({ query: "共同关键词", limit: 2 }, { ...recall, tokenLimit: 260 });
    expect(limited).toMatchObject({ returnedSessionCount: 1, droppedSessionCount: 1, droppedReason: "token_budget", truncated: true });
    let page = await memory.readSession({ sessionId: first.id }, recall);
    while (page.nextCursor) page = await memory.readSession({ cursor: page.nextCursor }, recall);
    expect(page.isComplete).toBe(true);
  });

  it("再次打开当前版本数据库保留已写入记录", async () => {
    const directory = await mkdtemp(join(tmpdir(), "everything-memory-reopen-"));
    const first = new MemoryRuntime(directory);
    const session = first.createSession();
    await addCompletedRun(first, session.id, "r1", "保留内容", "保留结果");
    first.close();
    const reopened = new MemoryRuntime(directory);
    runtimes.push(reopened);
    expect((await reopened.searchSessions({ query: "保留内容" }, recall)).sessions).toHaveLength(1);
  });
});

async function createMemory(): Promise<MemoryRuntime> {
  const memory = new MemoryRuntime(await mkdtemp(join(tmpdir(), "everything-memory-"))); runtimes.push(memory); return memory;
}
async function addCompletedRun(memory: MemoryRuntime, sessionId: string, runId: string, prompt: string, reply: string): Promise<void> {
  memory.startRun(sessionId, runId, prompt);
  await memory.completeRun(sessionId, runId, [{ role: "assistant", content: [{ type: "text", text: reply }] }]);
}
function response(text: string): ModelResponse { return { content: [{ type: "text", text }], stop_reason: "end_turn" } }
function scriptedClient(items: Array<ModelResponse | Error>): AgentModelClient {
  return { messages: { async create() { const item = items.shift(); if (!item) throw new Error("没有脚本响应"); if (item instanceof Error) throw item; return item } } };
}
function options(memory: MemoryRuntime, client: AgentModelClient, currentSessionId: string) {
  void memory;
  return { client, model: "small", currentSessionId, recall };
}
