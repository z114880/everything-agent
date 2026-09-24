export interface TraceRecord {
  version: 3;
  eventId?: string;
  type: string;
  timestamp: string;
  sequence?: number;
  /** 采用真实回合、任务或操作标识的轨迹归组键。 */
  traceId: string;
  /** 仅聊天回合携带；后台任务用 sourceTurnId 关联来源。 */
  turnId?: string;
  taskId?: string;
  sourceTurnId?: string;
  sessionId?: string;
  iteration?: number;
  modelCallId?: string;
  toolCallId?: string;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}

/** 为同一记录器生成带顺序和凭证脱敏的运行时事件；无需读取或写入文件。 */
export function createTraceEventFactory(now: () => Date = () => new Date()) {
  const sequences = new Map<string, number>();
  return (type: string, event: Record<string, unknown>): TraceRecord => {
    // traceId 是观测归组键，优先采用后台任务标识，避免派生任务混入聊天回合。
    const traceId = typeof event.taskId === "string" ? event.taskId
      : typeof event.turnId === "string" ? event.turnId
      : typeof event.rebuildId === "string" ? event.rebuildId
      : typeof event.operationId === "string" ? event.operationId : crypto.randomUUID();
    const sequence = (sequences.get(traceId) ?? 0) + 1;
    sequences.set(traceId, sequence);
    return { version: 3, eventId: crypto.randomUUID(), type, timestamp: localIsoMilliseconds(now()), sequence, traceId, ...traceEventFields(type, event) };
  };
}

function traceEventFields(type: string, event: Record<string, unknown>): Record<string, unknown> {
  const payloadFields: Record<string, string[]> = {
    turn_started: ["userInput", "provider", "model", "settings", "runtime"],
    context_assembled: ["messageCount", "historyMessageCount", "hasSystemPrompt", "semanticMemoryIds", "sessionRecallSessionIds", "sessionRecallRanges", "sessionRecallEntryCount", "sessionRecallEstimatedTokens", "sessionRecallTruncated"],
    compact_started: ["beforeTokens", "targetTokens", "availableInputTokens"],
    compact_completed: ["beforeTokens", "afterTokens", "targetTokens", "availableInputTokens", "targetReached", "ms"],
    compact_failed: ["beforeTokens", "targetTokens", "availableInputTokens", "ms", "errorType", "reasonCode"],
    compact_model_started: ["model", "batchIndex"],
    compact_model_completed: ["model", "batchIndex", "ms", "tokenUsage"],
    compact_model_failed: ["model", "batchIndex", "ms", "errorType"],
    skills_discovered: ["skills", "count"],
    skill_loaded: ["skill", "contentHash", "instructionLength"],
    gate_start: ["model"],
    gate_end: ["intent", "semantic", "sessionRecallMode", "reason", "fallback", "errorType", "model", "tokenUsage"],
    retrieval_start: ["mode", "intent"],
    model_request: ["provider", "model", "request"],
    model_response: ["provider", "model", "response", "stopReason", "tokenUsage", "ms"],
    model_failed: ["provider", "model", "errorType", "errorMessage", "ms"],
    stream_fallback: ["error"],
    tool_started: ["tool"],
    tool_completed: ["tool", "arguments", "result", "summary", "isError", "ms", "outputLength"],
    tool_failed: ["tool", "arguments", "result", "summary", "isError", "ms", "outputLength"],
    turn_completed: [
      "provider", "model", "reply", "iterations", "stopReason", "toolCallCount", "failedToolCallCount",
      "derivedTaskIds", "ms", "retrievalMs", "modelMs", "toolMs",
      "contextWindow", "maxTokens", "contextSafetyTokens", "availableInputTokens",
      "peakEstimatedInputTokens", "peakInputTokens",
    ],
    turn_failed: [
      "provider", "model", "errorType", "errorMessage", "iterations", "cancelled", "timedOut",
      "derivedTaskIds", "ms", "retrievalMs",
    ],
    consolidation_started: ["trigger", "attempt", "createdAt"],
    consolidation_snapshot: ["batchIndex", "totalBatches", "factCount"],
    consolidation_batch_started: ["batchIndex", "totalBatches", "factCount"],
    consolidation_reviewed: ["batchIndex", "totalBatches", "decisionCount", "unresolvedConflicts"],
    consolidation_change: ["batchIndex", "totalBatches", "action", "reasonCode", "targetId", "deletedIds"],
    consolidation_batch_completed: ["batchIndex", "totalBatches", "completedBatches"],
    consolidation_completed: ["attempt", "completedBatches"],
    consolidation_retry: ["attempt", "errorType", "nextAttemptAt"],
    consolidation_failed: ["attempt", "errorType", "nextAttemptAt"],
    consolidation_batch_failed: ["batchIndex", "totalBatches", "errorType"],
    consolidation_model_started: ["batchIndex", "totalBatches", "model"],
    consolidation_model_completed: ["batchIndex", "totalBatches", "model", "durationMs", "tokenUsage"],
    consolidation_model_failed: ["batchIndex", "totalBatches", "model", "errorType"],
    memory_task_started: ["attempt"],
    memory_task_completed: ["attempt"],
    memory_task_retry: ["attempt", "errorType", "nextAttemptAt"],
    memory_task_failed: ["attempt", "errorType", "nextAttemptAt"],
    memory_change_replayed: ["candidateId", "action", "targetId"],
    memory_candidate_extracted: ["candidateId", "intent", "evidenceMessageIds"],
    memory_search_completed: ["candidateId", "attempt", "revision", "candidateIds"],
    memory_model_started: ["candidateId", "batchIndex", "totalBatches", "model"],
    memory_model_completed: ["candidateId", "batchIndex", "totalBatches", "model", "durationMs", "tokenUsage"],
    memory_model_failed: ["candidateId", "batchIndex", "totalBatches", "model", "errorType"],
    memory_decision_completed: ["candidateId", "attempt", "action", "reasonCode", "targetId", "sourceIds", "evidenceMessageIds"],
    memory_validation_completed: ["candidateId", "attempt", "action"],
    memory_conflict: ["candidateId", "attempt"],
    memory_change_completed: ["candidateId", "action", "reasonCode", "targetId", "deletedIds", "durationMs"],
    memory_change_failed: ["candidateId", "errorType", "durationMs"],
    embedding_started: ["provider", "model", "purpose", "batchIndex", "itemCount", "estimatedTokens", "rebuildId"],
    embedding_completed: ["provider", "model", "purpose", "batchIndex", "itemCount", "estimatedTokens", "tokenUsage", "dimensions", "ms", "rebuildId"],
    embedding_failed: ["provider", "model", "purpose", "batchIndex", "itemCount", "estimatedTokens", "errorType", "errorMessage", "ms", "rebuildId"],
    embedding_rebuild_started: ["generationId", "rebuildId"],
    embedding_rebuild_progress: ["generationId", "rebuildId", "processedChunks"],
    embedding_generation_activated: ["generationId", "rebuildId", "chunkCount"],
    embedding_rebuild_completed: ["generationId", "rebuildId", "chunkCount"],
    embedding_rebuild_failed: ["generationId", "rebuildId", "errorType"],
    embedding_rebuild_cancelled: ["generationId", "rebuildId"],
    dense_retrieval_completed: ["corpus", "candidateCount"],
    lexical_retrieval_completed: ["corpus", "candidateCount"],
    rrf_completed: ["corpus", "candidateCount"],
    mmr_completed: ["corpus", "selected", "excludedAsDuplicate"],
    retrieval_completed: ["semantic", "sessionRecall", "semanticCount", "sessionCount", "mode"],
    user_feedback: ["rating", "correction"],
    eval_judgment: ["evaluator", "evaluatorVersion", "scores", "reason"],
    trace_read_error: ["file"],
    langfuse_export_failed: ["message"],
  };
  const output: Record<string, unknown> = {};
  for (const key of ["turnId", "rebuildId", "compactionId", "taskId", "taskKind", "taskCreatedAt", "sourceTurnId", "operationId", "parentOperationId"]) if (typeof event[key] === "string") output[key] = event[key];
  if (typeof event.sessionId === "string") output.sessionId = event.sessionId;
  if (typeof event.iteration === "number") output.iteration = event.iteration;
  if (typeof event.modelCallId === "string") output.modelCallId = event.modelCallId;
  if (typeof event.toolCallId === "string") output.toolCallId = event.toolCallId;
  const payload = Object.fromEntries((payloadFields[type] ?? []).flatMap((key) => event[key] === undefined
    ? []
    : [[key, sanitizeTraceValue(event[key], key)]]));
  if (type.startsWith("consolidation_") && typeof event.attempt === "number") payload.attempt = event.attempt;
  if (Object.keys(payload).length > 0) output.payload = payload;
  return output;
}

function sanitizeTraceValue(value: unknown, key: string): unknown {
  if (isCredentialField(key)) return "[凭证已移除]";
  if (typeof value === "string") return removeCredentialText(value);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeTraceValue(item, ""));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .map(([itemKey, itemValue]) => [itemKey, sanitizeTraceValue(itemValue, itemKey)]));
}

function isCredentialField(key: string): boolean {
  const normalized = key.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
  if (/(?:^|_)token_(?:count|limit|budget|usage)$/.test(normalized)) return false;
  return /(?:^|_)(?:api_key|authorization|cookie|token|access_token|refresh_token|auth_token|secret|client_secret|password)(?:$|_)/.test(normalized);
}

function removeCredentialText(value: string): string {
  return value
    .replace(/\b(?:sk|key|token)-[A-Za-z0-9_-]{8,}\b/gi, "[凭证已移除]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [凭证已移除]");
}

function localIsoMilliseconds(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const milliseconds = String(date.getMilliseconds()).padStart(3, "0");
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const absolute = Math.abs(offset);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${milliseconds}${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}
