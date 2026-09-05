import { createHash } from "node:crypto";
import { estimateTextTokens } from "../../model/token-estimator.ts";
import { CHUNKING_VERSION, chunkText, SqliteVectorStore } from "./index.ts";
import type { EmbeddingProfile, StoredChunk } from "./index.ts";
import type { MemoryRetrievalConfiguration } from "../types.ts";
import type { Row } from "../storage/records.ts";
import { nowUtc, parseJson, plainText, semanticFromRow } from "../storage/records.ts";
import type { MemoryDatabase } from "../storage/database.ts";

/** 向量配置、增量嵌入和可取消的影子索引重建。 */
export class EmbeddingIndex {
  private readonly storage: MemoryDatabase;

  constructor(storage: MemoryDatabase) {
    this.storage = storage;
    this.vectors = new SqliteVectorStore(storage.connection);
  }

  readonly vectors: SqliteVectorStore;
  retrieval: MemoryRetrievalConfiguration = { mode: "lexical_only" };
  private activeRebuild: { id: string; controller: AbortController } | null = null;
  private corpusMutationEpoch = 0;

  /** 登记可能改变检索语料的写入，防止并发重建激活过期快照。 */
  markCorpusMutation(): void { this.corpusMutationEpoch += 1 }

  /** 设置相关性检索模式及远程 Embedding 依赖。 */
  configureRetrieval(configuration: MemoryRetrievalConfiguration): void {
    if (configuration.mode !== "lexical_only" && !configuration.embedding) {
      throw new Error("Dense/Hybrid 模式必须配置 Embedding");
    }
    if (configuration.embedding && !configuration.allowIncompleteIndex
      && this.vectors.activeProfileHash() !== embeddingProfileHash(configuration.embedding.profile)) {
      throw new Error("Embedding 配置与 active generation 不一致，请先重建索引");
    }
    this.retrieval = configuration;
  }

  /** 返回配置页展示所需的非敏感向量索引状态。 */
  embeddingIndexStatus(): { ready: boolean; generationId: string | null; profileHash: string | null } {
    const generationId = this.vectors.activeGenerationId();
    return { ready: Boolean(generationId), generationId, profileHash: this.vectors.activeProfileHash() };
  }

  /** 判断 active generation 是否与给定 profile 完全一致。 */
  embeddingIndexMatches(profile: EmbeddingProfile): boolean {
    return this.vectors.activeProfileHash() === embeddingProfileHash(profile);
  }

  /** 读取 active generation 的非敏感 profile，供新配置重建前继续服务。 */
  activeEmbeddingProfile(): Omit<EmbeddingProfile, "apiKey"> | null {
    const json = this.vectors.activeProfileJson();
    if (!json) return null;
    const value = JSON.parse(json) as Partial<EmbeddingProfile>;
    if (typeof value.baseUrl !== "string" || typeof value.model !== "string"
      || typeof value.queryTemplate !== "string"
      || typeof value.documentTemplate !== "string" || typeof value.minimumSimilarity !== "number") {
      throw new TypeError("active generation profile 无效");
    }
    return {
      baseUrl: value.baseUrl, model: value.model,
      queryTemplate: value.queryTemplate, documentTemplate: value.documentTemplate,
      minimumSimilarity: value.minimumSimilarity,
    };
  }

  /** 使用当前 Embedding 配置全量建立影子 generation，并在成功后原子激活。 */
  async rebuildEmbeddings(rebuildId: string = crypto.randomUUID()): Promise<{ rebuildId: string; generationId: string; chunkCount: number }> {
    if (this.activeRebuild) throw new Error("已有 Embedding rebuild 正在运行");
    const embedding = this.retrieval.embedding;
    if (!embedding) throw new Error("尚未配置 Embedding");
    const controller = new AbortController();
    const profileJson = embeddingProfileJson(embedding.profile);
    const profileHash = embeddingProfileHash(embedding.profile);
    const generationId = this.vectors.createGeneration(profileJson, profileHash, CHUNKING_VERSION);
    this.storage.connection.prepare(`
      INSERT INTO embedding_rebuilds(id, generation_id, status, started_at) VALUES (?, ?, 'running', ?)
    `).run(rebuildId, generationId, nowUtc());
    const observer = this.retrieval.observer ?? (() => {});
    this.activeRebuild = { id: rebuildId, controller };
    const mutationEpoch = this.corpusMutationEpoch;
    try {
      await observer("embedding_rebuild_started", { rebuildId, generationId });
      const documents = await this.embeddingDocuments();
      let processedChunks = 0;
      for (const document of documents) {
        controller.signal.throwIfAborted();
        const chunks = await this.embedDocument(document.text, "rebuild", rebuildId, controller.signal);
        this.vectors.insertChunks(generationId, chunks.map((chunk) => ({
          ...chunk, corpus: document.corpus, sourceId: document.sourceId,
          ...(document.sessionId ? { sessionId: document.sessionId } : {}),
          ...(document.anchorMessageId === undefined ? {} : { anchorMessageId: document.anchorMessageId }),
        })));
        processedChunks += chunks.length;
        this.storage.connection.prepare("UPDATE embedding_rebuilds SET processed_chunks = ? WHERE id = ?")
          .run(processedChunks, rebuildId);
        await observer("embedding_rebuild_progress", { rebuildId, generationId, processedChunks });
      }
      if (mutationEpoch !== this.corpusMutationEpoch) {
        throw new Error("Embedding 重建期间检索语料发生变化，请重新执行重建");
      }
      this.storage.transaction(() => {
        this.vectors.activate(generationId);
        this.storage.connection.prepare(`
          UPDATE embedding_rebuilds SET status='completed', total_chunks=?, processed_chunks=?, completed_at=? WHERE id=?
        `).run(processedChunks, processedChunks, nowUtc(), rebuildId);
      });
      await observer("embedding_generation_activated", { rebuildId, generationId, chunkCount: processedChunks });
      await observer("embedding_rebuild_completed", { rebuildId, generationId, chunkCount: processedChunks });
      return { rebuildId, generationId, chunkCount: processedChunks };
    } catch (error) {
      const cancelled = controller.signal.aborted;
      this.storage.transaction(() => {
        this.vectors.discardGeneration(generationId, cancelled ? "cancelled" : "failed");
        this.storage.connection.prepare(`
          UPDATE embedding_rebuilds SET status=?, error_type=?, error_message=?, completed_at=? WHERE id=?
        `).run(
          cancelled ? "cancelled" : "failed",
          error instanceof Error ? error.name : "UnknownError",
          error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000),
          nowUtc(), rebuildId,
        );
      });
      if (cancelled) await observer("embedding_rebuild_cancelled", { rebuildId, generationId });
      else await observer("embedding_rebuild_failed", {
        rebuildId, generationId, errorType: error instanceof Error ? error.name : "UnknownError",
      });
      throw error;
    } finally {
      if (this.activeRebuild?.id === rebuildId) this.activeRebuild = null;
    }
  }

  /** 取消当前影子索引构建；已激活 generation 保持不变。 */
  cancelEmbeddingRebuild(): boolean {
    if (!this.activeRebuild) return false;
    this.activeRebuild.controller.abort(new Error("Embedding rebuild 已取消"));
    return true;
  }

  /** 判断影子 generation 是否仍在构建，供配置与数据清理入口阻止竞态。 */
  isEmbeddingRebuildRunning(): boolean { return this.activeRebuild !== null }

  private async embeddingDocuments(): Promise<EmbeddingDocument[]> {
    const semantic = (this.storage.connection.prepare("SELECT * FROM semantic_memory ORDER BY updated_at DESC, id DESC").all() as Row[]).map(semanticFromRow).map((item) => ({
      corpus: "semantic" as const, sourceId: String(item.id), text: `主题：${item.subject}\n内容：${item.content}`,
    }));
    const rows = this.storage.connection.prepare(`
      SELECT * FROM chat_log c
      WHERE EXISTS (
        SELECT 1 FROM chat_log done WHERE done.session_id = c.session_id
          AND done.run_id = c.run_id AND done.kind = 'assistant_message'
      )
      ORDER BY c.session_id, c.run_id, c.id
    `).all() as Row[];
    const grouped = new Map<string, Row[]>();
    for (const row of rows) {
      const key = `${row.session_id}\0${row.run_id}`;
      const group = grouped.get(key) ?? [];
      group.push(row); grouped.set(key, group);
    }
    const sessions: EmbeddingDocument[] = [];
    for (const group of grouped.values()) {
      const user = group.find((row) => row.kind === "user_message");
      const assistant = [...group].reverse().find((row) => row.kind === "assistant_message");
      if (!user || !assistant) continue;
      sessions.push({
        corpus: "session", sourceId: String(user.run_id), sessionId: String(user.session_id),
        anchorMessageId: Number(user.id),
        text: `用户：${plainText(parseJson(String(user.content_json)))}\n助手：${plainText(parseJson(String(assistant.content_json)))}`,
      });
    }
    return [...semantic, ...sessions];
  }

  async embedDocument(
    text: string,
    purpose: "memory_create" | "run_complete" | "rebuild",
    rebuildId?: string,
    signal?: AbortSignal,
    runId?: string,
  ): Promise<PendingStoredChunk[]> {
    const embedding = this.retrieval.embedding;
    if (!embedding) return [];
    const formatted = applyTemplate(embedding.profile.documentTemplate, text);
    const chunks = chunkText(formatted);
    if (!chunks.length) return [];
    const vectors = await embedding.client.embed(
      chunks.map((chunk) => chunk.text), chunks.map((chunk) => chunk.estimatedTokens),
      {
        purpose,
        ...(this.retrieval.observer ? { observer: this.retrieval.observer } : {}),
        ...(rebuildId ? { rebuildId } : {}),
        ...(signal ? { signal } : {}),
        ...(runId ? { runId } : {}),
      },
    );
    const byIndex = new Map(vectors.map((item) => [item.index, item.vector]));
    return chunks.map((chunk) => {
      const vector = byIndex.get(chunk.index);
      if (!vector) throw new Error("Embedding 响应缺少 chunk 向量");
      return {
        chunkIndex: chunk.index, startOffset: chunk.startOffset, endOffset: chunk.endOffset,
        estimatedTokens: chunk.estimatedTokens, vector,
      };
    });
  }

  async embedQuery(query: string, runId?: string, observer = this.retrieval.observer): Promise<Float32Array> {
    const embedding = this.retrieval.embedding;
    if (!embedding) throw new Error("尚未配置 Embedding");
    const text = applyTemplate(embedding.profile.queryTemplate, query);
    const estimatedTokens = estimateTextTokens(text);
    if (estimatedTokens < 1 || estimatedTokens > 512) throw new Error("Embedding Query 估算量必须为 1–512 tokens");
    const [result] = await embedding.client.embed([text], [estimatedTokens], {
      purpose: "query", ...(observer ? { observer } : {}),
      ...(runId ? { runId } : {}),
    });
    if (!result) throw new Error("Embedding Query 未返回向量");
    return result.vector;
  }

  assertNoEmbeddingRebuild(): void {
    if (this.activeRebuild) throw new Error("Embedding 索引重建期间暂停 Agent run 与 Memory 写入");
  }
}

interface EmbeddingDocument { corpus: "semantic" | "session"; sourceId: string; text: string; sessionId?: string; anchorMessageId?: number }

type PendingStoredChunk = Omit<StoredChunk, "corpus" | "sourceId" | "sessionId" | "anchorMessageId">;

function applyTemplate(template: string, text: string): string {
  if ((template.match(/\{text\}/g) ?? []).length !== 1) throw new TypeError("Embedding Template 必须且只能包含一个 {text}");
  return template.replace("{text}", text);
}

function embeddingProfileJson(profile: EmbeddingProfile): string {
  return JSON.stringify({
    baseUrl: profile.baseUrl, model: profile.model,
    queryTemplate: profile.queryTemplate, documentTemplate: profile.documentTemplate,
    minimumSimilarity: profile.minimumSimilarity, dimensions: 1024,
  });
}

function embeddingProfileHash(profile: EmbeddingProfile): string {
  // Query Template 与阈值只影响查询，不改变已保存文档向量，因此不触发重建。
  return createHash("sha256").update(JSON.stringify({
    baseUrl: profile.baseUrl, model: profile.model,
    documentTemplate: profile.documentTemplate, dimensions: 1024,
    documentFormatVersion: 1, chunkingVersion: CHUNKING_VERSION,
    normalizationVersion: 1,
  })).digest("hex");
}
