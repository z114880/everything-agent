import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createEvaluationService, starterDatasets, validateDataset, emptyEvaluationCase, summarizeRun, scoreAssertions, createFixtureTools, type EvaluationDataset, type EvaluationRun, type EvaluationExecution, type EvaluationEvidence } from "../index.ts";
import { startMockProvider } from "../../../mock-data/mock-provider.ts";

const directories: string[] = [], servers: Server[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(servers.splice(0).map(server => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }))); await Promise.all(directories.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
async function environment() {
  const directory = await mkdtemp(join(tmpdir(), "fixed-evaluation-")); directories.push(directory);
  const configurationHome = join(directory, "configuration"); await mkdir(configurationHome);
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const items = new Map<string, Record<string, unknown>[]>();
  const state = { fail: "", invalidScore: false, scoreReady: false, rejectSpans: false, source: "EVAL", corruptDataset: false };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://localhost"); let raw = ""; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    requests.push({ path: url.pathname, body }); res.setHeader("Content-Type", "application/json");
    if (state.fail && url.pathname.endsWith(state.fail)) { res.writeHead(500); res.end('{"error":"secret-never-show"}'); return; }
    let value: unknown = {};
    if (url.pathname.endsWith("/v2/datasets")) { items.set(String(body.name), []); value = { id: crypto.randomUUID() }; }
    else if (url.pathname.endsWith("/dataset-items")) {
      if (req.method === "POST") { const item = { ...body, updatedAt: new Date().toISOString() }; items.get(String(body.datasetName))!.push(item); value = item; }
      else value = { data: state.corruptDataset ? [] : items.get(url.searchParams.get("datasetName")!) ?? [], meta: { totalPages: 1 } };
    } else if (url.pathname.endsWith("/v3/scores")) {
      value = { data: state.scoreReady ? [{ source: state.source, name: "task_quality", dataType: "NUMERIC", value: state.invalidScore ? 9 : 0.9, comment: "完成任务", updatedAt: new Date().toISOString(), subject: { kind: "observation", id: url.searchParams.get("observationId"), traceId: url.searchParams.get("traceId") } }] : [], meta: {} };
    } else if (url.pathname.endsWith("/otel/v1/traces") && state.rejectSpans) value = { partialSuccess: { rejectedSpans: 1 } };
    res.end(JSON.stringify(value));
  }); servers.push(server);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const address = server.address() as { port: number };
  vi.stubEnv("LANGFUSE_ENABLED", "true"); vi.stubEnv("LANGFUSE_BASE_URL", `http://127.0.0.1:${address.port}`); vi.stubEnv("LANGFUSE_PUBLIC_KEY", "public"); vi.stubEnv("LANGFUSE_SECRET_KEY", "private"); vi.stubEnv("LANGFUSE_PROJECT_ID", "project"); vi.stubEnv("LANGFUSE_EVALUATION_CAPTURE_CONTENT", "true");
  const service = createEvaluationService(join(directory, "evaluation"), configurationHome, { sourceRoot: resolve("."), scoreWaitMs: 0 });
  return { directory, configurationHome, service, state, requests };
}
async function configure(home: string, baseUrl: string) {
  await writeFile(join(home, "config.json"), JSON.stringify({ models: { agent: { provider: "openai-compatible", model: "mock-agent", baseUrl }, small: { provider: "openai-compatible", model: "mock-small", baseUrl } }, retrieval: { mode: "lexical_only" } }));
  await writeFile(join(home, ".env"), "EVERYTHING_AGENT_API_KEY=fixture-secret\nEVERYTHING_SMALL_API_KEY=fixture-secret\n");
}
function dataset(judge = false): EvaluationDataset {
  return { id: "assistant", name: "个人助理", description: "模拟用例", defaultEnabled: true, cases: [{ ...emptyEvaluationCase("answer"), name: "回答", turns: ["请回答完成"], assertions: [{ kind: "reply_contains", value: "完成" }], ...(judge ? { criteria: "是否完成", judge: { scoreName: "task_quality", threshold: 0.8 } } : {}) }] };
}
it("固定数据集只含一个代码场景，配置校验拒绝无断言、越界和凭证", () => {
  const starters = starterDatasets(); starters.forEach(d => expect(validateDataset(d)).toEqual(d));
  expect(starters.flatMap(d => d.cases).filter(c => c.terminal)).toHaveLength(1);
  for (const value of [null, {}, { ...dataset(), id: "../escape" }, { ...dataset(), defaultEnabled: 1 }, { ...dataset(), cases: [] }, { ...dataset(), apiKey: "secret" }, { ...dataset(), cases: [dataset().cases[0], dataset().cases[0]] }]) expect(() => validateDataset(value)).toThrow();
  for (const changes of [{ files: { "../secret": "x" } }, { files: { ".env": "x" } }, { files: { "/x": "x" } }, { assertions: [] }, { turns: [] }, { judge: { scoreName: "bad name", threshold: 1 }, criteria: "规则" }, { judge: { scoreName: "quality", threshold: 2 }, criteria: "规则" }, { criteria: "缺少裁判" }, { terminal: true, tools: [{ name: "run_terminal", arguments: {}, result: {} }] }, { tools: [{ name: "unknown", arguments: {}, result: {} }] }, { assertions: [{ kind: "invalid" }] }]) expect(() => validateDataset({ ...dataset(), cases: [{ ...dataset().cases[0], ...changes }] })).toThrow();
});
it("数据集保存是版本化提交，失败不覆盖；初始化不覆盖用户编辑", async () => {
  const e = await environment();
  expect((await e.service.overview()).datasets).toEqual([]);
  await expect(e.service.start()).rejects.toThrow("默认数据集");
  const first = await e.service.saveDataset(dataset());
  expect((await e.service.dataset(first.id)).cases).toEqual(dataset().cases);
  const next = await e.service.saveDataset({ ...dataset(), name: "新名称" });
  expect(first.remoteName).not.toBe(next.remoteName);
  e.state.fail = "/dataset-items";
  await expect(e.service.saveDataset(dataset())).rejects.toThrow("500");
  expect((await e.service.overview()).datasets[0]?.name).toBe("新名称");
  e.state.fail = ""; await e.service.initializeDatasets();
  const before = e.requests.length; await e.service.initializeDatasets(); expect(e.requests).toHaveLength(before);
  await expect(e.service.dataset("missing")).rejects.toThrow("不存在");
  await expect(e.service.start(["missing"])).rejects.toThrow("不存在");
  await expect(e.service.start([])).rejects.toThrow("请选择");
  e.state.corruptDataset = true; await expect(e.service.dataset(first.id)).rejects.toThrow();
  const catalog = await readFile(join(e.directory, "evaluation", "datasets.json"), "utf8");
  expect(catalog).not.toContain('"turns"'); expect(catalog).not.toContain("private");
});
it("运行当前 Agent，冻结版本和源码，未知费用不影响通过，事件关联完整", async () => {
  const e = await environment(); const provider = await startMockProvider({ plan: () => ({ reply: "完成" }) });
  try {
    await configure(e.configurationHome, provider.baseUrl); await e.service.saveDataset(dataset());
    const observed: string[] = []; const unsubscribe = e.service.subscribe(event => observed.push(event.type));
    const id = await e.service.start();
    await expect(e.service.start()).rejects.toThrow("正在进行");
    await expect(e.service.saveDataset(dataset())).rejects.toThrow("正在进行");
    await e.service.wait(); unsubscribe();
    const run = await e.service.get(id);
    expect(run.error).toBeNull(); expect(run.report).toMatchObject({ decision: "passed", passed: 1, total: 1 });
    expect(run.executions[0]?.evidence?.agentUsd).toBeNull(); expect(run.codeHash).toHaveLength(64);
    expect(JSON.stringify(run)).not.toContain("fixture-secret");
    const events = await e.service.events(id); expect(events.map(ev => ev.type)).toEqual(["dataset_ready", "agent_started", "execution_started", "execution_completed", "scoring_started", "gate_completed"]);
    expect(observed).toEqual(events.map(ev => ev.type)); expect(events.map(ev => ev.sequence)).toEqual([1, 2, 3, 4, 5, 6]); expect(events.every(ev => ev.runId === id && Boolean(ev.timestamp))).toBe(true);
    const spans = JSON.stringify(e.requests.filter(r => r.path.endsWith("/otel/v1/traces")));
    expect(spans).toContain("langfuse.experiment.item.version"); expect(spans).toContain(run.datasets[0]!.itemIds.answer);
    expect(await e.service.refreshScores(id)).toMatchObject({ report: { decision: "passed" } });
    expect(e.service.cancel(id)).toBe(false);
  } finally { await provider.close(); }
}, 20000);
it("平台未评分不会通过，人工同名分数不采用，刷新不重复调用 Agent", async () => {
  const e = await environment(); let calls = 0; const provider = await startMockProvider({ plan: () => { calls++; return { reply: "完成" }; } });
  try {
    await configure(e.configurationHome, provider.baseUrl); await e.service.saveDataset(dataset(true));
    const id = await e.service.start(); await e.service.wait();
    expect(await e.service.get(id)).toMatchObject({ status: "waiting_scores", report: { decision: "insufficient" } });
    const before = calls; e.state.scoreReady = true; e.state.source = "ANNOTATION";
    expect((await e.service.refreshScores(id)).report.decision).toBe("insufficient");
    e.state.source = "EVAL"; e.state.invalidScore = true;
    expect((await e.service.refreshScores(id)).report.decision).toBe("insufficient");
    e.state.invalidScore = false;
    expect((await e.service.refreshScores(id)).report.decision).toBe("passed"); expect(calls).toBe(before);
    expect((await e.service.overview()).active).toBeNull();
  } finally { await provider.close(); }
}, 20000);
it("Langfuse 部分拒收不能标为同步成功，重试仅补传已有证据", async () => {
  const e = await environment(); const provider = await startMockProvider({ plan: () => ({ reply: "完成" }) });
  try {
    await configure(e.configurationHome, provider.baseUrl); await e.service.saveDataset(dataset()); e.state.rejectSpans = true;
    const id = await e.service.start(); await e.service.wait();
    expect(await e.service.get(id)).toMatchObject({ status: "failed", report: { decision: "insufficient" } });
    e.state.rejectSpans = false; expect((await e.service.refreshScores(id)).report.decision).toBe("passed");
  } finally { await provider.close(); }
}, 20000);
it("取消前台执行后不触发平台评分，已落盘事件可回放", async () => {
  const e = await environment(); const provider = await startMockProvider({ plan: () => ({ reply: "完成" }) });
  try {
    await configure(e.configurationHome, provider.baseUrl); await e.service.saveDataset(dataset());
    const id = await e.service.start(); expect(e.service.cancel(id)).toBe(true); await e.service.wait();
    expect(await e.service.get(id)).toMatchObject({ status: "cancelled", report: { decision: "insufficient" } });
    expect((await e.service.events(id)).at(-1)?.type).toBe("run_cancelled");
    await expect(e.service.refreshScores(id)).rejects.toThrow();
    expect(e.requests.some(r => r.path.endsWith("/v3/scores"))).toBe(false);
  } finally { await provider.close(); }
}, 20000);
it("关闭内容上传阻止语义评估，未配置 Langfuse 时概览仍可打开", async () => {
  const e = await environment(); await e.service.saveDataset(dataset(true)); vi.stubEnv("LANGFUSE_EVALUATION_CAPTURE_CONTENT", "false");
  await expect(e.service.start()).rejects.toThrow("CAPTURE_CONTENT");
  vi.stubEnv("LANGFUSE_ENABLED", "false"); expect((await e.service.overview()).langfuse.configured).toBe(false);
  await expect(e.service.saveDataset(dataset())).rejects.toThrow("启用 Langfuse");
});
it("确定性断言检查真实状态，关键失败不能被其他高分抵消", () => {
  const evidence: EvaluationEvidence = { complete: true, replies: ["完成"], memory: [{ subject: "用户", content: "咖啡" }], files: { "x.txt": "内容" }, traces: [], toolCalls: [{ tool: "search_web", arguments: { query: "x" }, isError: false }], runIds: [], derivedTaskIds: [], responseMs: 1, totalMs: 1, agentUsd: null, modelCalls: 1, usage: [] };
  const c = { ...dataset().cases[0]!, assertions: [{ kind: "reply_equals" as const, value: "完成" }, { kind: "memory_contains" as const, value: "咖啡" }, { kind: "memory_absent" as const, value: "旧地址" }, { kind: "file_equals" as const, path: "x.txt", value: "内容" }, { kind: "tool_called" as const, tool: "search_web", arguments: { query: "x" } }, { kind: "tool_forbidden" as const, tool: "run_terminal" }] };
  expect(scoreAssertions(c, evidence).every(s => s.status === "passed")).toBe(true);
  expect(scoreAssertions(c, { ...evidence, toolCalls: [{ tool: "search_web", arguments: { query: "x" }, isError: true }] })[4]?.status).toBe("failed");
  const d = { ...dataset(), cases: [c], remoteName: "remote", remoteId: "remote", version: "version", count: 1, url: null, itemIds: { answer: "item" } };
  const execution: EvaluationExecution = { id: "e", datasetId: d.id, caseId: c.id, status: "completed", error: null, evidence, scores: scoreAssertions(c, evidence), sync: "synced", traceId: "trace", observationId: "root", traceUrl: null };
  const run: Pick<EvaluationRun, "datasets" | "executions" | "status"> = { datasets: [d], executions: [execution], status: "completed" };
  expect(summarizeRun(run).decision).toBe("passed");
  expect(summarizeRun({ ...run, executions: [] }).decision).toBe("insufficient");
  execution.status = "timed_out"; expect(summarizeRun(run).decision).toBe("failed");
});
it("模拟外部工具未匹配时不回退真实工具，保留记忆与 Skill 实现", async () => {
  const original = { schemas: () => [], execute: vi.fn(async () => "原始结果") };
  const testCase = starterDatasets()[0]!.cases[0]!;
  const tools = createFixtureTools(original, testCase, "/tmp");
  const context = { signal: undefined, deadline: null, iteration: 1, toolUseId: "t" };
  expect(await tools.execute("read_skill", {}, vi.fn(), context)).toBe("原始结果");
  await expect(tools.execute("search_web", {}, vi.fn(), context)).rejects.toThrow("未注册");
  await expect(tools.execute("get_current_time", { timezone: "other" }, vi.fn(), context)).rejects.toThrow();
  expect(await tools.execute("get_current_time", {}, vi.fn(), context)).toMatchObject({ timeZone: "Asia/Shanghai" });
  expect(original.execute).toHaveBeenCalledTimes(1);
});

it("重启后将中断执行记录为失败事件，流程图不会永远停留在运行中", async () => {
  const e = await environment(); const provider = await startMockProvider({ plan: () => ({ reply: "完成" }) });
  try {
    await configure(e.configurationHome, provider.baseUrl); await e.service.saveDataset(dataset());
    const id = await e.service.start(); await e.service.wait(); const run = await e.service.get(id);
    await writeFile(join(e.directory, "evaluation", "runs", id, "run.json"), JSON.stringify({ ...run, status: "running", stage: "agent" }));
    const restarted = createEvaluationService(join(e.directory, "evaluation"), e.configurationHome);
    const results = await Promise.all([restarted.get(id), restarted.get(id)]);
    expect(results.every(r => r.status === "failed" && r.report.decision === "insufficient")).toBe(true);
    const events = await restarted.events(id); expect(events.at(-1)).toMatchObject({ type: "run_failed", stage: "agent", decision: "insufficient" });
    expect(events.filter(ev => ev.type === "run_failed")).toHaveLength(1);
  } finally { await provider.close(); }
}, 20000);
