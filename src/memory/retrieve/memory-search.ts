import { maximalMarginalRelevance, rankDenseSources, reciprocalRankFusion, searchSemanticLexical, searchSessionLexical } from "./index.ts";
import type { RankedCandidate } from "./index.ts";
import type { SemanticMemory } from "../types.ts";
import type { Row } from "../storage/records.ts";
import type { SemanticStore } from "../storage/semantic-store.ts";
import type { MemoryDatabase } from "../storage/database.ts";
import type { EmbeddingIndex } from "./embedding-index.ts";

/** 独立候选池检索、融合排序与 Session 去重。 */
export class MemorySearch {
  private readonly storage: MemoryDatabase;
  private readonly embedding: EmbeddingIndex;
  private readonly semantic: SemanticStore;

  constructor(storage: MemoryDatabase, embedding: EmbeddingIndex, semantic: SemanticStore) {
    this.storage = storage;
    this.embedding = embedding;
    this.semantic = semantic;
  }

  /** 按全局模式搜索 Semantic Memory；Dense 与 Lexical 始终在独立候选池中执行。 */
  async searchSemantic(query: string, limit = 100, providedQueryVector?: Float32Array, runId?: string, observer = this.embedding.retrieval.observer): Promise<SemanticMemory[]> {
    const clean = query.trim(); if (!clean) return [];
    const lexical = searchSemanticLexical(this.storage.connection, clean, 50);
    await observer?.("lexical_retrieval_completed", { corpus: "semantic", candidateCount: lexical.length });
    if (this.embedding.retrieval.mode === "lexical_only") return lexical.slice(0, limit);
    const queryVector = providedQueryVector ?? await this.embedding.embedQuery(clean, runId, observer);
    const stored = this.embedding.vectors.listActive("semantic");
    const dense = rankDenseSources(queryVector, stored, this.embedding.retrieval.embedding!.profile.minimumSimilarity);
    await observer?.("dense_retrieval_completed", { corpus: "semantic", candidateCount: dense.length });
    if (this.embedding.retrieval.mode === "dense_only") {
      const selected = maximalMarginalRelevance(dense, limit);
      await observer?.("mmr_completed", mmrEvent("semantic", selected));
      return selected.selected.flatMap((item) => {
        const memory = this.semantic.getSemantic(Number(item.id)); return memory ? [{ ...memory, score: item.score }] : [];
      });
    }
    const vectorsBySource = new Map<string, Float32Array[]>();
    for (const chunk of stored) {
      const values = vectorsBySource.get(chunk.sourceId) ?? [];
      values.push(chunk.vector); vectorsBySource.set(chunk.sourceId, values);
    }
    const lexicalCandidates: RankedCandidate<unknown>[] = lexical.map((item, index) => ({
      id: String(item.id), value: item, rank: index + 1, score: -(item.score ?? 0),
      vectors: vectorsBySource.get(String(item.id)) ?? [],
    }));
    const fused = reciprocalRankFusion(dense as RankedCandidate<unknown>[], lexicalCandidates);
    await observer?.("rrf_completed", { corpus: "semantic", candidateCount: fused.length });
    const selected = maximalMarginalRelevance(fused, limit);
    await observer?.("mmr_completed", mmrEvent("semantic", selected));
    return selected.selected.flatMap((item) => {
      const memory = this.semantic.getSemantic(Number(item.id)); return memory ? [{ ...memory, score: item.score }] : [];
    });
  }

  async sessionSearchCandidates(query: string, currentSessionId?: string, providedQueryVector?: Float32Array, runId?: string, observer = this.embedding.retrieval.observer): Promise<SearchCandidate[]> {
    const lexical = this.searchCandidates(query, currentSessionId).slice(0, 50);
    await observer?.("lexical_retrieval_completed", { corpus: "session", candidateCount: lexical.length });
    if (this.embedding.retrieval.mode === "lexical_only") {
      // Lexical 先按 run 排名；对外返回前必须保留每个 Session 的最佳 run，避免单个长会话挤占名额。
      const unique = new Map<string, SearchCandidate>();
      for (const item of lexical) if (!unique.has(item.sessionId)) unique.set(item.sessionId, item);
      return [...unique.values()];
    }
    const queryVector = providedQueryVector ?? await this.embedding.embedQuery(query, runId, observer);
    const stored = this.embedding.vectors.listActive("session").filter((item) => item.sessionId !== currentSessionId);
    const denseRanked = rankDenseSources(queryVector, stored, this.embedding.retrieval.embedding!.profile.minimumSimilarity);
    const dense: RankedCandidate<SearchCandidate>[] = denseRanked.flatMap((item) => item.value.sessionId ? [{
      ...item,
      value: {
        sourceId: item.id, sessionId: item.value.sessionId,
        ...(item.value.anchorMessageId === undefined ? {} : { messageId: item.value.anchorMessageId }),
        score: item.score, vectors: [...item.vectors], totalMatches: 1,
      },
    }] : []);
    await observer?.("dense_retrieval_completed", { corpus: "session", candidateCount: dense.length });
    const ranked = this.embedding.retrieval.mode === "dense_only"
      ? dense
      : reciprocalRankFusion(
        dense,
        lexical.map((item, index) => ({
          id: item.sourceId, value: item, rank: index + 1, score: -(item.bm25 ?? 0),
          vectors: stored.filter((chunk) => chunk.sourceId === item.sourceId).map((chunk) => chunk.vector),
        })),
      );
    if (this.embedding.retrieval.mode === "hybrid") {
      await observer?.("rrf_completed", { corpus: "session", candidateCount: ranked.length });
    }
    // Session Recall 对外返回不同 Session；同一 Session 的次优 run 不再竞争名额。
    const unique = new Map<string, RankedCandidate<SearchCandidate>>();
    for (const item of ranked) if (!unique.has(item.value.sessionId)) unique.set(item.value.sessionId, item);
    const selected = maximalMarginalRelevance([...unique.values()], SEARCH_SESSION_LIMIT);
    await observer?.("mmr_completed", mmrEvent("session", selected));
    const denseScores = new Map(dense.map((item) => [item.id, item.score]));
    return selected.selected.map((item) => {
      const denseScore = denseScores.get(item.id);
      return {
        ...item.value,
        ...(denseScore === undefined ? {} : { dense: denseScore }),
        ...(this.embedding.retrieval.mode === "hybrid" ? { fused: item.score } : {}),
        mmr: item.mmrScore,
        score: item.score,
        vectors: [...item.vectors],
      };
    });
  }

  private searchCandidates(query: string, currentSessionId?: string): SearchCandidate[] {
    return searchSessionLexical(this.storage.connection, query, currentSessionId);
  }

  recentCandidates(currentSessionId: string | undefined, limit: number): SearchCandidate[] {
    const rows = this.storage.connection.prepare(`
      SELECT s.id FROM sessions s WHERE (? = '' OR s.id <> ?)
        AND EXISTS (
          SELECT 1 FROM chat_log c
          WHERE c.session_id = s.id AND c.kind = 'assistant_message'
        )
      ORDER BY s.updated_at DESC, s.id ASC LIMIT ?
    `).all(currentSessionId ?? "", currentSessionId ?? "", limit) as Row[];
    return rows.map((row) => ({ sourceId: `recent:${row.id}`, sessionId: String(row.id), totalMatches: 0 }));
  }
}

export const SEARCH_SESSION_LIMIT = 20;

export interface SearchCandidate {
  sourceId: string; sessionId: string; messageId?: number; bm25?: number; dense?: number;
  fused?: number; mmr?: number; score?: number; vectors?: Float32Array[]; totalMatches: number;
}

function mmrEvent(corpus: "semantic" | "session", result: { selected: Array<{ id: string; relevance: number; redundancy: number; mmrScore: number; suppressedBy?: string }>; excludedAsDuplicate: Array<{ id: string; duplicateOf: string }> }): Record<string, unknown> {
  return {
    corpus,
    selected: result.selected.map((item) => ({
      id: item.id, relevance: item.relevance, redundancy: item.redundancy,
      mmrScore: item.mmrScore, ...(item.suppressedBy ? { suppressedBy: item.suppressedBy } : {}),
    })),
    excludedAsDuplicate: result.excludedAsDuplicate,
  };
}
