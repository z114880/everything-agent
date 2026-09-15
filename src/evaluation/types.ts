import type { AgentProvider } from "../model/model-client.ts";
import type { TraceFile } from "../tracing/jsonl-tracer.ts";

export interface EvaluationModel {
  provider: AgentProvider;
  model: string;
  baseUrl: string;
  /** 仅保存环境变量名称，凭证由执行进程读取，不写入快照。 */
  apiKeyEnv: string;
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
}
export interface EvaluationVariant {
  name: string;
  sourceRoot: string;
  systemPrompt: string;
  agent: EvaluationModel;
  small: EvaluationModel;
  maxIterations: number;
  maxTokens: number;
  modelContextWindow: number;
  skills: { name: string; content: string }[];
  retrieval: {
    mode: "lexical_only" | "dense_only" | "hybrid";
    embedding: EvaluationModel | null;
    minimumSimilarity: number;
  };
}
export type EvaluationAssertion =
  | { kind: "reply_contains" | "reply_equals" | "memory_contains" | "memory_absent"; value: string }
  | { kind: "tool_called" | "tool_forbidden"; tool: string; arguments?: Record<string, unknown> }
  | { kind: "file_equals"; path: string; value: string };
export interface EvaluationCase {
  id: string;
  name: string;
  critical: boolean;
  turns: string[];
  history: { prompt: string; reply: string }[];
  memory: { subject: string; content: string; source: string }[];
  files: Record<string, string>;
  /** 外部工具只匹配固定参数，不命中即失败，禁止退回真实网络或终端。 */
  tools: { name: "get_current_time" | "search_web" | "run_terminal"; arguments: Record<string, unknown>; result: unknown; files?: Record<string, string>; approval?: boolean }[];
  assertions: EvaluationAssertion[];
  expectedOutput: string;
  criteria: string;
}
export interface EvaluationDataset { name: string; version: string; cases: EvaluationCase[] }
export interface EvaluationPlan {
  name: string;
  dataset: EvaluationDataset;
  baseline: EvaluationVariant;
  candidate: EvaluationVariant;
  repetitions: number;
  timeoutMs: number;
  judge: EvaluationModel | null;
  gate: { maxSuccessRateDrop: number; minimumPassRate: number; minimumRepetitions: number; maxAgentUsd: number | null; maxJudgeUsd: number | null; judgeThreshold: number };
}
export interface EvaluationEvidence {
  complete: boolean;
  replies: string[];
  memory: { subject: string; content: string }[];
  files: Record<string, string>;
  traces: TraceFile[];
  toolCalls: { tool: string; arguments: unknown; isError: boolean }[];
  runIds: string[];
  derivedTaskIds: string[];
  responseMs: number;
  totalMs: number;
  agentUsd: number | null;
  modelCalls: number;
  usage: { purpose: string; model: string; inputTokens: number | null; outputTokens: number | null }[];
}
export interface EvaluationScore { name: string; status: "passed" | "failed" | "error"; score: number | null; reason: string }
export interface EvaluationExecution {
  id: string;
  caseId: string;
  variant: "baseline" | "candidate";
  repetition: number;
  status: "completed" | "failed" | "cancelled" | "timed_out";
  error: string | null;
  evidence: EvaluationEvidence | null;
  scores: EvaluationScore[];
  judgeUsd: number | null;
}
export interface EvaluationComparison {
  caseId: string;
  baselineRate: number;
  candidateRate: number;
  change: "improved" | "regressed" | "unchanged";
}
export interface EvaluationReport {
  decision: "passed" | "failed" | "insufficient";
  reasons: string[];
  comparisons: EvaluationComparison[];
  baselineRate: number;
  candidateRate: number;
  agentUsd: number | null;
  judgeUsd: number | null;
}
export interface EvaluationExperiment {
  id: string;
  createdAt: string;
  status: "queued" | "running" | "completed" | "cancelled" | "failed";
  plan: EvaluationPlan;
  fingerprint: string;
  codeHashes: { baseline: string; candidate: string };
  scorerVersion: string;
  executions: EvaluationExecution[];
  report: EvaluationReport | null;
  reviews: { caseId: string; conclusion: string; createdAt: string }[];
  error: string | null;
}
export interface EvaluationEvent { sequence: number; type: string; experimentId: string; timestamp: string; executionId?: string }
