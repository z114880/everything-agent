# Agent Graph

`src/agent-graph/` 负责描述 Agent Harness 的静态拓扑，不执行模型或工具，也不保存运行状态。

## 拓扑

`harness-graph.ts` 声明以下可视化主链路：

```text
Working Memory → LLM ↔ Tools → Reply
```

- `agentHarnessGraph.describe()` 是 Harness 节点和边的唯一静态事实来源。
- `START` 在 Harness 视觉中隐藏，因此 Working Memory 是可见起点。
- LLM 根据经过代码验证的路由标签进入 Tools 或 Reply。
- Tools 执行完成后回到 LLM，并同时受到 Agent Loop 迭代限制保护。

User Prompt、SQLite Session History 和 System Prompt 是 Harness 的输入，不属于 Graph 静态拓扑。服务端从持久化 Chat Log 恢复最近的完整回合并组装本轮 Working Memory；前端通过 Agent Loop 的 `context_assembled` observer 事件更新 `working_memory` 静态节点的执行状态。

## 使用方式

```ts
import { agentHarnessGraph } from "everything-agent";

const description = agentHarnessGraph.describe();
console.log(description.nodes);
console.log(description.edges);
```

静态拓扑只负责展示模块关系。真实执行阶段、文本流、工具调用、耗时和错误必须来自 Agent Loop observer 事件，不能通过最终状态反推。

## 相关模块

- `../agent-loop/`：执行 `observe → reason → act → repeat` 回合。
- `../tools/`：提供受控工具注册表。
- `../model/`：把真实模型协议适配为 Agent Loop 接口。
- `../memory/`：提供持久 Session、检索上下文与 consolidation。
