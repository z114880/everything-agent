import type { SessionSummary, TraceRecord } from "./agent-api";

export interface TraceRunGroup {
  runId: string;
  startedAt: string;
  endedAt: string;
  status: "completed" | "error" | "running";
  prompt?: string;
  reply?: string;
  records: TraceRecord[];
}

export interface TraceSessionGroup {
  sessionId: string | null;
  title: string;
  latestAt: string;
  eventCount: number;
  runs: TraceRunGroup[];
}

/** 将扁平 trace 稳定整理为 Session → Agent 回合 → 事件三级结构。 */
export function groupTraceRecords(
  records: TraceRecord[],
  sessions: SessionSummary[],
): TraceSessionGroup[] {
  const titles = new Map(sessions.map((session) => [session.id, session.title]));
  const buckets = new Map<string, TraceRecord[]>();
  for (const record of records) {
    if (record.type === "session_created" || record.type === "session_selected") continue;
    const key = record.sessionId || "__system__";
    buckets.set(key, [...(buckets.get(key) ?? []), record]);
  }

  return [...buckets.entries()].map(([key, sessionRecords]) => {
    const ordered = sessionRecords.slice().sort(compareRecords);
    const runBuckets = new Map<string, TraceRecord[]>();
    for (const record of ordered) {
      runBuckets.set(record.runId, [...(runBuckets.get(record.runId) ?? []), record]);
    }
    const runs = [...runBuckets.entries()].map(([runId, runRecords]) => toRun(runId, runRecords))
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    const latestAt = ordered.at(-1)?.timestamp ?? "";
    const sessionId = key === "__system__" ? null : key;
    return {
      sessionId,
      title: sessionId ? titles.get(sessionId) ?? `会话 ${shortId(sessionId)}` : "系统记录",
      latestAt,
      eventCount: ordered.length,
      runs,
    };
  }).sort((left, right) => right.latestAt.localeCompare(left.latestAt));
}

function toRun(runId: string, records: TraceRecord[]): TraceRunGroup {
  const ordered = records.slice().sort(compareRecords);
  const start = ordered.find((record) => record.type === "run_started" || record.type === "turn_start");
  const end = [...ordered].reverse().find((record) => record.type === "run_completed" || record.type === "turn_end");
  const failed = ordered.some((record) => record.type === "run_failed"
    || record.type === "turn_error"
    || record.type === "consolidation_error"
    || record.type === "trace_read_error");
  const completed = Boolean(end || ordered.some((record) => record.type === "consolidation_end"));
  const startPayload = payloadOf(start);
  const endPayload = payloadOf(end);
  return {
    runId,
    startedAt: start?.timestamp ?? ordered[0]?.timestamp ?? "",
    endedAt: ordered.at(-1)?.timestamp ?? "",
    status: failed ? "error" : completed ? "completed" : "running",
    ...(typeof startPayload.userInput === "string" ? { prompt: startPayload.userInput }
      : typeof start?.userMessage === "string" ? { prompt: start.userMessage } : {}),
    ...(typeof endPayload.reply === "string" ? { reply: endPayload.reply }
      : typeof end?.reply === "string" ? { reply: end.reply } : {}),
    records: ordered,
  };
}

function compareRecords(left: TraceRecord, right: TraceRecord): number {
  return left.timestamp.localeCompare(right.timestamp) || (left.sequence ?? 0) - (right.sequence ?? 0);
}

function payloadOf(record: TraceRecord | undefined): Record<string, unknown> {
  return record?.payload ?? {};
}

export function shortId(value: string): string {
  return value.slice(0, 8);
}
