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

  private async write(record: TraceRecord): Promise<void> {
    const dateDirectory = join(this.traceDirectory, record.timestamp.slice(0, 10));
    await mkdir(dateDirectory, { recursive: true });
    const sessionFile = traceFileName(record.sessionId);
    const primaryPath = join(dateDirectory, sessionFile);
    let path = this.recoveryPaths.get(primaryPath) ?? primaryPath;
    if (!this.checkedPaths.has(path)) {
      try {
        await validateJsonl(path);
      } catch {
        path = join(dateDirectory, `${sessionFile.slice(0, -6)}.recovered-${record.timestamp.slice(11, 19).replaceAll(":", "")}.jsonl`);
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
  const records: TraceRecord[] = [];
  for (const dateDirectory of dateDirectories) {
    const files = (await readdir(join(directory, dateDirectory)))
      .filter((file) => file.endsWith(".jsonl"))
      .sort();
    for (const file of files) {
      const text = await readFile(join(directory, dateDirectory, file), "utf8");
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
    }
  }
  records.sort((left, right) => left.timestamp.localeCompare(right.timestamp)
    || (left.sequence ?? 0) - (right.sequence ?? 0));
  return records.slice(-Math.max(1, Math.min(10_000, Math.trunc(limit))));
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
    context_assembled: ["messageCount", "historyMessageCount", "hasSystemPrompt", "semanticMemoryIds", "sessionRecallSessionIds", "sessionRecallRanges", "sessionRecallEntryCount", "sessionRecallCharacterCount", "sessionRecallTruncated"],
    gate_start: [],
    gate_end: ["intent", "semantic", "sessionRecallMode", "reason", "fallback", "errorType"],
    retrieval: ["semantic", "sessionRecall"],
    model_request: ["provider", "model", "request"],
    model_response: ["provider", "model", "response", "stopReason", "usage", "ms"],
    model_failed: ["provider", "model", "errorType", "errorMessage", "ms"],
    stream_fallback: ["error"],
    tool_started: ["tool"],
    tool_completed: ["tool", "arguments", "result", "summary", "isError", "ms", "outputLength"],
    tool_failed: ["tool", "arguments", "result", "summary", "isError", "ms", "outputLength"],
    run_completed: ["reply", "iterations", "stopReason", "toolCallCount", "ms"],
    run_failed: ["errorType", "errorMessage", "iterations", "ms"],
    consolidation_start: ["trigger", "throughMessageId"],
    consolidation_end: ["throughMessageId", "factsCreated", "factsUpdated", "factsSkipped"],
    consolidation_error: ["throughMessageId", "errorType"],
    user_feedback: ["rating", "correction"],
    eval_judgment: ["evaluator", "evaluatorVersion", "scores", "reason"],
    trace_read_error: ["file"],
  };
  const output: Record<string, unknown> = {};
  if (typeof event.sessionId === "string") output.sessionId = event.sessionId;
  if (typeof event.iteration === "number") output.iteration = event.iteration;
  if (typeof event.modelCallId === "string") output.modelCallId = event.modelCallId;
  if (typeof event.toolCallId === "string") output.toolCallId = event.toolCallId;
  const payload = Object.fromEntries((payloadFields[type] ?? []).flatMap((key) => event[key] === undefined
    ? []
    : [[key, sanitizeTraceValue(event[key], key)]]));
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
