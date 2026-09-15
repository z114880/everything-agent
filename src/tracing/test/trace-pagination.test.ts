import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { JsonlTracer, listTraceRuns, readTraceRun } from "../../index.ts";

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))); });

it("按完整运行分页，详情保留全部事件及关联后台任务", async () => {
  const home = await mkdtemp(join(tmpdir(), "trace-pages-")); homes.push(home);
  const tracer = new JsonlTracer(home, { now: () => new Date("2026-09-15T00:00:00Z") });
  for (const runId of ["a", "b", "c"]) {
    await tracer.record("run_started", { runId, sessionId: "session" });
    await tracer.record("run_completed", { runId, sessionId: "session", derivedTaskIds: runId === "b" ? ["task"] : [] });
  }
  await tracer.record("memory_task_completed", { runId: "background", taskId: "task", taskKind: "memory_write", sourceRunId: "b" });
  const first = await listTraceRuns(home, { pageSize: 2 });
  expect(first.runs).toHaveLength(2);
  const second = await listTraceRuns(home, { pageSize: 2, cursor: first.nextCursor! });
  expect(new Set([...first.runs, ...second.runs].map((run) => run.runId)).size).toBe(4);
  expect(second.nextCursor).toBeNull();
  const detail = await readTraceRun(home, "b");
  expect(detail.flatMap((file) => file.records).map((record) => record.type)).toEqual(["run_started", "run_completed", "memory_task_completed"]);
  expect(await readTraceRun(home, "missing")).toEqual([]);
  await expect(listTraceRuns(home, { pageSize: 0 })).rejects.toThrow();
  await expect(listTraceRuns(home, { cursor: "invalid" })).rejects.toThrow();
});
