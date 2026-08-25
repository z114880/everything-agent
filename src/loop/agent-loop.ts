const DEFAULT_MAX_ITERATIONS = 10;
const DEFAULT_MAX_TOKENS = 2048;
const ITERATION_LIMIT_REPLY = "已达到本轮最大迭代次数，请把任务拆小后重试。";

type EventData = Record<string, unknown>;

/** Agent Loop 使用的最小消息形状。 */
export interface AgentMessage {
  role: string;
  content: any;
  [key: string]: unknown;
}

/** 模型响应中的内容块。 */
export interface ModelContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  [key: string]: unknown;
}

/** 模型客户端返回的最小响应形状。 */
export interface ModelResponse {
  content: ModelContentBlock[];
  stop_reason?: string | null;
  stopReason?: string | null;
  usage?: {
    input_tokens?: number;
    inputTokens?: number;
    output_tokens?: number;
    outputTokens?: number;
  };
  [key: string]: unknown;
}

/** 发送给模型客户端的请求。 */
export interface ModelRequest {
  model: string;
  system: string;
  messages: AgentMessage[];
  tools: unknown;
  max_tokens: number;
  signal: AbortSignal | undefined;
}

/** 可选的流式模型响应。 */
export interface ModelStream {
  textStream: AsyncIterable<unknown>;
  getFinalMessage(): Promise<ModelResponse> | ModelResponse;
}

/** Agent Loop 依赖的最小模型客户端接口。 */
export interface AgentModelClient {
  messages: {
    create(request: ModelRequest): Promise<ModelResponse> | ModelResponse;
    stream?: (request: ModelRequest) => Promise<ModelStream> | ModelStream;
  };
}

/** 工具执行期间获得的取消、截止时间和调用身份。 */
export interface ToolExecutionContext {
  signal: AbortSignal | undefined;
  deadline: number | null;
  iteration: number;
  toolUseId: string;
}

/** 工具可向 Loop 发送事件的函数。 */
export type AgentObserver = (
  kind: string,
  event: EventData,
) => void | Promise<void>;

/** 注入 Agent Loop 的工具注册表接口。 */
export interface ToolRegistry {
  schemas(): unknown;
  execute(
    name: string,
    args: unknown,
    notify: AgentObserver,
    context: ToolExecutionContext,
  ): unknown | Promise<unknown>;
}

/** 一次已执行的工具调用，仅在结果中保留完整参数与输出。 */
export interface ToolCallRecord {
  tool: string;
  args: unknown;
  output: string;
  toolUseId: string;
  iteration: number;
  isError: boolean;
}

/** Agent Loop 的运行参数。 */
export interface AgentLoopOptions {
  client: AgentModelClient;
  model: string;
  system?: string;
  messages: AgentMessage[];
  tools: ToolRegistry;
  maxIterations?: number;
  maxTokens?: number;
  observer?: AgentObserver;
  stream?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  serializeToolEvent?: (call: ToolCallRecord) => EventData;
}

/** Agent Loop 的结束原因与执行结果。 */
export interface AgentLoopResult {
  reply: string;
  toolCalls: ToolCallRecord[];
  iterations: number;
  stopReason: "completed" | "max_iterations";
}

interface GuardOptions {
  signal: AbortSignal | undefined;
  deadline: number | null;
  timeoutMs: number;
}

/** Agent Loop 被取消时抛出的错误。 */
export class AgentLoopAbortError extends Error {
  constructor(message = "Agent Loop 已取消") {
    super(message);
    this.name = "AgentLoopAbortError";
  }
}

/** Agent Loop 超过整轮超时时间时抛出的错误。 */
export class AgentLoopTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Agent Loop 在 ${timeoutMs}ms 内未完成`);
    this.name = "AgentLoopTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${name} 必须是正整数`);
  }
}

function textFrom(content: ModelContentBlock[]): string {
  return content
    .filter((block) => block?.type === "text")
    .map((block) => block.text ?? "")
    .join("");
}

function usageFrom(response: ModelResponse): { in: number; out: number } {
  const usage = response.usage ?? {};
  return {
    in: usage.input_tokens ?? usage.inputTokens ?? 0,
    out: usage.output_tokens ?? usage.outputTokens ?? 0,
  };
}

function abortError(signal?: AbortSignal): AgentLoopAbortError {
  const message = signal?.reason instanceof Error
    ? signal.reason.message
    : "Agent Loop 已取消";
  return new AgentLoopAbortError(message);
}

/**
 * 运行一次有截止时间的异步操作。超时只负责终止本轮等待；模型与工具实现应读取
 * request.signal，才能同时取消底层网络或 I/O。
 */
async function runGuarded<T>(
  operation: () => T | Promise<T>,
  { signal, deadline, timeoutMs }: GuardOptions,
): Promise<T> {
  if (signal?.aborted) throw abortError(signal);

  const remaining = deadline === null ? null : deadline - Date.now();
  if (remaining !== null && remaining <= 0) {
    throw new AgentLoopTimeoutError(timeoutMs);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener = () => {};
  const guards: Promise<never>[] = [];

  if (remaining !== null) {
    guards.push(new Promise((_, reject) => {
      timer = setTimeout(() => reject(new AgentLoopTimeoutError(timeoutMs)), remaining);
    }));
  }

  if (signal) {
    guards.push(new Promise((_, reject) => {
      const onAbort = () => reject(abortError(signal));
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    }));
  }

  try {
    return await Promise.race([Promise.resolve().then(operation), ...guards]);
  } finally {
    if (timer) clearTimeout(timer);
    removeAbortListener();
  }
}

function isControlFlowError(error: unknown): boolean {
  return error instanceof AgentLoopAbortError
    || error instanceof AgentLoopTimeoutError
    || (error instanceof Error && error.name === "AbortError");
}

async function createResponse(
  client: AgentModelClient,
  request: ModelRequest,
  guard: GuardOptions,
): Promise<ModelResponse> {
  return runGuarded(() => client.messages.create(request), guard);
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
    throw new TypeError("流式客户端必须返回 textStream 和 getFinalMessage() ");
  }

  const iterator = stream.textStream[Symbol.asyncIterator]();
  while (true) {
    const item = await runGuarded(() => iterator.next(), guard);
    if (item.done) break;
    await notify("text", { delta: String(item.value) });
  }
  return runGuarded(() => stream.getFinalMessage(), guard);
}

function privateToolEvent(call: ToolCallRecord): EventData {
  return {
    tool: call.tool,
    toolUseId: call.toolUseId,
    iteration: call.iteration,
    // 默认不把工具参数和结果复制到 observer；调用方可通过 serializeToolEvent
    // 明确提供脱敏后的摘要。
    args: "[已隐藏]",
    output: "[已隐藏]",
    isError: call.isError,
  };
}

/**
 * 执行一个 `observe → reason → act → repeat` Agent 回合。
 *
 * `client` 采用 Anthropic Messages 风格的最小接口：
 * `client.messages.create(request)`；启用 stream 时还可实现
 * `client.messages.stream(request) -> { textStream, getFinalMessage }`。
 * `tools` 只需实现 `schemas()` 和 `execute(name, args, notify, context)`，因此 Loop
 * 不直接依赖具体模型 SDK、工具实现、数据库或 UI。
 *
 * 传入的 messages 会原地追加 assistant 工具请求和 user 工具结果，作为本轮
 * 完整工作记忆。工具输出应为字符串；其他返回值会被安全地转为字符串。
 */
export async function runAgentLoop({
  client,
  model,
  system = "",
  messages,
  tools,
  maxIterations = DEFAULT_MAX_ITERATIONS,
  maxTokens = DEFAULT_MAX_TOKENS,
  observer = () => {},
  stream = false,
  signal,
  timeoutMs,
  serializeToolEvent = privateToolEvent,
}: AgentLoopOptions): Promise<AgentLoopResult> {
  assertPositiveInteger(maxIterations, "maxIterations");
  assertPositiveInteger(maxTokens, "maxTokens");
  if (timeoutMs !== undefined) assertPositiveInteger(timeoutMs, "timeoutMs");
  if (!client?.messages || typeof client.messages.create !== "function") {
    throw new TypeError("client.messages.create 必须是函数");
  }
  if (!Array.isArray(messages)) throw new TypeError("messages 必须是数组");
  if (!tools || typeof tools.schemas !== "function" || typeof tools.execute !== "function") {
    throw new TypeError("tools 必须实现 schemas() 和 execute()");
  }
  if (typeof observer !== "function") throw new TypeError("observer 必须是函数");
  if (typeof serializeToolEvent !== "function") {
    throw new TypeError("serializeToolEvent 必须是函数");
  }

  const runId = crypto.randomUUID();
  const startedAt = performance.now();
  const deadline = timeoutMs === undefined ? null : Date.now() + timeoutMs;
  const guard: GuardOptions = { signal, deadline, timeoutMs: timeoutMs ?? 0 };
  const toolCalls: ToolCallRecord[] = [];
  const notify: AgentObserver = async (kind, event = {}) => observer(kind, { ...event, runId });
  let iterations = 0;

  await notify("loop_start", { model, maxIterations });

  try {
    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      iterations = iteration;
      const request = {
        model,
        system,
        messages,
        tools: tools.schemas(),
        max_tokens: maxTokens,
        signal,
      };

      let response: ModelResponse | undefined;
      const canStream = stream && typeof client.messages.stream === "function";
      if (canStream) {
        try {
          response = await streamResponse(client, request, notify, guard);
        } catch (error) {
          if (isControlFlowError(error)) throw error;
          await notify("stream_fallback", { iteration, error: String(error) });
        }
      }
      if (!response) response = await createResponse(client, request, guard);
      if (!Array.isArray(response?.content)) {
        throw new TypeError("模型响应的 content 必须是数组");
      }

      await notify("llm", {
        iteration,
        stopReason: response.stop_reason ?? response.stopReason ?? null,
        usage: usageFrom(response),
      });
      messages.push({ role: "assistant", content: response.content });

      const requestedTools = response.content.filter((block) => block?.type === "tool_use");
      if (requestedTools.length === 0) {
        const result: AgentLoopResult = {
          reply: textFrom(response.content),
          toolCalls,
          iterations,
          stopReason: "completed",
        };
        await notify("loop_end", {
          iterations,
          stopReason: result.stopReason,
          toolCallCount: toolCalls.length,
          ms: Math.round(performance.now() - startedAt),
        });
        return result;
      }

      const toolResults: EventData[] = [];
      for (const call of requestedTools) {
        const toolName = call.name!;
        const toolUseId = call.id!;
        const args = call.input ?? {};
        let rawOutput: unknown;
        let isError = false;
        try {
          rawOutput = await runGuarded(
            () => tools.execute(toolName, args, notify, {
              signal,
              deadline,
              iteration,
              toolUseId,
            }),
            guard,
          );
        } catch (error) {
          if (isControlFlowError(error)) throw error;
          isError = true;
          rawOutput = `工具 ${toolName} 执行失败：${error instanceof Error ? error.message : String(error)}`;
        }
        const serialized = typeof rawOutput === "string" ? rawOutput : JSON.stringify(rawOutput);
        const output = serialized === undefined ? String(rawOutput) : serialized;

        const record: ToolCallRecord = {
          tool: toolName,
          args,
          output,
          toolUseId,
          iteration,
          isError,
        };
        toolCalls.push(record);
        await notify("tool", serializeToolEvent(record));
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUseId,
          content: output,
          ...(isError ? { is_error: true } : {}),
        });
      }
      messages.push({ role: "user", content: toolResults });
    }

    const result: AgentLoopResult = {
      reply: ITERATION_LIMIT_REPLY,
      toolCalls,
      iterations,
      stopReason: "max_iterations",
    };
    await notify("loop_end", {
      iterations,
      stopReason: result.stopReason,
      toolCallCount: toolCalls.length,
      ms: Math.round(performance.now() - startedAt),
    });
    return result;
  } catch (error) {
    await notify("loop_error", {
      iterations,
      error: String(error),
      ms: Math.round(performance.now() - startedAt),
    });
    throw error;
  }
}

// 名称兼容参考实现，也方便调用方按“运行循环”的语义使用。
export const runLoop = runAgentLoop;
