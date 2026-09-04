import type { RankedCandidate } from "../types.ts";
import type { StoredChunk } from "./vector-store.ts";
import { cosineSimilarity } from "./vector.ts";

export interface DenseSource {
  sourceId: string;
  sessionId?: string;
  anchorMessageId?: number;
  bestChunkIndex: number;
}

/** 按 source 聚合最高 chunk cosine，应用阈值后返回 Top 50。 */
export function rankDenseSources(
  queryVector: Float32Array,
  chunks: readonly StoredChunk[],
  minimumSimilarity: number,
): RankedCandidate<DenseSource>[] {
  if (!Number.isFinite(minimumSimilarity) || minimumSimilarity < -1 || minimumSimilarity > 1) {
    throw new TypeError("minimumSimilarity 必须在 -1 到 1 之间");
  }
  const grouped = new Map<string, { best: StoredChunk; score: number; vectors: Float32Array[] }>();
  for (const chunk of chunks) {
    const score = cosineSimilarity(queryVector, chunk.vector);
    const current = grouped.get(chunk.sourceId);
    if (!current) grouped.set(chunk.sourceId, { best: chunk, score, vectors: [chunk.vector] });
    else {
      current.vectors.push(chunk.vector);
      if (score > current.score || (score === current.score && chunk.chunkIndex < current.best.chunkIndex)) {
        current.best = chunk; current.score = score;
      }
    }
  }
  return [...grouped.entries()]
    .filter(([, item]) => item.score >= minimumSimilarity)
    .sort(([leftId, left], [rightId, right]) => right.score - left.score || leftId.localeCompare(rightId))
    .slice(0, 50)
    .map(([id, item], index) => ({
      id, rank: index + 1, score: item.score, vectors: item.vectors,
      value: {
        sourceId: id, bestChunkIndex: item.best.chunkIndex,
        ...(item.best.sessionId ? { sessionId: item.best.sessionId } : {}),
        ...(item.best.anchorMessageId === undefined ? {} : { anchorMessageId: item.best.anchorMessageId }),
      },
    }));
}

