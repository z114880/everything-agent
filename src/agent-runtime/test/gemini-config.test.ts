import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createAgentRuntime, type AgentRuntime } from "../index.ts";

const resources: Array<{ runtime: AgentRuntime; home: string }> = [];
afterEach(async () => {
  for (const { runtime, home } of resources.splice(0)) { await runtime.close(); await rm(home, { recursive: true, force: true }); }
  vi.unstubAllGlobals();
});
async function setup() {
  const home = await mkdtemp(join(tmpdir(), "gemini-config-"));
  const runtime = createAgentRuntime({ home, defaultSystemPromptPath: join(home, "default.md") });
  resources.push({ runtime, home });
  return { runtime, home };
}
const connection = { provider: "gemini" as const, model: "gemini-test", apiKey: "google-test-key" };

it("分别探测 Gemini 双模型，处理分页并只返回支持生成的模型，密钥只落在本地 env", async () => {
  const { runtime, home } = await setup();
  const fetcher = vi.fn()
    .mockResolvedValueOnce(Response.json({ models: [
      { name: "models/gemini-a", supportedGenerationMethods: ["generateContent"] },
      { name: "models/embedding", supportedGenerationMethods: ["embedContent"] }, {},
    ], nextPageToken: "next page" }))
    .mockResolvedValueOnce(Response.json({ models: [{ name: "models/gemini-b", supportedGenerationMethods: ["generateContent"] }] }))
    .mockResolvedValueOnce(Response.json({ models: [{ name: "models/gemini-small", supportedGenerationMethods: ["generateContent"] }] }));
  vi.stubGlobal("fetch", fetcher);
  const result = await runtime.saveAgentSettings({
    agentModel: connection, smallModel: { ...connection, baseUrl: "https://gemini.example/v1beta/", apiKey: "small-google-key" },
  });
  expect(result.models).toEqual({ agentModel: ["gemini-a", "gemini-b"], smallModel: ["gemini-small"] });
  expect(fetcher.mock.calls[0]![0]).toBe("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000");
  expect(fetcher.mock.calls[1]![0]).toContain("pageToken=next+page");
  expect(fetcher.mock.calls[2]![0]).toBe("https://gemini.example/v1beta/models?pageSize=1000");
  expect(fetcher.mock.calls[0]![1].headers).toEqual({ "x-goog-api-key": "google-test-key" });
  expect(result.settings.agentModel).toMatchObject({ provider: "gemini", keyConfigured: true, keyLast4: "-key" });
  expect(JSON.stringify(result)).not.toContain("google-test-key");
  expect(await readFile(join(home, ".env"), "utf8")).toContain('EVERYTHING_AGENT_API_KEY="google-test-key"');
  const config = await readFile(join(home, "config.json"), "utf8");
  expect(config).toContain('"provider": "gemini"');
  expect(config).not.toContain("google-test-key");
  expect((await runtime.getSettings()).smallModel.provider).toBe("gemini");
});

it("Gemini 探测失败脱敏且不覆盖旧值，显式强制保存后切换协议会清除旧密钥", async () => {
  const { runtime } = await setup();
  await runtime.saveAgentSettings({ agentModel: connection, smallModel: connection, force: true });
  const fetcher = vi.fn().mockResolvedValue(new Response("invalid new-secret", { status: 401 }));
  vi.stubGlobal("fetch", fetcher);
  const changed = { ...connection, apiKey: "new-secret", model: "changed" };
  await expect(runtime.saveAgentSettings({ agentModel: changed, smallModel: connection })).rejects.toMatchObject({
    canForce: true, message: "Agent Model：连接测试失败（HTTP 401）：invalid ***",
  });
  expect((await runtime.getSettings()).agentModel.model).toBe("gemini-test");
  await runtime.saveAgentSettings({ agentModel: changed, smallModel: connection, force: true });
  expect((await runtime.getSettings()).agentModel.model).toBe("changed");
  await runtime.saveAgentSettings({ agentModel: { provider: "anthropic", model: "test" }, smallModel: connection });
  expect((await runtime.getSettings()).agentModel.keyConfigured).toBe(false);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("重复分页游标及时停止，空列表仍可保存手工填写的模型", async () => {
  const { runtime } = await setup();
  const fetcher = vi.fn().mockImplementation(async () => Response.json({ nextPageToken: "repeat" }));
  vi.stubGlobal("fetch", fetcher);
  expect((await runtime.saveAgentSettings({ agentModel: connection, smallModel: connection })).models)
    .toEqual({ agentModel: [], smallModel: [] });
  expect(fetcher).toHaveBeenCalledTimes(4);
});

it("Gemini 双模型可完成真实 Runtime 回合，历史工具签名与真实用量进入会话和 Trace", async () => {
  const { runtime } = await setup();
  await runtime.saveAgentSettings({ agentModel: connection, smallModel: connection, force: true });
  let mainCalls = 0;
  const payloads: Array<Record<string, any>> = [];
  const part = { functionCall: { name: "get_current_time", args: {}, id: "clock-call" }, thoughtSignature: "persisted-signature" };
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (!body.tools?.length) return Response.json({ candidates: [{ content: { parts: [{ text: '{"intent":"none"}' }] }, finishReason: "STOP" }] });
    mainCalls++;
    payloads.push(body);
    const payload = {
      candidates: [{ content: { parts: mainCalls === 1 ? [part] : [{ text: "完成" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 3, thoughtsTokenCount: 2, totalTokenCount: 25 },
    };
    expect(url).toContain(":streamGenerateContent?alt=sse");
    return new Response(`data: ${JSON.stringify(payload)}\n\n`);
  });
  vi.stubGlobal("fetch", fetcher);
  const session = await runtime.createSession();
  const options = { observer: vi.fn(), signal: new AbortController().signal };
  const first = await runtime.run({ sessionId: session.id, prompt: "现在几点" }, options);
  expect(first).toMatchObject({ reply: "完成", provider: "gemini", toolCallCount: 1 });
  await runtime.run({ sessionId: session.id, prompt: "继续" }, options);
  expect(payloads[2]!.contents.some((item: { parts: unknown[] }) => JSON.stringify(item.parts) === JSON.stringify([part]))).toBe(true);
  const records = (await runtime.readTraces()).flatMap(file => file.records);
  expect(records.find(record => record.type === "model_response")?.payload).toMatchObject({
    provider: "gemini", tokenUsage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
  });
  expect(JSON.stringify(records)).not.toContain("google-test-key");
});

it("Embedding Provider 独立保存到配置，切换后不复用旧密钥并要求重建索引", async () => {
  const { runtime, home } = await setup();
  const base = { agentModel: connection, smallModel: connection, force: true,
    embeddingBaseUrl: "https://embedding.example/v1", embeddingModel: "embed", embeddingApiKey: "openai-embedding-key" };
  await runtime.saveAgentSettings({ ...base, embeddingProvider: "openai-compatible" });
  await runtime.rebuildEmbeddingIndex();
  expect((await runtime.getSettings()).embeddingIndex.ready).toBe(true);
  await runtime.saveAgentSettings({ ...base, embeddingProvider: "gemini", embeddingApiKey: "" });
  expect(await runtime.getSettings()).toMatchObject({ embeddingProvider: "gemini", embeddingKeyConfigured: false, embeddingIndex: { ready: false } });
  expect(await readFile(join(home, ".env"), "utf8")).not.toContain("openai-embedding-key");
  await runtime.saveAgentSettings({ ...base, embeddingProvider: "gemini", embeddingApiKey: "new-gemini-key" });
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await expect(runtime.prepareMemory()).rejects.toThrow("请先重建向量索引");
  expect(fetcher).not.toHaveBeenCalled();
  await runtime.rebuildEmbeddingIndex();
  expect((await runtime.getSettings()).embeddingIndex.ready).toBe(true);
  expect(runtime.memory.activeEmbeddingProfile()).toMatchObject({ provider: "gemini" });
  expect(JSON.parse(await readFile(join(home, "config.json"), "utf8")).retrieval.embedding.provider).toBe("gemini");
  expect(await readFile(join(home, "config.json"), "utf8")).not.toContain("new-gemini-key");
});

it("Gemini 重建真实记忆索引后可检索，Trace 带向量 Provider 和真实 token 用量", async () => {
  const { runtime } = await setup();
  const fact = await runtime.memory.createSemantic("偏好", "喜欢红茶");
  await runtime.saveAgentSettings({ agentModel: connection, smallModel: connection, force: true,
    retrievalMode: "dense_only", embeddingProvider: "gemini", embeddingApiKey: "vector-key",
    embeddingBaseUrl: "https://gemini.example/v1beta", embeddingModel: "gemini-embedding-001",
  });
  const fetcher = vi.fn(async (_url, init) => Response.json({
    embeddings: JSON.parse(init.body).requests.map(() => ({ values: Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0) })),
    usageMetadata: { promptTokenCount: 5 },
  }));
  vi.stubGlobal("fetch", fetcher);
  await runtime.rebuildEmbeddingIndex();
  await runtime.prepareMemory();
  expect((await runtime.memory.searchSemantic("喜欢什么饮品", 5))[0]?.id).toBe(fact.id);
  const requests = fetcher.mock.calls.map(call => JSON.parse(call[1].body));
  expect(requests[0].requests[0].embedContentConfig.taskType).toBe("RETRIEVAL_DOCUMENT");
  expect(requests.at(-1).requests[0].embedContentConfig.taskType).toBe("RETRIEVAL_QUERY");
  const records = (await runtime.readTraces()).flatMap(file => file.records);
  expect(records.find(record => record.type === "embedding_completed")?.payload).toMatchObject({
    provider: "gemini", tokenUsage: { inputTokens: 5, outputTokens: 0, totalTokens: 5 },
  });
});

it("切换向量 Provider 后重建失败保留原错误与旧索引，不残留允许不完整索引的配置", async () => {
  const { runtime } = await setup();
  await runtime.memory.createSemantic("饮品", "喜欢红茶");
  const base = { agentModel: connection, smallModel: connection, force: true,
    embeddingModel: "embedding", embeddingApiKey: "embedding-key", embeddingBaseUrl: "https://embedding.example/v1" };
  await runtime.saveAgentSettings({ ...base, embeddingProvider: "openai-compatible" });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ data: [{ index: 0, embedding: Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0) }] })));
  await runtime.rebuildEmbeddingIndex();
  const previous = runtime.memory.embeddingIndexStatus().generationId;
  await runtime.saveAgentSettings({ ...base, embeddingProvider: "gemini" });
  const fetcher = vi.fn().mockResolvedValue(new Response("failed", { status: 503 }));
  vi.stubGlobal("fetch", fetcher);
  await expect(runtime.rebuildEmbeddingIndex()).rejects.toThrow("HTTP 503");
  expect(runtime.memory.embeddingIndexStatus().generationId).toBe(previous);
  await expect(runtime.prepareMemory()).rejects.toThrow("请先重建向量索引");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
