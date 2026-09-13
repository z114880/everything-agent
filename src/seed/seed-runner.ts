import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createAgentRuntime } from "../agent-runtime/index.ts";
import type { RetrievalMode } from "../memory/index.ts";
import type { AgentObserver } from "../agent-loop/agent-loop.ts";
import { buildSeedSessions, type SeedSession } from "./conversations.ts";
import { startFakeProvider, type FakeProviderStats, type TurnScript } from "./fake-provider.ts";

export interface SeedOptions {
  /** 数据写入目录；必须与真实 `.everything` 分开，除非明确要灌入真实数据。 */
  home: string;
  sessionCount?: number;
  /** 伪随机种子；相同 seed 与 sessionCount 产生完全相同的数据。 */
  seed?: number;
  retrievalMode?: RetrievalMode;
  /** 生成 Dense 向量索引；关闭后只有 FTS5 词法检索可用。 */
  buildEmbeddingIndex?: boolean;
  /** 生成结束后触发一次 consolidation，产生整理运行记录。 */
  consolidate?: boolean;
  onProgress?: (message: string) => void;
}

export interface SeedResult {
  home: string;
  sessionCount: number;
  runCount: number;
  toolCallCount: number;
  chatLogCount: number;
  indexedMessageCount: number;
  semanticMemoryCount: number;
  traceFileCount: number;
  embeddingChunkCount: number;
  consolidationCount: number;
  providerStats: FakeProviderStats;
  ms: number;
}

/**
 * 用本地假供应商驱动真实 Agent Runtime 生成完整测试数据：
 * SQLite（sessions / chat_log / FTS5 / semantic_memory / 审计与变更）、JSONL trace 与向量索引。
 * 全程没有任何外部网络调用，同一 seed 与 sessionCount 的结果可完全复现。
 */
export async function seedEverythingData(options: SeedOptions): Promise<SeedResult> {
  const sessionCount = options.sessionCount ?? 20;
  const report = options.onProgress ?? (() => {});
  const startedAt = performance.now();
  const withEmbedding = options.buildEmbeddingIndex !== false;
  const sessions = buildSeedSessions(sessionCount, options.seed ?? 1);
  const scripts = new Map<string, TurnScript>();
  for (const session of sessions) for (const turn of session.turns) scripts.set(turn.prompt, turn.script);

  await mkdir(options.home, { recursive: true });
  const provider = await startFakeProvider({ plan: (prompt) => scripts.get(prompt) });
  report(`本地假供应商已启动：${provider.baseUrl}`);

  const runtime = createAgentRuntime({
    home: options.home,
    envPath: join(options.home, ".env"),
    defaultSystemPromptPath: join(options.home, "EVERYTHING.md"),
  });
  let runCount = 0;
  let toolCallCount = 0;
  try {
    await runtime.start();
    await configureRuntime(runtime, provider.baseUrl, options);
    // hybrid 检索要求先存在 active generation；空库建索引成本极低，且让对话过程本身
    // 就产生 dense / RRF / MMR 事件，而不是事后补一个索引。
    if (withEmbedding) await runtime.rebuildEmbeddingIndex();
    report(`配置完成，开始生成 ${sessions.length} 个会话`);

    for (const [index, session] of sessions.entries()) {
      const created = await runtime.createSession();
      for (const turn of session.turns) {
        const result = await runtime.run(
          { sessionId: created.id, prompt: turn.prompt },
          { observer: silentObserver, signal: AbortSignal.timeout(120_000) },
        );
        runCount += 1;
        toolCallCount += result.toolCallCount;
      }
      report(`会话 ${index + 1}/${sessions.length}：${session.title}（${session.turns.length} 轮）`);
    }

    // 记忆写入走后台队列，必须等待落库后再统计与建索引。
    await runtime.memory.waitForBackgroundTasks();
    report("后台记忆任务已完成");

    let embeddingChunkCount = 0;
    if (withEmbedding) {
      const built = await runtime.rebuildEmbeddingIndex();
      embeddingChunkCount = built.result.chunkCount;
      report(`向量索引已重建：${embeddingChunkCount} 个 chunk`);
    }
    if (options.consolidate) {
      await runtime.consolidate("manual");
      await runtime.memory.waitForBackgroundTasks();
      report("consolidation 已完成");
    }

    const memory = runtime.memory;
    const overview = memory.overview();
    return {
      home: options.home,
      sessionCount: memory.listSessions().length,
      runCount,
      toolCallCount,
      chatLogCount: memory.getChatLog(undefined, 1_000_000).length,
      indexedMessageCount: overview.indexedMessageCount,
      semanticMemoryCount: memory.listSemantic().length,
      traceFileCount: await countTraceFiles(options.home),
      embeddingChunkCount,
      consolidationCount: memory.listConsolidations().length,
      providerStats: provider.stats,
      ms: Math.round(performance.now() - startedAt),
    };
  } finally {
    await runtime.close();
    await provider.close();
  }
}

const silentObserver: AgentObserver = () => {};

async function configureRuntime(
  runtime: ReturnType<typeof createAgentRuntime>,
  baseUrl: string,
  options: SeedOptions,
): Promise<void> {
  const connection = { provider: "openai-compatible" as const, baseUrl, apiKey: "seed-local-key" };
  await runtime.saveAgentSettings({
    agentModel: { ...connection, model: "fake-agent" },
    smallModel: { ...connection, model: "fake-small" },
    retrievalMode: options.retrievalMode ?? (options.buildEmbeddingIndex === false ? "lexical_only" : "hybrid"),
    embeddingBaseUrl: baseUrl,
    embeddingModel: "fake-embedding",
    embeddingApiKey: "seed-local-key",
    force: true,
  });
}

async function countTraceFiles(home: string): Promise<number> {
  try {
    const days = await readdir(join(home, "traces"), { withFileTypes: true });
    let total = 0;
    for (const day of days) {
      if (!day.isDirectory()) continue;
      total += (await readdir(join(home, "traces", day.name))).length;
    }
    return total;
  } catch { return 0 }
}
