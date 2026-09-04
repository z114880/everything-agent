/**
 * Agent Loop 遵循 observe → reason → act → repeat：模型根据消息推理，需要工具
 * 时执行调用并把结果放回工作记忆，不再请求工具时向用户回复。模型自然结束和
 * maxIterations 硬限制共同保证循环一定能够退出。
 */

/**
 * 本文件保留 Agent Loop 的公开接口和调度主干；类型、执行保护、模型响应与工具
 * 执行分别由同目录内部模块负责。
 */

import type { GuardOptions } from "./execution-guard.ts";
import { requestModelResponse, textFrom, tokenUsageFrom } from "./model-response.ts";
import { executeToolCalls } from "./tool-execution.ts";
import type {
  AgentLoopOptions,
  AgentLoopResult,
  AgentObserver,
  EventData,
  ModelResponse,
  TokenEstimator,
  ToolCallRecord,
} from "./types.ts";

export { AgentLoopAbortError, AgentLoopTimeoutError } from "./errors.ts";
export type {
  AgentLoopOptions,
  AgentLoopResult,
  AgentMessage,
  AgentModelClient,
  AgentObserver,
  ModelContentBlock,
  ModelRequest,
  ModelResponse,
  ModelStream,
  TokenEstimator,
  TokenUsage,
  ToolCallRecord,
  ToolExecutionContext,
  ToolRegistry,
} from "./types.ts";

const DEFAULT_MAX_ITERATIONS = 10;
const DEFAULT_MAX_TOKENS = 2048;
const CONTEXT_SAFETY_TOKENS = 512;
const ITERATION_LIMIT_REPLY = "已达到本轮最大迭代次数，请把任务拆小后重试。";

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${name} 必须是正整数`);
  }
}

function validateOptions(options: AgentLoopOptions): void {
  const {
    client,
    messages,
    tools,
    maxIterations = DEFAULT_MAX_ITERATIONS,
    maxTokens = DEFAULT_MAX_TOKENS,
    modelContextWindow,
    tokenEstimator,
    observer = () => {},
    timeoutMs,
    serializeToolEvent = defaultToolEvent,
  } = options;

  assertPositiveInteger(maxIterations, "maxIterations");
  assertPositiveInteger(maxTokens, "maxTokens");
  if (modelContextWindow !== undefined) assertPositiveInteger(modelContextWindow, "modelContextWindow");
  if (modelContextWindow !== undefined && !tokenEstimator) throw new TypeError("配置 modelContextWindow 时必须提供 tokenEstimator");
  if (timeoutMs !== undefined) assertPositiveInteger(timeoutMs, "timeoutMs");
  if (!client?.messages || typeof client.messages.create !== "function") {
    throw new TypeError("client.messages.create 必须是函数");
  }
  if (!Array.isArray(messages)) throw new TypeError("messages 必须是数组");
  if (!tools || typeof tools.schemas !== "function" || typeof tools.execute !== "function") {
    throw new TypeError("tools 必须实现 schemas() 和 execute()");
  }
  if (typeof observer !== "function") throw new TypeError("observer 必须是函数");
  if (typeof serializeToolEvent !== "function") {
    throw new TypeError("serializeToolEvent 必须是函数");
  }
}

function defaultToolEvent(call: ToolCallRecord): EventData {
  return {
    tool: call.tool,
    toolCallId: call.toolUseId,
    iteration: call.iteration,
    arguments: call.args,
    result: call.result,
    isError: call.isError,
  };
}

/**
 * 执行一个 `observe → reason → act → repeat` Agent 回合。
 *
 * 模型与工具都通过小接口注入。传入的 messages 会原地追加 assistant 工具请求
 * 和 user 工具结果，作为本轮完整工作记忆。
 */
export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  validateOptions(options);
  const {
    client,
    model,
    system = "",
    messages,
    tools,
    maxIterations = DEFAULT_MAX_ITERATIONS,
    maxTokens = DEFAULT_MAX_TOKENS,
    modelContextWindow,
    tokenEstimator,
    observer = () => {},
    stream = false,
    signal,
    timeoutMs,
    serializeToolEvent = defaultToolEvent,
  } = options;

  const runId = options.runId ?? crypto.randomUUID();
  const startedAt = performance.now();
  const deadline = timeoutMs === undefined ? null : Date.now() + timeoutMs;
  const guard: GuardOptions = { signal, deadline, timeoutMs: timeoutMs ?? 0 };
  const toolCalls: ToolCallRecord[] = [];
  const notify: AgentObserver = async (kind, event = {}) => observer(kind, { ...event, runId });
  let iterations = 0;

  await notify("context_assembled", {
    messageCount: messages.length,
    hasSystemPrompt: Boolean(system.trim()),
  });
  await notify("loop_start", { model, maxIterations });

  try {
    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      iterations = iteration;
      const toolSchemas = tools.schemas();
      const request = {
        model,
        system,
        messages,
        tools: toolSchemas,
        max_tokens: maxTokens,
        signal,
      };
      if (modelContextWindow !== undefined && tokenEstimator) {
        const estimatedInputTokens = tokenEstimator.estimateRequest(request);
        if (estimatedInputTokens + maxTokens + CONTEXT_SAFETY_TOKENS > modelContextWindow) {
          throw new Error(`模型输入估算、输出预留与安全余量共 ${estimatedInputTokens + maxTokens + CONTEXT_SAFETY_TOKENS} tokens，超过 Context Window ${modelContextWindow}；请新建 Session 或调高 Context Window`);
        }
      }

      const modelCallId = crypto.randomUUID();
      await notify("model_request", {
        iteration,
        modelCallId,
        request: {
          model,
          system,
          messages: structuredClone(messages),
          tools: structuredClone(toolSchemas),
          maxTokens,
          stream,
        },
      });
      const llmStartedAt = performance.now();
      let response: ModelResponse;
      try {
        response = await requestModelResponse(
          client,
          request,
          notify,
          guard,
          stream,
          iteration,
        );
      } catch (error) {
        await notify("model_failed", {
          iteration,
          modelCallId,
          errorType: error instanceof Error ? error.name : "UnknownError",
          errorMessage: error instanceof Error ? error.message : String(error),
          ms: Math.round(performance.now() - llmStartedAt),
        });
        throw error;
      }
      const tokenUsage = tokenUsageFrom(response);
      const stopReason = response.stop_reason ?? response.stopReason ?? null;
      await notify("model_response", {
        iteration,
        modelCallId,
        response: structuredClone(response),
        stopReason,
        tokenUsage,
        ms: Math.round(performance.now() - llmStartedAt),
      });
      await notify("llm", { iteration, stopReason, tokenUsage });
      messages.push({ role: "assistant", content: response.content });

      const requestedTools = response.content.filter((block) => block?.type === "tool_use");
      if (requestedTools.length === 0) {
        return finishCompletedLoop(
          textFrom(response.content),
          toolCalls,
          iterations,
          startedAt,
          notify,
        );
      }

      const executed = await executeToolCalls({
        calls: requestedTools,
        tools,
        notify,
        guard,
        signal,
        deadline,
        iteration,
        serializeToolEvent,
      });
      toolCalls.push(...executed.records);
      messages.push({ role: "user", content: executed.results });
    }

    const result: AgentLoopResult = {
      reply: ITERATION_LIMIT_REPLY,
      toolCalls,
      iterations,
      stopReason: "max_iterations",
    };
    await notifyLoopEnd(result, startedAt, notify);
    return result;
  } catch (error) {
    await notify("loop_error", {
      iterations,
      error: String(error),
      ms: Math.round(performance.now() - startedAt),
    });
    throw error;
  }
}

async function finishCompletedLoop(
  reply: string,
  toolCalls: ToolCallRecord[],
  iterations: number,
  startedAt: number,
  notify: AgentObserver,
): Promise<AgentLoopResult> {
  const result: AgentLoopResult = { reply, toolCalls, iterations, stopReason: "completed" };
  await notify("reply", { iteration: iterations, textLength: reply.length });
  await notifyLoopEnd(result, startedAt, notify);
  return result;
}

async function notifyLoopEnd(
  result: AgentLoopResult,
  startedAt: number,
  notify: AgentObserver,
): Promise<void> {
  await notify("loop_end", {
    iterations: result.iterations,
    stopReason: result.stopReason,
    toolCallCount: result.toolCalls.length,
    ms: Math.round(performance.now() - startedAt),
  });
}
