import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readTraceFiles } from "../../src/tracing/jsonl-tracer.ts";
import {
  buildSessions, decideApply, listDatasetIds, loadDataset, readManifest,
  seedMockData, startMockProvider, writeManifest,
} from "../index.ts";

describe("模拟数据集", () => {
  it("加载并校验 datasets 目录下的数据集", async () => {
    const ids = await listDatasetIds();
    expect(ids).toContain("personal-assistant");
    const dataset = await loadDataset("personal-assistant");
    expect(dataset.topics.length).toBeGreaterThan(0);
    expect(dataset.checksum).toHaveLength(16);
    expect(dataset.topics.every((topic) => topic.facts.length > 0)).toBe(true);
  });

  it("拒绝非法数据集 id", async () => {
    await expect(loadDataset("../secrets")).rejects.toThrow("只能包含小写字母");
  });

  it("相同数据集与 seed 产生完全相同的会话", async () => {
    const dataset = await loadDataset("personal-assistant");
    expect(buildSessions(dataset, 6, 7)).toEqual(buildSessions(dataset, 6, 7));
    expect(buildSessions(dataset, 6, 7)).not.toEqual(buildSessions(dataset, 6, 8));
  });

  it("重复出现的主题使用不同侧面的事实，避免全部被去重", async () => {
    const dataset = await loadDataset("personal-assistant");
    const statements = buildSessions(dataset, dataset.topics.length * 2, 1).map((session) => session.turns[0]!.prompt);
    expect(new Set(statements).size).toBe(statements.length);
  });
});

describe("写入清单", () => {
  it("未写入过时允许写入", () => {
    expect(decideApply({ version: 1, applied: [] }, "a", "c1", new Set())).toMatchObject({ skip: false });
  });

  it("已写入且会话仍在时跳过，并标记内容变更", () => {
    const manifest = {
      version: 1 as const,
      applied: [{ datasetId: "a", version: 1, checksum: "c1", appliedAt: "t", sessionCount: 1, sessionIds: ["s1"] }],
    };
    expect(decideApply(manifest, "a", "c1", new Set(["s1"]))).toMatchObject({ skip: true, reason: "already-applied" });
    expect(decideApply(manifest, "a", "c2", new Set(["s1"]))).toMatchObject({ skip: true, checksumChanged: true });
  });

  it("会话已不存在时重新允许写入，避免清单与数据不一致", () => {
    const manifest = {
      version: 1 as const,
      applied: [{ datasetId: "a", version: 1, checksum: "c1", appliedAt: "t", sessionCount: 1, sessionIds: ["s1"] }],
    };
    expect(decideApply(manifest, "a", "c1", new Set(["other"]))).toMatchObject({ skip: false });
  });

  it("同一数据集只保留最后一次记录", async () => {
    const home = await mkdtemp(join(tmpdir(), "mock-data-manifest-"));
    const record = { datasetId: "a", version: 1, checksum: "c1", appliedAt: "t1", sessionCount: 1, sessionIds: ["s1"] };
    await writeManifest(home, record);
    await writeManifest(home, { ...record, appliedAt: "t2", sessionIds: ["s2"] });
    const manifest = await readManifest(home);
    expect(manifest.applied).toHaveLength(1);
    expect(manifest.applied[0]).toMatchObject({ appliedAt: "t2" });
  });
});

describe("模拟供应商", () => {
  it("按 system prompt 区分 Gate 与主模型请求，并支持切换脚本", async () => {
    const provider = await startMockProvider({ plan: () => ({ reply: "第一版" }) });
    try {
      const gate = await postChat(provider.baseUrl, '只输出 JSON：{"intent"', "帮我记一下");
      expect(JSON.parse(textOf(gate)).intent).toBe("fact_with_evidence");
      expect(textOf(await postChat(provider.baseUrl, "你是用户的个人助理。", "帮我记一下"))).toBe("第一版");
      provider.setPlan(() => ({ reply: "第二版" }));
      expect(textOf(await postChat(provider.baseUrl, "你是用户的个人助理。", "帮我记一下"))).toBe("第二版");
      expect(provider.stats).toMatchObject({ gate: 1, agent: 2 });
    } finally { await provider.close() }
  });

  it("对同一文本返回稳定向量", async () => {
    const provider = await startMockProvider();
    try {
      const first = await postEmbedding(provider.baseUrl, ["上午喝手冲咖啡"]);
      expect(first).toEqual(await postEmbedding(provider.baseUrl, ["上午喝手冲咖啡"]));
      expect(first).not.toEqual(await postEmbedding(provider.baseUrl, ["马拉松训练计划"]));
      expect(first[0]).toHaveLength(1024);
    } finally { await provider.close() }
  });
});

describe("合并写入现有数据目录", () => {
  it("写入数据、跳过重复运行，并原样保留用户配置", async () => {
    const home = await mkdtemp(join(tmpdir(), "mock-data-merge-"));
    const configPath = join(home, "config.json");
    const envPath = join(home, ".env");
    const originalConfig = JSON.stringify({ models: { agent: { provider: "anthropic", model: "claude-opus-5" } }, maxIterations: 42 });
    await writeFile(configPath, originalConfig, "utf8");
    await writeFile(envPath, "EVERYTHING_AGENT_API_KEY=sk-user-real-key\n", "utf8");

    const first = await seedMockData({ home, sessionCount: 3 });
    expect(first.outcomes[0]).toMatchObject({ datasetId: "personal-assistant", skipped: false });
    expect(first.sessionsCreated).toBe(3);
    expect(first.chatLogAdded).toBeGreaterThan(0);
    expect(first.semanticMemoryAdded).toBeGreaterThan(0);
    expect(first.toolCallsExecuted).toBeGreaterThan(0);

    // 模型配置与密钥必须与运行前完全一致，否则会破坏用户的真实设置。
    expect(await readFile(configPath, "utf8")).toBe(originalConfig);
    expect(await readFile(envPath, "utf8")).toBe("EVERYTHING_AGENT_API_KEY=sk-user-real-key\n");

    const second = await seedMockData({ home, sessionCount: 3 });
    expect(second.outcomes[0]).toMatchObject({ skipped: true, reason: expect.stringContaining("已于") });
    expect(second.sessionsCreated).toBe(0);

    // 数据被清空后，清单记录失效，应允许重新写入。
    await rm(join(home, "database"), { recursive: true, force: true });
    const third = await seedMockData({ home, sessionCount: 2 });
    expect(third.outcomes[0]).toMatchObject({ skipped: false });
    expect(third.sessionsCreated).toBe(2);
  }, 120_000);

  it("生成的 trace 覆盖回合级字段：耗时拆分、工具失败、派生任务与上下文水位", async () => {
    const home = await mkdtemp(join(tmpdir(), "mock-data-trace-"));
    const result = await seedMockData({ home, sessionCount: 20 });

    // 验证真实生成产物：同一会话的多轮执行必须分文件，不能重新合并为 Session 文件。
    const traceFiles = await readTraceFiles(home);
    const turnFiles = traceFiles.filter((file) => /\/\d+-turn-/.test(file.path));
    expect(turnFiles).toHaveLength(result.turnsExecuted);
    expect(turnFiles.length).toBeGreaterThan(result.sessionsCreated);
    expect(traceFiles.some((file) => /\/\d+-session-/.test(file.path))).toBe(false);
    for (const file of turnFiles) {
      const turnId = file.records[0]!.turnId;
      expect(file.path.endsWith(`-turn-${turnId}.jsonl`)).toBe(true);
      expect(new Set(file.records.map((record) => record.turnId))).toEqual(new Set([turnId]));
      expect(new Set(file.records.map((record) => record.sessionId)).size).toBe(1);
      expect(file.records[0]).toMatchObject({ type: "turn_started", sessionId: expect.any(String) });
      expect(file.records.filter((record) => record.type === "turn_completed")).toHaveLength(1);
    }

    const records = await readTraceRecords(home);
    const turns = records.filter((record) => record.type === "turn_completed").map((record) => record.payload);
    expect(turns.length).toBeGreaterThan(0);

    // 三段耗时都存在，且合计不超过整轮墙钟时间。
    expect(turns.every((turn) => turn.retrievalMs + turn.modelMs + turn.toolMs <= turn.ms)).toBe(true);
    // 供应商 usage 随请求体量变化，而不是固定常数，否则水位在模拟数据上不可观察。
    expect(new Set(turns.map((turn) => turn.peakInputTokens)).size).toBeGreaterThan(1);
    // 估算与供应商分词之间保留固定偏差，可用来观察估算器误差。
    expect(turns.every((turn) => turn.peakInputTokens > turn.peakEstimatedInputTokens)).toBe(true);
    expect(turns.every((turn) => turn.availableInputTokens === turn.contextWindow - turn.maxTokens - turn.contextSafetyTokens)).toBe(true);

    expect(turns.some((turn) => turn.failedToolCallCount > 0)).toBe(true);
    expect(records.some((record) => record.type === "tool_failed")).toBe(true);

    // 派生任务 ID 必须能对上独立的后台任务 trace 文件。
    const derived = turns.flatMap((turn) => turn.derivedTaskIds);
    expect(derived.length).toBeGreaterThan(0);
    const files = await readdir(join(home, "traces"), { recursive: true });
    expect(derived.every((taskId) => files.some((file) => String(file).includes(`memory_write-${taskId}.jsonl`)))).toBe(true);
  }, 120_000);

  it("force 忽略已写入判断并在现有数据上追加", async () => {
    const home = await mkdtemp(join(tmpdir(), "mock-data-force-"));
    await seedMockData({ home, sessionCount: 2 });
    const forced = await seedMockData({ home, sessionCount: 2, force: true });
    expect(forced.sessionsCreated).toBe(2);
    expect(forced.outcomes[0]).toMatchObject({ skipped: false });
  }, 120_000);
});

interface TraceRecord { type: string; payload: Record<string, any> }

/** 读取写入目录下的全部 JSONL 事件；缺少 payload 的事件补空对象，便于统一断言。 */
async function readTraceRecords(home: string): Promise<TraceRecord[]> {
  const root = join(home, "traces");
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const records: TraceRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const text = await readFile(join(entry.parentPath, entry.name), "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const record = JSON.parse(line) as { type: string; payload?: Record<string, unknown> };
      records.push({ type: record.type, payload: record.payload ?? {} });
    }
  }
  return records;
}

async function postChat(baseUrl: string, system: string, prompt: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "mock", stream: false, messages: [{ role: "system", content: system }, { role: "user", content: prompt }] }),
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
    body: JSON.stringify({ model: "mock", input }),
  });
  const payload = await response.json() as { data: Array<{ embedding: number[] }> };
  return payload.data.map((item) => item.embedding);
}
