import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRuntime } from "../../index.ts";
import type { EmbeddingPort, EmbeddingProfile } from "../index.ts";
import type { AgentModelClient } from "../../../agent-loop/agent-loop.ts";

const runtimes: MemoryRuntime[] = [];
const profile: EmbeddingProfile = {
  baseUrl: "https://embedding.invalid/v1", apiKey: "secret", model: "fake-1024",
  queryTemplate: "{text}", documentTemplate: "{text}", minimumSimilarity: 0.2,
};
const client: EmbeddingPort = {
  async embed(texts) {
    return texts.map((text, index) => ({ index, vector: keywordVector(text) }));
  },
};

afterEach(() => runtimes.splice(0).forEach((runtime) => runtime.close()));

describe("MemoryRuntime Dense/Hybrid 集成", () => {
  it.each(["lexical_only", "dense_only", "hybrid"] as const)("%s 的前 4 条 Session Recall 来自不同 Session", async (mode) => {
    const memory = await createMemory();
    const dominant = memory.createSession("高频会话");
    for (let index = 0; index < 6; index += 1) {
      memory.startRun(dominant.id, `dominant-${index}`, `ORBIT `.repeat(20) + "高频会话");
      await memory.completeRun(dominant.id, `dominant-${index}`, [{ role: "assistant", content: "ORBIT 高频结果" }]);
    }
    for (const label of ["会话甲", "会话乙", "会话丙", "会话丁"]) {
      const session = memory.createSession(label);
      memory.startRun(session.id, `run-${label}`, `ORBIT ${label} ` + "无关内容 ".repeat(20));
      await memory.completeRun(session.id, `run-${label}`, [{ role: "assistant", content: `${label} 的结果` }]);
    }

    const diverseClient: EmbeddingPort = {
      async embed(texts) {
        return texts.map((text, index) => ({ index, vector: sessionVector(text) }));
      },
    };
    memory.configureRetrieval({ mode: "lexical_only", embedding: { profile, client: diverseClient }, allowIncompleteIndex: true });
    await memory.rebuildEmbeddings();
    memory.configureRetrieval({ mode, embedding: { profile, client: diverseClient } });

    const result = await memory.searchSessions(
      { query: "ORBIT", limit: 4 },
      { ...recall(), messageLimit: 1_000, tokenLimit: 1_000_000 },
    );
    const sessionIds = result.sessions.map((item) => item.session.id);
    expect(sessionIds).toHaveLength(4);
    expect(new Set(sessionIds).size).toBe(4);
  });

  it("拒绝缺失配置或 active generation 的 Dense，并允许无配置 lexical-only", async () => {
    const memory = await createMemory();
    memory.configureRetrieval({ mode: "lexical_only" });
    expect(memory.cancelEmbeddingRebuild()).toBe(false);
    await expect(memory.rebuildEmbeddings()).rejects.toThrow("尚未配置");
    expect(() => memory.configureRetrieval({ mode: "dense_only" })).toThrow("必须配置");
    expect(() => memory.configureRetrieval({
      mode: "hybrid", embedding: { profile, client },
    })).toThrow("请先重建索引");
  });

  it("以独立候选池覆盖 Semantic Memory 与 Session Recall", async () => {
    const memory = await createMemory();
    const coffee = await memory.createSemantic("饮品", "用户喜欢手冲咖啡");
    await memory.createSemantic("部署", "项目使用蓝绿发布");
    const session = memory.createSession("历史发布");
    memory.startRun(session.id, "run-release", "上次如何发布服务");
    await memory.completeRun(session.id, "run-release", [{ role: "assistant", content: "使用蓝绿发布" }]);

    memory.configureRetrieval({ mode: "lexical_only", embedding: { profile, client }, allowIncompleteIndex: true });
    await memory.rebuildEmbeddings("rebuild-test");
    expect(memory.activeEmbeddingProfile()).toEqual({
      baseUrl: profile.baseUrl,
      model: profile.model,
      queryTemplate: profile.queryTemplate,
      documentTemplate: profile.documentTemplate,
      minimumSimilarity: profile.minimumSimilarity,
    });
    memory.configureRetrieval({ mode: "dense_only", embedding: { profile, client } });

    expect((await memory.searchSemantic("想喝咖啡", 4))[0]?.id).toBe(coffee.id);
    const recalled = await memory.searchSessions({ query: "发布", limit: 4 }, recall());
    expect(recalled.sessions[0]?.session.id).toBe(session.id);
  });

  it("Embedding 写入失败时不提交 Semantic Memory", async () => {
    const memory = await createMemory();
    memory.configureRetrieval({ mode: "lexical_only", embedding: { profile, client }, allowIncompleteIndex: true });
    await memory.rebuildEmbeddings();
    const failedClient: EmbeddingPort = { async embed() { throw new Error("远程 embedding 失败") } };
    memory.configureRetrieval({ mode: "lexical_only", embedding: { profile, client: failedClient } });

    await expect(memory.createSemantic("偏好", "用户喜欢咖啡")).rejects.toThrow("远程 embedding 失败");
    expect(memory.listSemantic()).toEqual([]);
  });

  it("成功 run 的 Embedding 失败时只保留未完成 Chat Log，不进入 FTS", async () => {
    const memory = await createMemory();
    memory.configureRetrieval({ mode: "lexical_only", embedding: { profile, client }, allowIncompleteIndex: true });
    await memory.rebuildEmbeddings();
    const failedClient: EmbeddingPort = { async embed() { throw new Error("run embedding 失败") } };
    memory.configureRetrieval({ mode: "lexical_only", embedding: { profile, client: failedClient } });
    const session = memory.createSession();
    memory.startRun(session.id, "failed-run", "唯一代号 ORANGE");
    await expect(memory.completeRun(session.id, "failed-run", [{ role: "assistant", content: "回答" }]))
      .rejects.toThrow("run embedding 失败");
    expect(memory.getChatLog(session.id)).toHaveLength(1);
    expect((await memory.searchSessions({ query: "ORANGE" }, recall())).sessions).toEqual([]);
  });

  it("拒绝使用与 active generation 不一致的 profile", async () => {
    const memory = await createMemory();
    memory.configureRetrieval({ mode: "lexical_only", embedding: { profile, client }, allowIncompleteIndex: true });
    await memory.rebuildEmbeddings();
    expect(() => memory.configureRetrieval({
      mode: "hybrid",
      embedding: { profile: { ...profile, model: "changed" }, client },
    })).toThrow("请先重建索引");
  });

  it("Semantic 与 Session 查询模板结果相同时复用一次 query embedding", async () => {
    const memory = await createMemory();
    await memory.createSemantic("发布", "项目采用蓝绿发布");
    const session = memory.createSession();
    memory.startRun(session.id, "r1", "发布方案");
    await memory.completeRun(session.id, "r1", [{ role: "assistant", content: "蓝绿发布" }]);
    let calls = 0;
    const countingClient: EmbeddingPort = {
      async embed(texts) { calls += 1; return texts.map((text, index) => ({ index, vector: keywordVector(text) })) },
    };
    memory.configureRetrieval({ mode: "lexical_only", embedding: { profile, client: countingClient }, allowIncompleteIndex: true });
    await memory.rebuildEmbeddings();
    memory.configureRetrieval({ mode: "hybrid", embedding: { profile, client: countingClient } });
    calls = 0;
    await memory.retrieve("发布", [], {
      client: gateClient(), model: "gate", currentSessionId: "current", recall: recall(),
    });
    expect(calls).toBe(1);
  });

  it("取消影子重建时保留旧 active generation", async () => {
    const memory = await createMemory();
    await memory.createSemantic("发布", "项目采用蓝绿发布");
    memory.configureRetrieval({ mode: "lexical_only", embedding: { profile, client }, allowIncompleteIndex: true });
    await memory.rebuildEmbeddings();
    const activeBefore = memory.embeddingIndexStatus().generationId;
    const blockingClient: EmbeddingPort = {
      embed(_texts, _counts, context) {
        return new Promise((_resolve, reject) => {
          context.signal?.addEventListener("abort", () => reject(context.signal?.reason), { once: true });
        });
      },
    };
    memory.configureRetrieval({ mode: "lexical_only", embedding: { profile, client: blockingClient } });
    const rebuilding = memory.rebuildEmbeddings("cancel-test");
    await Promise.resolve();
    await expect(memory.rebuildEmbeddings("concurrent")).rejects.toThrow("正在运行");
    await expect(memory.createSemantic("暂停", "写入")).rejects.toThrow("暂停");
    expect(memory.cancelEmbeddingRebuild()).toBe(true);
    await expect(rebuilding).rejects.toThrow("已取消");
    expect(memory.embeddingIndexStatus().generationId).toBe(activeBefore);
  });

  it("重建失败保留旧索引，并严格拒绝超长或缺失的 query embedding", async () => {
    const memory = await createMemory();
    await memory.createSemantic("发布", "项目采用蓝绿发布");
    memory.configureRetrieval({ mode: "lexical_only", embedding: { profile, client }, allowIncompleteIndex: true });
    await memory.rebuildEmbeddings();
    const activeBefore = memory.embeddingIndexStatus().generationId;
    const events: string[] = [];
    const failedClient: EmbeddingPort = { async embed() { throw new TypeError("rebuild failed") } };
    memory.configureRetrieval({
      mode: "lexical_only", embedding: { profile, client: failedClient },
      observer: async (kind) => { events.push(kind) },
    });
    await expect(memory.rebuildEmbeddings("failed-rebuild")).rejects.toThrow("rebuild failed");
    expect(memory.embeddingIndexStatus().generationId).toBe(activeBefore);
    expect(events).toContain("embedding_rebuild_failed");

    memory.configureRetrieval({ mode: "dense_only", embedding: { profile, client } });
    await expect(memory.searchSemantic("x".repeat(2_049))).rejects.toThrow("1–512 tokens");
    const emptyClient: EmbeddingPort = { async embed() { return [] } };
    memory.configureRetrieval({ mode: "dense_only", embedding: { profile, client: emptyClient } });
    await expect(memory.searchSemantic("发布")).rejects.toThrow("未返回向量");
  });

  it("成功 run 必须有最终 Assistant 回复，Embedding 响应必须覆盖全部 chunk", async () => {
    const memory = await createMemory();
    const session = memory.createSession();
    memory.startRun(session.id, "no-answer", "问题");
    await expect(memory.completeRun(session.id, "no-answer", [])).rejects.toThrow("最终 Assistant");

    memory.configureRetrieval({ mode: "lexical_only", embedding: { profile, client }, allowIncompleteIndex: true });
    await memory.rebuildEmbeddings();
    memory.configureRetrieval({
      mode: "lexical_only",
      embedding: { profile, client: { async embed() { return [] } } },
    });
    await expect(memory.createSemantic("主题", "内容")).rejects.toThrow("缺少 chunk 向量");
  });
});

function keywordVector(text: string): Float32Array {
  const vector = new Float32Array(1024);
  vector[text.includes("咖啡") ? 0 : text.includes("发布") ? 1 : 2] = 1;
  return vector;
}

function sessionVector(text: string): Float32Array {
  const vector = new Float32Array(1024);
  const labels = ["高频会话", "会话甲", "会话乙", "会话丙", "会话丁"];
  const marker = labels.findIndex((label) => text.includes(label));
  vector[0] = marker >= 0 ? 0.8 : 1;
  if (marker >= 0) vector[marker + 1] = 0.6;
  return vector;
}

function recall() {
  return {
    searchWindow: 5, scrollStep: 10, messageLimit: 100, tokenLimit: 8_192,
    tokenEstimator: { estimateText(text: string) { return text.length } },
  };
}

async function createMemory(): Promise<MemoryRuntime> {
  const memory = new MemoryRuntime(await mkdtemp(join(tmpdir(), "everything-dense-memory-")));
  runtimes.push(memory);
  return memory;
}

function gateClient(): AgentModelClient {
  return {
    messages: {
      async create() {
        return {
          content: [{ type: "text", text: JSON.stringify({
            intent: "fact_with_evidence", semanticQuery: "发布",
            sessionRecall: { mode: "search", query: "发布" }, reason: "测试",
          }) }],
          stop_reason: "end_turn",
        };
      },
    },
  };
}
