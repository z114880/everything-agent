import { describe, expect, it, vi } from "vitest";
import {
  chunkText,
  cosineSimilarity,
  rankDenseSources,
  maximalMarginalRelevance,
  normalizeVector,
  OpenAIEmbeddingClient,
  reciprocalRankFusion,
  vectorFromBlob,
  vectorToBlob,
} from "../index.ts";
import type { RankedCandidate } from "../index.ts";

function vector(first: number, second = 0): Float32Array {
  const value = new Float32Array(1024);
  value[0] = first;
  value[1] = second;
  const norm = Math.hypot(first, second);
  value[0] /= norm;
  value[1] /= norm;
  return value;
}

function candidate(id: string, rank: number, score: number, value = vector(1)): RankedCandidate<string> {
  return { id, value: id, rank, score, vectors: [value] };
}

describe("Memory Retrieval 算法", () => {
  it("在句末附近按估算 token 预算切块并保留重叠", () => {
    const chunks = chunkText("甲乙。丙丁戊己庚辛", {
      targetTokens: 5, maxTokens: 6, overlapTokens: 2, minimumTailTokens: 2,
    });

    expect(chunks).toEqual([
      { index: 0, text: "甲乙。", estimatedTokens: 3, startOffset: 0, endOffset: 3 },
      { index: 1, text: "乙。丙丁戊己", estimatedTokens: 6, startOffset: 1, endOffset: 7 },
      { index: 2, text: "戊己庚辛", estimatedTokens: 4, startOffset: 5, endOffset: 9 },
    ]);
  });

  it("切块器覆盖空文本、向后句界与非法参数", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("abcdefghijklmnopqrst。abcdefgh", {
      targetTokens: 5, maxTokens: 7, overlapTokens: 1, minimumTailTokens: 2,
    })[0]).toMatchObject({ text: "abcdefghijklmnopqrst。", estimatedTokens: 6 });
    expect(() => chunkText("x", { targetTokens: 0 })).toThrow("正整数");
    expect(() => chunkText("x", { targetTokens: 3, maxTokens: 2 })).toThrow("不能超过");
    expect(() => chunkText("x", { targetTokens: 2, maxTokens: 2, overlapTokens: 2 })).toThrow("必须小于");
  });

  it("固定使用 1024 维归一化向量并可往返 little-endian BLOB", () => {
    const raw = Array.from({ length: 1024 }, (_, index) => index < 2 ? 1 : 0);
    const normalized = normalizeVector(raw);
    expect(cosineSimilarity(normalized, normalized)).toBeCloseTo(1, 6);
    expect(vectorFromBlob(vectorToBlob(normalized))).toEqual(normalized);
    expect(() => normalizeVector([1, 2])).toThrow("1024");
    expect(() => normalizeVector(Array(1024).fill(0))).toThrow("零向量");
    expect(() => normalizeVector([...Array(1023).fill(0), Number.NaN])).toThrow("非法数值");
    expect(() => cosineSimilarity(new Float32Array(3), new Float32Array(3))).toThrow("1024");
    expect(() => vectorFromBlob(new Uint8Array(2))).toThrow("BLOB");
  });

  it("通过移动前一块边界保证短尾块达到最小估算量", () => {
    const chunks = chunkText("a".repeat(2_080));
    expect(chunks.at(-1)?.estimatedTokens).toBeGreaterThanOrEqual(80);
    expect(chunks.every((chunk) => chunk.estimatedTokens <= 512)).toBe(true);
  });

  it("以固定 k=60 等权融合，并使用稳定规则打破平分", () => {
    const result = reciprocalRankFusion(
      [candidate("dense-only", 1, 0.9), candidate("both", 2, 0.8)],
      [candidate("both", 1, -2), candidate("lexical-only", 2, -1)],
    );

    expect(result.map((item) => item.id)).toEqual(["both", "dense-only", "lexical-only"]);
    expect(result[0]).toMatchObject({ denseRank: 2, lexicalRank: 1, rank: 1 });
  });

  it("MMR 偏向相关性并在内部排除几乎完全重复的向量", () => {
    const result = maximalMarginalRelevance([
      candidate("a", 1, 1, vector(1, 0)),
      candidate("duplicate", 2, 0.99, vector(1, 0)),
      candidate("different", 3, 0.7, vector(0, 1)),
    ], 3);

    expect(result.selected.map((item) => item.id)).toEqual(["a", "different"]);
    expect(result.excludedAsDuplicate).toEqual([{ id: "duplicate", duplicateOf: "a" }]);
    expect(result.selected[1]?.redundancy).toBe(0);
    expect(result.selected[1]?.mmrScore).toBeCloseTo(0.49, 8);
  });

  it("Dense 按 source 取最佳 chunk、保留全部向量并稳定限制 Top 50", () => {
    const chunks = Array.from({ length: 52 }, (_, index) => ({
      corpus: "semantic" as const, sourceId: String(index).padStart(2, "0"), chunkIndex: 0,
      startOffset: 0, endOffset: 1, estimatedTokens: 1, vector: vector(1, index / 100),
    }));
    chunks.push({ ...chunks[0]!, chunkIndex: 1, vector: vector(0, 1) });
    const result = rankDenseSources(vector(1), chunks, -1);
    expect(result).toHaveLength(50);
    expect(result[0]).toMatchObject({ id: "00", value: { bestChunkIndex: 0 } });
    expect(result[0]?.vectors).toHaveLength(2);
    const updated = rankDenseSources(vector(1), [
      { ...chunks[0]!, vector: vector(0, 1) },
      { ...chunks[0]!, chunkIndex: 2, vector: vector(1) },
      { ...chunks[0]!, chunkIndex: 1, vector: vector(1) },
    ], 0);
    expect(updated[0]?.value.bestChunkIndex).toBe(1);
    expect(() => rankDenseSources(vector(1), chunks, 2)).toThrow("minimumSimilarity");
  });

  it("MMR 和 RRF 覆盖空输入、非法限制、负相似度与单路候选", () => {
    expect(maximalMarginalRelevance([], 2)).toEqual({ selected: [], excludedAsDuplicate: [] });
    expect(() => maximalMarginalRelevance([], 0)).toThrow("正整数");
    const negative = maximalMarginalRelevance([
      candidate("a", 1, 1, vector(1)), candidate("b", 2, 0.5, vector(-1)),
    ], 2);
    expect(negative.selected[1]?.redundancy).toBe(0);
    expect(reciprocalRankFusion([], [candidate("only", 1, 1)])).toMatchObject([{ id: "only", lexicalRank: 1 }]);
    const withoutDenseVector = { ...candidate("both", 1, 1), vectors: [] };
    expect(reciprocalRankFusion([withoutDenseVector], [candidate("both", 1, 1)])[0]?.vectors).toHaveLength(1);
    const zeroRelevance = maximalMarginalRelevance([
      candidate("b", 2, 0, vector(0, 1)), candidate("a", 1, 0, vector(1)),
    ], 2);
    expect(zeroRelevance.selected.map((item) => item.id)).toEqual(["a", "b"]);
    expect(maximalMarginalRelevance([
      { ...candidate("empty-a", 1, 1), vectors: [] },
      { ...candidate("empty-b", 2, 0.5), vectors: [] },
    ], 2).selected).toHaveLength(2);
    expect(reciprocalRankFusion(
      [candidate("z", 1, 1), candidate("a", 2, 1)],
      [candidate("a", 1, 1), candidate("z", 2, 1)],
    ).map((item) => item.id)).toEqual(["z", "a"]);
  });

  it("Embedding HTTP adapter 强制 dimensions=1024 并按响应 index 还原顺序", async () => {
    const observer = vi.fn();
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(JSON.parse(String(init.body))).toMatchObject({ model: "embed", dimensions: 1024, input: ["甲", "乙"] });
      return new Response(JSON.stringify({ data: [
        { index: 1, embedding: Array.from(vector(0, 1)) },
        { index: 0, embedding: Array.from(vector(1, 0)) },
      ], usage: { prompt_tokens: 2, total_tokens: 2 } }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new OpenAIEmbeddingClient({
      baseUrl: "https://embedding.example/v1", apiKey: "secret", model: "embed",
      queryTemplate: "{text}", documentTemplate: "{text}", minimumSimilarity: 0.3,
    });

    const result = await client.embed(["甲", "乙"], [1, 1], { purpose: "query", observer });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.map((item) => item.index)).toEqual([0, 1]);
    expect(observer.mock.calls.map(([kind]) => kind)).toEqual(["embedding_started", "embedding_completed"]);
    expect(observer.mock.calls[1]?.[1]).toMatchObject({
      estimatedTokens: 2,
      tokenUsage: { inputTokens: 2, outputTokens: 0, totalTokens: 2 },
    });
    vi.unstubAllGlobals();
  });

  it("Embedding HTTP 失败零重试，trace 不包含 API Key", async () => {
    const observer = vi.fn();
    const fetchMock = vi.fn(async () => new Response("sensitive", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new OpenAIEmbeddingClient({
      baseUrl: "https://embedding.example/v1", apiKey: "super-secret", model: "embed",
      queryTemplate: "{text}", documentTemplate: "{text}", minimumSimilarity: 0.3,
    });
    await expect(client.embed(["甲"], [1], { purpose: "query", observer })).rejects.toThrow("HTTP 429");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(observer.mock.calls)).not.toContain("super-secret");
    expect(JSON.stringify(observer.mock.calls)).not.toContain("sensitive");
  });

  it("Embedding adapter 校验输入 token、响应数量、index 与向量", async () => {
    const client = new OpenAIEmbeddingClient({
      baseUrl: "https://embedding.example/v1", apiKey: "secret", model: "embed",
      queryTemplate: "{text}", documentTemplate: "{text}", minimumSimilarity: 0.3,
    });
    await expect(client.embed([], [], { purpose: "query" })).rejects.toThrow("不能为空");
    await expect(client.embed(["x"], [], { purpose: "query" })).rejects.toThrow("一一对应");
    await expect(client.embed(["x"], [0], { purpose: "query" })).rejects.toThrow("token 数");

    for (const data of [
      [],
      [{ embedding: Array.from(vector(1)) }],
      [{ index: 2, embedding: Array.from(vector(1)) }],
      [{ index: 0, embedding: [1, 2] }],
    ]) {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data }), { status: 200 })));
      await expect(client.embed(["x"], [1], { purpose: "query" })).rejects.toThrow();
    }
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [
      { index: 0, embedding: Array.from(vector(1)) },
      { index: 0, embedding: Array.from(vector(1)) },
    ] }), { status: 200 })));
    await expect(client.embed(["x", "y"], [1, 1], { purpose: "query" })).rejects.toThrow("重复");
    vi.unstubAllGlobals();
  });

  it("Embedding adapter 按 16 条和 8192 tokens 串行拆批", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const input = (JSON.parse(String(init.body)) as { input: string[] }).input;
      return new Response(JSON.stringify({ data: input.map((_, index) => ({ index, embedding: Array.from(vector(1)) })) }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new OpenAIEmbeddingClient({
      baseUrl: "https://embedding.example/v1/", apiKey: "secret", model: "embed",
      queryTemplate: "{text}", documentTemplate: "{text}", minimumSimilarity: 0.3,
    });
    const texts = Array.from({ length: 17 }, (_, index) => `x${index}`);
    expect(await client.embed(texts, Array(17).fill(500), { purpose: "rebuild", rebuildId: "r" })).toHaveLength(17);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const controller = new AbortController();
    expect(await client.embed(["large-a", "large-b"], [5_000, 5_000], {
      purpose: "query", runId: "run", signal: controller.signal,
    })).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    vi.unstubAllGlobals();
  });
});
