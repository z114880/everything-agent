import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { agentHarnessGraph, harnessPresentation, harnessEdgeLabels, describeHarnessRetrieval } from "../../src/agent-graph/harness-graph.ts";
import { AgentHarnessCanvas } from "../src/pages/agent/AgentHarnessCanvas";

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
    expect(html).not.toContain("Session Chat History");
    expect(html).toContain("Current Session");
    expect(html).toContain("当前会话");
    expect(html).toContain("最近 3 个已完成回合");
    expect(html).toContain("全部已完成回合");
    expect(html).toContain("EVERYTHING.md");
    expect(html).toContain("Skills Catalog");
    expect(html).toContain("Procedural Memory");
    expect(html).toContain("Tool Schemas");
    expect(html).not.toContain("System Prompt");
    for (const subtitle of ["用户输入", "System instructions", "Instructions + available skills", "Names &amp; descriptions", "assembled per turn"]) {
      expect(html).toContain(subtitle);
    }
    expect(html).not.toContain("Context budget");
    expect(harnessPresentation.tool_schemas).toMatchObject({
      x: harnessPresentation.procedural_memory!.x,
      y: expect.any(Number),
    });
    expect(harnessPresentation.procedural_memory!.y).toBe(
      harnessPresentation.everything_md!.y,
    );
    expect(harnessPresentation.tool_schemas!.y).toBeGreaterThan(
      harnessPresentation.procedural_memory!.y,
    );
    expect(harnessPresentation.skills_catalog!.y).toBe(
      harnessPresentation.tool_schemas!.y,
    );
    expect(html).toContain('data-edge="tool_schemas-&gt;working_memory"');
    expect(html).toContain('d="M 326 460 V 420 H 729 V 395"');
    expect(html).toContain('data-edge="session_chat_history-&gt;working_memory"');
    expect(html).toContain('d="M 106 290 V 315 H 729 V 345"');
    expect(html).toContain('data-edge="retrieval_gate-&gt;working_memory"');
    expect(html).toContain('d="M 326 135 V 105 H 766 V 345"');
    expect(html).toContain('data-edge="user_prompt-&gt;working_memory"');
    expect(html).toContain('d="M 106 135 V 75 H 803 V 345"');
    expect(html).toContain("后台写入 · 独立串行队列，不阻塞回复");
    expect(html).toContain("Memory Retrieval &amp; Agent Loop");
    expect(html).toContain("记忆任务入队");
    expect(html).toContain("Consolidation / Dreaming");
    expect(html).not.toContain("Background Memory");
    expect(html).not.toContain("Memory Queue");
    expect(html).toContain('agent-node running');
    expect(html).toContain('agent-edge active');
    expect(html.match(/<rect x="1"[^>]*width="1108"[^>]*class="agent-loop-box"/g)).toHaveLength(3);
    expect(html).toContain('viewBox="0 19 1110 882"');
    expect(html).toContain('<rect x="1" y="570" width="1108" height="180"');
    expect(html).toContain('<rect x="1" y="770" width="1108" height="130"');
    expect(harnessPresentation.consolidate_trigger!.y).toBe(815);
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
