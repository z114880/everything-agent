import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { AgentProvider } from "../../model/model-client.ts";
import type { MemoryRuntime, RetrievalMode, EmbeddingProvider } from "../../memory/index.ts";

const VALID_PROVIDERS = new Set<AgentProvider>(["anthropic", "openai-compatible", "gemini"]);
const VALID_RETRIEVAL_MODES = new Set<RetrievalMode>(["lexical_only", "dense_only", "hybrid"]);
export const RUNTIME_DEFAULTS = {
  sessionSearchWindow: 5,
  sessionRecallEntryTokenLimit: 8_192,
  modelContextWindow: 262_144,
  maxTokens: 32_768,
  maxIterations: 100,
} as const;

/** 单次 Session Recall 可占用的 Context Window 比例；总额由它派生，不单独配置。 */
export const SESSION_RECALL_TOKEN_SHARE = 0.25;

/** 由 Context Window 派生单次 session_search 的 token 总额。 */
export function sessionRecallTokenLimit(modelContextWindow: number): number {
  return Math.floor(modelContextWindow * SESSION_RECALL_TOKEN_SHARE);
}

/** 内部配置包含完整凭证，只能经 publicSettings 投影后交给宿主。 */
export interface ModelConnectionSettings {
  provider: AgentProvider;
  model: string;
  baseUrl: string;
  apiKey: string;
}

/** 单条模型连接的保存输入；空密钥表示保留已保存值。 */
export interface ModelConnectionInput {
  provider: AgentProvider;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  clearApiKey?: boolean;
}

export type ModelConnectionTarget = "agentModel" | "smallModel";

export interface RuntimeSettings {
  agentModel: ModelConnectionSettings;
  smallModel: ModelConnectionSettings;
  sessionSearchWindow: number;
  sessionRecallEntryTokenLimit: number;
  modelContextWindow: number;
  maxTokens: number;
  maxIterations: number;
  retrievalMode: RetrievalMode;
  embeddingProvider: EmbeddingProvider;
  embeddingBaseUrl: string;
  embeddingModel: string;
  embeddingQueryTemplate: string;
  embeddingDocumentTemplate: string;
  embeddingMinimumSimilarity: number;
  embeddingApiKey: string;
  /** 终端命令的沙箱工作区根目录；为空表示尚未配置，终端能力不可用。 */
  sandboxWorkspaceRoot: string;
}

/** 保存运行配置的输入；省略预算字段时使用默认值。 */
export type AgentSettingsInput = {
  agentModel: ModelConnectionInput;
  smallModel: ModelConnectionInput;
} & Partial<Omit<RuntimeSettings, "agentModel" | "smallModel">> & {
    clearEmbeddingApiKey?: boolean; force?: boolean;
  };

/** 可安全发送到浏览器的本地 Agent 配置。 */
export interface PublicModelConnection {
  provider: AgentProvider;
  model: string;
  baseUrl: string;
  keyConfigured: boolean;
  keyLast4: string;
}

export interface PublicAgentSettings {
  agentModel: PublicModelConnection;
  smallModel: PublicModelConnection;
  sessionSearchWindow: number;
  sessionRecallEntryTokenLimit: number;
  /** 由 modelContextWindow 派生的只读总额，配置页展示但不可编辑。 */
  sessionRecallTokenLimit: number;
  modelContextWindow: number;
  maxTokens: number;
  maxIterations: number;
  retrievalMode: RetrievalMode;
  embeddingProvider: EmbeddingProvider;
  embeddingBaseUrl: string;
  embeddingModel: string;
  embeddingQueryTemplate: string;
  embeddingDocumentTemplate: string;
  embeddingMinimumSimilarity: number;
  embeddingKeyConfigured: boolean;
  embeddingKeyLast4: string;
  embeddingIndex: ReturnType<MemoryRuntime["embeddingIndexStatus"]>;
  /** 沙箱工作区与当前平台能力；`unavailableReason` 非空时终端能力无法启用。 */
  sandbox: { workspaceRoot: string; kind: string | null; unavailableReason: string | null };
  limits: typeof SETTING_LIMITS;
}

export const SETTING_LIMITS = {
  maxTokens: { min: 1, max: 131_072 },
  maxIterations: { min: 1, max: 1_000 },
  sessionSearchWindow: { min: 1, max: 20 },
  sessionRecallEntryTokenLimit: { min: 256, max: 16_384 },
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
    sessionRecallEntryTokenLimit: parseSetting(body.sessionRecallEntryTokenLimit, "Session Recall Entry Token Limit", RUNTIME_DEFAULTS.sessionRecallEntryTokenLimit, SETTING_LIMITS.sessionRecallEntryTokenLimit),
    maxTokens: parseSetting(body.maxTokens, "单次模型输出", RUNTIME_DEFAULTS.maxTokens, SETTING_LIMITS.maxTokens),
    maxIterations: parseSetting(body.maxIterations, "Agent 最大迭代", RUNTIME_DEFAULTS.maxIterations, SETTING_LIMITS.maxIterations),
    modelContextWindow: parseSetting(body.modelContextWindow, "Model Context Window", RUNTIME_DEFAULTS.modelContextWindow, SETTING_LIMITS.modelContextWindow),
    retrievalMode: parseRetrievalMode(body.retrievalMode ?? "lexical_only"),
    embeddingProvider: parseEmbeddingProvider(body.embeddingProvider ?? "openai-compatible"),
    embeddingBaseUrl: optionalText(body.embeddingBaseUrl, "Embedding Base URL", 2_000),
    embeddingModel: optionalText(body.embeddingModel, "Embedding Model", 500),
    embeddingQueryTemplate: embeddingTemplate(body.embeddingQueryTemplate, "Query Template"),
    embeddingDocumentTemplate: embeddingTemplate(body.embeddingDocumentTemplate, "Document Template"),
    embeddingMinimumSimilarity: parseSimilarity(body.embeddingMinimumSimilarity ?? 0.30),
    sandboxWorkspaceRoot: parseWorkspaceRoot(body.sandboxWorkspaceRoot),
  };
}

/**
 * 校验沙箱工作区根目录。
 *
 * 空值表示不启用终端能力；非空时必须是已存在目录的绝对路径，否则沙箱会在第一条
 * 命令上失败，而那时的报错离配置现场已经很远。
 */
export function parseWorkspaceRoot(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || value.length > 4_000) throw new AgentConfigError("工作区根目录必须是小于 4000 字符的字符串");
  const trimmed = value.trim();
  if (trimmed === "") return "";
  if (!isAbsolute(trimmed)) throw new AgentConfigError("工作区根目录必须是绝对路径");
  const absolute = resolve(trimmed);
  let isDirectory = false;
  try {
    isDirectory = statSync(absolute).isDirectory();
  } catch {
    throw new AgentConfigError(`工作区根目录不存在：${absolute}`);
  }
  if (!isDirectory) throw new AgentConfigError(`工作区根目录必须是目录：${absolute}`);
  return absolute;
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
    throw new TypeError("Provider 必须是 anthropic、openai-compatible 或 gemini");
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

/** Embedding 仅接受已实现的向量协议，不能复用聊天 Provider 的全集。 */
export function parseEmbeddingProvider(value: unknown): EmbeddingProvider {
  if (value !== "openai-compatible" && value !== "gemini") throw new TypeError("Embedding Provider 必须是 openai-compatible 或 gemini；Anthropic 不提供原生 Embedding");
  return value;
}
