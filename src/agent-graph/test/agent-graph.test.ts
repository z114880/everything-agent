import { describe, expect, it, vi } from "vitest";
import {
  agentHarnessGraph,
  createModelClient,
  LocalToolRegistry,
} from "../../index.ts";

describe("Agent Harness", () => {
  it("业务拓扑从用户输入开始并包含召回和独立后台记忆关系", () => {
    const graph = agentHarnessGraph.describe();
    expect(graph.nodes.map((node) => node.name)).toEqual(expect.arrayContaining([
      "user_prompt", "session_chat_history", "system_prompt", "procedural_memory",
      "retrieval_gate", "semantic_recall", "session_recall", "working_memory",
      "memory_queue", "consolidate_trigger", "consolidation", "memory_review", "memory_commit", "semantic_store",
    ]));
    const edges = graph.edges.map((edge) => `${edge.source}->${edge.target}`);
    expect(edges).toContain("START->user_prompt");
    expect(edges).not.toContain("START->working_memory");
    expect(edges).toEqual(expect.arrayContaining([
      "retrieval_gate->working_memory", "retrieval_gate->semantic_recall", "retrieval_gate->session_recall",
      "llm->tools", "tools->llm", "llm->reply", "tools->memory_queue",
      "consolidate_trigger->consolidate_snapshot", "consolidation->consolidate_commit", "memory_queue->memory_review",
      "memory_review->memory_commit", "memory_commit->semantic_store",
    ]));
    const isolated = new Set(["consolidate_trigger", "consolidate_snapshot", "consolidation", "consolidate_commit", "consolidate_result"]);
    expect(graph.edges.every((edge) => isolated.has(edge.source) === isolated.has(edge.target))).toBe(true);
    expect(edges).not.toContain("reply->consolidation");
    expect(edges).not.toContain("memory_commit->reply");
    expect(graph.edges.find((edge) => edge.source === "llm" && edge.target === "tools")?.conditional).toBe(true);
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
      tokenUsage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
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
      tokenUsage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
    });
    vi.restoreAllMocks();
  });

  it("消费 Anthropic SSE 的文本与分段工具参数", async () => {
    const payload = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":3,"cache_read_input_tokens":2,"cache_creation_input_tokens":1}}}',
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
      tokenUsage: { inputTokens: 6, outputTokens: 4, totalTokens: 10 },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/messages",
      expect.objectContaining({ headers: expect.objectContaining({ "x-api-key": "secret" }) }),
    );
    vi.restoreAllMocks();
  });

  it("供应商缺少完整 usage 时明确返回 null", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: "完成" } }],
      usage: { prompt_tokens: 4 },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const client = createModelClient({ provider: "openai-compatible", apiKey: "secret" });
    const response = await client.messages.create({
      model: "test-model", system: "", messages: [], tools: [], max_tokens: 100, signal: undefined,
    });
    expect(response.tokenUsage).toBeNull();
    vi.restoreAllMocks();
  });
});
