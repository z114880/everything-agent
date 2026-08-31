import {
  isControlFlowError,
  runGuarded,
  type GuardOptions,
} from "./execution-guard.js";
import type {
  AgentObserver,
  EventData,
  ModelContentBlock,
  ToolCallRecord,
  ToolRegistry,
} from "./types.js";

interface ExecuteToolCallsOptions {
  calls: ModelContentBlock[];
  tools: ToolRegistry;
  notify: AgentObserver;
  guard: GuardOptions;
  signal: AbortSignal | undefined;
  deadline: number | null;
  iteration: number;
  serializeToolEvent: (call: ToolCallRecord) => EventData;
}

export interface ExecutedToolCalls {
  records: ToolCallRecord[];
  results: EventData[];
}

/** 顺序执行同一轮模型请求的工具，并生成下一轮可观察的工具结果。 */
export async function executeToolCalls({
  calls,
  tools,
  notify,
  guard,
  signal,
  deadline,
  iteration,
  serializeToolEvent,
}: ExecuteToolCallsOptions): Promise<ExecutedToolCalls> {
  const records: ToolCallRecord[] = [];
  const results: EventData[] = [];

  for (const call of calls) {
    const toolName = call.name!;
    const toolUseId = call.id!;
    const args = call.input ?? {};
    let rawOutput: unknown;
    let isError = false;
    const startedAt = performance.now();

    await notify("tool_start", { tool: toolName, toolUseId, iteration });
    try {
      rawOutput = await runGuarded(
        () => tools.execute(toolName, args, notify, {
          signal,
          deadline,
          iteration,
          toolUseId,
        }),
        guard,
      );
    } catch (error) {
      if (isControlFlowError(error)) throw error;
      isError = true;
      rawOutput = `工具 ${toolName} 执行失败：${error instanceof Error ? error.message : String(error)}`;
    }

    const serialized = typeof rawOutput === "string" ? rawOutput : JSON.stringify(rawOutput);
    const output = serialized === undefined ? String(rawOutput) : serialized;
    const record: ToolCallRecord = {
      tool: toolName,
      args,
      output,
      toolUseId,
      iteration,
      isError,
    };
    records.push(record);

    const publicToolEvent = serializeToolEvent(record);
    await notify("tool_end", {
      ...publicToolEvent,
      ms: Math.round(performance.now() - startedAt),
    });
    await notify("tool", publicToolEvent);
    results.push({
      type: "tool_result",
      tool_use_id: toolUseId,
      content: output,
      ...(isError ? { is_error: true } : {}),
    });
  }

  return { records, results };
}
