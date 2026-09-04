import type {
  AgentMessage,
  AgentModelClient,
  ModelContentBlock,
  ModelRequest,
  ModelResponse,
  ModelStream,
  TokenUsage,
} from "../agent-loop/agent-loop.ts";

export type AgentProvider = "anthropic" | "openai-compatible";

/** 创建真实模型客户端所需的服务端配置。 */
export interface ModelClientConfig {
  provider: AgentProvider;
  apiKey: string;
  baseUrl?: string;
}

/** 根据协议类型创建与 Agent Loop 兼容的模型客户端。 */
export function createModelClient(config: ModelClientConfig): AgentModelClient {
  assertConfig(config);
  return config.provider === "anthropic"
    ? createAnthropicClient(config)
    : createOpenAIClient(config);
}

function createAnthropicClient(config: ModelClientConfig): AgentModelClient {
  const endpoint = `${normalizedBaseUrl(config.baseUrl || "https://api.anthropic.com")}/v1/messages`;
  return {
    messages: {
      async create(request) {
        const response = await postJson(endpoint, anthropicHeaders(config.apiKey), {
          ...anthropicBody(request),
          stream: false,
        }, request.signal) as ModelResponse & { usage?: Record<string, unknown> };
        const { usage, ...message } = response;
        return { ...message, tokenUsage: normalizeAnthropicUsage(usage) };
      },
      async stream(request) {
        const response = await postStream(endpoint, anthropicHeaders(config.apiKey), {
          ...anthropicBody(request),
          stream: true,
        }, request.signal);
        return anthropicStream(response);
      },
    },
  };
}

function createOpenAIClient(config: ModelClientConfig): AgentModelClient {
  const endpoint = `${normalizedBaseUrl(config.baseUrl || "https://api.openai.com/v1")}/chat/completions`;
  const headers = {
    Authorization: `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
  };
  return {
    messages: {
      async create(request) {
        const response = await postJson(endpoint, headers, {
          ...openAIBody(request),
          stream: false,
        }, request.signal) as OpenAIResponse;
        return fromOpenAIResponse(response);
      },
      async stream(request) {
        const response = await postStream(endpoint, headers, {
          ...openAIBody(request),
          stream: true,
          stream_options: { include_usage: true },
        }, request.signal);
        return openAIStream(response);
      },
    },
  };
}

function anthropicBody(request: ModelRequest): Record<string, unknown> {
  return {
    model: request.model,
    system: request.system,
    messages: request.messages,
    tools: request.tools,
    max_tokens: request.max_tokens,
  };
}

function openAIBody(request: ModelRequest): Record<string, unknown> {
  return {
    model: request.model,
    messages: toOpenAIMessages(request.system, request.messages),
    tools: toOpenAITools(request.tools),
    max_tokens: request.max_tokens,
  };
}

function toOpenAIMessages(system: string, messages: AgentMessage[]): unknown[] {
  const output: unknown[] = system ? [{ role: "system", content: system }] : [];
  for (const message of messages) {
    if (typeof message.content === "string") {
      output.push({ role: message.role, content: message.content });
      continue;
    }
    if (!Array.isArray(message.content)) {
      output.push({ role: message.role, content: String(message.content ?? "") });
      continue;
    }

    if (message.role === "assistant") {
      const text = message.content
        .filter((block: ModelContentBlock) => block.type === "text")
        .map((block: ModelContentBlock) => block.text ?? "")
        .join("");
      const toolCalls = message.content
        .filter((block: ModelContentBlock) => block.type === "tool_use")
        .map((block: ModelContentBlock) => ({
          id: block.id,
          type: "function",
          function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
        }));
      output.push({
        role: "assistant",
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    for (const block of message.content as ModelContentBlock[]) {
      if (block.type === "tool_result") {
        output.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content: typeof block.content === "string" ? block.content : JSON.stringify(block.content),
        });
      } else if (block.type === "text") {
        output.push({ role: message.role, content: block.text ?? "" });
      }
    }
  }
  return output;
}

function toOpenAITools(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.map((tool) => {
    const item = tool as Record<string, unknown>;
    return {
      type: "function",
      function: {
        name: item.name,
        description: item.description,
        parameters: item.input_schema,
      },
    };
  });
}

interface OpenAIToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAIResponse {
  choices?: Array<{
    finish_reason?: string | null;
    message?: { content?: string | null; tool_calls?: OpenAIToolCall[] };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

function fromOpenAIResponse(response: OpenAIResponse): ModelResponse {
  const choice = response.choices?.[0];
  if (!choice?.message) throw new TypeError("OpenAI Compatible 响应缺少 choices[0].message");
  const content: ModelContentBlock[] = [];
  if (choice.message.content) content.push({ type: "text", text: choice.message.content });
  for (const call of choice.message.tool_calls ?? []) {
    if (!call.id || !call.function?.name) {
      throw new TypeError("OpenAI Compatible 工具调用缺少 id 或函数名");
    }
    content.push({
      type: "tool_use",
      id: call.id,
      name: call.function?.name,
      input: parseToolArguments(call.function?.arguments),
    });
  }
  return {
    content,
    stop_reason: choice.finish_reason ?? null,
    tokenUsage: normalizeOpenAIUsage(response.usage),
  };
}

function anthropicStream(response: Response): ModelStream {
  let finalMessage: ModelResponse | null = null;
  async function* textStream(): AsyncGenerator<string> {
    const blocks = new Map<number, ModelContentBlock & { inputJson?: string }>();
    let stopReason: string | null = null;
    let usage: Record<string, unknown> | undefined;
    for await (const event of iterateSse(response)) {
      if (event.type === "error") throw providerError(event.error);
      if (event.type === "message_start") {
        usage = (event.message as Record<string, unknown> | undefined)?.usage as Record<string, unknown> | undefined;
      }
      if (event.type === "content_block_start") {
        const index = Number(event.index);
        const block = event.content_block as ModelContentBlock | undefined;
        if (block) blocks.set(index, { ...block, inputJson: "" });
      }
      if (event.type === "content_block_delta") {
        const index = Number(event.index);
        const block = blocks.get(index);
        const delta = event.delta as Record<string, unknown> | undefined;
        if (!block || !delta) continue;
        if (delta.type === "text_delta") {
          const text = String(delta.text ?? "");
          block.text = (block.text ?? "") + text;
          if (text) yield text;
        }
        if (delta.type === "input_json_delta") {
          block.inputJson = (block.inputJson ?? "") + String(delta.partial_json ?? "");
        }
      }
      if (event.type === "message_delta") {
        const delta = event.delta as Record<string, unknown> | undefined;
        stopReason = String(delta?.stop_reason ?? stopReason ?? "") || null;
        usage = { ...(usage ?? {}), ...((event.usage as Record<string, unknown> | undefined) ?? {}) };
      }
    }
    const content = [...blocks.entries()].sort(([left], [right]) => left - right).map(([, block]) => {
      if (block.type === "tool_use") {
        const { inputJson, ...rest } = block;
        return { ...rest, input: parseToolArguments(inputJson) };
      }
      const { inputJson: _inputJson, ...rest } = block;
      return rest;
    });
    finalMessage = {
      content,
      stop_reason: stopReason,
      tokenUsage: normalizeAnthropicUsage(usage),
    };
  }
  return {
    textStream: textStream(),
    getFinalMessage() {
      if (!finalMessage) throw new Error("Anthropic 流尚未读取完成");
      return finalMessage;
    },
  };
}

function openAIStream(response: Response): ModelStream {
  let finalMessage: ModelResponse | null = null;
  async function* textStream(): AsyncGenerator<string> {
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
    let replyText = "";
    let stopReason: string | null = null;
    let usage: Record<string, unknown> | undefined;
    for await (const event of iterateSse(response)) {
      if (event.error) throw providerError(event.error);
      const eventUsage = event.usage as Record<string, unknown> | undefined;
      if (eventUsage) usage = eventUsage;
      const choice = (event.choices as Array<Record<string, unknown>> | undefined)?.[0];
      if (!choice) continue;
      stopReason = String(choice.finish_reason ?? stopReason ?? "") || null;
      const delta = choice.delta as Record<string, unknown> | undefined;
      const text = typeof delta?.content === "string" ? delta.content : "";
      if (text) {
        replyText += text;
        yield text;
      }
      for (const rawCall of (delta?.tool_calls as Array<Record<string, unknown>> | undefined) ?? []) {
        const index = Number(rawCall.index ?? 0);
        const current = toolCalls.get(index) ?? { id: "", name: "", arguments: "" };
        const fn = rawCall.function as Record<string, unknown> | undefined;
        current.id += String(rawCall.id ?? "");
        current.name += String(fn?.name ?? "");
        current.arguments += String(fn?.arguments ?? "");
        toolCalls.set(index, current);
      }
    }
    const content: ModelContentBlock[] = replyText ? [{ type: "text", text: replyText }] : [];
    content.push(...[...toolCalls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, call]) => ({
        type: "tool_use",
        id: call.id,
        name: call.name,
        input: parseToolArguments(call.arguments),
      })));
    finalMessage = {
      content,
      stop_reason: stopReason,
      tokenUsage: normalizeOpenAIUsage(usage),
    };
  }
  return {
    textStream: textStream(),
    getFinalMessage() {
      if (!finalMessage) throw new Error("OpenAI Compatible 流尚未读取完成");
      return finalMessage;
    },
  };
}

function normalizeOpenAIUsage(usage: Record<string, unknown> | undefined): TokenUsage | null {
  if (!usage) return null;
  const inputTokens = nonNegativeInteger(usage.prompt_tokens);
  const outputTokens = nonNegativeInteger(usage.completion_tokens);
  if (inputTokens === null || outputTokens === null) return null;
  const reportedTotal = nonNegativeInteger(usage.total_tokens);
  return { inputTokens, outputTokens, totalTokens: reportedTotal ?? inputTokens + outputTokens };
}

function normalizeAnthropicUsage(usage: Record<string, unknown> | undefined): TokenUsage | null {
  if (!usage) return null;
  const ordinaryInput = nonNegativeInteger(usage.input_tokens);
  const outputTokens = nonNegativeInteger(usage.output_tokens);
  if (ordinaryInput === null || outputTokens === null) return null;
  const cacheRead = optionalNonNegativeInteger(usage.cache_read_input_tokens);
  const cacheWrite = optionalNonNegativeInteger(usage.cache_creation_input_tokens);
  if (cacheRead === null || cacheWrite === null) return null;
  const inputTokens = ordinaryInput + cacheRead + cacheWrite;
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function optionalNonNegativeInteger(value: unknown): number | null {
  return value === undefined ? 0 : nonNegativeInteger(value);
}

async function* iterateSse(response: Response): AsyncGenerator<Record<string, any>> {
  if (!response.body) throw new Error("模型响应缺少可读取的流");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done }).replaceAll("\r\n", "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = raw.split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (data && data !== "[DONE]") yield JSON.parse(data) as Record<string, any>;
      boundary = buffer.indexOf("\n\n");
    }
    if (done) break;
  }
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw await responseError(response);
  return response.json();
}

async function postStream(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw await responseError(response);
  return response;
}

async function responseError(response: Response): Promise<Error> {
  const text = await response.text();
  try {
    return providerError(JSON.parse(text));
  } catch {
    return new Error(`模型服务返回 HTTP ${response.status}：${text.slice(0, 300)}`);
  }
}

function providerError(value: unknown): Error {
  if (typeof value === "string") return new Error(value);
  const record = value && typeof value === "object" ? value as Record<string, any> : {};
  const nested = record.error && typeof record.error === "object" ? record.error : record;
  return new Error(String(nested.message ?? nested.error ?? "模型服务请求失败"));
}

function parseToolArguments(value: unknown): unknown {
  if (!value) return {};
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new TypeError("模型返回了无效的工具参数 JSON");
  }
}

function anthropicHeaders(apiKey: string): Record<string, string> {
  return {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "Content-Type": "application/json",
  };
}

function normalizedBaseUrl(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new TypeError("Base URL 只支持 HTTP 或 HTTPS");
  return url.toString().replace(/\/$/, "");
}

function assertConfig(config: ModelClientConfig): void {
  if (!config.apiKey.trim()) throw new Error("模型 API Key 尚未配置");
  if (!["anthropic", "openai-compatible"].includes(config.provider)) {
    throw new TypeError(`不支持的模型提供方：${config.provider}`);
  }
  if (config.baseUrl) normalizedBaseUrl(config.baseUrl);
}
