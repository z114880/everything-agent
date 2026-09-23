import { afterEach, describe, expect, it, vi } from "vitest";
import { runAgentLoop, AgentLoopAbortError, AgentLoopTimeoutError, type AgentMessage, type AgentLoopOptions, type ContextCompaction, type ModelRequest, type ModelResponse } from "../agent-loop.ts";

const response = (text: string): ModelResponse => ({ content: [{ type: "text", text }], stop_reason: "end_turn" });
const estimator = {
  estimateText: (text: string) => text.length,
  estimateRequest: (request: ModelRequest) => request.system.length + JSON.stringify(request.messages).length + JSON.stringify(request.tools).length,
};
const user = (content: string): AgentMessage => ({ role: "user", content });
const assistant = (content: string): AgentMessage => ({ role: "assistant", content });
const toolCall = (id: string): ModelResponse => ({ content: [{ type: "tool_use", id, name: "read", input: {} }] });
function setup(messages: AgentMessage[], overrides: Partial<AgentLoopOptions> = {}) {
  const calls: ModelRequest[] = [];
  const events: Array<{ kind: string; event: Record<string, unknown> }> = [];
  const checkpoints: ContextCompaction[] = [];
  const create = vi.fn(async (request: ModelRequest) => {
    calls.push(structuredClone({ ...request, signal: undefined }));
    return response(request.tools instanceof Array && request.tools.length === 0 ? "目标：继续任务。约束：使用中文。" : "完成");
  });
  const options: AgentLoopOptions = {
    client: { messages: { create } }, model: "主模型", messages,
    tools: { schemas: () => [{ name: "read" }], execute: () => "结果" },
    tokenEstimator: estimator, modelContextWindow: 10_000, maxTokens: 500,
    observer: (kind, event) => { events.push({ kind, event }); },
    onCompacted: (checkpoint) => { checkpoints.push(structuredClone(checkpoint)); },
    ...overrides,
  };
  return { options, calls, events, checkpoints, create };
}
afterEach(() => vi.useRealTimers());

describe("自动上下文压缩", () => {
  it("达到输入额度七成后使用主模型摘要，保留当前原文与完整历史记录", async () => {
    const history = [user("旧需求".repeat(1800)), assistant("已完成旧需求".repeat(200)), user("继续，不能修改文件")];
    const original = structuredClone(history);
    const fixture = setup(history);
    await runAgentLoop(fixture.options);
    expect(fixture.checkpoints).toHaveLength(1);
    const compacted = fixture.checkpoints[0]!;
    expect(compacted.targetTokens).toBe(Math.floor((10_000 - 500 - 512) * 0.3));
    expect(compacted.afterTokens).toBeLessThanOrEqual(compacted.targetTokens);
    expect(compacted.messages.at(-1)).toEqual(original.at(-1));
    expect(history.slice(0, original.length)).toEqual(original);
    expect(history.at(-1)).toMatchObject({ role: "assistant", content: [{ text: "完成" }] });
    expect(fixture.calls[0]).toMatchObject({ model: "主模型", tools: [] });
    expect(fixture.calls.at(-1)?.messages).toEqual(compacted.messages);
    const names = fixture.events.map((item) => item.kind);
    expect(names.indexOf("compact_started")).toBeLessThan(names.indexOf("compact_model_started"));
    expect(names.indexOf("compact_model_completed")).toBeLessThan(names.indexOf("compact_completed"));
    expect(names.indexOf("compact_completed")).toBeLessThan(names.indexOf("model_request"));
    const compactEvents = fixture.events.filter((item) => item.kind.startsWith("compact_"));
    expect(JSON.stringify(compactEvents)).not.toContain("旧需求");
    expect(JSON.stringify(compactEvents)).not.toContain("目标：继续任务");
  });

  it("七成以下不发起摘要调用", async () => {
    const fixture = setup([user("你好")]);
    await runAgentLoop(fixture.options);
    expect(fixture.create).toHaveBeenCalledTimes(1);
    expect(fixture.checkpoints).toEqual([]);
  });

  it("恰好达到七成才触发，并把系统提示与工具定义计入额度", async () => {
    for (const delta of [-1, 0]) {
      const messages = [user("x".repeat(4000)), assistant("旧回复"), user("当前请求")];
      const base = setup(messages, { system: "固定规则".repeat(100) });
      const ordinaryEstimate = estimator.estimateRequest({ model: "主模型", system: base.options.system!, messages, tools: base.options.tools.schemas(), max_tokens: 500, signal: undefined });
      const allowance = 9000;
      const padding = allowance * 0.7 + delta - ordinaryEstimate;
      base.options.modelContextWindow = allowance + 500 + 512;
      base.options.tokenEstimator = { ...estimator, estimateRequest: (request) => estimator.estimateRequest(request) + padding };
      await runAgentLoop(base.options);
      expect(base.checkpoints.length).toBe(delta === 0 ? 1 : 0);
    }
  });

  it("单轮工具循环增长后压缩，调用与结果成对保留且保护当前请求", async () => {
    let turn = 0;
    const fixture = setup([user("一直保留这条请求")], {
      tools: { schemas: () => [{ name: "read" }], execute: () => "工具原文".repeat(800) },
    });
    fixture.create.mockImplementation(async (request) => {
      fixture.calls.push(structuredClone({ ...request, signal: undefined }));
      if (Array.isArray(request.tools) && request.tools.length === 0) return response("工具结论已保存");
      return ++turn < 3 ? toolCall(`tool-${turn}`) : response("完成");
    });
    await runAgentLoop(fixture.options);
    expect(fixture.checkpoints).toHaveLength(1);
    const checkpoint = fixture.checkpoints[0]!;
    expect(checkpoint.iteration).toBe(3);
    expect(checkpoint.messages).toContainEqual(user("一直保留这条请求"));
    const blocks = checkpoint.messages.flatMap((message) => Array.isArray(message.content) ? message.content : []);
    expect(blocks.filter((block) => block.type === "tool_use").map((block) => block.id)).toEqual(["tool-2"]);
    expect(blocks.filter((block) => block.type === "tool_result").map((block) => block.tool_use_id)).toEqual(["tool-2"]);
    expect(checkpoint.targetReached).toBe(false);
    expect(fixture.options.messages).toHaveLength(6);
  });

  it("失败后仍在硬限制内继续，同一轮工具循环不重试摘要", async () => {
    let turn = 0;
    const fixture = setup([user("a".repeat(7000)), assistant("旧回复"), user("继续")]);
    fixture.create.mockImplementation(async (request) => {
      if (Array.isArray(request.tools) && request.tools.length === 0) throw new Error("服务不可用");
      return ++turn === 1 ? toolCall("one") : response("完成");
    });
    await expect(runAgentLoop(fixture.options)).resolves.toMatchObject({ reply: "完成" });
    expect(fixture.events.filter(({ kind }) => kind === "compact_started")).toHaveLength(1);
    expect(fixture.events.some(({ kind }) => kind === "compact_failed")).toBe(true);
    expect(fixture.checkpoints).toEqual([]);
  });

  it.each(["空摘要", "截断", "工具调用", "无收益", "持久化失败"])("%s 不替换上下文", async (failure) => {
    const fixture = setup([user("a".repeat(7000)), assistant("旧回复"), user("继续")]);
    fixture.create.mockImplementation(async (request) => {
      if (Array.isArray(request.tools) && request.tools.length === 0) {
        if (failure === "空摘要") return response(" ");
        if (failure === "截断") return { ...response("被截断"), stop_reason: "max_tokens" };
        if (failure === "工具调用") return toolCall("不允许");
        return response(failure === "无收益" ? "x".repeat(9000) : "有效摘要");
      }
      expect(request.messages[0]?.content).toBe("a".repeat(7000));
      return response("完成");
    });
    if (failure === "持久化失败") fixture.options.onCompacted = () => { throw new Error("磁盘写入失败"); };
    await runAgentLoop(fixture.options);
    expect(fixture.checkpoints).toEqual([]);
    expect(fixture.events.find(({ kind }) => kind === "compact_failed")?.event.reasonCode)
      .toBe(failure === "持久化失败" ? "persistence_failed" : failure === "无收益" ? "not_reduced" : "invalid_summary");
  });

  it("历史超过单次摘要输入额度时分批读完，最终只提交一次", async () => {
    const fixture = setup([user("a".repeat(24000)), assistant("已结束"), user("继续")]);
    await runAgentLoop(fixture.options);
    const summaries = fixture.calls.filter((request) => Array.isArray(request.tools) && request.tools.length === 0);
    expect(summaries.length).toBeGreaterThan(1);
    for (const request of summaries) expect(estimator.estimateRequest(request) + request.max_tokens + 512).toBeLessThanOrEqual(10_000);
    const fragments = summaries.map((request) => JSON.parse(request.messages[0]!.content).historyFragment).join("");
    expect(fragments).toContain("a".repeat(24000));
    expect(fixture.checkpoints).toHaveLength(1);
  });

  it("摘要失败且原输入超过硬限制时停止，不发送主任务请求", async () => {
    const fixture = setup([user("a".repeat(12000)), assistant("旧回复"), user("继续")]);
    fixture.create.mockRejectedValue(new Error("失败"));
    await expect(runAgentLoop(fixture.options)).rejects.toThrow("超过 Context Window");
    expect(fixture.events.some(({ kind }) => kind === "model_request")).toBe(false);
  });

  it("没有可压缩旧内容时不循环调用摘要，必要输入超限则明确停止", async () => {
    const fixture = setup([user("a".repeat(12000))]);
    await expect(runAgentLoop(fixture.options)).rejects.toThrow("超过 Context Window");
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it.each(["取消", "超时"])("摘要%s与晚到响应不会提交检查点", async (mode) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fixture = setup([user("a".repeat(7000)), assistant("旧回复"), user("继续")], { signal: controller.signal, timeoutMs: 100 });
    let resolve!: (response: ModelResponse) => void;
    let started!: () => void;
    const entered = new Promise<void>((r) => { started = r; });
    fixture.create.mockImplementation(() => { started(); return new Promise<ModelResponse>((r) => { resolve = r; }); });
    const running = runAgentLoop(fixture.options);
    const rejected = expect(running).rejects.toBeInstanceOf(mode === "取消" ? AgentLoopAbortError : AgentLoopTimeoutError);
    await entered;
    if (mode === "取消") controller.abort(); else await vi.advanceTimersByTimeAsync(101);
    await rejected;
    resolve(response("晚到摘要"));
    await Promise.resolve();
    expect(fixture.checkpoints).toEqual([]);
    expect(fixture.events.some(({ kind }) => kind === "compact_completed")).toBe(false);
  });
});

it("持续工具增长可以多次压缩，每次合并旧摘要而不叠加摘要消息", async () => {
  let turn = 0;
  const fixture = setup([user("保护当前请求")], {
    tools: { schemas: () => [{ name: "read" }], execute: () => "x".repeat(3700) },
  });
  fixture.create.mockImplementation(async (request) => {
    if (Array.isArray(request.tools) && request.tools.length === 0) return response("统一摘要");
    expect(request.messages.filter((message) => message.contextSummary === true).length).toBeLessThanOrEqual(1);
    expect(request.messages).toContainEqual(user("保护当前请求"));
    return ++turn < 5 ? toolCall(`tool-${turn}`) : response("完成");
  });
  await runAgentLoop(fixture.options);
  expect(fixture.checkpoints.length).toBeGreaterThan(1);
  expect(new Set(fixture.checkpoints.map((item) => item.compactionId)).size).toBe(fixture.checkpoints.length);
});

it.each(["批次上限", "摘要请求无额度"])("%s 时不提交不完整摘要", async (scenario) => {
  const fixture = setup([user("x".repeat(50000)), assistant("旧结果"), user("当前请求")], {
    modelContextWindow: scenario === "批次上限" ? 2000 : 800, maxTokens: 500,
  });
  await expect(runAgentLoop(fixture.options)).rejects.toThrow("超过 Context Window");
  expect(fixture.checkpoints).toEqual([]);
  expect(fixture.events.some(({ kind }) => kind === "compact_failed")).toBe(true);
  expect(fixture.events.filter(({ kind }) => kind === "compact_model_started").length).toBe(scenario === "批次上限" ? 32 : 0);
});

it("检查点提交后的观察者故障终止回合，不报告已回滚的假象", async () => {
  const fixture = setup([user("a".repeat(7000)), assistant("旧回复"), user("继续")]);
  fixture.options.observer = (kind, event) => {
    fixture.events.push({ kind, event });
    if (kind === "compact_completed") throw new Error("观察者不可用");
  };
  await expect(runAgentLoop(fixture.options)).rejects.toThrow("观察者不可用");
  expect(fixture.checkpoints).toHaveLength(1);
  expect(fixture.events.some(({ kind }) => kind === "compact_failed")).toBe(false);
});
