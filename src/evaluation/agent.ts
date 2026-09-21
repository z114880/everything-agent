import { join } from 'node:path';
import { createAgentRuntime } from '../agent-runtime/index.ts';

/** 空白评估库也要建立当前 Embedding generation，保持真实检索配置不变。 */
export async function createEvaluationRuntime(home: string, signal: AbortSignal) {
  const runtime = createAgentRuntime({ home, defaultSystemPromptPath: join(home, 'EVERYTHING.md') }, { langfuse: false });
  const cancelRebuild = () => { runtime.cancelEmbeddingIndexRebuild(); };
  try {
    signal.throwIfAborted();
    const settings = await runtime.getSettings();
    if (settings.embeddingKeyConfigured && settings.embeddingBaseUrl && settings.embeddingModel && !settings.embeddingIndex.ready) {
      signal.addEventListener('abort', cancelRebuild, { once: true });
      signal.throwIfAborted();
      await runtime.rebuildEmbeddingIndex();
    }
    signal.throwIfAborted();
    return runtime;
  } catch (error) { await runtime.close(); throw error; }
  finally { signal.removeEventListener('abort', cancelRebuild); }
}
