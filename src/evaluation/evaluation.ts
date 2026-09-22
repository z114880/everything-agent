import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createEvaluationRuntime } from './agent.ts';
import { createLocalConfig } from '../agent-runtime/index.ts';
import type { AgentRuntime } from '../agent-runtime/index.ts';
import type { LangfuseEvaluationClient } from './langfuse.ts';
import { evaluationSecrets, prepareEvaluationHome, writeEvaluationJson } from './isolation.ts';
import { redactEvaluation } from './privacy.ts';
import type { EvaluationInput, EvaluationItem, EvaluationRun } from './types.ts';

type Runtime = Pick<AgentRuntime, 'run' | 'createSession' | 'close' | 'listPendingApprovals' | 'settleApproval'>;
/** 评估依赖由宿主注入；测试通过相同公开入口控制模型和平台边界。 */
export interface EvaluationOptions {
  directory: string; sourceHome: string;
  client: Pick<LangfuseEvaluationClient, 'dataset' | 'publish' | 'scores'>;
  createRuntime?: (home: string) => Runtime;
  /** 用例并发上限，默认 3；必须是正安全整数。 */
  concurrency?: number;
}

/** 本地真实评估队列：独立数据、有限并发、取消、审批、持久化与同步重试。 */
export class EvaluationService {
  private readonly options: EvaluationOptions;
  private readonly concurrency: number;
  private readonly runs = new Map<string, EvaluationRun>();
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly runtimes = new Map<string, { runId: string; itemId: string; runtime: Runtime }>();
  private readonly writes = new Map<string, Promise<void>>();
  private readonly syncing = new Map<string, Promise<void>>();
  private secrets: string[] = [];
  private initialized = false;
  constructor(options: EvaluationOptions) {
    this.concurrency = options.concurrency ?? 3;
    if (!Number.isSafeInteger(this.concurrency) || this.concurrency < 1) throw new Error('评估并发数必须是正安全整数');
    this.options = options;
  }

  /** 载入新模块自己的历史记录；进程中断不自动重跑真实操作。 */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    this.secrets = await evaluationSecrets(this.options.sourceHome);
    for (const name of await readdir(this.options.directory)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      const run = JSON.parse(await readFile(join(this.options.directory, name), 'utf8')) as EvaluationRun;
      if (run.status === 'queued' || run.status === 'running') {
        run.status = 'interrupted'; run.error = '进程中断；未自动重跑真实操作'; run.finishedAt = new Date().toISOString();
        for (const item of run.items) if (['queued', 'running', 'waiting_approval'].includes(item.status)) {
          item.status = 'cancelled'; item.error = '进程中断'; item.finishedAt = run.finishedAt;
        }
        await writeEvaluationJson(join(this.options.directory, name), run);
      }
      this.runs.set(run.id, run);
    }
    this.initialized = true;
  }
  /** 入队后立即返回 ID；一次只接受一个实验，每次实验按配置限制用例并发，默认 3。 */
  async start(input: EvaluationInput): Promise<EvaluationRun> {
    if (!this.initialized) throw new Error('评估服务尚未初始化');
    if (this.controllers.size) throw new Error('已有评估运行，请等待完成或取消');
    const datasetName = text(input.datasetName, '数据集名称', 200);
    const createdAt = new Date().toISOString();
    const id = randomUUID();
    const run: EvaluationRun = { id, name: `${input.name ? text(input.name, '实验名称', 120) : 'Everything Agent'} ${id.slice(0, 8)}`,
      datasetName, datasetId: input.datasetId ?? '', datasetVersion: createdAt, memorySnapshot: false,
      createdAt, status: 'queued', items: [] };
    const controller = new AbortController();
    this.controllers.set(id, controller); this.runs.set(id, run);
    try { this.secrets = [...new Set([...this.secrets, ...await evaluationSecrets(this.options.sourceHome)])]; await this.save(run); } catch (error) { this.controllers.delete(id); this.runs.delete(id); throw error; }
    const job = this.execute(run, controller.signal).finally(() => { this.controllers.delete(id); this.jobs.delete(id); });
    this.jobs.set(id, job);
    // 所有执行异常由 execute 持久化；持久化本身失败仍应可见，不产生未处理 Promise。
    void job.catch(error => { run.status = 'failed'; run.error = this.message(error); });
    return structuredClone(run);
  }
  /** 返回独立快照，调用方不能修改内部状态。 */
  list(): EvaluationRun[] { return structuredClone([...this.runs.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt))); }
  /** 等待一个已入队实验及其最终状态写盘。 */
  async wait(id: string): Promise<void> { await this.jobs.get(id); }
  /** 取消所有未完成用例；已产生的真实操作不回滚。 */
  cancel(id: string): boolean { const controller = this.controllers.get(id); controller?.abort(new Error('用户取消评估')); return Boolean(controller); }
  /** 返回与实验、用例关联的待审批项。 */
  approvals() {
    return [...this.runtimes.values()].flatMap(({ runId, itemId, runtime }) => runtime.listPendingApprovals().map(approval => ({
      ...approval, command: redactEvaluation(approval.command, this.secrets) as string,
      reason: redactEvaluation(approval.reason, this.secrets) as string,
      ...(approval.detail ? { detail: redactEvaluation(approval.detail, this.secrets) as string } : {}), runId, itemId,
    })));
  }
  /** 审批必须与当前实验和用例匹配，不能批准过期请求。 */
  approve(runId: string, itemId: string, approvalId: string, approved: boolean): boolean {
    if (typeof approved !== 'boolean') throw new Error('approved 必须为布尔值');
    const active = this.runtimes.get(`${runId}:${itemId}`);
    return active?.runtime.settleApproval(approvalId, approved) ?? false;
  }
  /** 只重传已经执行完的轨迹并拉取评分，不再次调用 Agent。 */
  async refresh(id: string): Promise<void> {
    if (this.jobs.has(id)) throw new Error('运行完成后才能刷新评分和重试同步');
    const run = this.runs.get(id); if (!run) throw new Error('评估记录不存在');
    const existing = this.syncing.get(id); if (existing) return existing;
    const job = (async () => {
      delete run.scoreError;
      for (const item of run.items) {
        if (!item.startedAt || !item.finishedAt) continue;
        if (item.sync !== 'synced') await this.publish(run, item);
        if (item.sync !== 'synced') continue;
        try { item.scores = redactEvaluation(await this.options.client.scores(item), this.secrets) as EvaluationItem['scores']; }
        catch (error) { run.scoreError = this.message(error); }
      }
      await this.save(run);
    })().finally(() => { this.syncing.delete(id); });
    this.syncing.set(id, job); return job;
  }
  /** 停止入口后等待活跃任务释放 Runtime 和文件句柄。 */
  async close(): Promise<void> {
    for (const controller of this.controllers.values()) controller.abort(new Error('评估服务关闭'));
    await Promise.allSettled([...this.jobs.values(), ...this.syncing.values()]);
  }
  private async execute(run: EvaluationRun, signal: AbortSignal): Promise<void> {
    try {
      const dataset = await this.options.client.dataset(run.datasetName, run.datasetVersion);
      if (run.datasetId && run.datasetId !== dataset.id) throw new Error('数据集 ID 与名称不匹配');
      run.datasetId = dataset.id;
      // 两种启动入口使用同一份平台配置，在复制记忆前固定本次运行的选择。
      run.memorySnapshot = dataset.memorySnapshot === true;
      if (!dataset.items.length) throw new Error('数据集没有启用的用例');
      if (dataset.items.length > 200) throw new Error('单次评估最多接受 200 条用例');
      signal.throwIfAborted();
      const baseline = join(this.options.directory, run.id, 'baseline');
      await prepareEvaluationHome(this.options.sourceHome, baseline, run.memorySnapshot);
      run.items = dataset.items.map(item => ({ ...redactEvaluation(item, this.secrets) as typeof item,
        traceId: randomBytes(16).toString('hex'), observationId: randomBytes(8).toString('hex'),
        status: 'queued', output: [], events: [], scores: [], sync: 'pending', toolCalls: 0,
        inputTokens: null, outputTokens: null, approvalDenied: false }));
      run.status = 'running'; await this.save(run);
      let next = 0;
      const worker = async () => {
        while (next < run.items.length) {
          const index = next++;
          await this.executeItem(run, run.items[index]!, dataset.items[index]!.input, baseline, signal);
        }
      };
      const workers = await Promise.allSettled(Array.from({ length: Math.min(this.concurrency, run.items.length) }, () => worker()));
      const failed = workers.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      run.status = signal.aborted ? 'cancelled' : run.items.some(item => item.status !== 'completed') ? 'failed' : 'completed';
    } catch (error) { run.status = signal.aborted ? 'cancelled' : 'failed'; run.error = this.message(error); }
    finally { run.finishedAt = new Date().toISOString(); await this.save(run); }
  }
  private async executeItem(run: EvaluationRun, item: EvaluationItem, input: unknown, baseline: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) { item.status = 'cancelled'; await this.save(run); return; }
    const home = join(this.options.directory, run.id, item.traceId);
    let runtime: Runtime | undefined;
    item.status = 'running'; item.startedAt = new Date().toISOString();
    const itemSignal = AbortSignal.any([signal, AbortSignal.timeout(600_000)]);
    try {
      const turns = evaluationTurns(input);
      await prepareEvaluationHome(baseline, home, run.memorySnapshot);
      if (item.terminalEnabled !== true) await createLocalConfig({ home, defaultSystemPromptPath: join(home, 'EVERYTHING.md') }).updateConfigFile({ EVERYTHING_TOOL_RUN_TERMINAL_ENABLED: 'false' });
      itemSignal.throwIfAborted();
      runtime = this.options.createRuntime ? this.options.createRuntime(home) : await createEvaluationRuntime(home, itemSignal);
      this.runtimes.set(`${run.id}:${item.id}`, { runId: run.id, itemId: item.id, runtime });
      const session = await runtime.createSession();
      for (const prompt of turns) {
        itemSignal.throwIfAborted();
        const result = await runtime.run({ sessionId: session.id, prompt }, {
          signal: itemSignal,
          observer: async (kind, event) => {
            if (kind === 'text_delta' || kind === 'text') return;
            if (kind === 'tool_started') item.toolCalls++;
            if (kind === 'model_request' && event.request && typeof event.request === 'object' && 'model' in event.request && typeof event.request.model === 'string') item.model = event.request.model;
            // 模型完整上下文含日常记忆，评估只保留调用元数据和用量。
            const data = projectEvaluationEvent(kind, event);
            item.events.push({ sequence: item.events.length + 1, kind, timestamp: new Date().toISOString(), data: redactEvaluation(data, this.secrets) as Record<string, unknown> });
            if (kind === 'approval_requested') item.status = 'waiting_approval';
            if (kind === 'approval_resolved') { item.status = 'running'; if (event.approved === false) item.approvalDenied = true; }
            if (kind === 'model_response' && event.tokenUsage && typeof event.tokenUsage === 'object') {
              const usage = event.tokenUsage as Record<string, unknown>;
              if (typeof usage.inputTokens === 'number') item.inputTokens = (item.inputTokens ?? 0) + usage.inputTokens;
              if (typeof usage.outputTokens === 'number') item.outputTokens = (item.outputTokens ?? 0) + usage.outputTokens;
            }
            await this.save(run);
          },
        });
        item.output.push(redactEvaluation(result.reply, this.secrets) as string); item.model = result.model;
        if (result.failedToolCallCount > 0 || result.stopReason === 'max_iterations') throw new Error('用例存在工具错误或达到迭代上限');
      }
      if (item.approvalDenied) throw new Error('操作审批被拒绝，用例未完整执行');
      item.status = 'completed';
    } catch (error) { item.status = signal.aborted ? 'cancelled' : 'failed'; item.error = this.message(error); }
    finally {
      this.runtimes.delete(`${run.id}:${item.id}`);
      try { await runtime?.close(); } catch (error) { item.status = 'failed'; item.error = this.message(error); }
      item.finishedAt = new Date().toISOString(); item.ms = Date.parse(item.finishedAt) - Date.parse(item.startedAt);
      await this.publish(run, item); await this.save(run);
    }
  }
  private async publish(run: EvaluationRun, item: EvaluationItem) {
    try { await this.options.client.publish(run, item); item.sync = 'synced'; delete item.syncError; }
    catch (error) { item.sync = 'failed'; item.syncError = this.message(error); }
  }
  private message(error: unknown): string { return redactEvaluation(error instanceof Error ? error.message : String(error), this.secrets) as string; }
  private save(run: EvaluationRun): Promise<void> {
    const snapshot = structuredClone(run);
    const task = (this.writes.get(run.id) ?? Promise.resolve()).catch(() => {}).then(() => writeEvaluationJson(join(this.options.directory, `${run.id}.json`), snapshot));
    this.writes.set(run.id, task); return task;
  }
}
/**
 * 事件顶层允许进入评估记录的键。
 *
 * 审批命令、理由和详情保留在本地记录里供审计；这些事件不在 publish 的回传范围内，
 * 所以它们不会出现在平台上。新增回传事件类型时必须重新检查这条前提。
 */
const SAFE_EVENT_KEYS = ['runId', 'sessionId', 'iteration', 'modelCallId', 'toolCallId', 'tool', 'isError', 'ms', 'outputLength', 'tokenUsage', 'stopReason', 'approvalId', 'kind', 'command', 'reason', 'detail', 'approved', 'errorType', 'summary'];
/** 工具结果里允许进入评估记录的键；工作目录、检索查询、技能说明和工具正文都不在其中。 */
const SAFE_TOOL_RESULT_KEYS = ['command', 'exitCode', 'stdoutLength', 'stderrLength', 'truncated', 'timedOut', 'instructionLength'];
/** 命令上限：完整命令仍留在本地 Runtime trace 的 JSONL 里，评估记录和平台回传只保留前缀。 */
const MAX_RECORDED_COMMAND_LENGTH = 500;

/**
 * 把一个观察者事件投影成评估记录。
 *
 * 评估记录既本地持久化也会回传平台，因此这里只保留标识、枚举和统计字段：模型请求、
 * 检索上下文和工具正文都不进入记录。工具结果按固定键名筛选，所以没有专用脱敏的工具
 * （例如 search_web、get_current_time）也不会把原始结果带出来。
 */
function projectEvaluationEvent(kind: string, event: Record<string, unknown>): Record<string, unknown> {
  const data = Object.fromEntries(SAFE_EVENT_KEYS.filter(key => event[key] !== undefined).map(key => [key, event[key]]));
  if (kind !== 'tool_completed' && kind !== 'tool_failed') return data;
  const result = event.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return data;
  const source = result as Record<string, unknown>;
  // 技能名是 read_skill 独有的短标识，按工具单独放行；把通用的 name 加进白名单，会让
  // 其它工具将来返回的同名键静默漏出去。
  const keys = event.tool === 'read_skill' ? [...SAFE_TOOL_RESULT_KEYS, 'name'] : SAFE_TOOL_RESULT_KEYS;
  const safe: Record<string, unknown> = Object.fromEntries(keys.filter(key => source[key] !== undefined).map(key => [key, source[key]]));
  if (typeof safe.command === 'string' && safe.command.length > MAX_RECORDED_COMMAND_LENGTH) safe.command = `${safe.command.slice(0, MAX_RECORDED_COMMAND_LENGTH)}…`;
  return Object.keys(safe).length > 0 ? { ...data, result: safe } : data;
}

/** 验证数据集输入，拒绝任意 Runtime 配置和远程工具定义。 */
export function evaluationTurns(input: unknown): string[] {
  if (typeof input === 'string') return [text(input, '用例输入', 40_000)];
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const value = input as Record<string, unknown>;
    if (typeof value.prompt === 'string' && value.turns === undefined) return [text(value.prompt, '用例输入', 40_000)];
    if (Array.isArray(value.turns) && value.turns.length > 0 && value.turns.length <= 20) return value.turns.map(turn => text(turn, '多轮输入', 40_000));
  }
  throw new Error('用例输入必须是字符串、{ prompt: string } 或 { turns: string[] }（最多 20 轮）');
}
function text(value: unknown, label: string, limit: number): string { if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new Error(`${label}必须为 1–${limit} 字符`); return value.trim(); }
