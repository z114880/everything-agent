import { mkdir, mkdtemp, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { executeEvaluationWorker, emptyEvaluationCase, createFixtureTools, type WorkerInput, type EvaluationConfiguration } from "../index.ts";
import { MemoryRuntime } from "../../memory/index.ts";
import { startMockProvider } from "../../../mock-data/mock-provider.ts";

const directories: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(directories.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function input(baseUrl: string): Promise<WorkerInput> {
  vi.stubEnv("EVALUATION_TEST_KEY", "fixture-model-secret"); vi.stubEnv("LANGFUSE_ENABLED", "false");
  const directory = await mkdtemp(join(tmpdir(), "evaluation-worker-")); directories.push(directory);
  const seed = join(directory, "seed"); await mkdir(seed);
  const memory = new MemoryRuntime(seed); const session = memory.createSession(); await memory.createSemantic("用户", "喜欢咖啡", "fixture"); memory.close();
  const model = { provider: "openai-compatible" as const, model: "mock-agent", baseUrl, apiKeyEnv: "EVALUATION_TEST_KEY" };
  const configuration: EvaluationConfiguration = { agent: model, small: { ...model, model: "mock-small" }, systemPrompt: "你是个人助理", maxIterations: 10, maxTokens: 2048, modelContextWindow: 32768, skills: [{ name: "test", content: "---\nname: test\ndescription: 示例过程\n---\n示例正文" }], retrieval: { mode: "hybrid", minimumSimilarity: 0, embedding: { ...model, model: "mock-embedding" } } };
  const testCase = { ...emptyEvaluationCase("case"), turns: ["完成任务"], files: { "out/result.txt": "完成" }, assertions: [{ kind: "file_equals" as const, path: "out/result.txt", value: "完成" }, { kind: "file_equals" as const, path: "missing.txt", value: "x" }] };
  const result: WorkerInput = { directory: join(directory, "run"), seed, sessionId: session.id, codeRoot: resolve("."), testCase, configuration, timeoutMs: 3000, denyRead: [], execution: { id: "execution", datasetId: "dataset", caseId: "case", status: "failed", error: null, evidence: null, scores: [], traceId: "trace", observationId: "observation", traceUrl: null, sync: "pending" } };
  await mkdir(result.directory); return result;
}
it("真实 Runtime 采集记忆、文件与向量用量，敏感凭证从结果及临时文件移除", async () => {
  const provider = await startMockProvider({ plan: () => ({ reply: "完成 fixture-model-secret" }) });
  try {
    const value = await input(provider.baseUrl);
    const result = await executeEvaluationWorker(value, new AbortController().signal);
    expect(result.status).toBe("completed"); expect(result.evidence?.complete).toBe(true);
    expect(result.evidence?.memory[0]?.content).toBe("喜欢咖啡"); expect(result.evidence?.files).toEqual({ "out/result.txt": "完成" });
    expect(result.evidence?.usage.some(u => u.purpose === "embedding")).toBe(true); expect(result.evidence?.agentUsd).toBeNull();
    expect(result.scores.map(s => s.status)).toEqual(["passed", "failed"]);
    expect(JSON.stringify(result)).not.toContain("fixture-model-secret"); expect(await readFile(join(value.directory, "home/.env"), "utf8")).not.toContain("fixture-model-secret");
  } finally { await provider.close(); }
}, 20000);
it("迭代上限和预先取消产生明确状态，仍保留完整证据", async () => {
  const provider = await startMockProvider({ plan: () => ({ toolCalls: [{ name: "get_current_time", input: {} }], reply: "完成" }) });
  try {
    for (const aborted of [false, true]) {
      const value = await input(provider.baseUrl); value.configuration.retrieval = { mode: "lexical_only", embedding: null, minimumSimilarity: 0 };
      value.configuration.maxIterations = 1; value.testCase.tools = [{ name: "get_current_time", arguments: {}, result: { iso: "2026-09-16" } }];
      const controller = new AbortController(); if (aborted) controller.abort();
      const result = await executeEvaluationWorker(value, controller.signal);
      expect(result.status).toBe(aborted ? "cancelled" : "failed"); expect(result.evidence).not.toBeNull();
      if (!aborted) expect(result.error).toContain("迭代上限");
    }
  } finally { await provider.close(); }
}, 20000);
it("唯一代码能力在真实无网络沙箱执行并验收文件，不使用模拟产物", async () => {
  const command = "printf 'printf \"买咖啡\\\\n预约体检\\\\n\" > plan.txt\\n' > organize.sh && /bin/sh organize.sh";
  const provider = await startMockProvider({ plan: () => ({ toolCalls: [{ name: "run_terminal", input: { command } }], reply: "完成" }) });
  try {
    const value = await input(provider.baseUrl); value.configuration.retrieval = { mode: "lexical_only", embedding: null, minimumSimilarity: 0 };
    value.testCase.terminal = true; value.testCase.assertions = [{ kind: "file_equals", path: "plan.txt", value: "买咖啡\n预约体检\n" }];
    const result = await executeEvaluationWorker(value, new AbortController().signal);
    expect(result.evidence?.files["plan.txt"]).toBe("买咖啡\n预约体检\n"); expect(result.scores[0]?.status).toBe("passed");
    expect(result.evidence?.toolCalls.some(c => c.tool === "run_terminal" && !c.isError)).toBe(true);
  } finally { await provider.close(); }
}, 20000);
it("真实终端拒绝越界写入，读取评估凭证与失败命令不会被当作成功调用", async () => {
  const directory = await mkdtemp(join(tmpdir(), "evaluation-terminal-")); directories.push(directory);
  const workspace = join(directory, "sandbox"); await mkdir(workspace); await writeFile(join(directory, ".env"), "secret");
  const tools = createFixtureTools({ schemas: () => [], execute: vi.fn() }, { ...emptyEvaluationCase(), terminal: true }, workspace);
  const context = { signal: undefined, deadline: null, iteration: 1, toolUseId: "tool" };
  await expect(tools.execute("run_terminal", { command: "printf ok > inside.txt" }, vi.fn(), context)).resolves.toMatchObject({ exitCode: 0 });
  for (const command of ["printf bad > ../outside.txt", "cat ../.env", "exit 1"]) await expect(tools.execute("run_terminal", { command }, vi.fn(), context)).rejects.toThrow("终端执行失败");
});
it("模拟终端保留审批审计、精确匹配和参数校验", async () => {
  const directory = await mkdtemp(join(tmpdir(), "evaluation-fixtures-")); directories.push(directory);
  const original = { schemas: () => [{ name: "search_web" }], execute: vi.fn() };
  const testCase = { ...emptyEvaluationCase(), tools: [{ name: "run_terminal" as const, arguments: { command: "git push" }, approval: false, result: {}, files: { "out.txt": "完成" } }] };
  const tools = createFixtureTools(original, testCase, directory); const notify = vi.fn(); const context = { signal: undefined, deadline: null, iteration: 1, toolUseId: "tool" };
  expect(tools.schemas()).toHaveLength(1);
  await expect(tools.execute("run_terminal", { command: "git push" }, notify, context)).rejects.toThrow("拒绝");
  expect(notify.mock.calls.map(c => c[0])).toEqual(["approval_requested", "approval_resolved"]);
  testCase.tools[0]!.approval = true;
  await tools.execute("run_terminal", { command: "git push" }, notify, context); expect(await readFile(join(directory, "out.txt"), "utf8")).toBe("完成");
  for (const args of [null, {}, { command: 1 }, { command: "" }, { command: "x", timeout_ms: 2 }, { command: "x", timeout_ms: 1000.5 }, { command: "x", other: true }, { command: "x", workdir: "../escape" }, { command: "different" }]) await expect(tools.execute("run_terminal", args, notify, context)).rejects.toThrow();
  testCase.tools[0]!.arguments.command = "rm -rf /"; await expect(tools.execute("run_terminal", { command: "rm -rf /" }, notify, context)).rejects.toThrow("安全规则");
});
it("产物符号链接不能把工作区外的数据读进报告", async () => {
  const provider = await startMockProvider({ plan: () => ({ reply: "完成" }) });
  try {
    const value = await input(provider.baseUrl); await mkdir(join(value.seed, "sandbox"));
    await symlink("/etc/hosts", join(value.seed, "sandbox", "outside.txt"));
    value.testCase.assertions = [{ kind: "file_equals", path: "outside.txt", value: "x" }];
    await expect(executeEvaluationWorker(value, new AbortController().signal)).rejects.toThrow("工作区外部");
    expect(await readFile(join(value.directory, "home/.env"), "utf8")).not.toContain("fixture-model-secret");
  } finally { await provider.close(); }
}, 20000);
