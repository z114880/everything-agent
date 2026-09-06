import { LocalToolRegistry } from "../../tools/tool-registry.ts";
import { ManageMemoryTool } from "../../tools/manage-memory.ts";
import { runAgentLoop } from "../../agent-loop/agent-loop.ts";
import type { AgentMessage, AgentObserver, TokenEstimator } from "../../agent-loop/agent-loop.ts";
import type { MemoryRuntime } from "../../memory/index.ts";
import type { JsonlTracer } from "../../tracing/jsonl-tracer.ts";
import type { RuntimeSettings } from "../settings/types.ts";
import type { AgentRunInput, AgentRunOptions, AgentRunResult } from "./types.ts";
import { createRuntimeClient, recallSettings } from "./model-context.ts";
import { publicToolEvent } from "./tool-events.ts";

const DEFAULT_TIMEOUT_MS = 60_000;

/** 执行已取得会话锁的回合，持久化消息并转发真实执行事件。 */
export async function executeAgentRun(
  input: AgentRunInput,
  { observer, signal }: AgentRunOptions,
  { memory, trace, settings, tokenEstimator, readSystemPrompt }: {
    memory: MemoryRuntime; trace: JsonlTracer; settings: RuntimeSettings;
    tokenEstimator: TokenEstimator; readSystemPrompt: () => Promise<string>;
  },
): Promise<AgentRunResult> {
  const { prompt, sessionId } = input;

  const client = createRuntimeClient(settings, tokenEstimator);
  const runId = crypto.randomUUID();
  const startedAt = performance.now();
  const userEvidence = memory.startRun(sessionId, runId, prompt);
  await trace.record("run_started", {
    runId,
    sessionId,
    userInput: prompt,
    provider: settings.provider,
    model: settings.model,
    settings: {
      modelContextWindow: settings.modelContextWindow,
      sessionRecall: recallSettings(settings, tokenEstimator),
      maxIterations: 10,
      maxTokens: 2_048,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      stream: true,
    },
    runtime: { nodeVersion: process.version, traceSchemaVersion: 2 },
  });
  let contextMetadata: Record<string, unknown> = {};
  const emit: AgentObserver = async (kind, event) => {
    const enriched = { ...event, ...(kind === "context_assembled" ? contextMetadata : {}), runId, sessionId };
    await observer(kind, enriched);
    if ([
      "context_assembled", "gate_start", "gate_end", "retrieval", "retrieval_completed",
      "embedding_started", "embedding_completed", "embedding_failed",
      "dense_retrieval_completed", "lexical_retrieval_completed", "rrf_completed", "mmr_completed",
      "model_request", "model_response", "model_failed", "stream_fallback",
      "tool_started", "tool_completed", "tool_failed",
    ].includes(kind) || kind.startsWith("memory_")) {
      const modelFields = kind.startsWith("model_") ? { provider: settings.provider, model: settings.model } : {};
      await trace.record(kind, { ...enriched, ...modelFields });
    }
  };
  try {
    const history = memory.getWorkingMemory(sessionId);
    const gateHistory = memory.getWorkingMemory(sessionId, 3);
    const retrieval = await memory.retrieve(prompt, gateHistory, {
      client,
      model: settings.smallModel || settings.model,
      currentSessionId: sessionId,
      recall: recallSettings(settings, tokenEstimator),
      observer: emit,
      runId,
    });
    const messages: AgentMessage[] = [...history, { role: "user", content: prompt }];
    const appendedFrom = messages.length;
    const baseSystem = await readSystemPrompt();
    contextMetadata = {
      historyMessageCount: history.length,
      semanticMemoryIds: retrieval.semantic.map((item) => item.id),
      sessionRecallSessionIds: retrieval.sessionRecall?.sessions.map((item) => item.session.id) ?? [],
      sessionRecallRanges: retrieval.sessionRecall?.sessions.map((item) => ({ sessionId: item.session.id, ranges: item.returnedRanges })) ?? [],
      sessionRecallEntryCount: retrieval.sessionRecall?.sessions.reduce((sum, item) => sum + item.returnedMessageCount, 0) ?? 0,
      sessionRecallEstimatedTokens: retrieval.sessionRecall
        ? tokenEstimator.estimateText(JSON.stringify(retrieval.sessionRecall.sessions.flatMap((item) => item.entries)))
        : 0,
      sessionRecallTruncated: retrieval.sessionRecall?.truncated ?? false,
    };
    const result = await runAgentLoop({
      client,
      model: settings.model,
      system: [baseSystem, retrieval.context].filter(Boolean).join("\n\n"),
      messages,
      tools: new LocalToolRegistry(memory, new ManageMemoryTool(memory, {
        client, model: settings.smallModel || settings.model, currentSessionId: sessionId,
        runId, evidenceMessageId: userEvidence.id, observer: emit,
      }), {
        currentSessionId: sessionId,
        settings: recallSettings(settings, tokenEstimator),
      }),
      maxIterations: 10,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      stream: true,
      modelContextWindow: settings.modelContextWindow,
      tokenEstimator,
      signal,
      observer: emit,
      serializeToolEvent: publicToolEvent,
      runId,
    });
    const appended = messages.slice(appendedFrom);
    if (!isFinalAssistantMessage(appended.at(-1))) {
      appended.push({ role: "assistant", content: [{ type: "text", text: result.reply }] });
    }
    await memory.completeRun(sessionId, runId, appended);
    const ms = Math.round(performance.now() - startedAt);
    await trace.record("run_completed", {
      runId,
      sessionId,
      reply: result.reply,
      iterations: result.iterations,
      stopReason: result.stopReason,
      toolCallCount: result.toolCalls.length,
      ms,
    });
    return {
      reply: result.reply,
      iterations: result.iterations,
      stopReason: result.stopReason,
      toolCallCount: result.toolCalls.length,
      model: settings.model,
      provider: settings.provider,
      ms,
      runId,
    };
  } catch (error) {
    await trace.record("run_failed", {
      runId,
      sessionId,
      errorType: error instanceof Error ? error.name : "UnknownError",
      errorMessage: error instanceof Error ? error.message : String(error),
      ms: Math.round(performance.now() - startedAt),
    });
    throw error;
}
}

function isFinalAssistantMessage(message: AgentMessage | undefined): boolean {
  return Boolean(message?.role === "assistant" && Array.isArray(message.content)
    && !message.content.some((block: { type?: string }) => block.type === "tool_use"));
}
