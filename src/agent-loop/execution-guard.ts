import { AgentLoopAbortError, AgentLoopTimeoutError } from "./errors.ts";

export interface GuardOptions {
  signal: AbortSignal | undefined;
  deadline: number | null;
  timeoutMs: number;
}

function abortError(signal?: AbortSignal): AgentLoopAbortError {
  const message = signal?.reason instanceof Error
    ? signal.reason.message
    : "Agent Loop 已取消";
  return new AgentLoopAbortError(message);
}

/**
 * 运行一次有截止时间的异步操作。超时只负责终止本轮等待；底层实现仍需读取
 * signal，才能同时取消网络或 I/O。
 */
export async function runGuarded<T>(
  operation: () => T | Promise<T>,
  { signal, deadline, timeoutMs }: GuardOptions,
): Promise<T> {
  if (signal?.aborted) throw abortError(signal);

  const remaining = deadline === null ? null : deadline - Date.now();
  if (remaining !== null && remaining <= 0) {
    throw new AgentLoopTimeoutError(timeoutMs);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener = () => {};
  const guards: Promise<never>[] = [];

  if (remaining !== null) {
    guards.push(new Promise((_, reject) => {
      timer = setTimeout(() => reject(new AgentLoopTimeoutError(timeoutMs)), remaining);
    }));
  }

  if (signal) {
    guards.push(new Promise((_, reject) => {
      const onAbort = () => reject(abortError(signal));
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    }));
  }

  try {
    return await Promise.race([Promise.resolve().then(operation), ...guards]);
  } finally {
    if (timer) clearTimeout(timer);
    removeAbortListener();
  }
}

/** 判断异常是否用于终止整个 Agent Loop，而非触发流式降级或工具错误结果。 */
export function isControlFlowError(error: unknown): boolean {
  return error instanceof AgentLoopAbortError
    || error instanceof AgentLoopTimeoutError
    || (error instanceof Error && error.name === "AbortError");
}
