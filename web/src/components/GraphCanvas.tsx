import { Braces, Cpu, GitBranch, Wrench } from "lucide-react";
import { useId, useMemo } from "react";
import { layoutWorkflow } from "../workflow-layout";
import type { NodeKind, Workflow } from "../workflow-api";

export type VisualNodeState = "idle" | "running" | "done" | "error";

interface GraphCanvasProps {
  workflow: Workflow;
  nodeStates: Record<string, VisualNodeState>;
  activeEdges: Set<string>;
}

const kindLabel: Record<NodeKind, string> = {
  llm: "模型调用",
  tool: "工具",
  agent: "Agent Loop",
  fn: "函数",
};

const kindIcon = {
  llm: Cpu,
  tool: Wrench,
  agent: GitBranch,
  fn: Braces,
};

export function GraphCanvas({ workflow, nodeStates, activeEdges }: GraphCanvasProps) {
  const layout = useMemo(() => layoutWorkflow(workflow), [workflow]);
  const displayWidth = Math.min(layout.width, 1120);
  const displayHeight = Math.round(layout.height * displayWidth / layout.width);
  const markerId = useId().replaceAll(":", "");
  const nodeById = new Map(workflow.nodes.map((node) => [node.id, node]));

  return (
    <section className="panel overflow-hidden">
      <div className="panel-header">
        <div>
          <div className="flex items-center gap-2"><GitBranch size={15} /> 动态拓扑</div>
          <p className="mt-1 text-[11px] font-normal text-[var(--muted)]">由当前代码生成 · 节点会随执行状态实时变化</p>
        </div>
        <span className="status-pill">{workflow.nodes.length} 个节点 · {workflow.edges.length} 条边</span>
      </div>
      <div className="graph-scroll">
        <svg
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          className="graph-svg"
          style={{ width: displayWidth, height: displayHeight }}
          role="img"
          aria-label="工作流动态图"
        >
          <defs>
            <marker id={markerId} viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" className="arrow-head" />
            </marker>
          </defs>
          {workflow.edges.map((edge) => {
            const source = layout.nodes[edge.source];
            const target = layout.nodes[edge.target];
            if (!source || !target) return null;
            const x1 = source.x + source.width;
            const y1 = source.y + source.height / 2;
            const x2 = target.x;
            const y2 = target.y + target.height / 2;
            const middle = (x1 + x2) / 2;
            const key = `${edge.source}->${edge.target}`;
            return (
              <g key={key}>
                <path
                  d={`M ${x1} ${y1} C ${middle} ${y1}, ${middle} ${y2}, ${x2} ${y2}`}
                  className={`graph-edge ${edge.conditional ? "conditional" : ""} ${activeEdges.has(key) ? "active" : ""}`}
                  markerEnd={`url(#${markerId})`}
                />
              </g>
            );
          })}
          {Object.values(layout.nodes).map((position) => {
            const node = nodeById.get(position.id);
            const isBoundary = position.id === "START" || position.id === "END";
            const state = nodeStates[position.id] ?? "idle";
            const Icon = node ? kindIcon[node.kind] : null;
            return (
              <g key={position.id} className={`graph-node ${state}`}>
                <rect x={position.x} y={position.y} width={position.width} height={position.height} rx={isBoundary ? 32 : 11} />
                {isBoundary ? (
                  <text x={position.x + position.width / 2} y={position.y + 38} textAnchor="middle" className="boundary-label">{position.id}</text>
                ) : (
                  <>
                    {Icon && <Icon x={position.x + 14} y={position.y + 15} width={14} height={14} />}
                    <text x={position.x + 36} y={position.y + 27} className="node-label">{node?.label}</text>
                    <text x={position.x + 15} y={position.y + 48} className="node-description">{kindLabel[node!.kind]}</text>
                  </>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </section>
  );
}
