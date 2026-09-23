import { randomUUID } from "node:crypto";
import type { AgentMessage, AgentModelClient, ModelContentBlock, ModelRequest, ModelResponse, ModelStream, TokenUsage } from "../agent-loop/agent-loop.ts";
import type { ModelClientConfig } from "./model-client.ts";
import { iterateSse, postJson, postStream, providerError } from "./transport.ts";

interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name?: string; args?: unknown; id?: string };
  functionResponse?: { name: string; id?: string; response: Record<string, unknown> };
}
interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: Record<string, unknown>;
  error?: unknown;
}

/** Gemini 原生 GenerateContent 适配；签名保留在内容块中供多轮工具续接。 */
export function createGeminiClient(config: ModelClientConfig): AgentModelClient {
  const base = (config.baseUrl || "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
  const headers = { "x-goog-api-key": config.apiKey, "Content-Type": "application/json" };
  const endpoint = (model: string, stream: boolean) => {
    const id = model.replace(/^models\//, "");
    if (!id || !/^[\w.-]+$/.test(id)) throw new TypeError("Gemini Model 必须是有效的模型 ID");
    return `${base}/models/${id}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
  };
  return { messages: {
    async create(request) {
      const response = await postJson(endpoint(request.model, false), headers, body(request), request.signal) as GeminiResponse;
      checkResponse(response);
      return finish(response.candidates?.[0]?.content?.parts ?? [], response.candidates?.[0]?.finishReason, response.usageMetadata);
    },
    async stream(request) {
      const response = await postStream(endpoint(request.model, true), headers, body(request), request.signal);
      return geminiStream(response);
    },
  } };
}

function body(request: ModelRequest): Record<string, unknown> {
  const tools = Array.isArray(request.tools) ? request.tools as Array<Record<string, unknown>> : [];
  return {
    contents: toContents(request.messages),
    ...(request.system ? { systemInstruction: { parts: [{ text: request.system }] } } : {}),
    generationConfig: { maxOutputTokens: request.max_tokens },
    ...(tools.length ? { tools: [{ functionDeclarations: tools.map(tool => ({
      name: tool.name, description: tool.description, parametersJsonSchema: tool.input_schema,
    })) }] } : {}),
  };
}

function toContents(messages: AgentMessage[]): Array<{ role: string; parts: GeminiPart[] }> {
  const calls = new Map<string, { name: string; id?: string }>();
  const contents: Array<{ role: string; parts: GeminiPart[] }> = [];
  for (const message of messages) {
    const blocks: ModelContentBlock[] = typeof message.content === "string"
      ? [{ type: "text", text: message.content }] : message.content;
    if (!Array.isArray(blocks)) throw new TypeError("Gemini 消息内容必须是文本或内容块数组");
    const parts: GeminiPart[] = [];
    for (const block of blocks) {
      const original = block.providerMetadata?.gemini as GeminiPart | undefined;
      if (block.type === "tool_use") {
        if (!block.id || !block.name) throw new TypeError("Gemini 工具调用缺少 ID 或函数名");
        calls.set(block.id, { name: block.name, ...(original?.functionCall?.id ? { id: original.functionCall.id } : {}) });
      }
      // 不重建供应商返回的 Part，避免工具续接时丢失签名、调用 ID 或 Part 边界。
      if (message.role === "assistant" && original) {
        parts.push(original);
      } else if (block.type === "text") {
        parts.push({ text: block.text ?? "" });
      } else if (block.type === "tool_use") {
        parts.push({ functionCall: { name: block.name!, args: block.input ?? {} } });
      } else if (block.type === "tool_result") {
        const call = calls.get(String(block.tool_use_id));
        if (!call) throw new TypeError("Gemini 工具结果缺少对应的工具调用");
        parts.push({ functionResponse: { ...call, response: { [block.is_error ? "error" : "output"]: block.content ?? "" } } });
      } else {
        throw new TypeError(`Gemini 不支持的消息内容块：${block.type}`);
      }
    }
    if (parts.length) contents.push({ role: message.role === "assistant" ? "model" : "user", parts });
  }
  return contents;
}

function checkResponse(response: GeminiResponse): void {
  if (response.error) throw providerError(response.error);
  const blocked = response.promptFeedback?.blockReason;
  if (blocked && blocked !== "BLOCK_REASON_UNSPECIFIED") throw new Error(`Gemini 请求被拦截：${blocked}`);
  const reason = response.candidates?.[0]?.finishReason;
  if (reason && !["STOP", "MAX_TOKENS", "FINISH_REASON_UNSPECIFIED"].includes(reason)) {
    throw new Error(`Gemini 生成失败：${reason}`);
  }
}

function finish(parts: GeminiPart[], reason: string | undefined, usage: Record<string, unknown> | undefined): ModelResponse {
  const content = parts.map((part): ModelContentBlock => {
    const providerMetadata = { gemini: part };
    if (part.functionCall) {
      if (!part.functionCall.name) throw new TypeError("Gemini 工具调用缺少函数名");
      return { type: "tool_use", id: part.functionCall.id || `gemini-${randomUUID()}`, name: part.functionCall.name,
        input: part.functionCall.args ?? {}, providerMetadata };
    }
    if (typeof part.text === "string" && !part.thought) return { type: "text", text: part.text, providerMetadata };
    if (part.thought || part.thoughtSignature) return { type: "provider_content", providerMetadata };
    throw new TypeError("Gemini 返回了不支持的内容类型，当前仅支持文本和工具调用");
  });
  if (!content.some(block => block.type === "tool_use" || (block.type === "text" && block.text))) {
    throw new TypeError(`Gemini 响应缺少文本或工具调用${reason ? `（${reason}）` : ""}`);
  }
  return { content, stop_reason: reason ?? null, tokenUsage: normalizeUsage(usage) };
}

function normalizeUsage(usage: Record<string, unknown> | undefined): TokenUsage | null {
  if (!usage) return null;
  const input = usage.promptTokenCount;
  const output = usage.candidatesTokenCount;
  const thoughts = usage.thoughtsTokenCount ?? 0;
  const valid = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
  if (!valid(input) || !valid(output) || !valid(thoughts)) return null;
  // Gemini 将思考量单列，统一输出用量需包含它；缓存 token 已包含在 promptTokenCount 中。
  const outputTokens = output + thoughts;
  return { inputTokens: input, outputTokens, totalTokens: valid(usage.totalTokenCount) ? usage.totalTokenCount : input + outputTokens };
}

function geminiStream(response: Response): ModelStream {
  let finalMessage: ModelResponse | undefined;
  async function* textStream(): AsyncGenerator<string> {
    const parts: GeminiPart[] = [];
    let reason: string | undefined;
    let usage: Record<string, unknown> | undefined;
    for await (const raw of iterateSse(response)) {
      const event: GeminiResponse = raw;
      checkResponse(event);
      const candidate = event.candidates?.[0];
      if (candidate?.finishReason) reason = candidate.finishReason;
      if (event.usageMetadata) usage = { ...usage, ...event.usageMetadata };
      for (const part of candidate?.content?.parts ?? []) {
        parts.push(part);
        if (part.text && !part.thought) yield part.text;
      }
    }
    if (!reason) throw new Error("Gemini 流在完成前中断");
    finalMessage = finish(parts, reason, usage);
  }
  return {
    textStream: textStream(),
    getFinalMessage() {
      if (!finalMessage) throw new Error("Gemini 流尚未读取完成");
      return finalMessage;
    },
  };
}
