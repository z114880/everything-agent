import type { AgentMessage, AgentModelClient, AgentObserver, TokenEstimator } from "../agent-loop/agent-loop.ts";
import type { EmbeddingPort, EmbeddingProfile, RetrievalMode } from "./retrieve/index.ts";

export const SEMANTIC_MEMORY_CATEGORIES = [
  "user_attribute", "preference", "ongoing_project", "constraint", "commitment",
] as const;
export type SemanticMemoryCategory = (typeof SEMANTIC_MEMORY_CATEGORIES)[number];

/** Gate 对当前请求所需记忆种类的单一判定。 */
export type RetrievalIntent =
  | "none"
  | "past_episode"
  | "fact_with_evidence";

export interface SessionRecallSettings {
  searchWindow: number;
  /** session_search 的单条正文上限；session_read 取全文时不受它约束。 */
  entryTokenLimit: number;
  /** 单次 session_search 的总 token 上限，由 modelContextWindow 派生。 */
  tokenLimit: number;
  tokenEstimator: Pick<TokenEstimator, "estimateText">;
}
export interface MemoryModelOptions {
  client: AgentModelClient;
  model: string;
  currentSessionId: string;
  recall: SessionRecallSettings;
  observer?: AgentObserver;
  runId?: string;
}

/** 注入 MemoryRuntime 的 Dense 检索依赖；未提供时仅允许 lexical-only。 */
export interface MemoryRetrievalConfiguration {
  mode: RetrievalMode;
  embedding?: {
    profile: EmbeddingProfile;
    client: EmbeddingPort;
  };
  observer?: AgentObserver;
  /** 仅供影子索引构建入口使用；普通查询和写入不得绕过 active profile 校验。 */
  allowIncompleteIndex?: boolean;
}
export interface SessionSummary {
  id: string; title: string; messageCount: number; completedRunCount: number; incompleteRunCount: number;
  createdAt: string; updatedAt: string;
}
export interface ChatLogEntry {
  compactions?: Omit<import("../agent-loop/agent-loop.ts").ContextCompaction, "messages">[];
  id: number; sessionId: string; runId: string; role: string; kind: string; content: unknown; createdAt: string;
  runComplete?: boolean; contentTruncated?: boolean; contentFragment?: boolean; contentOffset?: number;
  /** 正文被截断时给出原文总长与「继续读这一条」的 cursor。 */
  contentLength?: number; contentCursor?: string;
}
export interface SemanticMemory {
  id: number; subject: string; content: string; source: string; createdAt: string; updatedAt: string; score?: number; sources?: MemorySource[];
}
export interface RecallRange { fromMessageId: number; toMessageId: number }
export interface SessionRecallResult {
  session: SessionSummary; rank: number; retrievalSignals: { bm25?: number; dense?: number; fused?: number; mmr?: number };
  match: null | { messageId: number; bm25?: number; dense?: number; totalMatches: number };
  entries: ChatLogEntry[]; totalMessageCount: number; returnedMessageCount: number; indexedMessageCount: number;
  returnedRanges: RecallRange[]; isComplete: boolean; truncated: boolean; nextCursor: string | null;
}
export interface SessionSearchResult {
  retrievalMode: "search" | "recent"; query?: string; requestedLimit: number; returnedSessionCount: number;
  droppedSessionCount: number;
  /** 丢弃 Session 的原因；候选本来就不足时为 null。 */
  droppedReason: "token_budget" | null;
  /** 返回内容的估算 token 量，供 trace 解释预算去向。 */
  estimatedTokens: number;
  truncated: boolean; sessions: SessionRecallResult[];
}
export interface SessionReadResult {
  session: SessionSummary; entries: ChatLogEntry[]; totalMessageCount: number;
  returnedMessageCount: number; returnedRanges: RecallRange[]; isComplete: boolean; truncated: boolean;
  nextCursor: string | null;
}
export interface ConsolidationRun {
  id: number; runId: string; trigger: string; status: string; totalBatches: number; completedBatches: number; unresolvedConflicts: number;
  factsCreated: number; factsUpdated: number; factsSkipped: number; factsDeleted: number; factsMerged: number; errorType: string | null;
  startedAt: string; completedAt: string | null;
}
export interface MemoryOverview {
  semanticCount: number; indexedSessionCount: number; indexedMessageCount: number; sessionCount: number;
  databasePath: string; latestConsolidation: ConsolidationRun | null;
}
export interface RetrievalResult {
  context: string; retrieved: boolean; semantic: SemanticMemory[]; sessionRecall: SessionSearchResult | null;
}
export interface StoredRun { sessionId: string; runId: string; prompt: string; messages: AgentMessage[] }

/** 主模型只提交事实或忘记意图，不能直接选择数据库操作。 */
export interface MemoryCandidate {
  intent: "remember" | "forget";
  subject: string;
  attribute: string;
  content: string;
  evidenceMessageIds: number[];
}
/** 事实证据仅保存位置与时间，不复制私人正文。 */
export interface MemorySource {
  sessionId: string;
  messageId: number;
  createdAt: string;
}
export type MemoryAction = "create" | "update" | "delete" | "merge" | "noop";
export type MemoryReasonCode = "new_fact" | "correction" | "explicit_forget" | "redundant" | "duplicate" | "not_durable" | "uncertain" | "no_change" | "unresolved_conflict" | "superseded";
export interface MemoryDecision {
  action: MemoryAction;
  reason: string;
  reasonCode: MemoryReasonCode;
  evidenceMessageIds: number[];
  targetId?: number;
  sourceIds?: number[];
  subject?: string;
  content?: string;
  category?: SemanticMemoryCategory;
  stable?: boolean;
  futureUseful?: boolean;
}
export interface MemoryManagementResult {
  action: MemoryAction;
  reason: string;
  reasonCode: MemoryReasonCode;
  targetId?: number;
  deletedIds: number[];
}
export interface MemoryManagementOptions {
  /** 持久任务的稳定操作标识，用于恢复时查询已提交结果。 */
  candidateId?: string;
  modelContextWindow?: number;
  tokenEstimator?: TokenEstimator;
  sourceRunId?: string;
  client: AgentModelClient;
  model: string;
  currentSessionId: string;
  runId?: string;
  observer?: AgentObserver;
  signal?: AbortSignal;
  source?: "agent" | "consolidation";
}
