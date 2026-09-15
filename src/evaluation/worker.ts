import { mkdir, readFile, writeFile, cp } from "node:fs/promises";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentRuntime } from "../agent-runtime/index.ts";
import { readTraceFiles } from "../tracing/jsonl-tracer.ts";
import { createFixtureTools } from "./fixtures.ts";
import { scoreWithDeepEval } from "./deepeval.ts";
import { scoreAssertions } from "./scoring.ts";
import { writeJson } from "./storage.ts";
import type { EvaluationCase, EvaluationEvidence, EvaluationExecution, EvaluationPlan, EvaluationVariant } from "./types.ts";

export interface WorkerInput { directory: string; codeRoot: string; seed: string; sessionId: string; testCase: EvaluationCase; variant: EvaluationVariant; plan: EvaluationPlan; execution: EvaluationExecution }

/** 每个用例在独立进程和数据目录内执行；只有环境变量中的模型凭证进入临时配置。 */
export async function executeEvaluationWorker(input: WorkerInput, signal: AbortSignal): Promise<EvaluationExecution> {
  const { directory, testCase, variant } = input;
  const started = performance.now();
  const home = join(directory, "home"); const workspace = join(home, "sandbox");
  await cp(input.seed, home, { recursive: true }); await mkdir(workspace, { recursive: true });
  const runtimeModule = await import(pathToFileURL(join(input.codeRoot, "src/agent-runtime/index.ts")).href) as typeof import("../agent-runtime/index.ts");
  if (runtimeModule.AGENT_RUNTIME_HOST_PROTOCOL !== 1) throw new Error("所选版本未提供受控宿主接口，请选择支持评估环境注入的代码版本");
  await writeJson(join(home, "config.json"), {
    models: { agent: variant.agent, small: variant.small },
    maxIterations: variant.maxIterations, maxTokens: variant.maxTokens, modelContextWindow: variant.modelContextWindow,
    retrieval: { mode: variant.retrieval.mode, embedding: variant.retrieval.embedding ? { ...variant.retrieval.embedding, minimumSimilarity: variant.retrieval.minimumSimilarity, queryTemplate: "{text}", documentTemplate: "{text}" } : {} },
    tools: { getCurrentTimeEnabled: false, searchWebEnabled: false, runTerminalEnabled: false }, sandbox: { workspaceRoot: workspace },
  });
  const secrets = [`EVERYTHING_AGENT_API_KEY=${process.env[variant.agent.apiKeyEnv] ?? ""}`, `EVERYTHING_SMALL_API_KEY=${process.env[variant.small.apiKeyEnv] ?? ""}`];
  if (variant.retrieval.embedding) secrets.push(`EVERYTHING_EMBEDDING_API_KEY=${process.env[variant.retrieval.embedding.apiKeyEnv] ?? ""}`);
  if (secrets.some((line) => /[\r\n]/.test(line))) throw new Error("模型凭证格式无效");
  await writeFile(join(home, ".env"), secrets.join("\n"), { mode: 0o600 });
  await writeFile(join(home, "EVERYTHING.md"), variant.systemPrompt);
  for (const skill of variant.skills) { const dir = join(home, "skills", skill.name); await mkdir(dir, { recursive: true }); await writeFile(join(dir, "SKILL.md"), skill.content); }
  for (const [path, content] of Object.entries(testCase.files)) { const target = join(workspace, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, content); }
  const usageEvents: { model: string; purpose: string; tokenUsage: { inputTokens: number; outputTokens: number } | null }[] = [];
  const runtime: AgentRuntime = runtimeModule.createAgentRuntime({ home, defaultSystemPromptPath: join(home, "EVERYTHING.md") }, { automaticConsolidation: false, onModelUsage: (event) => usageEvents.push(event), configureTools: (tools) => createFixtureTools(tools, testCase, workspace) });
  const evidence: EvaluationEvidence = { complete: false, replies: [], memory: [], files: {}, traces: [], toolCalls: [], runIds: [], derivedTaskIds: [], responseMs: 0, totalMs: 0, agentUsd: null, modelCalls: 0, usage: [] };
  const execution = input.execution;
  try {
    await runtime.start();
    if (variant.retrieval.mode !== "lexical_only") await runtime.rebuildEmbeddingIndex();
    for (const prompt of testCase.turns) {
      signal.throwIfAborted();
      const result = await runtime.run({ sessionId: input.sessionId, prompt }, { signal, observer: async () => {} });
      evidence.replies.push(result.reply); evidence.runIds.push(result.runId); evidence.derivedTaskIds.push(...result.derivedTaskIds); evidence.responseMs += result.ms;
      evidence.traces = await runtime.readTraces();
      execution.evidence = evidence;
      await writeJson(join(directory, "execution.json"), redact(execution));
      await runtime.memory.waitForBackgroundTasks();
      const tasks = runtime.memory.listBackgroundTasks().filter((task) => result.derivedTaskIds.includes(task.id));
      if (tasks.some((task) => task.status !== "completed")) throw new Error("关联后台记忆任务未成功完成");
      if (result.stopReason === "max_iterations") throw new Error("Agent 达到迭代上限");
    }
    execution.status = "completed";
  } catch (error) { execution.status = signal.aborted ? "cancelled" : "failed"; execution.error = error instanceof Error ? error.message : String(error); }
  finally {
    await runtime.memory.waitForBackgroundTasks();
    evidence.memory = runtime.memory.listSemantic().map(({ subject, content }) => ({ subject, content }));
    await runtime.close();
    // 临时模型凭证不进入可回放的实验归档。
    await writeFile(join(home, ".env"), "# 凭证已清除\n", { mode: 0o600 });
  }
  evidence.traces = await readTraceFiles(home);
  evidence.toolCalls = evidence.traces.flatMap((file) => file.records).filter((record) => record.type === "tool_completed" || record.type === "tool_failed").map((record) => ({ tool: String(record.payload?.tool), arguments: record.payload?.arguments, isError: record.type === "tool_failed" || record.payload?.isError === true }));
  for (const path of new Set([...Object.keys(testCase.files), ...testCase.tools.flatMap((t) => Object.keys(t.files ?? {})), ...testCase.assertions.flatMap((a) => a.kind === "file_equals" ? [a.path] : [])])) {
    try { evidence.files[path] = await readFile(join(workspace, path), "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  evidence.modelCalls = usageEvents.length;
  evidence.usage = usageEvents.map((event) => ({ purpose: event.purpose, model: event.model, inputTokens: event.tokenUsage?.inputTokens ?? null, outputTokens: event.tokenUsage?.outputTokens ?? null }));
  evidence.agentUsd = 0;
  for (const event of usageEvents) {
    const connection = event.purpose === "small" ? variant.small : variant.agent;
    if (!event.tokenUsage || connection.inputUsdPerMillion === undefined || connection.outputUsdPerMillion === undefined) { evidence.agentUsd = null; break; }
    evidence.agentUsd += (event.tokenUsage.inputTokens * connection.inputUsdPerMillion + event.tokenUsage.outputTokens * connection.outputUsdPerMillion) / 1e6;
  }
  for (const record of evidence.traces.flatMap((file) => file.records).filter((record) => record.type === "embedding_completed" || record.type === "embedding_failed")) {
    const tokens = record.payload?.tokenUsage as { inputTokens: number } | null | undefined;
    const price = variant.retrieval.embedding?.inputUsdPerMillion;
    evidence.usage.push({ purpose: "embedding", model: variant.retrieval.embedding?.model ?? "", inputTokens: tokens?.inputTokens ?? null, outputTokens: tokens ? 0 : null });
    if (record.type === "embedding_failed" || !tokens || price === undefined) evidence.agentUsd = null;
    else if (evidence.agentUsd !== null) evidence.agentUsd += tokens.inputTokens * price / 1e6;
  }
  evidence.totalMs = Math.round(performance.now() - started);
  evidence.complete = true;
  execution.evidence = evidence;
  execution.scores = scoreAssertions(testCase, evidence);
  execution.judgeUsd = testCase.criteria ? null : 0;
  await writeJson(join(directory, "execution.json"), redact(execution));
  if (testCase.criteria && input.plan.judge && execution.status === "completed") {
    try {
      const result = await scoreWithDeepEval(testCase, evidence, input.plan.judge, input.plan.gate.judgeThreshold, signal);
      execution.scores.push(result.score); execution.judgeUsd = result.cost;
    } catch { execution.scores.push({ name: "deepeval:GEval", status: "error", score: null, reason: "评分器执行失败，请检查裁判连接与规则" }); }
  }
  const result = redact(execution);
  await writeJson(join(directory, "execution.json"), result);
  return result;

  function redact(value: EvaluationExecution): EvaluationExecution {
    const credentials = [variant.agent, variant.small, variant.retrieval.embedding, input.plan.judge].flatMap((connection) => connection && process.env[connection.apiKeyEnv] ? [process.env[connection.apiKeyEnv]!] : []);
    function clean(item: unknown): unknown {
      if (typeof item === "string") return credentials.reduce((text, credential) => text.replaceAll(credential, "[凭证已移除]"), item);
      if (Array.isArray(item)) return item.map(clean);
      if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, clean(child)]));
      return item;
    }
    return clean(value) as EvaluationExecution;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.once("message", (input: WorkerInput) => {
    const controller = new AbortController();
    process.on("message", (message: unknown) => { if (message === "cancel") controller.abort(); });
    void executeEvaluationWorker(input, controller.signal).then((result) => { process.send?.({ result }); process.disconnect?.(); }).catch(() => { process.send?.({ error: "执行进程失败，请检查源码版本、配置和隔离环境" }); process.disconnect?.(); process.exitCode = 1; });
  });
}
