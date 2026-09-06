import { useId } from "react";
import type { Workflow } from "../workflow-api";
import type { VisualNodeState } from "./GraphCanvas";

interface AgentHarnessCanvasProps {
  workflow: Workflow;
  nodeStates: Record<string, VisualNodeState>;
  activeEdges: Set<string>;
}

/** 展示服务端 Graph 提供的业务节点与边，后台关系不推断为聊天执行状态。 */
export function AgentHarnessCanvas({ workflow, nodeStates, activeEdges }: AgentHarnessCanvasProps) {
  const markerId = useId().replaceAll(":", "");
  const nodes = workflow.nodes.filter((node) => node.id !== "START" && node.id !== "END");
  const positions = new Map(nodes.map((node, index) => [node.id, node.presentation ?? { x: 24 + index % 5 * 220, y: 85 + Math.floor(index / 5) * 105 }]));
  return <div className="business-graph-scroll">
      <svg viewBox="0 0 1110 905" style={{ width: "100%", minWidth: 850 }} className="agent-harness-svg" role="img" aria-label="Agent 与 Memory 业务流程图">
        <defs><marker id={markerId} viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" className="arrow-head" /></marker></defs>
        <rect x="8" y="20" width="1090" height="477" rx="16" className="agent-loop-box" />
        <text x="24" y="47" className="agent-loop-label">Memory Retrieval &amp; Agent Loop</text>
        <rect x="8" y="520" width="1090" height="215" rx="16" className="agent-loop-box" />
        <text x="24" y="545" className="agent-loop-label">后台写入 · 独立串行队列，不阻塞回复</text>
        <rect x="8" y="755" width="1090" height="130" rx="16" className="agent-loop-box" />
        <text x="24" y="780" className="agent-loop-label">Dreaming / Consolidation</text>
        {workflow.edges.map((edge) => {
          const source = positions.get(edge.source), target = positions.get(edge.target);
          if (!source || !target) return null;
          const key = `${edge.source}->${edge.target}`;
          let x1 = source.x + 164, y1 = source.y + 25, x2 = target.x, y2 = target.y + 25;
          let path: string, lx: number, ly: number;
          if (edge.source === "llm" && edge.target === "tools") {
            x1 = source.x; x2 = target.x + 164; y1 -= 12; y2 -= 12;
          }
          if (edge.source === "tools" && edge.target === "llm") { y1 += 12; y2 += 12; }
          if (source.x === target.x) {
            x1 = source.x + 82; x2 = x1; y1 = source.y + 50; y2 = target.y;
            path = `M ${x1} ${y1} L ${x2} ${y2}`; lx = x1 + 40; ly = (y1 + y2) / 2;
          } else if (edge.target === "working_memory" && ["user_prompt", "session_chat_history", "retrieval_gate"].includes(edge.source)) {
            // 输入依赖走节点之间的空隙，不穿过召回卡片。
            const lane = edge.source === "user_prompt" ? 60 : edge.source === "session_chat_history" ? 265 : 160;
            x1 = source.x + 82; y1 = edge.source === "user_prompt" ? source.y : source.y + 50;
            x2 = target.x + (edge.source === "user_prompt" ? 140 : edge.source === "retrieval_gate" ? 110 : 50); y2 = target.y;
            path = `M ${x1} ${y1} V ${lane} H ${x2} V ${y2}`; lx = (x1 + x2) / 2; ly = lane - 7;
          } else if (edge.target === "memory_queue") {
            x1 = source.x + 82; y1 = source.y + 50; x2 = target.x + 82; y2 = target.y;
            path = `M ${x1} ${y1} V 485 H ${x2} V ${y2}`; lx = (x1 + x2) / 2; ly = 478;
          } else {
            const mid = (x1 + x2) / 2;
            path = `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`; lx = mid; ly = (y1 + y2) / 2 - 7;
          }
          return <g key={key} data-edge={key}><path d={path} className={`agent-edge ${activeEdges.has(key) ? "active" : ""}`} markerEnd={`url(#${markerId})`} /><text x={lx} y={ly} textAnchor="middle" className="harness-edge-label">{edge.label}</text></g>;
        })}
        {nodes.map((node) => {
          const position = positions.get(node.id)!;
          return <g key={node.id} className={`agent-node ${nodeStates[node.id] ?? "idle"}`} data-node={node.id}><title>{`${node.label}：${node.presentation?.subtitle ?? ""}`}</title><rect x={position.x} y={position.y} width="164" height="50" rx="9" /><text x={position.x + 10} y={position.y + 21} className="agent-node-title">{node.label}</text><text x={position.x + 10} y={position.y + 39} className="agent-node-subtitle">{node.presentation?.subtitle}</text></g>;
        })}
      </svg>
  </div>;
}
