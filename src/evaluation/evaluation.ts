import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { MemoryRuntime } from "../memory/index.ts";
import { readEvaluationConfiguration } from "./configuration.ts";
import { EvaluationLangfuse } from "./langfuse.ts";
import { starterDatasets } from "./datasets.ts";
import { identifier } from "./validation.ts";
import { summarizeRun } from "./scoring.ts";
import { idPath, listRuns, readRun, saveRun, snapshotCode, writeJson } from "./storage.ts";
import { runEvaluationProcess } from "./process-runner.ts";
import { identifier as traceIdentifier } from "../tracing/langfuse/observations.ts";
import type { DatasetReference, EvaluationEvent, EvaluationExecution, EvaluationOverview, EvaluationRun, EvaluationRunSummary, EvaluationStage } from "./types.ts";

/** 固定数据集回归入口，页面和未来 CI 共用；同一实例只允许一个运行或目录写操作。 */
export function createEvaluationService(home: string, configurationHome = join(process.cwd(), ".everything"), options: { sourceRoot?: string; executionTimeoutMs?: number; scoreWaitMs?: number; scorePollMs?: number } = {}) {
  const runsHome = join(home, "runs");
  const sourceRoot = options.sourceRoot ?? process.cwd();
  let busy = false;
  let active: { id: string; controller: AbortController; promise: Promise<void> } | null = null;
  const recovering = new Map<string, Promise<EvaluationRun>>();
  const observers = new Set<(event: EvaluationEvent) => void>();
  const summary = (r: EvaluationRun): EvaluationRunSummary => ({ id: r.id, createdAt: r.createdAt, status: r.status, stage: r.stage, report: r.report, error: r.error });
  async function catalog(): Promise<DatasetReference[]> {
    try { return JSON.parse(await readFile(join(home, "datasets.json"), "utf8")) as DatasetReference[]; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  async function exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (busy || active) throw new Error("已有评估或数据集操作正在进行");
    busy = true;
    try { return await action(); } finally { busy = false; }
  }
  async function events(id: string): Promise<EvaluationEvent[]> {
    try { return (await readFile(join(idPath(runsHome, identifier(id)), "events.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as EvaluationEvent); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  async function emit(run: EvaluationRun, type: string, stage: EvaluationStage, executionId?: string) {
    run.stage = stage; run.updatedAt = new Date().toISOString(); run.report = summarizeRun(run);
    await saveRun(runsHome, run);
    const event: EvaluationEvent = { runId: run.id, sequence: (await events(run.id)).length + 1, timestamp: run.updatedAt, type, stage, status: run.status, decision: run.report.decision, ...(executionId ? { executionId } : {}) };
    await appendFile(join(idPath(runsHome, run.id), "events.jsonl"), `${JSON.stringify(event)}\n`, { mode: 0o600 });
    for (const observer of observers) { try { observer(event); } catch { console.warn("评估事件订阅者处理失败，执行事实已落盘"); } }
  }
  async function get(id: string): Promise<EvaluationRun> {
    const pending = recovering.get(id); if (pending) return pending;
    const run = await readRun(runsHome, identifier(id));
    if ((run.status === "queued" || run.status === "running") && active?.id !== id) {
      const existing = recovering.get(id); if (existing) return existing;
      run.status = "failed"; run.error = "服务中断，执行未完成，请重新评估";
      const recovery = emit(run, "run_failed", run.stage).then(() => run).finally(() => { recovering.delete(id); });
      recovering.set(id, recovery); return recovery;
    }
    return run;
  }
  async function collectScores(run: EvaluationRun, client: EvaluationLangfuse, signal?: AbortSignal) {
    let missing = false;
    for (const execution of run.executions) {
      signal?.throwIfAborted();
      const testCase = run.datasets.find(d => d.id === execution.datasetId)!.cases.find(c => c.id === execution.caseId)!;
      if (execution.sync !== "synced") await client.publish(run, execution, signal);
      if (execution.status !== "completed" || !execution.evidence?.complete || !testCase.judge) continue;
      const score = await client.score(execution, testCase, signal);
      execution.scores = execution.scores.filter(s => s.name !== testCase.judge!.scoreName);
      if (score) execution.scores.push(score); else missing = true;
    }
    return missing;
  }
  async function execute(run: EvaluationRun, credentials: Record<string, string>, signal: AbortSignal) {
    const directory = idPath(runsHome, run.id);
    const client = new EvaluationLangfuse(configurationHome);
    try {
      run.status = "running";
      await emit(run, "dataset_ready", "dataset");
      run.codeHash = await snapshotCode(sourceRoot, join(directory, "code"));
      await emit(run, "agent_started", "agent");
      for (const dataset of run.datasets) for (const testCase of dataset.cases) {
        signal.throwIfAborted();
        const seed = join(directory, "seeds", dataset.id, testCase.id); await mkdir(seed, { recursive: true });
        const memory = new MemoryRuntime(seed); let sessionId: string;
        try {
          for (const fact of testCase.memory) await memory.createSemantic(fact.subject, fact.content, fact.source);
          const session = memory.createSession("评估初始会话"); sessionId = session.id;
          for (const [index, turn] of testCase.history.entries()) {
            const runId = `seed-${index}`; memory.startRun(session.id, runId, turn.prompt);
            await memory.completeRun(session.id, runId, [{ role: "user", content: turn.prompt }, { role: "assistant", content: [{ type: "text", text: turn.reply }] }]);
          }
        } finally { memory.close(); }
        const id = crypto.randomUUID(), traceId = traceIdentifier(`${run.id}:${id}`);
        const execution: EvaluationExecution = { id, datasetId: dataset.id, caseId: testCase.id, status: "failed", error: null, evidence: null, scores: [], traceId, observationId: traceIdentifier(`${traceId}:root`, 16), traceUrl: null, sync: "pending" };
        const runDirectory = join(directory, "executions", id); await mkdir(runDirectory, { recursive: true });
        await emit(run, "execution_started", "agent", id);
        const result = await runEvaluationProcess({ directory: runDirectory, codeRoot: join(directory, "code"), seed, sessionId, testCase, configuration: run.configuration, execution, timeoutMs: options.executionTimeoutMs ?? 300000, denyRead: await terminalDenyRead(runDirectory, configurationHome) }, signal, credentials);
        run.executions.push(result);
        await emit(run, "execution_completed", "agent", id);
      }
      signal.throwIfAborted(); run.status = "waiting_scores";
      await emit(run, "scoring_started", "score");
      for (const execution of run.executions) {
        try { await client.publish(run, execution, signal); }
        catch (error) { execution.sync = "failed"; throw error; }
      }
      const deadline = Date.now() + (options.scoreWaitMs ?? 120000);
      while (await collectScores(run, client, signal)) {
        await emit(run, "scores_pending", "score");
        if (Date.now() >= deadline) { run.error = "等待 Langfuse 自动评分超时，可在详情中刷新评分"; return; }
        await delay(options.scorePollMs ?? 3000, undefined, { signal });
      }
      run.status = "completed"; await emit(run, "gate_completed", "gate");
    } catch (error) {
      run.status = signal.aborted ? "cancelled" : "failed";
      run.error = signal.aborted ? "评估已取消" : error instanceof Error ? error.message : "评估失败";
      await emit(run, signal.aborted ? "run_cancelled" : "run_failed", run.stage);
    } finally { run.report = summarizeRun(run); await saveRun(runsHome, run); }
  }
  return {
    /** Overview 返回摘要和连接状态，不批量传输私人执行正文。 */
    async overview(): Promise<EvaluationOverview> {
      const runs = await listRuns(runsHome);
      const summaries = await Promise.all(runs.slice(0, 30).map(async r => summary(await get(r.id))));
      return { datasets: await catalog(), runs: summaries, active: active ? summary(await get(active.id)) : null, langfuse: EvaluationLangfuse.status(configurationHome) };
    },
    async dataset(id: string) {
      const reference = (await catalog()).find(d => d.id === identifier(id));
      if (!reference) throw new Error("数据集不存在");
      return new EvaluationLangfuse(configurationHome).dataset(reference);
    },
    /** 保存新版本成功后才替换目录引用；上传失败不会破坏上一版本。 */
    async saveDataset(value: unknown) {
      return exclusive(async () => {
        const reference = await new EvaluationLangfuse(configurationHome).saveDataset(value);
        const all = await catalog(); await mkdir(home, { recursive: true });
        await writeJson(join(home, "datasets.json"), [...all.filter(d => d.id !== reference.id), reference]);
        return reference;
      });
    },
    /** 显式安装缺失的默认数据集，不覆盖已编辑内容。 */
    async initializeDatasets() {
      return exclusive(async () => {
        const all = await catalog(); const client = new EvaluationLangfuse(configurationHome);
        await mkdir(home, { recursive: true });
        for (const dataset of starterDatasets()) if (!all.some(d => d.id === dataset.id)) {
          all.push(await client.saveDataset(dataset)); await writeJson(join(home, "datasets.json"), all);
        }
        return all;
      });
    },
    /** 运行选定数据集或全部默认集，始终使用当前 Agent，冻结用例与源码。 */
    async start(datasetIds?: string[]): Promise<string> {
      return exclusive(async () => {
        if (datasetIds !== undefined && (!Array.isArray(datasetIds) || !datasetIds.length || datasetIds.length > 100 || new Set(datasetIds).size !== datasetIds.length)) throw new Error("请选择有效且不重复的数据集");
        const all = await catalog();
        if (datasetIds) for (const id of datasetIds) if (!all.some(d => d.id === identifier(id))) throw new Error("数据集不存在");
        const selected = all.filter(d => datasetIds ? datasetIds.includes(d.id) : d.defaultEnabled);
        if (!selected.length) throw new Error("请先在 Evaluation 初始化或启用默认数据集");
        const client = new EvaluationLangfuse(configurationHome);
        const datasets = await Promise.all(selected.map(d => client.dataset(d)));
        if (datasets.reduce((total, dataset) => total + dataset.cases.length, 0) > 1000) throw new Error("单次评估最多 1000 个用例");
        if (datasets.some(d => d.cases.some(c => c.judge)) && !EvaluationLangfuse.status(configurationHome).captureContent) throw new Error("语义评分需要启用 LANGFUSE_EVALUATION_CAPTURE_CONTENT");
        const { configuration, credentials } = await readEvaluationConfiguration(configurationHome);
        const now = new Date().toISOString();
        const run: EvaluationRun = { id: crypto.randomUUID(), createdAt: now, updatedAt: now, status: "queued", stage: "dataset", datasets, configuration, codeHash: "", executions: [], report: { decision: "insufficient", total: 0, passed: 0, failed: 0, pending: 0, reasons: [] }, error: null };
        run.report = summarizeRun(run); await saveRun(runsHome, run);
        const task = { id: run.id, controller: new AbortController(), promise: Promise.resolve() }; active = task;
        task.promise = execute(run, credentials, task.controller.signal).finally(() => { active = null; });
        void task.promise.catch(() => {});
        return run.id;
      });
    },
    get, events,
    /** 刷新已有证据的同步与平台评分，绝不重新执行 Agent。 */
    async refreshScores(id: string) {
      return exclusive(async () => {
        const run = await get(id);
        if (run.stage !== "score" && run.stage !== "gate") throw new Error("执行尚未完整，不能只刷新评分");
        if (run.status === "cancelled") throw new Error("已取消的运行不能恢复评分，请重新评估");
        run.status = "waiting_scores"; run.error = null;
        try {
          const missing = await collectScores(run, new EvaluationLangfuse(configurationHome));
          run.status = missing ? "waiting_scores" : "completed";
          await emit(run, missing ? "scores_pending" : "gate_completed", missing ? "score" : "gate");
        } catch (error) { run.error = error instanceof Error ? error.message : "评分刷新失败"; await emit(run, "scores_failed", "score"); }
        return run;
      });
    },
    cancel(id: string) { if (active?.id !== id) return false; active.controller.abort(); return true; },
    async wait() { await active?.promise; },
    subscribe(observer: (event: EvaluationEvent) => void) { observers.add(observer); return () => { observers.delete(observer); }; },
  };
}
/** 屏蔽宿主个人目录与评估凭证；沿工作区祖先逐级拒读兄弟路径，保留 Node 安装路径。 */
async function terminalDenyRead(directory: string, configurationHome: string): Promise<string[]> {
  const workspace = resolve(directory, "home", "sandbox");
  const denied = new Set([resolve(configurationHome)]);
  const contains = (parent: string, child: string) => { const rel = relative(parent, child); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); };
  let cursor = homedir();
  // 宿主项目可能在临时目录，仍拒读个人目录；保留运行时安装所在的一级目录。
  while (true) {
    for (const entry of await readdir(cursor, { withFileTypes: true })) {
      const path = join(cursor, entry.name);
      if (!contains(path, workspace) && !contains(path, process.execPath)) denied.add(path);
    }
    if (!contains(cursor, workspace) || cursor === workspace) break;
    const next = relative(cursor, workspace).split("/")[0]; if (!next) break;
    cursor = join(cursor, next);
    try { await readdir(cursor); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") break; throw error; }
  }
  denied.add(join(directory, "home", ".env"));
  return [...denied];
}
