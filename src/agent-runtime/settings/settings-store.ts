import type { AgentProvider } from "../../model/model-client.ts";
import type { MemoryRuntime } from "../../memory/index.ts";
import type { JsonlTracer } from "../../tracing/jsonl-tracer.ts";
import type { createLocalConfig } from "../local-config.ts";
import { AgentConfigError, RUNTIME_DEFAULTS, SETTING_LIMITS, OBSOLETE_CONFIG_KEYS } from "./types.ts";
import type { AgentSettingsInput, PublicAgentSettings, RuntimeSettings } from "./types.ts";
import { parseProvider, requiredText, optionalText, parseRuntimeSettingBody, validateBaseUrl, keyNameFor, sanitizeError, parseSetting, parseRetrievalMode, parseSimilarity, normalizeBaseUrl } from "./validation.ts";

/** 管理配置校验、连接探测和持久化；资源状态由 Runtime 实例提供。 */
export function createSettingsStore({ config, assertOpen, getMemoryRuntime, getTracer, isEmbeddingRebuildRunning }: {
  config: ReturnType<typeof createLocalConfig>;
  assertOpen: () => void;
  getMemoryRuntime: () => MemoryRuntime;
  getTracer: () => JsonlTracer;
  isEmbeddingRebuildRunning: () => boolean;
}) {
  const { readEnvValues, updateEnvFile } = config;
  /** 保存模型配置；密钥永远不会出现在返回值中。 */
  async function saveAgentSettings(body: AgentSettingsInput): Promise<{
    settings: PublicAgentSettings;
    models: string[];
  }> {
    assertOpen();
    if (isEmbeddingRebuildRunning()) {
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
    if (isEmbeddingRebuildRunning()) throw new Error("Embedding 索引正在重建，请等待完成或先取消重建");
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
      EVERYTHING_SESSION_SCROLL_STEP: String(RUNTIME_DEFAULTS.sessionScrollStep),
      EVERYTHING_SESSION_RECALL_MESSAGE_LIMIT: String(RUNTIME_DEFAULTS.sessionRecallMessageLimit),
      EVERYTHING_SESSION_RECALL_TOKEN_LIMIT: String(RUNTIME_DEFAULTS.sessionRecallTokenLimit),
      EVERYTHING_MODEL_CONTEXT_WINDOW: String(RUNTIME_DEFAULTS.modelContextWindow),
    }, ["EVERYTHING_HISTORY_TURNS", ...OBSOLETE_CONFIG_KEYS]);
    return { settings: publicSettings(await loadRuntimeSettings()) };
  }

  async function loadRuntimeSettings(): Promise<RuntimeSettings> {
    const values = await readEnvValues();
    const provider = parseProvider(values.EVERYTHING_PROVIDER || "anthropic");
    const keyName = keyNameFor(provider);
    return {
      provider,
      model: values.EVERYTHING_MODEL ?? "",
      smallModel: values.EVERYTHING_SMALL_MODEL ?? "",
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

  return { saveAgentSettings, clearProviderApiKey, clearEmbeddingApiKey, resetRuntimeSettings, loadRuntimeSettings, publicSettings };
}
