import type { ContextUsage } from "./agent-api";

/** 圆环的三档水位；颜色只作用于弧线，中心数字始终使用前景色。 */
export type ContextGaugeLevel = "normal" | "warn" | "critical";

export interface ContextGaugeReading {
  /** 已用额度占比，未封顶的真实值，可能超过 1。 */
  ratio: number;
  /** 展示用的整数百分比，同样不封顶。 */
  percent: number;
  /** 弧线长度占比，封顶在 1，避免画出超过一圈的进度。 */
  arcRatio: number;
  level: ContextGaugeLevel;
  usedTokens: number;
  availableTokens: number;
}

const WARN_RATIO = 0.7;
const CRITICAL_RATIO = 0.9;

/**
 * 把上下文占用换算成圆环读数。
 * 分子分母与 Agent Loop 的 Context Window 硬限制完全一致，避免出现
 * 「圆环显示未满、一发送就报超限」。额度非正数时返回 null，不渲染圆环。
 */
export function readContextGauge(usage: ContextUsage | null): ContextGaugeReading | null {
  if (!usage || usage.availableInputTokens <= 0) return null;
  const ratio = usage.estimatedInputTokens / usage.availableInputTokens;
  if (!Number.isFinite(ratio) || ratio < 0) return null;
  return {
    ratio,
    percent: Math.round(ratio * 100),
    arcRatio: Math.min(ratio, 1),
    level: ratio >= CRITICAL_RATIO ? "critical" : ratio >= WARN_RATIO ? "warn" : "normal",
    usedTokens: usage.estimatedInputTokens,
    availableTokens: usage.availableInputTokens,
  };
}
