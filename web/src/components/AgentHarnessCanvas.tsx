import { useId } from "react";
import type { Workflow } from "../workflow-api";
import type { VisualNodeState } from "./GraphCanvas";

interface AgentHarnessCanvasProps {
  workflow: Workflow;
  nodeStates: Record<string, VisualNodeState>;
  activeEdges: Set<string>;
  historyCount: number;
  systemPromptLength: number;
}

const positions = {
  user_prompt: { x: 20, y: 68, width: 165, height: 58 },
  client_chat_history: { x: 20, y: 180, width: 165, height: 58 },
  system_prompt: { x: 20, y: 292, width: 165, height: 58 },
  working_memory: { x: 220, y: 180, width: 165, height: 64 },
  llm: { x: 435, y: 104, width: 155, height: 64 },
  tools: { x: 435, y: 270, width: 155, height: 64 },
  reply: { x: 650, y: 180, width: 140, height: 64 },
} as const;

const labels: Record<string, { title: string; subtitle: string }> = {
  user_prompt: { title: "User Prompt", subtitle: "current turn" },
  working_memory: { title: "Working Memory", subtitle: "assembled per turn" },
  llm: { title: "LLM", subtitle: "reason" },
  tools: { title: "Tools", subtitle: "act · observe" },
  reply: { title: "Reply", subtitle: "stream to client" },
};

export function AgentHarnessCanvas({
  workflow,
  nodeStates,
  activeEdges,
  historyCount,
  systemPromptLength,
}: AgentHarnessCanvasProps) {
  const markerId = useId().replaceAll(":", "");
  const dynamicIds = new Set(workflow.nodes.map((node) => node.id));
  const externalLabels = {
    client_chat_history: { title: "Client Chat History", subtitle: `${historyCount} messages` },
    system_prompt: { title: "System Prompt", subtitle: `${systemPromptLength} chars` },
  };
  const fixedEdges = [
    ["user_prompt", "working_memory"],
    ["client_chat_history", "working_memory"],
    ["system_prompt", "working_memory"],
  ] as const;
  const graphEdges = workflow.edges.filter((edge) => edge.source !== "START" && edge.target !== "END");
  const visibleIds = [
    "user_prompt",
    "client_chat_history",
    "system_prompt",
    ...workflow.nodes.map((node) => node.id).filter((id) => id in positions),
  ];

  return (
    <section className="agent-harness-panel panel">
      <div className="panel-header">
        <div>
          <div>Agent Harness</div>
          <p className="mt-1 text-[11px] font-normal text-[var(--muted)]">静态输入进入 Working Memory；Loop 拓扑来自 Graph.describe()</p>
        </div>
        <span className="status-pill">真实 observer 事件</span>
      </div>
      <div className="agent-svg-wrap">
        <svg viewBox="0 0 810 420" className="agent-harness-svg" role="img" aria-label="Agent Harness 实时流程图">
          <defs>
            <marker id={markerId} viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" className="arrow-head" />
            </marker>
          </defs>
          <rect x="415" y="50" width="200" height="330" rx="20" className="agent-loop-box" />
          <text x="433" y="79" className="agent-loop-label">AGENT LOOP</text>

          {[...fixedEdges, ...graphEdges.map((edge) => [edge.source, edge.target] as const)].map(([sourceId, targetId]) => {
            const source = positions[sourceId as keyof typeof positions];
            const target = positions[targetId as keyof typeof positions];
            if (!source || !target) return null;
            const key = `${sourceId}->${targetId}`;
            const path = edgePath(sourceId, targetId, source, target);
            return <path key={key} d={path} className={`agent-edge ${activeEdges.has(key) ? "active" : ""}`} markerEnd={`url(#${markerId})`} />;
          })}

          {visibleIds.map((id) => {
            const position = positions[id as keyof typeof positions];
            if (!position || (!dynamicIds.has(id) && !["user_prompt", "client_chat_history", "system_prompt"].includes(id))) return null;
            const label = labels[id] ?? externalLabels[id as keyof typeof externalLabels];
            const state = nodeStates[id] ?? "idle";
            return (
              <g key={id} className={`agent-node ${id} ${state}`} data-node={id}>
                <rect {...position} rx={id === "llm" ? 32 : 12} />
                <text x={position.x + 15} y={position.y + 28} className="agent-node-title">{label.title}</text>
                <text x={position.x + 15} y={position.y + 48} className="agent-node-subtitle">{label.subtitle}</text>
              </g>
            );
          })}
        </svg>
      </div>
      <div className="agent-graph-note">Graph 起点 <code>START → working_memory</code> 在 Harness 中隐藏 START，仅展示真实业务起点。</div>
    </section>
  );
}

function edgePath(
  sourceId: string,
  targetId: string,
  source: { x: number; y: number; width: number; height: number },
  target: { x: number; y: number; width: number; height: number },
): string {
  if (sourceId === "llm" && targetId === "tools") {
    return `M ${source.x + 70} ${source.y + source.height} C ${source.x + 45} 205, ${target.x + 45} 230, ${target.x + 70} ${target.y}`;
  }
  if (sourceId === "tools" && targetId === "llm") {
    return `M ${source.x + 125} ${source.y} C ${source.x + 155} 235, ${target.x + 155} 200, ${target.x + 125} ${target.y + target.height}`;
  }
  const x1 = source.x + source.width;
  const y1 = source.y + source.height / 2;
  const x2 = target.x;
  const y2 = target.y + target.height / 2;
  const middle = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${middle} ${y1}, ${middle} ${y2}, ${x2} ${y2}`;
}
