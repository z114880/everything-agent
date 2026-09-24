import { GitBranch } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { SaveMessage } from "../../components/SaveMessage";
import { MINIMUM_FEEDBACK_DURATION_MS, withMinimumDuration } from "../../lib/minimum-duration";
import { PageHeading } from "../../components/PageHeading";
import type { VisualNodeState } from "../../visual-node-state";
import {
  loadLocalWorkflow,
  runLocalWorkflow,
  saveLocalWorkflow,
  type GraphExecutionResult,
  type WaveResult,
  type Workflow,
} from "../../workflow-api";
import { CodeEditor } from "./CodeEditor";
import { GraphCanvas } from "./GraphCanvas";
import { ResultPanel, RunPanel } from "./RunPanel";

/** 编辑、展示并执行本地工作流。 */
export function WorkflowPage() {
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState("");
  const [messageVariant, setMessageVariant] = useState<"success" | "error">("success");
  const [editable, setEditable] = useState(false);
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

  function applyLoadedWorkflow(loaded: Awaited<ReturnType<typeof loadLocalWorkflow>>) {
    saveRevisionRef.current += 1;
    lastSavedSourceRef.current = loaded.source;
    setWorkflowFiles(loaded.files);
    setSelectedFile(loaded.selectedFile);
    setCode(loaded.source);
    setEditable(loaded.editable);
    setWorkflow(loaded.workflow);
    setCompileError("");
    setNodeStates(Object.fromEntries(loaded.workflow.nodes.map((node) => [node.id, "idle"])));
    setResult(null);
    setWaves([]);
    wavesRef.current = [];
  }

  async function reloadFromDisk(file = selectedFile || undefined, notify = false) {
    if (notify && (refreshing || switchingWorkflow)) return;
    if (notify) {
      setRefreshing(true);
      setMessage("");
    }
    try {
      applyLoadedWorkflow(await withMinimumDuration(() => loadLocalWorkflow(file), notify ? MINIMUM_FEEDBACK_DURATION_MS : 0));
      if (notify) {
        setMessageVariant("success");
        setMessage("已重新读取");
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setCompileError(detail);
      if (notify) {
        setMessageVariant("error");
        setMessage(detail);
      }
    } finally {
      if (notify) setRefreshing(false);
    }
  }

  useEffect(() => {
    void reloadFromDisk();
  }, []);

  useEffect(() => {
    if (!editable || !selectedFile || switchingWorkflow || !code || code === lastSavedSourceRef.current) return;
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
  }, [code, editable, selectedFile, switchingWorkflow]);

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

  async function selectWorkflow(file: string) {
    if (!selectedFile || file === selectedFile || switchingWorkflow || running) return;
    setSwitchingWorkflow(true);
    saveRevisionRef.current += 1;
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    try {
      if (editable && code !== lastSavedSourceRef.current) {
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

  const updateWaves = (updater: (currentWaves: WaveResult[]) => WaveResult[]) => {
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
          setActiveEdges(new Set((event.activatedEdges ?? []).map((edge) => `${edge.source}->${edge.target}`)));
        }
        if (kind === "node_start" && event.node && event.wave) {
          startsRef.current[`${event.wave}:${event.node}`] = performance.now();
          setNodeStates((states) => ({ ...states, [event.node!]: "running" }));
        }
        if (kind === "node_end" && event.node && event.wave) {
          const nodeName = event.node;
          const key = `${event.wave}:${nodeName}`;
          delete startsRef.current[key];
          setElapsed((current) => ({ ...current, [key]: event.ms ?? 0 }));
          updateWaves((current) => current.map((wave) => wave.index === event.wave
            ? { ...wave, nodes: wave.nodes.map((node) => node.id === nodeName
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
    <div className="content-wrap workflow-page">
      <PageHeading eyebrow="工作流 / 可视化执行" title="Workflow" description="用代码定义智能体工作流，并实时观察节点、路由、并行 wave 和最终结果。" />
      <SaveMessage message={message} setMessage={setMessage} variant={messageVariant} />
      <div className="intro-note"><GitBranch size={16} /><p><strong>本地代码是事实来源。</strong> {editable ? "下方编辑器直接读写" : "生产环境只读查看"} <code>{editable ? "src/workflows/" : "dist-server/src/workflows/"}{selectedFile || "…"}</code>；拓扑来自 <code>Graph.describe()</code>，执行过程来自本地 <code>runGraph()</code> 的 observer 事件。</p></div>
      <div className="workspace-grid">
        {workflow ? <GraphCanvas workflow={workflow} nodeStates={nodeStates} activeEdges={activeEdges} /> : <div className="panel grid min-h-[580px] place-items-center text-sm text-[var(--muted-foreground)]">等待有效的工作流代码…</div>}
      </div>
      <div className="analysis-grid">
        <CodeEditor editable={editable} code={code} error={compileError} workflowFiles={workflowFiles} selectedFile={selectedFile} switching={switchingWorkflow || refreshing} refreshing={refreshing} onChange={setCode} onSelect={(file) => void selectWorkflow(file)} onReset={() => void reloadFromDisk(undefined, true)} />
        {workflow && <RunPanel workflow={workflow} input={input} running={running} runError={runError} result={result} waves={waves} nodeStates={nodeStates} elapsed={elapsed} onInput={setInput} onRun={run} />}
      </div>
      {workflow && <ResultPanel result={result} />}
    </div>
  );
}
