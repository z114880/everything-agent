import type {
  EmbeddedVector,
  EmbeddingCallContext,
  EmbeddingPort,
  EmbeddingProfile,
} from "../types.ts";
import type { TokenUsage } from "../../../agent-loop/agent-loop.ts";
import { normalizeVector, VECTOR_DIMENSIONS } from "./vector.ts";

const MAX_BATCH_ITEMS = 16;
const MAX_BATCH_TOKENS = 8_192;
const REQUEST_TIMEOUT_MS = 60_000;

/** 按 Provider 调用向量协议，统一批次、维度校验与可观察事件。 */
export class EmbeddingClient implements EmbeddingPort {
  private readonly profile: EmbeddingProfile;

  constructor(profile: EmbeddingProfile) {
    if (profile.provider !== "openai-compatible" && profile.provider !== "gemini") throw new TypeError("Embedding Provider 不受支持");
    this.profile = profile;
  }

  async embed(texts: string[], estimatedTokens: number[], context: EmbeddingCallContext): Promise<EmbeddedVector[]> {
    if (texts.length !== estimatedTokens.length || texts.length === 0) {
      throw new TypeError("Embedding 文本与 token 数必须一一对应且不能为空");
    }
    const batches = splitBatches(texts, estimatedTokens);
    const output: EmbeddedVector[] = [];
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
      const batch = batches[batchIndex]!;
      const startedAt = performance.now();
      const operationId = crypto.randomUUID();
      await context.observer?.("embedding_started", metadata(context, {
        operationId, provider: this.profile.provider, model: this.profile.model, batchIndex, itemCount: batch.texts.length, estimatedTokens: sum(batch.estimatedTokens),
      }));
      try {
        const result = await this.request(batch.texts, context);
        output.push(...result.vectors.map((item) => ({ index: batch.startIndex + item.index, vector: item.vector })));
        await context.observer?.("embedding_completed", metadata(context, {
          operationId, provider: this.profile.provider, model: this.profile.model, batchIndex, itemCount: batch.texts.length, estimatedTokens: sum(batch.estimatedTokens), tokenUsage: result.tokenUsage,
          dimensions: VECTOR_DIMENSIONS, ms: Math.round(performance.now() - startedAt),
        }));
      } catch (error) {
        await context.observer?.("embedding_failed", metadata(context, {
          operationId, provider: this.profile.provider, model: this.profile.model, batchIndex, itemCount: batch.texts.length, estimatedTokens: sum(batch.estimatedTokens),
          errorType: error instanceof Error ? error.name : "UnknownError",
          errorMessage: sanitizedError(error), ms: Math.round(performance.now() - startedAt),
        }));
        throw error;
      }
    }
    return output.sort((left, right) => left.index - right.index);
  }

  private async request(texts: string[], context: EmbeddingCallContext): Promise<{ vectors: EmbeddedVector[]; tokenUsage: TokenUsage | null }> {
    if (this.profile.provider === "gemini") return this.requestGemini(texts, context);
    const { signal } = context;
    const endpoint = `${this.profile.baseUrl.replace(/\/+$/, "")}/embeddings`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.profile.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.profile.model, input: texts, dimensions: VECTOR_DIMENSIONS }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Embedding HTTP ${response.status}`);
    const value = await response.json() as { data?: Array<{ index?: unknown; embedding?: unknown }>; usage?: Record<string, unknown> };
    if (!Array.isArray(value.data) || value.data.length !== texts.length) {
      throw new TypeError("Embedding 响应数量与请求不一致");
    }
    const seen = new Set<number>();
    const vectors = value.data.map((item) => {
      const index = Number(item.index);
      if (!Number.isInteger(index) || index < 0 || index >= texts.length || seen.has(index)) {
        throw new TypeError("Embedding 响应 index 无效或重复");
      }
      seen.add(index);
      return { index, vector: normalizeVector(item.embedding) };
    });
    return { vectors, tokenUsage: embeddingTokenUsage(value.usage) };
  }

  private async requestGemini(texts: string[], context: EmbeddingCallContext): Promise<{ vectors: EmbeddedVector[]; tokenUsage: TokenUsage | null }> {
    const id = this.profile.model.replace(/^models\//, "");
    if (!/^[\w.-]+$/.test(id)) throw new TypeError("Gemini Embedding Model 必须是有效的模型 ID");
    const model = `models/${id}`;
    const response = await fetch(`${this.profile.baseUrl.replace(/\/+$/, "")}/${model}:batchEmbedContents`, {
      method: "POST",
      headers: { "x-goog-api-key": this.profile.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ requests: texts.map(text => ({
        model, content: { parts: [{ text }] },
        embedContentConfig: {
          outputDimensionality: VECTOR_DIMENSIONS,
          taskType: context.purpose === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT",
          autoTruncate: false,
        },
      })) }),
      signal: context.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Embedding HTTP ${response.status}`);
    const value = await response.json() as { embeddings?: Array<{ values?: unknown }>; usageMetadata?: { promptTokenCount?: unknown } };
    if (!Array.isArray(value.embeddings) || value.embeddings.length !== texts.length) throw new TypeError("Embedding 响应数量与请求不一致");
    // Gemini 的批量响应按输入顺序返回；与 OpenAI 一样校验维度并归一化后才写入索引。
    const vectors = value.embeddings.map((item, index) => ({ index, vector: normalizeVector(item.values) }));
    const inputTokens = nonNegativeInteger(value.usageMetadata?.promptTokenCount);
    return { vectors, tokenUsage: inputTokens === null ? null : { inputTokens, outputTokens: 0, totalTokens: inputTokens } };
  }

}

interface Batch { startIndex: number; texts: string[]; estimatedTokens: number[] }

function splitBatches(texts: string[], estimatedTokens: number[]): Batch[] {
  const batches: Batch[] = [];
  let current: Batch = { startIndex: 0, texts: [], estimatedTokens: [] };
  for (let index = 0; index < texts.length; index += 1) {
    const estimated = estimatedTokens[index]!;
    if (!Number.isInteger(estimated) || estimated < 1 || estimated > MAX_BATCH_TOKENS) {
      throw new TypeError(`单个 Embedding 文本估算 token 数必须在 1–${MAX_BATCH_TOKENS} 之间`);
    }
    if (current.texts.length && (current.texts.length === MAX_BATCH_ITEMS || sum(current.estimatedTokens) + estimated > MAX_BATCH_TOKENS)) {
      batches.push(current);
      current = { startIndex: index, texts: [], estimatedTokens: [] };
    }
    current.texts.push(texts[index]!);
    current.estimatedTokens.push(estimated);
  }
  if (current.texts.length) batches.push(current);
  return batches;
}

function sum(values: number[]): number { return values.reduce((total, value) => total + value, 0) }

function embeddingTokenUsage(usage: Record<string, unknown> | undefined): TokenUsage | null {
  if (!usage) return null;
  const inputTokens = nonNegativeInteger(usage.prompt_tokens ?? usage.input_tokens);
  if (inputTokens === null) return null;
  const totalTokens = nonNegativeInteger(usage.total_tokens) ?? inputTokens;
  return { inputTokens, outputTokens: 0, totalTokens };
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function metadata(context: EmbeddingCallContext, value: Record<string, unknown>): Record<string, unknown> {
  return { purpose: context.purpose, ...(context.turnId ? { turnId: context.turnId } : {}), ...(context.rebuildId ? { rebuildId: context.rebuildId } : {}), ...value };
}

function sanitizedError(error: unknown): string { return sanitizeText(error instanceof Error ? error.message : String(error)) }

function sanitizeText(value: string): string {
  return value.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [已脱敏]").slice(0, 1_000);
}
