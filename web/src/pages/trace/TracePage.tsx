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
    const current = ++requestNumber.current;
    setError("");
    setLoading(true);
    try {
      const result = await withMinimumDuration(async () => {
        const page = await loadTraces(cursor);
        const details = await Promise.all(page.runs.map((run) => loadTraceRun(run.runId)));
        // 关联后台任务可能出现在多个运行详情中，同一文件中的事件只展示一次。
        const grouped = new Map<string, Map<string, TraceFile["records"][number]>>();
        for (const detail of details) for (const file of detail.files) {
          const records = grouped.get(file.path) ?? new Map();
          for (const record of file.records) records.set(record.eventId ?? JSON.stringify(record), record);
          grouped.set(file.path, records);
        }
        const pageFiles = [...grouped].sort(([a], [b]) => {
          const [leftDate, leftName = ""] = a.split("/");
          const [rightDate, rightName = ""] = b.split("/");
          const sequence = (name: string) => Number(/^(\d+)-/.exec(name)?.[1] ?? Number.MAX_SAFE_INTEGER);
          return rightDate!.localeCompare(leftDate!) || sequence(rightName) - sequence(leftName) || b.localeCompare(a);
        }).map(([path, records]) => ({
          path,
          records: [...records.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || (a.sequence ?? 0) - (b.sequence ?? 0)),
        }));
        return { page, files: pageFiles };
      }, minimumDurationMs);
      if (current !== requestNumber.current) return false;
      setDashboard(result.page);
      setFiles(result.files);
      setCursors((previous) => cursor === undefined ? [undefined] : previous);
      return true;
    } catch (value) {
      if (current === requestNumber.current) setError(value instanceof Error ? value.message : String(value));
      return false;
    } finally {
      if (current === requestNumber.current) setLoading(false);
    }
  };
  useEffect(() => { void reload(); return () => { requestNumber.current++; }; }, []);

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
    {!loading && !error && dashboard.runs.length === 0 && <div className="panel trace-empty">No traces yet.</div>}
    <div className="flex flex-wrap gap-2 my-4">
      <Button disabled={loading || cursors.length < 2} onClick={() => { const next = cursors.slice(0, -1); void reload(0, next.at(-1)).then((success) => { if (success) setCursors(next); }); }}>上一页</Button>
      <span>第 {cursors.length} 页</span>
      <Button disabled={loading || !dashboard.nextCursor} onClick={() => { const cursor = dashboard.nextCursor!; void reload(0, cursor).then((success) => { if (success) setCursors([...cursors, cursor]); }); }}>下一页</Button>
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
