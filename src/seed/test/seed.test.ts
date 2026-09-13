import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSeedSessions, seedEverythingData, startFakeProvider } from "../index.ts";

describe("Seed 数据生成", () => {
  it("相同 seed 与数量产生完全相同的会话", () => {
    expect(buildSeedSessions(6, 7)).toEqual(buildSeedSessions(6, 7));
    expect(buildSeedSessions(6, 7)).not.toEqual(buildSeedSessions(6, 8));
  });

  it("重复出现的主题使用不同侧面的事实，避免全部被去重", () => {
    const sessions = buildSeedSessions(20, 1);
    const statements = sessions.map((session) => session.turns[0]!.prompt);
    // 前 10 个主题各出现两轮，第二轮必须换一条事实。
    expect(new Set(statements).size).toBe(statements.length);
  });

  it("假供应商按 system prompt 区分 Gate 与主模型请求", async () => {
    const provider = await startFakeProvider({ plan: () => ({ reply: "固定回复" }) });
    try {
      const gate = await postChat(provider.baseUrl, '只输出 JSON：{"intent"', "帮我记一下");
      expect(JSON.parse(textOf(gate)).intent).toBe("fact_with_evidence");
      const agent = await postChat(provider.baseUrl, "你是用户的个人助理。", "帮我记一下");
      expect(textOf(agent)).toBe("固定回复");
      expect(provider.stats).toMatchObject({ gate: 1, agent: 1 });
    } finally { await provider.close() }
  });

  it("假供应商对同一文本返回稳定向量", async () => {
    const provider = await startFakeProvider();
    try {
      const first = await postEmbedding(provider.baseUrl, ["上午喝手冲咖啡"]);
      const second = await postEmbedding(provider.baseUrl, ["上午喝手冲咖啡"]);
      const other = await postEmbedding(provider.baseUrl, ["马拉松训练计划"]);
      expect(first).toEqual(second);
      expect(first).not.toEqual(other);
      expect(first[0]).toHaveLength(1024);
    } finally { await provider.close() }
  });

  it("驱动真实 Runtime 生成数据库、记忆与 trace，且不产生失败任务", async () => {
    const home = await mkdtemp(join(tmpdir(), "everything-seed-"));
    const result = await seedEverythingData({ home, sessionCount: 4, consolidate: true });

    expect(result.sessionCount).toBe(4);
    expect(result.runCount).toBeGreaterThan(4);
    expect(result.chatLogCount).toBeGreaterThan(result.indexedMessageCount);
    expect(result.semanticMemoryCount).toBeGreaterThan(0);
    expect(result.toolCallCount).toBeGreaterThan(0);
    expect(result.traceFileCount).toBeGreaterThan(0);
    expect(result.embeddingChunkCount).toBe(result.semanticMemoryCount);
    expect(result.consolidationCount).toBe(1);
    // 工具轮判断必须限定在当前回合，否则只有每个会话的首轮会调用工具。
    expect(result.toolCallCount).toBeGreaterThanOrEqual(4);
  }, 60_000);
});

async function postChat(baseUrl: string, system: string, prompt: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "fake", stream: false, messages: [{ role: "system", content: system }, { role: "user", content: prompt }] }),
  });
  return await response.json() as Record<string, unknown>;
}

function textOf(payload: Record<string, unknown>): string {
  const choices = payload.choices as Array<{ message?: { content?: string } }>;
  return choices[0]?.message?.content ?? "";
}

async function postEmbedding(baseUrl: string, input: string[]): Promise<number[][]> {
  const response = await fetch(`${baseUrl}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "fake", input }),
  });
  const payload = await response.json() as { data: Array<{ embedding: number[] }> };
  return payload.data.map((item) => item.embedding);
}
