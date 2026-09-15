import { ChevronRight, FileJson, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { loadTraces, loadTraceRun, type TraceFile, type TraceDashboard } from "../../agent-api";
import { MINIMUM_FEEDBACK_DURATION_MS, withMinimumDuration } from "../../lib/minimum-duration";
import { Button } from "../../components/ui/button";
import { PageHeading } from "../../components/PageHeading";
import { SaveMessage } from "../../components/SaveMessage";

const EMPTY_DASHBOARD: TraceDashboard = { runs: [], nextCursor: null };

/** 按 JSONL 文件原样列出 Trace，不在页面中推导 Session 或回合结构。 */
export function TracePage() {
  const [dashboard, setDashboard] = useState<TraceDashboard>(EMPTY_DASHBOARD);
  const [files, setFiles] = useState<TraceFile[]>([]);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const requestNumber = useRef(0);
  const [error, setError] = useState("");
  const [saveMessage, setSaveMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const reload = async (minimumDurationMs = 0, cursor?: string) => {
    requestNumber.current++;
    setError("");
    setLoading(true);
    try {
      setDashboard(await withMinimumDuration(() => loadTraces(cursor), minimumDurationMs));
      setFiles([]);
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
      setCursors([undefined]);
      if (await reload(MINIMUM_FEEDBACK_DURATION_MS)) setSaveMessage("已刷新");
    } finally {
      setRefreshing(false);
    }
  }

  return <div className="content-wrap trace-page">
    <PageHeading eyebrow="JSONL traces" title="Traces" description="按文件查看已脱敏的 JSONL 事件。" descriptionActions={<Button size="sm" loading={refreshing} onClick={() => void refresh()}><RefreshCw size={14} /> 刷新数据</Button>} />
    <SaveMessage message={saveMessage} setMessage={setSaveMessage} />
    {error && <div className="error-message" role="alert">{error}</div>}
    {!error && dashboard.runs.length === 0 && <div className="panel trace-empty">No traces yet.</div>}
    <div className="flex flex-wrap gap-2 my-4">
      <Button disabled={loading || cursors.length < 2} onClick={() => { const next = cursors.slice(0, -1); setCursors(next); void reload(0, next.at(-1)); }}>上一页</Button>
      <span>第 {cursors.length} 页</span>
      <Button disabled={loading || !dashboard.nextCursor} onClick={() => { const cursor = dashboard.nextCursor!; setCursors([...cursors, cursor]); void reload(0, cursor); }}>下一页</Button>
    </div>
    <div className="flex flex-col gap-2">
      {dashboard.runs.map((run) => <Button variant="outline" key={run.runId} onClick={() => {
        const current = ++requestNumber.current;
        void loadTraceRun(run.runId).then((result) => { if (current === requestNumber.current) setFiles(result.files); }).catch((value) => { if (current === requestNumber.current) setError(String(value)); });
      }}>{run.startedAt} · {run.runId} · {run.eventCount} 条 · {run.status}</Button>)}
    </div>
    <div className="trace-file-list">
      {files.map((file) => <details className="panel trace-file" open key={file.path}>
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
