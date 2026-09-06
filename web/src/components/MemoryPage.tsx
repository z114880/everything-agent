import { Database, FileText, RefreshCw, Search, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import {
  loadAgent, loadMemory, memoryAction, saveSystemPrompt,
  type MemoryDashboard, type SemanticMemory, type SessionReadResult, type SessionRecallResult, type SessionSearchResult,
} from "../agent-api";

type MemoryTab = "overview" | "semantic" | "episodic" | "procedural" | "chat" | "consolidation";
const tabs: Array<{ id: MemoryTab; label: string }> = [
  { id: "overview", label: "Overview" }, { id: "semantic", label: "Semantic" },
  { id: "episodic", label: "Session Recall" }, { id: "procedural", label: "Procedural" },
  { id: "chat", label: "Chat Log" }, { id: "consolidation", label: "Consolidation" },
];

export function MemoryPage() {
  const [tab, setTab] = useState<MemoryTab>("overview");
  const [data, setData] = useState<MemoryDashboard | null>(null);
  const [prompt, setPrompt] = useState("");
  const [query, setQuery] = useState("");
  const [semanticResults, setSemanticResults] = useState<SemanticMemory[] | null>(null);
  const [recall, setRecall] = useState<SessionSearchResult | null>(null);
  const [message, setMessage] = useState("");
  const reload = async () => setData(await loadMemory());
  useEffect(() => {
    void Promise.all([reload(), loadAgent().then((value) => setPrompt(value.systemPrompt))])
      .catch((error: unknown) => setMessage(error instanceof Error ? error.message : String(error)));
  }, []);

  async function mutate(action: Record<string, unknown>) {
    try { await memoryAction(action); await reload(); setMessage("已保存"); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  }
  async function search() {
    try {
      if (tab === "semantic") setSemanticResults(query.trim() ? await memoryAction({ action: "search_semantic", query }) : null);
      if (tab === "episodic") setRecall(await memoryAction<SessionSearchResult>(
        query.trim() ? { action: "session_search", query } : { action: "session_search", recent: true },
      ));
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  }
  async function read(result: SessionRecallResult, fromStart = false) {
    try {
      const value = await memoryAction<SessionReadResult>(fromStart || !result.nextCursor
        ? { action: "session_read", sessionId: result.session.id }
        : { action: "session_read", cursor: result.nextCursor });
      setRecall((current) => current ? {
        ...current,
        sessions: current.sessions.map((item) => item.session.id === result.session.id
          ? {
            ...item,
            ...value,
            ...(value.expandLimitReached ? {
              entries: item.entries,
              returnedMessageCount: item.returnedMessageCount,
              returnedRanges: item.returnedRanges,
            } : {}),
            rank: item.rank,
            retrievalSignals: item.retrievalSignals,
            match: item.match,
            indexedMessageCount: item.indexedMessageCount,
          }
          : item),
      } : current);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  }

  if (!data) return <div className="content-wrap"><div className="panel loading-panel">正在加载 Memory… {message}</div></div>;
  const semantic = semanticResults ?? data.semantic;
  return <div className="content-wrap memory-page">
    <div className="memory-header"><div><div className="eyebrow">SQLite / Lexical + Dense</div><h1>Memory</h1><p>Semantic Memory、Session Recall、会话日志与整理状态。</p></div><button className="ghost-action" onClick={() => void reload()}><RefreshCw size={14} /> 刷新</button></div>
    <div className="memory-tabs">{tabs.map((item) => <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}>{item.label}</button>)}</div>
    {message && <div className="memory-message">{message}</div>}
    {tab === "overview" && <div className="metric-grid">
      <Metric label="Semantic" value={data.overview.semanticCount} />
      <Metric label="已索引 Session" value={data.overview.indexedSessionCount} />
      <Metric label="已索引消息" value={data.overview.indexedMessageCount} />
      <Metric label="Sessions" value={data.overview.sessionCount} />
      <Metric label="整理次数" value={data.consolidations.length} />
      <div className="panel path-card"><Database size={18} /><div><strong>Database</strong><code>{data.overview.databasePath}</code></div></div>
    </div>}
    {(tab === "semantic" || tab === "episodic") && <div className="memory-search"><Search size={14} /><input value={query} onChange={(event) => { setQuery(event.target.value); if (!event.target.value) setSemanticResults(null); }} onKeyDown={(event) => { if (event.key === "Enter") void search(); }} placeholder={tab === "episodic" ? "留空返回最近 Session，或按当前模式检索" : "按当前检索模式搜索"} /><button className="ghost-action" onClick={() => void search()}>{tab === "episodic" && !query.trim() ? "最近 Session" : "搜索"}</button>{tab === "semantic" && <button className="primary-action" onClick={() => createSemantic(mutate)}>新建</button>}</div>}
    {tab === "semantic" && <div className="memory-list">{semantic.map((item) => <SemanticCard key={item.id} item={item} mutate={mutate} />)}</div>}
    {tab === "episodic" && <div className="memory-list">
      {!recall && <div className="panel loading-panel">输入查询验证真实 Session Recall；留空可查看最近活跃 Session。</div>}
      {recall && <div className="memory-message">{recall.retrievalMode} · 返回 {recall.returnedSessionCount}/{recall.requestedLimit} 个 Session{recall.truncated ? " · 截断或省略 " + recall.droppedSessionCount + " 个" : ""}</div>}
      {recall?.sessions.map((result) => <RecallCard key={result.session.id} result={result} read={read} />)}
    </div>}
    {tab === "procedural" && <section className="panel procedural-editor"><div className="panel-header"><span><FileText size={15} /> System Prompt</span><code>.everything/EVERYTHING.md</code></div><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} /><button className="primary-action" onClick={() => void saveSystemPrompt(prompt).then(() => setMessage("EVERYTHING.md 已保存"))}>保存 Procedural Memory</button></section>}
    {tab === "chat" && <div className="panel table-scroll"><table><thead><tr><th>ID</th><th>Task ID</th><th>Run ID</th><th>Role / Kind</th><th>内容</th><th>时间</th></tr></thead><tbody>{data.chatLog.map((item) => <tr key={item.id}><td>{item.id}</td><td><code>{short(item.runId)}</code></td><td><code>{short(item.runId)}</code></td><td>{item.role}<br /><small>{item.kind}</small></td><td><pre>{contentText(item.content)}</pre></td><td>{local(item.createdAt)}</td></tr>)}</tbody></table></div>}
    {tab === "consolidation" && <div className="panel table-scroll"><table><thead><tr><th>Status</th><th>Task ID</th><th>Trigger</th><th>批次 / 未解决冲突</th><th>Facts</th><th>时间</th></tr></thead><tbody>{data.consolidations.map((item) => <tr key={item.id}><td><span className={"status-pill " + item.status}>{item.status}</span>{item.errorType && <small>{item.errorType}</small>}</td><td><code>{short(item.runId)}</code></td><td>{item.trigger}</td><td>{item.completedBatches} / {item.totalBatches} · 冲突 {item.unresolvedConflicts}</td><td>新增 {item.factsCreated} / 更新 {item.factsUpdated} / 删除 {item.factsDeleted} / 合并 {item.factsMerged} / 跳过 {item.factsSkipped}</td><td>{local(item.startedAt)}</td></tr>)}</tbody></table></div>}
  </div>;
}

function RecallCard({ result, read }: { result: SessionRecallResult; read(result: SessionRecallResult, fromStart?: boolean): Promise<void> }) {
  return <article className="panel memory-card"><div>
    <span className="memory-id">#{result.rank} · {retrievalScoreLabel(result)}</span>
    <strong>{result.session.title}</strong>
    <small>{local(result.session.updatedAt)} · 返回 {result.returnedMessageCount}/{result.totalMessageCount} · {result.isComplete ? "完整 Session" : "部分范围"}</small>
    {result.expandLimitReached && <small>完整扩窗已达到预算，请从头分页读取。</small>}
    <pre>{result.entries.map((entry) => "[" + entry.id + " · " + entry.kind + " · " + (entry.runComplete ? "完整" : "未完成") + "] " + contentText(entry.content)).join("\\n\\n")}</pre>
  </div><div>
    {result.nextCursor && !result.isComplete && <button onClick={() => void read(result)}>扩大 / 继续</button>}
    {!result.isComplete && <button onClick={() => void read(result, true)}>从头读取</button>}
  </div></article>;
}
function retrievalScoreLabel(result: SessionRecallResult): string {
  const signals = result.retrievalSignals;
  if (signals.mmr !== undefined) return `MMR ${signals.mmr.toFixed(3)}`;
  if (signals.fused !== undefined) return `RRF ${signals.fused.toFixed(3)}`;
  if (signals.dense !== undefined) return `Dense ${signals.dense.toFixed(3)}`;
  if (signals.bm25 !== undefined) return `BM25 ${signals.bm25.toFixed(3)}`;
  return "recent";
}
function Metric({ label, value }: { label: string; value: number }) { return <div className="panel metric-card"><span>{label}</span><strong>{value}</strong></div> }
function SemanticCard({ item, mutate }: { item: SemanticMemory; mutate(action: Record<string, unknown>): Promise<void> }) {
  return <article className="panel memory-card"><div><span className="memory-id">Semantic #{item.id}</span><strong>{item.subject}</strong><p>{item.content}</p><small>{item.source} · 创建 {local(item.createdAt)} · 更新 {local(item.updatedAt)}</small></div><div><button onClick={() => editSemantic(item, mutate)}>编辑</button><button className="danger" onClick={() => window.confirm("确认彻底删除这条记忆？") && void mutate({ action: "delete_semantic", id: item.id })}><Trash2 size={13} /></button></div></article>;
}
function createSemantic(mutate: (action: Record<string, unknown>) => Promise<void>) {
  const subject = window.prompt("Subject"); if (!subject) return; const content = window.prompt("记忆内容");
  if (content) void mutate({ action: "create_semantic", subject, content });
}
function editSemantic(item: SemanticMemory, mutate: (action: Record<string, unknown>) => Promise<void>) {
  const subject = window.prompt("Subject", item.subject); if (!subject) return; const content = window.prompt("记忆内容", item.content);
  if (content) void mutate({ action: "update_semantic", id: item.id, subject, content });
}
function contentText(value: unknown) { return typeof value === "string" ? value : JSON.stringify(value, null, 2) }
function short(value: string) { return value.slice(0, 8) }
function local(value: string) { return new Date(value).toLocaleString(undefined, { hour12: false }) }
