# Everything Agent Engine

一个轻量、可观察的 Node.js Graph Engine。它没有运行时依赖，核心只有五个概念：

- `State`：一次运行的共享黑板；节点读取快照并返回增量。
- `Node`：`handler(state, context) -> update`，同步和异步函数都支持。
- `Graph`：声明节点、普通边和条件路由。
- `describe`：从真实 Graph 生成可序列化拓扑，避免文档与代码漂移。
- `runGraph`：按 wave 并发执行就绪节点，合并状态并推进图。

## 快速开始

```ts
import { END, START, Graph, node, runGraph } from "everything-agent";

const graph = new Graph("demo")
  .addNode(node("prepare", (state) => ({ value: state.input * 2 })))
  .addNode(node("finish", (state) => ({ output: `结果: ${state.value}` })))
  .addEdge(START, "prepare")
  .addEdge("prepare", "finish")
  .addEdge("finish", END);

const result = await runGraph(graph, { input: 21 });
console.log(result.state.output); // 结果: 42
```

## 路由

路由是读取状态的普通代码，不由模型直接控制执行流：

```ts
graph.addRouter(
  "classify",
  (state) => state.route,
  { quick: "quickReply", full: "fullAgent", stop: END },
);
```

## 执行语义

1. `START` 的所有出边形成首个 wave。
2. 同一 wave 的节点读取各自的状态快照，并通过 `Promise.all` 并发运行。
3. 引擎按图中节点顺序合并增量；并行节点写入相同键会抛出 `StateCollisionError`。
4. 条件路由会把命中的分支标记为已激活，并将未命中的分支标记为已跳过；跳过状态会向下传播，因此条件分支之后可以正常汇合。
5. 普通并行汇合等待所有已声明的上游完成决议：成功和跳过允许继续，任一上游失败都会阻止依赖其输出的节点运行。
6. 节点异常不会让整个 Graph 执行崩溃，错误写入 `state.errors`；配置 `onError` 可跳转到恢复节点。
7. `maxVisits` 限制单个节点访问次数，`maxSteps` 限制整次运行步数。

`runGraph` 返回的 `status` 为 `completed`、`failed` 或 `stalled`。当没有可运行节点、但已有节点仍在等待无法解决的部分上游时，状态为 `stalled`，`blockedNodes` 会列出阻塞节点及其等待的上游。原有的 `state`、`path`、`steps` 和 `error` 字段保持不变。

## 事件

可通过 observer 获取 `graph_start`、`wave_start`、`node_start`、`node_end`、`route`、`graph_stalled`、`graph_end`。`wave_start` 包含真实的 wave 编号、当前 wave 的并发节点和实际触发的 `activatedEdges`；未命中的条件分支不会出现在激活边中。`node_start`、`node_end` 也包含对应的 `wave`：

```ts
await runGraph(graph, initialState, {
  maxSteps: 25,
  observer(kind, event) {
    console.log(kind, event);
  },
});
```

`graph_stalled` 只在运行停滞时发送。`graph_end` 始终发送，并包含 `status` 和 `blockedNodes`，便于调用方区分正常完成、失败和调度停滞。

## 本地验证

```bash
npm test             # 单次运行全部 Vitest 测试
npm run test:watch   # 开发时监听文件变化
npm run test:coverage
npm run typecheck    # 严格检查源码、测试和示例
npm run build        # 检查后端类型并由 Vite 构建前端；后端不生成 dist/
npm run example
```

测试通过包的公开导出验证行为，分别覆盖 `State`、`Node`、`Graph/describe`
和 `runGraph`。覆盖率报告生成在 `coverage/index.html`，配置的最低门槛为：行、
函数和语句 90%，分支 85%。
