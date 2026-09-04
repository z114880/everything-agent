import type { AgentMessage, AgentModelClient, AgentObserver } from "../agent-loop/agent-loop.ts";

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
  scrollStep: number;
  messageLimit: number;
  characterLimit: number;
}
export interface MemoryModelOptions {
  client: AgentModelClient;
  model: string;
  currentSessionId: string;
  recall: SessionRecallSettings;
  observer?: AgentObserver;
}
export interface SessionSummary {
  id: string; title: string; messageCount: number; completedRunCount: number; incompleteRunCount: number;
  createdAt: string; updatedAt: string; pendingMessages: number;
}
export interface ChatLogEntry {
  id: number; sessionId: string; runId: string; role: string; kind: string; content: unknown; createdAt: string;
  runComplete?: boolean; contentTruncated?: boolean; contentFragment?: boolean; contentOffset?: number;
}
export interface SemanticMemory {
  id: number; subject: string; content: string; source: string; createdAt: string; updatedAt: string; score?: number;
}
export interface RecallRange { fromMessageId: number; toMessageId: number }
export interface SessionRecallResult {
  session: SessionSummary; rank: number; retrievalSignals: { bm25?: number };
  match: null | { messageId: number; bm25: number; totalMatches: number };
  entries: ChatLogEntry[]; totalMessageCount: number; returnedMessageCount: number; indexedMessageCount: number;
  returnedRanges: RecallRange[]; isComplete: boolean; truncated: boolean; expandLimitReached: boolean; nextCursor: string | null;
}
export interface SessionSearchResult {
  retrievalMode: "search" | "recent"; query?: string; requestedLimit: number; returnedSessionCount: number;
  droppedSessionCount: number; truncated: boolean; sessions: SessionRecallResult[];
}
export interface SessionReadResult {
  mode: "expand" | "sequential"; session: SessionSummary; entries: ChatLogEntry[]; totalMessageCount: number;
  returnedMessageCount: number; returnedRanges: RecallRange[]; isComplete: boolean; truncated: boolean;
  expandLimitReached: boolean; nextCursor: string | null;
}
export interface ConsolidationRun {
  id: number; runId: string; sessionId: string; trigger: string; status: string; throughMessageId: number;
  factsCreated: number; factsUpdated: number; factsSkipped: number; errorType: string | null;
  startedAt: string; completedAt: string | null;
}
export interface MemoryOverview {
  semanticCount: number; indexedSessionCount: number; indexedMessageCount: number; sessionCount: number;
  pendingSessionCount: number; databasePath: string; latestConsolidation: ConsolidationRun | null;
}
export interface RetrievalResult {
  context: string; retrieved: boolean; semantic: SemanticMemory[]; sessionRecall: SessionSearchResult | null;
}
export interface StoredRun { sessionId: string; runId: string; prompt: string; messages: AgentMessage[] }
