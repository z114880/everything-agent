import { mkdir, readFile, writeFile, cp, realpath, stat } from "node:fs/promises";
import { join, dirname, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentRuntime } from "../agent-runtime/index.ts";
import { readTraceFiles } from "../tracing/jsonl-tracer.ts";
import { createFixtureTools } from "./fixtures.ts";
import { scoreAssertions } from "./scoring.ts";
import { redactExecution } from "./redaction.ts";
import { writeJson } from "./storage.ts";
import type { EvaluationCase, EvaluationEvidence, EvaluationExecution, EvaluationConfiguration } from "./types.ts";

export interface WorkerInput { directory: string; codeRoot: string; seed: string; sessionId: string; testCase: EvaluationCase; configuration: EvaluationConfiguration; timeoutMs: number; denyRead: string[]; execution: EvaluationExecution }

/** 每个用例在独立进程和数据目录内执行；只有环境变量中的模型凭证进入临时配置。 */
export async function executeEvaluationWorker(input: WorkerInput, signal: AbortSignal): Promise<EvaluationExecution> {
  const { directory, testCase, configuration: settings } = input;
  const started = performance.now();
  const home = join(directory, "home"); const workspace = join(home, "sandbox");
  await cp(input.seed, home, { recursive: true }); await mkdir(workspace, { recursive: true });
  const runtimeModule = await import(pathToFileURL(join(input.codeRoot, "src/agent-runtime/index.ts")).href) as typeof import("../agent-runtime/index.ts");
  if (runtimeModule.AGENT_RUNTIME_HOST_PROTOCOL !== 1) throw new Error("当前 Runtime 未提供受控宿主接口");
  await writeJson(join(home, "config.json"), {
    models: { agent: settings.agent, small: settings.small },
    maxIterations: settings.maxIterations, maxTokens: settings.maxTokens, modelContextWindow: settings.modelContextWindow,
    retrieval: { mode: settings.retrieval.mode, embedding: settings.retrieval.embedding ? { ...settings.retrieval.embedding, minimumSimilarity: settings.retrieval.minimumSimilarity, queryTemplate: "{text}", documentTemplate: "{text}" } : {} },
    tools: { getCurrentTimeEnabled: false, searchWebEnabled: false, runTerminalEnabled: false }, sandbox: { workspaceRoot: workspace },
  });
  const secrets = [`EVERYTHING_AGENT_API_KEY=${process.env[settings.agent.apiKeyEnv] ?? ""}`, `EVERYTHING_SMALL_API_KEY=${process.env[settings.small.apiKeyEnv] ?? ""}`];
  if (settings.retrieval.embedding) secrets.push(`EVERYTHING_EMBEDDING_API_KEY=${process.env[settings.retrieval.embedding.apiKeyEnv] ?? ""}`);
  if (secrets.some((line) => /[\r\n]/.test(line))) throw new Error("模型凭证格式无效");
  await writeFile(join(home, ".env"), secrets.join("\n"), { mode: 0o600 });
  await writeFile(join(home, "EVERYTHING.md"), settings.systemPrompt);
  for (const skill of settings.skills) { const dir = join(home, "skills", skill.name); await mkdir(dir, { recursive: true }); await writeFile(join(dir, "SKILL.md"), skill.content); }
  for (const [path, content] of Object.entries(testCase.files)) { const target = join(workspace, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, content); }
  const usageEvents: { model: string; purpose: string; tokenUsage: { inputTokens: number; outputTokens: number } | null }[] = [];
  const runtime: AgentRuntime = runtimeModule.createAgentRuntime({ home, defaultSystemPromptPath: join(home, "EVERYTHING.md") }, { automaticConsolidation: false, onModelUsage: (event) => usageEvents.push(event), configureTools: (tools) => createFixtureTools(tools, testCase, workspace, input.denyRead) });
  const evidence: EvaluationEvidence = { complete: false, replies: [], memory: [], files: {}, traces: [], toolCalls: [], runIds: [], derivedTaskIds: [], responseMs: 0, totalMs: 0, agentUsd: null, modelCalls: 0, usage: [] };
  const execution = input.execution;
  try {
    await runtime.start();
    if (settings.retrieval.mode !== "lexical_only") await runtime.rebuildEmbeddingIndex();
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
    // 临时模型凭证不进入可回放的评估归档。
    await writeFile(join(home, ".env"), "# 凭证已清除\n", { mode: 0o600 });
  }
  evidence.traces = await readTraceFiles(home);
  evidence.toolCalls = evidence.traces.flatMap((file) => file.records).filter((record) => record.type === "tool_completed" || record.type === "tool_failed").map((record) => ({ tool: String(record.payload?.tool), arguments: record.payload?.arguments, isError: record.type === "tool_failed" || record.payload?.isError === true }));
  for (const path of new Set([...Object.keys(testCase.files), ...testCase.tools.flatMap((t) => Object.keys(t.files ?? {})), ...testCase.assertions.flatMap((a) => a.kind === "file_equals" ? [a.path] : [])])) {
    try {
      const actual = await realpath(join(workspace, path)); const rel = relative(await realpath(workspace), actual);
      if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("评估产物不能指向工作区外部");
      if ((await stat(actual)).size > 1_000_000) throw new Error("评估产物超过 1MB");
      evidence.files[path] = await readFile(actual, "utf8");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  evidence.modelCalls = usageEvents.length;
  evidence.usage = usageEvents.map((event) => ({ purpose: event.purpose, model: event.model, inputTokens: event.tokenUsage?.inputTokens ?? null, outputTokens: event.tokenUsage?.outputTokens ?? null }));
  // 未配置供应商价格时显示未知，不影响任务质量结论。
  evidence.agentUsd = null;
  for (const record of evidence.traces.flatMap(file => file.records).filter(record => record.type === "embedding_completed" || record.type === "embedding_failed")) {
    const tokens = record.payload?.tokenUsage as { inputTokens: number } | null | undefined;
    evidence.usage.push({ purpose: "embedding", model: settings.retrieval.embedding?.model ?? "", inputTokens: tokens?.inputTokens ?? null, outputTokens: tokens ? 0 : null });
  }
  evidence.totalMs = Math.round(performance.now() - started);
  evidence.complete = true;
  execution.evidence = evidence;
  execution.scores = scoreAssertions(testCase, evidence);
  const result = redact(execution);
  await writeJson(join(directory, "execution.json"), result);
  return result;

  function redact(value: EvaluationExecution): EvaluationExecution {
    const credentials = [settings.agent, settings.small, settings.retrieval.embedding].flatMap((connection) => connection && process.env[connection.apiKeyEnv] ? [process.env[connection.apiKeyEnv]!] : []);
    return redactExecution(value, credentials);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.once("message", (input: WorkerInput) => {
    const controller = new AbortController();
    process.once("disconnect", () => controller.abort());
    process.on("message", (message: unknown) => { if (message === "cancel") controller.abort(); });
    void executeEvaluationWorker(input, controller.signal).then((result) => { process.send?.({ result }); process.disconnect?.(); }).catch(() => { process.send?.({ error: "执行进程失败，请检查源码版本、配置和隔离环境" }); process.disconnect?.(); process.exitCode = 1; });
  });
}
