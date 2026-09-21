import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
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


it("超过两千条的运行完整读取，新运行不会挤入既有游标页面", async () => {
  const home = await mkdtemp(join(tmpdir(), "trace-complete-")); homes.push(home);
  const directory = join(home, "traces", "2026-09-15"); await mkdir(directory, { recursive: true });
  const records = Array.from({ length: 2100 }, (_, sequence) => ({ version: 2, runId: "old", sessionId: "s", sequence, timestamp: "2026-09-15T00:00:00Z", type: sequence === 0 ? "run_started" : "model_response" }));
  await writeFile(join(directory, "001-run-old.jsonl"), records.map(record => JSON.stringify(record)).join("\n"));
  const tracer = new JsonlTracer(home, { now: () => new Date("2026-09-15T01:00:00Z") });
  await tracer.record("run_completed", { runId: "middle", sessionId: "s" });
  const first = await listTraceRuns(home, { pageSize: 1 });
  await new JsonlTracer(home, { now: () => new Date("2026-09-15T02:00:00Z") }).record("run_completed", { runId: "new", sessionId: "s" });
  const second = await listTraceRuns(home, { pageSize: 1, cursor: first.nextCursor! });
  expect(second.runs.map(run => run.runId)).toEqual(["old"]);
  expect(second.runs[0]?.eventCount).toBe(2100);
  expect((await readTraceRun(home, "old")).flatMap(file => file.records)).toHaveLength(2100);
  expect((await listTraceRuns(home, { pageSize: 1 })).runs[0]?.runId).toBe("new");
});

it("损坏行的分页标识稳定，错误详情可读取；子步骤完成不代表整个整理结束", async () => {
  const home = await mkdtemp(join(tmpdir(), "trace-corrupt-")); homes.push(home);
  const directory = join(home, "traces", "2026-09-15"); await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "001-broken.jsonl"), 'broken\nnull\n{}\n');
  const tracer = new JsonlTracer(home);
  await tracer.record("consolidation_started", { runId: "consolidate" });
  await tracer.record("consolidation_model_completed", { runId: "consolidate" });
  const first = await listTraceRuns(home), second = await listTraceRuns(home);
  expect(second).toEqual(first);
  expect(first.runs.find(run => run.runId === "consolidate")?.status).toBe("running");
  const corrupt = first.runs.find(run => run.status === "corrupt")!;
  const details = await readTraceRun(home, corrupt.runId);
  expect(details[0]?.records).toHaveLength(3);
  expect(details[0]?.records.every(record => record.type === "trace_read_error")).toBe(true);
});
