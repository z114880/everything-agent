import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAgentRuntime } from "../src/agent-runtime/index.ts";
import type { AgentObserver } from "../src/agent-loop/agent-loop.ts";
import { buildSessions } from "./conversations.ts";
import { listDatasetIds, loadDataset, type Dataset } from "./dataset.ts";
import { decideApply, readManifest, writeManifest } from "./manifest.ts";
import { startMockProvider, type MockProviderStats, type TurnScript } from "./mock-provider.ts";

export interface SeedOptions {
  /** 目标数据目录，默认仓库根的 `.everything`，即 Web 控制台使用的真实数据。 */
  home: string;
  /** 要写入的数据集；省略时写入 `datasets/` 下的全部数据集。 */
  datasetIds?: string[];
  /** 每个数据集生成的会话数。 */
  sessionCount?: number;
  seed?: number;
  /** 忽略已写入判断，强制再写一遍（会产生重复数据）。 */
  force?: boolean;
  consolidate?: boolean;
  onProgress?: (message: string) => void;
}

export interface DatasetOutcome {
  datasetId: string;
  skipped: boolean;
  reason?: string;
  sessionCount: number;
  runCount: number;
  toolCallCount: number;
}

export interface SeedResult {
  home: string;
  outcomes: DatasetOutcome[];
  sessionsCreated: number;
  runsExecuted: number;
  toolCallsExecuted: number;
  chatLogAdded: number;
  semanticMemoryAdded: number;
  consolidationRan: boolean;
  /** 目标库存在向量索引时为 true：新写入的记忆没有向量，需要用户自行重建。 */
  embeddingIndexPresent: boolean;
  providerStats: MockProviderStats;
  ms: number;
}

const silentObserver: AgentObserver = () => {};

/**
 * 把模拟数据合并进一个现有的 Everything Agent 数据目录。
 *
 * 数据由本地模拟供应商驱动真实 Agent Runtime 产生，全程没有外部网络调用。
 * 已经写入过的数据集会被跳过；判断同时依赖写入清单与数据库中对应 Session 是否仍然存在，
 * 因此清空数据后可以重新写入。
 *
 * 目标目录中的模型配置与密钥在运行前备份、运行后原样恢复；检索强制使用 lexical_only
 * 且不绑定 Embedding，因此不会用模拟向量污染用户已有的向量索引。
 */
export async function seedMockData(options: SeedOptions): Promise<SeedResult> {
  const report = options.onProgress ?? (() => {});
  const startedAt = performance.now();
  const sessionCount = options.sessionCount ?? 20;
  const ids = options.datasetIds?.length ? options.datasetIds : await listDatasetIds();
  if (!ids.length) throw new Error("datasets 目录中没有任何数据集");
  const datasets: Dataset[] = [];
  for (const id of ids) datasets.push(await loadDataset(id));

  const provider = await startMockProvider({ plan: () => undefined });
  const runtime = createAgentRuntime({
    home: options.home,
    defaultSystemPromptPath: join(options.home, "EVERYTHING.md"),
  });
  const outcomes: DatasetOutcome[] = [];
  let restoreConfiguration: (() => Promise<void>) | null = null;
  let sessionsCreated = 0;
  let runsExecuted = 0;
  let toolCallsExecuted = 0;
  let chatLogBefore = 0;
  let semanticBefore = 0;
  let consolidationRan = false;
  let embeddingIndexPresent = false;

  try {
    await runtime.start();
    const memory = runtime.memory;
    const manifest = await readManifest(options.home);
    const existingSessionIds = new Set(memory.listSessions().map((item) => item.id));
    embeddingIndexPresent = memory.embeddingIndexStatus().ready;

    const pending: Dataset[] = [];
    for (const dataset of datasets) {
      const decision = decideApply(manifest, dataset.id, dataset.checksum, existingSessionIds);
      if (decision.skip && !options.force) {
        const changed = decision.checksumChanged ? "，且数据文件已变更（如需重写请加 --force）" : "";
        outcomes.push({
          datasetId: dataset.id, skipped: true,
          reason: `已于 ${decision.previous!.appliedAt} 写入 ${decision.previous!.sessionCount} 个会话${changed}`,
          sessionCount: 0, runCount: 0, toolCallCount: 0,
        });
        report(`跳过 ${dataset.id}：已写入过`);
        continue;
      }
      if (decision.previous && !decision.skip) report(`${dataset.id} 的历史会话已不在数据库中，重新写入`);
      pending.push(dataset);
    }
    if (!pending.length) {
      return finish(options.home, outcomes, {
        sessionsCreated: 0, runsExecuted: 0, toolCallsExecuted: 0, chatLogAdded: 0, semanticMemoryAdded: 0,
        consolidationRan: false, embeddingIndexPresent, providerStats: provider.stats, ms: performance.now() - startedAt,
      });
    }

    restoreConfiguration = await backupConfiguration(options.home);
    await configureForSeeding(runtime, provider.baseUrl);
    chatLogBefore = memory.getChatLog(undefined, 1_000_000).length;
    semanticBefore = memory.listSemantic().length;

    for (const dataset of pending) {
      const sessions = buildSessions(dataset, sessionCount, options.seed ?? 1);
      const scripts = new Map<string, TurnScript>();
      for (const session of sessions) for (const turn of session.turns) scripts.set(turn.prompt, turn.script);
      provider.setPlan((prompt) => scripts.get(prompt));

      const createdSessionIds: string[] = [];
      let datasetRuns = 0;
      let datasetToolCalls = 0;
      for (const [index, session] of sessions.entries()) {
        const created = await runtime.createSession();
        createdSessionIds.push(created.id);
        for (const turn of session.turns) {
          const result = await runtime.run(
            { sessionId: created.id, prompt: turn.prompt },
            { observer: silentObserver, signal: AbortSignal.timeout(120_000) },
          );
          datasetRuns += 1;
          datasetToolCalls += result.toolCallCount;
        }
        if ((index + 1) % 10 === 0 || index === sessions.length - 1) {
          report(`${dataset.id}：${index + 1}/${sessions.length} 个会话`);
        }
      }
      // 记忆写入走后台队列，必须等待落库后再记录清单。
      await memory.waitForBackgroundTasks();
      await writeManifest(options.home, {
        datasetId: dataset.id, version: dataset.version, checksum: dataset.checksum,
        appliedAt: new Date().toISOString(), sessionCount: createdSessionIds.length, sessionIds: createdSessionIds,
      });
      sessionsCreated += createdSessionIds.length;
      runsExecuted += datasetRuns;
      toolCallsExecuted += datasetToolCalls;
      outcomes.push({
        datasetId: dataset.id, skipped: false,
        sessionCount: createdSessionIds.length, runCount: datasetRuns, toolCallCount: datasetToolCalls,
      });
    }

    if (options.consolidate) {
      await runtime.consolidate("manual");
      await memory.waitForBackgroundTasks();
      consolidationRan = true;
      report("consolidation 已完成");
    }

    return finish(options.home, outcomes, {
      sessionsCreated, runsExecuted, toolCallsExecuted,
      chatLogAdded: memory.getChatLog(undefined, 1_000_000).length - chatLogBefore,
      semanticMemoryAdded: memory.listSemantic().length - semanticBefore,
      consolidationRan, embeddingIndexPresent, providerStats: provider.stats,
      ms: performance.now() - startedAt,
    });
  } finally {
    await runtime.close();
    // 配置必须在 Runtime 关闭后恢复，避免其内部再次写回 seeding 配置。
    if (restoreConfiguration) await restoreConfiguration();
    await provider.close();
  }
}

function finish(home: string, outcomes: DatasetOutcome[], rest: Omit<SeedResult, "home" | "outcomes" | "ms"> & { ms: number }): SeedResult {
  return { home, outcomes, ...rest, ms: Math.round(rest.ms) };
}

/**
 * 备份目标目录的模型配置与密钥文件，返回恢复函数。
 * 运行前不存在的文件在恢复时删除，保持目录原状。
 */
async function backupConfiguration(home: string): Promise<() => Promise<void>> {
  const paths = [join(home, "config.json"), join(home, ".env")];
  const snapshots = await Promise.all(paths.map(async (path) => {
    try { return { path, content: await readFile(path, "utf8") } }
    catch { return { path, content: null } }
  }));
  return async () => {
    for (const snapshot of snapshots) {
      if (snapshot.content === null) await rm(snapshot.path, { force: true });
      else await writeFile(snapshot.path, snapshot.content, { mode: 0o600 });
    }
  };
}

/**
 * 指向本地模拟供应商，并强制 lexical_only、清空 Embedding 配置。
 * 清空 Embedding 后 Semantic 写入不会调用远程服务，也不会向 active generation 写入模拟向量；
 * lexical_only 同时绕过「配置与 active generation 一致」的校验，因此已有真实索引的目录也能安全写入。
 */
async function configureForSeeding(runtime: ReturnType<typeof createAgentRuntime>, baseUrl: string): Promise<void> {
  const connection = { provider: "openai-compatible" as const, baseUrl, apiKey: "mock-data-local-key" };
  await runtime.saveAgentSettings({
    agentModel: { ...connection, model: "mock-agent" },
    smallModel: { ...connection, model: "mock-small" },
    retrievalMode: "lexical_only",
    embeddingBaseUrl: "",
    embeddingModel: "",
    clearEmbeddingApiKey: true,
    force: true,
  });
}
