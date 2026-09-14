import { detectSandbox } from "../../sandbox/index.ts";
import type { AgentProvider } from "../../model/model-client.ts";
import type { MemoryRuntime } from "../../memory/index.ts";
import type { createLocalConfig } from "../local-config.ts";
import {
  AgentConfigError, RUNTIME_DEFAULTS, SETTING_LIMITS,
  optionalText, parseProvider, parseRetrievalMode, parseRuntimeSettingBody,
  parseSetting, parseSimilarity, requiredText, sessionRecallTokenLimit, validateBaseUrl,
} from "./schema.ts";
import type {
  AgentSettingsInput, ModelConnectionInput, ModelConnectionSettings, ModelConnectionTarget,
  PublicAgentSettings, PublicModelConnection, RuntimeSettings,
} from "./schema.ts";

/** 管理配置校验、连接探测和持久化；资源使用许可由 Runtime 在调用前检查。 */
export function createRuntimeSettings(config: ReturnType<typeof createLocalConfig>) {
  const { readValues, updateConfigFile, updateSecretEnvFile } = config;
  return { load: loadRuntimeSettings, save, clearModelApiKey, clearEmbeddingApiKey, reset: resetRuntimeSettings };

  async function save(body: AgentSettingsInput): Promise<{ settings: RuntimeSettings; models: Record<ModelConnectionTarget, string[]> }> {
    const runtime = parseRuntimeSettingBody(body);
    if (runtime.embeddingBaseUrl) validateBaseUrl(runtime.embeddingBaseUrl);
    const embeddingApiKey = optionalText(body.embeddingApiKey, "Embedding API Key", 10_000);
    const clearEmbeddingApiKey = body.clearEmbeddingApiKey === true;
    const force = body.force === true;
    const before = await readValues();
    const agentModel = parseModelConnection(body.agentModel, "Agent Model", before, "AGENT");
    const smallModel = parseModelConnection(body.smallModel, "Small Model", before, "SMALL");
    const candidateEmbeddingKey = clearEmbeddingApiKey ? "" : embeddingApiKey || before.EVERYTHING_EMBEDDING_API_KEY || "";
    const models = { agentModel: [] as string[], smallModel: [] as string[] };
    await probeChangedConnection("Agent Model", agentModel, models.agentModel, force);
    await probeChangedConnection("Small Model", smallModel, models.smallModel, force);

    const updates: Record<string, string> = {
      EVERYTHING_AGENT_PROVIDER: agentModel.settings.provider,
      EVERYTHING_AGENT_MODEL: agentModel.settings.model,
      EVERYTHING_AGENT_BASE_URL: agentModel.settings.baseUrl,
      EVERYTHING_SMALL_PROVIDER: smallModel.settings.provider,
      EVERYTHING_SMALL_MODEL: smallModel.settings.model,
      EVERYTHING_SMALL_BASE_URL: smallModel.settings.baseUrl,
      EVERYTHING_SESSION_SEARCH_WINDOW: String(runtime.sessionSearchWindow),
      EVERYTHING_SESSION_RECALL_ENTRY_TOKEN_LIMIT: String(runtime.sessionRecallEntryTokenLimit),
      EVERYTHING_AGENT_MAX_TOKENS: String(runtime.maxTokens),
      EVERYTHING_AGENT_MAX_ITERATIONS: String(runtime.maxIterations),
      EVERYTHING_MODEL_CONTEXT_WINDOW: String(runtime.modelContextWindow),
      EVERYTHING_RETRIEVAL_MODE: runtime.retrievalMode,
      EVERYTHING_EMBEDDING_BASE_URL: runtime.embeddingBaseUrl,
      EVERYTHING_EMBEDDING_MODEL: runtime.embeddingModel,
      EVERYTHING_EMBEDDING_QUERY_TEMPLATE: runtime.embeddingQueryTemplate,
      EVERYTHING_EMBEDDING_DOCUMENT_TEMPLATE: runtime.embeddingDocumentTemplate,
      EVERYTHING_EMBEDDING_MINIMUM_SIMILARITY: String(runtime.embeddingMinimumSimilarity),
    };
    if (runtime.retrievalMode !== "lexical_only" && !(candidateEmbeddingKey && runtime.embeddingBaseUrl && runtime.embeddingModel)) {
      throw new AgentConfigError("Dense/Hybrid 模式必须完整配置独立的 Embedding Base URL、API Key 与 Model");
    }
    await updateConfigFile(updates);
    await updateSecretEnvFile({
      ...(agentModel.inputApiKey ? { EVERYTHING_AGENT_API_KEY: agentModel.inputApiKey } : {}),
      ...(smallModel.inputApiKey ? { EVERYTHING_SMALL_API_KEY: smallModel.inputApiKey } : {}),
      ...(embeddingApiKey ? { EVERYTHING_EMBEDDING_API_KEY: embeddingApiKey } : {}),
    }, [
      ...(agentModel.clearApiKey ? ["EVERYTHING_AGENT_API_KEY"] : []),
      ...(smallModel.clearApiKey ? ["EVERYTHING_SMALL_API_KEY"] : []),
      ...(clearEmbeddingApiKey ? ["EVERYTHING_EMBEDDING_API_KEY"] : []),
    ]);
    return { settings: await loadRuntimeSettings(), models };
  }

  async function clearModelApiKey(target: ModelConnectionTarget): Promise<RuntimeSettings> {
    if (target !== "agentModel" && target !== "smallModel") throw new TypeError("模型连接目标无效");
    await updateSecretEnvFile({}, [target === "agentModel" ? "EVERYTHING_AGENT_API_KEY" : "EVERYTHING_SMALL_API_KEY"]);
    return loadRuntimeSettings();
  }

  async function clearEmbeddingApiKey(): Promise<RuntimeSettings> {
    await updateConfigFile({ EVERYTHING_RETRIEVAL_MODE: "lexical_only" });
    await updateSecretEnvFile({}, ["EVERYTHING_EMBEDDING_API_KEY"]);
    return loadRuntimeSettings();
  }

  async function resetRuntimeSettings(): Promise<RuntimeSettings> {
    await updateConfigFile({
      EVERYTHING_SESSION_SEARCH_WINDOW: String(RUNTIME_DEFAULTS.sessionSearchWindow),
      EVERYTHING_SESSION_RECALL_ENTRY_TOKEN_LIMIT: String(RUNTIME_DEFAULTS.sessionRecallEntryTokenLimit),
      EVERYTHING_AGENT_MAX_TOKENS: String(RUNTIME_DEFAULTS.maxTokens),
      EVERYTHING_AGENT_MAX_ITERATIONS: String(RUNTIME_DEFAULTS.maxIterations),
      EVERYTHING_MODEL_CONTEXT_WINDOW: String(RUNTIME_DEFAULTS.modelContextWindow),
    });
    return loadRuntimeSettings();
  }

  async function loadRuntimeSettings(): Promise<RuntimeSettings> {
    const values = await readValues();
    return {
      agentModel: loadModelConnection(values, "AGENT"),
      smallModel: loadModelConnection(values, "SMALL"),
      sessionSearchWindow: parseSetting(values.EVERYTHING_SESSION_SEARCH_WINDOW, "Session Search Window", RUNTIME_DEFAULTS.sessionSearchWindow, SETTING_LIMITS.sessionSearchWindow),
      sessionRecallEntryTokenLimit: parseSetting(values.EVERYTHING_SESSION_RECALL_ENTRY_TOKEN_LIMIT, "Session Recall Entry Token Limit", RUNTIME_DEFAULTS.sessionRecallEntryTokenLimit, SETTING_LIMITS.sessionRecallEntryTokenLimit),
      maxTokens: parseSetting(values.EVERYTHING_AGENT_MAX_TOKENS, "单次模型输出", RUNTIME_DEFAULTS.maxTokens, SETTING_LIMITS.maxTokens),
      maxIterations: parseSetting(values.EVERYTHING_AGENT_MAX_ITERATIONS, "Agent 最大迭代", RUNTIME_DEFAULTS.maxIterations, SETTING_LIMITS.maxIterations),
      modelContextWindow: parseSetting(values.EVERYTHING_MODEL_CONTEXT_WINDOW, "Model Context Window", RUNTIME_DEFAULTS.modelContextWindow, SETTING_LIMITS.modelContextWindow),
      retrievalMode: parseRetrievalMode(values.EVERYTHING_RETRIEVAL_MODE || "lexical_only"),
      embeddingBaseUrl: values.EVERYTHING_EMBEDDING_BASE_URL ?? "",
      embeddingModel: values.EVERYTHING_EMBEDDING_MODEL ?? "",
      embeddingQueryTemplate: values.EVERYTHING_EMBEDDING_QUERY_TEMPLATE ?? "{text}",
      embeddingDocumentTemplate: values.EVERYTHING_EMBEDDING_DOCUMENT_TEMPLATE ?? "{text}",
      embeddingMinimumSimilarity: parseSimilarity(values.EVERYTHING_EMBEDDING_MINIMUM_SIMILARITY ?? "0.30"),
      embeddingApiKey: values.EVERYTHING_EMBEDDING_API_KEY ?? "",
      sandboxWorkspaceRoot: values.EVERYTHING_SANDBOX_WORKSPACE_ROOT ?? "",
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
    agentModel: publicModelConnection(settings.agentModel),
    smallModel: publicModelConnection(settings.smallModel),
    sessionSearchWindow: settings.sessionSearchWindow,
    sessionRecallEntryTokenLimit: settings.sessionRecallEntryTokenLimit,
    sessionRecallTokenLimit: sessionRecallTokenLimit(settings.modelContextWindow),
    maxTokens: settings.maxTokens,
    maxIterations: settings.maxIterations,
    modelContextWindow: settings.modelContextWindow,
    retrievalMode: settings.retrievalMode,
    embeddingBaseUrl: settings.embeddingBaseUrl,
    embeddingModel: settings.embeddingModel,
    embeddingQueryTemplate: settings.embeddingQueryTemplate,
    embeddingDocumentTemplate: settings.embeddingDocumentTemplate,
    embeddingMinimumSimilarity: settings.embeddingMinimumSimilarity,
    embeddingKeyConfigured: Boolean(settings.embeddingApiKey),
    embeddingKeyLast4: settings.embeddingApiKey ? settings.embeddingApiKey.slice(-4) : "",
    sandbox: sandboxStatus(settings.sandboxWorkspaceRoot),
    embeddingIndex: { ...embeddingIndex, ready: Boolean(embeddingProfile && memory.embeddingIndexMatches(embeddingProfile)) },
    limits: SETTING_LIMITS,
  };
}

interface ParsedConnection {
  settings: ModelConnectionSettings;
  inputApiKey: string;
  clearApiKey: boolean;
  changed: boolean;
}

function parseModelConnection(
  input: ModelConnectionInput,
  label: string,
  before: Record<string, string>,
  prefix: "AGENT" | "SMALL",
): ParsedConnection {
  if (!input || typeof input !== "object") throw new TypeError(`${label} 配置不能为空`);
  const provider = parseProvider(input.provider);
  const model = requiredText(input.model, `${label} Model`, 200);
  const baseUrl = optionalText(input.baseUrl, `${label} Base URL`, 2_000);
  if (baseUrl) validateBaseUrl(baseUrl);
  const inputApiKey = optionalText(input.apiKey, `${label} API Key`, 10_000);
  const currentProvider = before[`EVERYTHING_${prefix}_PROVIDER`] || "anthropic";
  // Provider 改变后旧凭证不属于新连接；未显式输入新密钥时直接清除。
  const clearApiKey = input.clearApiKey === true || (provider !== currentProvider && !inputApiKey);
  const currentApiKey = before[`EVERYTHING_${prefix}_API_KEY`] ?? "";
  const settings = {
    provider, model, baseUrl,
    apiKey: clearApiKey ? "" : inputApiKey || currentApiKey,
  };
  return {
    settings, inputApiKey, clearApiKey,
    changed: Boolean(inputApiKey && inputApiKey !== currentApiKey)
      || provider !== currentProvider
      || baseUrl !== (before[`EVERYTHING_${prefix}_BASE_URL`] ?? ""),
  };
}

async function probeChangedConnection(label: string, connection: ParsedConnection, models: string[], force: boolean): Promise<void> {
  if (connection.clearApiKey || !connection.settings.apiKey || !connection.changed || force) return;
  try {
    models.push(...await probeModels(connection.settings.provider, connection.settings.apiKey, connection.settings.baseUrl));
  } catch (error) {
    throw new AgentConfigError(`${label}：${sanitizeError(error, [connection.settings.apiKey])}`, true);
  }
}

function loadModelConnection(values: Record<string, string>, prefix: "AGENT" | "SMALL"): ModelConnectionSettings {
  return {
    provider: parseProvider(values[`EVERYTHING_${prefix}_PROVIDER`] || "anthropic"),
    model: values[`EVERYTHING_${prefix}_MODEL`] ?? "",
    baseUrl: values[`EVERYTHING_${prefix}_BASE_URL`] ?? "",
    apiKey: values[`EVERYTHING_${prefix}_API_KEY`] ?? "",
  };
}

function publicModelConnection(connection: ModelConnectionSettings): PublicModelConnection {
  return {
    provider: connection.provider,
    model: connection.model,
    baseUrl: connection.baseUrl,
    keyConfigured: Boolean(connection.apiKey),
    keyLast4: connection.apiKey ? connection.apiKey.slice(-4) : "",
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

/** 报告工作区配置与当前平台的沙箱能力，供配置页直接展示。 */
function sandboxStatus(workspaceRoot: string): PublicAgentSettings["sandbox"] {
  const availability = detectSandbox();
  return {
    workspaceRoot,
    kind: availability.available ? availability.kind : null,
    unavailableReason: availability.available ? null : availability.reason,
  };
}
