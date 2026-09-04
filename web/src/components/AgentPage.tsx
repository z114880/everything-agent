import { Bot, CircleStop, Clock3, MessageSquarePlus, Pencil, Send, Settings2, Trash2, Wrench } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { loadAgent, memoryAction, runAgent, type AgentBootstrap, type AgentEvent, type AgentRunResult, type ChatLogEntry, type SessionSummary } from "../agent-api";
import { shouldSubmitAgentComposer } from "../agent-composer";
import { createEdgePlayback } from "../edge-playback";
import type { VisualNodeState } from "./GraphCanvas";
import { AgentHarnessCanvas } from "./AgentHarnessCanvas";

interface AgentPageProps { onOpenConfig(): void }
interface ToolView { id: string; name: string; status: "running" | "done" | "error"; summary: string; args?: unknown; output?: unknown; ms?: number }
interface UserChatMessage { id: string; role: "user"; content: string }
interface AssistantChatMessage { id: string; role: "assistant"; content: string; pending: boolean; error?: string; tools: ToolView[]; startedAt: number; result?: AgentRunResult; streamFallback?: boolean }
type ChatMessage = UserChatMessage | AssistantChatMessage;

const idleStates: Record<string, VisualNodeState> = {
  user_prompt: "idle", client_chat_history: "idle", system_prompt: "idle", working_memory: "idle", llm: "idle", tools: "idle", reply: "idle",
};

export function AgentPage({ onOpenConfig }: AgentPageProps) {
  const [bootstrap, setBootstrap] = useState<AgentBootstrap | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [loadError, setLoadError] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [nodeStates, setNodeStates] = useState<Record<string, VisualNodeState>>(idleStates);
  const [activeEdges, setActiveEdges] = useState<Set<string>>(new Set());
  const [tick, setTick] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const chatLogRef = useRef<HTMLDivElement | null>(null);
  const edgePlaybackRef = useRef<ReturnType<typeof createEdgePlayback> | null>(null);
  edgePlaybackRef.current ??= createEdgePlayback(setActiveEdges);
  const edgePlayback = edgePlaybackRef.current;

  useEffect(() => { void initialize(); }, []);
  useEffect(() => { chatLogRef.current?.scrollTo({ top: chatLogRef.current.scrollHeight, behavior: "smooth" }); }, [messages]);
  useEffect(() => { if (!running) return; const timer = window.setInterval(() => setTick((value) => value + 1), 1_000); return () => window.clearInterval(timer); }, [running]);
  useEffect(() => () => edgePlayback.cancel(), [edgePlayback]);

  async function initialize() {
    try {
      const loaded = await loadAgent();
      setBootstrap(loaded);
      let available = loaded.sessions;
      if (available.length === 0) available = (await memoryAction<{ session: SessionSummary; sessions: SessionSummary[] }>({ action: "ensure_session" })).sessions;
      setSessions(available);
      const remembered = window.localStorage.getItem("everything.activeSessionId");
      const selected = available.find((item) => item.id === remembered)?.id ?? available[0]!.id;
      await selectSession(selected, available);
    } catch (error) { setLoadError(error instanceof Error ? error.message : String(error)); }
  }

  async function selectSession(sessionId: string, knownSessions = sessions) {
    if (running) return;
    const result = await memoryAction<{ messages: ChatLogEntry[]; sessions: SessionSummary[] }>({ action: "select_session", sessionId });
    setActiveSessionId(sessionId);
    setSessions(result.sessions.length ? result.sessions : knownSessions);
    setMessages(toChatMessages(result.messages));
    window.localStorage.setItem("everything.activeSessionId", sessionId);
  }

  async function createSession() {
    if (running) return;
    const result = await memoryAction<{ session: SessionSummary; sessions: SessionSummary[] }>({ action: "create_session", previousSessionId: activeSessionId });
    setSessions(result.sessions); setActiveSessionId(result.session.id); setMessages([]);
    window.localStorage.setItem("everything.activeSessionId", result.session.id);
  }

  async function renameActiveSession() {
    const active = sessions.find((item) => item.id === activeSessionId);
    const title = window.prompt("输入新的会话标题", active?.title ?? "");
    if (!title?.trim()) return;
    await memoryAction({ action: "rename_session", sessionId: activeSessionId, title });
    setSessions((current) => current.map((item) => item.id === activeSessionId ? { ...item, title: title.trim() } : item));
  }

  async function deleteActiveSession() {
    if (!activeSessionId || !window.confirm("确认删除整个 Session？已提炼的长期记忆不会删除。")) return;
    const result = await memoryAction<{ sessions: SessionSummary[] }>({ action: "delete_session", sessionId: activeSessionId });
    if (result.sessions.length) { setSessions(result.sessions); await selectSession(result.sessions[0]!.id, result.sessions); }
    else {
      const created = await memoryAction<{ session: SessionSummary; sessions: SessionSummary[] }>({ action: "create_session" });
      setSessions(created.sessions); setActiveSessionId(created.session.id); setMessages([]);
    }
  }

  async function send() {
    const prompt = input.trim();
    if (!prompt || running || !bootstrap || !activeSessionId) return;
    const assistantId = crypto.randomUUID();
    const controller = new AbortController();
    abortRef.current = controller; setInput(""); setRunning(true); setTick((value) => value + 1); edgePlayback.reset();
    setNodeStates({ ...idleStates, user_prompt: "running", client_chat_history: "running", system_prompt: "running" });
    edgePlayback.show(["user_prompt->working_memory", "client_chat_history->working_memory", "system_prompt->working_memory"]);
    setMessages((current) => [...current, { id: crypto.randomUUID(), role: "user", content: prompt }, { id: assistantId, role: "assistant", content: "", pending: true, tools: [], startedAt: performance.now() }]);
    try {
      const result = await runAgent(prompt, activeSessionId, (kind, event) => applyAgentEvent(kind, event, assistantId, setMessages, setNodeStates, edgePlayback.show), controller.signal);
      setMessages((current) => updateAssistant(current, assistantId, (message) => ({ ...message, content: message.content || result.reply, pending: false, result })));
      setNodeStates((states) => ({ ...states, reply: "done" })); await edgePlayback.finish();
      const refreshed = await memoryAction<{ messages: ChatLogEntry[]; sessions: SessionSummary[] }>({ action: "select_session", sessionId: activeSessionId });
      setSessions(refreshed.sessions); setMessages(toChatMessages(refreshed.messages));
    } catch (error) {
      const message = controller.signal.aborted ? "本轮运行已停止" : error instanceof Error ? error.message : String(error);
      setMessages((current) => updateAssistant(current, assistantId, (assistant) => ({ ...assistant, pending: false, error: message })));
      setNodeStates((states) => ({ ...states, llm: states.llm === "running" ? "error" : states.llm, tools: states.tools === "running" ? "error" : states.tools, reply: "error" })); edgePlayback.reset();
    } finally { abortRef.current = null; setRunning(false); }
  }

  if (loadError) return <div className="content-wrap"><div className="panel error-panel">Agent 加载失败：{loadError}</div></div>;
  if (!bootstrap) return <div className="content-wrap"><div className="panel loading-panel">正在加载 Agent Harness…</div></div>;
  return <div className="agent-page-layout">
    <div className="agent-main-column"><div className="agent-page-intro"><div><div className="eyebrow">个人助理 / 实时执行</div><h1>Agent</h1><p>发送消息，并观察 Working Memory、LLM、Tools 与 Reply 的真实运行状态。</p></div>{!bootstrap.settings.keyConfigured && <button className="config-warning" onClick={onOpenConfig}><Settings2 size={14} /> 配置模型后开始</button>}</div><AgentHarnessCanvas workflow={bootstrap.workflow} nodeStates={nodeStates} activeEdges={activeEdges} historyCount={messages.length} systemPromptLength={bootstrap.systemPrompt.length} /></div>
    <aside className="agent-chat-dock"><div className="session-rail"><button className="new-session" onClick={() => void createSession()}><MessageSquarePlus size={14} /> 新建对话</button><div className="session-list">{sessions.map((session) => <button key={session.id} className={session.id === activeSessionId ? "active" : ""} onClick={() => void selectSession(session.id)}><strong>{session.title}</strong><span>{session.messageCount} 条记录</span></button>)}</div></div>
      <div className="chat-pane"><div className="agent-dock-header"><div className="agent-avatar"><Bot size={16} /></div><div><strong>{sessions.find((item) => item.id === activeSessionId)?.title ?? "当前会话"}</strong><span>当前 Session 全部完整回合进入上下文</span></div><button className="session-icon" onClick={() => void renameActiveSession()} title="重命名"><Pencil size={13} /></button><button className="session-icon danger" onClick={() => void deleteActiveSession()} title="删除 Session"><Trash2 size={13} /></button><button className="model-chip" onClick={onOpenConfig} title="打开模型配置"><span className={bootstrap.settings.keyConfigured ? "model-dot ready" : "model-dot"} />{bootstrap.settings.model || bootstrap.settings.provider}</button></div>
        <div className="agent-chat-log" ref={chatLogRef}>{messages.length === 0 && <div className="agent-chat-empty"><Bot size={24} /><strong>开始这段对话</strong><span>消息会保存在本地 Session 中。</span></div>}{messages.map((message) => message.role === "user" ? <div key={message.id} className="user-bubble">{message.content}</div> : <AssistantCard key={message.id} message={message} tick={tick} />)}</div>
        <div className="agent-composer"><textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (shouldSubmitAgentComposer(event)) { event.preventDefault(); void send(); } }} placeholder={bootstrap.settings.keyConfigured ? "给 Everything Agent 发消息…" : "请先配置模型 API Key"} disabled={running || !bootstrap.settings.keyConfigured} rows={2} /><div className="agent-composer-actions">{running ? <button className="stop-agent" onClick={() => abortRef.current?.abort()}><CircleStop size={15} /> 停止</button> : <button className="send-agent" onClick={() => void send()} disabled={!input.trim() || !bootstrap.settings.keyConfigured}><Send size={15} /> 发送</button>}</div></div>
      </div></aside>
  </div>;
}

function AssistantCard({ message, tick: _tick }: { message: AssistantChatMessage; tick: number }) {
  const elapsed = message.result?.ms ?? Math.round(performance.now() - message.startedAt);
  return <div className={`assistant-card ${message.error ? "has-error" : ""}`}><div className="assistant-stages"><span className={message.pending ? "stage-chip active" : "stage-chip done"}>loop</span>{message.tools.map((tool) => <span key={tool.id} className={`stage-chip ${tool.status}`}><Wrench size={10} /> {tool.name}</span>)}<span className={message.content ? "stage-chip done" : "stage-chip"}>reply</span></div>{message.streamFallback && <div className="agent-inline-note">流式响应失败，已降级为普通请求。</div>}{message.tools.map((tool) => <details key={`${tool.id}-detail`} className={`tool-summary ${tool.status}`}><summary><code>{tool.name}</code> · {tool.summary || "完成"}{tool.ms !== undefined && ` · ${tool.ms}ms`}</summary><pre>{JSON.stringify({ args: tool.args, output: tool.output }, null, 2)}</pre></details>)}{message.error ? <div className="assistant-error">{message.error}</div> : message.content ? <div className="assistant-reply">{message.content}{message.pending && <span className="stream-caret" />}</div> : <div className="assistant-thinking">思考中… <span>{(elapsed / 1_000).toFixed(0)}s</span></div>}<div className="assistant-meta"><Clock3 size={11} /> {(elapsed / 1_000).toFixed(1)}s{message.result && <> · {message.result.iterations} iter · {message.result.model}</>}</div></div>;
}

function applyAgentEvent(kind: string, event: AgentEvent, assistantId: string, setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>, setNodeStates: React.Dispatch<React.SetStateAction<Record<string, VisualNodeState>>>, showActiveEdges: (edges: Iterable<string>) => void) {
  if (kind === "context_assembled") { setNodeStates((states) => ({ ...states, user_prompt: "done", client_chat_history: "done", system_prompt: "done", working_memory: "done" })); showActiveEdges(["working_memory->llm"]); }
  if (kind === "model_request") { setNodeStates((states) => ({ ...states, llm: "running", tools: states.tools === "running" ? "done" : states.tools })); showActiveEdges((event.iteration ?? 1) > 1 ? ["tools->llm"] : ["working_memory->llm"]); }
  if (kind === "model_response") setNodeStates((states) => ({ ...states, llm: "done" }));
  if (kind === "model_failed") setNodeStates((states) => ({ ...states, llm: "error" }));
  if (kind === "tool_started") { const toolId = event.toolCallId ?? `${event.tool}-${event.iteration}`; setNodeStates((states) => ({ ...states, tools: "running" })); showActiveEdges(["llm->tools"]); setMessages((current) => updateAssistant(current, assistantId, (message) => ({ ...message, content: "", tools: [...message.tools, { id: toolId, name: event.tool ?? "tool", status: "running", summary: "" }] }))); }
  if (kind === "tool_completed" || kind === "tool_failed") { const toolId = event.toolCallId ?? `${event.tool}-${event.iteration}`; setNodeStates((states) => ({ ...states, tools: event.isError ? "error" : "done" })); setMessages((current) => updateAssistant(current, assistantId, (message) => ({ ...message, tools: message.tools.map((tool) => tool.id === toolId ? { ...tool, status: event.isError ? "error" : "done", summary: event.summary ?? "", args: event.arguments, output: event.result, ...(event.ms !== undefined ? { ms: event.ms } : {}) } : tool) }))); }
  if (kind === "text") { setNodeStates((states) => ({ ...states, reply: "running" })); showActiveEdges(["llm->reply"]); setMessages((current) => updateAssistant(current, assistantId, (message) => ({ ...message, content: message.content + (event.delta ?? "") }))); }
  if (kind === "stream_fallback") setMessages((current) => updateAssistant(current, assistantId, (message) => ({ ...message, content: "", streamFallback: true })));
  if (kind === "reply") { setNodeStates((states) => ({ ...states, llm: "done", reply: "done" })); showActiveEdges(["llm->reply"]); }
}

function updateAssistant(messages: ChatMessage[], id: string, updater: (message: AssistantChatMessage) => AssistantChatMessage): ChatMessage[] { return messages.map((message) => message.id === id && message.role === "assistant" ? updater(message) : message); }

function toChatMessages(entries: ChatLogEntry[]): ChatMessage[] {
  const groups = new Map<string, ChatLogEntry[]>();
  for (const entry of entries) groups.set(entry.runId, [...(groups.get(entry.runId) ?? []), entry]);
  const messages: ChatMessage[] = [];
  for (const [runId, rows] of groups) {
    const user = rows.find((row) => row.kind === "user_message"); if (!user) continue;
    messages.push({ id: `${runId}-user`, role: "user", content: plainText(user.content) });
    const final = [...rows].reverse().find((row) => row.kind === "assistant_message");
    const toolCalls = rows.filter((row) => row.kind === "assistant_tool_call").flatMap((row) => blocks(row.content, "tool_use"));
    const toolResults = rows.filter((row) => row.kind === "tool_result").flatMap((row) => blocks(row.content, "tool_result"));
    messages.push({ id: `${runId}-assistant`, role: "assistant", content: final ? plainText(final.content) : "", pending: false, ...(final ? {} : { error: "此回合未完成" }), startedAt: performance.now(), tools: toolCalls.map((call) => { const result = toolResults.find((item) => item.tool_use_id === call.id); return { id: String(call.id ?? crypto.randomUUID()), name: String(call.name ?? "tool"), status: result?.is_error ? "error" : "done", summary: result?.is_error ? "工具执行失败" : "工具执行完成", args: call.input, output: result?.content }; }) });
  }
  return messages;
}

function blocks(content: unknown, type: string): Array<Record<string, unknown>> { return Array.isArray(content) ? content.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && (item as { type?: string }).type === type)) : []; }
function plainText(content: unknown): string { return typeof content === "string" ? content : blocks(content, "text").map((block) => String(block.text ?? "")).join(""); }
