import { describe, expect, it } from "vitest";
import type { SessionSummary, TraceRecord } from "../src/agent-api";
import { groupTraceRecords } from "../src/trace-view-model";

describe("运行记录分组", () => {
  it("按 Session 汇总，并在 Session 内按 Agent 回合组织事件", () => {
    const records: TraceRecord[] = [
      record("session_selected", "activity", "s1", "2026-09-03T08:00:00+08:00"),
      { ...record("run_started", "r1", "s1", "2026-09-03T08:01:00+08:00"), payload: { userInput: "第一问" } },
      record("model_response", "r1", "s1", "2026-09-03T08:01:01+08:00"),
      { ...record("run_completed", "r1", "s1", "2026-09-03T08:01:02+08:00"), payload: { reply: "第一答" } },
      { ...record("run_started", "r2", "s1", "2026-09-03T08:02:00+08:00"), payload: { userInput: "第二问" } },
      record("run_failed", "r2", "s1", "2026-09-03T08:02:01+08:00"),
      record("trace_read_error", "broken", undefined, ""),
    ];
    const sessions: SessionSummary[] = [{
      id: "s1",
      title: "猫咪问题",
      messageCount: 4,
      createdAt: "2026-09-03T08:00:00+08:00",
      updatedAt: "2026-09-03T08:02:01+08:00",
      pendingMessages: 0,
    }];

    const groups = groupTraceRecords(records, sessions);

    expect(groups[0]).toMatchObject({ sessionId: "s1", title: "猫咪问题", eventCount: 5 });
    expect(groups[0]?.runs.map((run) => run.runId)).toEqual(["r2", "r1"]);
    expect(groups[0]?.runs[0]).toMatchObject({ status: "error", prompt: "第二问" });
    expect(groups[0]?.runs[1]).toMatchObject({ status: "completed", prompt: "第一问", reply: "第一答" });
    expect(groups[0]?.runs.find((run) => run.runId === "activity")).toBeUndefined();
    expect(groups[1]).toMatchObject({ sessionId: null, title: "系统记录", eventCount: 1 });
  });
});

function record(type: string, runId: string, sessionId: string | undefined, timestamp: string): TraceRecord {
  return { version: 1, type, timestamp, runId, ...(sessionId ? { sessionId } : {}) };
}
