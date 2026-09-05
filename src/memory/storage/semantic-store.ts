import { toSearchText } from "../retrieve/index.ts";
import type { SemanticMemory } from "../types.ts";
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
    return (this.storage.connection.prepare("SELECT * FROM semantic_memory ORDER BY updated_at DESC, id DESC").all() as Row[]).map(semanticFromRow);
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
    return row ? semanticFromRow(row) : null;
  }

  private audit(memoryType: string, memoryId: number, action: string, source: string): void {
    this.storage.connection.prepare("INSERT INTO memory_audit(memory_type, memory_id, action, source, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(memoryType, memoryId, action, source, nowUtc());
  }
}
