import { RUNTIME_SYSTEM_PROMPT } from "../../../../src/agent-runtime/system-prompt.ts";
import { Database, FileText, RefreshCw, Search, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import {
  loadAgent, loadMemory, memoryAction, saveSystemPrompt,
  type MemoryDashboard, type SemanticMemory, type SessionReadResult, type SessionRecallResult, type SessionSearchResult,
} from "../../agent-api";
import { MINIMUM_FEEDBACK_DURATION_MS, withMinimumDuration } from "../../lib/minimum-duration";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { MemoryContent } from "./MemoryContent";
import { PageHeading } from "../../components/PageHeading";
import { SaveMessage } from "../../components/SaveMessage";
import { Textarea } from "../../components/ui/textarea";

type MemoryTab = "overview" | "semantic" | "episodic" | "procedural" | "chat" | "consolidation" | "system_prompt";
const tabs: Array<{ id: MemoryTab; label: string }> = [
  { id: "overview", label: "Overview" }, { id: "semantic", label: "Semantic" },
  { id: "episodic", label: "Session Recall" }, { id: "procedural", label: "Procedural" },
  { id: "chat", label: "Chat Log" }, { id: "consolidation", label: "Consolidation" },
  { id: "system_prompt", label: "System Prompt" },
];

export function MemoryPage() {
  const [tab, setTab] = useState<MemoryTab>("overview");
  const [data, setData] = useState<MemoryDashboard | null>(null);
  const [prompt, setPrompt] = useState("");
  const [query, setQuery] = useState("");
  const [semanticResults, setSemanticResults] = useState<SemanticMemory[] | null>(null);
  const [recall, setRecall] = useState<SessionSearchResult | null>(null);
  const [saveMessage, setSaveMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const reload = async (minimumDurationMs = 0) => {
    setError("");
    setLoading(true);
    try {
      setData(await withMinimumDuration(loadMemory, minimumDurationMs));
      return true;
    } catch (reason) {
      setError(errorMessage(reason));
      return false;
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void reload();
    void loadAgent().then((value) => setPrompt(value.systemPrompt)).catch((reason: unknown) => setError(errorMessage(reason)));
  }, []);

  async function refresh() {
    setSaveMessage("");
    if (await reload(MINIMUM_FEEDBACK_DURATION_MS)) setSaveMessage("已刷新");
  }

  async function mutate(action: Record<string, unknown>) {
    setSaveMessage("");
    setError("");
    try {
      await memoryAction(action);
      if (await reload()) setSaveMessage("已保存");
    } catch (reason) { setError(errorMessage(reason)); }
  }
  async function search() {
    setError("");
    try {
      if (tab === "semantic") setSemanticResults(query.trim() ? await memoryAction({ action: "search_semantic", query }) : null);
      if (tab === "episodic") setRecall(await memoryAction<SessionSearchResult>(
        query.trim() ? { action: "session_search", query } : { action: "session_search", recent: true },
      ));
    } catch (reason) { setError(errorMessage(reason)); }
  }
  async function read(result: SessionRecallResult, fromStart = false) {
    setError("");
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
            rank: item.rank,
            retrievalSignals: item.retrievalSignals,
            match: item.match,
            indexedMessageCount: item.indexedMessageCount,
          }
          : item),
      } : current);
    } catch (reason) { setError(errorMessage(reason)); }
  }

  async function persistSystemPrompt() {
    setSaveMessage("");
    setError("");
    try {
      await saveSystemPrompt(prompt);
      setSaveMessage("EVERYTHING.md 已保存");
    } catch (reason) { setError(errorMessage(reason)); }
  }

  if (!data) return <div className="content-wrap"><div className="panel loading-panel">正在加载 Memory… {error}</div></div>;
  const semantic = semanticResults ?? data.semantic;
  return <div className="content-wrap memory-page">
    <PageHeading eyebrow="SQLite / Lexical + Dense" title="Memory" description="Semantic Memory、Session Recall、会话日志与整理状态。" descriptionActions={<Button size="sm" className="memory-refresh" loading={loading} onClick={() => void refresh()}><RefreshCw size={14} /> 刷新数据</Button>} />
    <SaveMessage message={saveMessage} setMessage={setSaveMessage} />
    {error && <div className="error-message" role="alert">{error}</div>}
    <div className="memory-tabs">{tabs.map((item) => <Button variant="ghost" size="sm" key={item.id} className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}>{item.label}</Button>)}</div>
    {tab === "overview" && <div className="metric-grid">
      <Metric label="Semantic" value={data.overview.semanticCount} />
      <Metric label="已索引 Session" value={data.overview.indexedSessionCount} />
      <Metric label="已索引消息" value={data.overview.indexedMessageCount} />
      <Metric label="Sessions" value={data.overview.sessionCount} />
      <Metric label="整理次数" value={data.consolidations.length} />
      <Card className="path-card"><Database size={18} /><div><strong>Database</strong><code>{data.overview.databasePath}</code></div></Card>
    </div>}
    {(tab === "semantic" || tab === "episodic") && <div className="memory-search"><div className="memory-search-field"><Search size={15} aria-hidden="true" /><Input value={query} onChange={(event) => { setQuery(event.target.value); if (!event.target.value) setSemanticResults(null); }} onKeyDown={(event) => { if (event.key === "Enter") void search(); }} placeholder={tab === "episodic" ? "留空返回最近 Session，或按当前模式检索" : "按当前检索模式搜索"} /></div><Button onClick={() => void search()}>{tab === "episodic" && !query.trim() ? "最近 Session" : "搜索"}</Button>{tab === "semantic" && <Button onClick={() => createSemantic(mutate)}>新建</Button>}</div>}
    {tab === "semantic" && <div className="memory-list">
      <div className="recall-hint recall-hint-compact"><div className="recall-hint-heading"><strong>搜索语义记忆</strong><p>输入关键词查找相关记忆，或留空查看记忆列表。</p></div></div>
      {semantic.map((item) => <SemanticCard key={item.id} item={item} mutate={mutate} />)}
    </div>}
    {tab === "episodic" && <div className="memory-list">
      <div className="recall-hint recall-hint-compact">
        <div className="recall-hint-heading"><strong>搜索历史会话</strong><p>输入关键词查找相关内容，或留空查看最近活跃的会话。</p></div>
        {recall && <div className="recall-hint-stats">
          <span className="recall-stat">查询上限 {recall.requestedLimit} 个会话</span>
          <span className="recall-stat">已返回 {recall.returnedSessionCount} 个</span>
          {recall.truncated && <span>部分结果已截断或省略（省略 {recall.droppedSessionCount} 个会话）。</span>}
        </div>}
      </div>
      {recall?.sessions.map((result) => <RecallCard key={result.session.id} result={result} read={read} />)}
    </div>}
    {tab === "procedural" && <Card className="procedural-editor"><div className="panel-header"><span><FileText size={15} /> System Prompt</span><code>.everything/EVERYTHING.md</code></div><Textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} /><Button onClick={() => void persistSystemPrompt()}>保存 Procedural Memory</Button></Card>}
    {tab === "system_prompt" && <Card className="procedural-editor"><div className="panel-header"><span><FileText size={15} /> System Prompt · 只读</span><code>src/agent-runtime/system-prompt.ts</code></div><Textarea aria-label="系统提示词（只读）" value={RUNTIME_SYSTEM_PROMPT} readOnly /></Card>}
    {tab === "chat" && (<div className="panel table-scroll"><table><thead><tr><th>ID</th><th>Session ID</th><th>Run ID</th><th>Role</th><th>Kind</th><th>内容</th><th>时间</th></tr></thead><tbody>{data.chatLog.map((item) => (<tr key={item.id}><td>{item.id}</td><td><code>{short(item.sessionId)}</code></td><td><code>{short(item.runId)}</code></td><td>{item.role}</td><td>{item.kind}</td><td><pre>{contentText(item.content)}</pre></td><td>{local(item.createdAt)}</td></tr>))}</tbody></table></div>)}
    {tab === "consolidation" && <div className="panel table-scroll"><table><thead><tr><th>Status</th><th>Run ID</th><th>Trigger</th><th>批次 / 未解决冲突</th><th>Facts</th><th>时间</th></tr></thead><tbody>{data.consolidations.map((item) => <tr key={item.id}><td><Badge variant={item.status === "completed" ? "success" : item.status === "failed" ? "destructive" : "outline"}>{item.status}</Badge>{item.errorType && <small>{item.errorType}</small>}</td><td><code>{short(item.runId)}</code></td><td>{item.trigger}</td><td>{item.completedBatches} / {item.totalBatches} · 冲突 {item.unresolvedConflicts}</td><td>新增 {item.factsCreated} / 更新 {item.factsUpdated} / 删除 {item.factsDeleted} / 合并 {item.factsMerged} / 跳过 {item.factsSkipped}</td><td>{local(item.startedAt)}</td></tr>)}</tbody></table></div>}
  </div>;
}

function RecallCard({ result, read }: { result: SessionRecallResult; read(result: SessionRecallResult, fromStart?: boolean): Promise<void> }) {
  return <article className="panel memory-card recall-card"><div>
    <span className="memory-id">#{result.rank} · {retrievalScoreLabel(result)}</span>
    <strong>{result.session.title}</strong>
    <small>{local(result.session.updatedAt)} · 返回 {result.returnedMessageCount}/{result.totalMessageCount} · {result.isComplete ? "完整 Session" : "部分范围"}</small>
    <div className="recall-entries">{result.entries.map((entry) => <section className="recall-entry" key={entry.id}>
      <span className="memory-id recall-entry-number">{entry.id}</span>
      <div className="recall-entry-body">
        <div className="memory-id">{entry.kind}</div>
        <MemoryContent value={entry.content} />
      </div>
    </section>)}</div>
  </div><div>
      {result.nextCursor && <Button size="sm" onClick={() => void read(result)}>继续读取</Button>}
      {!result.isComplete && <Button size="sm" onClick={() => void read(result, true)}>从头读取</Button>}
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
function Metric({ label, value }: { label: string; value: number }) { return <Card className="metric-card"><span>{label}</span><strong>{value}</strong></Card> }
function SemanticCard({ item, mutate }: { item: SemanticMemory; mutate(action: Record<string, unknown>): Promise<void> }) {
  return <article className="panel memory-card"><div><span className="memory-id">Semantic #{item.id}</span><strong>{item.subject}</strong><p>{item.content}</p><small>{item.source} · 创建 {local(item.createdAt)} · 更新 {local(item.updatedAt)}</small></div><div><Button size="sm" onClick={() => editSemantic(item, mutate)}>编辑</Button><Button variant="destructive" size="icon-sm" aria-label="删除记忆" onClick={() => window.confirm("确认彻底删除这条记忆？") && void mutate({ action: "delete_semantic", id: item.id })}><Trash2 size={13} /></Button></div></article>;
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
function errorMessage(value: unknown) { return value instanceof Error ? value.message : String(value) }
