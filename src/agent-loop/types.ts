export type EventData = Record<string, unknown>;

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
