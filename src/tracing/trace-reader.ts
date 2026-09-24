export { readTraceFiles, readTraceRecords } from "./jsonl-tracer.ts";
export type { TraceFile, TraceRecord } from "./jsonl-tracer.ts";
import { readTraceFiles, type TraceFile } from "./jsonl-tracer.ts";

export interface TraceSummary {
  traceId: string;
  startedAt: string;
  eventCount: number;
  status: string;
}
export interface TracePage {
  traces: TraceSummary[];
  nextCursor: string | null;
}
export interface TracePageOptions { pageSize?: number; cursor?: string }

/** 按轨迹分页，游标固定首次分页的上界；列表不返回私人正文。 */
export async function listTraces(home: string, options: TracePageOptions = {}): Promise<TracePage> {
  const size = options.pageSize ?? 20;
  if (!Number.isInteger(size) || size < 1 || size > 100) throw new Error("每页轨迹数必须为 1–100");
  let cursor: { before: string; ceiling: string } | null = null;
  if (options.cursor) {
    try {
      cursor = JSON.parse(Buffer.from(options.cursor, "base64url").toString()) as { before: string; ceiling: string };
      if (!cursor || typeof cursor.before !== "string" || typeof cursor.ceiling !== "string") throw new Error();
    } catch { throw new Error("Trace 分页游标无效"); }
  }
  const grouped = new Map<string, TraceSummary>();
  for (const { records } of await readTraceFiles(home)) for (const record of records) {
    const value = grouped.get(record.traceId) ?? { traceId: record.traceId, startedAt: new Date(record.timestamp).toISOString(), eventCount: 0, status: "running" };
    const timestamp = new Date(record.timestamp).toISOString();
    value.startedAt = value.startedAt < timestamp ? value.startedAt : timestamp;
    value.eventCount++;
    if (["turn_completed", "turn_failed", "memory_task_completed", "memory_task_failed", "consolidation_completed", "consolidation_failed"].includes(record.type)) value.status = record.type.endsWith("failed") ? "failed" : "completed";
    if (record.type === "trace_read_error") value.status = "corrupt";
    grouped.set(record.traceId, value);
  }
  const key = (trace: TraceSummary) => `${trace.startedAt}|${trace.traceId}`;
  const all = [...grouped.values()].sort((a, b) => key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0);
  const ceiling = cursor?.ceiling ?? (all[0] ? key(all[0]) : "");
  const eligible = all.filter((trace) => key(trace) <= ceiling && (!cursor || key(trace) < cursor.before));
  const traces = eligible.slice(0, size);
  return { traces, nextCursor: eligible.length > size ? Buffer.from(JSON.stringify({ ceiling, before: key(traces.at(-1)!) })).toString("base64url") : null };
}

/** 完整读取指定轨迹及其派生任务，包含恢复文件中的记录，不按事件数截断。 */
export async function readTrace(home: string, traceId: string): Promise<TraceFile[]> {
  const files = await readTraceFiles(home);
  const turnId = files.flatMap((file) => file.records).find((record) => record.traceId === traceId)?.turnId;
  const taskIds = new Set(files.flatMap((file) => file.records).filter((record) => record.traceId === traceId)
    .flatMap((record) => Array.isArray(record.payload?.derivedTaskIds) ? record.payload.derivedTaskIds : []));
  return files.flatMap((file) => {
    const records = file.records.filter((record) => record.traceId === traceId || (turnId !== undefined && record.sourceTurnId === turnId) || taskIds.has(record.taskId));
    return records.length ? [{ path: file.path, records }] : [];
  });
}
