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
  /** 由模型协议适配器归一化的真实 token 消耗；供应商未返回完整数据时为 null。 */
  tokenUsage?: TokenUsage | null;
  [key: string]: unknown;
}

/** 一次远程调用由供应商报告的真实 token 消耗。 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
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

/** 在模型请求前提供近似预算的供应商无关接口。 */
export interface TokenEstimator {
  estimateRequest(request: ModelRequest): number;
  estimateText(text: string): number;
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
  /** 工具返回的原始结构化值，供 trace 和 eval 使用。 */
  result: unknown;
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
  /** 模型总上下文窗口；输入、输出和固定安全余量之和不得超过它。 */
  modelContextWindow?: number;
  /** 配置 Context Window 时必须注入的 token 估算器。 */
  tokenEstimator?: TokenEstimator;
  observer?: AgentObserver;
  stream?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  serializeToolEvent?: (call: ToolCallRecord) => EventData;
  runId?: string;
}

/** Agent Loop 的结束原因与执行结果。 */
export interface AgentLoopResult {
  reply: string;
  toolCalls: ToolCallRecord[];
  iterations: number;
  stopReason: "completed" | "max_iterations";
}
