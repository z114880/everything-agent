import { MemoryConsolidation, type ConsolidationProgress } from "./consolidation.ts";
import type { SemanticStore } from "./storage/semantic-store.ts";
import type { MemoryCandidate, MemoryManagementOptions } from "./types.ts";
import type { MemoryDatabase } from "./storage/database.ts";
import type { MemoryManagement } from "./management.ts";
import type { Row } from "./storage/records.ts";
import { nowUtc } from "./storage/records.ts";

interface TaskPayload {
  sessionId?: string;
  sourceRunId?: string;
  candidate?: MemoryCandidate;
  consolidation?: ConsolidationProgress;
}
export interface BackgroundTask {
  id: string;
  kind: "memory_write" | "consolidation";
  status: "pending" | "running" | "completed" | "failed";
  attempts: number;
  createdAt: string;
  nextAttemptAt: number;
  errorType: string | null;
}
export type BackgroundOptions = (task: BackgroundTask) => Promise<MemoryManagementOptions>;

/** 持久化单消费者队列；候选检查点与事务内操作凭据保证恢复不重复提交。 */
export class MemoryBackgroundTasks {
  private readonly storage: MemoryDatabase;
  private readonly management: MemoryManagement;
  private readonly consolidation: MemoryConsolidation;
  private options: BackgroundOptions | undefined;
  private work: Promise<void> | undefined;
  private stopped = false;
  private wake: (() => void) | undefined;

  constructor(storage: MemoryDatabase, management: MemoryManagement, semantic: SemanticStore) {
    this.storage = storage; this.management = management;
    this.consolidation = new MemoryConsolidation(semantic, storage);
  }

  /** 只恢复已经入库的任务，不因服务启动创建每日任务。 */
  start(options: BackgroundOptions): void { this.options = options; this.stopped = false; this.kick(); }

  /** 停止继续取任务；正在执行的单次操作由调用方等待后再关闭数据库。 */
  stop(): void { this.stopped = true; this.wake?.(); }

  /** 只返回任务元数据，避免任务候选正文进入默认展示。 */
  list(): BackgroundTask[] {
    return (this.storage.connection.prepare("SELECT * FROM memory_tasks ORDER BY rowid").all() as Row[]).map(taskFromRow);
  }

  /** 候选落库成功才返回 queued；后台不继承聊天的取消信号。 */
  enqueueMemory(candidate: MemoryCandidate, options: MemoryManagementOptions): { status: "queued"; taskId: string } {
    this.management.validateEvidence(candidate, options);
    const id = this.insert("memory_write", { candidate, sessionId: options.currentSessionId, ...(options.runId ? { sourceRunId: options.runId } : {}) });
    // 直接使用 MemoryRuntime 的调用方也可注入依赖；应用层在启动时配置独立 trace observer。
    const { signal: _signal, ...detached } = options;
    this.options ??= async () => detached;
    this.kick();
    return { status: "queued", taskId: id };
  }

  /** 持久化每日去重与任务互斥；手动执行不受每日自动配额限制。 */
  enqueueConsolidation(trigger: "daily" | "manual") {
    if (trigger !== "daily" && trigger !== "manual") throw new TypeError("Consolidate 触发来源无效");
    const now = new Date();
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const result = this.storage.transaction(() => {
      const existing = this.storage.connection.prepare("SELECT id FROM memory_tasks WHERE kind='consolidation' AND status IN ('pending','running') LIMIT 1").get();
      const daily = this.storage.connection.prepare("SELECT task_id FROM consolidation_days WHERE day=?").get(day);
      if (existing) {
        if (trigger === "daily") this.storage.connection.prepare("INSERT OR IGNORE INTO consolidation_days VALUES (?, ?)").run(day, String(existing.id));
        return { status: "active" as const, taskId: String(existing.id) };
      }
      if (trigger === "daily" && daily) return { status: "already_ran" as const, taskId: String(daily.task_id) };
      const taskId = this.insert("consolidation", { consolidation: { trigger, completed: 0 } });
      if (trigger === "daily") this.storage.connection.prepare("INSERT INTO consolidation_days VALUES (?, ?)").run(day, taskId);
      this.storage.connection.prepare("INSERT INTO consolidation_runs(run_id, trigger, status, started_at) VALUES (?, ?, 'pending', ?)").run(taskId, trigger, nowUtc());
      return { status: "queued" as const, taskId };
    });
    this.kick();
    return result;
  }

  /** 等待当前队列排空，供测试与显式生命周期操作使用；聊天请求不调用。 */
  async wait(): Promise<void> { while (this.work) await this.work; }

  private insert(kind: BackgroundTask["kind"], payload: TaskPayload): string {
    const id = crypto.randomUUID();
    this.storage.connection.prepare("INSERT INTO memory_tasks(id, kind, status, payload_json, created_at) VALUES (?, ?, 'pending', ?, ?)").run(id, kind, JSON.stringify(payload), nowUtc());
    return id;
  }

  private save(id: string, payload: TaskPayload): void {
    this.storage.connection.prepare("UPDATE memory_tasks SET payload_json=? WHERE id=?").run(JSON.stringify(payload), id);
  }

  private kick(): void {
    this.wake?.();
    if (!this.options || this.work || this.stopped) return;
    // 先返回 queued，再在后续事件循环处理远程工作。
    this.work = new Promise<void>((resolve) => setImmediate(resolve)).then(() => this.drain()).finally(() => { this.work = undefined; });
  }

  private async drain(): Promise<void> {
    while (!this.stopped) {
      const row = this.storage.connection.prepare("SELECT * FROM memory_tasks WHERE status='pending' ORDER BY next_attempt_at, rowid LIMIT 1").get() as Row | undefined;
      if (!row) return;
      const task = taskFromRow(row);
      if (task.nextAttemptAt > Date.now()) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => { this.wake = undefined; resolve(); }, task.nextAttemptAt - Date.now());
          this.wake = () => { clearTimeout(timer); this.wake = undefined; resolve(); };
        });
        continue;
      }
      const payload = JSON.parse(String(row.payload_json)) as TaskPayload;
      task.attempts++;
      this.storage.connection.prepare("UPDATE memory_tasks SET status='running', attempts=? WHERE id=?").run(task.attempts, task.id);
      let options: MemoryManagementOptions | undefined;
      try {
        const { signal: _signal, ...base } = await this.options!(task);
        options = {
          ...base, runId: task.id, ...(payload.sourceRunId ? { sourceRunId: payload.sourceRunId } : {}),
          observer: async (kind, event) => base.observer?.(kind, { ...event, runId: task.id, ...(task.kind === "consolidation" ? { attempt: task.attempts } : { taskId: task.id, taskKind: task.kind, taskCreatedAt: task.createdAt, sourceRunId: payload.sourceRunId }) })
        };
        await options.observer?.(task.kind === "consolidation" ? "consolidation_started" : "memory_task_started", { attempt: task.attempts, ...(task.kind === "consolidation" ? { trigger: payload.consolidation!.trigger, createdAt: task.createdAt } : {}) });
        if (task.kind === "memory_write") {
          await this.management.manage(payload.candidate!, { ...options, currentSessionId: payload.sessionId!, source: "agent", candidateId: "write" });
        } else {
          this.storage.connection.prepare("UPDATE consolidation_runs SET status='running', error_type=NULL WHERE run_id=?").run(task.id);
          await this.consolidation.run(task.id, payload.consolidation!, options, () => this.save(task.id, payload));
          this.storage.connection.prepare("UPDATE consolidation_runs SET status='completed', completed_at=? WHERE run_id=?").run(nowUtc(), task.id);
        }
        this.storage.connection.prepare("UPDATE memory_tasks SET status='completed', error_type=NULL, completed_at=? WHERE id=?").run(nowUtc(), task.id);
        await options.observer?.(task.kind === "consolidation" ? "consolidation_completed" : "memory_task_completed", { attempt: task.attempts, ...(task.kind === "consolidation" ? { completedBatches: payload.consolidation!.completed } : {}) });
      } catch (error) {
        const retry = task.attempts < 3;
        const errorType = error instanceof Error ? error.name : "UnknownError";
        const nextAttemptAt = retry ? Date.now() + 1000 * 2 ** (task.attempts - 1) : 0;
        this.storage.connection.prepare("UPDATE memory_tasks SET status=?, error_type=?, next_attempt_at=? WHERE id=?").run(retry ? "pending" : "failed", errorType, nextAttemptAt, task.id);
        if (task.kind === "consolidation") this.storage.connection.prepare("UPDATE consolidation_runs SET status=?, error_type=? WHERE run_id=?").run(retry ? "pending" : "failed", errorType, task.id);
        await options?.observer?.(task.kind === "consolidation" ? (retry ? "consolidation_retry" : "consolidation_failed") : (retry ? "memory_task_retry" : "memory_task_failed"), { attempt: task.attempts, errorType, nextAttemptAt });
      }
    }
  }

}

function taskFromRow(row: Row): BackgroundTask {
  return { id: String(row.id), kind: row.kind as BackgroundTask["kind"], status: row.status as BackgroundTask["status"], attempts: Number(row.attempts), createdAt: String(row.created_at), nextAttemptAt: Number(row.next_attempt_at), errorType: row.error_type === null ? null : String(row.error_type) };
}
