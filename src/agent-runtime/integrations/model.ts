import { createModelClient } from "../../model/model-client.ts";
import type { AgentModelClient, TokenEstimator } from "../../agent-loop/agent-loop.ts";
import type { ModelConnectionSettings } from "../configuration/schema.ts";

/** 创建真实模型客户端；非 Loop 调用也使用同一估算预算。 */
export function createRuntimeClient(connection: ModelConnectionSettings, modelContextWindow: number, estimator?: TokenEstimator, onUsage?: (usage: import("../../agent-loop/agent-loop.ts").TokenUsage | null) => void): AgentModelClient {
  const client = createModelClient(connection);
  return {
    messages: {
      async create(request) {
        if (estimator) assertModelTokenLimit(request, modelContextWindow, estimator);
        try {
          const result = await client.messages.create(request);
          onUsage?.(result.tokenUsage ?? null);
          return result;
        } catch (error) { onUsage?.(null); throw error; }
      },
      ...(client.messages.stream ? { async stream(request: import("../../agent-loop/agent-loop.ts").ModelRequest) {
        let stream: import("../../agent-loop/agent-loop.ts").ModelStream;
        try { stream = await client.messages.stream!(request); }
        catch (error) { onUsage?.(null); throw error; }
        let reported = false;
        return {
          textStream: (async function* () {
            try { for await (const chunk of stream.textStream) yield chunk; }
            catch (error) { if (!reported) { reported = true; onUsage?.(null); } throw error; }
          })(),
          async getFinalMessage() {
            try {
              const result = await stream.getFinalMessage();
              if (!reported) { reported = true; onUsage?.(result.tokenUsage ?? null); }
              return result;
            } catch (error) { if (!reported) { reported = true; onUsage?.(null); } throw error; }
          },
        };
      } } : {}),
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
