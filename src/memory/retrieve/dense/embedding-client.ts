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

/** 调用 OpenAI-compatible `/v1/embeddings` 的严格 HTTP adapter。 */
export class OpenAIEmbeddingClient implements EmbeddingPort {
  private readonly profile: EmbeddingProfile;

  constructor(profile: EmbeddingProfile) { this.profile = profile }

  async embed(texts: string[], estimatedTokens: number[], context: EmbeddingCallContext): Promise<EmbeddedVector[]> {
    if (texts.length !== estimatedTokens.length || texts.length === 0) {
      throw new TypeError("Embedding 文本与 token 数必须一一对应且不能为空");
    }
    const batches = splitBatches(texts, estimatedTokens);
    const output: EmbeddedVector[] = [];
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
      const batch = batches[batchIndex]!;
      const startedAt = performance.now();
      await context.observer?.("embedding_started", metadata(context, {
        batchIndex, itemCount: batch.texts.length, estimatedTokens: sum(batch.estimatedTokens),
      }));
      try {
        const result = await this.request(batch.texts, context.signal);
        output.push(...result.vectors.map((item) => ({ index: batch.startIndex + item.index, vector: item.vector })));
        await context.observer?.("embedding_completed", metadata(context, {
          batchIndex, itemCount: batch.texts.length, estimatedTokens: sum(batch.estimatedTokens), tokenUsage: result.tokenUsage,
          dimensions: VECTOR_DIMENSIONS, ms: Math.round(performance.now() - startedAt),
        }));
      } catch (error) {
        await context.observer?.("embedding_failed", metadata(context, {
          batchIndex, itemCount: batch.texts.length, estimatedTokens: sum(batch.estimatedTokens),
          errorType: error instanceof Error ? error.name : "UnknownError",
          errorMessage: sanitizedError(error), ms: Math.round(performance.now() - startedAt),
        }));
        throw error;
      }
    }
    return output.sort((left, right) => left.index - right.index);
  }

  private async request(texts: string[], signal?: AbortSignal): Promise<{ vectors: EmbeddedVector[]; tokenUsage: TokenUsage | null }> {
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
  return { purpose: context.purpose, ...(context.runId ? { runId: context.runId } : {}), ...(context.rebuildId ? { rebuildId: context.rebuildId } : {}), ...value };
}

function sanitizedError(error: unknown): string { return sanitizeText(error instanceof Error ? error.message : String(error)) }

function sanitizeText(value: string): string {
  return value.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [已脱敏]").slice(0, 1_000);
}
