import { createRuntimeTracer } from "../tracing/runtime-tracer.ts";
import { join } from "node:path";
import { RoughTokenEstimator } from "../model/token-estimator.ts";
import { LocalToolRegistry } from "../tools/tool-registry.ts";
import { ManageMemoryTool } from "../tools/manage-memory.ts";
import { MemoryRuntime } from "../memory/index.ts";
import { readTraceFiles } from "../tracing/jsonl-tracer.ts";
import { AgentLoopAbortError, AgentLoopTimeoutError, runAgentLoop } from "../agent-loop/agent-loop.ts";
import type { AgentMessage, AgentObserver } from "../agent-loop/agent-loop.ts";
import { ApprovalRegistry } from "./approval-registry.ts";
import type { PendingApproval } from "./approval-registry.ts";
import { createLocalConfig } from "./local-config.ts";
import type { LocalConfigPaths } from "./local-config.ts";
import { clearEverythingData } from "./local-data.ts";
import { AgentConfigError, requiredText } from "./configuration/schema.ts";
import type { AgentSettingsInput, ModelConnectionTarget, PublicAgentSettings, RuntimeSettings } from "./configuration/schema.ts";
import { createRuntimeSettings, publicSettings } from "./configuration/settings.ts";
import { availableInputTokens, contextWaterline, CONTEXT_SAFETY_TOKENS } from "./context-window.ts";
import type { ContextUsage } from "./context-window.ts";
import { createRuntimeClient } from "./integrations/model.ts";
import { configureMemoryRuntime, recallSettings } from "./integrations/memory.ts";
import { publicToolEvent } from "./events/tool-events.ts";
import { startDailyConsolidationCheck } from "./daily-consolidation.ts";
import type { DailyConsolidationCheck } from "./daily-consolidation.ts";
import { formatSkillCatalog, SkillStore } from "../skills/index.ts";
import { createToolSettings } from "../tools/tool-settings.ts";
import type { ToolSettingsInput } from "../tools/tool-settings.ts";
import type { AgentRunInput, AgentRunOptions, AgentRunResult } from "./types.ts";

import { RUNTIME_SYSTEM_PROMPT } from "./system-prompt.ts";

const DEFAULT_TIMEOUT_MS = 300_000;

/** 创建本地个人助理 Runtime；资源与会话锁由实例独立持有。 */
export function createAgentRuntime(paths: LocalConfigPaths, options: { langfuse?: boolean } = {}) {
  const everythingHome = paths.home;
  const config = createLocalConfig(paths);
  const { readSystemPrompt } = config;
  const settingsStore = createRuntimeSettings(config);
  const toolSettingsStore = createToolSettings(config);
  // 终端工具在工作区之外唯一可写的目录，同时作为子进程 TMPDIR。
  const terminalTempDir = join(everythingHome, "terminal-tmp");
  // 同一时刻只允许一轮运行，因此活跃的审批通道最多一个；界面的确认走独立请求进来。
  let activeApprovals: ApprovalRegistry | null = null;
  const loadRuntimeSettings = settingsStore.load;
  let closed = false;
  let memoryRuntime: MemoryRuntime | null = null;
  let tracer: ReturnType<typeof createRuntimeTracer> | null = null;
  let recoveryScheduled = false;
  let dailyConsolidation: DailyConsolidationCheck | null = null;
  let dataClearing = false;
  const backgroundObservers = new Set<AgentObserver>();
  const sessionLocks = new Map<string, Promise<void>>();
  const tokenEstimator = new RoughTokenEstimator();
  const skills = new SkillStore(everythingHome);
  // 基础检索配置事件直接落盘；聊天与后台队列在各自执行入口发布事件。
  const recordMemoryEvent: AgentObserver = (kind, event) => getTracer().record(kind, event);

  /** 保存模型配置；密钥永远不会出现在返回值中。 */
  async function saveAgentSettings(body: AgentSettingsInput): Promise<{
    settings: PublicAgentSettings;
    models: Record<ModelConnectionTarget, string[]>;
  }> {
    assertOpen();
    if (memoryRuntime?.isEmbeddingRebuildRunning()) {
      throw new AgentConfigError("Embedding 索引正在重建，请等待完成或先取消重建");
    }
    const { settings, models } = await settingsStore.save(body);
    return { settings: publicSettings(settings, getMemoryRuntime()), models };
  }

  /** 清除指定用途模型连接的本地 API Key，不影响另一条连接。 */
  async function clearModelApiKey(target: ModelConnectionTarget): Promise<{ settings: PublicAgentSettings }> {
    assertOpen();
    const settings = await settingsStore.clearModelApiKey(target);
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
      memory.configureRetrieval({ mode: "lexical_only", observer: recordMemoryEvent });
      const active = memory.activeEmbeddingProfile();
      // 只恢复当前凭证对应的连接；跨供应商重建失败时保留原错误，后续运行仍要求重建。
      if (active?.provider === settings.embeddingProvider && active.baseUrl === settings.embeddingBaseUrl) {
        await configureMemoryRuntime(memory, settings, recordMemoryEvent);
        scheduleStartupRecovery(memory, settings);
      }
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

  /** 保存可配置工具的启用状态与凭证，并返回脱敏后的完整目录。 */
  async function saveToolSettings(input: ToolSettingsInput) {
    assertOpen();
    await toolSettingsStore.save(input);
    return toolSettingsStore.publicCatalog();
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
    const toolSettings = await toolSettingsStore.load();
    assertModelConnectionConfigured(settings.agentModel, "Agent Model");
    assertModelConnectionConfigured(settings.smallModel, "Small Model");

    return withSessionLock(sessionId, async () => {
      const memory = getMemoryRuntime();
      await configureMemoryRuntime(memory, settings, recordMemoryEvent);
      scheduleStartupRecovery(memory, settings);
      const trace = getTracer();
      const agentClient = createRuntimeClient(settings.agentModel, settings.modelContextWindow, tokenEstimator);
      const smallClient = createRuntimeClient(settings.smallModel, settings.modelContextWindow, tokenEstimator);
      const runId = crypto.randomUUID();
      const startedAt = performance.now();
      const userEvidence = memory.startRun(sessionId, runId, prompt);
      await trace.record("run_started", {
        runId,
        sessionId,
        userInput: prompt,
        provider: settings.agentModel.provider,
        model: settings.agentModel.model,
        settings: {
          modelContextWindow: settings.modelContextWindow,
          sessionRecall: recallSettings(settings, tokenEstimator),
          maxIterations: settings.maxIterations,
          maxTokens: settings.maxTokens,
          timeoutMs: DEFAULT_TIMEOUT_MS,
          stream: true,
        },
        runtime: { nodeVersion: process.version, traceSchemaVersion: 2 },
      });
      let contextMetadata: Record<string, unknown> = {};
      // 检索在 try 之外声明，失败回合也能报告已经花掉的检索时间。
      let retrievalMs = 0;
      // 记忆写入是异步队列，回合结束时任务往往还没执行；记下 taskId 才能把回合 trace
      // 与 <序号>-memory_write-<taskId>.jsonl 对上。
      const derivedTaskIds = new Set<string>();
      // 在执行边界统一关联回合与会话；observer 保持完整事件流，trace 只保存选定事件。
      const emit: AgentObserver = async (kind, event) => {
        const enriched = { ...event, ...(kind === "context_assembled" ? contextMetadata : {}), runId, sessionId };
        collectDerivedTaskId(derivedTaskIds, kind, enriched);
        await observer(kind, enriched);
        if ([
          "context_assembled", "gate_start", "gate_end", "retrieval_start", "retrieval_completed",
          "embedding_started", "embedding_completed", "embedding_failed",
          "dense_retrieval_completed", "lexical_retrieval_completed", "rrf_completed", "mmr_completed",
          "model_request", "model_response", "model_failed", "stream_fallback",
          "tool_started", "tool_completed", "tool_failed", "skills_discovered", "skill_loaded",
          "approval_requested", "approval_resolved", "command_blocked", "sandbox_denied",
        ].includes(kind) || kind.startsWith("memory_") || kind.startsWith("compact_")) {
          const modelFields = kind.startsWith("model_") ? { provider: settings.agentModel.provider, model: settings.agentModel.model } : {};
          await trace.record(kind, { ...enriched, ...modelFields });
        }
      };
      const approvals = new ApprovalRegistry(emit);
      activeApprovals = approvals;
      try {
        const history = memory.getWorkingMemory(sessionId);
        const gateHistory = memory.getWorkingMemory(sessionId, 3);
        const retrievalStartedAt = performance.now();
        const retrieval = await memory.retrieve(prompt, gateHistory, {
          client: smallClient,
          model: settings.smallModel.model,
          currentSessionId: sessionId,
          recall: recallSettings(settings, tokenEstimator),
          observer: emit,
          runId,
        });
        retrievalMs = Math.round(performance.now() - retrievalStartedAt);
        const messages: AgentMessage[] = [...history, { role: "user", content: prompt }];
        const appendedFrom = messages.length;
        const baseSystem = await readSystemPrompt();
        const availableSkills = await skills.list();
        const skillCatalog = formatSkillCatalog(availableSkills);
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
          availableSkills: availableSkills.map((skill) => skill.name),
        };
        await emit("skills_discovered", {
          skills: availableSkills.map((skill) => ({ name: skill.name, description: skill.description })),
          count: availableSkills.length,
        });
        const result = await runAgentLoop({
          client: agentClient,
          model: settings.agentModel.model,
          system: [RUNTIME_SYSTEM_PROMPT, baseSystem, skillCatalog, retrieval.context].filter(Boolean).join("\n\n"),
          messages,
          tools: new LocalToolRegistry(memory, new ManageMemoryTool(memory, {
            client: agentClient, model: settings.agentModel.model, currentSessionId: sessionId,
            runId, evidenceMessageId: userEvidence.id, observer: emit,
          }), {
            currentSessionId: sessionId,
            settings: recallSettings(settings, tokenEstimator),
          }, skills, {
            getCurrentTimeEnabled: toolSettings.getCurrentTimeEnabled,
            terminalEnabled: toolSettings.terminalEnabled,
            terminalWorkspaceRoot: settings.sandboxWorkspaceRoot,
            terminalSessionTempDir: terminalTempDir,
            approval: approvals,
            searchWebEnabled: toolSettings.searchWebEnabled,
            tavilyApiKey: toolSettings.tavilyApiKey,
          }),
          maxIterations: settings.maxIterations,
          maxTokens: settings.maxTokens,
          timeoutMs: DEFAULT_TIMEOUT_MS,
          stream: true,
          modelContextWindow: settings.modelContextWindow,
          onCompacted: (compaction) => memory.saveCompaction(sessionId, runId, messages.slice(appendedFrom), compaction),
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
        const context = contextWaterline(
          settings.modelContextWindow,
          settings.maxTokens,
          result.peakEstimatedInputTokens,
          result.peakInputTokens,
        );
        await trace.record("run_completed", {
          runId,
          sessionId,
          provider: settings.agentModel.provider,
          model: settings.agentModel.model,
          reply: result.reply,
          iterations: result.iterations,
          stopReason: result.stopReason,
          toolCallCount: result.toolCalls.length,
          failedToolCallCount: result.failedToolCallCount,
          derivedTaskIds: [...derivedTaskIds],
          ms,
          retrievalMs,
          modelMs: result.modelMs,
          toolMs: result.toolMs,
          ...context,
        });
        return {
          reply: result.reply,
          iterations: result.iterations,
          stopReason: result.stopReason,
          toolCallCount: result.toolCalls.length,
          failedToolCallCount: result.failedToolCallCount,
          derivedTaskIds: [...derivedTaskIds],
          model: settings.agentModel.model,
          provider: settings.agentModel.provider,
          ms,
          retrievalMs,
          modelMs: result.modelMs,
          toolMs: result.toolMs,
          ...context,
          runId,
        };
      } catch (error) {
        await trace.record("run_failed", {
          runId,
          sessionId,
          provider: settings.agentModel.provider,
          model: settings.agentModel.model,
          errorType: error instanceof Error ? error.name : "UnknownError",
          errorMessage: error instanceof Error ? error.message : String(error),
          // 用户主动停止与整轮超时都不是模型或工具故障，统计错误率时必须能摘出去。
          cancelled: error instanceof AgentLoopAbortError,
          timedOut: error instanceof AgentLoopTimeoutError,
          derivedTaskIds: [...derivedTaskIds],
          ms: Math.round(performance.now() - startedAt),
          retrievalMs,
        });
        throw error;
      } finally {
        // 运行结束后不能留下悬空的等待：界面上的确认卡此刻已经失效。
        approvals.rejectAll();
        if (activeApprovals === approvals) activeApprovals = null;
      }
    });
  }

  /** 兑现一次界面上的确认；返回 false 表示该请求已经失效。 */
  function settleApproval(approvalId: string, approved: boolean): boolean {
    return activeApprovals?.settle(approvalId, approved) ?? false;
  }

  /** 列出当前待确认的请求，供界面重新连接后恢复。 */
  function listPendingApprovals(): PendingApproval[] {
    return activeApprovals?.pending() ?? [];
  }

  /**
   * 估算下一轮回合起步就会占用的上下文，用于在超限之前展示水位。
   * 与 Loop 的硬限制共用估算器和额度公式；不含本轮检索注入的记忆。
   */
  async function contextUsage(sessionId: string): Promise<ContextUsage> {
    assertOpen();
    const settings = await loadRuntimeSettings();
    const toolSettings = await toolSettingsStore.load();
    const memory = getMemoryRuntime();
    const availableSkills = await skills.list();
    const system = [RUNTIME_SYSTEM_PROMPT, await readSystemPrompt(), formatSkillCatalog(availableSkills)]
      .filter(Boolean).join("\n\n");
    const tools = new LocalToolRegistry(memory, new ManageMemoryTool(memory), {
      currentSessionId: sessionId,
      settings: recallSettings(settings, tokenEstimator),
    }, skills, {
      getCurrentTimeEnabled: toolSettings.getCurrentTimeEnabled,
      terminalEnabled: toolSettings.terminalEnabled,
      terminalWorkspaceRoot: settings.sandboxWorkspaceRoot,
      terminalSessionTempDir: terminalTempDir,
      searchWebEnabled: toolSettings.searchWebEnabled,
      tavilyApiKey: toolSettings.tavilyApiKey,
    });
    return {
      contextWindow: settings.modelContextWindow,
      maxTokens: settings.maxTokens,
      contextSafetyTokens: CONTEXT_SAFETY_TOKENS,
      availableInputTokens: availableInputTokens(settings.modelContextWindow, settings.maxTokens),
      estimatedInputTokens: tokenEstimator.estimateRequest({
        model: settings.agentModel.model,
        system,
        messages: memory.getWorkingMemory(sessionId),
        tools: tools.schemas(),
        max_tokens: settings.maxTokens,
        signal: undefined,
      }),
    };
  }

  /** 读取本地追踪文件，展示结构由宿主组装。 */
  async function readTraces() {
    return readTraceFiles(everythingHome);
  }

  /** 列出可用 Skills；损坏的 SKILL.md 会阻止返回不完整目录。 */
  async function listSkills() {
    assertOpen();
    return skills.list();
  }

  /** 保存或重命名 Skill，并让后续回合重新发现。 */
  async function saveSkill(input: import("../skills/index.ts").SaveSkillInput) {
    assertOpen();
    return skills.save(input);
  }

  /** 删除 Skill 目录及其中的配套资源。 */
  async function deleteSkill(name: string) {
    assertOpen();
    return skills.delete(name);
  }

  /** 清除数据库、Session、Memory 与 trace，保留 EVERYTHING.md、Skills 和 config.json。 */
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
      if (tracer) await tracer.close();
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

  function getTracer(): ReturnType<typeof createRuntimeTracer> {
    tracer ??= createRuntimeTracer(everythingHome, options.langfuse !== false);
    return tracer;
  }

  /** 用户进入 Agent 页面、点击 Consolidate 或每日兜底检查；未配置模型时不占每日配额。 */
  async function consolidate(trigger: "daily" | "manual") {
    const settings = await loadRuntimeSettings();
    const memory = getMemoryRuntime();
    if (!isModelConnectionConfigured(settings.agentModel)) {
      if (trigger === "manual") throw new Error("请先配置模型后再 Consolidate");
      return null;
    }
    scheduleStartupRecovery(memory, settings);
    return memory.consolidate(trigger);
  }

  /** 页面只在挂载时触发 daily 整理，进程长期运行时由本地时间轮询兜底。 */
  function scheduleDailyConsolidation(): void {
    dailyConsolidation ??= startDailyConsolidationCheck({
      consolidate: () => consolidate("daily"),
      onError: (error) => void recordMemoryEvent("daily_consolidation_check_failed", {
        errorType: error instanceof Error ? error.name : "UnknownError",
      }),
    });
  }

  // 每个实例只启动一次消费器；每个后台任务执行前重新读取配置，不绑定聊天取消信号。
  function scheduleStartupRecovery(memory: MemoryRuntime, settings: RuntimeSettings): void {
    if (recoveryScheduled || !isModelConnectionConfigured(settings.agentModel)) return;
    recoveryScheduled = true;
    memory.startBackgroundTasks(async () => {
      const current = await loadRuntimeSettings();
      await configureMemoryRuntime(memory, current, recordMemoryEvent);
      return {
        client: createRuntimeClient(current.agentModel, current.modelContextWindow, tokenEstimator), model: current.agentModel.model,
        modelContextWindow: current.modelContextWindow, tokenEstimator,
        currentSessionId: "", observer: async (kind, event) => {
          const enriched = kind.includes("_model_")
            ? { ...event, provider: current.agentModel.provider, model: current.agentModel.model }
            : event;
          await getTracer().record(kind, enriched);
          for (const observer of backgroundObservers) await observer(kind, enriched);
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
      dailyConsolidation?.stop();
      dailyConsolidation = null;
      if (memoryRuntime) {
        memoryRuntime.stopBackgroundTasks();
        await memoryRuntime.waitForBackgroundTasks();
      }
      if (tracer) await tracer.close();
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
    saveAgentSettings, clearModelApiKey, clearEmbeddingApiKey, resetRuntimeSettings,
    rebuildEmbeddingIndex, cancelEmbeddingIndexRebuild, saveSystemPrompt,
    saveToolSettings,
    settleApproval,
    listPendingApprovals,
    clearLocalAgentData, readTraces, contextUsage,
    readSystemPrompt,
    listSkills, saveSkill, deleteSkill,
    getTools() { assertOpen(); return toolSettingsStore.publicCatalog(); },
    async getSettings() { return publicSettings(await loadRuntimeSettings(), getMemoryRuntime()); },
    async start() {
      assertOpen();
      await config.initialize();
      scheduleStartupRecovery(getMemoryRuntime(), await loadRuntimeSettings());
      scheduleDailyConsolidation();
    },
    get memory() { return getMemoryRuntime(); },
    async prepareMemory() {
      const memory = getMemoryRuntime();
      const settings = await loadRuntimeSettings();
      await configureMemoryRuntime(memory, settings, recordMemoryEvent);
      scheduleStartupRecovery(memory, settings);
      return recallSettings(settings, tokenEstimator);
    },
    consolidate,
    async createSession(previousSessionId?: string) {
      const settings = await loadRuntimeSettings();
      const memory = getMemoryRuntime();
      if (previousSessionId && sessionLocks.has(previousSessionId)) throw new Error("当前对话仍在运行");
      scheduleStartupRecovery(memory, settings);
      return memory.createConversation(previousSessionId);
    },
  };
}

/**
 * 从工具事件中挑出记忆写入队列返回的 taskId。
 * `publicToolEvent` 已把 manage_memory 的结果收敛成元数据，这里只读其中的 taskId。
 */
function collectDerivedTaskId(taskIds: Set<string>, kind: string, event: Record<string, unknown>): void {
  if (kind !== "tool_completed" || event.tool !== "manage_memory") return;
  const result = event.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return;
  const taskId = (result as Record<string, unknown>).taskId;
  if (typeof taskId === "string" && taskId) taskIds.add(taskId);
}

function isModelConnectionConfigured(connection: RuntimeSettings["agentModel"]): boolean {
  return Boolean(connection.apiKey && connection.model);
}

function assertModelConnectionConfigured(connection: RuntimeSettings["agentModel"], label: string): void {
  if (!connection.apiKey) throw new Error(`请先在配置页填写 ${label} API Key`);
  if (!connection.model) throw new Error(`请先在配置页填写 ${label} Model`);
}

/** 本地 Runtime 的公开接口。 */
export type AgentRuntime = ReturnType<typeof createAgentRuntime>;
