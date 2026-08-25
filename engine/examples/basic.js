import { END, START, Graph, node, runGraph } from "../src/index.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 根据用户消息识别意图。
 * 实际项目中这里可以替换为一次 LLM 调用。
 */
async function understandRequest(state) {
  await wait(30);

  let intent = "chat";
  if (state.message.includes("天气")) intent = "weather";
  if (state.message.includes("日程")) intent = "calendar";

  return { intent };
}

/**
 * 模拟读取个人资料。它和意图识别互不依赖，所以会在同一个 wave 中执行。
 */
async function loadProfile() {
  await wait(15);
  return {
    profile: {
      name: "小明",
      city: "上海",
    },
  };
}

/** 模拟从个人记忆中读取最近上下文。 */
async function loadMemory() {
  await wait(10);
  return {
    memory: "用户下午准备骑车出门",
  };
}

const graph = new Graph("个人助理演示")
  // Wave 1：以下三个节点没有互相依赖，因此会并行执行。
  .addNode(node("理解请求", understandRequest, { kind: "llm" }))
  .addNode(node("读取资料", loadProfile, { kind: "tool" }))
  .addNode(node("读取记忆", loadMemory, { kind: "tool" }))

  // Wave 2：准备上下文会等待 Wave 1 的三个节点全部结束。
  .addNode(node("准备上下文", (state) => ({
    contextSummary: `${state.profile.name}位于${state.profile.city}；${state.memory}`,
  })))

  // 天气工具第一次模拟失败，第二次成功，用于展示 maxVisits 有界重试。
  .addNode(node("查询天气", async (state, context) => {
    const attempt = (state.weatherAttempts ?? 0) + 1;

    await context.emit("tool_start", {
      tool: "weather",
      city: state.profile.city,
      attempt,
    });
    await wait(20);

    if (attempt === 1) {
      await context.emit("tool_retry", {
        tool: "weather",
        reason: "模拟的临时网络错误",
      });
      return {
        weatherAttempts: attempt,
        weatherReady: false,
      };
    }

    return {
      weatherAttempts: attempt,
      weatherReady: true,
      weather: "晴，26°C，微风",
    };
  }, {
    kind: "tool",
    maxVisits: 3,
  }))

  .addNode(node("读取日程", async () => {
    await wait(20);
    return {
      calendar: ["14:00 项目讨论", "18:30 骑车"],
    };
  }, { kind: "tool" }))

  .addNode(node("闲聊", () => ({
    chatText: "很高兴见到你，有什么可以帮忙的吗？",
  }), { kind: "llm" }))

  // 所有业务分支最终通过路由跳转到同一个回复节点。
  .addNode(node("生成回复", (state) => {
    if (state.intent === "weather") {
      return {
        reply: `${state.profile.name}，${state.profile.city}今天${state.weather}。`
          + "你下午要骑车，天气很合适。",
      };
    }

    if (state.intent === "calendar") {
      return {
        reply: `${state.profile.name}，今天的日程是：${state.calendar.join("；")}。`,
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

  // 模型只负责把 intent 写入状态，普通代码负责验证并选择执行路径。
  .addRouter("准备上下文", (state) => state.intent, {
    weather: "查询天气",
    calendar: "读取日程",
    chat: "闲聊",
  })

  // 天气尚未就绪时重新访问同一节点，但最多只能访问 maxVisits 次。
  .addRouter("查询天气", (state) => state.weatherReady ? "reply" : "retry", {
    retry: "查询天气",
    reply: "生成回复",
  })
  .addRouter("读取日程", () => "reply", { reply: "生成回复" })
  .addRouter("闲聊", () => "reply", { reply: "生成回复" })
  .addEdge("生成回复", END);

const eventLog = [];
const result = await runGraph(
  graph,
  { message: "上海今天天气怎么样？适合骑车吗？" },
  {
    maxSteps: 15,
    observer(kind, event) {
      eventLog.push({ kind, event });
    },
  },
);

console.log("\n=== Graph 拓扑 ===");
console.dir(graph.describe(), { depth: null });

console.log("\n=== 执行过程 ===");
for (const { kind, event } of eventLog) {
  if (kind === "graph_start") {
    console.log(`[Graph 开始] ${event.graph}（共 ${event.nodes.length} 个节点）`);
  } else if (kind === "node_start") {
    console.log(`[开始] ${event.node}（第 ${event.visit} 次访问）`);
  } else if (kind === "node_end") {
    console.log(`[结束] ${event.node}（${event.ms}ms，写入：${event.keys.join(", ") || "无"}）`);
  } else if (kind === "route") {
    console.log(`[路由] ${event.node} --${event.label}--> ${event.target}`);
  } else if (kind === "tool_start") {
    console.log(`[工具] ${event.tool}，城市：${event.city}，尝试：${event.attempt}`);
  } else if (kind === "tool_retry") {
    console.log(`[重试] ${event.reason}`);
  } else if (kind === "graph_end") {
    const errorText = event.error ? `，错误：${event.error}` : "";
    console.log(`[Graph 结束] ${event.graph}（${event.steps} 步，${event.ms}ms${errorText}）`);
  }
}

console.log("\n=== 最终结果 ===");
console.log("执行路径：", result.path.join(" → "));
console.log("执行步数：", result.steps);
console.log("天气尝试次数：", result.state.weatherAttempts);
console.log("助理回复：", result.state.reply);
