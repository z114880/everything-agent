import { END, START, Graph, node } from "../engine/src/index.js";
import type { AnyState } from "../engine/src/index.js";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 浏览器执行工作流时使用的初始状态。 */
export function createInitialState(input: string): AnyState {
  return { message: input };
}

/**
 * 本地控制台使用的晨间简报 Graph。
 * 浏览器编辑器会直接读写本文件，执行则始终委托给 Node.js 进程中的 runGraph。
 */
export const graph = new Graph("个人助理 · 晨间简报")
  .addNode(node("理解请求", async (state) => {
    await wait(460);
    return { intent: state.message || "帮我规划今天的工作" };
  }, { kind: "llm" }))

  // 以下三个读取节点没有互相依赖，会在同一个 wave 中并发执行。
  .addNode(node("读取日程", async () => {
    await wait(920);
    return { calendar: ["10:00 产品评审", "15:30 一对一沟通"] };
  }, { kind: "tool" }))
  .addNode(node("检索记忆", async () => {
    await wait(680);
    return { memory: "产品评审前需要确认埋点范围" };
  }, { kind: "tool" }))
  .addNode(node("读取待办", async () => {
    await wait(1180);
    return { tasks: ["回复设计稿反馈", "准备评审材料"] };
  }, { kind: "tool" }))

  .addNode(node("生成简报", async (state) => {
    await wait(740);
    const meetings = state.calendar?.join("、") || "暂无会议";
    const tasks = state.tasks?.join("、") || "暂无待办";
    return { draft: `今天有：${meetings}。建议优先处理：${tasks}。` };
  }, { kind: "agent" }))
  .addNode(node("结果检查", async (state) => {
    await wait(320);
    return { finalAnswer: `早上好。${state.draft} 另外提醒：${state.memory}` };
  }))

  .addEdge(START, "理解请求")
  .addEdge("理解请求", "读取日程")
  .addEdge("理解请求", "检索记忆")
  .addEdge("理解请求", "读取待办")
  .addEdge("读取日程", "生成简报")
  .addEdge("检索记忆", "生成简报")
  .addEdge("读取待办", "生成简报")
  .addEdge("生成简报", "结果检查")
  .addEdge("结果检查", END);

/** 防止浏览器中编辑出的循环无限执行。 */
export const maxSteps = 25;
