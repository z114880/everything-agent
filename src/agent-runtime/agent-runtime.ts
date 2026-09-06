import { RoughTokenEstimator } from "../model/token-estimator.ts";
import { LocalToolRegistry } from "../tools/tool-registry.ts";
import { ManageMemoryTool } from "../tools/manage-memory.ts";
import { MemoryRuntime } from "../memory/index.ts";
import { JsonlTracer, readTraceFiles } from "../tracing/jsonl-tracer.ts";
import { runAgentLoop } from "../agent-loop/agent-loop.ts";
import type { AgentMessage, AgentObserver } from "../agent-loop/agent-loop.ts";
import type { AgentProvider } from "../model/model-client.ts";
import { createLocalConfig } from "./local-config.ts";
import type { LocalConfigPaths } from "./local-config.ts";
import { clearEverythingData } from "./local-data.ts";
import { AgentConfigError, requiredText } from "./configuration/schema.ts";
import type { AgentSettingsInput, PublicAgentSettings, RuntimeSettings } from "./configuration/schema.ts";
import { createRuntimeSettings, publicSettings } from "./configuration/settings.ts";
import { createRuntimeClient } from "./integrations/model.ts";
import { configureMemoryRuntime, recallSettings } from "./integrations/memory.ts";
import { publicToolEvent } from "./events/tool-events.ts";
import type { AgentRunInput, AgentRunOptions, AgentRunResult } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 60_000;

/** 创建本地个人助理 Runtime；资源与会话锁由实例独立持有。 */
export function createAgentRuntime(paths: LocalConfigPaths) {
  const everythingHome = paths.home;
  const config = createLocalConfig(paths);
  const { readSystemPrompt } = config;
  const settingsStore = createRuntimeSettings(config);
  const loadRuntimeSettings = settingsStore.load;
  let closed = false;
  let memoryRuntime: MemoryRuntime | null = null;
  let tracer: JsonlTracer | null = null;
  let recoveryScheduled = false;
  let dataClearing = false;
  const backgroundObservers = new Set<AgentObserver>();
  const sessionLocks = new Map<string, Promise<void>>();
  const tokenEstimator = new RoughTokenEstimator();
  // 基础检索配置事件直接落盘；聊天与后台队列在各自执行入口发布事件。
  const recordMemoryEvent: AgentObserver = (kind, event) => getTracer().record(kind, event);

  /** 保存模型配置；密钥永远不会出现在返回值中。 */
  async function saveAgentSettings(body: AgentSettingsInput): Promise<{
    settings: PublicAgentSettings;
    models: string[];
  }> {
    assertOpen();
    if (memoryRuntime?.isEmbeddingRebuildRunning()) {
      throw new AgentConfigError("Embedding 索引正在重建，请等待完成或先取消重建");
    }
    const { settings, models } = await settingsStore.save(body);
    return { settings: publicSettings(settings, getMemoryRuntime()), models };
  }

  /** 清除指定模型提供方的本地 API Key，不修改其他尚未保存的配置。 */
  async function clearProviderApiKey(provider: AgentProvider): Promise<{ settings: PublicAgentSettings }> {
    assertOpen();
    const settings = await settingsStore.clearProviderApiKey(provider);
    return { settings: publicSettings(settings, getMemoryRuntime()) };
  }

  /** 清除独立 Embedding API Key，并强制回到 lexical-only。 */
  async function clearEmbeddingApiKey(): Promise<{ settings: PublicAgentSettings }> {
    assertOpen();
    if (memoryRuntime?.isEmbeddingRebuildRunning()) throw new Error("Embedding 索引正在重建，请等待完成或先取消重建");
    const settings = await settingsStore.clearEmbeddingApiKey();
    getMemoryRuntime().configureRetrieval({ mode: "lexical_only", observer: recordMemoryEvent });
    return { settings: publicSettings(settings, getMemoryRuntime()) };
  }

  /** 恢复全部运行参数默认值，保留模型连接和 EVERYTHING.md。 */
  async function resetRuntimeSettings(): Promise<{ settings: PublicAgentSettings }> {
    assertOpen();
    return { settings: publicSettings(await settingsStore.reset(), getMemoryRuntime()) };
  }

  /** 使用已保存的 Embedding profile 建立影子索引，成功后原子激活。 */
  async function rebuildEmbeddingIndex(): Promise<{ result: Awaited<ReturnType<MemoryRuntime["rebuildEmbeddings"]>>; settings: PublicAgentSettings }> {
    assertOpen();
    const settings = await loadRuntimeSettings();
    const memory = getMemoryRuntime();
    await configureMemoryRuntime(memory, settings, recordMemoryEvent, true);
    try {
      const result = await memory.rebuildEmbeddings();
      return { result, settings: publicSettings(settings, getMemoryRuntime()) };
    } finally {
      // 无论成功、失败还是取消，都退出 allowIncompleteIndex 临时状态。
      // 失败时普通运行会重新绑定旧 active generation，避免影子索引语义名存实亡。
      await configureMemoryRuntime(memory, settings, recordMemoryEvent);
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

  /** 执行一次真实 Agent 回合，并通过 observer 流式暴露可观察事件。 */
  async function runLocalAgent(
    input: AgentRunInput,
    { observer, signal }: AgentRunOptions,
  ): Promise<AgentRunResult> {
    assertOpen();
    if (dataClearing) throw new Error("本地数据正在清理，请稍后重试");
    const prompt = requiredText(input.prompt, "User Prompt", 40_000);
    const sessionId = requiredText(input.sessionId, "Session ID", 200);
    const settings = await loadRuntimeSettings();
    if (!settings.apiKey) throw new Error(`请先在配置页填写 ${settings.keyName}`);
    if (!settings.model) throw new Error("请先在配置页填写 Model");

    return withSessionLock(sessionId, async () => {
      const memory = getMemoryRuntime();
      await configureMemoryRuntime(memory, settings, recordMemoryEvent);
      scheduleStartupRecovery(memory, settings);
      const trace = getTracer();
      const client = createRuntimeClient(settings, tokenEstimator);
      const runId = crypto.randomUUID();
      const startedAt = performance.now();
      const userEvidence = memory.startRun(sessionId, runId, prompt);
      await trace.record("run_started", {
        runId,
        sessionId,
        userInput: prompt,
        provider: settings.provider,
        model: settings.model,
        settings: {
          modelContextWindow: settings.modelContextWindow,
          sessionRecall: recallSettings(settings, tokenEstimator),
          maxIterations: 10,
          maxTokens: 2_048,
          timeoutMs: DEFAULT_TIMEOUT_MS,
          stream: true,
        },
        runtime: { nodeVersion: process.version, traceSchemaVersion: 2 },
      });
      let contextMetadata: Record<string, unknown> = {};
      // 在执行边界统一关联回合与会话；observer 保持完整事件流，trace 只保存选定事件。
      const emit: AgentObserver = async (kind, event) => {
        const enriched = { ...event, ...(kind === "context_assembled" ? contextMetadata : {}), runId, sessionId };
        await observer(kind, enriched);
        if ([
          "context_assembled", "gate_start", "gate_end", "retrieval_start", "retrieval_completed",
          "embedding_started", "embedding_completed", "embedding_failed",
          "dense_retrieval_completed", "lexical_retrieval_completed", "rrf_completed", "mmr_completed",
          "model_request", "model_response", "model_failed", "stream_fallback",
          "tool_started", "tool_completed", "tool_failed",
        ].includes(kind) || kind.startsWith("memory_")) {
          const modelFields = kind.startsWith("model_") ? { provider: settings.provider, model: settings.model } : {};
          await trace.record(kind, { ...enriched, ...modelFields });
        }
      };
      try {
        const history = memory.getWorkingMemory(sessionId);
        const gateHistory = memory.getWorkingMemory(sessionId, 3);
        const retrieval = await memory.retrieve(prompt, gateHistory, {
          client,
          model: settings.smallModel || settings.model,
          currentSessionId: sessionId,
          recall: recallSettings(settings, tokenEstimator),
          observer: emit,
          runId,
        });
        const messages: AgentMessage[] = [...history, { role: "user", content: prompt }];
        const appendedFrom = messages.length;
        const baseSystem = await readSystemPrompt();
        contextMetadata = {
          historyMessageCount: history.length,
          semanticMemoryIds: retrieval.semantic.map((item) => item.id),
          sessionRecallSessionIds: retrieval.sessionRecall?.sessions.map((item) => item.session.id) ?? [],
          sessionRecallRanges: retrieval.sessionRecall?.sessions.map((item) => ({ sessionId: item.session.id, ranges: item.returnedRanges })) ?? [],
          sessionRecallEntryCount: retrieval.sessionRecall?.sessions.reduce((sum, item) => sum + item.returnedMessageCount, 0) ?? 0,
          sessionRecallEstimatedTokens: retrieval.sessionRecall
            ? tokenEstimator.estimateText(JSON.stringify(retrieval.sessionRecall.sessions.flatMap((item) => item.entries)))
            : 0,
          sessionRecallTruncated: retrieval.sessionRecall?.truncated ?? false,
        };
        const result = await runAgentLoop({
          client,
          model: settings.model,
          system: [baseSystem, retrieval.context].filter(Boolean).join("\n\n"),
          messages,
          tools: new LocalToolRegistry(memory, new ManageMemoryTool(memory, {
            client, model: settings.smallModel || settings.model, currentSessionId: sessionId,
            runId, evidenceMessageId: userEvidence.id, observer: emit,
          }), {
            currentSessionId: sessionId,
            settings: recallSettings(settings, tokenEstimator),
          }),
          maxIterations: 10,
          timeoutMs: DEFAULT_TIMEOUT_MS,
          stream: true,
          modelContextWindow: settings.modelContextWindow,
          tokenEstimator,
          signal,
          observer: emit,
          serializeToolEvent: publicToolEvent,
          runId,
        });
        // Loop 原地追加消息；只提交本轮新增内容，避免重复写入历史或用户证据。
        const appended = messages.slice(appendedFrom);
        if (!isFinalAssistantMessage(appended.at(-1))) {
          appended.push({ role: "assistant", content: [{ type: "text", text: result.reply }] });
        }
        await memory.completeRun(sessionId, runId, appended);
        const ms = Math.round(performance.now() - startedAt);
        await trace.record("run_completed", {
          runId,
          sessionId,
          reply: result.reply,
          iterations: result.iterations,
          stopReason: result.stopReason,
          toolCallCount: result.toolCalls.length,
          ms,
        });
        return {
          reply: result.reply,
          iterations: result.iterations,
          stopReason: result.stopReason,
          toolCallCount: result.toolCalls.length,
          model: settings.model,
          provider: settings.provider,
          ms,
          runId,
        };
      } catch (error) {
        await trace.record("run_failed", {
          runId,
          sessionId,
          errorType: error instanceof Error ? error.name : "UnknownError",
          errorMessage: error instanceof Error ? error.message : String(error),
          ms: Math.round(performance.now() - startedAt),
        });
        throw error;
      }
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
      // 先停止领取任务并等待在途写入，再落盘 trace、释放数据库，最后删除数据。
      if (memoryRuntime) {
        memoryRuntime.stopBackgroundTasks();
        await memoryRuntime.waitForBackgroundTasks();
      }
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

  // 每个实例只启动一次消费器；每个后台任务执行前重新读取配置，不绑定聊天取消信号。
  function scheduleStartupRecovery(memory: MemoryRuntime, settings: RuntimeSettings): void {
    if (recoveryScheduled || !settings.apiKey || !(settings.smallModel || settings.model)) return;
    recoveryScheduled = true;
    memory.startBackgroundTasks(async () => {
      const current = await loadRuntimeSettings();
      await configureMemoryRuntime(memory, current, recordMemoryEvent);
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

  // 锁覆盖历史读取到回合落盘；同一会话排队，不同会话互不等待。
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
      // 无论回合成功或失败都释放等待者；只有队尾可以移除锁记录。
      release();
      if (sessionLocks.get(sessionId) === tail) sessionLocks.delete(sessionId);
    }
  }

  function isFinalAssistantMessage(message: AgentMessage | undefined): boolean {
    return Boolean(message?.role === "assistant" && Array.isArray(message.content)
      && !message.content.some((block: { type?: string }) => block.type === "tool_use"));
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
      if (memoryRuntime) {
        memoryRuntime.stopBackgroundTasks();
        await memoryRuntime.waitForBackgroundTasks();
      }
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
    async getSettings() { return publicSettings(await loadRuntimeSettings(), getMemoryRuntime()); },
    async start() {
      assertOpen();
      scheduleStartupRecovery(getMemoryRuntime(), await loadRuntimeSettings());
    },
    get memory() { return getMemoryRuntime(); },
    async prepareMemory() {
      const memory = getMemoryRuntime();
      const settings = await loadRuntimeSettings();
      await configureMemoryRuntime(memory, settings, recordMemoryEvent);
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
