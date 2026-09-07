import { createModelClient } from "../../model/model-client.ts";
import type { AgentModelClient, TokenEstimator } from "../../agent-loop/agent-loop.ts";
import type { ModelConnectionSettings } from "../configuration/schema.ts";

/** 创建真实模型客户端；非 Loop 调用也使用同一估算预算。 */
export function createRuntimeClient(connection: ModelConnectionSettings, modelContextWindow: number, estimator?: TokenEstimator): AgentModelClient {
  const client = createModelClient(connection);
  if (!estimator) return client;
  return {
    messages: {
      async create(request) {
        assertModelTokenLimit(request, modelContextWindow, estimator);
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
