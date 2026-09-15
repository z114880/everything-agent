import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { executeEvaluationWorker, exampleEvaluationPlan, type WorkerInput } from "../index.ts";
import { MemoryRuntime } from "../../memory/index.ts";
import { startMockProvider } from "../../../mock-data/mock-provider.ts";

const directories: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });

it("单次执行接口保留真实记忆与文件、统计索引成本，并记录裁判错误", async () => {
  vi.stubEnv("EVALUATION_MODEL_API_KEY", "fixture"); vi.stubEnv("DEEPEVAL_TELEMETRY_OPT_OUT", "YES");
  const directory = await mkdtemp(join(tmpdir(), "evaluation-worker-")); directories.push(directory);
  const provider = await startMockProvider({ plan: () => ({ reply: "完成" }) });
  try {
    const seed = join(directory, "seed"); await mkdir(seed);
    const memory = new MemoryRuntime(seed); const session = memory.createSession(); await memory.createSemantic("用户", "喜欢咖啡", "fixture"); memory.close();
    const root = fileURLToPath(new URL("../../../", import.meta.url)); const plan = exampleEvaluationPlan(root);
    plan.baseline.agent.baseUrl = provider.baseUrl; plan.baseline.agent.model = "mock-agent";
    plan.baseline.small.baseUrl = provider.baseUrl; plan.baseline.small.model = "mock-small";
    plan.baseline.agent.inputUsdPerMillion = 0; plan.baseline.agent.outputUsdPerMillion = 0;
    plan.baseline.retrieval = { mode: "hybrid", minimumSimilarity: 0, embedding: { ...plan.baseline.agent, model: "mock-embedding" } };
    plan.judge = { ...plan.baseline.agent };
    const testCase = plan.dataset.cases[0]!;
    testCase.criteria = "评价是否完成"; testCase.files = { "out/result.txt": "完成" };
    testCase.assertions = [{ kind: "file_equals", path: "out/result.txt", value: "完成" }, { kind: "file_equals", path: "missing.txt", value: "x" }];
    plan.baseline.skills = [{ name: "test", content: "---\nname: test\ndescription: 示例过程\n---\n示例正文" }];
    const input: WorkerInput = { directory: join(directory, "run"), seed, sessionId: session.id, codeRoot: root, testCase, variant: plan.baseline, plan, execution: { id: "run", caseId: testCase.id, variant: "baseline", repetition: 1, status: "failed", error: null, evidence: null, scores: [], judgeUsd: null } };
    await mkdir(input.directory);
    const result = await executeEvaluationWorker(input, new AbortController().signal);
    expect(result.status).toBe("completed");
    expect(result.evidence?.files["out/result.txt"]).toBe("完成");
    expect(result.evidence?.memory[0]?.content).toBe("喜欢咖啡");
    expect(result.evidence?.agentUsd).toBe(0);
    expect(result.scores.at(-1)?.status).toBe("error");
    expect(await readFile(join(input.directory, "home/.env"), "utf8")).not.toContain("fixture");
  } finally { await provider.close(); }
}, 20000);

it("失败与取消仍保留可读证据，缺少模型价格不会报告零成本", async () => {
  vi.stubEnv("EVALUATION_MODEL_API_KEY", "fixture");
  const directory = await mkdtemp(join(tmpdir(), "evaluation-failure-")); directories.push(directory);
  const provider = await startMockProvider({ plan: () => ({ toolCalls: [{ name: "get_current_time", input: {} }], reply: "完成" }) });
  try {
    const seed = join(directory, "seed"); await mkdir(seed); const memory = new MemoryRuntime(seed); const session = memory.createSession(); memory.close();
    const root = fileURLToPath(new URL("../../../", import.meta.url)); const plan = exampleEvaluationPlan(root);
    plan.baseline.agent.baseUrl = provider.baseUrl; plan.baseline.small.baseUrl = provider.baseUrl; plan.baseline.maxIterations = 1;
    const testCase = plan.dataset.cases[0]!;
    for (const aborted of [false, true]) {
      const input: WorkerInput = { directory: join(directory, String(aborted)), seed, sessionId: session.id, codeRoot: root, testCase, variant: plan.baseline, plan, execution: { id: "run", caseId: testCase.id, variant: "baseline", repetition: 1, status: "failed", error: null, evidence: null, scores: [], judgeUsd: null } };
      await mkdir(input.directory); const controller = new AbortController(); if (aborted) controller.abort();
      const result = await executeEvaluationWorker(input, controller.signal);
      expect(result.status).toBe(aborted ? "cancelled" : "failed");
      expect(result.evidence).not.toBeNull();
      if (!aborted) expect(result.evidence?.agentUsd).toBeNull();
    }
  } finally { await provider.close(); }
}, 20000);
