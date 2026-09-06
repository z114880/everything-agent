import type { AgentProvider } from "../../model/model-client.ts";
import type { MemoryRuntime, RetrievalMode } from "../../memory/index.ts";

export const VALID_PROVIDERS = new Set<AgentProvider>(["anthropic", "openai-compatible"]);
export const VALID_RETRIEVAL_MODES = new Set<RetrievalMode>(["lexical_only", "dense_only", "hybrid"]);
export const RUNTIME_DEFAULTS = {
  sessionSearchWindow: 5,
  sessionScrollStep: 10,
  sessionRecallMessageLimit: 100,
  sessionRecallTokenLimit: 8_192,
  modelContextWindow: 32_768,
} as const;
export const OBSOLETE_CONFIG_KEYS = ["EVERYTHING_CHAT_TOKENIZER_ID", "EVERYTHING_EMBEDDING_TOKENIZER_ID"] as const;

export interface RuntimeSettings {
  provider: AgentProvider;
  model: string;
  smallModel: string;
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

export const SETTING_LIMITS = {
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

