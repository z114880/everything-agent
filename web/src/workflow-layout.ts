import type { Workflow } from "./workflow-api";

export interface PositionedNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GraphLayout {
  width: number;
  height: number;
  nodes: Record<string, PositionedNode>;
}

/** 使用稳定的分层布局把 Graph.describe() 的拓扑放进 SVG。 */
export function layoutWorkflow(workflow: Workflow): GraphLayout {
  const ids = ["START", ...workflow.nodes.map((node) => node.id), "END"];
  const layers: Record<string, number> = { START: 0 };
  for (let pass = 0; pass < ids.length; pass += 1) {
    for (const edge of workflow.edges) {
      layers[edge.target] = Math.max(layers[edge.target] ?? 0, (layers[edge.source] ?? 0) + 1);
    }
  }
  if (layers.END === undefined) layers.END = Math.max(...Object.values(layers)) + 1;

  const columns = new Map<number, string[]>();
  for (const id of ids) {
    const layer = layers[id] ?? 0;
    columns.set(layer, [...(columns.get(layer) ?? []), id]);
  }
  const orderedColumns = [...columns.entries()].sort(([a], [b]) => a - b).map(([, column]) => column);
  const nodeWidth = 174;
  const nodeHeight = 64;
  const gapX = 92;
  const gapY = 30;
  const padding = 30;
  const maxRows = Math.max(...orderedColumns.map((column) => column.length));
  const height = Math.max(160, padding * 2 + maxRows * nodeHeight + (maxRows - 1) * gapY);
  const width = Math.max(720, padding * 2 + orderedColumns.length * nodeWidth + (orderedColumns.length - 1) * gapX);
  const nodes: Record<string, PositionedNode> = {};

  orderedColumns.forEach((column, columnIndex) => {
    const columnHeight = column.length * nodeHeight + (column.length - 1) * gapY;
    column.forEach((id, rowIndex) => {
      nodes[id] = {
        id,
        x: padding + columnIndex * (nodeWidth + gapX),
        y: (height - columnHeight) / 2 + rowIndex * (nodeHeight + gapY),
        width: nodeWidth,
        height: nodeHeight,
      };
    });
  });
  return { width, height, nodes };
}
