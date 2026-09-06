import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { agentHarnessGraph, harnessPresentation, harnessEdgeLabels, describeHarnessRetrieval } from "../../src/agent-graph/harness-graph.ts";
import { AgentHarnessCanvas } from "../src/components/AgentHarnessCanvas";

function workflow() {
  const graph = agentHarnessGraph.describe();
  return { name: graph.name, nodes: graph.nodes.map((node) => ({ id: node.name, label: harnessPresentation[node.name]!.title, kind: node.kind, maxVisits: node.maxVisits, presentation: harnessPresentation[node.name]! })), edges: graph.edges.map((edge) => ({ ...edge, label: harnessEdgeLabels[`${edge.source}->${edge.target}`]! })) };
}

describe("Agent 业务画布", () => {
  it("从 Graph 渲染所有业务节点和边说明，隐藏边界且不额外拼接输入", () => {
    const graph = workflow();
    const html = renderToStaticMarkup(<AgentHarnessCanvas workflow={graph} nodeStates={{ retrieval_gate: "running" }} activeEdges={new Set(["user_prompt->retrieval_gate"])} />);
    for (const node of graph.nodes) expect(html.split(`data-node="${node.id}"`)).toHaveLength(2);
    for (const edge of graph.edges.filter((edge) => edge.source !== "START" && edge.target !== "END")) {
      expect(edge.label).toBeTruthy();
      expect(html).toContain(edge.label);
    }
    expect(html).not.toContain('data-node="START"');
    expect(html).not.toContain('data-node="END"');
    expect(html).not.toContain("Client Chat History");
    expect(html).toContain("Session Chat History");
    expect(html).toContain("后台写入 · 独立串行队列，不阻塞回复");
    expect(html).toContain("Memory Retrieval &amp; Agent Loop");
    expect(html).toContain("记忆任务入队");
    expect(html).toContain("Dreaming / Consolidation");
    expect(html).not.toContain("Background Memory");
    expect(html).not.toContain("Memory Queue");
    expect(html).toContain('agent-node running');
    expect(html).toContain('agent-edge active');
  });
  it("服务端移除节点时不在前端恢复固定节点", () => {
    const graph = workflow();
    graph.nodes = graph.nodes.filter((node) => node.id !== "user_prompt");
    const html = renderToStaticMarkup(<AgentHarnessCanvas workflow={graph} nodeStates={{}} activeEdges={new Set()} />);
    expect(html).not.toContain('data-node="user_prompt"');
    expect(html).not.toContain('data-edge="user_prompt');
  });
});

it.each(["lexical_only", "dense_only", "hybrid"] as const)("流程图按 %s 标明事实召回，历史对话保持 FTS", (mode) => {
  const graph = workflow();
  const presentation = describeHarnessRetrieval(mode);
  graph.nodes = graph.nodes.map((node) => ({ ...node, presentation: presentation[node.id]! }));
  const html = renderToStaticMarkup(<AgentHarnessCanvas workflow={graph} nodeStates={{}} activeEdges={new Set()} />);
  expect(html).toContain("FTS5 + BM25 · 排除当前会话");
  expect(html.includes("Hybrid · RRF + MMR")).toBe(mode === "hybrid");
  expect(html).not.toContain("BM25 + Dense → RRF 融合 → MMR 去重");
  expect(html.includes("Dense · 相似度过滤")).toBe(mode === "dense_only");
});

it("画布精简标题、说明、缩放和记忆提交文案", () => {
  const html = renderToStaticMarkup(<AgentHarnessCanvas workflow={workflow()} nodeStates={{}} activeEdges={new Set()} />);
  for (const text of ["Agent Graph · 业务流程", "拓扑来自", "连线表示", "缩小流程图", "放大流程图", "事务提交 / 跳过", "检索旧记忆并判断"]) expect(html).not.toContain(text);
  expect(html).toContain("检索旧semantic memory");
  expect(html).toContain("事务提交");
});
