import { END, Graph, START, node } from "../engine/src/index.ts";
import type { StateRecord } from "../engine/src/index.ts";

/** observer 使用的核心回合节点名称。 */
export const AGENT_HARNESS_NODES = {
  workingMemory: "working_memory", llm: "llm", tools: "tools", reply: "reply",
} as const;

/** 业务展示元数据；位置不参与执行语义。 */
export const harnessPresentation: Record<string, { title: string; subtitle: string; x: number; y: number }> = {
  user_prompt: { title: "User Prompt", subtitle: "", x: 24, y: 85 },
  session_chat_history: { title: "Session Chat History", subtitle: "Current session", x: 24, y: 190 },
  procedural_memory: { title: "Procedural Memory", subtitle: "EVERYTHING.md", x: 24, y: 295 },
  system_prompt: { title: "System Prompt", subtitle: "", x: 244, y: 295 },
  retrieval_gate: { title: "Retrieval Gate", subtitle: "小模型 · 代码验证检索意图", x: 244, y: 85 },
  semantic_recall: { title: "Semantic Recall", subtitle: "Semantic Memory", x: 464, y: 85 },
  session_recall: { title: "Session Recall", subtitle: "FTS5 + BM25", x: 464, y: 190 },
  working_memory: { title: "Working Memory", subtitle: "Context budget", x: 684, y: 295 },
  llm: { title: "LLM", subtitle: "理解需求 · 决定下一步", x: 684, y: 410 },
  tools: { title: "Tools", subtitle: "受控调用 · 参数验证", x: 464, y: 410 },
  reply: { title: "Reply", subtitle: "流式输出", x: 904, y: 410 },
  memory_queue: { title: "记忆任务入队", subtitle: "manage_memory · 返回任务 ID", x: 244, y: 570 },
  consolidate_trigger: { title: "Consolidate", subtitle: "每日首次使用 / 手动触发", x: 24, y: 800 },
  consolidate_snapshot: { title: "全量事实与分批", subtitle: "Semantic Facts · 上下文预算", x: 244, y: 800 },
  consolidation: { title: "模型整理", subtitle: "去重 / 合并 / 冲突 / 清理", x: 464, y: 800 },
  consolidate_commit: { title: "校验并提交", subtitle: "版本检查 · 直接替换旧事实", x: 684, y: 800 },
  consolidate_result: { title: "整理结果", subtitle: "批次进度 / 冲突 / 错误", x: 904, y: 800 },
  memory_review: { title: "检索旧semantic memory", subtitle: "小模型 · 合并 / 更新 / 忘记", x: 464, y: 625 },
  memory_commit: { title: "校验并保存", subtitle: "证据与版本校验 · 审计", x: 684, y: 625 },
  semantic_store: { title: "Semantic Memory", subtitle: "新增 / 更新 / 删除 / 合并 / 跳过", x: 904, y: 625 },
};

/** 边的业务说明，与拓扑在同一声明处维护。 */
export const harnessEdgeLabels: Record<string, string> = {};

/** 静态业务关系图；真实回合与后台队列分别执行，不用 runGraph 调度此展示图。 */
export const agentHarnessGraph = new Graph<StateRecord>("agent-harness");
for (const id of Object.keys(harnessPresentation)) {
  agentHarnessGraph.addNode(node(id, () => ({}), {
    kind: ["llm", "retrieval_gate", "memory_review", "consolidation"].includes(id) ? "llm" : id === "tools" ? "tool" : "fn",
    maxVisits: ["llm", "tools"].includes(id) ? 10 : 1,
  }));
}
const connections = [
  [START, "user_prompt", "提交"],
  ["user_prompt", "retrieval_gate", "当前问题"],
  ["session_chat_history", "retrieval_gate", "最近 3 回合"],
  ["user_prompt", "working_memory", "本轮输入"],
  ["session_chat_history", "working_memory", "完整历史"],
  ["procedural_memory", "system_prompt", "加载规则"],
  ["system_prompt", "working_memory", "系统指令"],
  ["retrieval_gate", "semantic_recall", "事实及证据"],
  ["retrieval_gate", "session_recall", "历史 / 事实证据"],
  ["retrieval_gate", "working_memory", "无需检索"],
  ["semantic_recall", "working_memory", "长期事实"],
  ["session_recall", "working_memory", "历史证据"],
  ["working_memory", "llm", "上下文就绪"],
  ["llm", "tools", "调用工具"],
  ["tools", "llm", "工具结果"],
  ["llm", "reply", "生成回复"],
  ["tools", "memory_queue", "提交记忆 · 异步"],
  ["memory_queue", "memory_review", "串行处理"],
  ["memory_review", "memory_commit", "五类决策"],
  ["memory_commit", "semantic_store", "事务提交"],
  ["consolidate_trigger", "consolidate_snapshot", "后台入队"],
  ["consolidate_snapshot", "consolidation", "全量 / 分批"],
  ["consolidation", "consolidate_commit", "结构化建议"],
  ["consolidate_commit", "consolidate_result", "审计与汇总"],
  ["reply", END, "完成"],
] as const;
for (const [source, target, label] of connections) {
  if (source !== "llm") agentHarnessGraph.addEdge(source, target);
  harnessEdgeLabels[`${source}->${target}`] = label;
}
// 条件出口沿用 Graph 的路由描述；实际选择由 Agent Loop 验证执行。
agentHarnessGraph.addRouter("llm", () => "reply", { tools: "tools", reply: "reply" });

/** 按实际检索配置标注召回节点；历史对话始终走 FTS，不伪造向量路径。 */
export function describeHarnessRetrieval(mode: "lexical_only" | "dense_only" | "hybrid"): typeof harnessPresentation {
  return {
    ...harnessPresentation,
    semantic_recall: { ...harnessPresentation.semantic_recall!, subtitle: {
      lexical_only: "FTS5 + BM25", dense_only: "Dense · 相似度过滤", hybrid: "Hybrid · RRF + MMR",
    }[mode] },
    session_recall: { ...harnessPresentation.session_recall!, subtitle: "FTS5 + BM25 · 排除当前会话" },
  };
}
