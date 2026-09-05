import { createModelClient } from "../model/model-client.ts";
import { RoughTokenEstimator } from "../model/token-estimator.ts";
import { LocalToolRegistry } from "../tools/tool-registry.ts";
import { ManageMemoryTool } from "../tools/manage-memory.ts";
import { MemoryRuntime, OpenAIEmbeddingClient } from "../memory/index.ts";
import { JsonlTracer, readTraceFiles } from "../tracing/jsonl-tracer.ts";
import { runAgentLoop } from "../agent-loop/agent-loop.ts";
import type { AgentMessage, AgentModelClient, AgentObserver, TokenEstimator, ToolCallRecord } from "../agent-loop/agent-loop.ts";
import type { AgentProvider } from "../model/model-client.ts";
import type { SessionRecallSettings, RetrievalMode } from "../memory/index.ts";
import { createLocalConfig } from "./local-config.ts";
import { clearEverythingData } from "./local-data.ts";
const VALID_PROVIDERS = new Set<AgentProvider>(["anthropic", "openai-compatible"]);
const VALID_RETRIEVAL_MODES = new Set<RetrievalMode>(["lexical_only", "dense_only", "hybrid"]);
const DEFAULT_TIMEOUT_MS = 60_000;
export const RUNTIME_DEFAULTS = {
  consolidationSessionInterval: 6,
  sessionSearchWindow: 5,
  sessionScrollStep: 10,
  sessionRecallMessageLimit: 100,
  sessionRecallTokenLimit: 8_192,
  modelContextWindow: 32_768,
} as const;
const OBSOLETE_CONFIG_KEYS = ["EVERYTHING_CHAT_TOKENIZER_ID", "EVERYTHING_EMBEDDING_TOKENIZER_ID"] as const;

interface RuntimeSettings {
  provider: AgentProvider;
  model: string;
  smallModel: string;
  consolidationSessionInterval: number;
  sessionSearchWindow: number;
  sessionScrollStep: number;
  sessionRecallMessageLimit: number;
  sessionRecallTokenLimit: number;
  modelContextWindow: number;
  retrievalMode: RetrievalMode;
  embeddingBaseUrl: string;
  embeddingModel: string;
  embeddingQueryTemplate: string;
  embeddingDocumentTemplate: string;
  embeddingMinimumSimilarity: number;
  embeddingApiKey: string;
  baseUrl: string;
  apiKey: string;
  keyName: "ANTHROPIC_API_KEY" | "OPENAI_API_KEY";
}

/** 保存运行配置的输入；省略预算字段时使用默认值。 */
export type AgentSettingsInput = Pick<RuntimeSettings, "provider" | "model"> &
  Partial<Omit<RuntimeSettings, "provider" | "model" | "keyName">> & {
    clearApiKey?: boolean; clearEmbeddingApiKey?: boolean; force?: boolean;
  };

/** 可安全发送到浏览器的本地 Agent 配置。 */
export interface PublicAgentSettings {
  provider: AgentProvider;
  model: string;
  smallModel: string;
  consolidationSessionInterval: number;
  sessionSearchWindow: number;
  sessionScrollStep: number;
  sessionRecallMessageLimit: number;
  sessionRecallTokenLimit: number;
  modelContextWindow: number;
  retrievalMode: RetrievalMode;
  embeddingBaseUrl: string;
  embeddingModel: string;
  embeddingQueryTemplate: string;
  embeddingDocumentTemplate: string;
  embeddingMinimumSimilarity: number;
  embeddingKeyConfigured: boolean;
  embeddingKeyLast4: string;
  embeddingIndex: ReturnType<MemoryRuntime["embeddingIndexStatus"]>;
  limits: typeof SETTING_LIMITS;
  baseUrl: string;
  keyConfigured: boolean;
  keyLast4: string;
}

const SETTING_LIMITS = {
  consolidationSessionInterval: { min: 1, max: 100 },
  sessionSearchWindow: { min: 1, max: 20 },
  sessionScrollStep: { min: 1, max: 50 },
  sessionRecallMessageLimit: { min: 1, max: 200 },
  sessionRecallTokenLimit: { min: 256, max: 131_072 },
  modelContextWindow: { min: 4_096, max: 2_000_000 },
} as const;

/** 配置保存失败时携带是否允许强制保存。 */
export class AgentConfigError extends Error {
  readonly canForce: boolean;

  constructor(message: string, canForce = false) {
    super(message);
    this.name = "AgentConfigError";
    this.canForce = canForce;
  }
}

/** 一次个人助理回合的输入。 */
export interface AgentRunInput { sessionId: string; prompt: string }
/** 宿主提供的事件接收器与取消信号。 */
export interface AgentRunOptions { observer: AgentObserver; signal: AbortSignal }
/** 回合完成结果，不包含页面展示数据。 */
export interface AgentRunResult {
  reply: string; iterations: number; stopReason: string; toolCallCount: number;
  model: string; provider: AgentProvider; ms: number; runId: string;
}
/** 创建本地个人助理 Runtime；资源与会话锁由实例独立持有。 */
export function createAgentRuntime(paths: import("./local-config.ts").LocalConfigPaths) {
  const everythingHome = paths.home;
  const config = createLocalConfig(paths);
  const { readEnvValues, updateEnvFile, readSystemPrompt } = config;
  let closed = false;
  let memoryRuntime: MemoryRuntime | null = null;
  let tracer: JsonlTracer | null = null;
  let recoveryScheduled = false;
  let dataClearing = false;
  const sessionLocks = new Map<string, Promise<void>>();
  const tokenEstimator = new RoughTokenEstimator();

  /** 保存模型配置；密钥永远不会出现在返回值中。 */
  async function saveAgentSettings(body: AgentSettingsInput): Promise<{
    settings: PublicAgentSettings;
    models: string[];
  }> {
    assertOpen();
    if (memoryRuntime?.isEmbeddingRebuildRunning()) {
      throw new AgentConfigError("Embedding 索引正在重建，请等待完成或先取消重建");
    }
    const provider = parseProvider(body.provider);
    const model = requiredText(body.model, "Model", 200);
    const smallModel = optionalText(body.smallModel, "Small Model", 200);
    const runtime = parseRuntimeSettingBody(body);
    if (runtime.embeddingBaseUrl) validateBaseUrl(runtime.embeddingBaseUrl);
    const baseUrl = optionalText(body.baseUrl, "Base URL", 2_000);
    const effectiveBaseUrl = provider === "openai-compatible" ? baseUrl : "";
    if (effectiveBaseUrl) validateBaseUrl(effectiveBaseUrl);
    const apiKey = optionalText(body.apiKey, "API Key", 10_000);
    const clearApiKey = body.clearApiKey === true;
    const embeddingApiKey = optionalText(body.embeddingApiKey, "Embedding API Key", 10_000);
    const clearEmbeddingApiKey = body.clearEmbeddingApiKey === true;
    const force = body.force === true;
    const before = await readEnvValues();
    const keyName = keyNameFor(provider);
    const currentKey = before[keyName] ?? "";
    const currentBaseUrl = before.EVERYTHING_BASE_URL ?? "";
    const candidateKey = clearApiKey ? "" : apiKey || currentKey;
    const candidateEmbeddingKey = clearEmbeddingApiKey ? "" : embeddingApiKey || before.EVERYTHING_EMBEDDING_API_KEY || "";
    const keyChanged = Boolean(apiKey && apiKey !== currentKey);
    const baseChanged = provider === "openai-compatible" && effectiveBaseUrl !== currentBaseUrl;
    let models: string[] = [];

    if (!clearApiKey && candidateKey && (keyChanged || baseChanged) && !force) {
      try {
        models = await probeModels(provider, candidateKey, effectiveBaseUrl);
      } catch (error) {
        throw new AgentConfigError(sanitizeError(error, [candidateKey]), true);
      }
    }

    const updates: Record<string, string> = {
      EVERYTHING_PROVIDER: provider,
      EVERYTHING_MODEL: model,
      EVERYTHING_SMALL_MODEL: smallModel,
      EVERYTHING_SESSION_SEARCH_WINDOW: String(runtime.sessionSearchWindow),
      EVERYTHING_CONSOLIDATION_SESSION_INTERVAL: String(runtime.consolidationSessionInterval),
      EVERYTHING_SESSION_SCROLL_STEP: String(runtime.sessionScrollStep),
      EVERYTHING_SESSION_RECALL_MESSAGE_LIMIT: String(runtime.sessionRecallMessageLimit),
      EVERYTHING_SESSION_RECALL_TOKEN_LIMIT: String(runtime.sessionRecallTokenLimit),
      EVERYTHING_MODEL_CONTEXT_WINDOW: String(runtime.modelContextWindow),
      EVERYTHING_RETRIEVAL_MODE: runtime.retrievalMode,
      EVERYTHING_EMBEDDING_BASE_URL: runtime.embeddingBaseUrl,
      EVERYTHING_EMBEDDING_MODEL: runtime.embeddingModel,
      EVERYTHING_EMBEDDING_QUERY_TEMPLATE: runtime.embeddingQueryTemplate,
      EVERYTHING_EMBEDDING_DOCUMENT_TEMPLATE: runtime.embeddingDocumentTemplate,
      EVERYTHING_EMBEDDING_MINIMUM_SIMILARITY: String(runtime.embeddingMinimumSimilarity),
      EVERYTHING_BASE_URL: effectiveBaseUrl,
    };
    if (apiKey) updates[keyName] = apiKey;
    if (embeddingApiKey) updates.EVERYTHING_EMBEDDING_API_KEY = embeddingApiKey;
    if (runtime.retrievalMode !== "lexical_only" && !(candidateEmbeddingKey && runtime.embeddingBaseUrl && runtime.embeddingModel)) {
      throw new AgentConfigError("Dense/Hybrid 模式必须完整配置独立的 Embedding Base URL、API Key 与 Model");
    }
    await updateEnvFile(updates, [
      ...(clearApiKey ? [keyName] : []),
      ...(clearEmbeddingApiKey ? ["EVERYTHING_EMBEDDING_API_KEY"] : []),
      ...OBSOLETE_CONFIG_KEYS,
    ]);
    const settings = await loadRuntimeSettings();
    return { settings: publicSettings(settings), models };
  }

  /** 清除指定模型提供方的本地 API Key，不修改其他尚未保存的配置。 */
  async function clearProviderApiKey(provider: AgentProvider): Promise<{
    settings: PublicAgentSettings;
  }> {
    assertOpen();
    await updateEnvFile({}, [keyNameFor(parseProvider(provider))]);
    return { settings: publicSettings(await loadRuntimeSettings()) };
  }

  /** 清除独立 Embedding API Key，并强制回到 lexical-only。 */
  async function clearEmbeddingApiKey(): Promise<{ settings: PublicAgentSettings }> {
    assertOpen();
    if (memoryRuntime?.isEmbeddingRebuildRunning()) throw new Error("Embedding 索引正在重建，请等待完成或先取消重建");
    await updateEnvFile({ EVERYTHING_RETRIEVAL_MODE: "lexical_only" }, ["EVERYTHING_EMBEDDING_API_KEY"]);
    const settings = await loadRuntimeSettings();
    getMemoryRuntime().configureRetrieval({ mode: "lexical_only", observer: (kind, event) => getTracer().record(kind, event) });
    return { settings: publicSettings(settings) };
  }

  /** 恢复全部运行参数默认值，保留模型连接和 EVERYTHING.md。 */
  async function resetRuntimeSettings(): Promise<{ settings: PublicAgentSettings }> {
    assertOpen();
    await updateEnvFile({
      EVERYTHING_SESSION_SEARCH_WINDOW: String(RUNTIME_DEFAULTS.sessionSearchWindow),
      EVERYTHING_CONSOLIDATION_SESSION_INTERVAL: String(RUNTIME_DEFAULTS.consolidationSessionInterval),
      EVERYTHING_SESSION_SCROLL_STEP: String(RUNTIME_DEFAULTS.sessionScrollStep),
      EVERYTHING_SESSION_RECALL_MESSAGE_LIMIT: String(RUNTIME_DEFAULTS.sessionRecallMessageLimit),
      EVERYTHING_SESSION_RECALL_TOKEN_LIMIT: String(RUNTIME_DEFAULTS.sessionRecallTokenLimit),
      EVERYTHING_MODEL_CONTEXT_WINDOW: String(RUNTIME_DEFAULTS.modelContextWindow),
    }, ["EVERYTHING_HISTORY_TURNS", ...OBSOLETE_CONFIG_KEYS]);
    return { settings: publicSettings(await loadRuntimeSettings()) };
  }

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
      await configureMemoryRuntime(memory, settings);
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
      const emit: AgentObserver = async (kind, event) => {
        const enriched = { ...event, ...(kind === "context_assembled" ? contextMetadata : {}), runId, sessionId };
        await observer(kind, enriched);
        if ([
          "context_assembled", "gate_start", "gate_end", "retrieval", "retrieval_completed",
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

  /** 清除数据库、Session、Memory 与 trace，仅保留 EVERYTHING.md。 */
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

  async function loadRuntimeSettings(): Promise<RuntimeSettings> {
    const values = await readEnvValues();
    const provider = parseProvider(values.EVERYTHING_PROVIDER || "anthropic");
    const keyName = keyNameFor(provider);
    return {
      provider,
      model: values.EVERYTHING_MODEL ?? "",
      smallModel: values.EVERYTHING_SMALL_MODEL ?? "",
      consolidationSessionInterval: parseSetting(values.EVERYTHING_CONSOLIDATION_SESSION_INTERVAL, "整理 Session 间隔", RUNTIME_DEFAULTS.consolidationSessionInterval, SETTING_LIMITS.consolidationSessionInterval),
      sessionSearchWindow: parseSetting(values.EVERYTHING_SESSION_SEARCH_WINDOW, "Session Search Window", RUNTIME_DEFAULTS.sessionSearchWindow, SETTING_LIMITS.sessionSearchWindow),
      sessionScrollStep: parseSetting(values.EVERYTHING_SESSION_SCROLL_STEP, "Session Scroll Step", RUNTIME_DEFAULTS.sessionScrollStep, SETTING_LIMITS.sessionScrollStep),
      sessionRecallMessageLimit: parseSetting(values.EVERYTHING_SESSION_RECALL_MESSAGE_LIMIT, "Session Recall Message Limit", RUNTIME_DEFAULTS.sessionRecallMessageLimit, SETTING_LIMITS.sessionRecallMessageLimit),
      sessionRecallTokenLimit: parseSetting(values.EVERYTHING_SESSION_RECALL_TOKEN_LIMIT, "Session Recall Token Limit", RUNTIME_DEFAULTS.sessionRecallTokenLimit, SETTING_LIMITS.sessionRecallTokenLimit),
      modelContextWindow: parseSetting(values.EVERYTHING_MODEL_CONTEXT_WINDOW, "Model Context Window", RUNTIME_DEFAULTS.modelContextWindow, SETTING_LIMITS.modelContextWindow),
      retrievalMode: parseRetrievalMode(values.EVERYTHING_RETRIEVAL_MODE || "lexical_only"),
      embeddingBaseUrl: values.EVERYTHING_EMBEDDING_BASE_URL ?? "",
      embeddingModel: values.EVERYTHING_EMBEDDING_MODEL ?? "",
      embeddingQueryTemplate: values.EVERYTHING_EMBEDDING_QUERY_TEMPLATE ?? "{text}",
      embeddingDocumentTemplate: values.EVERYTHING_EMBEDDING_DOCUMENT_TEMPLATE ?? "{text}",
      embeddingMinimumSimilarity: parseSimilarity(values.EVERYTHING_EMBEDDING_MINIMUM_SIMILARITY ?? "0.30"),
      embeddingApiKey: values.EVERYTHING_EMBEDDING_API_KEY ?? "",
      baseUrl: values.EVERYTHING_BASE_URL ?? "",
      apiKey: values[keyName] ?? "",
      keyName,
    };
  }

  async function probeModels(
    provider: AgentProvider,
    apiKey: string,
    baseUrl: string,
  ): Promise<string[]> {
    const endpoint = provider === "anthropic"
      ? `${normalizeBaseUrl(baseUrl || "https://api.anthropic.com")}/v1/models`
      : `${normalizeBaseUrl(baseUrl || "https://api.openai.com/v1")}/models`;
    const headers: Record<string, string> = provider === "anthropic"
      ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
      : { Authorization: `Bearer ${apiKey}` };
    const response = await fetch(endpoint, { headers, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`连接测试失败（HTTP ${response.status}）：${detail}`);
    }
    const payload = await response.json() as { data?: Array<{ id?: string }> };
    return (payload.data ?? []).map((item) => item.id ?? "").filter(Boolean).slice(0, 500);
  }

  function publicToolEvent(call: ToolCallRecord): Record<string, unknown> {
    const result = call.tool === "session_search" || call.tool === "session_read"
      ? sessionRecallToolMetadata(call.result)
      : call.tool === "manage_memory" ? memoryToolMetadata(call.result) : removeCredentials(call.result);
    return {
      tool: call.tool,
      toolCallId: call.toolUseId,
      iteration: call.iteration,
      isError: call.isError,
      arguments: call.tool === "manage_memory" ? memoryToolMetadata(call.args) : removeCredentials(call.args),
      result,
      outputLength: call.output.length,
      summary: call.isError ? "工具执行失败" : "工具执行完成",
    };
  }

  function memoryToolMetadata(value: unknown): unknown {
    if (Array.isArray(value)) return { count: value.length, ids: value.map((item) => item?.id).filter((id) => typeof id === "number") };
    if (!value || typeof value !== "object") return { redacted: true };
    const item = value as Record<string, unknown>;
    return Object.fromEntries(["action", "intent", "reasonCode", "targetId", "deletedIds"].filter((key) => item[key] !== undefined).map((key) => [key, item[key]]));
  }

  function sessionRecallToolMetadata(value: unknown): unknown {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const result = value as Record<string, unknown>;
    if (Array.isArray(result.sessions)) {
      return {
        retrievalMode: result.retrievalMode,
        requestedLimit: result.requestedLimit,
        returnedSessionCount: result.returnedSessionCount,
        droppedSessionCount: result.droppedSessionCount,
        truncated: result.truncated,
        sessions: result.sessions.map((item) => {
          const sessionResult = item as Record<string, unknown>;
          const session = sessionResult.session as Record<string, unknown> | undefined;
          return {
            sessionId: session?.id,
            rank: sessionResult.rank,
            match: sessionResult.match,
            retrievalSignals: sessionResult.retrievalSignals,
            returnedMessageCount: sessionResult.returnedMessageCount,
            returnedRanges: sessionResult.returnedRanges,
            isComplete: sessionResult.isComplete,
            truncated: sessionResult.truncated,
          };
        }),
      };
    }
    const session = result.session as Record<string, unknown> | undefined;
    return {
      mode: result.mode,
      sessionId: session?.id,
      totalMessageCount: result.totalMessageCount,
      returnedMessageCount: result.returnedMessageCount,
      returnedRanges: result.returnedRanges,
      isComplete: result.isComplete,
      truncated: result.truncated,
      expandLimitReached: result.expandLimitReached,
    };
  }

  function publicSettings(settings: RuntimeSettings): PublicAgentSettings {
    const memory = getMemoryRuntime();
    const embeddingIndex = memory.embeddingIndexStatus();
    const embeddingProfile = settings.embeddingApiKey && settings.embeddingBaseUrl && settings.embeddingModel
      ? {
          baseUrl: settings.embeddingBaseUrl, apiKey: settings.embeddingApiKey, model: settings.embeddingModel,
          queryTemplate: settings.embeddingQueryTemplate,
          documentTemplate: settings.embeddingDocumentTemplate, minimumSimilarity: settings.embeddingMinimumSimilarity,
        }
      : null;
    return {
      provider: settings.provider,
      model: settings.model,
      smallModel: settings.smallModel,
      consolidationSessionInterval: settings.consolidationSessionInterval,
      sessionSearchWindow: settings.sessionSearchWindow,
      sessionScrollStep: settings.sessionScrollStep,
      sessionRecallMessageLimit: settings.sessionRecallMessageLimit,
      sessionRecallTokenLimit: settings.sessionRecallTokenLimit,
      modelContextWindow: settings.modelContextWindow,
      retrievalMode: settings.retrievalMode,
      embeddingBaseUrl: settings.embeddingBaseUrl,
      embeddingModel: settings.embeddingModel,
      embeddingQueryTemplate: settings.embeddingQueryTemplate,
      embeddingDocumentTemplate: settings.embeddingDocumentTemplate,
      embeddingMinimumSimilarity: settings.embeddingMinimumSimilarity,
      embeddingKeyConfigured: Boolean(settings.embeddingApiKey),
      embeddingKeyLast4: settings.embeddingApiKey ? settings.embeddingApiKey.slice(-4) : "",
      embeddingIndex: { ...embeddingIndex, ready: Boolean(embeddingProfile && memory.embeddingIndexMatches(embeddingProfile)) },
      limits: SETTING_LIMITS,
      baseUrl: settings.baseUrl,
      keyConfigured: Boolean(settings.apiKey),
      keyLast4: settings.apiKey ? settings.apiKey.slice(-4) : "",
    };
  }

  function parseRuntimeSettingBody(body: AgentSettingsInput) {
    return {
      consolidationSessionInterval: parseSetting(body.consolidationSessionInterval, "整理 Session 间隔", RUNTIME_DEFAULTS.consolidationSessionInterval, SETTING_LIMITS.consolidationSessionInterval),
      sessionSearchWindow: parseSetting(body.sessionSearchWindow, "Session Search Window", RUNTIME_DEFAULTS.sessionSearchWindow, SETTING_LIMITS.sessionSearchWindow),
      sessionScrollStep: parseSetting(body.sessionScrollStep, "Session Scroll Step", RUNTIME_DEFAULTS.sessionScrollStep, SETTING_LIMITS.sessionScrollStep),
      sessionRecallMessageLimit: parseSetting(body.sessionRecallMessageLimit, "Session Recall Message Limit", RUNTIME_DEFAULTS.sessionRecallMessageLimit, SETTING_LIMITS.sessionRecallMessageLimit),
      sessionRecallTokenLimit: parseSetting(body.sessionRecallTokenLimit, "Session Recall Token Limit", RUNTIME_DEFAULTS.sessionRecallTokenLimit, SETTING_LIMITS.sessionRecallTokenLimit),
      modelContextWindow: parseSetting(body.modelContextWindow, "Model Context Window", RUNTIME_DEFAULTS.modelContextWindow, SETTING_LIMITS.modelContextWindow),
      retrievalMode: parseRetrievalMode(body.retrievalMode ?? "lexical_only"),
      embeddingBaseUrl: optionalText(body.embeddingBaseUrl, "Embedding Base URL", 2_000),
      embeddingModel: optionalText(body.embeddingModel, "Embedding Model", 500),
      embeddingQueryTemplate: embeddingTemplate(body.embeddingQueryTemplate, "Query Template"),
      embeddingDocumentTemplate: embeddingTemplate(body.embeddingDocumentTemplate, "Document Template"),
      embeddingMinimumSimilarity: parseSimilarity(body.embeddingMinimumSimilarity ?? 0.30),
    };
  }

  function parseSetting(value: unknown, name: string, fallback: number, limits: { min: number; max: number }): number {
    const number = value === undefined || value === "" ? fallback : Number(value);
    if (!Number.isInteger(number) || number < limits.min || number > limits.max) {
      throw new TypeError(`${name} 必须是 ${limits.min}–${limits.max} 的整数`);
    }
    return number;
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
        currentSessionId: "", observer: (kind, event) => getTracer().record(kind, event),
      };
    });
  }

  /** 创建真实模型客户端；非 Loop 调用也使用同一估算预算。 */
  function createRuntimeClient(settings: RuntimeSettings, estimator?: TokenEstimator): AgentModelClient {
    const client = createModelClient(settings);
    if (!estimator) return client;
    return {
      messages: {
        async create(request) {
          assertModelTokenLimit(request, settings.modelContextWindow, estimator);
          return client.messages.create(request);
        },
        ...(client.messages.stream ? { stream: client.messages.stream.bind(client.messages) } : {}),
      },
    };
  }

  function assertModelTokenLimit(
    request: Parameters<AgentModelClient["messages"]["create"]>[0],
    modelContextWindow: number,
    estimator: TokenEstimator,
  ): void {
    const estimatedInputTokens = estimator.estimateRequest(request);
    const total = estimatedInputTokens + request.max_tokens + 512;
    if (total > modelContextWindow) {
      throw new Error(`模型输入估算、输出预留与安全余量共 ${total} tokens，超过 Context Window ${modelContextWindow}`);
    }
  }

  function recallSettings(settings: RuntimeSettings, estimator: TokenEstimator): SessionRecallSettings {
    return {
      searchWindow: settings.sessionSearchWindow,
      scrollStep: settings.sessionScrollStep,
      messageLimit: settings.sessionRecallMessageLimit,
      tokenLimit: settings.sessionRecallTokenLimit,
      tokenEstimator: estimator,
    };
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

  function isFinalAssistantMessage(message: AgentMessage | undefined): boolean {
    return Boolean(message?.role === "assistant" && Array.isArray(message.content)
      && !message.content.some((block: { type?: string }) => block.type === "tool_use"));
  }

  function removeCredentials(value: unknown, key = ""): unknown {
    const normalizedKey = key.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
    if (/(?:^|_)(?:api_key|authorization|cookie|token|access_token|refresh_token|auth_token|secret|client_secret|password)(?:$|_)/.test(normalizedKey)) {
      return "[凭证已移除]";
    }
    if (Array.isArray(value)) return value.map((item) => removeCredentials(item));
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([itemKey, itemValue]) => [itemKey, removeCredentials(itemValue, itemKey)]));
  }

  function parseProvider(value: unknown): AgentProvider {
    if (typeof value !== "string" || !VALID_PROVIDERS.has(value as AgentProvider)) {
      throw new TypeError("Provider 必须是 anthropic 或 openai-compatible");
    }
    return value as AgentProvider;
  }

  function parseRetrievalMode(value: unknown): RetrievalMode {
    if (typeof value !== "string" || !VALID_RETRIEVAL_MODES.has(value as RetrievalMode)) {
      throw new TypeError("Retrieval Mode 必须是 lexical_only、dense_only 或 hybrid");
    }
    return value as RetrievalMode;
  }

  function parseSimilarity(value: unknown): number {
    const number = Number(value);
    if (!Number.isFinite(number) || number < -1 || number > 1) {
      throw new TypeError("Minimum Similarity 必须是 -1–1 的数字");
    }
    return number;
  }

  function embeddingTemplate(value: unknown, field: string): string {
    const template = value === undefined ? "{text}" : optionalText(value, field, 2_000);
    if ((template.match(/\{text\}/g) ?? []).length !== 1) throw new TypeError(`${field} 必须且只能包含一个 {text}`);
    return template;
  }

  function keyNameFor(provider: AgentProvider): RuntimeSettings["keyName"] {
    return provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
  }

  function requiredText(value: unknown, field: string, maxLength: number): string {
    const text = optionalText(value, field, maxLength);
    if (!text.trim()) throw new TypeError(`${field} 不能为空`);
    return text;
  }

  function optionalText(value: unknown, field: string, maxLength: number): string {
    if (value === undefined || value === null) return "";
    if (typeof value !== "string" || value.length > maxLength) {
      throw new TypeError(`${field} 必须是小于 ${maxLength} 字符的字符串`);
    }
    return value.trim();
  }

  function validateBaseUrl(value: string): void {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) throw new TypeError("Base URL 只支持 HTTP 或 HTTPS");
  }

  function normalizeBaseUrl(value: string): string {
    validateBaseUrl(value);
    return value.replace(/\/$/, "");
  }

  function sanitizeError(error: unknown, secrets: string[]): string {
    let message = error instanceof Error ? error.message : String(error);
    for (const secret of secrets) if (secret) message = message.replaceAll(secret, "***");
    return message;
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
    async createSession(previousSessionId?: string) {
      const settings = await loadRuntimeSettings();
      const memory = getMemoryRuntime();
      if (previousSessionId && sessionLocks.has(previousSessionId)) throw new Error("当前对话仍在运行");
      scheduleStartupRecovery(memory, settings);
      return memory.createConversation(previousSessionId, settings.consolidationSessionInterval);
    },
  };
}
/** 本地 Runtime 的公开接口。 */
export type AgentRuntime = ReturnType<typeof createAgentRuntime>;
