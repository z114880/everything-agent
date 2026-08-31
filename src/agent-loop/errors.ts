/** Agent Loop 被取消时抛出的错误。 */
export class AgentLoopAbortError extends Error {
  constructor(message = "Agent Loop 已取消") {
    super(message);
    this.name = "AgentLoopAbortError";
  }
}

/** Agent Loop 超过整轮超时时间时抛出的错误。 */
export class AgentLoopTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Agent Loop 在 ${timeoutMs}ms 内未完成`);
    this.name = "AgentLoopTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}
