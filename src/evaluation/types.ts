import type { AgentProvider } from "../model/model-client.ts";
import type { TraceFile } from "../tracing/jsonl-tracer.ts";

/** 当前 Agent 的无凭证配置快照；连接仅由服务端读取。 */
export interface EvaluationModel {
  provider: AgentProvider; model: string; baseUrl: string; apiKeyEnv: string;
}
export interface EvaluationConfiguration {
  systemPrompt: string; agent: EvaluationModel; small: EvaluationModel;
  maxIterations: number; maxTokens: number; modelContextWindow: number;
  skills: { name: string; content: string }[];
  retrieval: { mode: "lexical_only" | "dense_only" | "hybrid"; embedding: EvaluationModel | null; minimumSimilarity: number };
}
export type EvaluationAssertion =
  | { kind: "reply_contains" | "reply_equals" | "memory_contains" | "memory_absent"; value: string }
  | { kind: "tool_called" | "tool_forbidden"; tool: string; arguments?: Record<string, unknown> }
  | { kind: "file_equals"; path: string; value: string };
/** 人工准备的非敏感用例；真实 Terminal 仅在明确开启的用例中提供。 */
export interface EvaluationCase {
  id: string; name: string; turns: string[];
  history: { prompt: string; reply: string }[];
  memory: { subject: string; content: string; source: string }[];
  files: Record<string, string>;
  terminal: boolean;
  tools: { name: "get_current_time" | "search_web" | "run_terminal"; arguments: Record<string, unknown>; result: unknown; files?: Record<string, string>; approval?: boolean }[];
  assertions: EvaluationAssertion[];
  expectedOutput: string; criteria: string;
  judge: { scoreName: string; threshold: number } | null;
}
export interface EvaluationDataset {
  id: string; name: string; description: string; defaultEnabled: boolean; cases: EvaluationCase[];
}
/** 本地目录只保存 Langfuse 不可变数据集版本的引用，不另存可编辑用例。 */
export interface DatasetReference {
  id: string; name: string; description: string; defaultEnabled: boolean;
  remoteName: string; remoteId: string; version: string; count: number; url: string | null;
}
export interface DatasetSnapshot extends DatasetReference { cases: EvaluationCase[]; itemIds: Record<string, string> }
export interface EvaluationEvidence {
  complete: boolean; replies: string[]; memory: { subject: string; content: string }[];
  files: Record<string, string>; traces: TraceFile[];
  toolCalls: { tool: string; arguments: unknown; isError: boolean }[];
  runIds: string[]; derivedTaskIds: string[]; responseMs: number; totalMs: number;
  agentUsd: number | null; modelCalls: number;
  usage: { purpose: string; model: string; inputTokens: number | null; outputTokens: number | null }[];
}
export interface EvaluationScore { name: string; status: "passed" | "failed" | "error"; score: number | null; reason: string }
export interface EvaluationExecution {
  id: string; datasetId: string; caseId: string;
  status: "completed" | "failed" | "cancelled" | "timed_out";
  error: string | null; evidence: EvaluationEvidence | null; scores: EvaluationScore[];
  traceId: string; observationId: string; traceUrl: string | null;
  sync: "pending" | "synced" | "failed";
}
export type EvaluationStage = "dataset" | "agent" | "score" | "gate";
export interface EvaluationReport {
  decision: "passed" | "failed" | "insufficient";
  passed: number; failed: number; pending: number; total: number; reasons: string[];
}
export interface EvaluationRun {
  id: string; createdAt: string; updatedAt: string;
  status: "queued" | "running" | "waiting_scores" | "completed" | "cancelled" | "failed";
  stage: EvaluationStage; datasets: DatasetSnapshot[]; configuration: EvaluationConfiguration;
  codeHash: string; executions: EvaluationExecution[]; report: EvaluationReport; error: string | null;
}
export interface EvaluationEvent {
  runId: string; sequence: number; timestamp: string; type: string; stage: EvaluationStage;
  status: EvaluationRun["status"]; decision: EvaluationReport["decision"]; executionId?: string;
}
export type EvaluationRunSummary = Pick<EvaluationRun, "id" | "createdAt" | "status" | "stage" | "report" | "error">;
export interface EvaluationOverview {
  datasets: DatasetReference[]; runs: EvaluationRunSummary[]; active: EvaluationRunSummary | null;
  langfuse: { configured: boolean; captureContent: boolean; url: string | null };
}
