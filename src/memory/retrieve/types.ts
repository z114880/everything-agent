import type { AgentObserver } from "../../agent-loop/agent-loop.ts";

/** Memory Retrieval 支持的全局相关性检索模式。 */
export type RetrievalMode = "dense_only" | "lexical_only" | "hybrid";

/** 已固定版本的远程 Embedding 配置。 */
export interface EmbeddingProfile {
  baseUrl: string;
  apiKey: string;
  model: string;
  queryTemplate: string;
  documentTemplate: string;
  minimumSimilarity: number;
}

/** 远程 Embedding 调用返回的已校验向量。 */
export interface EmbeddedVector {
  index: number;
  vector: Float32Array;
}

/** Embedding 模块的可观察上下文。 */
export interface EmbeddingCallContext {
  purpose: "query" | "memory_create" | "run_complete" | "rebuild" | "config_probe";
  observer?: AgentObserver;
  runId?: string;
  rebuildId?: string;
  signal?: AbortSignal;
}

/** 供生产 HTTP adapter 与测试内存 adapter 实现的内部 seam。 */
export interface EmbeddingPort {
  embed(texts: string[], estimatedTokens: number[], context: EmbeddingCallContext): Promise<EmbeddedVector[]>;
}

/** 具有稳定身份、排名和可选向量的检索候选。 */
export interface RankedCandidate<T = unknown> {
  id: string;
  value: T;
  rank: number;
  score: number;
  vectors: readonly Float32Array[];
}
