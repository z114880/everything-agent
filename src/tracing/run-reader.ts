import { readTraceFiles, type TraceFile } from "./jsonl-tracer.ts";

export interface TraceRunSummary {
  runId: string;
  startedAt: string;
  eventCount: number;
  status: string;
}
export interface TraceRunPage {
  runs: TraceRunSummary[];
  nextCursor: string | null;
}
export interface TracePageOptions { pageSize?: number; cursor?: string }

/** 按运行分页，游标固定首次分页的上界；列表不返回私人正文。 */
export async function listTraceRuns(home: string, options: TracePageOptions = {}): Promise<TraceRunPage> {
  const size = options.pageSize ?? 20;
  if (!Number.isInteger(size) || size < 1 || size > 100) throw new Error("每页运行数必须为 1–100");
  let cursor: { before: string; ceiling: string } | null = null;
  if (options.cursor) {
    try {
      cursor = JSON.parse(Buffer.from(options.cursor, "base64url").toString()) as { before: string; ceiling: string };
      if (!cursor || typeof cursor.before !== "string" || typeof cursor.ceiling !== "string") throw new Error();
    } catch { throw new Error("Trace 分页游标无效"); }
  }
  const grouped = new Map<string, TraceRunSummary>();
  for (const { records } of await readTraceFiles(home)) for (const record of records) {
    const value = grouped.get(record.runId) ?? { runId: record.runId, startedAt: record.timestamp, eventCount: 0, status: "running" };
    value.startedAt = value.startedAt < record.timestamp ? value.startedAt : record.timestamp;
    value.eventCount++;
    if (/_(completed|failed)$/.test(record.type) && /^(run|memory_task|consolidation)_/.test(record.type)) value.status = record.type.endsWith("failed") ? "failed" : "completed";
    if (record.type === "trace_read_error") value.status = "corrupt";
    grouped.set(record.runId, value);
  }
  const key = (run: TraceRunSummary) => `${run.startedAt}|${run.runId}`;
  const all = [...grouped.values()].sort((a, b) => key(b).localeCompare(key(a)));
  const ceiling = cursor?.ceiling ?? (all[0] ? key(all[0]) : "");
  const eligible = all.filter((run) => key(run) <= ceiling && (!cursor || key(run) < cursor.before));
  const runs = eligible.slice(0, size);
  return { runs, nextCursor: eligible.length > size ? Buffer.from(JSON.stringify({ ceiling, before: key(runs.at(-1)!) })).toString("base64url") : null };
}

/** 完整读取指定运行及其派生任务，包含恢复文件中的记录，不按事件数截断。 */
export async function readTraceRun(home: string, runId: string): Promise<TraceFile[]> {
  const files = await readTraceFiles(home);
  const taskIds = new Set(files.flatMap((file) => file.records).filter((record) => record.runId === runId)
    .flatMap((record) => Array.isArray(record.payload?.derivedTaskIds) ? record.payload.derivedTaskIds : []));
  return files.flatMap((file) => {
    const records = file.records.filter((record) => record.runId === runId || record.sourceRunId === runId || taskIds.has(record.taskId));
    return records.length ? [{ path: file.path, records }] : [];
  });
}
