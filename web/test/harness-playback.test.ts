import { describe, expect, it } from "vitest";
import { advanceHarnessMemory } from "../src/harness-playback";

describe("记忆流程事件映射", () => {
  it("无需检索时不点亮召回节点", () => {
    const start = advanceHarnessMemory("gate_start", {}, {});
    expect(start.states.retrieval_gate).toBe("running");
    const end = advanceHarnessMemory("gate_end", { intent: "none" }, start.states);
    expect(end.edges).toEqual(["retrieval_gate->working_memory"]);
    expect(end.states.session_recall).toBeUndefined();
    expect(advanceHarnessMemory("retrieval_completed", {}, end.states).edges).toEqual([]);
  });
  it.each(["past_episode", "fact_with_evidence"] as const)("按 %s 标记实际召回分支并在完成后流入上下文", (intent) => {
    const gate = advanceHarnessMemory("gate_end", { intent }, {});
    expect(gate.states.session_recall).toBe("running");
    expect(gate.states.semantic_recall).toBe(intent === "fact_with_evidence" ? "running" : undefined);
    const completed = advanceHarnessMemory("retrieval_completed", {}, gate.states);
    expect(completed.states.session_recall).toBe("done");
    expect(completed.edges).toContain("session_recall->working_memory");
    expect(gate.states.session_recall).toBe("running");
  });
  it("已入队不意味着后台判断或保存完成", () => {
    const result = advanceHarnessMemory("tool_completed", { tool: "manage_memory", result: { status: "queued", taskId: "task-1" } }, {});
    expect(result.states).toEqual({ memory_queue: "done" });
    expect(result.edges).toEqual(["tools->memory_queue"]);
    expect(advanceHarnessMemory("tool_completed", { tool: "manage_memory", result: [] }, {}).edges).toEqual([]);
  });
  it("上下文事件标记真实输入来源完成", () => {
    expect(advanceHarnessMemory("context_assembled", {}, {}).states).toMatchObject({ session_chat_history: "done", procedural_memory: "done", working_memory: "done" });
  });
});

it("后台任务开始会点亮判断节点和入队连线", () => {
  const result = advanceHarnessMemory("memory_task_started", {}, {});
  expect(result.states.memory_review).toBe("running");
  expect(result.edges).toContain("memory_queue->memory_review");
});

it("后台决策保存成功才点亮长期记忆库，失败不显示成功", () => {
  const started = advanceHarnessMemory("memory_task_started", {}, {});
  const decision = advanceHarnessMemory("memory_decision_completed", {}, started.states);
  expect(decision.states).toMatchObject({ memory_review: "done", memory_commit: "running" });
  expect(decision.edges).toEqual(["memory_review->memory_commit"]);
  const failed = advanceHarnessMemory("memory_change_failed", {}, decision.states);
  expect(failed.states.memory_commit).toBe("error");
  expect(failed.states.semantic_store).toBe("idle");
  const completed = advanceHarnessMemory("memory_change_completed", {}, decision.states);
  expect(completed.states.semantic_store).toBe("done");
  expect(completed.edges).toEqual(["memory_commit->semantic_store"]);
});
it("整理独立推进，不点亮聊天记忆写入节点", () => {
  const event = {};
  const started = advanceHarnessMemory("consolidation_started", event, {});
  expect(started.edges).toEqual(["consolidate_trigger->consolidate_snapshot"]);
  const batch = advanceHarnessMemory("consolidation_batch_started", event, started.states);
  expect(batch.edges).toEqual([]);
  expect(batch.states.consolidate_snapshot).toBe("running");
  const model = advanceHarnessMemory("consolidation_model_started", event, batch.states);
  expect(model.edges).toEqual(["consolidate_snapshot->consolidation"]);
  const reviewed = advanceHarnessMemory("consolidation_reviewed", event, batch.states);
  expect(reviewed.edges).toEqual(["consolidation->consolidate_commit"]);
  const committed = advanceHarnessMemory("consolidation_batch_completed", event, reviewed.states);
  expect(committed.edges).toEqual(["consolidate_commit->consolidate_result"]);
  expect(committed.states).not.toHaveProperty("memory_review");
  expect(advanceHarnessMemory("consolidation_completed", event, committed.states).states.consolidate_result).toBe("done");
  expect(advanceHarnessMemory("consolidation_failed", event, reviewed.states).states.consolidate_commit).toBe("error");
});

it("空库整理完成不伪造模型调用完成状态", () => {
  const event = {};
  const started = advanceHarnessMemory("consolidation_started", event, {});
  const completed = advanceHarnessMemory("consolidation_completed", event, started.states);
  expect(completed.states.consolidation).toBe("idle");
  expect(completed.states.consolidate_result).toBe("done");
});
