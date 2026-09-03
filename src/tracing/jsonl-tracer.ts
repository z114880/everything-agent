import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface TraceRecord {
  version: 1;
  type: string;
  timestamp: string;
  runId: string;
  sessionId?: string;
  [key: string]: unknown;
}

export interface JsonlTracerOptions {
  onWarning?: (message: string) => void;
  now?: () => Date;
}

/** 以每天一个 JSONL 文件持久化 classic loop 与 memory 事件。 */
export class JsonlTracer {
  private readonly traceDirectory: string;
  private readonly onWarning: (message: string) => void;
  private readonly now: () => Date;
  private writeQueue: Promise<void> = Promise.resolve();
  private checkedPaths = new Set<string>();
  private recoveryPath: string | null = null;

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
    const sanitized = sanitizeTraceEvent(type, event);
    return {
      version: 1,
      type,
      timestamp: localIsoSeconds(this.now()),
      runId,
      ...sanitized,
    };
  }

  private async write(record: TraceRecord): Promise<void> {
    await mkdir(this.traceDirectory, { recursive: true });
    let path = this.recoveryPath ?? join(this.traceDirectory, `${record.timestamp.slice(0, 10)}.jsonl`);
    if (!this.checkedPaths.has(path)) {
      try {
        await validateJsonl(path);
      } catch {
        path = join(this.traceDirectory, `${record.timestamp.slice(0, 10)}.recovered-${record.timestamp.slice(11, 19).replaceAll(":", "")}.jsonl`);
        this.recoveryPath = path;
        this.onWarning("当天运行记录文件无法安全追加，已切换到恢复文件。");
      }
      this.checkedPaths.add(path);
    }
    await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
  }
}

/** 读取 trace 目录中的事件；损坏行作为错误记录返回，不猜测修复。 */
export async function readTraceRecords(home: string, limit = 1_000): Promise<TraceRecord[]> {
  const { readdir } = await import("node:fs/promises");
  const directory = join(home, "traces");
  let files: string[];
  try {
    files = (await readdir(directory)).filter((file) => file.endsWith(".jsonl")).sort();
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const records: TraceRecord[] = [];
  for (const file of files) {
    const text = await readFile(join(directory, file), "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as TraceRecord);
      } catch {
        records.push({
          version: 1,
          type: "trace_read_error",
          timestamp: "",
          runId: crypto.randomUUID(),
          file,
        });
      }
    }
  }
  return records.slice(-Math.max(1, Math.min(10_000, Math.trunc(limit))));
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

function sanitizeTraceEvent(type: string, event: Record<string, unknown>): Record<string, unknown> {
  const allowedByType: Record<string, string[]> = {
    session_created: ["runId", "sessionId"],
    session_selected: ["runId", "sessionId"],
    turn_start: ["runId", "sessionId"],
    working_memory: ["runId", "sessionId", "messageCount", "hasSystemPrompt"],
    gate_start: ["runId", "sessionId"],
    gate_end: ["runId", "sessionId", "decision", "reason", "fallback", "errorType"],
    retrieval: ["runId", "sessionId", "query", "semantic", "episodic"],
    llm_start: ["runId", "sessionId", "iteration", "provider", "model"],
    llm_end: ["runId", "sessionId", "iteration", "provider", "model", "stopReason", "usage", "ms"],
    tool_start: ["runId", "sessionId", "iteration", "tool", "toolUseId"],
    tool_end: ["runId", "sessionId", "iteration", "tool", "toolUseId", "isError", "ms", "outputLength"],
    turn_end: ["runId", "sessionId", "iterations", "stopReason", "ms"],
    turn_error: ["runId", "sessionId", "errorType", "ms"],
    consolidation_start: ["runId", "sessionId", "trigger", "throughMessageId"],
    consolidation_end: ["runId", "sessionId", "throughMessageId", "factsCreated", "factsUpdated", "factsSkipped", "episodeChanged"],
    consolidation_error: ["runId", "sessionId", "throughMessageId", "errorType"],
  };
  const output: Record<string, unknown> = {};
  for (const key of allowedByType[type] ?? ["runId", "sessionId"]) {
    if (event[key] !== undefined) output[key] = key === "query" && typeof event[key] === "string"
      ? sanitizeQuery(event[key])
      : event[key];
  }
  return output;
}

function sanitizeQuery(value: string): string {
  return value
    .replace(/\b(?:sk|key|token)-[A-Za-z0-9_-]{8,}\b/gi, "[凭证已移除]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [凭证已移除]")
    .slice(0, 240);
}

function localIsoSeconds(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const absolute = Math.abs(offset);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
