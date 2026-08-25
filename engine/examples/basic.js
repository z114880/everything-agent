import { END, START, Graph, loop, node } from "../src/index.js";

const graph = new Graph("问候流程")
  .addNode(node("读取用户", async (state) => ({
    normalizedName: state.name.trim(),
  })))
  .addNode(node("生成问候", async (state) => ({
    greeting: `你好，${state.normalizedName}！`,
  })))
  .addEdge(START, "读取用户")
  .addEdge("读取用户", "生成问候")
  .addEdge("生成问候", END);

console.log("拓扑:", graph.describe());
console.log("结果:", await loop(graph, { name: " Waku " }));
