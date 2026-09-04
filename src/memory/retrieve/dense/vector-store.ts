import { DatabaseSync } from "node:sqlite";
import { vectorFromBlob, vectorToBlob } from "./vector.ts";

interface Row extends Record<string, unknown> {}

export interface StoredChunk {
  corpus: "semantic" | "session";
  sourceId: string;
  sessionId?: string;
  anchorMessageId?: number;
  chunkIndex: number;
  startOffset: number;
  endOffset: number;
  estimatedTokens: number;
  vector: Float32Array;
}

/** 在 SQLite 中维护互相隔离的向量 generation。事务由调用方控制。 */
export class SqliteVectorStore {
  private readonly database: DatabaseSync;

  constructor(database: DatabaseSync) { this.database = database }

  activeGenerationId(): string | null {
    const row = this.database.prepare("SELECT id FROM embedding_generations WHERE status = 'active'").get() as Row | undefined;
    return row ? String(row.id) : null;
  }

  activeProfileHash(): string | null {
    const row = this.database.prepare("SELECT profile_hash FROM embedding_generations WHERE status = 'active'").get() as Row | undefined;
    return row ? String(row.profile_hash) : null;
  }

  activeProfileJson(): string | null {
    const row = this.database.prepare("SELECT profile_json FROM embedding_generations WHERE status = 'active'").get() as Row | undefined;
    return row ? String(row.profile_json) : null;
  }

  createGeneration(profileJson: string, profileHash: string, chunkingVersion: number): string {
    const id = crypto.randomUUID();
    this.database.prepare(`
      INSERT INTO embedding_generations(id, status, profile_json, profile_hash, chunking_version, created_at)
      VALUES (?, 'building', ?, ?, ?, ?)
    `).run(id, profileJson, profileHash, chunkingVersion, new Date().toISOString());
    return id;
  }

  insertChunks(generationId: string, chunks: readonly StoredChunk[]): void {
    const insert = this.database.prepare(`
      INSERT INTO embedding_chunks(
        generation_id, corpus, source_id, session_id, anchor_message_id, chunk_index,
        start_offset, end_offset, estimated_tokens, vector
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const chunk of chunks) {
      insert.run(
        generationId, chunk.corpus, chunk.sourceId, chunk.sessionId ?? null,
        chunk.anchorMessageId ?? null, chunk.chunkIndex, chunk.startOffset, chunk.endOffset,
        chunk.estimatedTokens, vectorToBlob(chunk.vector),
      );
    }
  }

  replaceActiveSource(corpus: StoredChunk["corpus"], sourceId: string, chunks: readonly StoredChunk[]): void {
    const generationId = this.activeGenerationId();
    if (!generationId) throw new Error("Embedding active generation 不存在");
    this.database.prepare("DELETE FROM embedding_chunks WHERE generation_id = ? AND corpus = ? AND source_id = ?")
      .run(generationId, corpus, sourceId);
    this.insertChunks(generationId, chunks);
  }

  deleteActiveSource(corpus: StoredChunk["corpus"], sourceId: string): void {
    const generationId = this.activeGenerationId();
    if (generationId) this.database.prepare("DELETE FROM embedding_chunks WHERE generation_id = ? AND corpus = ? AND source_id = ?")
      .run(generationId, corpus, sourceId);
  }

  /** 删除 active generation 中属于一个 Session 的全部 run 向量。 */
  deleteActiveSession(sessionId: string): void {
    const generationId = this.activeGenerationId();
    if (generationId) {
      this.database.prepare("DELETE FROM embedding_chunks WHERE generation_id = ? AND corpus = 'session' AND session_id = ?")
        .run(generationId, sessionId);
    }
  }

  listActive(corpus: StoredChunk["corpus"]): StoredChunk[] {
    const generationId = this.activeGenerationId();
    if (!generationId) throw new Error("Embedding active generation 不存在");
    return (this.database.prepare(`
      SELECT * FROM embedding_chunks WHERE generation_id = ? AND corpus = ?
      ORDER BY source_id, chunk_index
    `).all(generationId, corpus) as Row[]).map(rowToChunk);
  }

  activate(generationId: string): void {
    const target = this.database.prepare("SELECT status FROM embedding_generations WHERE id = ?").get(generationId) as Row | undefined;
    if (target?.status !== "building") throw new Error("待激活的 Embedding generation 不存在");
    this.database.prepare("UPDATE embedding_generations SET status = 'interrupted' WHERE status = 'active'").run();
    const result = this.database.prepare("UPDATE embedding_generations SET status = 'active', activated_at = ? WHERE id = ? AND status = 'building'")
      .run(new Date().toISOString(), generationId);
    if (Number(result.changes) !== 1) throw new Error("Embedding generation 激活失败");
    this.database.prepare("DELETE FROM embedding_generations WHERE id <> ?").run(generationId);
  }

  deleteGeneration(generationId: string): void {
    this.database.prepare("DELETE FROM embedding_generations WHERE id = ? AND status <> 'active'").run(generationId);
  }

  /** 清空未激活 generation 的局部 chunks，并保留失败/取消状态供诊断。 */
  discardGeneration(generationId: string, status: "failed" | "cancelled" | "interrupted"): void {
    this.database.prepare("DELETE FROM embedding_chunks WHERE generation_id = ?").run(generationId);
    this.database.prepare("UPDATE embedding_generations SET status = ? WHERE id = ? AND status = 'building'")
      .run(status, generationId);
  }
}

function rowToChunk(row: Row): StoredChunk {
  const raw = row.vector;
  const blob = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer);
  return {
    corpus: String(row.corpus) as StoredChunk["corpus"], sourceId: String(row.source_id),
    ...(row.session_id === null ? {} : { sessionId: String(row.session_id) }),
    ...(row.anchor_message_id === null ? {} : { anchorMessageId: Number(row.anchor_message_id) }),
    chunkIndex: Number(row.chunk_index), startOffset: Number(row.start_offset), endOffset: Number(row.end_offset),
    estimatedTokens: Number(row.estimated_tokens), vector: vectorFromBlob(blob),
  };
}
