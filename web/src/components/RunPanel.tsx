import { ArrowRight, Check, CircleAlert, LoaderCircle, Play, Sparkles } from "lucide-react";
import type { GraphExecutionResult, WaveResult, Workflow } from "../workflow-api";
import type { VisualNodeState } from "./GraphCanvas";

interface RunPanelProps {
  workflow: Workflow;
  input: string;
  running: boolean;
  runError: string;
  result: GraphExecutionResult | null;
  waves: WaveResult[];
  nodeStates: Record<string, VisualNodeState>;
  elapsed: Record<string, number>;
  onInput: (value: string) => void;
  onRun: () => void;
}

export function RunPanel(props: RunPanelProps) {
  const { workflow, input, running, runError, result, waves, nodeStates, elapsed, onInput, onRun } = props;
  const shownWaves = result?.waves ?? waves;

  return (
    <section className="panel run-analysis-panel">
      <div className="run-analysis-fixed p-4 sm:p-5">
          <div className="run-row">
            <div className="relative min-w-0 flex-1">
              <Sparkles className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--muted)]" size={16} />
              <input
                className="run-input"
                value={input}
                onChange={(event) => onInput(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter" && !running) onRun(); }}
                placeholder="输入一个任务，例如：帮我规划今天的工作"
              />
            </div>
            <button className="run-button" onClick={onRun} disabled={running}>
              {running ? <LoaderCircle className="animate-spin" size={16} /> : <Play size={15} fill="currentColor" />}
              {running ? "执行中" : "执行工作流"}
            </button>
          </div>
          <p className="mt-3 text-xs text-[var(--muted)]">图展示真实拓扑，下面的卡片按 Engine 的 wave_start 事件展示节点如何并发发生。代码在本地 Node.js 进程执行；当前示例节点不会产生外部写操作。</p>
      </div>

      <div className="run-analysis-scroll px-4 pb-4 sm:px-5 sm:pb-5">
          {shownWaves.map((wave) => {
            const maxMs = Math.max(1, ...wave.nodes.map((node) => node.ms));
            return (
              <div key={wave.index} className="wave-section">
                <div className="wave-heading">
                  波次 {wave.index}<span>·</span>{wave.nodes.length} 个节点
                  {wave.nodes.some((node) => node.ms > 0) && <><span>·</span>{(maxMs / 1000).toFixed(2)} 秒</>}
                </div>
                <div className="wave-grid">
                  {wave.nodes.map((node) => {
                    const definition = workflow.nodes.find((item) => item.id === node.id);
                    const state = node.error ? "error" : node.ms > 0 ? "done" : (nodeStates[node.id] ?? "idle");
                    const ms = elapsed[`${wave.index}:${node.id}`] ?? node.ms;
                    return (
                      <div key={node.id} className={`wave-card ${state}`}>
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2 font-medium">
                            {state === "running" ? <LoaderCircle className="animate-spin text-[var(--accent)]" size={14} /> : state === "error" ? <CircleAlert className="text-red-600" size={14} /> : <Check size={14} className={state === "done" ? "text-emerald-600" : "text-[var(--muted)]"} />}
                            {definition?.label || node.id}
                          </div>
                          <span className="time-chip">{state === "running" ? `${(ms / 1000).toFixed(1)}s` : node.ms ? `${node.ms}ms` : "等待"}</span>
                        </div>
                        <div className="wave-track"><i style={{ width: state === "running" ? "72%" : node.ms ? `${Math.max(8, node.ms / maxMs * 100)}%` : "0%" }} /></div>
                        <div className="min-h-4 text-[11px] text-[var(--muted)]">{node.error ? `错误：${node.error}` : node.keys.length ? `写入：${node.keys.join("、")}` : `类型：${definition?.kind ?? "fn"}`}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {runError && <div className="error-message"><CircleAlert size={15} />{runError}</div>}
      </div>
    </section>
  );
}

export function ResultPanel({ result }: { result: GraphExecutionResult | null }) {
  return (
      <section className="mt-7 pb-10">
        <div className="section-title"><span>最后结果</span>{result && <span className="text-[var(--muted)] normal-case tracking-normal">共 {result.totalMs}ms</span>}</div>
        <div className={`result-card ${!result ? "empty" : ""}`}>
          {result ? (
            <>
              <div className="result-icon"><Sparkles size={16} /></div>
              <div className="min-w-0 flex-1">
                <div className={`mb-1.5 flex items-center gap-2 text-xs font-semibold ${result.status === "completed" ? "text-emerald-700" : "text-red-600"}`}><Check size={14} />{result.status === "completed" ? "执行完成" : `执行${result.status === "stalled" ? "停滞" : "失败"}`}</div>
                <p className="text-[14px] leading-7 text-[var(--ink)]">{String(result.state.finalAnswer ?? "工作流已完成，请在状态详情中查看输出。")}</p>
                <details className="mt-3 text-xs text-[var(--muted)]">
                  <summary className="cursor-pointer select-none hover:text-[var(--accent)]">查看完整状态</summary>
                  <pre className="state-output">{JSON.stringify(result.state, null, 2)}</pre>
                </details>
              </div>
            </>
          ) : <p>执行工作流后，最终结果会显示在这里。</p>}
        </div>
      </section>
  );
}
