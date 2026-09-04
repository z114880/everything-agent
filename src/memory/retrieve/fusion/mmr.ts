import { cosineSimilarity } from "../dense/vector.ts";
import type { RankedCandidate } from "../types.ts";

export interface MmrCandidate<T> extends RankedCandidate<T> {
  relevance: number;
  redundancy: number;
  mmrScore: number;
  suppressedBy?: string;
}

export interface MmrResult<T> {
  selected: MmrCandidate<T>[];
  excludedAsDuplicate: Array<{ id: string; duplicateOf: string }>;
}

/** 使用固定 λ=0.7 执行 MMR，并在 MMR 内排除 cosine >= 0.999 的候选。 */
export function maximalMarginalRelevance<T>(
  candidates: readonly RankedCandidate<T>[],
  limit: number,
): MmrResult<T> {
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError("MMR limit 必须是正整数");
  const maxRelevance = Math.max(...candidates.map((item) => item.score), 0);
  const remaining = candidates.map((item) => ({ ...item, relevance: maxRelevance ? item.score / maxRelevance : 0 }));
  const selected: MmrCandidate<T>[] = [];
  const excludedAsDuplicate: Array<{ id: string; duplicateOf: string }> = [];
  while (remaining.length && selected.length < limit) {
    for (let index = remaining.length - 1; index >= 0; index -= 1) {
      const candidate = remaining[index]!;
      const duplicate = selected.find((item) => candidateSimilarity(candidate, item) >= 0.999);
      if (duplicate) {
        excludedAsDuplicate.push({ id: candidate.id, duplicateOf: duplicate.id });
        remaining.splice(index, 1);
      }
    }
    let bestIndex = -1;
    let best: MmrCandidate<T> | null = null;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index]!;
      const similarity = mostSimilar(candidate, selected);
      const evaluated: MmrCandidate<T> = {
        ...candidate,
        redundancy: similarity.score,
        mmrScore: 0.7 * candidate.relevance - 0.3 * similarity.score,
        ...(similarity.id ? { suppressedBy: similarity.id } : {}),
      };
      if (!best || evaluated.mmrScore > best.mmrScore
        || (evaluated.mmrScore === best.mmrScore && (evaluated.rank < best.rank
          || (evaluated.rank === best.rank && evaluated.id.localeCompare(best.id) < 0)))) {
        best = evaluated;
        bestIndex = index;
      }
    }
    if (!best || bestIndex < 0) break;
    remaining.splice(bestIndex, 1);
    selected.push(best);
  }
  return { selected, excludedAsDuplicate };
}

function mostSimilar<T>(candidate: RankedCandidate<T>, selected: readonly RankedCandidate<T>[]): { score: number; id?: string } {
  let score = 0;
  let id: string | undefined;
  for (const item of selected) {
    const current = Math.max(0, candidateSimilarity(candidate, item));
    if (current > score) { score = current; id = item.id }
  }
  return { score, ...(id ? { id } : {}) };
}

function candidateSimilarity<T>(left: RankedCandidate<T>, right: RankedCandidate<T>): number {
  let score = -1;
  for (const leftVector of left.vectors) {
    for (const rightVector of right.vectors) score = Math.max(score, cosineSimilarity(leftVector, rightVector));
  }
  return score;
}
