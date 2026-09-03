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
} from "./types.ts";

/** 从模型内容块提取最终文本回复。 */
export function textFrom(content: ModelContentBlock[]): string {
  return content
    .filter((block) => block?.type === "text")
    .map((block) => block.text ?? "")
    .join("");
}

/** 兼容模型客户端的两种 token 字段命名。 */
export function usageFrom(response: ModelResponse): { in: number; out: number } {
  const usage = response.usage ?? {};
  return {
    in: usage.input_tokens ?? usage.inputTokens ?? 0,
    out: usage.output_tokens ?? usage.outputTokens ?? 0,
  };
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
