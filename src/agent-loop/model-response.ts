import {
  isControlFlowError,
  runGuarded,
  type GuardOptions,
} from "./execution-guard.ts";
import type {
  AgentModelClient,
  AgentObserver,
  ModelContentBlock,
  ModelRequest,
  ModelResponse,
  TokenUsage,
} from "./types.ts";

/** 从模型内容块提取最终文本回复。 */
export function textFrom(content: ModelContentBlock[]): string {
  return content
    .filter((block) => block?.type === "text")
    .map((block) => block.text ?? "")
    .join("");
}

/** 返回协议适配器提供的真实 token 消耗，不使用估算值补齐。 */
export function tokenUsageFrom(response: ModelResponse): TokenUsage | null {
  const usage = response.tokenUsage;
  if (!usage || !isNonNegativeInteger(usage.inputTokens)
    || !isNonNegativeInteger(usage.outputTokens)
    || !isNonNegativeInteger(usage.totalTokens)) return null;
  return usage;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

async function streamResponse(
  client: AgentModelClient,
  request: ModelRequest,
  notify: AgentObserver,
  guard: GuardOptions,
): Promise<ModelResponse> {
  const streamMethod = client.messages.stream;
  if (!streamMethod) throw new TypeError("客户端未实现流式响应");
  const stream = await runGuarded(() => streamMethod(request), guard);
  if (!stream?.textStream || typeof stream.getFinalMessage !== "function") {
    throw new TypeError("流式客户端必须返回 textStream 和 getFinalMessage()");
  }

  const iterator = stream.textStream[Symbol.asyncIterator]();
  while (true) {
    const item = await runGuarded(() => iterator.next(), guard);
    if (item.done) break;
    await notify("text", { delta: String(item.value) });
  }
  return runGuarded(() => stream.getFinalMessage(), guard);
}

/** 请求一轮模型响应；流式失败时保留事件并降级为普通请求。 */
export async function requestModelResponse(
  client: AgentModelClient,
  request: ModelRequest,
  notify: AgentObserver,
  guard: GuardOptions,
  stream: boolean,
  iteration: number,
): Promise<ModelResponse> {
  let response: ModelResponse | undefined;
  if (stream && typeof client.messages.stream === "function") {
    try {
      response = await streamResponse(client, request, notify, guard);
    } catch (error) {
      if (isControlFlowError(error)) throw error;
      await notify("stream_fallback", { iteration, error: String(error) });
    }
  }

  response ??= await runGuarded(() => client.messages.create(request), guard);
  if (!Array.isArray(response?.content)) {
    throw new TypeError("模型响应的 content 必须是数组");
  }
  return response;
}
