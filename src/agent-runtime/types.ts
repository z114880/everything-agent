import type { AgentObserver } from "../agent-loop/agent-loop.ts";
import type { AgentProvider } from "../model/model-client.ts";

/** 一次个人助理回合的输入。 */
export interface AgentRunInput {
  sessionId: string;
  prompt: string;
}

/** 宿主提供的事件接收器与取消信号。 */
export interface AgentRunOptions {
  observer: AgentObserver;
  signal: AbortSignal;
}

/** 回合完成结果，不包含页面展示数据。 */
export interface AgentRunResult {
  reply: string;
  iterations: number;
  stopReason: string;
  toolCallCount: number;
  model: string;
  provider: AgentProvider;
  ms: number;
  runId: string;
}
