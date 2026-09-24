import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { createTraceEventFactory, type TraceRecord } from "./trace-event.ts";
export type { TraceRecord } from "./trace-event.ts";

export interface TraceFile {
  path: string;
  records: TraceRecord[];
}

export interface JsonlTracerOptions {
  onWarning?: (message: string) => void;
  now?: () => Date;
}

/** 按本地日期目录与 turn / task JSONL 文件持久化 classic loop 和 memory 事件。 */
export class JsonlTracer {
  private readonly traceDirectory: string;
  private readonly onWarning: (message: string) => void;
  private readonly makeRecord: ReturnType<typeof createTraceEventFactory>;
  private writeQueue: Promise<void> = Promise.resolve();
  private checkedPaths = new Set<string>();
  private recoveryPaths = new Map<string, string>();
  // 同一记录器的系统事件共用 UUID，避免把每个无 Session 事件拆成文件。
  private readonly systemId = crypto.randomUUID();

  constructor(home: string, options: JsonlTracerOptions = {}) {
    this.traceDirectory = join(home, "traces");
    this.onWarning = options.onWarning ?? (() => {});
    this.makeRecord = createTraceEventFactory(options.now);
  }

  /** 排队写入一个事件；失败只告警，不影响 Agent Loop。 */
  async record(type: string, event: Record<string, unknown>): Promise<void> {
    await this.writeEvent(this.makeRecord(type, event));
  }

  /** 写入已标准化的 TraceEvent，与其他导出器共享相同的事件标识和时间。 */
  async writeEvent(record: TraceRecord): Promise<void> {
    this.writeQueue = this.writeQueue.then(() => this.write(record)).catch((error) => {
      this.onWarning(`运行记录写入失败：${error instanceof Error ? error.message : String(error)}`);
    });
    await this.writeQueue;
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  // 固定使用前台运行首个事件的本地日期，避免跨午夜拆分。
  private readonly turnDates = new Map<string, string>();
  private readonly consolidationDates = new Map<string, string>();

  private async write(record: TraceRecord): Promise<void> {
    const consolidation = record.type.startsWith("consolidation_") || this.consolidationDates.has(record.traceId);
    if (consolidation && !this.consolidationDates.has(record.traceId)) {
      this.consolidationDates.set(record.traceId, typeof record.payload?.createdAt === "string" ? record.payload.createdAt : record.timestamp);
    }
    if (record.turnId && !this.turnDates.has(record.traceId)) {
      this.turnDates.set(record.traceId, record.timestamp);
    }
    const dateDirectory = join(this.traceDirectory, (this.consolidationDates.get(record.traceId) ?? (typeof record.taskCreatedAt === "string" ? record.taskCreatedAt : this.turnDates.get(record.traceId) ?? record.timestamp)).slice(0, 10));
    await mkdir(dateDirectory, { recursive: true });
    const traceFile = traceFileName(consolidation ? `consolidation-${record.traceId}` : typeof record.taskId === "string" ? `${record.taskKind}-${record.taskId}` : record.turnId ? `turn-${record.turnId}` : `system-${this.systemId}`);
    const primaryPath = await numberedTracePath(dateDirectory, traceFile);
    let path = this.recoveryPaths.get(primaryPath) ?? primaryPath;
    if (!this.checkedPaths.has(path)) {
      try {
        await validateJsonl(path);
      } catch {
        path = `${primaryPath.slice(0, -6)}.recovered-${record.timestamp.slice(11, 19).replaceAll(":", "")}.jsonl`;
        this.recoveryPaths.set(primaryPath, path);
        this.onWarning("当前运行记录文件无法安全追加，已切换到恢复文件。");
      }
      this.checkedPaths.add(path);
    }
    await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
  }
}

/** 读取 trace 目录中的事件；损坏行作为错误记录返回，不猜测修复。 */
export async function readTraceRecords(home: string): Promise<TraceRecord[]> {
  const files = await readTraceFiles(home);
  return files.flatMap((file) => file.records).sort(compareTraceRecords);
}

/** 按日期和带序号的 JSONL 文件读取运行记录。 */
export async function readTraceFiles(home: string): Promise<TraceFile[]> {
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
      for (const [lineIndex, line] of text.split(/\r?\n/).entries()) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line) as TraceRecord;
          if (!record || record.version !== 3 || typeof record.traceId !== "string" || typeof record.type !== "string" || typeof record.timestamp !== "string" || !Number.isFinite(Date.parse(record.timestamp))) throw new Error("运行记录字段无效");
          records.push(record);
        } catch {
          records.push({
            version: 3,
            eventId: createHash("sha256").update(`${dateDirectory}/${file}:${lineIndex}`).digest("hex"),
            type: "trace_read_error",
            timestamp: `${dateDirectory}T23:59:59Z`,
            sequence: 0,
            traceId: `corrupt-${createHash("sha256").update(`${dateDirectory}/${file}`).digest("hex")}`,
            payload: { file: `${dateDirectory}/${file}` },
          });
        }
      }
      records.sort(compareTraceRecords);
      traceFiles.push({ path: `${dateDirectory}/${file}`, records });
    }
  }
  return traceFiles;
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

function traceFileName(sessionId: string): string {
  if (/^[A-Za-z0-9_-]{1,200}$/.test(sessionId)) return `${sessionId}.jsonl`;
  const safe = encodeURIComponent(sessionId).replace(/%/g, "_").slice(0, 200);
  return `${safe || "unknown"}.jsonl`;
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

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
