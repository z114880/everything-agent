import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { MemoryRuntime } from "../memory/index.ts";
import { validateEvaluationPlan } from "./validation.ts";
import { compareEvaluations } from "./scoring.ts";
import { hash, idPath, listExperiments, readExperiment, saveExperiment, snapshotCode, writeJson } from "./storage.ts";
import { runEvaluationProcess } from "./process-runner.ts";
import type { EvaluationEvent, EvaluationExperiment, EvaluationExecution } from "./types.ts";

/** 本地评估服务。独立目录保存实验；同一实例串行调度，调用方可取消和等待。 */
export function createEvaluationService(home: string) {
  let active: { id: string; controller: AbortController; promise: Promise<void> } | null = null;
  const observers = new Set<(event: EvaluationEvent) => void>();

  async function emit(experiment: EvaluationExperiment, type: string, sequence: number, executionId?: string) {
    const event: EvaluationEvent = { experimentId: experiment.id, timestamp: new Date().toISOString(), sequence, type, ...(executionId ? { executionId } : {}) };
    await appendFile(join(idPath(home, experiment.id), "events.jsonl"), `${JSON.stringify(event)}\n`, { mode: 0o600 });
    for (const observer of observers) observer(event);
  }
  async function execute(experiment: EvaluationExperiment, signal: AbortSignal) {
    const directory = idPath(home, experiment.id); let sequence = 0;
    try {
      experiment.status = "running"; await saveExperiment(home, experiment); await emit(experiment, "experiment_started", ++sequence);
      for (const side of ["baseline", "candidate"] as const) {
        signal.throwIfAborted(); experiment.codeHashes[side] = await snapshotCode(experiment.plan[side].sourceRoot, join(directory, "code", side));
      }
      experiment.fingerprint = hash({ plan: experiment.plan, code: experiment.codeHashes, scorer: experiment.scorerVersion });
      await writeJson(join(directory, "manifest.json"), { fingerprint: experiment.fingerprint, codeHashes: experiment.codeHashes, plan: experiment.plan, scorerVersion: experiment.scorerVersion });
      for (const testCase of experiment.plan.dataset.cases) {
        signal.throwIfAborted();
        const seed = join(directory, "seeds", testCase.id); await mkdir(seed, { recursive: true });
        const memory = new MemoryRuntime(seed); let sessionId: string;
        try {
          for (const fact of testCase.memory) await memory.createSemantic(fact.subject, fact.content, fact.source);
          const session = memory.createSession("评估初始会话"); sessionId = session.id;
          for (const [index, turn] of testCase.history.entries()) {
            const runId = `seed-${index}`; memory.startRun(session.id, runId, turn.prompt);
            await memory.completeRun(session.id, runId, [{ role: "user", content: turn.prompt }, { role: "assistant", content: [{ type: "text", text: turn.reply }] }]);
          }
        } finally { memory.close(); }
        for (let repetition = 1; repetition <= experiment.plan.repetitions; repetition++) {
          // 交错先后顺序，避免一侧总处于供应商冷启动或高负载时段。
          const sides = repetition % 2 ? ["baseline", "candidate"] as const : ["candidate", "baseline"] as const;
          for (const variant of sides) {
            signal.throwIfAborted();
            const execution: EvaluationExecution = { id: `${testCase.id}-${variant}-${repetition}`, caseId: testCase.id, variant, repetition, status: "failed", error: null, evidence: null, scores: [], judgeUsd: null };
            const runDirectory = join(directory, "executions", execution.id); await mkdir(runDirectory, { recursive: true });
            await emit(experiment, "execution_started", ++sequence, execution.id);
            const result = await runEvaluationProcess({ directory: runDirectory, codeRoot: join(directory, "code", variant), seed, sessionId, testCase, variant: experiment.plan[variant], plan: experiment.plan, execution }, signal);
            await writeJson(join(runDirectory, "execution.json"), result);
            experiment.executions.push(result);
            experiment.report = compareEvaluations(experiment.plan, experiment.executions);
            await saveExperiment(home, experiment); await emit(experiment, "execution_completed", ++sequence, execution.id);
            if (budgetExceeded(experiment)) throw new Error("已达到实验预算门槛，停止后续执行");
          }
        }
      }
      experiment.status = "completed";
    } catch (error) {
      experiment.status = signal.aborted ? "cancelled" : "failed";
      experiment.error = signal.aborted ? "实验已取消" : error instanceof Error ? error.message : String(error);
    } finally {
      experiment.report = compareEvaluations(experiment.plan, experiment.executions);
      if (experiment.status !== "completed" && experiment.report.decision === "passed") { experiment.report.decision = "insufficient"; experiment.report.reasons.push("实验未正常结束"); }
      await saveExperiment(home, experiment); await emit(experiment, `experiment_${experiment.status}`, ++sequence);
    }
  }

  return {
    /** 校验并持久化实验后立即返回 ID，执行进度通过事件与详情查询获得。 */
    async start(value: unknown): Promise<string> {
      if (active) throw new Error("已有评估实验正在运行");
      const plan = validateEvaluationPlan(value);
      for (const model of [plan.baseline.agent, plan.baseline.small, plan.baseline.retrieval.embedding, plan.candidate.agent, plan.candidate.small, plan.candidate.retrieval.embedding, plan.judge]) {
        if (model && !process.env[model.apiKeyEnv]) throw new Error(`请在服务端配置模型凭证环境变量：${model.apiKeyEnv}`);
      }
      const experiment: EvaluationExperiment = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), status: "queued", plan, fingerprint: "", codeHashes: { baseline: "", candidate: "" }, scorerVersion: "assertions-v1/deepeval-0.9.16", executions: [], report: null, reviews: [], error: null };
      const controller = new AbortController();
      // 先占用运行槽，避免并发 start 在首次落盘前同时通过检查。
      const task = { id: experiment.id, controller, promise: Promise.resolve() }; active = task;
      try { await saveExperiment(home, experiment); }
      catch (error) { active = null; throw error; }
      task.promise = execute(experiment, controller.signal).finally(() => { active = null; });
      // 保留可 await 的失败，同时避免 HTTP 分离执行产生未处理 rejection。
      void task.promise.catch(() => {});
      return experiment.id;
    },
    /** 等待当前实验落盘；CLI 和测试使用，HTTP 创建接口不等待。 */
    async wait() { await active?.promise; },
    /** 取消当前实验；已完成的评分与证据保留。 */
    cancel(id: string) { if (!active || active.id !== id) return false; active.controller.abort(); return true; },
    /** 分页返回实验摘要，避免批量传输证据正文。 */
    async list(page = 1, pageSize = 20) {
      if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error("分页参数无效");
      const all = await listExperiments(home);
      return { total: all.length, page, items: all.slice((page - 1) * pageSize, page * pageSize).map((e) => ({ id: e.id, name: e.plan.name, createdAt: e.createdAt, status: (e.status === "running" || e.status === "queued") && active?.id !== e.id ? "interrupted" : e.status, completed: e.executions.length, total: e.plan.dataset.cases.length * e.plan.repetitions * 2, decision: e.report?.decision ?? null })) };
    },
    /** 完整实验详情，包含各次执行证据，不从分页列表拼接。 */
    async get(id: string) {
      const e = await readExperiment(home, id);
      if ((e.status === "running" || e.status === "queued") && active?.id !== id) { e.status = "failed"; e.error = "服务中断，实验没有完成；请创建新实验重跑"; e.report = compareEvaluations(e.plan, e.executions); e.report.decision = "insufficient"; }
      return e;
    },
    /** 人工复核以附加记录保存，不能覆盖自动评分或发布结论。 */
    async review(id: string, caseId: string, conclusion: string) {
      if (active?.id === id) throw new Error("请在实验完成后复核");
      const e = await readExperiment(home, id);
      if (!e.plan.dataset.cases.some((c) => c.id === caseId) || typeof conclusion !== "string" || !conclusion.trim() || conclusion.length > 10000) throw new Error("复核内容或用例无效");
      e.reviews.push({ caseId, conclusion, createdAt: new Date().toISOString() }); await saveExperiment(home, e); return e;
    },
    /** 读取实际调度事件用于回放；与 Agent Trace 分开存放。 */
    async events(id: string): Promise<EvaluationEvent[]> {
      const text = await readFile(join(idPath(home, id), "events.jsonl"), "utf8"); return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as EvaluationEvent);
    },
    subscribe(observer: (event: EvaluationEvent) => void) { observers.add(observer); return () => observers.delete(observer); },
  };
}
function budgetExceeded(experiment: EvaluationExperiment): boolean {
  const g = experiment.plan.gate;
  const costs = (kind: "agent" | "judge") => experiment.executions.reduce((sum, e) => sum + (kind === "agent" ? e.evidence?.agentUsd ?? 0 : e.judgeUsd ?? 0), 0);
  return (g.maxAgentUsd !== null && (costs("agent") > g.maxAgentUsd || experiment.executions.some((e) => e.evidence?.agentUsd == null)))
    || (g.maxJudgeUsd !== null && (costs("judge") > g.maxJudgeUsd || experiment.executions.some((e) => e.judgeUsd === null)));
}
