import { ChevronRight, FileJson, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { loadTraces, type TraceDashboard } from "../agent-api";

const EMPTY_DASHBOARD: TraceDashboard = { files: [] };

/** 按 JSONL 文件原样列出运行记录，不在页面中推导 Session 或回合结构。 */
export function TracePage() {
  const [dashboard, setDashboard] = useState<TraceDashboard>(EMPTY_DASHBOARD);
  const [error, setError] = useState("");
  const reload = () => {
    setError("");
    return loadTraces().then(setDashboard)
      .catch((value: unknown) => setError(value instanceof Error ? value.message : String(value)));
  };
  useEffect(() => { void reload(); }, []);

  return <div className="content-wrap trace-page">
    <div className="memory-header">
      <div>
        <div className="eyebrow">JSONL 运行记录</div>
        <h1>运行记录</h1>
        <p>按文件查看已脱敏的 JSONL 事件。</p>
      </div>
      <button className="ghost-action" onClick={() => void reload()}><RefreshCw size={14} /> 刷新</button>
    </div>
    {error && <div className="error-message">{error}</div>}
    {!error && dashboard.files.length === 0 && <div className="panel trace-empty">还没有运行记录。</div>}
    <div className="trace-file-list">
      {dashboard.files.slice().reverse().map((file) => <details className="panel trace-file" open key={file.path}>
        <summary className="trace-file-summary">
          <ChevronRight className="trace-file-chevron" size={14} />
          <FileJson size={15} />
          <strong>{file.path}</strong>
          <span>{file.records.length} 条</span>
        </summary>
        <div className="trace-record-list">
          {file.records.map((record, index) => <details className="trace-record" key={record.eventId ?? `${record.timestamp}-${index}`}>
            <summary>
              <ChevronRight className="trace-record-chevron" size={13} />
              <strong>{record.type}</strong>
              <time dateTime={record.timestamp}>{record.timestamp}</time>
              {record.sequence !== undefined && <span>#{record.sequence}</span>}
            </summary>
            <pre>{JSON.stringify(record, null, 2)}</pre>
          </details>)}
        </div>
      </details>)}
    </div>
  </div>;
}
