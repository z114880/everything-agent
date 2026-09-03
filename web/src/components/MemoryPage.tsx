import { Database, FileText, RefreshCw, Search, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { loadAgent, loadMemory, memoryAction, saveSystemPrompt, type EpisodicMemory, type MemoryDashboard, type SemanticMemory } from "../agent-api";

type MemoryTab = "overview" | "semantic" | "episodic" | "procedural" | "chat" | "consolidation";
const tabs: Array<{ id: MemoryTab; label: string }> = [
  { id: "overview", label: "Overview" }, { id: "semantic", label: "Semantic" }, { id: "episodic", label: "Episodic" },
  { id: "procedural", label: "Procedural" }, { id: "chat", label: "Chat Log" }, { id: "consolidation", label: "Consolidation" },
];

export function MemoryPage() {
  const [tab, setTab] = useState<MemoryTab>("overview");
  const [data, setData] = useState<MemoryDashboard | null>(null);
  const [prompt, setPrompt] = useState("");
  const [query, setQuery] = useState("");
  const [semanticResults, setSemanticResults] = useState<SemanticMemory[] | null>(null);
  const [episodicResults, setEpisodicResults] = useState<EpisodicMemory[] | null>(null);
  const [message, setMessage] = useState("");
  const reload = async () => setData(await loadMemory());
  useEffect(() => { void Promise.all([reload(), loadAgent().then((value) => setPrompt(value.systemPrompt))]).catch((error: unknown) => setMessage(error instanceof Error ? error.message : String(error))); }, []);

  async function mutate(action: Record<string, unknown>) {
    try { await memoryAction(action); await reload(); setMessage("已保存"); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  }

  async function search() {
    if (!query.trim()) { setSemanticResults(null); setEpisodicResults(null); return; }
    if (tab === "semantic") setSemanticResults(await memoryAction<SemanticMemory[]>({ action: "search_semantic", query }));
    if (tab === "episodic") setEpisodicResults(await memoryAction<EpisodicMemory[]>({ action: "search_episodic", query }));
  }

  if (!data) return <div className="content-wrap"><div className="panel loading-panel">正在加载 Memory… {message}</div></div>;
  const semantic = semanticResults ?? data.semantic;
  const episodic = episodicResults ?? data.episodic;
  return <div className="content-wrap memory-page"><div className="memory-header"><div><div className="eyebrow">本地 SQLite / FTS5 + BM25</div><h1>Memory</h1><p>长期记忆、会话日志与自动整理状态。</p></div><button className="ghost-action" onClick={() => void reload()}><RefreshCw size={14} /> 刷新</button></div>
    <div className="memory-tabs">{tabs.map((item) => <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}>{item.label}</button>)}</div>
    {message && <div className="memory-message">{message}</div>}
    {tab === "overview" && <div className="metric-grid"><Metric label="Semantic" value={data.overview.semanticCount} /><Metric label="Episodic" value={data.overview.episodicCount} /><Metric label="Sessions" value={data.overview.sessionCount} /><Metric label="待整理 Session" value={data.overview.pendingSessionCount} /><div className="panel path-card"><Database size={18} /><div><strong>Database</strong><code>{data.overview.databasePath}</code></div></div></div>}
    {(tab === "semantic" || tab === "episodic") && <div className="memory-search"><Search size={14} /><input value={query} onChange={(event) => { setQuery(event.target.value); if (!event.target.value) { setSemanticResults(null); setEpisodicResults(null); } }} onKeyDown={(event) => { if (event.key === "Enter") void search(); }} placeholder="使用 FTS5 + BM25 搜索" /><button className="ghost-action" onClick={() => void search()}>搜索</button><button className="primary-action" onClick={() => tab === "semantic" ? createSemantic(mutate) : createEpisodic(mutate)}>新建</button></div>}
    {tab === "semantic" && <div className="memory-list">{semantic.map((item) => <SemanticCard key={item.id} item={item} mutate={mutate} />)}</div>}
    {tab === "episodic" && <div className="memory-list">{episodic.map((item) => <EpisodicCard key={item.id} item={item} mutate={mutate} />)}</div>}
    {tab === "procedural" && <section className="panel procedural-editor"><div className="panel-header"><span><FileText size={15} /> System Prompt</span><code>.everything/EVERYTHING.md</code></div><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} /><button className="primary-action" onClick={() => void saveSystemPrompt(prompt).then(() => setMessage("EVERYTHING.md 已保存"))}>保存 Procedural Memory</button></section>}
    {tab === "chat" && <div className="panel table-scroll"><table><thead><tr><th>ID</th><th>Session ID</th><th>Run ID</th><th>Role / Kind</th><th>内容</th><th>时间</th></tr></thead><tbody>{data.chatLog.map((item) => <tr key={item.id}><td>{item.id}</td><td><code>{short(item.sessionId)}</code></td><td><code>{short(item.runId)}</code></td><td>{item.role}<br /><small>{item.kind}</small></td><td><pre>{typeof item.content === "string" ? item.content : JSON.stringify(item.content, null, 2)}</pre></td><td>{local(item.createdAt)}</td></tr>)}</tbody></table></div>}
    {tab === "consolidation" && <div className="panel table-scroll"><table><thead><tr><th>Status</th><th>Session ID</th><th>Trigger</th><th>High Watermark</th><th>Facts</th><th>Episode</th><th>时间</th></tr></thead><tbody>{data.consolidations.map((item) => <tr key={item.id}><td><span className={`status-pill ${item.status}`}>{item.status}</span>{item.errorType && <small>{item.errorType}</small>}</td><td><code>{short(item.sessionId)}</code></td><td>{item.trigger}</td><td>{item.throughMessageId}</td><td>+{item.factsCreated} / ~{item.factsUpdated} / ={item.factsSkipped}</td><td>{item.episodeChanged ? "已更新" : "无变化"}</td><td>{local(item.startedAt)}</td></tr>)}</tbody></table></div>}
  </div>;
}

function Metric({ label, value }: { label: string; value: number }) { return <div className="panel metric-card"><span>{label}</span><strong>{value}</strong></div>; }
function SemanticCard({ item, mutate }: { item: SemanticMemory; mutate(action: Record<string, unknown>): Promise<void> }) { return <article className="panel memory-card"><div><span className="memory-id">Semantic #{item.id}</span><strong>{item.subject}</strong><p>{item.content}</p><small>{item.source} · 创建 {local(item.createdAt)} · 更新 {local(item.updatedAt)}</small></div><div><button onClick={() => editSemantic(item, mutate)}>编辑</button><button className="danger" onClick={() => window.confirm("确认彻底删除这条记忆？") && void mutate({ action: "delete_semantic", id: item.id })}><Trash2 size={13} /></button></div></article>; }
function EpisodicCard({ item, mutate }: { item: EpisodicMemory; mutate(action: Record<string, unknown>): Promise<void> }) { return <article className="panel memory-card"><div><span className="memory-id">Episodic #{item.id}</span><strong>{local(item.happenedAt)}</strong><p>{item.summary}</p><small>{item.source} · 更新 {local(item.updatedAt)}</small></div><div><button onClick={() => editEpisodic(item, mutate)}>编辑</button><button className="danger" onClick={() => window.confirm("确认彻底删除这条记忆？") && void mutate({ action: "delete_episodic", id: item.id })}><Trash2 size={13} /></button></div></article>; }

function createSemantic(mutate: (action: Record<string, unknown>) => Promise<void>) { const subject = window.prompt("Subject"); if (!subject) return; const content = window.prompt("记忆内容"); if (content) void mutate({ action: "create_semantic", subject, content }); }
function editSemantic(item: SemanticMemory, mutate: (action: Record<string, unknown>) => Promise<void>) { const subject = window.prompt("Subject", item.subject); if (!subject) return; const content = window.prompt("记忆内容", item.content); if (content) void mutate({ action: "update_semantic", id: item.id, subject, content }); }
function createEpisodic(mutate: (action: Record<string, unknown>) => Promise<void>) { const summary = window.prompt("事件摘要"); if (!summary) return; void mutate({ action: "create_episodic", summary, happenedAt: new Date().toISOString() }); }
function editEpisodic(item: EpisodicMemory, mutate: (action: Record<string, unknown>) => Promise<void>) {
  const summary = window.prompt("事件摘要", item.summary);
  if (!summary) return;
  const happenedAt = window.prompt("Event Time（ISO 8601）", item.happenedAt);
  if (happenedAt) void mutate({ action: "update_episodic", id: item.id, summary, happenedAt });
}
function short(value: string) { return value.slice(0, 8); }
function local(value: string) { return new Date(value).toLocaleString(undefined, { hour12: false }); }
