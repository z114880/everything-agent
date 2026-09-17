# Agent Graph

`src/agent-graph/` 描述个人助理的业务关系，不执行模型、工具或后台任务。

## 当前拓扑

- User Prompt、Current Session、EVERYTHING.md、Skills Catalog、Procedural Memory、System Prompt 与 Tool Schemas 均属于 Graph 的正式节点。START 连接 User Prompt；画布隐藏 START 与 END。
- Current Session 来自服务端 SQLite 当前会话的全部已完成回合，不包含本轮输入；最近 3 个已完成回合另供检索意图判断。
- EVERYTHING.md 的常驻规则与 Skills Catalog 的名称、描述共同组成 Procedural Memory；完整 Skill 正文仍由模型按需调用 `read_skill` 读取。
- 小模型判断记忆需求：`none` 跳过召回；`past_episode` 召回历史对话；`fact_with_evidence` 同时召回长期事实和历史对话。图中两条召回边表示检索依赖，不表示并行执行。
- Procedural Memory → System Prompt → Working Memory 展示系统指令的组装关系；基础角色及 Semantic Memory 策略由运行时注入 System Prompt，不单独展示节点。
- 当前输入、会话历史、System Prompt、Tool Schemas 和召回证据进入 Working Memory，检查上下文预算后交给模型推理；工具结果回到模型，最终回复用户。Tool Schemas 表示本轮注册工具的名称、用途和参数结构，不属于 Procedural Memory。
- 工具提交的记忆进入后台队列并立即返回任务 ID。
- Consolidation 独立成区，与其他流程没有连线：每日首次使用 / 手动 Consolidate → 全量事实与分批 → 模型整理 → 校验提交 → 结果汇总。仅处理 semantic facts。
- 两种后台入口共用检索旧记忆、小模型判断、证据及版本校验、事务提交和审计，执行新增、更新、删除、合并或跳过。

## Evaluation 区域

固定 Dataset → Evaluate Agent → 自动评分 → 评估结论是独立区域，节点和边同样来自 `Graph.describe()`。Agent 页面 Evaluate 按钮运行默认数据集，支持取消；点击评估节点或状态进入 Evaluation。状态来自独立评估事件流，不受聊天或 Consolidate 重置影响。当前无 CI 触发和自动发布。

## 静态与动态边界

`agentHarnessGraph.describe()` 是所有节点和连线的唯一拓扑来源。`harnessPresentation` 和 `harnessEdgeLabels` 在同模块提供业务名称、简述、布局位置与边说明；Web 服务将其附加到 describe 输出，前端不补画固定输入或业务关系。

此 Graph 表达数据依赖和触发条件，不是可通过 `runGraph` 执行的业务调度实现；真实聊天由 `runAgentLoop` 执行，后台由 Memory 持久化串行队列执行。

画布用真实 `gate_start`、`gate_end`、`retrieval_completed`、`context_assembled` 和模型、工具、回复事件更新前台状态。只有工具真实返回 `queued` 才显示记忆任务入队完成，不推断后台处理成功。后台区域通过独立 SSE 连接订阅 Runtime 的后台 observer 事件，显示任务启动、候选判断、校验保存、完成及失败。聊天回复结束保留后台进度；新回合启动时，记忆任务入队、判断、保存和长期记忆库节点恢复白色空闲状态，并清除后台连线播放队列，不沿用上一轮执行结果。后台订阅保持连接，后续真实事件继续更新节点，独立整理流程的节点状态保留；任务未启动时不会推断执行。连接仅展示订阅期间的实时事件，历史结果仍由 Trace / Memory 页面提供。

输入展示不包含私人正文。画布提供缩放和横向滚动，节点简述强调业务目的，连线说明传递的数据或触发条件。

## 使用

```ts
import { agentHarnessGraph } from "everything-agent";
const description = agentHarnessGraph.describe();
console.log(description.nodes, description.edges);
```

相关执行语义见 [Agent Loop](../agent-loop/README.md)、[Memory](../memory/README.md) 和 [Agent Runtime](../agent-runtime/README.md)。

Web 配置页的 Memory Retrieval 区域提供 Retrieval Mode 与 Minimum Similarity，保存后下一回合生效，重新进入 Agent 页时流程图显示当前配置。Semantic 召回节点标明实际模式；Hybrid 展示 BM25 + Dense → RRF → MMR，历史对话召回始终标明 FTS5 + BM25。同一区域提供 Embedding 连接与索引管理，不展示 Query Template / Document Template，Web 保存使用 `{text}`。

Web 画布使用简短节点术语，隐藏顶部标题、缩放控件与底部说明；节点和连线文案仍由服务端展示元数据提供。Minimum Similarity 的问号支持悬浮和键盘聚焦显示校准建议。
