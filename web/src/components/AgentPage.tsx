import { Bot, CircleStop, Clock3, Eraser, Send, Settings2, Wrench } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  loadAgent,
  runAgent,
  type AgentBootstrap,
  type AgentEvent,
  type AgentRunResult,
  type ClientHistoryMessage,
} from "../agent-api";
import { createEdgePlayback } from "../edge-playback";
import type { VisualNodeState } from "./GraphCanvas";
import { AgentHarnessCanvas } from "./AgentHarnessCanvas";

interface AgentPageProps {
  onOpenConfig(): void;
}

interface ToolView {
  id: string;
  name: string;
  status: "running" | "done" | "error";
  summary: string;
  ms?: number;
}

interface UserChatMessage {
  id: string;
  role: "user";
  content: string;
}

interface AssistantChatMessage {
  id: string;
  role: "assistant";
  content: string;
  pending: boolean;
  error?: string;
  tools: ToolView[];
  startedAt: number;
  result?: AgentRunResult;
  streamFallback?: boolean;
}

type ChatMessage = UserChatMessage | AssistantChatMessage;

const idleStates: Record<string, VisualNodeState> = {
  user_prompt: "idle",
  client_chat_history: "idle",
  system_prompt: "idle",
  working_memory: "idle",
  llm: "idle",
  tools: "idle",
  reply: "idle",
};

export function AgentPage({ onOpenConfig }: AgentPageProps) {
  const [bootstrap, setBootstrap] = useState<AgentBootstrap | null>(null);
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

  useEffect(() => {
    loadAgent().then(setBootstrap).catch((error: unknown) => {
      setLoadError(error instanceof Error ? error.message : String(error));
    });
  }, []);

  useEffect(() => {
    chatLogRef.current?.scrollTo({ top: chatLogRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [running]);

  useEffect(() => () => edgePlayback.cancel(), [edgePlayback]);

  async function send() {
    const prompt = input.trim();
    if (!prompt || running || !bootstrap) return;
    const history = toClientHistory(messages);
    const assistantId = crypto.randomUUID();
    const controller = new AbortController();
    abortRef.current = controller;
    setInput("");
    setRunning(true);
    setTick((value) => value + 1);
    edgePlayback.reset();
    setNodeStates({
      ...idleStates,
      user_prompt: "running",
      client_chat_history: "running",
      system_prompt: "running",
    });
    edgePlayback.show([
      "user_prompt->working_memory",
      "client_chat_history->working_memory",
      "system_prompt->working_memory",
    ]);
    setMessages((current) => [
      ...current,
      { id: crypto.randomUUID(), role: "user", content: prompt },
      { id: assistantId, role: "assistant", content: "", pending: true, tools: [], startedAt: performance.now() },
    ]);

    try {
      const result = await runAgent(prompt, history, (kind, event) => {
        applyAgentEvent(kind, event, assistantId, setMessages, setNodeStates, edgePlayback.show);
      }, controller.signal);
      setMessages((current) => updateAssistant(current, assistantId, (message) => ({
        ...message,
        content: message.content || result.reply,
        pending: false,
        result,
      })));
      setNodeStates((states) => ({ ...states, reply: "done" }));
      await edgePlayback.finish();
    } catch (error) {
      const stopped = controller.signal.aborted;
      const message = stopped ? "本轮运行已停止" : error instanceof Error ? error.message : String(error);
      setMessages((current) => updateAssistant(current, assistantId, (assistant) => ({
        ...assistant,
        pending: false,
        error: message,
      })));
      setNodeStates((states) => ({
        ...states,
        llm: states.llm === "running" ? "error" : states.llm,
        tools: states.tools === "running" ? "error" : states.tools,
        reply: states.reply === "running" ? "error" : states.reply,
      }));
      edgePlayback.reset();
    } finally {
      abortRef.current = null;
      setRunning(false);
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  if (loadError) {
    return <div className="content-wrap"><div className="panel error-panel">Agent 加载失败：{loadError}</div></div>;
  }
  if (!bootstrap) {
    return <div className="content-wrap"><div className="panel loading-panel">正在加载 Agent Harness…</div></div>;
  }

  return (
    <div className="agent-page-layout">
      <div className="agent-main-column">
        <div className="agent-page-intro">
          <div>
            <div className="eyebrow">个人助理 / 实时执行</div>
            <h1>Agent</h1>
            <p>发送消息，并观察 Working Memory、LLM、Tools 与 Reply 的真实运行状态。</p>
          </div>
          {!bootstrap.settings.keyConfigured && (
            <button className="config-warning" onClick={onOpenConfig}><Settings2 size={14} /> 配置模型后开始</button>
          )}
        </div>
        <AgentHarnessCanvas
          workflow={bootstrap.workflow}
          nodeStates={nodeStates}
          activeEdges={activeEdges}
          historyCount={toClientHistory(messages).length}
          systemPromptLength={bootstrap.systemPrompt.length}
        />
      </div>

      <aside className="agent-chat-dock">
        <div className="agent-dock-header">
          <div className="agent-avatar"><Bot size={16} /></div>
          <div><strong>当前会话</strong><span>刷新页面即清空</span></div>
          <button className="model-chip" onClick={onOpenConfig} title="打开模型配置">
            <span className={bootstrap.settings.keyConfigured ? "model-dot ready" : "model-dot"} />
            {bootstrap.settings.model || bootstrap.settings.provider}
          </button>
        </div>
        <div className="agent-chat-log" ref={chatLogRef}>
          {messages.length === 0 && (
            <div className="agent-chat-empty">
              <Bot size={24} />
              <strong>开始一个临时会话</strong>
              <span>消息只保存在当前页面内存中。</span>
            </div>
          )}
          {messages.map((message) => message.role === "user"
            ? <div key={message.id} className="user-bubble">{message.content}</div>
            : <AssistantCard key={message.id} message={message} tick={tick} />)}
        </div>
        <div className="agent-composer">
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            placeholder={bootstrap.settings.keyConfigured ? "给 Everything Agent 发消息…" : "请先配置模型 API Key"}
            disabled={running || !bootstrap.settings.keyConfigured}
            rows={2}
          />
          <div className="agent-composer-actions">
            <button className="clear-chat" onClick={() => setMessages([])} disabled={running || messages.length === 0} title="清空会话"><Eraser size={15} /></button>
            {running
              ? <button className="stop-agent" onClick={stop}><CircleStop size={15} /> 停止</button>
              : <button className="send-agent" onClick={() => void send()} disabled={!input.trim() || !bootstrap.settings.keyConfigured}><Send size={15} /> 发送</button>}
          </div>
        </div>
      </aside>
    </div>
  );
}

function AssistantCard({ message, tick: _tick }: { message: AssistantChatMessage; tick: number }) {
  const elapsed = message.result?.ms ?? Math.round(performance.now() - message.startedAt);
  return (
    <div className={`assistant-card ${message.error ? "has-error" : ""}`}>
      <div className="assistant-stages">
        <span className={message.pending ? "stage-chip active" : "stage-chip done"}>loop</span>
        {message.tools.map((tool) => (
          <span key={tool.id} className={`stage-chip ${tool.status}`}><Wrench size={10} /> {tool.name}</span>
        ))}
        <span className={message.content ? "stage-chip done" : "stage-chip"}>reply</span>
      </div>
      {message.streamFallback && <div className="agent-inline-note">流式响应失败，已降级为普通请求。</div>}
      {message.tools.map((tool) => (
        <div key={`${tool.id}-detail`} className={`tool-summary ${tool.status}`}>
          <span className="tool-status-dot" />
          <code>{tool.name}</code>
          <span>{tool.summary || (tool.status === "running" ? "执行中…" : "完成")}</span>
          {tool.ms !== undefined && <small>{tool.ms}ms</small>}
        </div>
      ))}
      {message.error
        ? <div className="assistant-error">{message.error}</div>
        : message.content
          ? <div className="assistant-reply">{message.content}{message.pending && <span className="stream-caret" />}</div>
          : <div className="assistant-thinking">思考中… <span>{(elapsed / 1_000).toFixed(0)}s</span></div>}
      <div className="assistant-meta">
        <Clock3 size={11} /> {(elapsed / 1_000).toFixed(1)}s
        {message.result && <> · {message.result.iterations} iter · {message.result.model}</>}
      </div>
    </div>
  );
}

function applyAgentEvent(
  kind: string,
  event: AgentEvent,
  assistantId: string,
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
  setNodeStates: React.Dispatch<React.SetStateAction<Record<string, VisualNodeState>>>,
  showActiveEdges: (edges: Iterable<string>) => void,
) {
  if (kind === "working_memory") {
    setNodeStates((states) => ({
      ...states,
      user_prompt: "done",
      client_chat_history: "done",
      system_prompt: "done",
      working_memory: "done",
    }));
    showActiveEdges(["working_memory->llm"]);
  }
  if (kind === "llm_start") {
    setNodeStates((states) => ({ ...states, llm: "running", tools: states.tools === "running" ? "done" : states.tools }));
    showActiveEdges((event.iteration ?? 1) > 1 ? ["tools->llm"] : ["working_memory->llm"]);
  }
  if (kind === "llm_end") setNodeStates((states) => ({ ...states, llm: "done" }));
  if (kind === "tool_start") {
    const toolId = event.toolUseId ?? `${event.tool}-${event.iteration}`;
    setNodeStates((states) => ({ ...states, tools: "running" }));
    showActiveEdges(["llm->tools"]);
    setMessages((current) => updateAssistant(current, assistantId, (message) => ({
      ...message,
      // 工具结果会触发新一轮模型响应；不把工具前的临时文本混进最终 Reply。
      content: "",
      tools: [...message.tools, {
        id: toolId,
        name: event.tool ?? "tool",
        status: "running",
        summary: "",
      }],
    })));
  }
  if (kind === "tool_end") {
    const toolId = event.toolUseId ?? `${event.tool}-${event.iteration}`;
    setNodeStates((states) => ({ ...states, tools: event.isError ? "error" : "done" }));
    setMessages((current) => updateAssistant(current, assistantId, (message) => ({
      ...message,
      tools: message.tools.map((tool) => tool.id === toolId ? {
        ...tool,
        status: event.isError ? "error" : "done",
        summary: event.summary ?? "",
        ...(event.ms !== undefined ? { ms: event.ms } : {}),
      } : tool),
    })));
  }
  if (kind === "text") {
    setNodeStates((states) => ({ ...states, reply: "running" }));
    showActiveEdges(["llm->reply"]);
    setMessages((current) => updateAssistant(current, assistantId, (message) => ({
      ...message,
      content: message.content + (event.delta ?? ""),
    })));
  }
  if (kind === "stream_fallback") {
    setMessages((current) => updateAssistant(current, assistantId, (message) => ({
      ...message,
      content: "",
      streamFallback: true,
    })));
  }
  if (kind === "reply") {
    setNodeStates((states) => ({ ...states, llm: "done", reply: "done" }));
    showActiveEdges(["llm->reply"]);
  }
}

function updateAssistant(
  messages: ChatMessage[],
  id: string,
  updater: (message: AssistantChatMessage) => AssistantChatMessage,
): ChatMessage[] {
  return messages.map((message) => message.id === id && message.role === "assistant" ? updater(message) : message);
}

function toClientHistory(messages: ChatMessage[]): ClientHistoryMessage[] {
  const history: ClientHistoryMessage[] = [];
  for (let index = 0; index < messages.length - 1; index += 1) {
    const user = messages[index];
    const assistant = messages[index + 1];
    if (user?.role !== "user" || assistant?.role !== "assistant") continue;
    if (assistant.pending || assistant.error || !assistant.content) continue;
    history.push(
      { role: "user", content: user.content },
      { role: "assistant", content: assistant.content },
    );
    index += 1;
  }
  return history;
}
