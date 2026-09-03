import { Activity, AlertCircle, Bot, MessageSquare, RefreshCw, Wrench } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { loadTraces, type TraceDashboard, type TraceRecord } from "../agent-api";
import { groupTraceRecords, shortId, type TraceRunGroup } from "../trace-view-model";

const EMPTY_DASHBOARD: TraceDashboard = { records: [], sessions: [] };

export function TracePage() {
  const [dashboard, setDashboard] = useState<TraceDashboard>(EMPTY_DASHBOARD);
  const [error, setError] = useState("");
  const groups = useMemo(
    () => groupTraceRecords(dashboard.records, dashboard.sessions),
    [dashboard],
  );
  const reload = () => {
    setError("");
    return loadTraces().then(setDashboard)
      .catch((value: unknown) => setError(value instanceof Error ? value.message : String(value)));
  };
  useEffect(() => { void reload(); }, []);

  return <div className="content-wrap trace-page">
    <div className="memory-header">
      <div>
        <div className="eyebrow">Classic Loop / 持久化可观测性</div>
        <h1>运行记录</h1>
        <p>按 Session 与 Agent 回合查看脱敏后的输入、模型、工具、记忆和结果。</p>
      </div>
      <button className="ghost-action" onClick={() => void reload()}><RefreshCw size={14} /> 刷新</button>
    </div>
    {error && <div className="error-message">{error}</div>}
    {!error && groups.length === 0 && <div className="panel trace-empty">还没有运行记录。</div>}
    <div className="trace-session-list">
      {groups.map((group, groupIndex) => <details className="panel trace-session" open={groupIndex === 0} key={group.sessionId ?? "system"}>
        <summary className="trace-session-summary">
          <span className="trace-session-icon"><MessageSquare size={15} /></span>
          <span className="trace-session-heading"><strong>{group.title}</strong><small>{group.sessionId ? `session ${shortId(group.sessionId)}` : "未关联 Session"}</small></span>
          <span className="trace-session-meta">{group.runs.length} 个回合 · {group.eventCount} 个事件<br />{formatTime(group.latestAt)}</span>
        </summary>
        <div className="trace-session-body">
          {group.runs.map((run, runIndex) => <RunGroup run={run} open={groupIndex === 0 && runIndex === 0} key={run.runId} />)}
        </div>
      </details>)}
    </div>
  </div>;
}

function RunGroup({ run, open }: { run: TraceRunGroup; open: boolean }) {
  const durationRecord = [...run.records].reverse().find((record) => typeof record.payload?.ms === "number" || typeof record.ms === "number");
  const duration = typeof durationRecord?.payload?.ms === "number" ? durationRecord.payload.ms : durationRecord?.ms;
  const toolCount = run.records.filter((record) => record.type === "tool_completed" || record.type === "tool_failed" || record.type === "tool_end").length;
  return <details className={`trace-run ${run.status}`} open={open}>
    <summary className="trace-run-summary">
      <span className={`trace-status-dot ${run.status}`} />
      <span className="trace-run-heading">
        <strong>{run.prompt || runLabel(run)}</strong>
        <small>run {shortId(run.runId)} · {formatTime(run.startedAt)}</small>
      </span>
      <span className="trace-run-meta">{statusLabel(run.status)} · {run.records.length} 步{toolCount ? ` · ${toolCount} 次工具` : ""}{typeof duration === "number" ? ` · ${formatDuration(duration)}` : ""}</span>
    </summary>
    <div className="trace-run-body">
      {run.prompt && <section className="trace-content user"><div><MessageSquare size={13} /> 用户输入</div><p>{run.prompt}</p></section>}
      {run.reply && <section className="trace-content assistant"><div><Bot size={13} /> Agent 回复</div><p>{run.reply}</p></section>}
      <div className="trace-event-list">{run.records.map((record, index) => <EventCard record={record} key={`${record.timestamp}-${record.type}-${index}`} />)}</div>
    </div>
  </details>;
}

function EventCard({ record }: { record: TraceRecord }) {
  const correlation = Object.fromEntries(Object.entries(record).filter(([key]) => ["sequence", "iteration", "modelCallId", "toolCallId"].includes(key)));
  const payload = record.payload
    ? { ...correlation, ...record.payload }
    : Object.fromEntries(Object.entries(record).filter(([key]) => !["version", "eventId", "type", "timestamp", "runId", "sessionId", "userMessage", "reply"].includes(key)));
  const hasPayload = Object.keys(payload).length > 0;
  const isTool = record.type.startsWith("tool_");
  const isError = record.type.endsWith("_error") || record.type.endsWith("_failed") || record.type === "trace_read_error";
  return <article className={`trace-event ${isError ? "error" : ""}`}>
    <div className="trace-event-icon">{isError ? <AlertCircle size={12} /> : isTool ? <Wrench size={12} /> : <Activity size={12} />}</div>
    <div className="trace-event-main">
      <div className="trace-event-title"><strong>{eventLabel(record.type)}</strong><time>{formatTime(record.timestamp, true)}</time></div>
      {hasPayload && <pre>{JSON.stringify(payload, null, 2)}</pre>}
    </div>
  </article>;
}

function runLabel(run: TraceRunGroup): string {
  if (run.records.some((record) => record.type.startsWith("consolidation_"))) return "长期记忆整理";
  if (run.records.some((record) => record.type === "trace_read_error")) return "运行记录读取错误";
  return "未命名回合";
}

function statusLabel(status: TraceRunGroup["status"]): string {
  return status === "completed" ? "已完成" : status === "error" ? "失败" : "未完成";
}

function eventLabel(type: string): string {
  return ({
    run_started: "回合开始", context_assembled: "上下文组装完成", gate_start: "检索判断开始",
    gate_end: "检索判断完成", retrieval: "长期记忆检索", model_request: "模型请求",
    model_response: "模型响应", model_failed: "模型调用失败", tool_started: "工具调用开始",
    tool_completed: "工具调用完成", tool_failed: "工具调用失败", run_completed: "回合完成", run_failed: "回合失败", consolidation_start: "记忆整理开始",
    consolidation_end: "记忆整理完成", consolidation_error: "记忆整理失败",
    stream_fallback: "流式请求降级", trace_read_error: "记录读取错误",
  } as Record<string, string>)[type] ?? type;
}

function formatTime(value: string, timeOnly = false): string {
  if (!value) return "时间未知";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", timeOnly
    ? { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }
    : { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
    .format(date);
}

function formatDuration(ms: number): string {
  return ms < 1_000 ? `${ms}ms` : `${(ms / 1_000).toFixed(1)}s`;
}
