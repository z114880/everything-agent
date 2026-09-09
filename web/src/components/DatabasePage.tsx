import { ArrowLeft, Database, Play, RefreshCw, Table2 } from "lucide-react";
import { useEffect, useState } from "react";
import {
  databaseSqlNeedsConfirmation,
  loadDatabase,
  runDatabaseSql,
  type DatabaseDashboard,
  type DatabaseQueryResult,
  type DatabaseTable,
} from "../agent-api";
import { MINIMUM_FEEDBACK_DURATION_MS, withMinimumDuration } from "../lib/minimum-duration";
import { Button } from "./ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "./ui/alert-dialog";
import { PageHeading } from "./PageHeading";
import { SaveMessage } from "./SaveMessage";

type DatabaseTab = "overview" | "query";
const DEFAULT_SQL = "SELECT * FROM sessions ORDER BY updated_at DESC LIMIT 20";

/** 展示本地 SQLite 普通表，并提供受限的 SQL 查询与写入控制台。 */
export function DatabasePage() {
  const [dashboard, setDashboard] = useState<DatabaseDashboard | null>(null);
  const [tab, setTab] = useState<DatabaseTab>("overview");
  const [selectedTableName, setSelectedTableName] = useState<string | null>(null);
  const [sql, setSql] = useState(DEFAULT_SQL);
  const [pendingWrite, setPendingWrite] = useState<string | null>(null);
  const [queryResult, setQueryResult] = useState<DatabaseQueryResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [saveMessage, setSaveMessage] = useState("");

  const reload = async (minimumDurationMs = 0) => {
    setError("");
    setLoading(true);
    try {
      const data = await withMinimumDuration(loadDatabase, minimumDurationMs);
      setDashboard(data);
      setSelectedTableName((current) => current && data.tables.some((table) => table.name === current) ? current : null);
      return true;
    } catch (value) {
      setError(errorText(value));
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

  async function requestRun() {
    setError("");
    setSaveMessage("");
    if (databaseSqlNeedsConfirmation(sql)) {
      setPendingWrite(sql);
      return;
    }
    await execute(sql, false);
  }

  async function execute(statement: string, confirmed: boolean) {
    setRunning(true);
    setError("");
    try {
      const result = await withMinimumDuration(() =>
        runDatabaseSql(statement, confirmed),
      );
      setQueryResult(result);
      if (result.kind === "write") {
        setSaveMessage(`写入成功，影响 ${result.changes} 行${result.lastInsertRowid === null ? "" : `，新增 ID ${result.lastInsertRowid}`}`);
        await reload();
        setTab("query");
      }
    } catch (value) {
      setError(errorText(value));
    } finally {
      setRunning(false);
    }
  }

  const selectedTable = dashboard?.tables.find((table) => table.name === selectedTableName);
  return <div className="content-wrap database-page">
    <PageHeading
      eyebrow="SQLite / state.db"
      title="Database"
      description="查看所有普通持久化表，并使用受限 SQL Console 查询或修改数据。"
      descriptionActions={<Button size="sm" onClick={() => void refresh()} loading={refreshing}><RefreshCw size={14} />刷新数据</Button>}
    />
    <SaveMessage message={saveMessage} setMessage={setSaveMessage} />
    {dashboard && <div className="database-tabs" role="tablist" aria-label="数据库视图">
      <button className={tab === "overview" ? "active" : ""} onClick={() => { setTab("overview"); setSelectedTableName(null); }}>Overview</button>
      <button className={tab === "query" ? "active" : ""} onClick={() => { setTab("query"); setSelectedTableName(null); }}>SQL Console</button>
    </div>}
    {error && <div className="error-message" role="alert">{error}</div>}
    {loading && !dashboard && <div className="panel loading-panel">正在读取 Database…</div>}
    {dashboard && tab === "overview" && !selectedTable && <DatabaseOverview dashboard={dashboard} onSelect={setSelectedTableName} />}
    {tab === "overview" && selectedTable && <DatabaseTableView table={selectedTable} onBack={() => setSelectedTableName(null)} />}
    {dashboard && tab === "query" && <SqlConsole sql={sql} result={queryResult} running={running} onSql={setSql} onRun={() => void requestRun()} />}
    <AlertDialog open={pendingWrite !== null} onOpenChange={(open) => { if (!open) setPendingWrite(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>确认执行数据库写操作？</AlertDialogTitle>
          <AlertDialogDescription>这条 SQL 会直接修改 state.db。执行成功后无法在页面中自动撤销。</AlertDialogDescription>
        </AlertDialogHeader>
        <pre className="database-confirm-sql">{pendingWrite}</pre>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction onClick={() => { const statement = pendingWrite; setPendingWrite(null); if (statement) void execute(statement, true); }}>确认执行</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>;
}

function DatabaseOverview({ dashboard, onSelect }: { dashboard: DatabaseDashboard; onSelect(tab: string): void }) {
  return <>
    <div className="database-metrics">
      <div className="panel database-metric"><Database size={18} /><div><strong>{dashboard.tables.length}</strong><span>普通表</span></div></div>
      <div className="panel database-metric"><Table2 size={18} /><div><strong>{dashboard.tables.reduce((sum, table) => sum + table.count, 0).toLocaleString()}</strong><span>总行数</span></div></div>
      <div className="panel database-path"><strong>数据库文件</strong><code>{dashboard.path}</code><span>{formatBytes(dashboard.size)} · SQLite + FTS5</span></div>
    </div>
    <div className="panel database-overview-table">
      <table><thead><tr><th>表</th><th>字段数</th><th>行数</th></tr></thead><tbody>
        {dashboard.tables.map((table) => <tr key={table.name} onClick={() => onSelect(table.name)}><td><button><code>{table.name}</code></button></td><td>{table.columns.length}</td><td>{table.count.toLocaleString()}</td></tr>)}
      </tbody></table>
    </div>
  </>;
}

function DatabaseTableView({ table, onBack }: { table: DatabaseTable; onBack(): void }) {
  return <>
    <button type="button" className="database-detail-back" onClick={onBack}><ArrowLeft size={13} />返回 Overview</button>
    <div className="database-table-summary"><strong><code>{table.name}</code></strong><span>{table.count.toLocaleString()} 行 · 当前显示 {table.rows.length} 行，最新在前</span></div>
    <DataTable columns={table.columns.map((column) => column.name)} columnTypes={table.columns.map((column) => column.type)} rows={table.rows} empty="该表暂无数据" />
  </>;
}

function SqlConsole(props: { sql: string; result: DatabaseQueryResult | null; running: boolean; onSql(value: string): void; onRun(): void }) {
  const { sql, result, running, onSql, onRun } = props;
  return <div className="database-query-layout">
    <section className="panel database-query-editor">
      <div className="panel-header"><span>SQL Console</span><span>SELECT 直接执行 · INSERT / UPDATE / DELETE 需要确认</span></div>
      <textarea aria-label="SQL 查询" value={sql} spellCheck={false} onChange={(event) => onSql(event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") onRun(); }} />
      <div className="database-query-actions"><span>仅允许单条语句，最多返回 200 行；不允许 DDL。</span><Button onClick={onRun} disabled={!sql.trim()} loading={running}><Play size={14} />运行 SQL</Button></div>
    </section>
    {result?.kind === "read" && <section className="database-query-result">
      <div className="database-table-summary"><strong>查询结果</strong><span>{result.rows.length} 行{result.truncated ? " · 结果已截断" : ""}</span></div>
      <DataTable columns={result.columns} rows={result.rows} empty="查询返回 0 行" />
    </section>}
  </div>;
}

function DataTable({ columns, columnTypes, rows, empty }: { columns: string[]; columnTypes?: string[]; rows: unknown[][]; empty: string }) {
  if (rows.length === 0) return <div className="panel database-empty">{empty}</div>;
  return <div className="panel database-table-scroll"><table><thead><tr>{columns.map((column, index) => <th key={`${column}-${index}`}><code>{column}</code>{columnTypes?.[index] && <small>{columnTypes[index]!.toLowerCase()}</small>}</th>)}</tr></thead><tbody>
    {rows.map((row, rowIndex) => <tr key={rowIndex}>{columns.map((_, columnIndex) => <td key={columnIndex}><pre>{displayCell(row[columnIndex])}</pre></td>)}</tr>)}
  </tbody></table></div>;
}

function displayCell(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function errorText(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
