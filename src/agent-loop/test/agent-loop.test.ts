import { describe, expect, it, vi } from "vitest";
import {
  AgentLoopAbortError,
  AgentLoopTimeoutError,
  runAgentLoop,
} from "../../index.ts";
import type {
  AgentLoopOptions,
  AgentMessage,
  AgentModelClient,
  ModelResponse,
  ToolRegistry,
} from "../agent-loop.ts";

type ObservedEvent = { kind: string; event: Record<string, any> };

function textResponse(text: string, overrides: Partial<ModelResponse> = {}): ModelResponse {
  return {
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    tokenUsage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    ...overrides,
  };
}

function toolResponse(
  name: string,
  input: Record<string, unknown>,
  id = "tool-1",
): ModelResponse {
  return {
    content: [{ type: "tool_use", id, name, input }],
    stop_reason: "tool_use",
    tokenUsage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 },
  };
}

function scriptedClient(responses: ModelResponse[]): AgentModelClient {
  return {
    messages: {
      create: vi.fn(async () => responses.shift()!),
    },
  };
}

function fakeTools(execute = vi.fn()): ToolRegistry {
  return {
    schemas: vi.fn(() => [{ name: "lookup", input_schema: { type: "object" } }]),
    execute,
  };
}

describe("runAgentLoop", () => {
  it("通过根入口公开，并在模型不请求工具时自然结束", async () => {
    const client = scriptedClient([textResponse("你好")]);
    const tools = fakeTools();
    const messages: AgentMessage[] = [{ role: "user", content: "打招呼" }];
    const events: ObservedEvent[] = [];

    const result = await runAgentLoop({
      client,
      model: "test-model",
      system: "你是助理",
      messages,
      tools,
      observer(kind, event) {
        events.push({ kind, event });
      },
    });

    expect(result).toEqual({
      reply: "你好",
      toolCalls: [],
      iterations: 1,
      stopReason: "completed",
    });
    expect(messages.at(-1)).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "你好" }],
    });
    expect(client.messages.create).toHaveBeenCalledWith(expect.objectContaining({
      model: "test-model",
      system: "你是助理",
      messages,
      max_tokens: 2048,
    }));
    expect(events.map(({ kind }) => kind)).toEqual([
      "context_assembled",
      "loop_start",
      "model_request",
      "model_response",
      "llm",
      "reply",
      "loop_end",
    ]);
    expect(events[2]!.event).toMatchObject({
      iteration: 1,
      modelCallId: expect.any(String),
      request: {
        model: "test-model",
        system: "你是助理",
        messages: [{ role: "user", content: "打招呼" }],
        tools: [{ name: "lookup", input_schema: { type: "object" } }],
        maxTokens: 2048,
        stream: false,
      },
    });
    expect(events[3]!.event).toMatchObject({
      iteration: 1,
      modelCallId: events[2]!.event.modelCallId,
      response: { content: [{ type: "text", text: "你好" }] },
      stopReason: "end_turn",
      tokenUsage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    });
    expect(events.every(({ event }) => typeof event.runId === "string")).toBe(true);
  });

  it("执行模型请求的工具，并把观察结果加入下一轮工作记忆", async () => {
    const client = scriptedClient([
      toolResponse("lookup", { city: "上海" }),
      textResponse("上海今天晴。"),
    ]);
    const execute = vi.fn(async () => ({ weather: "晴" }));
    const tools = fakeTools(execute);
    const messages: AgentMessage[] = [{ role: "user", content: "天气如何？" }];
    const events: ObservedEvent[] = [];

    const result = await runAgentLoop({
      client,
      model: "test-model",
      messages,
      tools,
      observer(kind, event) {
        events.push({ kind, event });
      },
    });

    expect(result).toMatchObject({
      reply: "上海今天晴。",
      iterations: 2,
      stopReason: "completed",
      toolCalls: [{
        tool: "lookup",
        args: { city: "上海" },
        output: '{"weather":"晴"}',
        toolUseId: "tool-1",
        iteration: 1,
        isError: false,
      }],
    });
    expect(execute).toHaveBeenCalledWith(
      "lookup",
      { city: "上海" },
      expect.any(Function),
      expect.objectContaining({ iteration: 1, toolUseId: "tool-1" }),
    );
    expect(messages[2]).toEqual({
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "tool-1",
        content: '{"weather":"晴"}',
      }],
    });
    expect(events.find(({ kind }) => kind === "tool")!.event).toMatchObject({
      tool: "lookup",
      arguments: { city: "上海" },
      result: { weather: "晴" },
    });
    expect(events.find(({ kind }) => kind === "tool_started")!.event).toMatchObject({
      tool: "lookup",
      iteration: 1,
      toolCallId: "tool-1",
    });
    expect(events.find(({ kind }) => kind === "tool_completed")!.event).toMatchObject({
      tool: "lookup",
      result: { weather: "晴" },
      isError: false,
      ms: expect.any(Number),
    });
    const modelRequests = events.filter(({ kind }) => kind === "model_request");
    expect(modelRequests[0]?.event.request.messages).toHaveLength(1);
    expect(modelRequests[1]?.event.request.messages).toHaveLength(3);
  });

  it("允许调用方只向 observer 暴露经过脱敏的工具摘要", async () => {
    const events: ObservedEvent[] = [];
    await runAgentLoop({
      client: scriptedClient([
        toolResponse("lookup", { token: "secret" }),
        textResponse("完成"),
      ]),
      model: "test-model",
      messages: [],
      tools: fakeTools(vi.fn(() => "private result")),
      serializeToolEvent(call) {
        return { tool: call.tool, outputLength: call.output.length };
      },
      observer(kind, event) {
        events.push({ kind, event });
      },
    });

    expect(events.find(({ kind }) => kind === "tool")!.event).toMatchObject({
      tool: "lookup",
      outputLength: 14,
    });
  });

  it("每次模型调用前拒绝超过 token Context Window 的完整输入", async () => {
    const client = scriptedClient([textResponse("不应调用")]);
    const tokenEstimator = { estimateRequest: vi.fn(() => 100), estimateText: vi.fn(() => 1) };
    await expect(runAgentLoop({
      client,
      model: "test-model",
      system: "系统规则",
      messages: [{ role: "user", content: "x".repeat(100) }],
      tools: fakeTools(),
      modelContextWindow: 2_600,
      tokenEstimator,
    })).rejects.toThrow("超过 Context Window");
    expect(tokenEstimator.estimateRequest).toHaveBeenCalledOnce();
    expect(client.messages.create).not.toHaveBeenCalled();
  });

  it("把工具异常作为可观察结果交回模型，而不是中断整个循环", async () => {
    const client = scriptedClient([
      toolResponse("lookup", {}),
      textResponse("工具失败，我无法查询。"),
    ]);
    const messages: AgentMessage[] = [];
    const events: ObservedEvent[] = [];

    const result = await runAgentLoop({
      client,
      model: "test-model",
      messages,
      tools: fakeTools(vi.fn(() => { throw new Error("网络不可用"); })),
      observer(kind, event) {
        events.push({ kind, event });
      },
    });

    expect(result.reply).toContain("工具失败");
    expect(result.toolCalls[0]).toMatchObject({ isError: true });
    expect(result.toolCalls[0]!.output).toContain("网络不可用");
    expect(messages[1]!.content[0]).toMatchObject({ is_error: true });
    expect(events.find(({ kind }) => kind === "tool_failed")?.event).toMatchObject({
      toolCallId: "tool-1",
      isError: true,
      result: expect.stringContaining("网络不可用"),
    });
  });

  it("模型调用失败时使用同一 modelCallId 记录请求与失败", async () => {
    const events: ObservedEvent[] = [];
    const client: AgentModelClient = {
      messages: { create: vi.fn(() => { throw new Error("模型不可用"); }) },
    };

    await expect(runAgentLoop({
      client,
      model: "test-model",
      messages: [{ role: "user", content: "你好" }],
      tools: fakeTools(),
      observer(kind, event) {
        events.push({ kind, event });
      },
    })).rejects.toThrow("模型不可用");

    const request = events.find(({ kind }) => kind === "model_request")!.event;
    expect(events.find(({ kind }) => kind === "model_failed")?.event).toMatchObject({
      modelCallId: request.modelCallId,
      errorType: "Error",
      errorMessage: "模型不可用",
    });
  });

  it("达到最大迭代次数后有界停止", async () => {
    const client = scriptedClient([
      toolResponse("lookup", {}, "tool-1"),
      toolResponse("lookup", {}, "tool-2"),
    ]);

    const result = await runAgentLoop({
      client,
      model: "test-model",
      messages: [],
      tools: fakeTools(vi.fn(() => "继续")),
      maxIterations: 2,
    });

    expect(result).toMatchObject({
      iterations: 2,
      stopReason: "max_iterations",
    });
    expect(result.reply).toContain("最大迭代次数");
    expect(result.toolCalls).toHaveLength(2);
  });

  it("支持流式文本事件，并使用最终消息决定是否继续", async () => {
    async function* textStream() {
      yield "你";
      yield "好";
    }
    const client = scriptedClient([]);
    client.messages.stream = vi.fn(async () => ({
      textStream: textStream(),
      getFinalMessage: vi.fn(async () => textResponse("你好")),
    }));
    const events: ObservedEvent[] = [];

    const result = await runAgentLoop({
      client,
      model: "test-model",
      messages: [],
      tools: fakeTools(),
      stream: true,
      observer(kind, event) {
        events.push({ kind, event });
      },
    });

    expect(result.reply).toBe("你好");
    expect(client.messages.create).not.toHaveBeenCalled();
    expect(events.filter(({ kind }) => kind === "text").map(({ event }) => event.delta))
      .toEqual(["你", "好"]);
  });

  it("流式调用失败时发送降级事件并改用普通调用", async () => {
    const client = scriptedClient([textResponse("降级成功")]);
    client.messages.stream = vi.fn(() => { throw new Error("连接中断"); });
    const events: ObservedEvent[] = [];

    const result = await runAgentLoop({
      client,
      model: "test-model",
      messages: [],
      tools: fakeTools(),
      stream: true,
      observer(kind, event) {
        events.push({ kind, event });
      },
    });

    expect(result.reply).toBe("降级成功");
    expect(events).toContainEqual(expect.objectContaining({ kind: "stream_fallback" }));
  });

  it("响应取消信号，并留下 loop_error 事件", async () => {
    const controller = new AbortController();
    controller.abort();
    const events: ObservedEvent[] = [];

    await expect(runAgentLoop({
      client: scriptedClient([textResponse("不会到达")]),
      model: "test-model",
      messages: [],
      tools: fakeTools(),
      signal: controller.signal,
      observer(kind, event) {
        events.push({ kind, event });
      },
    })).rejects.toBeInstanceOf(AgentLoopAbortError);

    expect(events.at(-1)).toMatchObject({ kind: "loop_error" });
  });

  it("整轮超时后停止等待模型", async () => {
    const client: AgentModelClient = {
      messages: { create: () => new Promise<ModelResponse>(() => {}) },
    };

    await expect(runAgentLoop({
      client,
      model: "test-model",
      messages: [],
      tools: fakeTools(),
      timeoutMs: 5,
    })).rejects.toBeInstanceOf(AgentLoopTimeoutError);
  });

  it.each([
    [{ client: {}, model: "x", messages: [], tools: fakeTools() }, "client.messages.create"],
    [{ client: scriptedClient([]), model: "x", messages: {}, tools: fakeTools() }, "messages"],
    [{ client: scriptedClient([]), model: "x", messages: [], tools: {} }, "tools"],
    [{ client: scriptedClient([]), model: "x", messages: [], tools: fakeTools(), maxIterations: 0 }, "maxIterations"],
    [{ client: scriptedClient([]), model: "x", messages: [], tools: fakeTools(), maxTokens: 0 }, "maxTokens"],
    [{ client: scriptedClient([]), model: "x", messages: [], tools: fakeTools(), modelContextWindow: 0 }, "modelContextWindow"],
    [{ client: scriptedClient([]), model: "x", messages: [], tools: fakeTools(), timeoutMs: 0 }, "timeoutMs"],
    [{ client: scriptedClient([]), model: "x", messages: [], tools: fakeTools(), observer: null }, "observer"],
    [{ client: scriptedClient([]), model: "x", messages: [], tools: fakeTools(), serializeToolEvent: null }, "serializeToolEvent"],
  ])("拒绝无效配置：%s", async (options, field) => {
    await expect(runAgentLoop(options as unknown as AgentLoopOptions)).rejects.toThrow(field);
  });
});
