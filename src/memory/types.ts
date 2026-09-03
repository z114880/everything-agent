import type { AgentMessage, AgentModelClient, AgentObserver } from "../agent-loop/agent-loop.js";

export interface MemoryModelOptions {
  client: AgentModelClient;
  model: string;
  observer?: AgentObserver;
}
export interface SessionSummary {
  id: string;
  title: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  pendingMessages: number;
}

export interface ChatLogEntry {
  id: number;
  sessionId: string;
  runId: string;
  role: string;
  kind: string;
  content: unknown;
  createdAt: string;
}

export interface SemanticMemory {
  id: number;
  subject: string;
  content: string;
  source: string;
  createdAt: string;
  updatedAt: string;
  score?: number;
}

export interface EpisodicMemory {
  id: number;
  sessionId: string | null;
  summary: string;
  happenedAt: string;
  source: string;
  createdAt: string;
  updatedAt: string;
  score?: number;
}

export interface ConsolidationRun {
  id: number;
  runId: string;
  sessionId: string;
  trigger: string;
  status: string;
  throughMessageId: number;
  factsCreated: number;
  factsUpdated: number;
  factsSkipped: number;
  episodeChanged: boolean;
  errorType: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface MemoryOverview {
  semanticCount: number;
  episodicCount: number;
  sessionCount: number;
  pendingSessionCount: number;
  databasePath: string;
  latestConsolidation: ConsolidationRun | null;
}

export interface RetrievalResult {
  context: string;
  retrieved: boolean;
  semantic: SemanticMemory[];
  episodic: EpisodicMemory[];
}

export interface StoredRun {
  sessionId: string;
  runId: string;
  prompt: string;
  messages: AgentMessage[];
}
