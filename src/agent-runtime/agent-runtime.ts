import { RoughTokenEstimator } from "../model/token-estimator.ts";
import { MemoryRuntime, OpenAIEmbeddingClient } from "../memory/index.ts";
import { JsonlTracer, readTraceFiles } from "../tracing/jsonl-tracer.ts";
import type { AgentObserver } from "../agent-loop/agent-loop.ts";
import { createLocalConfig } from "./local-config.ts";
import { clearEverythingData } from "./local-data.ts";
import { createSettingsStore } from "./settings/settings-store.ts";
import type { PublicAgentSettings, RuntimeSettings } from "./settings/types.ts";
import { requiredText } from "./settings/validation.ts";
import { createRuntimeClient, recallSettings } from "./execution/model-context.ts";
import { executeAgentRun } from "./execution/run-agent.ts";
import type { AgentRunInput, AgentRunOptions, AgentRunResult } from "./execution/types.ts";

/** 创建本地个人助理 Runtime；资源与会话锁由实例独立持有。 */
export function createAgentRuntime(paths: import("./local-config.ts").LocalConfigPaths) {
  const everythingHome = paths.home;
  const config = createLocalConfig(paths);
  const { readSystemPrompt } = config;
  let closed = false;
  let memoryRuntime: MemoryRuntime | null = null;
  let tracer: JsonlTracer | null = null;
  let recoveryScheduled = false;
  let dataClearing = false;
  const backgroundObservers = new Set<AgentObserver>();
  const sessionLocks = new Map<string, Promise<void>>();
  const tokenEstimator = new RoughTokenEstimator();

  const {
    saveAgentSettings, clearProviderApiKey, clearEmbeddingApiKey,
    resetRuntimeSettings, loadRuntimeSettings, publicSettings,
  } = createSettingsStore({
    config, assertOpen, getMemoryRuntime, getTracer,
    isEmbeddingRebuildRunning: () => memoryRuntime?.isEmbeddingRebuildRunning() ?? false,
  });

  /** 使用已保存的 Embedding profile 建立影子索引，成功后原子激活。 */
  async function rebuildEmbeddingIndex(): Promise<{ result: Awaited<ReturnType<MemoryRuntime["rebuildEmbeddings"]>>; settings: PublicAgentSettings }> {
    assertOpen();
    const settings = await loadRuntimeSettings();
    const memory = getMemoryRuntime();
    await configureMemoryRuntime(memory, settings, true);
    try {
      const result = await memory.rebuildEmbeddings();
      return { result, settings: publicSettings(settings) };
    } finally {
      // 无论成功、失败还是取消，都退出 allowIncompleteIndex 临时状态。
      // 失败时普通运行会重新绑定旧 active generation，避免影子索引语义名存实亡。
      await configureMemoryRuntime(memory, settings);
      scheduleStartupRecovery(memory, settings);
    }
  }

  /** 请求取消当前 Embedding 影子索引构建。 */
  function cancelEmbeddingIndexRebuild(): { cancelled: boolean } {
    return { cancelled: getMemoryRuntime().cancelEmbeddingRebuild() };
  }

  /** 显式保存 procedural memory，并让下一回合立即读取新内容。 */
  async function saveSystemPrompt(value: string): Promise<string> {
    assertOpen();
    const systemPrompt = requiredText(value, "System Prompt", 100_000);
    await config.saveSystemPrompt(systemPrompt);
    return systemPrompt.trimEnd();
  }

  /** 校验运行状态并串行化同一会话，回合细节由 execution 模块负责。 */
  async function runLocalAgent(input: AgentRunInput, options: AgentRunOptions): Promise<AgentRunResult> {
    assertOpen();
    const prompt = requiredText(input.prompt, "User Prompt", 40_000);
    const sessionId = requiredText(input.sessionId, "Session ID", 200);
    const settings = await loadRuntimeSettings();
    if (!settings.apiKey) throw new Error(`请先在配置页填写 ${settings.keyName}`);
    if (!settings.model) throw new Error("请先在配置页填写 Model");
    return withSessionLock(sessionId, async () => {
      const memory = getMemoryRuntime();
      await configureMemoryRuntime(memory, settings);
      scheduleStartupRecovery(memory, settings);
      return executeAgentRun({ sessionId, prompt }, options, {
        memory, trace: getTracer(), settings, tokenEstimator, readSystemPrompt,
      });
    });
  }

  /** 读取本地追踪文件，展示结构由宿主组装。 */
  async function readTraces() {
    return readTraceFiles(everythingHome, 2_000);
  }

  /** 清除数据库、Session、Memory 与 trace，保留 EVERYTHING.md 和 .env 配置。 */
  async function clearLocalAgentData(): Promise<{ cleared: true }> {
    assertOpen();
    if (dataClearing) throw new Error("本地数据正在清理");
    if (sessionLocks.size > 0) throw new Error("仍有 Agent 回合正在运行，请结束后再清理");
    if (memoryRuntime?.isEmbeddingRebuildRunning()) throw new Error("Embedding 索引正在重建，请等待完成或先取消重建");
    dataClearing = true;
    try {
      if (memoryRuntime) { memoryRuntime.stopBackgroundTasks(); await memoryRuntime.waitForBackgroundTasks(); }
      if (tracer) await tracer.flush();
      memoryRuntime?.close();
      memoryRuntime = null;
      tracer = null;
      recoveryScheduled = false;
      await clearEverythingData(everythingHome);
      return { cleared: true };
    } finally {
      dataClearing = false;
    }
  }

  function getMemoryRuntime(): MemoryRuntime {
    assertOpen();
    memoryRuntime ??= new MemoryRuntime(everythingHome);
    return memoryRuntime;
  }

  function getTracer(): JsonlTracer {
    tracer ??= new JsonlTracer(everythingHome);
    return tracer;
  }

  function scheduleStartupRecovery(memory: MemoryRuntime, settings: RuntimeSettings): void {
    if (recoveryScheduled || !settings.apiKey || !(settings.smallModel || settings.model)) return;
    recoveryScheduled = true;
    memory.startBackgroundTasks(async () => {
      const current = await loadRuntimeSettings();
      await configureMemoryRuntime(memory, current);
      return {
        client: createRuntimeClient(current, tokenEstimator), model: current.smallModel || current.model,
        modelContextWindow: current.modelContextWindow, tokenEstimator,
        currentSessionId: "", observer: async (kind, event) => {
          await getTracer().record(kind, event);
          for (const observer of backgroundObservers) await observer(kind, event);
        },
      };
    });
  }

  async function configureMemoryRuntime(memory: MemoryRuntime, settings: RuntimeSettings, allowIncompleteIndex = false): Promise<void> {
    const complete = Boolean(
      settings.embeddingApiKey && settings.embeddingBaseUrl
      && settings.embeddingModel,
    );
    if (!complete) {
      if (settings.retrievalMode !== "lexical_only") throw new Error("Dense/Hybrid 模式的 Embedding 配置不完整");
      memory.configureRetrieval({ mode: "lexical_only", observer: (kind, event) => getTracer().record(kind, event) });
      return;
    }
    const desiredProfile = {
      baseUrl: settings.embeddingBaseUrl,
      apiKey: settings.embeddingApiKey,
      model: settings.embeddingModel,
      queryTemplate: settings.embeddingQueryTemplate,
      documentTemplate: settings.embeddingDocumentTemplate,
      minimumSimilarity: settings.embeddingMinimumSimilarity,
    };
    const activeProfile = !allowIncompleteIndex && !memory.embeddingIndexMatches(desiredProfile)
      ? memory.activeEmbeddingProfile()
      : null;
    const profile = activeProfile
      ? {
          ...activeProfile,
          apiKey: settings.embeddingApiKey,
          // 这两个字段不参与文档向量构建，可安全即时采用新配置。
          queryTemplate: settings.embeddingQueryTemplate,
          minimumSimilarity: settings.embeddingMinimumSimilarity,
        }
      : desiredProfile;
    memory.configureRetrieval({
      mode: settings.retrievalMode,
      embedding: { profile, client: new OpenAIEmbeddingClient(profile) },
      observer: (kind, event) => getTracer().record(kind, event),
      ...(allowIncompleteIndex ? { allowIncompleteIndex: true } : {}),
    });
  }

  async function withSessionLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = sessionLocks.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    sessionLocks.set(sessionId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (sessionLocks.get(sessionId) === tail) sessionLocks.delete(sessionId);
    }
  }

  function assertOpen(): void {
    if (closed) throw new Error("Agent Runtime 已关闭");
    if (dataClearing) throw new Error("本地数据正在清理或 Runtime 正在关闭");
  }
  /** 等待后台任务及追踪落盘后关闭；活动回合或索引重建期间拒绝关闭。 */
  async function close(): Promise<void> {
    if (closed) return;
    if (dataClearing || sessionLocks.size || memoryRuntime?.isEmbeddingRebuildRunning()) {
      throw new Error("Agent Runtime 仍有任务正在运行");
    }
    dataClearing = true;
    try {
      if (memoryRuntime) { memoryRuntime.stopBackgroundTasks(); await memoryRuntime.waitForBackgroundTasks(); }
      if (tracer) await tracer.flush();
      memoryRuntime?.close();
      closed = true;
    } finally {
      dataClearing = false;
    }
  }
  return {
    run: runLocalAgent, close,
    /** 订阅独立后台队列事件；返回取消订阅函数，不随聊天回合结束关闭。 */
    subscribeBackgroundEvents(observer: AgentObserver) {
      assertOpen();
      backgroundObservers.add(observer);
      return () => { backgroundObservers.delete(observer); };
    },
    saveAgentSettings, clearProviderApiKey, clearEmbeddingApiKey, resetRuntimeSettings,
    rebuildEmbeddingIndex, cancelEmbeddingIndexRebuild, saveSystemPrompt,
    clearLocalAgentData, readTraces,
    readSystemPrompt,
    async getSettings() { return publicSettings(await loadRuntimeSettings()); },
    async start() {
      assertOpen();
      scheduleStartupRecovery(getMemoryRuntime(), await loadRuntimeSettings());
    },
    get memory() { return getMemoryRuntime(); },
    async prepareMemory() {
      const memory = getMemoryRuntime();
      const settings = await loadRuntimeSettings();
      await configureMemoryRuntime(memory, settings);
      scheduleStartupRecovery(memory, settings);
      return recallSettings(settings, tokenEstimator);
    },
    /** 用户进入 Agent 页面或点击 Consolidate；未配置模型时不占每日配额。 */
    async consolidate(trigger: "daily" | "manual") {
      const settings = await loadRuntimeSettings();
      const memory = getMemoryRuntime();
      if (!settings.apiKey || !(settings.smallModel || settings.model)) {
        if (trigger === "manual") throw new Error("请先配置模型后再 Consolidate");
        return null;
      }
      scheduleStartupRecovery(memory, settings);
      return memory.consolidate(trigger);
    },
    async createSession(previousSessionId?: string) {
      const settings = await loadRuntimeSettings();
      const memory = getMemoryRuntime();
      if (previousSessionId && sessionLocks.has(previousSessionId)) throw new Error("当前对话仍在运行");
      scheduleStartupRecovery(memory, settings);
      return memory.createConversation(previousSessionId);
    },
  };
}
/** 本地 Runtime 的公开接口。 */
export type AgentRuntime = ReturnType<typeof createAgentRuntime>;
