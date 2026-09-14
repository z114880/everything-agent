import { CONTEXT_SAFETY_TOKENS } from "../agent-loop/agent-loop.ts";

/** 一次回合真实达到过的上下文水位，与 Context Window 硬限制同口径。 */
export interface ContextWaterline {
  contextWindow: number;
  maxTokens: number;
  contextSafetyTokens: number;
  /** 留给输入的额度：Context Window 扣掉输出预留与安全余量。 */
  availableInputTokens: number;
  /** 本轮各次请求估算输入 token 的最大值；未注入估算器时为 null。 */
  peakEstimatedInputTokens: number | null;
  /** 供应商返回的真实输入 token 峰值；无一次报告 usage 时为 null。 */
  peakInputTokens: number | null;
}

/** 下一轮起步就会占用的上下文，用于在超限之前展示水位。 */
export interface ContextUsage {
  contextWindow: number;
  maxTokens: number;
  contextSafetyTokens: number;
  availableInputTokens: number;
  /**
   * 系统提示、Skill 目录、工具 schema 与该 Session 全部工作记忆的估算之和。
   * 不含本轮检索注入的记忆——检索内容取决于尚未输入的那句话，事前不可知，
   * 因此这是下限而非精确值。
   */
  estimatedInputTokens: number;
}

export { CONTEXT_SAFETY_TOKENS };

/** 计算留给输入的额度；Loop 的硬限制用的是同一个公式。 */
export function availableInputTokens(contextWindow: number, maxTokens: number): number {
  return contextWindow - maxTokens - CONTEXT_SAFETY_TOKENS;
}

/** 把 Loop 报告的峰值补齐成完整水位，供 run_completed 与前端共用同一组分母。 */
export function contextWaterline(
  contextWindow: number,
  maxTokens: number,
  peakEstimatedInputTokens: number | null,
  peakInputTokens: number | null,
): ContextWaterline {
  return {
    contextWindow,
    maxTokens,
    contextSafetyTokens: CONTEXT_SAFETY_TOKENS,
    availableInputTokens: availableInputTokens(contextWindow, maxTokens),
    peakEstimatedInputTokens,
    peakInputTokens,
  };
}
