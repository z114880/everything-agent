import type { AgentProvider } from "../../model/model-client.ts";
import type { MemoryRuntime, RetrievalMode } from "../../memory/index.ts";

const VALID_PROVIDERS = new Set<AgentProvider>(["anthropic", "openai-compatible"]);
const VALID_RETRIEVAL_MODES = new Set<RetrievalMode>(["lexical_only", "dense_only", "hybrid"]);
export const RUNTIME_DEFAULTS = {
  sessionSearchWindow: 5,
  sessionScrollStep: 10,
  sessionRecallMessageLimit: 100,
  sessionRecallTokenLimit: 8_192,
  modelContextWindow: 32_768,
} as const;

/** 内部配置包含完整凭证，只能经 publicSettings 投影后交给宿主。 */
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

/** 校验保存输入；未提供的预算字段使用默认值。 */
export function parseRuntimeSettingBody(body: AgentSettingsInput) {
  return {
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

/** 解析整数预算，拒绝超出配置边界的值。 */
export function parseSetting(value: unknown, name: string, fallback: number, limits: { min: number; max: number }): number {
  const number = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isInteger(number) || number < limits.min || number > limits.max) {
    throw new TypeError(`${name} 必须是 ${limits.min}–${limits.max} 的整数`);
  }
  return number;
}

/** 验证模型提供方，避免未经验证的值进入客户端配置。 */
export function parseProvider(value: unknown): AgentProvider {
  if (typeof value !== "string" || !VALID_PROVIDERS.has(value as AgentProvider)) {
    throw new TypeError("Provider 必须是 anthropic 或 openai-compatible");
  }
  return value as AgentProvider;
}

/** 验证检索模式，拒绝未知路由值。 */
export function parseRetrievalMode(value: unknown): RetrievalMode {
  if (typeof value !== "string" || !VALID_RETRIEVAL_MODES.has(value as RetrievalMode)) {
    throw new TypeError("Retrieval Mode 必须是 lexical_only、dense_only 或 hybrid");
  }
  return value as RetrievalMode;
}

/** 相似度阈值允许负值，但必须位于余弦相似度范围内。 */
export function parseSimilarity(value: unknown): number {
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

/** 返回模型提供方对应的凭证配置键。 */
export function keyNameFor(provider: AgentProvider): RuntimeSettings["keyName"] {
  return provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
}

/** 校验必填文本，裁剪首尾空白并限制原始输入长度。 */
export function requiredText(value: unknown, field: string, maxLength: number): string {
  const text = optionalText(value, field, maxLength);
  if (!text.trim()) throw new TypeError(`${field} 不能为空`);
  return text;
}

/** 归一化可选文本；非字符串或过长输入直接报错。 */
export function optionalText(value: unknown, field: string, maxLength: number): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > maxLength) {
    throw new TypeError(`${field} 必须是小于 ${maxLength} 字符的字符串`);
  }
  return value.trim();
}

/** 限制服务地址协议，拒绝文件等非 HTTP 地址。 */
export function validateBaseUrl(value: string): void {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new TypeError("Base URL 只支持 HTTP 或 HTTPS");
}
