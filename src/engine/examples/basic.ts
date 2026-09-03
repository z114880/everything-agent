import { END, START, Graph, node, runGraph } from "../../index.ts";
import type { StateRecord } from "../../index.ts";

type AssistantState = StateRecord & {
  message: string;
  intent?: "weather" | "calendar" | "chat";
  profile?: { name: string; city: string };
  memory?: string;
  weatherAttempts?: number;
  weatherReady?: boolean;
  weather?: string;
  calendar?: string[];
  chatText?: string;
  contextSummary?: string;
  reply?: string;
};

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const graph = new Graph<AssistantState>("个人助理演示")
  // Wave 1：以下三个节点没有互相依赖，因此会并行执行。
  .addNode(node<AssistantState>("理解请求", async (state) => {
    await wait(30);
    const intent = state.message.includes("天气")
      ? "weather"
      : state.message.includes("日程") ? "calendar" : "chat";
    return { intent };
  }, { kind: "llm" }))
  .addNode(node<AssistantState>("读取资料", async () => {
    await wait(15);
    return { profile: { name: "小明", city: "上海" } };
  }, { kind: "tool" }))
  .addNode(node<AssistantState>("读取记忆", async () => {
    await wait(10);
    return { memory: "用户下午准备骑车出门" };
  }, { kind: "tool" }))

  // Wave 2：准备上下文会等待 Wave 1 的三个节点全部结束。
  .addNode(node<AssistantState>("准备上下文", (state) => ({
    contextSummary: `${state.profile?.name}位于${state.profile?.city}；${state.memory}`,
  })))

  // 天气工具第一次模拟失败，第二次成功，用于展示 maxVisits 有界重试。
  .addNode(node<AssistantState>("查询天气", async (state, context) => {
    const attempt = (state.weatherAttempts ?? 0) + 1;
    await context.emit("tool_start", {
      tool: "weather",
      city: state.profile?.city,
      attempt,
    });
    await wait(20);

    if (attempt === 1) {
      await context.emit("tool_retry", {
        tool: "weather",
        reason: "模拟的临时网络错误",
      });
      return { weatherAttempts: attempt, weatherReady: false };
    }

    return {
      weatherAttempts: attempt,
      weatherReady: true,
      weather: "晴，26°C，微风",
    };
  }, { kind: "tool", maxVisits: 3 }))
  .addNode(node<AssistantState>("读取日程", async () => {
    await wait(20);
    return { calendar: ["14:00 项目讨论", "18:30 骑车"] };
  }, { kind: "tool" }))
  .addNode(node<AssistantState>("闲聊", () => ({
    chatText: "很高兴见到你，有什么可以帮忙的吗？",
  }), { kind: "llm" }))
  .addNode(node<AssistantState>("生成回复", (state) => {
    if (state.intent === "weather") {
      return {
        reply: `${state.profile?.name}，${state.profile?.city}今天${state.weather}。你下午要骑车，天气很合适。`,
      };
    }
    if (state.intent === "calendar") {
      return {
        reply: `${state.profile?.name}，今天的日程是：${state.calendar?.join("；")}。`,
      };
    }
    return { reply: state.chatText };
  }, { kind: "llm" }))
  .addEdge(START, "理解请求")
  .addEdge(START, "读取资料")
  .addEdge(START, "读取记忆")
  .addEdge("理解请求", "准备上下文")
  .addEdge("读取资料", "准备上下文")
  .addEdge("读取记忆", "准备上下文")
  .addRouter("准备上下文", (state) => state.intent ?? "chat", {
    weather: "查询天气",
    calendar: "读取日程",
    chat: "闲聊",
  })
  .addRouter("查询天气", (state) => state.weatherReady ? "reply" : "retry", {
    retry: "查询天气",
    reply: "生成回复",
  })
  .addRouter("读取日程", () => "reply", { reply: "生成回复" })
  .addRouter("闲聊", () => "reply", { reply: "生成回复" })
  .addEdge("生成回复", END);

const eventKinds: string[] = [];
const result = await runGraph(
  graph,
  { message: "上海今天天气怎么样？适合骑车吗？" },
  {
    maxSteps: 15,
    observer(kind) {
      eventKinds.push(kind);
    },
  },
);

console.log("\n=== Graph 拓扑 ===");
console.dir(graph.describe(), { depth: null });
console.log("\n=== 执行事件 ===");
console.log(eventKinds.join(" → "));
console.log("\n=== 最终结果 ===");
console.log("执行路径：", result.path.join(" → "));
console.log("执行步数：", result.steps);
console.log("天气尝试次数：", result.state.weatherAttempts);
console.log("助理回复：", result.state.reply);
