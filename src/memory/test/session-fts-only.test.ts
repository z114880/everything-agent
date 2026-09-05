import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { MemoryRuntime } from "../index.ts";

it("Session 归档、重建和 dense_only 下历史搜索均不调用 embedding", async () => {
  const memory = new MemoryRuntime(await mkdtemp(join(tmpdir(), "session-fts-")));
  let calls = 0;
  const embedding = { profile: { baseUrl: "https://example.invalid", apiKey: "test", model: "test", queryTemplate: "{text}", documentTemplate: "{text}", minimumSimilarity: 0.2 }, client: { async embed(texts: string[]) { calls++; return texts.map((_, index) => ({ index, vector: new Float32Array([1, 0]) })); } } };
  try {
    memory.configureRetrieval({ mode: "lexical_only", embedding, allowIncompleteIndex: true });
    const session = memory.createSession();
    memory.startRun(session.id, "r1", "我喜欢红茶");
    await memory.completeRun(session.id, "r1", [{ role: "assistant", content: "好的" }]);
    await memory.rebuildEmbeddings();
    memory.configureRetrieval({ mode: "dense_only", embedding });
    const result = await memory.searchSessions({ query: "红茶" }, { searchWindow: 5, scrollStep: 10, messageLimit: 100, tokenLimit: 50000, tokenEstimator: { estimateText: (text) => text.length } });
    expect(result.sessions.map((item) => item.session.id)).toEqual([session.id]);
    expect(calls).toBe(0);
  } finally { memory.close(); }
});
