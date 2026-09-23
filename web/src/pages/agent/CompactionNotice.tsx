import type { AgentEvent, CompactionRecord } from "../../agent-api";

export interface CompactionView extends Partial<CompactionRecord> {
  compactionId: string;
  reasonCode?: string;
  status: "running" | "done" | "error";
}

/** 按实际生命周期更新压缩标记，重复事件不会增加相同标记。 */
export function updateCompactionViews(items: CompactionView[], kind: string, event: AgentEvent): CompactionView[] {
  if (!event.compactionId) return items;
  const next: CompactionView = {
    ...items.find((item) => item.compactionId === event.compactionId),
    compactionId: event.compactionId,
    beforeTokens: event.beforeTokens, afterTokens: event.afterTokens,
    availableInputTokens: event.availableInputTokens, ms: event.ms,
    targetReached: event.targetReached, reasonCode: event.reasonCode,
    status: kind === "compact_started" ? "running" : kind === "compact_completed" ? "done" : "error",
  };
  return [...items.filter((item) => item.compactionId !== event.compactionId), next];
}

/** 聊天内只显示统计信息，不展示可能包含私人内容的摘要。 */
export function CompactionNotice({ item }: { item: CompactionView }) {
  const waterline = (tokens: number | undefined) => tokens === undefined ? "—"
    : `${tokens.toLocaleString()} tokens${item.availableInputTokens && item.availableInputTokens > 0 ? `（${Math.round(tokens / item.availableInputTokens * 100)}%）` : ""}`;
  const reasons: Record<string, string> = {
    batch_limit: "历史超过分批上限", input_limit: "摘要请求无可用额度", invalid_summary: "摘要为空或不完整",
    not_reduced: "摘要未减少占用", persistence_failed: "检查点保存失败", interrupted: "压缩已取消或超时", model_failed: "摘要模型调用失败",
  };
  return <div className="agent-inline-note" role="status">
    {item.status === "running" ? "正在压缩上下文" : item.status === "error" ? "上下文压缩失败，保留原上下文" : "上下文已压缩"}
    {item.status === "error" && item.reasonCode && reasons[item.reasonCode] && `（${reasons[item.reasonCode]}）`}
    {" · "}{waterline(item.beforeTokens)}
    {item.status === "done" && <> → {waterline(item.afterTokens)}{item.targetReached === false && " · 已保留必要内容，超过 30% 目标"}</>}
    {item.ms !== undefined && ` · ${(item.ms / 1000).toFixed(1)}s`}
  </div>;
}
