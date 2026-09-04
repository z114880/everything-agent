import type { RankedCandidate } from "../types.ts";

export interface FusedCandidate<T> extends RankedCandidate<T> {
  denseRank?: number;
  lexicalRank?: number;
}

/** 以固定 k=60 和 1:1 权重融合两条排名列表。 */
export function reciprocalRankFusion<T>(
  dense: readonly RankedCandidate<T>[],
  lexical: readonly RankedCandidate<T>[],
): FusedCandidate<T>[] {
  const byId = new Map<string, FusedCandidate<T>>();
  addRoute(byId, dense.slice(0, 50), "denseRank");
  addRoute(byId, lexical.slice(0, 50), "lexicalRank");
  return [...byId.values()]
    .sort((left, right) => right.score - left.score
      || rank(left.denseRank) - rank(right.denseRank)
      || rank(left.lexicalRank) - rank(right.lexicalRank)
      || left.id.localeCompare(right.id))
    .map((item, index) => ({ ...item, rank: index + 1 }));
}

function addRoute<T>(
  output: Map<string, FusedCandidate<T>>,
  candidates: readonly RankedCandidate<T>[],
  rankKey: "denseRank" | "lexicalRank",
): void {
  candidates.forEach((candidate, index) => {
    const routeRank = index + 1;
    const existing = output.get(candidate.id);
    if (existing) {
      existing.score += 1 / (60 + routeRank);
      existing[rankKey] = routeRank;
      if (!existing.vectors.length && candidate.vectors.length) existing.vectors = candidate.vectors;
      return;
    }
    output.set(candidate.id, {
      ...candidate, rank: 0, score: 1 / (60 + routeRank), [rankKey]: routeRank,
    });
  });
}

function rank(value: number | undefined): number { return value ?? Number.MAX_SAFE_INTEGER }

