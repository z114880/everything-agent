import { ChevronRight, FileJson, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { loadTraces, type TraceDashboard } from "../../agent-api";
import { MINIMUM_FEEDBACK_DURATION_MS, withMinimumDuration } from "../../lib/minimum-duration";
import { Button } from "../../components/ui/button";
import { PageHeading } from "../../components/PageHeading";
import { SaveMessage } from "../../components/SaveMessage";

const EMPTY_DASHBOARD: TraceDashboard = { files: [] };

/** 按 JSONL 文件原样列出 Trace，不在页面中推导 Session 或回合结构。 */
export function TracePage() {
  const [dashboard, setDashboard] = useState<TraceDashboard>(EMPTY_DASHBOARD);
  const [error, setError] = useState("");
  const [saveMessage, setSaveMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const reload = async (minimumDurationMs = 0) => {
    setError("");
    setLoading(true);
    try {
      setDashboard(await withMinimumDuration(loadTraces, minimumDurationMs));
      return true;
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      return false;
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void reload(); }, []);

  async function refresh() {
    if (loading) return;
    setSaveMessage("");
    setRefreshing(true);
    try {
      if (await reload(MINIMUM_FEEDBACK_DURATION_MS)) setSaveMessage("已刷新");
    } finally {
      setRefreshing(false);
    }
  }

  return <div className="content-wrap trace-page">
    <PageHeading eyebrow="JSONL traces" title="Traces" description="按文件查看已脱敏的 JSONL 事件。" descriptionActions={<Button size="sm" loading={refreshing} onClick={() => void refresh()}><RefreshCw size={14} /> 刷新数据</Button>} />
    <SaveMessage message={saveMessage} setMessage={setSaveMessage} />
    {error && <div className="error-message" role="alert">{error}</div>}
    {!error && dashboard.files.length === 0 && <div className="panel trace-empty">No traces yet.</div>}
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
