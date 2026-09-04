import type { DatabaseSync } from "node:sqlite";
import { toMatchQuery } from "./search-text.ts";

interface Row extends Record<string, unknown> {}

export interface LexicalSessionCandidate {
  sourceId: string;
  sessionId: string;
  messageId: number;
  bm25: number;
  totalMatches: number;
}

/** 检索消息级 FTS 命中，并在进入融合前按成功 run 聚合最佳 BM25。 */
export function searchSessionLexical(database: DatabaseSync, query: string, currentSessionId?: string): LexicalSessionCandidate[] {
  const match = toMatchQuery(query);
  if (!match) return [];
  const rows = database.prepare(`
    SELECT c.session_id, c.run_id, c.id AS message_id, bm25(chat_log_fts) AS bm25, s.updated_at
    FROM chat_log_fts f JOIN chat_log c ON c.id = f.rowid JOIN sessions s ON s.id = c.session_id
    WHERE chat_log_fts MATCH ? AND (? = '' OR c.session_id <> ?)
    ORDER BY bm25 ASC, s.updated_at DESC, c.session_id ASC, c.id ASC LIMIT 2000
  `).all(match, currentSessionId ?? "", currentSessionId ?? "") as Row[];
  const grouped = new Map<string, LexicalSessionCandidate>();
  for (const row of rows) {
    const sourceId = String(row.run_id);
    const current = grouped.get(sourceId);
    if (current) current.totalMatches += 1;
    else grouped.set(sourceId, {
      sourceId, sessionId: String(row.session_id), messageId: Number(row.message_id),
      bm25: Number(row.bm25), totalMatches: 1,
    });
  }
  return [...grouped.values()];
}
