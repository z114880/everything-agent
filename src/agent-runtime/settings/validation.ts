import type { AgentProvider } from "../../model/model-client.ts";
import type { RetrievalMode } from "../../memory/index.ts";
import { RUNTIME_DEFAULTS, SETTING_LIMITS, VALID_PROVIDERS, VALID_RETRIEVAL_MODES } from "./types.ts";
import type { AgentSettingsInput, RuntimeSettings } from "./types.ts";

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

export function parseSetting(value: unknown, name: string, fallback: number, limits: { min: number; max: number }): number {
  const number = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isInteger(number) || number < limits.min || number > limits.max) {
    throw new TypeError(`${name} 必须是 ${limits.min}–${limits.max} 的整数`);
  }
  return number;
}

export function parseProvider(value: unknown): AgentProvider {
  if (typeof value !== "string" || !VALID_PROVIDERS.has(value as AgentProvider)) {
    throw new TypeError("Provider 必须是 anthropic 或 openai-compatible");
  }
  return value as AgentProvider;
}

export function parseRetrievalMode(value: unknown): RetrievalMode {
  if (typeof value !== "string" || !VALID_RETRIEVAL_MODES.has(value as RetrievalMode)) {
    throw new TypeError("Retrieval Mode 必须是 lexical_only、dense_only 或 hybrid");
  }
  return value as RetrievalMode;
}

export function parseSimilarity(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < -1 || number > 1) {
    throw new TypeError("Minimum Similarity 必须是 -1–1 的数字");
  }
  return number;
}

export function embeddingTemplate(value: unknown, field: string): string {
  const template = value === undefined ? "{text}" : optionalText(value, field, 2_000);
  if ((template.match(/\{text\}/g) ?? []).length !== 1) throw new TypeError(`${field} 必须且只能包含一个 {text}`);
  return template;
}

export function keyNameFor(provider: AgentProvider): RuntimeSettings["keyName"] {
  return provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
}

export function requiredText(value: unknown, field: string, maxLength: number): string {
  const text = optionalText(value, field, maxLength);
  if (!text.trim()) throw new TypeError(`${field} 不能为空`);
  return text;
}

export function optionalText(value: unknown, field: string, maxLength: number): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > maxLength) {
    throw new TypeError(`${field} 必须是小于 ${maxLength} 字符的字符串`);
  }
  return value.trim();
}

export function validateBaseUrl(value: string): void {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new TypeError("Base URL 只支持 HTTP 或 HTTPS");
}

export function normalizeBaseUrl(value: string): string {
  validateBaseUrl(value);
  return value.replace(/\/$/, "");
}

export function sanitizeError(error: unknown, secrets: string[]): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) if (secret) message = message.replaceAll(secret, "***");
  return message;
}
