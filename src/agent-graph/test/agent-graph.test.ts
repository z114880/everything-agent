import { describe, expect, it, vi } from "vitest";
import {
  agentHarnessGraph,
  createModelClient,
  LocalToolRegistry,
} from "../../index.ts";

describe("Agent Harness", () => {
  it("通过公开接口描述从 Working Memory 开始的工具循环", () => {
    expect(agentHarnessGraph.describe()).toEqual({
      name: "agent-harness",
      nodes: [
        { name: "working_memory", kind: "fn", maxVisits: 1 },
        { name: "llm", kind: "llm", maxVisits: 10 },
        { name: "tools", kind: "tool", maxVisits: 10 },
        { name: "reply", kind: "fn", maxVisits: 1 },
      ],
      edges: [
        { source: "START", target: "working_memory", conditional: false },
        { source: "working_memory", target: "llm", conditional: false },
        { source: "tools", target: "llm", conditional: false },
        { source: "reply", target: "END", conditional: false },
        { source: "llm", target: "tools", conditional: true },
        { source: "llm", target: "reply", conditional: true },
      ],
    });
  });

  it("只执行已注册的只读时间工具", async () => {
    const registry = new LocalToolRegistry();
    expect(registry.schemas()).toEqual([expect.objectContaining({ name: "get_current_time" })]);
    const result = await registry.execute("get_current_time", {}, vi.fn(), {
      signal: undefined,
      deadline: null,
      iteration: 1,
      toolUseId: "tool-1",
    });
    expect(result).toEqual(expect.objectContaining({
      iso: expect.any(String),
      timeZone: expect.any(String),
      local: expect.any(String),
    }));
    expect(() => registry.execute("unknown", {}, vi.fn(), {
      signal: undefined,
      deadline: null,
      iteration: 1,
      toolUseId: "tool-2",
    })).toThrow("工具未注册");
    expect(() => registry.execute("get_current_time", { extra: true }, vi.fn(), {
      signal: undefined,
      deadline: null,
      iteration: 1,
      toolUseId: "tool-3",
    })).toThrow("不接受参数");
  });
});

describe("模型客户端", () => {
  it("把 OpenAI Compatible 普通响应转换为 Agent Loop 内容块", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      choices: [{
        finish_reason: "tool_calls",
        message: {
          content: null,
          tool_calls: [{
            id: "call-1",
            function: { name: "get_current_time", arguments: "{}" },
          }],
        },
      }],
      usage: { prompt_tokens: 4, completion_tokens: 2 },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const client = createModelClient({
      provider: "openai-compatible",
      apiKey: "secret",
      baseUrl: "https://example.test/v1",
    });
    const result = await client.messages.create({
      model: "test-model",
      system: "系统提示",
      messages: [{ role: "user", content: "现在几点" }],
      tools: [{ name: "get_current_time", input_schema: { type: "object" } }],
      max_tokens: 100,
      signal: undefined,
    });

    expect(result).toMatchObject({
      content: [{ type: "tool_use", id: "call-1", name: "get_current_time", input: {} }],
      stop_reason: "tool_calls",
      usage: { input_tokens: 4, output_tokens: 2 },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.test/v1/chat/completions",
      expect.objectContaining({ method: "POST" }),
    );
    fetchMock.mockRestore();
  });

  it("消费 OpenAI Compatible SSE 并保留逐字文本", async () => {
    const payload = [
      'data: {"choices":[{"delta":{"content":"你"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"content":"好"},"finish_reason":"stop"}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1}}',
      "data: [DONE]",
      "",
    ].join("\n\n");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(payload, { status: 200 }));
    const client = createModelClient({ provider: "openai-compatible", apiKey: "secret" });
    const stream = await client.messages.stream!({
      model: "test-model",
      system: "",
      messages: [],
      tools: [],
      max_tokens: 100,
      signal: undefined,
    });
    const chunks: string[] = [];
    for await (const chunk of stream.textStream) chunks.push(String(chunk));
    expect(chunks).toEqual(["你", "好"]);
    expect(await stream.getFinalMessage()).toMatchObject({
      content: [{ type: "text", text: "你好" }],
      stop_reason: "stop",
      usage: { input_tokens: 2, output_tokens: 1 },
    });
    vi.restoreAllMocks();
  });

  it("消费 Anthropic SSE 的文本与分段工具参数", async () => {
    const payload = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"先查时间。"}}',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tool-1","name":"get_current_time","input":{}}}',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{"}}',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"}"}}',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":4}}',
      "",
    ].join("\n\n");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(payload, { status: 200 }));
    const client = createModelClient({ provider: "anthropic", apiKey: "secret" });
    const stream = await client.messages.stream!({
      model: "test-model",
      system: "系统提示",
      messages: [{ role: "user", content: "现在几点" }],
      tools: [],
      max_tokens: 100,
      signal: undefined,
    });
    const chunks: string[] = [];
    for await (const chunk of stream.textStream) chunks.push(String(chunk));
    expect(chunks).toEqual(["先查时间。"]);
    expect(await stream.getFinalMessage()).toMatchObject({
      content: [
        { type: "text", text: "先查时间。" },
        { type: "tool_use", id: "tool-1", name: "get_current_time", input: {} },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 3, output_tokens: 4 },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/messages",
      expect.objectContaining({ headers: expect.objectContaining({ "x-api-key": "secret" }) }),
    );
    vi.restoreAllMocks();
  });
});
