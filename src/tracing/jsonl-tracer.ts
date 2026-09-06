import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export interface TraceRecord {
  version: 1 | 2;
  eventId?: string;
  type: string;
  timestamp: string;
  sequence?: number;
  runId: string;
  sessionId?: string;
  iteration?: number;
  modelCallId?: string;
  toolCallId?: string;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface TraceFile {
  path: string;
  records: TraceRecord[];
}

export interface JsonlTracerOptions {
  onWarning?: (message: string) => void;
  now?: () => Date;
}

/** 按本地日期目录与 Session JSONL 文件持久化 classic loop 和 memory 事件。 */
export class JsonlTracer {
  private readonly traceDirectory: string;
  private readonly onWarning: (message: string) => void;
  private readonly now: () => Date;
  private writeQueue: Promise<void> = Promise.resolve();
  private checkedPaths = new Set<string>();
  private recoveryPaths = new Map<string, string>();
  private sequences = new Map<string, number>();

  constructor(home: string, options: JsonlTracerOptions = {}) {
    this.traceDirectory = join(home, "traces");
    this.onWarning = options.onWarning ?? (() => {});
    this.now = options.now ?? (() => new Date());
  }

  /** 排队写入一个事件；失败只告警，不影响 Agent Loop。 */
  async record(type: string, event: Record<string, unknown>): Promise<void> {
    const record = this.makeRecord(type, event);
    this.writeQueue = this.writeQueue.then(() => this.write(record)).catch((error) => {
      this.onWarning(`运行记录写入失败：${error instanceof Error ? error.message : String(error)}`);
    });
    await this.writeQueue;
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private makeRecord(type: string, event: Record<string, unknown>): TraceRecord {
    const runId = typeof event.runId === "string" ? event.runId : crypto.randomUUID();
    const sequence = (this.sequences.get(runId) ?? 0) + 1;
    this.sequences.set(runId, sequence);
    const sanitized = traceEventFields(type, event);
    return {
      version: 2,
      eventId: crypto.randomUUID(),
      type,
      timestamp: localIsoMilliseconds(this.now()),
      sequence,
      runId,
      ...sanitized,
    };
  }

  private readonly consolidationDates = new Map<string, string>();

  private async write(record: TraceRecord): Promise<void> {
    const consolidation = record.type.startsWith("consolidation_") || this.consolidationDates.has(record.runId);
    if (consolidation && !this.consolidationDates.has(record.runId)) {
      this.consolidationDates.set(record.runId, typeof record.payload?.createdAt === "string" ? record.payload.createdAt : record.timestamp);
    }
    const dateDirectory = join(this.traceDirectory, (this.consolidationDates.get(record.runId) ?? (typeof record.taskCreatedAt === "string" ? record.taskCreatedAt : record.timestamp)).slice(0, 10));
    await mkdir(dateDirectory, { recursive: true });
    const sessionFile = traceFileName(consolidation ? `consolidation-${record.runId}` : typeof record.taskId === "string" ? `${record.taskKind}-${record.taskId}` : record.sessionId);
    const primaryPath = await numberedTracePath(dateDirectory, sessionFile);
    let path = this.recoveryPaths.get(primaryPath) ?? primaryPath;
    if (!this.checkedPaths.has(path)) {
      try {
        await validateJsonl(path);
      } catch {
        path = `${primaryPath.slice(0, -6)}.recovered-${record.timestamp.slice(11, 19).replaceAll(":", "")}.jsonl`;
        this.recoveryPaths.set(primaryPath, path);
        this.onWarning("当前 Session 的运行记录文件无法安全追加，已切换到恢复文件。");
      }
      this.checkedPaths.add(path);
    }
    await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
  }
}

/** 读取 trace 目录中的事件；损坏行作为错误记录返回，不猜测修复。 */
export async function readTraceRecords(home: string, limit = 1_000): Promise<TraceRecord[]> {
  const files = await readTraceFiles(home, limit);
  return files.flatMap((file) => file.records).sort(compareTraceRecords);
}

/** 按日期和带序号的 JSONL 文件读取运行记录。 */
export async function readTraceFiles(home: string, limit = 1_000): Promise<TraceFile[]> {
  const directory = join(home, "traces");
  let dateDirectories: string[];
  try {
    dateDirectories = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const traceFiles: TraceFile[] = [];
  for (const dateDirectory of dateDirectories) {
    const files = (await readdir(join(directory, dateDirectory)))
      .filter((file) => file.endsWith(".jsonl"))
      .sort(compareTraceFileNames);
    for (const file of files) {
      const text = await readFile(join(directory, dateDirectory, file), "utf8");
      const records: TraceRecord[] = [];
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          records.push(JSON.parse(line) as TraceRecord);
        } catch {
          records.push({
            version: 2,
            eventId: crypto.randomUUID(),
            type: "trace_read_error",
            timestamp: `${dateDirectory}T23:59:59`,
            sequence: 0,
            runId: crypto.randomUUID(),
            payload: { file: `${dateDirectory}/${file}` },
          });
        }
      }
      records.sort(compareTraceRecords);
      traceFiles.push({ path: `${dateDirectory}/${file}`, records });
    }
  }
  const boundedLimit = Math.max(1, Math.min(10_000, Math.trunc(limit)));
  const selected = new Set(traceFiles.flatMap((file, fileIndex) => file.records.map((record, recordIndex) => ({
    key: `${fileIndex}:${recordIndex}`,
    record,
  }))).sort((left, right) => compareTraceRecords(left.record, right.record)).slice(-boundedLimit).map((item) => item.key));
  return traceFiles.flatMap((file, fileIndex) => {
    const records = file.records.filter((_, recordIndex) => selected.has(`${fileIndex}:${recordIndex}`));
    return records.length > 0 ? [{ ...file, records }] : [];
  });
}

async function numberedTracePath(directory: string, sessionFile: string): Promise<string> {
  const files = await readdir(directory);
  const existing = files
    .filter((file) => /^\d+-/.test(file) && file.endsWith(`-${sessionFile}`))
    .sort(compareTraceFileNames)[0];
  if (existing) return join(directory, existing);
  const next = files.reduce((maximum, file) => {
    const match = /^(\d+)-/.exec(file);
    return match ? Math.max(maximum, Number(match[1])) : maximum;
  }, 0) + 1;
  return join(directory, `${String(next).padStart(3, "0")}-${sessionFile}`);
}

function compareTraceFileNames(left: string, right: string): number {
  const leftSequence = Number(/^(\d+)-/.exec(left)?.[1] ?? Number.MAX_SAFE_INTEGER);
  const rightSequence = Number(/^(\d+)-/.exec(right)?.[1] ?? Number.MAX_SAFE_INTEGER);
  return leftSequence - rightSequence || left.localeCompare(right);
}

function compareTraceRecords(left: TraceRecord, right: TraceRecord): number {
  return left.timestamp.localeCompare(right.timestamp) || (left.sequence ?? 0) - (right.sequence ?? 0);
}

function traceFileName(sessionId: string | undefined): string {
  if (!sessionId) return "system.jsonl";
  if (/^[A-Za-z0-9_-]{1,200}$/.test(sessionId)) return `${sessionId}.jsonl`;
  const safe = encodeURIComponent(sessionId).replace(/%/g, "_").slice(0, 200);
  return `session-${safe || "unknown"}.jsonl`;
}

async function validateJsonl(path: string): Promise<void> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  for (const line of text.split(/\r?\n/)) if (line.trim()) JSON.parse(line);
}

function traceEventFields(type: string, event: Record<string, unknown>): Record<string, unknown> {
  const payloadFields: Record<string, string[]> = {
    run_started: ["userInput", "provider", "model", "settings", "runtime"],
    context_assembled: ["messageCount", "historyMessageCount", "hasSystemPrompt", "semanticMemoryIds", "sessionRecallSessionIds", "sessionRecallRanges", "sessionRecallEntryCount", "sessionRecallEstimatedTokens", "sessionRecallTruncated"],
    gate_start: [],
    gate_end: ["intent", "semantic", "sessionRecallMode", "reason", "fallback", "errorType"],
    retrieval_start: ["mode", "intent"],
    model_request: ["provider", "model", "request"],
    model_response: ["provider", "model", "response", "stopReason", "tokenUsage", "ms"],
    model_failed: ["provider", "model", "errorType", "errorMessage", "ms"],
    stream_fallback: ["error"],
    tool_started: ["tool"],
    tool_completed: ["tool", "arguments", "result", "summary", "isError", "ms", "outputLength"],
    tool_failed: ["tool", "arguments", "result", "summary", "isError", "ms", "outputLength"],
    run_completed: ["reply", "iterations", "stopReason", "toolCallCount", "ms"],
    run_failed: ["errorType", "errorMessage", "iterations", "ms"],
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
    consolidation_model_completed: ["batchIndex", "totalBatches", "model", "durationMs"],
    consolidation_model_failed: ["batchIndex", "totalBatches", "model", "errorType"],
    memory_task_started: ["attempt"],
    memory_task_completed: ["attempt"],
    memory_task_retry: ["attempt", "errorType", "nextAttemptAt"],
    memory_task_failed: ["attempt", "errorType", "nextAttemptAt"],
    memory_change_replayed: ["candidateId", "action", "targetId"],
    memory_candidate_extracted: ["candidateId", "intent", "evidenceMessageIds"],
    memory_search_completed: ["candidateId", "attempt", "revision", "candidateIds"],
    memory_model_started: ["candidateId", "batchIndex", "totalBatches", "model"],
    memory_model_completed: ["candidateId", "batchIndex", "totalBatches", "model", "durationMs"],
    memory_model_failed: ["candidateId", "batchIndex", "totalBatches", "model", "errorType"],
    memory_decision_completed: ["candidateId", "attempt", "action", "reasonCode", "targetId", "sourceIds", "evidenceMessageIds"],
    memory_validation_completed: ["candidateId", "attempt", "action"],
    memory_conflict: ["candidateId", "attempt"],
    memory_change_completed: ["candidateId", "action", "reasonCode", "targetId", "deletedIds", "durationMs"],
    memory_change_failed: ["candidateId", "errorType", "durationMs"],
    embedding_started: ["purpose", "batchIndex", "itemCount", "estimatedTokens", "rebuildId"],
    embedding_completed: ["purpose", "batchIndex", "itemCount", "estimatedTokens", "tokenUsage", "dimensions", "ms", "rebuildId"],
    embedding_failed: ["purpose", "batchIndex", "itemCount", "estimatedTokens", "errorType", "errorMessage", "ms", "rebuildId"],
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
  };
  const output: Record<string, unknown> = {};
  for (const key of ["taskId", "taskKind", "taskCreatedAt", "sourceRunId"]) if (typeof event[key] === "string") output[key] = event[key];
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

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
