import type { MemoryCandidate, MemoryManagementOptions, MemoryManagementResult } from "./types.ts";
import type { MemoryDatabase } from "./storage/database.ts";
import type { MemoryManagement } from "./management.ts";
import type { Row } from "./storage/records.ts";
import { nowUtc } from "./storage/records.ts";

interface SessionProgress {
  sessionId: string;
  throughMessageId: number;
  batches: Array<{ messageIds: number[]; candidates?: MemoryCandidate[] }>;
  completed?: boolean;
}
interface TaskPayload {
  sessionId?: string;
  sourceRunId?: string;
  candidate?: MemoryCandidate;
  sessions?: SessionProgress[];
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
  private options: BackgroundOptions | undefined;
  private work: Promise<void> | undefined;
  private stopped = false;
  private wake: (() => void) | undefined;

  constructor(storage: MemoryDatabase, management: MemoryManagement) {
    this.storage = storage; this.management = management;
  }

  /** 只恢复已经入库的任务，不因启动把不足阈值的 Session 入队。 */
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

  /** 新建对话边界按未入队 Session 数量分批；快照水位防止处理中新增消息被误标完成。 */
  enqueueConsolidations(currentSessionId: string, threshold: number): void {
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > 100) throw new TypeError("整理间隔必须为 1 至 100 个 Session");
    const reserved = new Map<string, number>();
    for (const row of this.storage.connection.prepare("SELECT payload_json FROM memory_tasks WHERE kind='consolidation'").all() as Row[]) {
      for (const session of (JSON.parse(String(row.payload_json)) as TaskPayload).sessions ?? []) reserved.set(session.sessionId, Math.max(reserved.get(session.sessionId) ?? 0, session.throughMessageId));
    }
    const rows = this.storage.connection.prepare(`SELECT s.id, s.consolidated_through_message_id AS watermark,
      MAX(c.id) AS through_id FROM sessions s JOIN chat_log c ON c.session_id=s.id
      WHERE s.id<>? AND EXISTS (SELECT 1 FROM chat_log done WHERE done.session_id=c.session_id AND done.run_id=c.run_id AND done.kind='assistant_message')
      GROUP BY s.id ORDER BY MIN(c.id)`).all(currentSessionId) as Row[];
    const pending: SessionProgress[] = [];
    for (const row of rows) {
      const sessionId = String(row.id);
      const watermark = Math.max(Number(row.watermark), reserved.get(sessionId) ?? 0);
      if (Number(row.through_id) <= watermark) continue;
      const ids = (this.storage.connection.prepare(`SELECT c.id FROM chat_log c WHERE c.session_id=? AND c.id>? AND c.id<=? AND c.kind='user_message'
        AND EXISTS (SELECT 1 FROM chat_log done WHERE done.session_id=c.session_id AND done.run_id=c.run_id AND done.kind='assistant_message') ORDER BY c.id`).all(sessionId, watermark, Number(row.through_id)) as Row[]).map((item) => Number(item.id));
      const batches: SessionProgress["batches"] = [];
      for (let offset = 0; offset < ids.length; offset += 16) batches.push({ messageIds: ids.slice(offset, offset + 16) });
      if (batches.length) pending.push({ sessionId, throughMessageId: Number(row.through_id), batches });
    }
    while (pending.length >= threshold) this.insert("consolidation", { sessions: pending.splice(0, threshold) });
    this.kick();
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
        options = { ...base, runId: task.id, ...(payload.sourceRunId ? { sourceRunId: payload.sourceRunId } : {}),
          observer: async (kind, event) => base.observer?.(kind, { ...event, runId: task.id, taskId: task.id, taskKind: task.kind, taskCreatedAt: task.createdAt, sourceRunId: payload.sourceRunId }) };
        await options.observer?.("memory_task_started", { attempt: task.attempts });
        if (task.kind === "memory_write") {
          await this.management.manage(payload.candidate!, { ...options, currentSessionId: payload.sessionId!, source: "agent", candidateId: "write" });
        } else {
          let failed = false;
          for (const session of payload.sessions!) {
            if (session.completed) continue;
            try { await this.consolidate(task, payload, session, options); }
            catch (error) {
              failed = true;
              await options.observer?.("consolidation_error", { sessionId: session.sessionId, errorType: error instanceof Error ? error.name : "UnknownError" });
            }
          }
          if (failed) throw new Error("部分 Session 整理失败");
        }
        this.storage.connection.prepare("UPDATE memory_tasks SET status='completed', error_type=NULL, completed_at=? WHERE id=?").run(nowUtc(), task.id);
        await options.observer?.("memory_task_completed", { attempt: task.attempts });
      } catch (error) {
        const retry = task.attempts < 3;
        const errorType = error instanceof Error ? error.name : "UnknownError";
        const nextAttemptAt = retry ? Date.now() + 1000 * 2 ** (task.attempts - 1) : 0;
        this.storage.connection.prepare("UPDATE memory_tasks SET status=?, error_type=?, next_attempt_at=? WHERE id=?").run(retry ? "pending" : "failed", errorType, nextAttemptAt, task.id);
        await options?.observer?.(retry ? "memory_task_retry" : "memory_task_failed", { attempt: task.attempts, errorType, nextAttemptAt });
      }
    }
  }

  private async consolidate(task: BackgroundTask, payload: TaskPayload, session: SessionProgress, options: MemoryManagementOptions): Promise<void> {
    const runId = `${task.id}:${session.sessionId}`;
    this.storage.connection.prepare(`INSERT INTO consolidation_runs(run_id, session_id, trigger, status, through_message_id, started_at)
      VALUES (?, ?, 'session_batch', 'running', ?, ?) ON CONFLICT(run_id) DO UPDATE SET status='running', error_type=NULL`).run(runId, session.sessionId, session.throughMessageId, nowUtc());
    const local = { ...options, currentSessionId: session.sessionId, source: "consolidation" as const };
    try {
      await options.observer?.("consolidation_start", { sessionId: session.sessionId, throughMessageId: session.throughMessageId, trigger: "session_batch" });
      for (const [batchIndex, batch] of session.batches.entries()) {
        if (!batch.candidates) {
          batch.candidates = await this.management.extract(batch.messageIds, local);
          this.save(task.id, payload);
        }
        for (const [index, candidate] of batch.candidates.entries()) {
          await this.management.manage(candidate, { ...local, candidateId: `${session.sessionId}:${batchIndex}:${index}` });
        }
      }
      const changes = this.storage.connection.prepare("SELECT action, COUNT(*) AS count FROM memory_changes WHERE run_id=? AND session_id=? GROUP BY action").all(task.id, session.sessionId) as Row[];
      const count = (action: MemoryManagementResult["action"]) => Number(changes.find((row) => row.action === action)?.count ?? 0);
      this.storage.transaction(() => {
        this.storage.connection.prepare("UPDATE sessions SET consolidated_through_message_id=MAX(consolidated_through_message_id, ?) WHERE id=?").run(session.throughMessageId, session.sessionId);
        this.storage.connection.prepare("UPDATE consolidation_runs SET status='completed', facts_created=?, facts_updated=?, facts_skipped=?, completed_at=? WHERE run_id=?").run(count("create"), count("update"), count("noop"), nowUtc(), runId);
        session.completed = true; this.save(task.id, payload);
      });
      await options.observer?.("consolidation_end", { sessionId: session.sessionId, throughMessageId: session.throughMessageId, factsCreated: count("create"), factsUpdated: count("update"), factsSkipped: count("noop"), factsDeleted: count("delete"), factsMerged: count("merge") });
    } catch (error) {
      this.storage.connection.prepare("UPDATE consolidation_runs SET status='failed', error_type=? WHERE run_id=?").run(error instanceof Error ? error.name : "UnknownError", runId);
      throw error;
    }
  }
}
function taskFromRow(row: Row): BackgroundTask {
  return { id: String(row.id), kind: row.kind as BackgroundTask["kind"], status: row.status as BackgroundTask["status"], attempts: Number(row.attempts), createdAt: String(row.created_at), nextAttemptAt: Number(row.next_attempt_at), errorType: row.error_type === null ? null : String(row.error_type) };
}
