import { END, START, Graph, node } from "../src/index.js";
import type { AnyState } from "../src/index.js";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 收件箱分拣工作流的初始状态。 */
export function createInitialState(input: string): AnyState {
  return { message: input };
}

/**
 * 根据消息内容选择处理分支，并生成建议回复。
 * 当前节点只读取内存中的模拟数据，不会发送消息或修改外部收件箱。
 */
export const graph = new Graph("个人助理 · 收件箱分拣")
  .addNode(node("理解消息", async (state) => {
    await wait(420);
    const message = String(state.message || "请尽快确认今天的线上故障处理进展");
    const urgentWords = ["尽快", "紧急", "故障", "阻塞"];
    return {
      normalizedMessage: message.trim(),
      priority: urgentWords.some((word) => message.includes(word)) ? "urgent" : "normal",
    };
  }, { kind: "llm" }))

  .addNode(node("提取联系人", async () => {
    await wait(560);
    return { contact: { name: "项目负责人", relationship: "工作协作" } };
  }, { kind: "tool" }))

  .addNode(node("紧急处理建议", async (state) => {
    await wait(720);
    return {
      handlingAdvice: `立即确认负责人和影响范围，并针对“${state.normalizedMessage}”同步处理进展。`,
    };
  }, { kind: "agent" }))

  .addNode(node("普通处理建议", async (state) => {
    await wait(520);
    return {
      handlingAdvice: `加入今日待回复列表，集中处理“${state.normalizedMessage}”。`,
    };
  }))

  .addNode(node("生成回复草稿", async (state) => {
    await wait(380);
    return {
      finalAnswer: `${state.contact.name}：已收到。${state.handlingAdvice}`,
    };
  }, { kind: "llm" }))

  .addEdge(START, "理解消息")
  .addEdge(START, "提取联系人")
  .addRouter("理解消息", (state) => state.priority, {
    urgent: "紧急处理建议",
    normal: "普通处理建议",
  })
  .addEdge("紧急处理建议", "生成回复草稿")
  .addEdge("普通处理建议", "生成回复草稿")
  .addEdge("提取联系人", "生成回复草稿")
  .addEdge("生成回复草稿", END);

export const maxSteps = 12;
