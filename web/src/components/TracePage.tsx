import { Activity, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { loadTraces, type TraceRecord } from "../agent-api";

export function TracePage() {
  const [records, setRecords] = useState<TraceRecord[]>([]);
  const [error, setError] = useState("");
  const reload = () => loadTraces().then((value) => setRecords(value.records)).catch((value: unknown) => setError(value instanceof Error ? value.message : String(value)));
  useEffect(() => { void reload(); }, []);
  return <div className="content-wrap trace-page"><div className="memory-header"><div><div className="eyebrow">Classic Loop / 持久化可观测性</div><h1>运行记录</h1><p>只读查看 `.everything/traces` 中的结构化事件。</p></div><button className="ghost-action" onClick={reload}><RefreshCw size={14} /> 刷新</button></div>{error && <div className="error-message">{error}</div>}<div className="trace-list">{records.slice().reverse().map((record, index) => <article className="panel trace-card" key={`${record.timestamp}-${record.runId}-${index}`}><div className="trace-dot"><Activity size={13} /></div><div><div className="trace-title"><strong>{record.type}</strong><time>{record.timestamp}</time></div><div className="trace-identifiers"><code>run {record.runId.slice(0, 8)}</code>{record.sessionId && <code>session {record.sessionId.slice(0, 8)}</code>}</div><pre>{JSON.stringify(Object.fromEntries(Object.entries(record).filter(([key]) => !["version", "type", "timestamp", "runId", "sessionId"].includes(key))), null, 2)}</pre></div></article>)}</div></div>;
}
