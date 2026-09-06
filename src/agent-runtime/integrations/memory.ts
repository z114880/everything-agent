import { OpenAIEmbeddingClient } from "../../memory/index.ts";
import type { MemoryRuntime, SessionRecallSettings } from "../../memory/index.ts";
import type { AgentObserver, TokenEstimator } from "../../agent-loop/agent-loop.ts";
import type { RuntimeSettings } from "../configuration/schema.ts";

/** 将配置预算映射到 Memory 的召回接口，使用 Runtime 实例的 token 估算器。 */
export function recallSettings(settings: RuntimeSettings, estimator: TokenEstimator): SessionRecallSettings {
  return {
    searchWindow: settings.sessionSearchWindow,
    scrollStep: settings.sessionScrollStep,
    messageLimit: settings.sessionRecallMessageLimit,
    tokenLimit: settings.sessionRecallTokenLimit,
    tokenEstimator: estimator,
  };
}

/** 配置检索与索引绑定；只有重建期间允许使用尚未完成的目标索引。 */
export async function configureMemoryRuntime(
  memory: MemoryRuntime,
  settings: RuntimeSettings,
  observer: AgentObserver,
  allowIncompleteIndex = false,
): Promise<void> {
  const complete = Boolean(
    settings.embeddingApiKey && settings.embeddingBaseUrl
    && settings.embeddingModel,
  );
  if (!complete) {
    if (settings.retrievalMode !== "lexical_only") throw new Error("Dense/Hybrid 模式的 Embedding 配置不完整");
    memory.configureRetrieval({ mode: "lexical_only", observer });
    return;
  }
  const desiredProfile = {
    baseUrl: settings.embeddingBaseUrl,
    apiKey: settings.embeddingApiKey,
    model: settings.embeddingModel,
    queryTemplate: settings.embeddingQueryTemplate,
    documentTemplate: settings.embeddingDocumentTemplate,
    minimumSimilarity: settings.embeddingMinimumSimilarity,
  };
  // 新配置尚未建成索引时继续绑定已激活版本，避免查询向量与文档向量不一致。
  const activeProfile = !allowIncompleteIndex && !memory.embeddingIndexMatches(desiredProfile)
    ? memory.activeEmbeddingProfile()
    : null;
  const profile = activeProfile
    ? {
        ...activeProfile,
        apiKey: settings.embeddingApiKey,
        // 这两个字段不参与文档向量构建，可安全即时采用新配置。
        queryTemplate: settings.embeddingQueryTemplate,
        minimumSimilarity: settings.embeddingMinimumSimilarity,
      }
    : desiredProfile;
  memory.configureRetrieval({
    mode: settings.retrievalMode,
    embedding: { profile, client: new OpenAIEmbeddingClient(profile) },
    observer,
    ...(allowIncompleteIndex ? { allowIncompleteIndex: true } : {}),
  });
}
