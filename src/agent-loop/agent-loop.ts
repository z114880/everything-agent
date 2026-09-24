/**
 * Agent Loop 遵循 observe → reason → act → repeat：模型根据消息推理，需要工具
 * 时执行调用并把结果放回工作记忆，不再请求工具时向用户回复。模型自然结束和
 * maxIterations 硬限制共同保证循环一定能够退出。
 */

/**
 * 本文件保留 Agent Loop 的公开接口和调度主干；类型、执行保护、模型响应与工具
 * 执行分别由同目录内部模块负责。
 */

import { compactContext, CompactionError, isUserRequest } from "./compaction.ts";
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
  ContextCompaction,
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
/** Context Window 之外必须留出的固定安全余量；水位展示与硬限制共用同一口径。 */
export const CONTEXT_SAFETY_TOKENS = 512;
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

  const turnId = options.turnId ?? crypto.randomUUID();
  const startedAt = performance.now();
  const deadline = timeoutMs === undefined ? null : Date.now() + timeoutMs;
  const guard: GuardOptions = { signal, deadline, timeoutMs: timeoutMs ?? 0 };
  const toolCalls: ToolCallRecord[] = [];
  const notify: AgentObserver = async (kind, event = {}) => observer(kind, { ...event, turnId });
  let iterations = 0;
  let workingMessages = [...messages];
  const protectedMessage = [...messages].reverse().find(isUserRequest);
  let compactionFailed = false;
  const metrics: LoopMetrics = {
    modelMs: 0,
    toolMs: 0,
    peakEstimatedInputTokens: null,
    peakInputTokens: null,
  };

  await notify("context_assembled", {
    messageCount: messages.length,
    hasSystemPrompt: Boolean(system.trim()),
  });
  await notify("loop_start", { model, maxIterations });

  try {
    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      iterations = iteration;
      const toolSchemas = tools.schemas();
      let compactionId: string | undefined;
      const request = {
        model,
        system,
        messages: workingMessages,
        tools: toolSchemas,
        max_tokens: maxTokens,
        signal,
      };
      if (tokenEstimator) {
        // 先记录再判定，超限的那次请求同样是本轮真实达到过的水位。
        let estimatedInputTokens = tokenEstimator.estimateRequest(request);
        metrics.peakEstimatedInputTokens = Math.max(metrics.peakEstimatedInputTokens ?? 0, estimatedInputTokens);
        if (modelContextWindow !== undefined && !compactionFailed) {
          try {
            const compacted = await compactContext({
              request, beforeTokens: estimatedInputTokens, client, estimator: tokenEstimator,
              inputBudget: modelContextWindow - maxTokens - CONTEXT_SAFETY_TOKENS,
              contextWindow: modelContextWindow, safetyTokens: CONTEXT_SAFETY_TOKENS,
              protectedMessage, guard, iteration, commit: options.onCompacted,
              notify: async (kind, event) => {
                if (kind === "compact_started") compactionId = String(event.compactionId);
                if (kind === "compact_model_completed" || kind === "compact_model_failed") metrics.modelMs += Number(event.ms);
                await notify(kind, event);
              },
            });
            if (compacted) {
              request.messages = workingMessages = compacted.messages;
              estimatedInputTokens = compacted.afterTokens;
            }
          } catch (error) {
            if (!(error instanceof CompactionError)) throw error;
            compactionFailed = true;
          }
        }
        if (modelContextWindow !== undefined && estimatedInputTokens + maxTokens + CONTEXT_SAFETY_TOKENS > modelContextWindow) {
          throw new Error(`模型输入估算、输出预留与安全余量共 ${estimatedInputTokens + maxTokens + CONTEXT_SAFETY_TOKENS} tokens，超过 Context Window ${modelContextWindow}；请新建 Session 或调高 Context Window`);
        }
      }

      const modelCallId = crypto.randomUUID();
      await notify("model_request", {
        iteration,
        ...(compactionId ? { compactionId } : {}),
        modelCallId,
        request: {
          model,
          system,
          messages: structuredClone(workingMessages),
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
        const failedMs = Math.round(performance.now() - llmStartedAt);
        metrics.modelMs += failedMs;
        await notify("model_failed", {
          iteration,
          modelCallId,
          errorType: error instanceof Error ? error.name : "UnknownError",
          errorMessage: error instanceof Error ? error.message : String(error),
          ms: failedMs,
        });
        throw error;
      }
      const modelMs = Math.round(performance.now() - llmStartedAt);
      metrics.modelMs += modelMs;
      const tokenUsage = tokenUsageFrom(response);
      if (tokenUsage) metrics.peakInputTokens = Math.max(metrics.peakInputTokens ?? 0, tokenUsage.inputTokens);
      const stopReason = response.stop_reason ?? response.stopReason ?? null;
      await notify("model_response", {
        iteration,
        modelCallId,
        response: structuredClone(response),
        stopReason,
        tokenUsage,
        ms: modelMs,
      });
      await notify("llm", { iteration, stopReason, tokenUsage });
      const assistantMessage = { role: "assistant", content: response.content };
      messages.push(assistantMessage);
      workingMessages.push(assistantMessage);

      const requestedTools = response.content.filter((block) => block?.type === "tool_use");
      if (requestedTools.length === 0) {
        return finishCompletedLoop(
          textFrom(response.content),
          toolCalls,
          iterations,
          metrics,
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
      metrics.toolMs += executed.ms;
      toolCalls.push(...executed.records);
      const resultsMessage = { role: "user", content: executed.results };
      messages.push(resultsMessage);
      workingMessages.push(resultsMessage);
    }

    const result: AgentLoopResult = {
      reply: ITERATION_LIMIT_REPLY,
      toolCalls,
      iterations,
      stopReason: "max_iterations",
      ...loopStatistics(toolCalls, metrics),
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

/** Loop 执行过程中持续累加的统计量。 */
interface LoopMetrics {
  modelMs: number;
  toolMs: number;
  peakEstimatedInputTokens: number | null;
  peakInputTokens: number | null;
}

/** 把过程累加量整理成结果字段；工具失败数由已执行记录得出。 */
function loopStatistics(toolCalls: ToolCallRecord[], metrics: LoopMetrics) {
  return {
    modelMs: metrics.modelMs,
    toolMs: metrics.toolMs,
    failedToolCallCount: toolCalls.filter((call) => call.isError).length,
    peakEstimatedInputTokens: metrics.peakEstimatedInputTokens,
    peakInputTokens: metrics.peakInputTokens,
  };
}

async function finishCompletedLoop(
  reply: string,
  toolCalls: ToolCallRecord[],
  iterations: number,
  metrics: LoopMetrics,
  startedAt: number,
  notify: AgentObserver,
): Promise<AgentLoopResult> {
  const result: AgentLoopResult = {
    reply,
    toolCalls,
    iterations,
    stopReason: "completed",
    ...loopStatistics(toolCalls, metrics),
  };
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
    failedToolCallCount: result.failedToolCallCount,
    modelMs: result.modelMs,
    toolMs: result.toolMs,
    peakEstimatedInputTokens: result.peakEstimatedInputTokens,
    peakInputTokens: result.peakInputTokens,
    ms: Math.round(performance.now() - startedAt),
  });
}
