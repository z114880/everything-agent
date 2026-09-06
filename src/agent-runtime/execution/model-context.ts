import { createModelClient } from "../../model/model-client.ts";
import type { AgentModelClient, TokenEstimator } from "../../agent-loop/agent-loop.ts";
import type { SessionRecallSettings } from "../../memory/index.ts";
import type { RuntimeSettings } from "../settings/types.ts";

/** 创建真实模型客户端；非 Loop 调用也使用同一估算预算。 */
export function createRuntimeClient(settings: RuntimeSettings, estimator?: TokenEstimator): AgentModelClient {
  const client = createModelClient(settings);
  if (!estimator) return client;
  return {
    messages: {
      async create(request) {
        assertModelTokenLimit(request, settings.modelContextWindow, estimator);
        return client.messages.create(request);
      },
      ...(client.messages.stream ? { stream: client.messages.stream.bind(client.messages) } : {}),
    },
  };
}

function assertModelTokenLimit(
  request: Parameters<AgentModelClient["messages"]["create"]>[0],
  modelContextWindow: number,
  estimator: TokenEstimator,
): void {
  const estimatedInputTokens = estimator.estimateRequest(request);
  const total = estimatedInputTokens + request.max_tokens + 512;
  if (total > modelContextWindow) {
    throw new Error(`模型输入估算、输出预留与安全余量共 ${total} tokens，超过 Context Window ${modelContextWindow}`);
  }
}

/** 将运行配置映射为共享的会话召回预算。 */
export function recallSettings(settings: RuntimeSettings, estimator: TokenEstimator): SessionRecallSettings {
  return {
    searchWindow: settings.sessionSearchWindow,
    scrollStep: settings.sessionScrollStep,
    messageLimit: settings.sessionRecallMessageLimit,
    tokenLimit: settings.sessionRecallTokenLimit,
    tokenEstimator: estimator,
  };
}
