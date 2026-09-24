import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createLangfuseTracer, readLangfuseConfiguration } from "../langfuse/index.ts";
import type { TraceRecord } from "../jsonl-tracer.ts";

const directories: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
const config = { baseUrl: "http://localhost:3300", publicKey: "public", secretKey: "secret", captureContent: false };
function event(type: string, payload: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): TraceRecord {
  return { version: 3, traceId: String(extra.taskId ?? extra.turnId ?? "turn-1"), eventId: crypto.randomUUID(), turnId: "turn-1", sessionId: "session-1", timestamp: "2026-09-16T01:00:00.000Z", type, payload, ...extra };
}
function receiver(status = 200, body = "{}") {
  const requests: { url: string; body: any; headers: any }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => { requests.push({ url, body: JSON.parse(init.body), headers: init.headers }); return new Response(body, { status }); }));
  return requests;
}
function spans(requests: ReturnType<typeof receiver>) { return requests.flatMap((r) => r.body.resourceSpans[0].scopeSpans[0].spans); }
function attributes(span: any) { return Object.fromEntries(span.attributes.map((a: any) => [a.key, a.value.stringValue])); }

it("真实生命周期映射为模型、工具、召回和技能记录，默认不上传正文", async () => {
  const requests = receiver(); const tracer = createLangfuseTracer(config);
  tracer.record(event("turn_started", { userInput: "私人问题" }));
  tracer.record(event("model_request", { model: "model-a", request: { messages: "私人提示词" } }, { modelCallId: "model-1" }));
  tracer.record(event("model_response", { model: "model-a", response: "私人回答", tokenUsage: { inputTokens: 7, outputTokens: 3 } }, { modelCallId: "model-1", timestamp: "2026-09-16T01:00:01.000Z" }));
  tracer.record(event("tool_started", { tool: "read_skill" }, { toolCallId: "tool-1" }));
  tracer.record(event("skill_loaded", { skill: "writer", contentHash: "hash", instructionLength: 30, instructions: "私人技能" }, { toolCallId: "tool-1" }));
  tracer.record(event("tool_completed", { tool: "read_skill", arguments: {}, result: { instructions: "私人技能" } }, { toolCallId: "tool-1" }));
  tracer.record(event("retrieval_start", { mode: "hybrid" }, { operationId: "search-1" }));
  tracer.record(event("retrieval_completed", { semanticCount: 2, semantic: { denseQuery: "私人查询" } }, { operationId: "search-1" }));
  tracer.record(event("tool_completed", { tool: "external", result: "私人字符串结果" }, { toolCallId: "external" }));
  tracer.record(event("tool_completed", { tool: "external", result: ["私人数组结果"] }, { toolCallId: "external-array" }));
  tracer.record(event("turn_completed", { reply: "私人结果" }));
  expect(await tracer.flush(true)).toEqual([]);
  const all = spans(requests); const root = all.find((s) => s.name === "turn");
  expect(root.parentSpanId).toBeUndefined();
  expect(all.find((s) => s.name === "model").parentSpanId).toBe(root.spanId);
  const skill = all.find((s) => s.name === "skill_loaded"), tool = all.find((s) => s.name === "read_skill");
  expect(skill.parentSpanId).toBe(tool.spanId);
  expect(attributes(skill)["langfuse.observation.metadata.execution"]).toContain('"contentHash":"hash"');
  expect(attributes(all.find((s) => s.name === "model"))["langfuse.observation.usage_details"]).toBe('{"input":7,"output":3}');
  expect(all.map((s) => attributes(s)["langfuse.observation.type"])).toEqual(expect.arrayContaining(["agent", "generation", "tool", "retriever", "event"]));
  expect(JSON.stringify(requests)).not.toContain("私人");
  expect(requests[0]!.url).toBe("http://localhost:3300/api/public/otel/v1/traces");
  expect(requests[0]!.headers["x-langfuse-ingestion-version"]).toBe("4");
});

it("并发调用按调用标识匹配，后台任务使用独立 trace 并保留来源", async () => {
  const requests = receiver(); const tracer = createLangfuseTracer({ ...config, captureContent: true });
  tracer.record(event("turn_started"));
  for (const id of ["a", "b"]) tracer.record(event("model_request", { request: id }, { modelCallId: id }));
  for (const id of ["b", "a"]) tracer.record(event("model_response", { response: id }, { modelCallId: id }));
  tracer.record(event("turn_completed"));
  const background = { turnId: undefined, taskId: "task-run", sourceTurnId: "turn-1" };
  tracer.record(event("memory_task_started", { attempt: 1 }, background));
  tracer.record(event("memory_change_completed", { action: "update", targetId: 3 }, background));
  tracer.record(event("memory_task_completed", { attempt: 1 }, background));
  await tracer.flush(true);
  const all = spans(requests); const models = all.filter((s) => s.name === "model");
  for (const s of models) expect(attributes(s)["langfuse.observation.input"]).toBe(attributes(s)["langfuse.observation.output"]);
  expect(models[0].spanId).not.toBe(models[1].spanId);
  const task = all.find((s) => s.name === "task");
  expect(task.traceId).not.toBe(models[0].traceId);
  expect(attributes(task)["langfuse.observation.metadata.execution"]).toContain('"sourceTurnId":"turn-1"');
  expect(all.find((s) => s.name === "memory_change_completed").parentSpanId).toBe(task.spanId);
});

it("只有完成事件不推算起点，未完成操作关闭时明确标错", async () => {
  const requests = receiver(); const tracer = createLangfuseTracer(config);
  tracer.record(event("tool_completed", { tool: "session_read" }, { toolCallId: "orphan" }));
  tracer.record(event("model_request", {}, { modelCallId: "incomplete" }));
  await tracer.flush(true);
  const all = spans(requests);
  expect(attributes(all[0])["langfuse.observation.type"]).toBe("event");
  expect(all[0].startTimeUnixNano).toBe(all[0].endTimeUnixNano);
  expect(all[1].status.code).toBe(2);
});

it("网络和部分接收故障可观察，不把服务端正文和密钥带入错误", async () => {
  for (const [status, body] of [[401, "secret"], [200, '{"partialSuccess":{"rejectedSpans":"1","errorMessage":"secret"}}'], [200, "invalid"]] as const) {
    receiver(status, body); const warning = vi.fn(); const tracer = createLangfuseTracer(config, warning);
    tracer.record(event("turn_started")); tracer.record(event("turn_failed"));
    const errors = await tracer.flush(true);
    expect(errors.length).toBeGreaterThan(0); expect(errors.join()).not.toContain("secret"); expect(warning).toHaveBeenCalled();
  }
});

it("定时发送不会结束活跃步骤，队列满时报告丢失", async () => {
  vi.useFakeTimers(); const requests = receiver(); const tracer = createLangfuseTracer(config);
  tracer.record(event("skill_loaded", { skill: "writer" }));
  await vi.advanceTimersByTimeAsync(1000); await tracer.flush(); expect(requests).toHaveLength(1);
  let release!: (value: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { release = resolve; })));
  const warning = vi.fn(); const blocked = createLangfuseTracer(config, warning);
  for (let index = 0; index < 260; index++) blocked.record(event("turn_completed", {}, { turnId: `run-${index}` }));
  expect(warning).toHaveBeenCalledWith(expect.stringContaining("队列已满"));
  await Promise.resolve();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
  release(new Response("{}"));
  expect((await blocked.flush()).length).toBeGreaterThan(0);
});

it("服务端配置显式启用、环境覆盖文件，拒绝凭证地址和缺失密钥", async () => {
  const home = await mkdtemp(join(tmpdir(), "langfuse-config-")); directories.push(home);
  vi.stubEnv("LANGFUSE_ENABLED", "false"); expect(readLangfuseConfiguration(home)).toBeNull();
  await writeFile(join(home, "langfuse.env"), "LANGFUSE_ENABLED=true\nLANGFUSE_PUBLIC_KEY=p\nLANGFUSE_SECRET_KEY=s\nLANGFUSE_BASE_URL=http://localhost:3300\n");
  expect(readLangfuseConfiguration(home)).toBeNull();
  vi.stubEnv("LANGFUSE_ENABLED", "true"); expect(readLangfuseConfiguration(home)?.captureContent).toBe(false);
  vi.stubEnv("LANGFUSE_CAPTURE_CONTENT", "true");
  expect(readLangfuseConfiguration(home)?.captureContent).toBe(true);
  vi.stubEnv("LANGFUSE_BASE_URL", "http://user:pass@localhost"); expect(() => readLangfuseConfiguration(home)).toThrow("地址");
  vi.stubEnv("LANGFUSE_BASE_URL", "http://localhost:3300"); vi.stubEnv("LANGFUSE_SECRET_KEY", ""); expect(() => readLangfuseConfiguration(home)).toThrow("密钥");
  const invalid = await mkdtemp(join(tmpdir(), "langfuse-invalid-")); directories.push(invalid); await mkdir(join(invalid, "langfuse.env"));
  expect(() => readLangfuseConfiguration(invalid)).toThrow();
});

it("整理批次、模型与变更保持父子关系，不同调用与重试不共用 span", async () => {
  const requests = receiver(); const tracer = createLangfuseTracer(config);
  for (const attempt of [1, 2]) {
    const fields = { attempt, batchIndex: 0 };
    tracer.record(event("consolidation_started", fields));
    tracer.record(event("consolidation_batch_started", fields));
    tracer.record(event("consolidation_model_started", { ...fields, model: "memory-model" }, { modelCallId: "call" }));
    tracer.record(event("consolidation_model_completed", { ...fields, tokenUsage: { inputTokens: 9, outputTokens: 2 } }, { modelCallId: "call" }));
    tracer.record(event("consolidation_change", { ...fields, action: "update" }));
    tracer.record(event("consolidation_batch_completed", fields));
    tracer.record(event(attempt === 1 ? "consolidation_retry" : "consolidation_completed", fields));
  }
  await tracer.flush(true);
  const all = spans(requests);
  const roots = all.filter(span => span.name === "consolidation");
  const batches = all.filter(span => span.name === "batch");
  const models = all.filter(span => span.name === "consolidation_model");
  const changes = all.filter(span => span.name === "consolidation_change");
  expect(new Set(all.map(span => span.spanId)).size).toBe(all.length);
  for (let i = 0; i < 2; i++) {
    expect(batches[i].parentSpanId).toBe(roots[i].spanId);
    expect(models[i].parentSpanId).toBe(batches[i].spanId);
    expect(changes[i].parentSpanId).toBe(batches[i].spanId);
    expect(attributes(models[i])["langfuse.observation.usage_details"]).toBe('{"input":9,"output":2}');
  }
  expect(roots.map(span => span.status.code)).toEqual([2, 1]);
});

it("并发 Gate 和 Embedding 按 operationId 配对，并保留模型与真实用量", async () => {
  const requests = receiver(); const tracer = createLangfuseTracer(config);
  tracer.record(event("turn_started"));
  for (const operationId of ["gate-a", "gate-b"]) tracer.record(event("gate_start", { model: operationId }, { operationId }));
  for (const operationId of ["gate-b", "gate-a"]) tracer.record(event("gate_end", { tokenUsage: { inputTokens: 5, outputTokens: 1 } }, { operationId }));
  for (const operationId of ["embed-a", "embed-b"]) tracer.record(event("embedding_started", { model: operationId }, { operationId }));
  tracer.record(event("embedding_failed", { errorType: "TimeoutError" }, { operationId: "embed-b" }));
  tracer.record(event("embedding_completed", { tokenUsage: { inputTokens: 12, totalTokens: 12 } }, { operationId: "embed-a" }));
  tracer.record(event("turn_completed")); await tracer.flush(true);
  const all = spans(requests);
  const gates = all.filter(span => span.name === "gate"), embeddings = all.filter(span => span.name === "embedding");
  expect(gates.map(span => attributes(span)["langfuse.observation.model.name"])).toEqual(["gate-b", "gate-a"]);
  expect(embeddings.map(span => attributes(span)["langfuse.observation.model.name"])).toEqual(["embed-b", "embed-a"]);
  expect(embeddings.map(span => span.status.code)).toEqual([2, 1]);
  expect(attributes(embeddings[1])["langfuse.observation.usage_details"]).toBe('{"input":12}');
});

it("压缩摘要调用归属压缩步骤，保留模型用量和水位且不上传摘要", async () => {
  const requests = receiver(); const tracer = createLangfuseTracer(config);
  const common = { compactionId: "compact-1" };
  tracer.record(event("turn_started"));
  tracer.record(event("compact_started", { beforeTokens: 7000, targetTokens: 3000, availableInputTokens: 10000 }, common));
  tracer.record(event("compact_model_started", { model: "main" }, { ...common, modelCallId: "summary-call" }));
  tracer.record(event("compact_model_completed", { model: "main", tokenUsage: { inputTokens: 7000, outputTokens: 100 }, summary: "私人摘要" }, { ...common, modelCallId: "summary-call" }));
  tracer.record(event("compact_completed", { beforeTokens: 7000, afterTokens: 2000, targetReached: true, ms: 200 }, common));
  tracer.record(event("turn_completed"));
  await tracer.flush(true);
  const all = spans(requests);
  const compact = all.find((s) => s.name === "compact");
  const generation = all.find((s) => s.name === "compact_model");
  expect(generation.parentSpanId).toBe(compact.spanId);
  expect(compact.parentSpanId).toBe(all.find((s) => s.name === "turn").spanId);
  expect(attributes(generation)["langfuse.observation.type"]).toBe("generation");
  expect(attributes(generation)["langfuse.observation.usage_details"]).toBe('{"input":7000,"output":100}');
  expect(attributes(compact)["langfuse.observation.metadata.execution"]).toContain('"afterTokens":2000');
  expect(JSON.stringify(requests)).not.toContain("私人摘要");
});
