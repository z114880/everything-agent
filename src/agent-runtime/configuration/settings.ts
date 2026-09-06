import type { AgentProvider } from "../../model/model-client.ts";
import type { MemoryRuntime } from "../../memory/index.ts";
import type { createLocalConfig } from "../local-config.ts";
import {
  AgentConfigError, RUNTIME_DEFAULTS, SETTING_LIMITS,
  keyNameFor, optionalText, parseProvider, parseRetrievalMode, parseRuntimeSettingBody,
  parseSetting, parseSimilarity, requiredText, validateBaseUrl,
} from "./schema.ts";
import type { AgentSettingsInput, PublicAgentSettings, RuntimeSettings } from "./schema.ts";

const OBSOLETE_CONFIG_KEYS = ["EVERYTHING_CHAT_TOKENIZER_ID", "EVERYTHING_EMBEDDING_TOKENIZER_ID"] as const;

/** 管理配置校验、连接探测和持久化；资源使用许可由 Runtime 在调用前检查。 */
export function createRuntimeSettings(config: ReturnType<typeof createLocalConfig>) {
  const { readEnvValues, updateEnvFile } = config;
  return { load: loadRuntimeSettings, save, clearProviderApiKey, clearEmbeddingApiKey, reset: resetRuntimeSettings };

  async function save(body: AgentSettingsInput): Promise<{ settings: RuntimeSettings; models: string[] }> {
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
    return { settings: await loadRuntimeSettings(), models };
  }

  async function clearProviderApiKey(provider: AgentProvider): Promise<RuntimeSettings> {
    await updateEnvFile({}, [keyNameFor(parseProvider(provider))]);
    return loadRuntimeSettings();
  }

  async function clearEmbeddingApiKey(): Promise<RuntimeSettings> {
    await updateEnvFile({ EVERYTHING_RETRIEVAL_MODE: "lexical_only" }, ["EVERYTHING_EMBEDDING_API_KEY"]);
    return loadRuntimeSettings();
  }

  async function resetRuntimeSettings(): Promise<RuntimeSettings> {
    await updateEnvFile({
      EVERYTHING_SESSION_SEARCH_WINDOW: String(RUNTIME_DEFAULTS.sessionSearchWindow),
      EVERYTHING_SESSION_SCROLL_STEP: String(RUNTIME_DEFAULTS.sessionScrollStep),
      EVERYTHING_SESSION_RECALL_MESSAGE_LIMIT: String(RUNTIME_DEFAULTS.sessionRecallMessageLimit),
      EVERYTHING_SESSION_RECALL_TOKEN_LIMIT: String(RUNTIME_DEFAULTS.sessionRecallTokenLimit),
      EVERYTHING_MODEL_CONTEXT_WINDOW: String(RUNTIME_DEFAULTS.modelContextWindow),
    }, ["EVERYTHING_HISTORY_TURNS", ...OBSOLETE_CONFIG_KEYS]);
    return loadRuntimeSettings();
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
}

/** 仅公开密钥配置状态和末四位，并按当前索引判断目标配置是否就绪。 */
export function publicSettings(settings: RuntimeSettings, memory: MemoryRuntime): PublicAgentSettings {
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

function normalizeBaseUrl(value: string): string {
  validateBaseUrl(value);
  return value.replace(/\/$/, "");
}

function sanitizeError(error: unknown, secrets: string[]): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) if (secret) message = message.replaceAll(secret, "***");
  return message;
}
