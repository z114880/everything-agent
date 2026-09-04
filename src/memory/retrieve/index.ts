export { CHUNKING_VERSION, chunkText } from "./dense/chunker.ts";
export type { ChunkOptions, TextChunk } from "./dense/chunker.ts";
export { OpenAIEmbeddingClient } from "./dense/embedding-client.ts";
export { rankDenseSources } from "./dense/dense-retriever.ts";
export type { DenseSource } from "./dense/dense-retriever.ts";
export { cosineSimilarity, normalizeVector, vectorFromBlob, vectorToBlob, VECTOR_DIMENSIONS } from "./dense/vector.ts";
export { SqliteVectorStore } from "./dense/vector-store.ts";
export type { StoredChunk } from "./dense/vector-store.ts";
export { maximalMarginalRelevance } from "./fusion/mmr.ts";
export type { MmrCandidate, MmrResult } from "./fusion/mmr.ts";
export { reciprocalRankFusion } from "./fusion/rrf.ts";
export type { FusedCandidate } from "./fusion/rrf.ts";
export { toMatchQuery, toSearchText } from "./lexical/search-text.ts";
export { searchSemanticLexical } from "./lexical/semantic-search.ts";
export { searchSessionLexical } from "./lexical/session-search.ts";
export type { LexicalSessionCandidate } from "./lexical/session-search.ts";
export type {
  EmbeddedVector,
  EmbeddingCallContext,
  EmbeddingPort,
  EmbeddingProfile,
  RankedCandidate,
  RetrievalMode,
} from "./types.ts";
