# Everything Agent Engine

一个轻量、可观察的 Node.js Graph Engine。它没有运行时依赖，核心只有五个概念：

- `State`：一次运行的共享黑板；节点读取快照并返回增量。
- `Node`：`handler(state, context) -> update`，同步和异步函数都支持。
- `Graph`：声明节点、普通边和条件路由。
- `describe`：从真实 Graph 生成可序列化拓扑，避免文档与代码漂移。
- `loop`：按波次并发执行就绪节点，合并状态并推进图。

## 快速开始

```js
import { END, START, Graph, loop, node } from "everything-agent";

const graph = new Graph("demo")
  .addNode(node("prepare", (state) => ({ value: state.input * 2 })))
  .addNode(node("finish", (state) => ({ output: `结果: ${state.value}` })))
  .addEdge(START, "prepare")
  .addEdge("prepare", "finish")
  .addEdge("finish", END);

const result = await loop(graph, { input: 21 });
console.log(result.state.output); // 结果: 42
```

## 路由

路由是读取状态的普通代码，不由模型直接控制执行流：

```js
graph.addRouter(
  "classify",
  (state) => state.route,
  { quick: "quickReply", full: "fullAgent", stop: END },
);
```

## 执行语义

1. `START` 的所有出边形成首个波次。
2. 同一波次节点读取各自的状态快照，并通过 `Promise.all` 并发运行。
3. 引擎按图中节点顺序合并增量；并行节点写入相同键会抛出 `StateCollisionError`。
4. 节点异常不会让整个 loop 崩溃，错误写入 `state.errors`；配置 `onError` 可跳转到恢复节点。
5. `maxVisits` 限制单个节点访问次数，`maxSteps` 限制整次运行步数。

## 事件

可通过 observer 获取 `loop_start`、`node_start`、`node_end`、`route`、`loop_end`：

```js
await loop(graph, initialState, {
  maxSteps: 25,
  observer(kind, event) {
    console.log(kind, event);
  },
});
```

## 本地验证

```bash
npm test             # 单次运行全部 Vitest 测试
npm run test:watch   # 开发时监听文件变化
npm run test:coverage
npm run example
```

测试通过包的公开导出验证行为，分别覆盖 `State`、`Node`、`Graph/describe`
和 `loop`。覆盖率报告生成在 `coverage/index.html`，配置的最低门槛为：行、
函数和语句 90%，分支 85%。
