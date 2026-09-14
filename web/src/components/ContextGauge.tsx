import type { ContextUsage } from "../agent-api";
import { readContextGauge } from "../context-gauge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./ui/tooltip";

const SIZE = 28;
const STROKE = 3;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * 输入框旁的上下文水位圆环。
 * 分子分母与 Agent Loop 的 Context Window 硬限制一致；额度不可用时整体不渲染，
 * 不显示 0%。
 */
export function ContextGauge({ usage }: { usage: ContextUsage | null }) {
  const reading = readContextGauge(usage);
  if (!reading) return null;
  const label = `上下文占用 ${reading.percent}%`;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={`context-gauge level-${reading.level}`}
            role="progressbar"
            aria-label={label}
            aria-valuenow={reading.percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuetext={label}
          >
            <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true">
              <circle
                className="context-gauge-track"
                cx={SIZE / 2}
                cy={SIZE / 2}
                r={RADIUS}
                strokeWidth={STROKE}
              />
              <circle
                className="context-gauge-arc"
                cx={SIZE / 2}
                cy={SIZE / 2}
                r={RADIUS}
                strokeWidth={STROKE}
                strokeDasharray={CIRCUMFERENCE}
                strokeDashoffset={CIRCUMFERENCE * (1 - reading.arcRatio)}
              />
            </svg>
            <span className="context-gauge-value">{reading.percent}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent role="tooltip">
          已用 {reading.usedTokens.toLocaleString()} / 可用{" "}
          {reading.availableTokens.toLocaleString()} tokens · 估算值，不含本轮检索注入的记忆
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
