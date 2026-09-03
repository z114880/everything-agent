import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentModelClient, ModelResponse } from "../../agent-loop/agent-loop.ts";
import { MemoryRuntime, toSearchText } from "../index.ts";

const runtimes: MemoryRuntime[] = [];

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.close();
});

describe("Memory Runtime", () => {
  it("使用中文 bigram 投影和 BM25 检索原文", async () => {
    const memory = await createMemory();
    const created = memory.createSemantic("用户", "用户喜欢下午喝咖啡");
    memory.createSemantic("项目", "发布计划将在周五完成");

    expect(toSearchText("下午咖啡")).toContain("下午");
    expect(memory.searchSemantic("下午")).toEqual([
      expect.objectContaining({ id: created.id, content: "用户喜欢下午喝咖啡" }),
    ]);

    memory.updateSemantic(created.id, "用户", "用户喜欢上午喝茶");
    expect(memory.searchSemantic("下午")).toEqual([]);
    expect(memory.searchSemantic("上午")[0]).toMatchObject({ id: created.id });
    memory.deleteSemantic(created.id);
    expect(memory.searchSemantic("上午")).toEqual([]);
  });

  it("仅恢复最近的完整回合，并保留结构化工具过程", async () => {
    const memory = await createMemory();
    const session = memory.createSession();
    memory.startRun(session.id, "failed", "未完成问题");
    memory.startRun(session.id, "done", "现在几点");
    memory.completeRun(session.id, "done", [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "get_current_time", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "十二点" }] },
      { role: "assistant", content: [{ type: "text", text: "现在十二点。" }] },
    ]);

    expect(memory.getWorkingMemory(session.id, 10)).toEqual([
      { role: "user", content: "现在几点" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "get_current_time", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "十二点" }] },
      { role: "assistant", content: [{ type: "text", text: "现在十二点。" }] },
    ]);
  });

  it("在 Session 离开时增量整理事实并维持单一 episode", async () => {
    const memory = await createMemory();
    const session = memory.createSession();
    addCompletedRun(memory, session.id, "r1", "我喜欢红茶", "我记住了。");
    const client = scriptedClient([
      response('{"facts":[{"action":"create","category":"preference","stable":true,"futureUseful":true,"subject":"用户","content":"用户喜欢红茶"}],"episode":"用户说明了饮品偏好。"}'),
      response('{"facts":[{"action":"update","id":1,"category":"preference","stable":true,"futureUseful":true,"subject":"用户","content":"用户现在喜欢绿茶"}],"episode":"用户先说明喜欢红茶，后来把偏好改为绿茶。"}'),
    ]);

    memory.scheduleConsolidation(session.id, "new_session", { client, model: "small" });
    await memory.waitForConsolidation();
    expect(memory.listSemantic()).toEqual([expect.objectContaining({ content: "用户喜欢红茶" })]);
    expect(memory.listEpisodic()).toHaveLength(1);

    addCompletedRun(memory, session.id, "r2", "改成绿茶", "已更新你的偏好。");
    memory.scheduleConsolidation(session.id, "new_session", { client, model: "small" });
    await memory.waitForConsolidation();

    expect(memory.listSemantic()).toEqual([expect.objectContaining({ content: "用户现在喜欢绿茶" })]);
    expect(memory.listEpisodic()).toEqual([
      expect.objectContaining({ summary: "用户先说明喜欢红茶，后来把偏好改为绿茶。" }),
    ]);
    expect(memory.overview().pendingSessionCount).toBe(0);
  });

  it("拒绝把普通时间问答写入 semantic memory", async () => {
    const memory = await createMemory();
    const session = memory.createSession();
    addCompletedRun(
      memory,
      session.id,
      "r1",
      "现在的时间是几点？顺便告诉我现在的时间点对应美国几点",
      "北京时间十九点，美国东部时间七点。",
    );
    memory.scheduleConsolidation(session.id, "new_session", {
      model: "small",
      client: scriptedClient([
        response('{"facts":[{"action":"create","subject":"当前时间与美国时区换算","content":"北京时间十九点，美国东部时间七点"}],"episode":null}'),
      ]),
    });

    await memory.waitForConsolidation();

    expect(memory.listSemantic()).toEqual([]);
    expect(memory.listConsolidations()).toEqual([
      expect.objectContaining({ factsCreated: 0, factsSkipped: 1 }),
    ]);
  });

  it("consolidation 失败时不推进高水位", async () => {
    const memory = await createMemory();
    const session = memory.createSession();
    addCompletedRun(memory, session.id, "r1", "重要内容", "收到");
    memory.scheduleConsolidation(session.id, "startup", {
      model: "small",
      client: scriptedClient([response("不是 JSON")]),
    });
    await memory.waitForConsolidation();

    expect(memory.overview().pendingSessionCount).toBe(1);
    expect(memory.listConsolidations()).toEqual([
      expect.objectContaining({ status: "failed", errorType: "TypeError" }),
    ]);
  });

  it("gate 跳过时不检索，gate 失败时使用原消息执行回退检索", async () => {
    const memory = await createMemory();
    memory.createSemantic("用户", "用户喜欢下午开会");
    const skip = await memory.retrieve("二加二", [], {
      model: "small",
      client: scriptedClient([response('{"retrieve":false,"query":"","reason":"常识"}')]),
    });
    expect(skip.retrieved).toBe(false);

    const fallback = await memory.retrieve("下午", [], {
      model: "small",
      client: scriptedClient([new Error("网络失败")]),
    });
    expect(fallback.retrieved).toBe(true);
    expect(fallback.context).toContain("用户喜欢下午开会");
  });

  it("管理 Session 标题、聊天记录和删除边界", async () => {
    const memory = await createMemory();
    const first = memory.createSession("  ");
    const second = memory.createSession("工作");
    memory.startRun(first.id, "r1", "  帮我整理周报  ");
    memory.completeRun(first.id, "r1", [{ role: "assistant", content: "好的" }]);

    expect(memory.listSessions().find((item) => item.id === first.id))
      .toMatchObject({ title: "帮我整理周报", messageCount: 2 });
    expect(memory.renameSession(first.id, " 新标题 ")).toMatchObject({ title: "新标题" });
    expect(memory.getChatLog()).toHaveLength(2);
    expect(memory.getChatLog(first.id, 0)).toHaveLength(1);
    expect(() => memory.renameSession(first.id, " ")).toThrow("会话标题不能为空");
    expect(() => memory.renameSession("missing", "标题")).toThrow("Session 不存在");
    expect(() => memory.startRun("missing", "r2", "问题")).toThrow("Session 不存在");

    memory.deleteSession(second.id);
    expect(() => memory.deleteSession(second.id)).toThrow("Session 不存在");
  });

  it("重复初始化空聊天页时只创建一个默认 Session", async () => {
    const memory = await createMemory();

    const first = memory.ensureSession();
    const second = memory.ensureSession();

    expect(second.id).toBe(first.id);
    expect(memory.listSessions()).toEqual([expect.objectContaining({ id: first.id })]);
  });

  it("支持 UI 管理 episodic memory 并同步 FTS 索引", async () => {
    const memory = await createMemory();
    const item = memory.createEpisodic("完成了发布准备", "2026-09-03T10:20:30+08:00");
    expect(memory.searchEpisodic("发布准备")[0]).toMatchObject({ id: item.id });
    expect(memory.searchEpisodic(" ")).toEqual([]);

    memory.updateEpisodic(item.id, "完成了正式发布", "2026-09-03T11:22:33+08:00");
    expect(memory.searchEpisodic("准备")).toEqual([]);
    expect(memory.searchEpisodic("正式发布")[0]).toMatchObject({ happenedAt: "2026-09-03T11:22:33+08:00" });
    memory.deleteEpisodic(item.id);
    expect(memory.listEpisodic()).toEqual([]);

    expect(() => memory.createEpisodic(" ", "2026-09-03T10:20:30+08:00")).toThrow("Summary 不能为空");
    expect(() => memory.updateEpisodic(999, "事件", "2026-09-03T10:20:30+08:00")).toThrow("Episodic memory 不存在");
    expect(() => memory.deleteEpisodic(999)).toThrow("Episodic memory 不存在");
  });

  it("检索两类记忆并输出精确到秒的时间和观察事件", async () => {
    const memory = await createMemory();
    memory.createSemantic("项目", "项目发布安排在周五");
    memory.createEpisodic("周五完成项目发布", "2026-09-03T10:20:30+08:00");
    const events: string[] = [];
    const result = await memory.retrieve("周五项目发布", [{ role: "user", content: "项目如何了" }], {
      model: "small",
      client: scriptedClient([response('前缀 {"retrieve":true,"query":"周五项目发布","reason":"涉及计划"} 后缀')]),
      observer: async (event) => { events.push(event); },
    });

    expect(result.semantic).toHaveLength(1);
    expect(result.episodic).toHaveLength(1);
    expect(result.context).toMatch(/\d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}/);
    expect(events).toEqual(["gate_start", "gate_end", "retrieval"]);
  });

  it("启动时串行整理全部有积压的 Session", async () => {
    const memory = await createMemory();
    const first = memory.createSession("一");
    const second = memory.createSession("二");
    addCompletedRun(memory, first.id, "r1", "普通问答", "回答");
    addCompletedRun(memory, second.id, "r2", "另一个问答", "回答");
    memory.schedulePendingConsolidations({
      model: "small",
      client: scriptedClient([
        response('{"facts":[{"action":"noop"}],"episode":null}'),
        response('{"facts":[],"episode":null}'),
      ]),
    });
    await memory.waitForConsolidation();

    expect(memory.listConsolidations()).toHaveLength(2);
    expect(memory.overview()).toMatchObject({ pendingSessionCount: 0, semanticCount: 0, episodicCount: 0 });
  });

  it("校验 semantic memory 的必填字段和不存在目标", async () => {
    const memory = await createMemory();
    expect(memory.searchSemantic(" ")).toEqual([]);
    expect(() => memory.createSemantic(" ", "内容")).toThrow("Subject 不能为空");
    expect(() => memory.createSemantic("主题", " ")).toThrow("Content 不能为空");
    expect(() => memory.updateSemantic(999, "主题", "内容")).toThrow("Semantic memory 不存在");
    expect(() => memory.deleteSemantic(999)).toThrow("Semantic memory 不存在");
  });
});

async function createMemory(): Promise<MemoryRuntime> {
  const directory = await mkdtemp(join(tmpdir(), "everything-memory-"));
  const memory = new MemoryRuntime(directory);
  runtimes.push(memory);
  return memory;
}

function addCompletedRun(memory: MemoryRuntime, sessionId: string, runId: string, prompt: string, reply: string): void {
  memory.startRun(sessionId, runId, prompt);
  memory.completeRun(sessionId, runId, [{ role: "assistant", content: [{ type: "text", text: reply }] }]);
}

function response(text: string): ModelResponse {
  return { content: [{ type: "text", text }], stop_reason: "end_turn" };
}

function scriptedClient(items: Array<ModelResponse | Error>): AgentModelClient {
  return {
    messages: {
      async create() {
        const item = items.shift();
        if (!item) throw new Error("没有脚本响应");
        if (item instanceof Error) throw item;
        return item;
      },
    },
  };
}
