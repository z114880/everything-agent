import { END, START, Graph, node } from "../engine/src/index.js";
import type { AnyState } from "../engine/src/index.js";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 会议准备工作流的初始状态。 */
export function createInitialState(input: string): AnyState {
  return { message: input };
}

/**
 * 并行收集会议上下文，再生成会前检查清单。
 * 当前工具节点返回固定的本地数据，不会读取或修改真实日历与联系人。
 */
export const graph = new Graph("个人助理 · 会议准备")
  .addNode(node("识别会议目标", async (state) => {
    await wait(440);
    return { meetingGoal: state.message || "准备产品评审会议" };
  }, { kind: "llm" }))

  // 三个节点在同一 wave 并发执行，用于展示真实的 Engine 并发语义。
  .addNode(node("读取会议议程", async () => {
    await wait(860);
    return { agenda: ["确认目标", "评审方案", "明确后续行动"] };
  }, { kind: "tool" }))
  .addNode(node("读取参会人", async () => {
    await wait(610);
    return { attendees: ["产品负责人", "设计负责人", "研发负责人"] };
  }, { kind: "tool" }))
  .addNode(node("检索相关记忆", async () => {
    await wait(740);
    return { relatedMemory: "上次评审遗留问题：需要补充异常流程说明" };
  }, { kind: "tool" }))

  .addNode(node("整理准备清单", async (state) => {
    await wait(680);
    return {
      checklist: [
        `围绕“${state.meetingGoal}”确认预期结论`,
        `按议程准备：${state.agenda.join("、")}`,
        `关注参会角色：${state.attendees.join("、")}`,
        state.relatedMemory,
      ],
    };
  }, { kind: "agent" }))

  .addNode(node("输出会前摘要", async (state) => {
    await wait(300);
    return { finalAnswer: `会前准备清单：\n- ${state.checklist.join("\n- ")}` };
  }))

  .addEdge(START, "识别会议目标")
  .addEdge("识别会议目标", "读取会议议程")
  .addEdge("识别会议目标", "读取参会人")
  .addEdge("识别会议目标", "检索相关记忆")
  .addEdge("读取会议议程", "整理准备清单")
  .addEdge("读取参会人", "整理准备清单")
  .addEdge("检索相关记忆", "整理准备清单")
  .addEdge("整理准备清单", "输出会前摘要")
  .addEdge("输出会前摘要", END);

export const maxSteps = 12;
