import { Activity, Bot, Brain, GitBranch, PanelLeftClose, PanelLeftOpen, Settings, Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { CodeEditor } from "./components/CodeEditor";
import { AgentPage } from "./components/AgentPage";
import { ConfigPage } from "./components/ConfigPage";
import { MemoryPage } from "./components/MemoryPage";
import { TracePage } from "./components/TracePage";
import { GraphCanvas, type VisualNodeState } from "./components/GraphCanvas";
import { ResultPanel, RunPanel } from "./components/RunPanel";
import {
  loadLocalWorkflow,
  runLocalWorkflow,
  saveLocalWorkflow,
  type GraphExecutionResult,
  type WaveResult,
  type Workflow,
} from "./workflow-api";

export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [page, setPage] = useState<"agent" | "workflow" | "memory" | "traces" | "config">("agent");
  const [code, setCode] = useState("");
  const [workflowFiles, setWorkflowFiles] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState("");
  const [switchingWorkflow, setSwitchingWorkflow] = useState(false);
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [compileError, setCompileError] = useState("");
  const [input, setInput] = useState("帮我规划今天的工作，优先处理最重要的事情");
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState("");
  const [result, setResult] = useState<GraphExecutionResult | null>(null);
  const [nodeStates, setNodeStates] = useState<Record<string, VisualNodeState>>({});
  const [activeEdges, setActiveEdges] = useState<Set<string>>(new Set());
  const [elapsed, setElapsed] = useState<Record<string, number>>({});
  const [waves, setWaves] = useState<WaveResult[]>([]);
  const startsRef = useRef<Record<string, number>>({});
  const wavesRef = useRef<WaveResult[]>([]);
  const lastSavedSourceRef = useRef("");
  const saveRevisionRef = useRef(0);
  const saveTimerRef = useRef<number | null>(null);
  const endFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void reloadFromDisk();
  }, []);

  useEffect(() => {
    if (!selectedFile || switchingWorkflow || !code || code === lastSavedSourceRef.current) return;
    const revision = ++saveRevisionRef.current;
    saveTimerRef.current = window.setTimeout(() => {
      saveLocalWorkflow(selectedFile, code).then(({ workflow: next }) => {
        if (revision !== saveRevisionRef.current) return;
        lastSavedSourceRef.current = code;
        setWorkflow(next);
        setCompileError("");
        setNodeStates(Object.fromEntries(next.nodes.map((node) => [node.id, "idle"])));
        setResult(null);
      }).catch((error: unknown) => {
        if (revision === saveRevisionRef.current) {
          setCompileError(error instanceof Error ? error.message : String(error));
        }
      });
    }, 420);
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    };
  }, [code, selectedFile, switchingWorkflow]);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      const now = performance.now();
      setElapsed((current) => ({
        ...current,
        ...Object.fromEntries(Object.entries(startsRef.current).map(([key, start]) => [key, Math.round(now - start)])),
      }));
    }, 80);
    return () => window.clearInterval(timer);
  }, [running]);

  useEffect(() => () => {
    if (endFlashTimerRef.current) clearTimeout(endFlashTimerRef.current);
  }, []);

  function applyLoadedWorkflow(loaded: Awaited<ReturnType<typeof loadLocalWorkflow>>) {
    saveRevisionRef.current += 1;
    lastSavedSourceRef.current = loaded.source;
    setWorkflowFiles(loaded.files);
    setSelectedFile(loaded.selectedFile);
    setCode(loaded.source);
    setWorkflow(loaded.workflow);
    setCompileError("");
    setNodeStates(Object.fromEntries(loaded.workflow.nodes.map((node) => [node.id, "idle"])));
    setResult(null);
    setWaves([]);
    wavesRef.current = [];
  }

  async function reloadFromDisk(file = selectedFile || undefined) {
    try {
      applyLoadedWorkflow(await loadLocalWorkflow(file));
    } catch (error) {
      setCompileError(error instanceof Error ? error.message : String(error));
    }
  }

  async function selectWorkflow(file: string) {
    if (!selectedFile || file === selectedFile || switchingWorkflow || running) return;
    setSwitchingWorkflow(true);
    saveRevisionRef.current += 1;
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    try {
      if (code !== lastSavedSourceRef.current) {
        await saveLocalWorkflow(selectedFile, code);
        lastSavedSourceRef.current = code;
      }
      applyLoadedWorkflow(await loadLocalWorkflow(file));
    } catch (error) {
      setCompileError(error instanceof Error ? error.message : String(error));
    } finally {
      setSwitchingWorkflow(false);
    }
  }

  const updateWaves = (updater: (waves: WaveResult[]) => WaveResult[]) => {
    wavesRef.current = updater(wavesRef.current);
    setWaves(wavesRef.current);
  };

  const run = useCallback(async () => {
    if (!workflow || !selectedFile || switchingWorkflow || running || compileError) return;
    setRunning(true);
    setRunError("");
    setResult(null);
    wavesRef.current = [];
    setWaves([]);
    setElapsed({});
    startsRef.current = {};
    if (endFlashTimerRef.current) clearTimeout(endFlashTimerRef.current);
    endFlashTimerRef.current = null;
    setActiveEdges(new Set());
    setNodeStates(Object.fromEntries(workflow.nodes.map((node) => [node.id, "idle"])));
    try {
      const nextResult = await runLocalWorkflow(selectedFile, input, (kind, event) => {
        if (kind === "graph_start") setNodeStates((states) => ({ ...states, START: "running" }));
        if (kind === "wave_start" && event.wave && event.nodes) {
          updateWaves((current) => [...current, {
            index: event.wave!,
            nodes: event.nodes!.map((id) => ({ id, ms: 0, keys: [] })),
          }]);
          setNodeStates((states) => ({ ...states, START: "done" }));
          setActiveEdges(new Set(
            (event.activatedEdges ?? []).map((edge) => `${edge.source}->${edge.target}`),
          ));
        }
        if (kind === "node_start" && event.node && event.wave) {
          const nodeName = event.node;
          startsRef.current[`${event.wave}:${nodeName}`] = performance.now();
          setNodeStates((states) => ({ ...states, [nodeName]: "running" }));
        }
        if (kind === "node_end" && event.node && event.wave) {
          const nodeName = event.node;
          const key = `${event.wave}:${event.node}`;
          delete startsRef.current[key];
          setElapsed((current) => ({ ...current, [key]: event.ms ?? 0 }));
          updateWaves((current) => current.map((wave) => wave.index === event.wave
            ? { ...wave, nodes: wave.nodes.map((node) => node.id === event.node
              ? { ...node, ms: event.ms ?? 0, keys: event.keys ?? [], error: event.error ? String(event.error) : null }
              : node) }
            : wave));
          setNodeStates((states) => ({ ...states, [nodeName]: event.error ? "error" : "done" }));
        }
        if (kind === "route" && event.node && event.target) {
          setActiveEdges(new Set([`${event.node}->${event.target}`]));
        }
        if (kind === "graph_end") {
          setActiveEdges(new Set(workflow.edges.filter((edge) => edge.target === "END").map((edge) => `${edge.source}->END`)));
          endFlashTimerRef.current = setTimeout(() => setActiveEdges(new Set()), 200);
          setNodeStates((states) => ({ ...states, END: event.status === "completed" ? "done" : "error" }));
        }
      });
      setResult({ ...nextResult, waves: wavesRef.current });
    } catch (error) {
      setActiveEdges(new Set());
      setRunError(error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false);
      startsRef.current = {};
    }
  }, [compileError, input, running, selectedFile, switchingWorkflow, workflow]);

  return (
    <div className="app-shell">
      <aside className={`sidebar ${sidebarOpen ? "open" : "closed"}`}>
        <div className="brand-row">
          <div className="brand-mark"><Sparkles size={15} /></div>
          <div><strong>Everything Agent</strong><span>可视化Agent控制台</span></div>
          <button className="sidebar-toggle" onClick={() => setSidebarOpen(false)} aria-label="收起侧边栏"><PanelLeftClose size={16} /></button>
        </div>
        <div className="nav-group">系统</div>
        <button className={`nav-item ${page === "agent" ? "active" : ""}`} onClick={() => setPage("agent")}><Bot size={15} /><span>Agent</span></button>
        <button className={`nav-item ${page === "workflow" ? "active" : ""}`} onClick={() => setPage("workflow")}><GitBranch size={15} /><span>Workflow</span><span className="nav-count">01</span></button>
        <button className={`nav-item ${page === "memory" ? "active" : ""}`} onClick={() => setPage("memory")}><Brain size={15} /><span>Memory</span></button>
        <button className={`nav-item ${page === "traces" ? "active" : ""}`} onClick={() => setPage("traces")}><Activity size={15} /><span>运行记录</span></button>
        <button className={`nav-item ${page === "config" ? "active" : ""}`} onClick={() => setPage("config")}><Settings size={15} /><span>配置</span></button>
        <div className="sidebar-note"><span className="signal bg-emerald-500" />本地 Engine 已连接</div>
      </aside>
      {!sidebarOpen && <button className="sidebar-reopen" onClick={() => setSidebarOpen(true)} aria-label="展开侧边栏"><PanelLeftOpen size={17} /></button>}

      <main className={`main-content ${page === "agent" ? "agent-main-content" : ""}`}>
        {page === "agent" ? <AgentPage onOpenConfig={() => setPage("config")} /> : page === "config" ? <ConfigPage /> : page === "memory" ? <MemoryPage /> : page === "traces" ? <TracePage /> : <>
        <header className="page-header">
          <div>
            <div className="eyebrow">工作流 / 可视化执行</div>
            <h1>Workflow</h1>
            <p>用代码定义智能体工作流，并实时观察节点、路由、并行 wave 和最终结果。</p>
          </div>
        </header>

        <div className="content-wrap">
          <div className="intro-note"><GitBranch size={16} /><p><strong>本地代码是事实来源。</strong> 下方编辑器直接读写 <code>src/workflows/{selectedFile || "…"}</code>；拓扑来自 <code>Graph.describe()</code>，执行过程来自本地 <code>runGraph()</code> 的 observer 事件。</p></div>
          <div className="workspace-grid">
            {workflow ? <GraphCanvas workflow={workflow} nodeStates={nodeStates} activeEdges={activeEdges} /> : <div className="panel grid min-h-[580px] place-items-center text-sm text-[var(--muted)]">等待有效的工作流代码…</div>}
          </div>
          <div className="analysis-grid">
            <CodeEditor
              code={code}
              error={compileError}
              workflowFiles={workflowFiles}
              selectedFile={selectedFile}
              switching={switchingWorkflow}
              onChange={setCode}
              onSelect={(file) => void selectWorkflow(file)}
              onReset={() => void reloadFromDisk()}
            />
            {workflow && <RunPanel workflow={workflow} input={input} running={running} runError={runError} result={result} waves={waves} nodeStates={nodeStates} elapsed={elapsed} onInput={setInput} onRun={run} />}
          </div>
          {workflow && <ResultPanel result={result} />}
        </div>
        </>}
      </main>
    </div>
  );
}
