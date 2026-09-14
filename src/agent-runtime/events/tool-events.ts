import type { ToolCallRecord } from "../../agent-loop/agent-loop.ts";

/** 工具事件的公开投影：记忆正文只保留元数据，普通工具递归移除凭证字段。 */
export function publicToolEvent(call: ToolCallRecord): Record<string, unknown> {
  const result = call.isError
    ? removeCredentials(call.result)
    : call.tool === "read_skill"
    ? skillToolMetadata(call.result)
    : call.tool === "session_search" || call.tool === "session_read"
    ? sessionRecallToolMetadata(call.result)
    : call.tool === "run_terminal"
    ? terminalToolMetadata(call.result)
    : call.tool === "manage_memory" ? memoryToolMetadata(call.result) : removeCredentials(call.result);
  return {
    tool: call.tool,
    toolCallId: call.toolUseId,
    iteration: call.iteration,
    isError: call.isError,
    arguments: call.tool === "manage_memory" ? memoryToolMetadata(call.args) : removeCredentials(call.args),
    result,
    outputLength: call.output.length,
    summary: call.isError ? "工具执行失败" : "工具执行完成",
  };
}

function skillToolMetadata(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { redacted: true };
  const result = value as Record<string, unknown>;
  return {
    name: result.name,
    description: result.description,
    instructionLength: typeof result.instructions === "string" ? result.instructions.length : 0,
  };
}

/** 终端执行只保留命令与边界信息；完整输出留在工具结果里，不灌进事件流。 */
function terminalToolMetadata(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { redacted: true };
  const result = value as Record<string, unknown>;
  return {
    command: result.command,
    workdir: result.workdir,
    exitCode: result.exitCode,
    truncated: result.truncated,
    timedOut: result.timedOut,
    denialHint: result.denialHint,
    sandbox: result.sandbox,
    approved: result.approved ?? false,
    networkAllowed: result.networkAllowed ?? false,
    stdoutLength: typeof result.stdout === "string" ? result.stdout.length : 0,
    stderrLength: typeof result.stderr === "string" ? result.stderr.length : 0,
  };
}

function memoryToolMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return { count: value.length, ids: value.map((item) => item?.id).filter((id) => typeof id === "number") };
  if (!value || typeof value !== "object") return { redacted: true };
  const item = value as Record<string, unknown>;
  return Object.fromEntries(["action", "intent", "status", "taskId", "reasonCode", "targetId", "deletedIds"].filter((key) => item[key] !== undefined).map((key) => [key, item[key]]));
}

function sessionRecallToolMetadata(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const result = value as Record<string, unknown>;
  if (Array.isArray(result.sessions)) {
    return {
      retrievalMode: result.retrievalMode,
      requestedLimit: result.requestedLimit,
      returnedSessionCount: result.returnedSessionCount,
      droppedSessionCount: result.droppedSessionCount,
      truncated: result.truncated,
      sessions: result.sessions.map((item) => {
        const sessionResult = item as Record<string, unknown>;
        const session = sessionResult.session as Record<string, unknown> | undefined;
        return {
          sessionId: session?.id,
          rank: sessionResult.rank,
          match: sessionResult.match,
          retrievalSignals: sessionResult.retrievalSignals,
          returnedMessageCount: sessionResult.returnedMessageCount,
          returnedRanges: sessionResult.returnedRanges,
          isComplete: sessionResult.isComplete,
          truncated: sessionResult.truncated,
        };
      }),
    };
  }
  const session = result.session as Record<string, unknown> | undefined;
  return {
    sessionId: session?.id,
    totalMessageCount: result.totalMessageCount,
    returnedMessageCount: result.returnedMessageCount,
    returnedRanges: result.returnedRanges,
    isComplete: result.isComplete,
    truncated: result.truncated,
  };
}

function removeCredentials(value: unknown, key = ""): unknown {
  const normalizedKey = key.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
  if (/(?:^|_)(?:api_key|authorization|cookie|token|access_token|refresh_token|auth_token|secret|client_secret|password)(?:$|_)/.test(normalizedKey)) {
    return "[凭证已移除]";
  }
  if (Array.isArray(value)) return value.map((item) => removeCredentials(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([itemKey, itemValue]) => [itemKey, removeCredentials(itemValue, itemKey)]));
}
