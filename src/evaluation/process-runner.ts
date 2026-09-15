import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import type { WorkerInput } from "./worker.ts";
import type { EvaluationExecution } from "./types.ts";
import { readTraceFiles } from "../tracing/jsonl-tracer.ts";

/** 在隔离 Node 进程中运行一个任务；截止后强制结束并保留已落盘的执行证据。 */
export async function runEvaluationProcess(input: WorkerInput, signal: AbortSignal): Promise<EvaluationExecution> {
  const started = performance.now();
  const result = await new Promise<EvaluationExecution>((resolve) => {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: input.directory, TMPDIR: input.directory, TZ: "UTC", DEEPEVAL_TELEMETRY_OPT_OUT: "YES", CONFIDENT_API_KEY: "" };
    for (const model of [input.variant.agent, input.variant.small, input.variant.retrieval.embedding, input.plan.judge]) if (model) env[model.apiKeyEnv] = process.env[model.apiKeyEnv];
    const child = fork(fileURLToPath(new URL("./worker.ts", import.meta.url)), [], { cwd: input.directory, env, execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] });
    let received: EvaluationExecution | undefined; let stop: "cancelled" | "timed_out" | null = null;
    const cancel = () => { stop = "cancelled"; child.kill("SIGKILL"); };
    const timer = setTimeout(() => { stop = "timed_out"; child.kill("SIGKILL"); }, input.plan.timeoutMs);
    signal.addEventListener("abort", cancel, { once: true });
    child.on("message", (message: { result?: EvaluationExecution }) => { if (message.result) received = message.result; });
    child.on("error", () => { received = { ...input.execution, status: "failed", error: "无法启动执行进程" }; });
    child.on("close", () => {
      clearTimeout(timer); signal.removeEventListener("abort", cancel);
      resolve(stop ? { ...input.execution, status: stop, error: stop === "cancelled" ? "实验已取消" : "执行或评分超过总时限" } : received ?? { ...input.execution, status: "failed", error: "执行进程异常退出" });
    });
    if (signal.aborted) cancel(); else child.send(input);
  });
  if (!result.evidence) {
    try { const saved = JSON.parse(await readFile(join(input.directory, "execution.json"), "utf8")) as EvaluationExecution; result.evidence = saved.evidence; result.scores = saved.scores; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  if (!result.evidence) {
    const traces = await readTraceFiles(join(input.directory, "home"));
    if (traces.length) result.evidence = { complete: false, traces, replies: [], memory: [], files: {}, toolCalls: [], runIds: [...new Set(traces.flatMap((f) => f.records.map((r) => r.runId)))], derivedTaskIds: [], responseMs: 0, totalMs: Math.round(performance.now() - started), agentUsd: null, modelCalls: 0, usage: [] };
  }
  // SIGKILL 不能执行 finally，由父进程清理临时凭证。
  try { await writeFile(join(input.directory, "home", ".env"), "# 凭证已清除\n", { mode: 0o600 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return result;
}
