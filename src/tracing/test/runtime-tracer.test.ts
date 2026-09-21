import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { createRuntimeTracer, readTraceRecords } from "../../index.ts";

const homes: string[] = [];
afterEach(async () => {
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })));
});
async function setup() {
  const home = await mkdtemp(join(tmpdir(), "trace-stream-")); homes.push(home);
  vi.stubEnv("LANGFUSE_ENABLED", "true");
  vi.stubEnv("LANGFUSE_PUBLIC_KEY", "public"); vi.stubEnv("LANGFUSE_SECRET_KEY", "secret");
  vi.stubEnv("LANGFUSE_BASE_URL", "http://langfuse.invalid");
  return home;
}

it("运行结束前就导出步骤，共享本地事件标识，删除 JSONL 也不影响实时上传", async () => {
  const home = await setup(); vi.useFakeTimers();
  const requests: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => { requests.push(String(init.body)); return new Response("{}"); }));
  const tracer = createRuntimeTracer(home);
  try {
    await tracer.record("run_started", { runId: "r", sessionId: "s", userInput: "私人问题" });
    await tracer.record("model_request", { runId: "r", modelCallId: "m", model: "test" });
    await tracer.record("model_response", { runId: "r", modelCallId: "m", model: "test", tokenUsage: { inputTokens: 3, outputTokens: 2 } });
    const records = await readTraceRecords(home);
    expect(records.map(record => record.sequence)).toEqual([1, 2, 3]);
    expect(records.some(record => record.type === "run_completed")).toBe(false);
    await rm(join(home, "traces"), { recursive: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain(records[2]!.eventId!);
    expect(requests[0]).not.toContain("私人问题");
    expect(requests[0]).toContain("generation");
  } finally { await tracer.close(); }
});

it("网络阻塞不阻止 JSONL 落盘，关闭等待在途导出且失败仅记录一次本地错误", async () => {
  const home = await setup();
  const pending = Promise.withResolvers<Response>();
  const started = Promise.withResolvers<void>();
  vi.stubGlobal("fetch", vi.fn(() => { started.resolve(); return pending.promise; }));
  const tracer = createRuntimeTracer(home);
  await tracer.record("run_started", { runId: "r" });
  await tracer.record("run_completed", { runId: "r" });
  await started.promise;
  expect((await readTraceRecords(home)).map(record => record.type)).toEqual(["run_started", "run_completed"]);
  const closed = vi.fn(); const closing = tracer.close().then(closed);
  await Promise.resolve(); expect(closed).not.toHaveBeenCalled();
  pending.resolve(new Response("敏感服务端错误", { status: 503 }));
  await closing;
  expect(fetch).toHaveBeenCalledTimes(1);
  const errors = (await readTraceRecords(home)).filter(record => record.type === "langfuse_export_failed");
  expect(errors).toHaveLength(1);
  expect(JSON.stringify(errors)).not.toContain("敏感服务端错误");
});

it("禁用时仅写本地，错误配置有本地记录且不阻断任务", async () => {
  const home = await setup(); const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  const disabled = createRuntimeTracer(home, false);
  await disabled.record("run_completed", { runId: "disabled" }); await disabled.close();
  vi.stubEnv("LANGFUSE_BASE_URL", "http://name:secret@localhost");
  const invalid = createRuntimeTracer(home);
  await invalid.record("run_completed", { runId: "invalid" }); await invalid.close();
  expect(fetcher).not.toHaveBeenCalled();
  const records = await readTraceRecords(home);
  expect(records.filter(record => record.type === "run_completed")).toHaveLength(2);
  expect(records.filter(record => record.type === "langfuse_export_failed")).toHaveLength(1);
  expect(JSON.stringify(records)).not.toContain("name:secret");
});

it("未启用的服务端配置不产生网络请求", async () => {
  const home = await setup(); vi.stubEnv("LANGFUSE_ENABLED", "false");
  await writeFile(join(home, "langfuse.env"), "LANGFUSE_ENABLED=true\n");
  vi.stubGlobal("fetch", vi.fn());
  const tracer = createRuntimeTracer(home);
  await tracer.record("run_completed", { runId: "r" }); await tracer.close();
  expect(fetch).not.toHaveBeenCalled();
});

it("无会话的向量操作按重建 ID 或操作 ID 归组，生命周期不被拆成不同运行", async () => {
  const home = await setup(); const requests: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => { requests.push(String(init.body)); return new Response("{}"); }));
  const tracer = createRuntimeTracer(home);
  await tracer.record("embedding_rebuild_started", { rebuildId: "rebuild" });
  for (const kind of ["embedding_started", "embedding_completed"]) {
    await tracer.record(kind, { rebuildId: "rebuild", operationId: "batch", model: "embedding-model" });
    await tracer.record(kind, { operationId: "standalone", model: "embedding-model" });
  }
  await tracer.record("embedding_rebuild_completed", { rebuildId: "rebuild" });
  await tracer.close();
  const records = await readTraceRecords(home);
  expect(records.filter(record => record.runId === "rebuild")).toHaveLength(4);
  expect(records.filter(record => record.runId === "standalone")).toHaveLength(2);
  expect(requests.join()).not.toContain("observation_incomplete");
});
