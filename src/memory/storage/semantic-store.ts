import type { AgentObserver } from "../../agent-loop/agent-loop.ts";
import { toSearchText } from "../retrieve/index.ts";
import type { MemoryDecision, MemoryManagementResult, MemorySource, SemanticMemory } from "../types.ts";
import type { Row } from "./records.ts";
import { nowUtc, requiredMemoryText, semanticFromRow } from "./records.ts";
import type { MemoryDatabase } from "./database.ts";
import type { EmbeddingIndex } from "../retrieve/embedding-index.ts";

/** 语义事实的增删改查及事务内审计。 */
export class SemanticStore {
  private readonly storage: MemoryDatabase;
  private readonly embedding: EmbeddingIndex;

  constructor(storage: MemoryDatabase, embedding: EmbeddingIndex) {
    this.storage = storage;
    this.embedding = embedding;
  }

  listSemantic(): SemanticMemory[] {
    return (this.storage.connection.prepare("SELECT * FROM semantic_memory ORDER BY updated_at DESC, id DESC").all() as Row[]).map((row) => this.withSources(row));
  }

  async createSemantic(subject: string, content: string, source = "user"): Promise<SemanticMemory> {
    this.embedding.assertNoEmbeddingRebuild();
    this.embedding.markCorpusMutation();
    const cleanSubject = requiredMemoryText(subject, "Subject"); const cleanContent = requiredMemoryText(content, "Content"); const timestamp = nowUtc();
    const dense = await this.embedding.embedDocument(`主题：${cleanSubject}\n内容：${cleanContent}`, "memory_create");
    this.embedding.assertNoEmbeddingRebuild();
    return this.storage.transaction(() => {
      const result = this.storage.connection.prepare(`
        INSERT INTO semantic_memory(subject, content, source, search_text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      `).run(cleanSubject, cleanContent, source, toSearchText(`${cleanSubject} ${cleanContent}`), timestamp, timestamp);
      const id = Number(result.lastInsertRowid);
      if (this.embedding.retrieval.embedding) this.embedding.vectors.replaceActiveSource("semantic", String(id), dense.map((chunk) => ({
        ...chunk, corpus: "semantic", sourceId: String(id),
      })));
      this.audit("semantic", id, "create", source); return this.getSemantic(id)!;
    });
  }

  async updateSemantic(id: number, subject: string, content: string, source = "ui"): Promise<SemanticMemory> {
    this.embedding.assertNoEmbeddingRebuild();
    this.embedding.markCorpusMutation();
    const cleanSubject = requiredMemoryText(subject, "Subject"); const cleanContent = requiredMemoryText(content, "Content");
    if (!this.getSemantic(id)) throw new Error("Semantic memory 不存在");
    const dense = await this.embedding.embedDocument(`主题：${cleanSubject}\n内容：${cleanContent}`, "memory_create");
    this.embedding.assertNoEmbeddingRebuild();
    return this.storage.transaction(() => {
      const result = this.storage.connection.prepare(`
        UPDATE semantic_memory SET subject = ?, content = ?, source = ?, search_text = ?, updated_at = ? WHERE id = ?
      `).run(cleanSubject, cleanContent, source, toSearchText(`${cleanSubject} ${cleanContent}`), nowUtc(), id);
      if (Number(result.changes) === 0) throw new Error("Semantic memory 不存在");
      if (this.embedding.retrieval.embedding) this.embedding.vectors.replaceActiveSource("semantic", String(id), dense.map((chunk) => ({
        ...chunk, corpus: "semantic", sourceId: String(id),
      })));
      this.audit("semantic", id, "update", source); return this.getSemantic(id)!;
    });
  }

  deleteSemantic(id: number, source = "ui"): void {
    this.embedding.assertNoEmbeddingRebuild();
    this.embedding.markCorpusMutation();
    this.storage.transaction(() => {
      const result = this.storage.connection.prepare("DELETE FROM semantic_memory WHERE id = ?").run(id);
      if (Number(result.changes) === 0) throw new Error("Semantic memory 不存在");
      this.embedding.vectors.deleteActiveSource("semantic", String(id));
      this.audit("semantic", id, "delete", source);
    });
  }

  getSemantic(id: number): SemanticMemory | null {
    const row = this.storage.connection.prepare("SELECT * FROM semantic_memory WHERE id = ?").get(id) as Row | undefined;
    return row ? this.withSources(row) : null;
  }

  private withSources(row: Row): SemanticMemory {
    return { ...semanticFromRow(row), sources: (this.storage.connection.prepare("SELECT session_id, message_id, created_at FROM semantic_sources WHERE memory_id=? ORDER BY session_id, message_id").all(Number(row.id)) as Row[]).map((item) => ({ sessionId: String(item.session_id), messageId: Number(item.message_id), createdAt: String(item.created_at) })) };
  }

  /** 检索与写入共享全库版本，同时检测新增、更新、删除及 ABA 变化。 */
  revision(): number {
    return Number(this.storage.connection.prepare("SELECT version FROM semantic_clock WHERE id=1").get()!.version);
  }

  /** 读取同一持久任务已提交的操作凭据；删除和合并也不能在恢复时重放。 */
  committedResult(runId: string, candidateId: string): MemoryManagementResult | null {
    const row = this.storage.connection.prepare("SELECT * FROM memory_changes WHERE run_id=? AND candidate_id=?").get(runId, candidateId) as Row | undefined;
    return row ? { action: row.action as MemoryManagementResult["action"], reason: "已提交", reasonCode: row.reason_code as MemoryManagementResult["reasonCode"],
      ...(row.target_id === null ? {} : { targetId: Number(row.target_id) }), deletedIds: JSON.parse(String(row.deleted_ids)) as number[] } : null;
  }

  /** 向量预计算后重新检查版本，再原子更新事实、来源、索引与审计；冲突返回 null。 */
  async applyDecision(decision: MemoryDecision, revision: number, evidence: MemorySource[], context: { runId: string; candidateId: string; sessionId: string; source: string; signal: AbortSignal; observer: AgentObserver }): Promise<MemoryManagementResult | null> {
    const { action } = decision;
    context.signal.throwIfAborted();
    const committed = this.committedResult(context.runId, context.candidateId);
    if (committed) return committed;
    if (this.revision() !== revision) return null;
    const writesContent = action === "create" || action === "update" || action === "merge";
    this.embedding.assertNoEmbeddingRebuild();
    const subject = writesContent ? requiredMemoryText(decision.subject!, "主题") : "";
    const content = writesContent ? requiredMemoryText(decision.content!, "内容") : "";
    const dense = writesContent ? await this.embedding.embedDocument(`主题：${subject}\n内容：${content}`, "memory_create", undefined, context.signal, context.runId, context.observer) : [];
    context.signal.throwIfAborted();
    this.embedding.assertNoEmbeddingRebuild();
    return this.storage.transaction(() => {
      const committed = this.committedResult(context.runId, context.candidateId);
      if (committed) return committed;
      if (this.revision() !== revision) return null;
      for (const item of evidence) {
        if (!this.storage.connection.prepare("SELECT 1 FROM chat_log WHERE id=? AND session_id=? AND kind='user_message'").get(item.messageId, item.sessionId)) throw new Error("记忆证据已删除，本次未提交");
      }
      let targetId = decision.targetId;
      const deletedIds = action === "delete" ? [targetId!] : action === "merge" ? decision.sourceIds! : [];
      if (writesContent) {
        this.embedding.markCorpusMutation();
        const timestamp = nowUtc();
        if (action === "create") {
          targetId = Number(this.storage.connection.prepare("INSERT INTO semantic_memory(subject, content, source, search_text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(subject, content, context.source, toSearchText(`${subject} ${content}`), timestamp, timestamp).lastInsertRowid);
        } else {
          this.storage.connection.prepare("UPDATE semantic_memory SET subject=?, content=?, source=?, search_text=?, updated_at=? WHERE id=?").run(subject, content, context.source, toSearchText(`${subject} ${content}`), timestamp, targetId!);
        }
        for (const id of action === "merge" ? deletedIds : []) {
          this.storage.connection.prepare("INSERT OR IGNORE INTO semantic_sources SELECT ?, session_id, message_id, created_at FROM semantic_sources WHERE memory_id=?").run(targetId!, id);
        }
        for (const item of evidence) this.storage.connection.prepare("INSERT OR IGNORE INTO semantic_sources VALUES (?, ?, ?, ?)").run(targetId!, item.sessionId, item.messageId, item.createdAt);
        if (this.embedding.retrieval.embedding) this.embedding.vectors.replaceActiveSource("semantic", String(targetId), dense.map((chunk) => ({ ...chunk, corpus: "semantic", sourceId: String(targetId) })));
        this.audit("semantic", targetId!, action, context.source);
      }
      for (const id of deletedIds) {
        this.embedding.markCorpusMutation();
        this.storage.connection.prepare("DELETE FROM semantic_memory WHERE id=?").run(id);
        this.embedding.vectors.deleteActiveSource("semantic", String(id));
        this.audit("semantic", id, "delete", context.source);
      }
      // 模型自由文本理由只返回调用方；持久审计不保存可能包含私人正文的理由。
      this.storage.connection.prepare("INSERT INTO memory_changes(run_id, candidate_id, action, target_id, reason_code, deleted_ids, evidence_ids, session_id, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(context.runId, context.candidateId, action, targetId ?? null, decision.reasonCode, JSON.stringify(deletedIds), JSON.stringify(evidence.map((item) => item.messageId)), context.sessionId, context.source, nowUtc());
      if (context.source === "consolidation") {
        this.storage.connection.prepare("UPDATE consolidation_runs SET facts_created=facts_created+?, facts_updated=facts_updated+?, facts_skipped=facts_skipped+? WHERE run_id=?").run(Number(action === "create"), Number(action === "update"), Number(action === "noop"), context.runId);
      }
      return { action, reason: decision.reason, reasonCode: decision.reasonCode, ...(targetId === undefined ? {} : { targetId }), deletedIds };
    });
  }

  private audit(memoryType: string, memoryId: number, action: string, source: string): void {
    this.storage.connection.prepare("INSERT INTO memory_audit(memory_type, memory_id, action, source, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(memoryType, memoryId, action, source, nowUtc());
  }
}
