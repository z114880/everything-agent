import type { AgentObserver } from "../agent-loop/agent-loop.ts";
import type { AgentProvider } from "../model/model-client.ts";
import type { ContextWaterline } from "./context-window.ts";

/** 一次个人助理回合的输入。 */
export interface AgentTurnInput {
  sessionId: string;
  prompt: string;
}

/** 宿主提供的事件接收器与取消信号。 */
export interface AgentTurnOptions {
  observer: AgentObserver;
  signal: AbortSignal;
}

/** 回合完成结果，不包含页面展示数据。 */
export interface AgentTurnResult extends ContextWaterline {
  reply: string;
  iterations: number;
  stopReason: string;
  toolCallCount: number;
  /** 返回错误结果的工具调用数量。 */
  failedToolCallCount: number;
  /** 本回合入队的后台记忆写入任务，用于关联独立的任务 trace 文件。 */
  derivedTaskIds: string[];
  model: string;
  provider: AgentProvider;
  ms: number;
  /** 检索阶段耗时，含 gate 小模型调用；`ms` 减去三段耗时即为编排开销。 */
  retrievalMs: number;
  modelMs: number;
  toolMs: number;
  turnId: string;
}
