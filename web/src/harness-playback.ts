import type { AgentEvent } from "./agent-api";
import type { VisualNodeState } from "./components/GraphCanvas";

/** 只用真实 observer 事件推进记忆节点；没有后台事件时保持后台区域空闲。 */
export function advanceHarnessMemory(kind: string, event: AgentEvent, states: Record<string, VisualNodeState>): { states: Record<string, VisualNodeState>; edges: string[] } {
  const next = { ...states };
  const edges: string[] = [];
  if (kind === "gate_start") {
    next.retrieval_gate = "running";
    edges.push("user_prompt->retrieval_gate", "session_chat_history->retrieval_gate");
  }
  if (kind === "gate_end") {
    next.retrieval_gate = "done";
    if (event.intent === "none") edges.push("retrieval_gate->working_memory");
    if (event.intent === "past_episode" || event.intent === "fact_with_evidence") {
      next.session_recall = "running";
      edges.push("retrieval_gate->session_recall");
    }
    if (event.intent === "fact_with_evidence") {
      next.semantic_recall = "running";
      edges.push("retrieval_gate->semantic_recall");
    }
  }
  if (kind === "retrieval_completed") {
    for (const id of ["semantic_recall", "session_recall"]) if (next[id] === "running") {
      next[id] = "done";
      edges.push(`${id}->working_memory`);
    }
  }
  if (kind === "context_assembled") {
    for (const id of ["user_prompt", "session_chat_history", "system_prompt", "procedural_memory", "working_memory"]) next[id] = "done";
    edges.push("procedural_memory->system_prompt", "user_prompt->working_memory", "session_chat_history->working_memory", "system_prompt->working_memory");
  }
  if (kind === "tool_completed" && event.tool === "manage_memory" && !event.isError && event.result && typeof event.result === "object" && "status" in event.result && event.result.status === "queued") {
    next.memory_queue = "done";
    edges.push("tools->memory_queue");
  }
  const consolidateNodes = ["consolidate_trigger", "consolidate_snapshot", "consolidation", "consolidate_commit", "consolidate_result"];
  if (kind.startsWith("consolidation_")) {
    if (kind === "consolidation_started") {
      for (const id of consolidateNodes) next[id] = "idle";
      next.consolidate_trigger = "done"; next.consolidate_snapshot = "running";
      edges.push("consolidate_trigger->consolidate_snapshot");
    }
    if (kind === "consolidation_batch_started") {
      next.consolidate_snapshot = "running"; next.consolidation = "idle"; next.consolidate_commit = "idle";
    }
    if (kind === "consolidation_snapshot") next.consolidate_snapshot = "done";
    if (kind === "consolidation_model_started") {
      next.consolidation = "running"; edges.push("consolidate_snapshot->consolidation");
    }
    if (kind === "consolidation_model_completed") next.consolidation = "done";
    if (kind === "consolidation_model_failed") next.consolidation = "error";
    if (kind === "consolidation_reviewed") {
      next.consolidate_snapshot = "done";
      next.consolidate_commit = "running";
      edges.push("consolidation->consolidate_commit");
    }
    if (kind === "consolidation_batch_completed") {
      next.consolidate_commit = "done"; next.consolidate_result = "running";
      edges.push("consolidate_commit->consolidate_result");
    }
    if (kind === "consolidation_completed") {
      for (const id of consolidateNodes) if (next[id] === "running") next[id] = "done";
      next.consolidate_result = "done";
    }
    if (kind === "consolidation_failed" || kind === "consolidation_retry" || kind === "consolidation_batch_failed") {
      for (const id of consolidateNodes) if (next[id] === "running") next[id] = "error";
      next.consolidate_result = "error";
    }
    return { states: next, edges };
  }
  if (kind === "memory_task_started") {
    for (const id of ["memory_queue", "memory_review", "memory_commit", "semantic_store"]) next[id] = "idle";
    next.memory_queue = "done"; next.memory_review = "running";
    edges.push("memory_queue->memory_review");
  }
  if (kind === "memory_candidate_extracted" || kind === "memory_conflict") {
    next.memory_review = "running"; next.memory_commit = "idle"; next.semantic_store = "idle";
  }
  if (kind === "memory_decision_completed") {
    next.memory_review = "done"; next.memory_commit = "running";
    edges.push("memory_review->memory_commit");
  }
  if (kind === "memory_change_completed" || kind === "memory_change_replayed") {
    next.memory_review = "done"; next.memory_commit = "done"; next.semantic_store = "done";
    edges.push("memory_commit->semantic_store");
  }
  if (["memory_change_failed", "memory_task_failed", "memory_task_retry"].includes(kind)) {
    for (const id of ["memory_review", "memory_commit"]) if (next[id] === "running") next[id] = "error";
  }
  return { states: next, edges };
}
