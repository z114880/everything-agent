import { afterEach, describe, expect, it, vi } from "vitest";
import { createModelClient, runAgentLoop, type ModelRequest } from "../../index.ts";

const request: ModelRequest = {
  model: "gemini-test", system: "使用中文", messages: [{ role: "user", content: "你好" }],
  tools: [], max_tokens: 512, signal: undefined,
};
const reply = (parts: unknown[], extra = {}) => ({
  candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }], ...extra,
});
const client = () => createModelClient({ provider: "gemini", apiKey: "test-key" });
const bodyAt = (fetcher: ReturnType<typeof vi.fn>, index = 0) => JSON.parse(fetcher.mock.calls[index]![1].body);
afterEach(() => vi.unstubAllGlobals());

describe("Gemini 原生协议", () => {
  it("发送系统指令与 JSON Schema 工具，并归一化含思考的真实用量", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(reply([{ text: "你好" }], {
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, thoughtsTokenCount: 5, totalTokenCount: 18 },
    })));
    vi.stubGlobal("fetch", fetcher);
    const signal = new AbortController().signal;
    const result = await client().messages.create({ ...request, signal, tools: [
      { name: "clock", description: "时间", input_schema: { type: "object", properties: {}, additionalProperties: false } },
    ] });
    expect(fetcher).toHaveBeenCalledWith("https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent", expect.objectContaining({
      headers: { "x-goog-api-key": "test-key", "Content-Type": "application/json" }, signal,
    }));
    expect(bodyAt(fetcher)).toEqual({
      systemInstruction: { parts: [{ text: "使用中文" }] },
      contents: [{ role: "user", parts: [{ text: "你好" }] }],
      generationConfig: { maxOutputTokens: 512 },
      tools: [{ functionDeclarations: [{ name: "clock", description: "时间", parametersJsonSchema: { type: "object", properties: {}, additionalProperties: false } }] }],
    });
    expect(result).toMatchObject({ content: [{ type: "text", text: "你好" }], tokenUsage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 } });
  });

  it("真实 Loop 续接并行同名工具，原样回传签名和供应商调用 ID", async () => {
    const parts = [
      { text: "内部思考", thought: true, thoughtSignature: "thought-signature" },
      { functionCall: { name: "clock", args: { zone: "a" }, id: "google-1" }, thoughtSignature: "call-signature" },
      { functionCall: { name: "clock", args: { zone: "b" } } },
    ];
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json(reply(parts)))
      .mockResolvedValueOnce(Response.json(reply([{ text: "完成" }])));
    vi.stubGlobal("fetch", fetcher);
    const events: Array<{ kind: string; event: Record<string, unknown> }> = [];
    const result = await runAgentLoop({ client: client(), model: request.model, messages: [...request.messages], stream: false,
      tools: { schemas: () => [], execute: (_name, args) => args }, observer: (kind, event) => { events.push({ kind, event }); },
    });
    expect(result.reply).toBe("完成");
    expect(result.toolCalls).toHaveLength(2);
    expect(new Set(result.toolCalls.map(call => call.toolUseId)).size).toBe(2);
    expect(bodyAt(fetcher, 1).contents[1]).toEqual({ role: "model", parts });
    expect(bodyAt(fetcher, 1).contents[2]).toMatchObject({ role: "user", parts: [
      { functionResponse: { name: "clock", id: "google-1", response: { output: expect.any(String) } } },
      { functionResponse: { name: "clock", response: { output: expect.any(String) } } },
    ] });
    expect(events.filter(event => event.kind === "tool_completed")).toHaveLength(2);
    expect(events.find(event => event.kind === "reply")?.event).not.toHaveProperty("text", "内部思考");
  });

  it("读取 SSE 文本增量、签名与最终用量，不向聊天输出思考", async () => {
    const chunks = [
      { candidates: [{ content: { parts: [{ text: "思考", thought: true }] } }] },
      { candidates: [{ content: { parts: [{ text: "你" }] } }] },
      { candidates: [{ content: { parts: [{ text: "好", thoughtSignature: "signed" }] }, finishReason: "STOP" }] },
      { usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 2, totalTokenCount: 4 } },
    ];
    const fetcher = vi.fn().mockResolvedValue(new Response(chunks.map(value => `data: ${JSON.stringify(value)}\n\n`).join("")));
    vi.stubGlobal("fetch", fetcher);
    const stream = await client().messages.stream!(request);
    expect(() => stream.getFinalMessage()).toThrow("尚未读取完成");
    const text = [];
    for await (const chunk of stream.textStream) text.push(chunk);
    expect(text).toEqual(["你", "好"]);
    expect(fetcher.mock.calls[0]![0]).toContain(":streamGenerateContent?alt=sse");
    expect(await stream.getFinalMessage()).toMatchObject({ tokenUsage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 } });
  });

  it("允许自定义版本地址和 models/ 前缀，缺少 usage 时不估算消耗", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(reply([{ text: "好" }])));
    vi.stubGlobal("fetch", fetcher);
    const result = await createModelClient({ provider: "gemini", apiKey: "key", baseUrl: "https://proxy.example/v1/" })
      .messages.create({ ...request, model: "models/gemini-test", system: "" });
    expect(fetcher.mock.calls[0]![0]).toBe("https://proxy.example/v1/models/gemini-test:generateContent");
    expect(bodyAt(fetcher)).not.toHaveProperty("tools");
    expect(bodyAt(fetcher)).not.toHaveProperty("systemInstruction");
    expect(result.tokenUsage).toBeNull();
  });

  it.each([
    [{ promptFeedback: { blockReason: "SAFETY" } }, "SAFETY"],
    [{ candidates: [{ finishReason: "SAFETY" }] }, "SAFETY"],
    [{ candidates: [{ finishReason: "MALFORMED_FUNCTION_CALL" }] }, "MALFORMED_FUNCTION_CALL"],
    [{}, "缺少"],
    [reply([{ functionCall: { args: {} } }]), "函数名"],
  ])("响应无效或被拦截时报告错误而非空回复 %j", async (response, message) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(response)));
    await expect(client().messages.create(request)).rejects.toThrow(message);
  });

  it("传播 HTTP 错误与取消信号", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: { message: "权限不足" } }, { status: 403 })));
    await expect(client().messages.create(request)).rejects.toThrow("权限不足");
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal("fetch", vi.fn((_url, init) => { init.signal.throwIfAborted(); }));
    await expect(client().messages.create({ ...request, signal: controller.signal })).rejects.toThrow();
  });
});

it("Gemini 流式工具和空文本签名在下一轮保持原始顺序，错误工具结果带 error", async () => {
  const parts = [
    { text: "检查" }, { text: "", thoughtSignature: "empty-text-signature" },
    { functionCall: { name: "clock", args: {}, id: "stream-call" }, thoughtSignature: "function-signature" },
  ];
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(parts.map((part, index) => `data: ${JSON.stringify({
    candidates: [{ content: { parts: [part] }, ...(index === 2 ? { finishReason: "STOP" } : {}) }],
  })}\n\n`).join(""))).mockResolvedValueOnce(Response.json(reply([{ text: "失败已处理" }])));
  vi.stubGlobal("fetch", fetcher);
  const model = client();
  const stream = await model.messages.stream!(request);
  for await (const _ of stream.textStream) { /* 消费完整协议流。 */ }
  const response = await stream.getFinalMessage();
  await model.messages.create({ ...request, messages: [...request.messages,
    { role: "assistant", content: response.content },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "stream-call", is_error: true, content: "工具失败" }] },
  ] });
  expect(bodyAt(fetcher, 1).contents[1].parts).toEqual(parts);
  expect(bodyAt(fetcher, 1).contents[2].parts).toEqual([
    { functionResponse: { name: "clock", id: "stream-call", response: { error: "工具失败" } } },
  ]);
});

it.each([
  [{ candidates: [{ content: { parts: [{ text: "未完成" }] } }] }, "完成前中断"],
  [{ error: { message: "流失败" } }, "流失败"],
  [{ candidates: [{ finishReason: "SAFETY" }] }, "SAFETY"],
])("Gemini 流不把错误或截断伪装为完成 %j", async (event, message) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(`data: ${JSON.stringify(event)}\n\n`)));
  const stream = await client().messages.stream!(request);
  await expect((async () => { for await (const _ of stream.textStream) { /* 消费到错误。 */ } })()).rejects.toThrow(message);
});

it.each([
  [{ promptTokenCount: 10, candidatesTokenCount: 3 }, { inputTokens: 10, outputTokens: 3, totalTokens: 13 }],
  [{ promptTokenCount: 10 }, null],
  [{ promptTokenCount: 10, candidatesTokenCount: 3, thoughtsTokenCount: -1 }, null],
])("Gemini 用量只根据供应商完整有效数据归一化 %j", async (usageMetadata, expected) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(reply([{ text: "完成" }], { usageMetadata }))));
  expect((await client().messages.create(request)).tokenUsage).toEqual(expected);
});

it("Gemini 会话切换到 Anthropic 时移除供应商续接元数据与思考块", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json(reply([
    { thought: true, text: "内部思考", thoughtSignature: "signature" }, { text: "回复" },
  ]))).mockResolvedValueOnce(Response.json({ content: [{ type: "text", text: "继续" }] }));
  vi.stubGlobal("fetch", fetcher);
  const response = await client().messages.create(request);
  await createModelClient({ provider: "anthropic", apiKey: "key" }).messages.create({
    ...request, messages: [{ role: "assistant", content: response.content }, { role: "user", content: "继续" }],
  });
  expect(bodyAt(fetcher, 1).messages[0]).toEqual({ role: "assistant", content: [{ type: "text", text: "回复" }] });
});

it("Gemini SSE 在 UTF-8 和 CRLF 任意字节切分后仍完整读取", async () => {
  const data = new TextEncoder().encode(`data: ${JSON.stringify(reply([{ text: "你好" }]))}\r\n\r\n`);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream({
    start(controller) { for (const byte of data) controller.enqueue(Uint8Array.of(byte)); controller.close(); },
  }))));
  const stream = await client().messages.stream!(request);
  const texts: unknown[] = [];
  for await (const text of stream.textStream) texts.push(text);
  expect(texts).toEqual(["你好"]);
});

it("Gemini 可转换既有标准工具历史并拒绝无法匹配的工具结果", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json(reply([{ text: "完成" }])));
  vi.stubGlobal("fetch", fetcher);
  await client().messages.create({ ...request, messages: [
    { role: "assistant", content: [{ type: "tool_use", id: "old", name: "clock" }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "old", content: { time: 1 } }] },
  ] });
  expect(bodyAt(fetcher).contents).toEqual([
    { role: "model", parts: [{ functionCall: { name: "clock", args: {} } }] },
    { role: "user", parts: [{ functionResponse: { name: "clock", response: { output: { time: 1 } } } }] },
  ]);
  await expect(client().messages.create({ ...request, messages: [
    { role: "user", content: [{ type: "tool_result", tool_use_id: "missing" }] },
  ] })).rejects.toThrow("缺少对应的工具调用");
});

it("Gemini 拒绝非文本响应，不静默忽略服务返回的图片", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(reply([{ inlineData: { mimeType: "image/png", data: "test" } }]))));
  await expect(client().messages.create(request)).rejects.toThrow("当前仅支持文本和工具调用");
});

it("Gemini 报告非 JSON HTTP 错误和缺少响应流", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response("upstream unavailable", { status: 502 }))
    .mockResolvedValueOnce(new Response(null));
  vi.stubGlobal("fetch", fetcher);
  await expect(client().messages.create(request)).rejects.toThrow("HTTP 502：upstream unavailable");
  const stream = await client().messages.stream!(request);
  await expect((async () => { for await (const _ of stream.textStream) { /* 消费到错误。 */ } })()).rejects.toThrow("缺少可读取的流");
});
