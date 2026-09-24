import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { JsonlTracer, listTraces, readTrace } from "../../index.ts";

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))); });

it("按完整运行分页，详情保留全部事件及关联后台任务", async () => {
  const home = await mkdtemp(join(tmpdir(), "trace-pages-")); homes.push(home);
  const tracer = new JsonlTracer(home, { now: () => new Date("2026-09-15T00:00:00Z") });
  for (const turnId of ["a", "b", "c"]) {
    await tracer.record("turn_started", { turnId, sessionId: "session" });
    await tracer.record("turn_completed", { turnId, sessionId: "session", derivedTaskIds: turnId === "b" ? ["task"] : [] });
  }
  await tracer.record("memory_task_completed", { taskId: "task", taskKind: "memory_write", sourceTurnId: "b" });
  const first = await listTraces(home, { pageSize: 2 });
  expect(first.traces).toHaveLength(2);
  const second = await listTraces(home, { pageSize: 2, cursor: first.nextCursor! });
  expect(new Set([...first.traces, ...second.traces].map((run) => run.traceId)).size).toBe(4);
  expect(second.nextCursor).toBeNull();
  const detail = await readTrace(home, "b");
  expect(detail.flatMap((file) => file.records).map((record) => record.type)).toEqual(["turn_started", "turn_completed", "memory_task_completed"]);
  expect(await readTrace(home, "missing")).toEqual([]);
  await expect(listTraces(home, { pageSize: 0 })).rejects.toThrow();
  await expect(listTraces(home, { cursor: "invalid" })).rejects.toThrow();
});


it("超过两千条的运行完整读取，新运行不会挤入既有游标页面", async () => {
  const home = await mkdtemp(join(tmpdir(), "trace-complete-")); homes.push(home);
  const directory = join(home, "traces", "2026-09-15"); await mkdir(directory, { recursive: true });
  const records = Array.from({ length: 2100 }, (_, sequence) => ({ version: 3, traceId: "old", turnId: "old", sessionId: "s", sequence, timestamp: "2026-09-15T00:00:00Z", type: sequence === 0 ? "turn_started" : "model_response" }));
  await writeFile(join(directory, "001-turn-old.jsonl"), records.map(record => JSON.stringify(record)).join("\n"));
  const tracer = new JsonlTracer(home, { now: () => new Date("2026-09-15T01:00:00Z") });
  await tracer.record("turn_completed", { turnId: "middle", sessionId: "s" });
  const first = await listTraces(home, { pageSize: 1 });
  await new JsonlTracer(home, { now: () => new Date("2026-09-15T02:00:00Z") }).record("turn_completed", { turnId: "new", sessionId: "s" });
  const second = await listTraces(home, { pageSize: 1, cursor: first.nextCursor! });
  expect(second.traces.map(run => run.traceId)).toEqual(["old"]);
  expect(second.traces[0]?.eventCount).toBe(2100);
  expect((await readTrace(home, "old")).flatMap(file => file.records)).toHaveLength(2100);
  expect((await listTraces(home, { pageSize: 1 })).traces[0]?.traceId).toBe("new");
});

it("损坏行的分页标识稳定，错误详情可读取；子步骤完成不代表整个整理结束", async () => {
  const home = await mkdtemp(join(tmpdir(), "trace-corrupt-")); homes.push(home);
  const directory = join(home, "traces", "2026-09-15"); await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "001-broken.jsonl"), 'broken\nnull\n{}\n');
  const tracer = new JsonlTracer(home);
  await tracer.record("consolidation_started", { taskId: "consolidate" });
  await tracer.record("consolidation_model_completed", { taskId: "consolidate" });
  const first = await listTraces(home), second = await listTraces(home);
  expect(second).toEqual(first);
  expect(first.traces.find(run => run.traceId === "consolidate")?.status).toBe("running");
  const corrupt = first.traces.find(run => run.status === "corrupt")!;
  const details = await readTrace(home, corrupt.traceId);
  expect(details[0]?.records).toHaveLength(3);
  expect(details[0]?.records.every(record => record.type === "trace_read_error")).toBe(true);
});


it("独立轨迹只读取自身，来源回合可展开派生任务且不包含无关整理", async () => {
  const home = await mkdtemp(join(tmpdir(), "trace-identities-")); homes.push(home);
  const tracer = new JsonlTracer(home);
  await tracer.record("turn_started", { turnId: "chat", sessionId: "s" });
  await tracer.record("turn_completed", { turnId: "chat", sessionId: "s" });
  await tracer.record("memory_task_started", { taskId: "write", taskKind: "memory_write", sourceTurnId: "chat" });
  await tracer.record("memory_task_completed", { taskId: "write", taskKind: "memory_write", sourceTurnId: "chat" });
  await tracer.record("consolidation_started", { taskId: "整理" });
  await tracer.record("embedding_completed", { operationId: "standalone" });
  const chat = (await readTrace(home, "chat")).flatMap(file => file.records);
  expect(chat.map(record => record.traceId)).toEqual(["chat", "chat", "write", "write"]);
  expect(chat.map(record => record.sequence)).toEqual([1, 2, 1, 2]);
  expect(chat.slice(0, 2).every(record => record.turnId === "chat" && !record.taskId)).toBe(true);
  expect(chat.slice(2).every(record => record.taskId === "write" && !record.turnId && record.sourceTurnId === "chat")).toBe(true);
  const independent = (await readTrace(home, "standalone")).flatMap(file => file.records);
  expect(independent).toHaveLength(1);
  expect(independent[0]).toMatchObject({ version: 3, traceId: "standalone", operationId: "standalone" });
  expect(independent[0]).not.toHaveProperty("turnId");
  expect(chat.every(record => !("runId" in record))).toBe(true);
});
