import type { DatabaseSync } from "node:sqlite";
import type { SemanticMemory } from "../../types.ts";
import { toMatchQuery } from "./search-text.ts";

interface Row extends Record<string, unknown> {}

/** 执行 Semantic Memory 的 FTS5 + 加权 BM25 检索。 */
export function searchSemanticLexical(database: DatabaseSync, query: string, limit: number): SemanticMemory[] {
  const match = toMatchQuery(query);
  if (!match) return [];
  return (database.prepare(`
    SELECT m.*, bm25(semantic_memory_fts, 2.0, 1.0) AS score
    FROM semantic_memory_fts f JOIN semantic_memory m ON m.id = f.rowid
    WHERE semantic_memory_fts MATCH ? ORDER BY score LIMIT ?
  `).all(match, limit) as Row[]).map((row) => ({
    id: Number(row.id), subject: String(row.subject), content: String(row.content), source: String(row.source),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at), score: Number(row.score),
  }));
}
