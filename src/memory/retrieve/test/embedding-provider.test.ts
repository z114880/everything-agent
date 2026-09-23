import { afterEach, expect, it, vi } from "vitest";
import { EmbeddingClient, type EmbeddingProfile } from "../index.ts";

const profile: EmbeddingProfile = {
  provider: "gemini", baseUrl: "https://embedding.example/v1beta/", model: "models/gemini-embedding-001", apiKey: "private-gemini-key",
  queryTemplate: "{text}", documentTemplate: "{text}", minimumSimilarity: 0.3,
};
const vector = (index = 0) => Array.from({ length: 1024 }, (_, i) => i === index ? 2 : 0);
afterEach(() => vi.unstubAllGlobals());

it.each(["query", "rebuild", "memory_create"] as const)("Gemini 向量按用途 %s 设置任务类型，并记录真实用量与 Provider", async (purpose) => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ embeddings: [{ values: vector(0) }, { values: vector(1) }], usageMetadata: { promptTokenCount: 7 } }));
  vi.stubGlobal("fetch", fetcher);
  const observer = vi.fn();
  const result = await new EmbeddingClient(profile).embed(["甲", "乙"], [1, 1], { purpose, observer });
  expect(fetcher).toHaveBeenCalledWith("https://embedding.example/v1beta/models/gemini-embedding-001:batchEmbedContents", expect.objectContaining({
    headers: { "x-goog-api-key": "private-gemini-key", "Content-Type": "application/json" },
  }));
  expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({ requests: ["甲", "乙"].map(text => ({
    model: "models/gemini-embedding-001", content: { parts: [{ text }] },
    embedContentConfig: { taskType: purpose === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT", outputDimensionality: 1024, autoTruncate: false },
  })) });
  expect(result.map(item => item.index)).toEqual([0, 1]);
  expect(result[0]!.vector[0]).toBe(1);
  expect(result[1]!.vector[1]).toBe(1);
  expect(observer.mock.calls.map(([kind]) => kind)).toEqual(["embedding_started", "embedding_completed"]);
  expect(observer.mock.calls[1]![1]).toMatchObject({ provider: "gemini", tokenUsage: { inputTokens: 7, outputTokens: 0, totalTokens: 7 } });
  expect(JSON.stringify(observer.mock.calls)).not.toContain("private-gemini-key");
});

it("Gemini 向量按批次拆分，缺少真实用量时不使用估算量替代", async () => {
  const fetcher = vi.fn(async (_url, init) => Response.json({ embeddings: JSON.parse(init.body).requests.map(() => ({ values: vector() })) }));
  vi.stubGlobal("fetch", fetcher);
  const observer = vi.fn();
  const result = await new EmbeddingClient({ ...profile, model: "gemini-embedding-001" }).embed(Array(17).fill("文本"), Array(17).fill(1), { purpose: "rebuild", observer });
  expect(result.map(item => item.index)).toEqual(Array.from({ length: 17 }, (_, i) => i));
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(observer.mock.calls[1]![1].tokenUsage).toBeNull();
});

it.each([
  [{ embeddings: [] }, "数量"],
  [{ embeddings: [{ values: [1, 0] }] }, "1024"],
  [{ embeddings: [{ values: Array(1024).fill(0) }] }, "零"],
])("Gemini 拒绝无效向量结果 %j", async (response, error) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(response)));
  await expect(new EmbeddingClient(profile).embed(["文本"], [2], { purpose: "query" })).rejects.toThrow(error);
});

it("Gemini 网络失败不重试、不记录响应正文，取消会传递给请求", async () => {
  const observer = vi.fn();
  const fetcher = vi.fn().mockResolvedValue(new Response("private-gemini-key", { status: 403 }));
  vi.stubGlobal("fetch", fetcher);
  await expect(new EmbeddingClient(profile).embed(["文本"], [2], { purpose: "query", observer })).rejects.toThrow("HTTP 403");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(observer.mock.calls.map(([kind]) => kind)).toEqual(["embedding_started", "embedding_failed"]);
  expect(observer.mock.calls[1]![1]).toMatchObject({ provider: "gemini" });
  expect(JSON.stringify(observer.mock.calls)).not.toContain("private-gemini-key");
  const controller = new AbortController();
  controller.abort(new Error("用户取消"));
  fetcher.mockImplementation(async (_url, init) => { init.signal.throwIfAborted(); });
  await expect(new EmbeddingClient(profile).embed(["文本"], [2], { purpose: "query", signal: controller.signal })).rejects.toThrow("用户取消");
});
