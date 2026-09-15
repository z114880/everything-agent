import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { createEvaluationService, validateEvaluationPlan, scoreAssertions, compareEvaluations, createFixtureTools } from "../index.ts";
import type { EvaluationEvidence, EvaluationExecution } from "../index.ts";
import { exampleEvaluationPlan } from "../example.ts";
import { LocalToolRegistry } from "../../tools/tool-registry.ts";
import { startMockProvider } from "../../../mock-data/mock-provider.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const directories: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function directory() { const p = await mkdtemp(join(tmpdir(), "evaluation-")); directories.push(p); return p; }
const evidence: EvaluationEvidence = { complete: true, replies: ["完成"], memory: [{ subject: "用户", content: "喜欢咖啡" }], files: { "result.txt": "完成" }, traces: [], toolCalls: [{ tool: "get_current_time", arguments: {}, isError: false }], runIds: [], derivedTaskIds: [], responseMs: 1, totalMs: 2, agentUsd: 0.01, modelCalls: 1, usage: [] };

it("固定配置拒绝无规则、凭证、路径穿越和无效预算", () => {
  const plan = exampleEvaluationPlan(root);
  expect(validateEvaluationPlan(plan)).toEqual(plan);
  for (const alter of [
    (p: typeof plan) => { p.dataset.cases[0]!.files = { "../secret": "x" }; },
    (p: typeof plan) => { p.repetitions = 0; },
    (p: typeof plan) => { p.dataset.cases[0]!.assertions = []; },
    (p: typeof plan) => { p.dataset.cases[0]!.criteria = "质量"; },
    (p: typeof plan) => { p.candidate.agent.baseUrl = "https://user:password@example.com"; },
    (p: typeof plan) => { p.dataset.cases.push(p.dataset.cases[0]!); },
  ]) { const copy = structuredClone(plan); alter(copy); expect(() => validateEvaluationPlan(copy)).toThrow(); }
  expect(() => validateEvaluationPlan({ ...plan, apiKey: "secret" })).toThrow("凭证");
});

it("确定性评分检查最终产物、记忆和工具成功，禁止调用包含失败尝试", () => {
  const c = exampleEvaluationPlan(root).dataset.cases[0]!;
  c.assertions = [{ kind: "reply_equals", value: "完成" }, { kind: "reply_contains", value: "成" }, { kind: "memory_contains", value: "咖啡" }, { kind: "memory_absent", value: "茶" }, { kind: "file_equals", path: "result.txt", value: "完成" }, { kind: "tool_called", tool: "get_current_time", arguments: {} }, { kind: "tool_forbidden", tool: "search_web" }];
  expect(scoreAssertions(c, evidence).every((s) => s.status === "passed")).toBe(true);
  const bad = structuredClone(evidence); bad.toolCalls[0]!.isError = true;
  expect(scoreAssertions(c, bad)[5]?.status).toBe("failed");
  c.assertions = [{ kind: "tool_forbidden", tool: "get_current_time" }];
  expect(scoreAssertions(c, bad)[0]?.status).toBe("failed");
});

it("发布门槛不把缺失执行、评分错误、未知成本算作通过", () => {
  const plan = exampleEvaluationPlan(root); plan.repetitions = 1; plan.gate.minimumRepetitions = 1;
  const base: EvaluationExecution = { id: "x", caseId: "current-time", variant: "baseline", repetition: 1, status: "completed", error: null, evidence, scores: [{ name: "x", score: 1, status: "passed", reason: "" }], judgeUsd: 0 };
  const candidate = { ...base, id: "y", variant: "candidate" as const };
  expect(compareEvaluations(plan, [base, candidate]).decision).toBe("passed");
  expect(compareEvaluations(plan, [base, { ...candidate, evidence: { ...evidence, agentUsd: null } }]).decision).toBe("insufficient");
  expect(compareEvaluations(plan, [base]).decision).toBe("insufficient");
  expect(compareEvaluations(plan, [base, { ...candidate, scores: [{ name: "x", score: null, status: "error", reason: "裁判不可用" }] }]).decision).toBe("insufficient");
  expect(compareEvaluations(plan, [base, { ...candidate, status: "failed" }]).decision).toBe("failed");
  plan.gate.maxAgentUsd = 1;
  expect(compareEvaluations(plan, [base, { ...candidate, evidence: { ...evidence, agentUsd: null } }]).decision).toBe("insufficient");
  plan.gate.maxAgentUsd = 0;
  expect(compareEvaluations(plan, [base, candidate]).decision).toBe("failed");
});

it("工具环境验证参数、拒绝未匹配请求、保留审批与安全拒绝", async () => {
  const workspace = await directory(); const c = exampleEvaluationPlan(root).dataset.cases[0]!;
  c.tools.push({ name: "run_terminal", arguments: { command: "git push" }, result: { exitCode: 0 }, files: { "result.txt": "done" }, approval: false });
  c.tools.push({ name: "run_terminal", arguments: { command: "rm -rf /" }, result: {} });
  const tools = createFixtureTools(new LocalToolRegistry(), c, workspace);
  const events: string[] = []; const notify = (kind: string) => { events.push(kind); };
  const context = { signal: undefined, deadline: null, iteration: 1, toolUseId: "t" };
  expect(tools.schemas()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "get_current_time" })]));
  expect(await tools.execute("get_current_time", {}, notify, context)).toEqual(c.tools[0]!.result);
  await expect(tools.execute("get_current_time", { extra: true }, notify, context)).rejects.toThrow("未知工具参数");
  await expect(tools.execute("run_terminal", {}, notify, context)).rejects.toThrow("缺少工具参数");
  await expect(tools.execute("run_terminal", { command: "echo x" }, notify, context)).rejects.toThrow("未匹配");
  await expect(tools.execute("run_terminal", { command: "git push" }, notify, context)).rejects.toThrow("审批");
  expect(events).toEqual(["approval_requested", "approval_resolved"]);
  c.tools[1]!.approval = true;
  await tools.execute("run_terminal", { command: "git push" }, notify, context);
  expect(await readFile(join(workspace, "result.txt"), "utf8")).toBe("done");
  await expect(tools.execute("run_terminal", { command: "rm -rf /" }, notify, context)).rejects.toThrow("安全规则");
  await expect(tools.execute("search_web", { query: "x" }, notify, context)).rejects.toThrow("未注册");
});

it("真实 Runtime 在独立进程完成双版本实验，保存完整证据并追加人工复核", async () => {
  const home = await directory();
  const provider = await startMockProvider({ plan: () => ({ toolCalls: [{ name: "get_current_time", input: {} }], reply: "2026年9月15日" }) });
  vi.stubEnv("EVALUATION_MODEL_API_KEY", "fixture-key");
  try {
    const plan = exampleEvaluationPlan(root); plan.repetitions = 1; plan.gate.minimumRepetitions = 1;
    for (const variant of [plan.baseline, plan.candidate]) for (const model of [variant.agent, variant.small]) { model.baseUrl = provider.baseUrl; model.model = "mock-agent"; model.inputUsdPerMillion = 1; model.outputUsdPerMillion = 2; }
    plan.dataset.cases[0]!.history = [{ prompt: "你好", reply: "你好" }];
    plan.dataset.cases[0]!.memory = [{ subject: "用户", content: "喜欢咖啡", source: "fixture" }];
    const service = createEvaluationService(home); const events: string[] = []; const off = service.subscribe((event) => events.push(event.type));
    const id = await service.start(plan);
    await expect(service.start(plan)).rejects.toThrow("正在运行");
    await service.wait();
    const result = await service.get(id);
    expect(result.error).toBeNull();
    expect(result.executions.map((e) => [e.status, e.error])).toEqual([["completed", null], ["completed", null]]);
    expect(result.report?.decision).toBe("passed");
    expect(result.report?.agentUsd).toBeGreaterThan(0);
    expect(result.codeHashes.baseline).toBe(result.codeHashes.candidate);
    expect(result.executions[0]?.evidence?.runIds).not.toEqual(result.executions[1]?.evidence?.runIds);
    expect(result.executions.every((e) => e.evidence?.traces.some((f) => f.records.some((r) => r.type === "run_started")))).toBe(true);
    expect((await service.list()).items).toHaveLength(1);
    expect((await service.events(id)).map((e) => e.type)).toEqual(events);
    expect(events[0]).toBe("experiment_started"); expect(events.at(-1)).toBe("experiment_completed");
    expect((await service.review(id, "current-time", "人工确认通过")).reviews).toHaveLength(1);
    expect(service.cancel(id)).toBe(false); off();
  } finally { await provider.close(); }
}, 30000);

it("DeepEval TypeScript 使用本地裁判返回分数与实际费用，无需 Python", async () => {
  vi.stubEnv("DEEPEVAL_TELEMETRY_OPT_OUT", "YES");
  vi.stubEnv("EVALUATION_MODEL_API_KEY", "fixture-key");
  const provider = await startMockProvider({ plan: () => ({ reply: '{"score":10,"reason":"满足预期"}' }) });
  try {
    const { scoreWithDeepEval } = await import("../index.ts");
    const c = exampleEvaluationPlan(root).dataset.cases[0]!; c.criteria = "回答是否符合预期";
    const result = await scoreWithDeepEval(c, evidence, { ...exampleEvaluationPlan(root).baseline.agent, baseUrl: provider.baseUrl, model: "mock-judge", inputUsdPerMillion: 1, outputUsdPerMillion: 1 }, 0.8, new AbortController().signal);
    expect(result.score.status).toBe("passed"); expect(result.score.score).toBe(1); expect(result.cost).toBeGreaterThan(0);
    const controller = new AbortController(); controller.abort();
    await expect(scoreWithDeepEval(c, evidence, { ...exampleEvaluationPlan(root).baseline.agent, baseUrl: provider.baseUrl }, 0.8, controller.signal)).rejects.toThrow();
  } finally { await provider.close(); }
});

it("取消保留中断报告，配置错误不会成为通过，非法实验路径被拒绝", async () => {
  vi.stubEnv("EVALUATION_MODEL_API_KEY", "fixture");
  const home = await directory(); const service = createEvaluationService(home);
  const plan = exampleEvaluationPlan(root);
  const id = await service.start(plan); expect(service.cancel(id)).toBe(true); await service.wait();
  expect((await service.get(id)).report?.decision).toBe("insufficient");
  expect((await service.get(id)).status).toBe("cancelled");
  await expect(service.get("../outside")).rejects.toThrow("ID");
  await expect(service.list(0)).rejects.toThrow("分页");
  await expect(service.review(id, "missing", "复核")).rejects.toThrow("无效");
});

it("配置边界拒绝无效字段，允许明确的搜索、审批与语义评分配置", () => {
  const plan = exampleEvaluationPlan(root);
  const mutations: ((p: typeof plan) => void)[] = [
    (p) => { p.name = ""; }, (p) => { p.dataset.cases = []; },
    (p) => { p.dataset.cases[0]!.id = "../bad"; }, (p) => { p.dataset.cases[0]!.critical = undefined as never; },
    (p) => { p.dataset.cases[0]!.turns = [""]; }, (p) => { p.dataset.cases[0]!.history = null as never; },
    (p) => { p.dataset.cases[0]!.memory = [{ subject: "", content: "a", source: "b" }]; },
    (p) => { p.dataset.cases[0]!.tools[0]!.name = "unknown" as never; },
    (p) => { delete (p.dataset.cases[0]!.tools[0] as { result?: unknown }).result; },
    (p) => { p.dataset.cases[0]!.tools[0]!.approval = "yes" as never; },
    (p) => { p.dataset.cases[0]!.assertions = [{ kind: "invalid" } as never]; },
    (p) => { p.dataset.cases[0]!.assertions = [{ kind: "tool_called", tool: "x", arguments: [] as never }]; },
    (p) => { p.baseline.sourceRoot = "relative"; }, (p) => { p.baseline.agent.provider = "unsupported" as never; },
    (p) => { p.baseline.agent.apiKeyEnv = "key-with-dash"; }, (p) => { p.baseline.agent.apiKeyEnv = "HOME"; },
    (p) => { p.baseline.agent.baseUrl = "file:///tmp"; }, (p) => { p.baseline.agent.inputUsdPerMillion = -1; },
    (p) => { p.baseline.maxTokens = p.baseline.modelContextWindow; }, (p) => { p.repetitions = 1.5; },
    (p) => { p.baseline.retrieval.mode = "bad" as never; }, (p) => { p.baseline.retrieval.mode = "hybrid"; },
    (p) => { p.baseline.retrieval.embedding = { ...p.baseline.agent, provider: "anthropic" }; },
    (p) => { p.baseline.skills = [{ name: "../bad", content: "x" }]; },
    (p) => { p.baseline.skills = [{ name: "one", content: "x" }, { name: "one", content: "y" }]; },
    (p) => { p.gate.judgeThreshold = NaN; },
  ];
  for (const mutate of mutations) { const copy = structuredClone(plan); mutate(copy); expect(() => validateEvaluationPlan(copy)).toThrow(); }
  plan.judge = plan.baseline.agent; plan.dataset.cases[0]!.criteria = "完成度";
  plan.dataset.cases[0]!.tools = [{ name: "search_web", arguments: { query: "查询" }, result: {}, files: { "result.txt": "内容" }, approval: true }];
  plan.dataset.cases[0]!.assertions = [{ kind: "file_equals", path: "result.txt", value: "" }, { kind: "memory_absent", value: "x" }, { kind: "tool_called", tool: "x", arguments: {} }];
  plan.baseline.retrieval.embedding = { ...plan.baseline.agent }; plan.baseline.retrieval.mode = "dense_only";
  plan.gate.maxAgentUsd = 1; plan.gate.maxJudgeUsd = 1;
  expect(validateEvaluationPlan(plan)).toEqual(plan);
});

it("工具参数边界和取消信号不能被固定环境绕过", async () => {
  const c = exampleEvaluationPlan(root).dataset.cases[0]!;
  c.tools = [{ name: "search_web", arguments: { query: "q" }, result: {} }, { name: "run_terminal", arguments: { command: "echo ok" }, result: {} }];
  const original = { schemas: () => [{ name: "local" }], execute: vi.fn(() => "local-result") };
  const tools = createFixtureTools(original, c, await directory()); const notify = vi.fn();
  const context = { signal: undefined, deadline: null, iteration: 1, toolUseId: "t" };
  for (const args of [null, [], { query: 1 }, { query: "q", max_results: 0 }, { query: "q", max_results: 11 }, { query: "q", max_results: 1.5 }]) await expect(tools.execute("search_web", args, notify, context)).rejects.toThrow();
  expect(await tools.execute("local", {}, notify, context)).toBe("local-result");
  await tools.execute("run_terminal", { command: "echo ok" }, notify, context);
  const controller = new AbortController(); controller.abort();
  await expect(tools.execute("search_web", { query: "q" }, notify, { ...context, signal: controller.signal })).rejects.toThrow();
});
