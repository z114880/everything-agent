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
  /** 供应商续接所需的不透明数据，由协议适配器读取；Loop 原样保留。 */
  providerMetadata?: Record<string, unknown>;
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

/** 已验证的压缩检查点；消息包含摘要、当前请求和最近完整交互。 */
export interface ContextCompaction {
  compactionId: string;
  iteration: number;
  beforeTokens: number;
  afterTokens: number;
  targetTokens: number;
  availableInputTokens: number;
  targetReached: boolean;
  ms: number;
  messages: AgentMessage[];
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
  /** 同步原子保存压缩检查点；抛错时本轮不切换上下文，也不重试压缩。 */
  onCompacted?: (compaction: ContextCompaction) => void;
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
  /** 本轮全部模型调用的耗时之和；调用顺序执行，因此不超过整轮耗时。 */
  modelMs: number;
  /** 本轮全部工具调用的耗时之和。 */
  toolMs: number;
  /** 返回错误结果的工具调用数量，用于区分「调用很多」和「调用都失败」。 */
  failedToolCallCount: number;
  /** 各次迭代请求估算输入 token 的最大值；与 Context Window 硬限制同口径。未注入估算器时为 null。 */
  peakEstimatedInputTokens: number | null;
  /** 供应商返回的真实输入 token 峰值；没有任何一次调用报告 usage 时为 null。 */
  peakInputTokens: number | null;
}
