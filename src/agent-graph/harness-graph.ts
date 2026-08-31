import { END, Graph, START, node } from "../engine/src/index.js";
import type { StateRecord } from "../engine/src/index.js";

/** Agent Harness 中由 Graph 描述的动态阶段名称。 */
export const AGENT_HARNESS_NODES = {
  workingMemory: "working_memory",
  llm: "llm",
  tools: "tools",
  reply: "reply",
} as const;

/**
 * Agent Harness 的静态拓扑。
 *
 * 该 Graph 是可视化的唯一拓扑来源；实际回合仍由 `runAgentLoop` 执行，
 * observer 事件负责把真实阶段映射回这些节点。
 */
export const agentHarnessGraph = new Graph<StateRecord>("agent-harness")
  .addNode(node(AGENT_HARNESS_NODES.workingMemory, () => ({})))
  .addNode(node(AGENT_HARNESS_NODES.llm, () => ({}), { kind: "llm", maxVisits: 10 }))
  .addNode(node(AGENT_HARNESS_NODES.tools, () => ({}), { kind: "tool", maxVisits: 10 }))
  .addNode(node(AGENT_HARNESS_NODES.reply, () => ({})))
  .addEdge(START, AGENT_HARNESS_NODES.workingMemory)
  .addEdge(AGENT_HARNESS_NODES.workingMemory, AGENT_HARNESS_NODES.llm)
  .addRouter(AGENT_HARNESS_NODES.llm, () => "reply", {
    tools: AGENT_HARNESS_NODES.tools,
    reply: AGENT_HARNESS_NODES.reply,
  })
  .addEdge(AGENT_HARNESS_NODES.tools, AGENT_HARNESS_NODES.llm)
  .addEdge(AGENT_HARNESS_NODES.reply, END);

