# Trace 存储与读取

## 已实现

`JsonlTracer` 把真实 observer 事件写入按日期组织的 JSONL 文件。前台回合关联 `runId`、`sessionId`，后台记忆任务通过 `sourceRunId`、`taskId` 及前台的 `derivedTaskIds` 关联。恢复文件保留原运行标识。

### 按运行分页

通过 `src/index.ts` 或 `src/tracing/trace-reader.ts` 使用：

```ts
const page = await listTraceRuns(home, { pageSize: 20 });
const next = page.nextCursor
  ? await listTraceRuns(home, { pageSize: 20, cursor: page.nextCursor })
  : null;
const files = await readTraceRun(home, page.runs[0]!.runId);
```

- 默认每页 20 次运行，允许 1–100；摘要只包含运行标识、开始时间、事件数和终态。
- 游标包含首页的排序上界与上一页的最后一个键。同一时间戳用 runId 打破平局。新产生且排序键超过上界的运行在刷新首页后出现。
- 游标不是数据库事务快照：正在追加的运行、迟到事件和手工改动仍可能改变摘要。
- `readTraceRun` 返回指定运行及关联后台任务的全部记录，包含恢复文件，不设置事件条数上限。
- `readTraceFiles` / `readTraceRecords` 读取全部记录，不再接收旧的条数限制参数。
- 损坏 JSONL 行转成 `trace_read_error`，不会伪造正常完成。
- Web 列表按运行翻页，自动加载当前页的完整详情，沿用 JSONL 文件列表样式和交互：文件默认展开、可折叠，单个事件默认折叠；同一文件的关联事件去重展示。

## 性能边界

当前按 JSONL 扫描构造运行摘要，分页限制响应大小，但尚未引入持久化运行索引。详情也会扫描文件寻找关联任务。数据量增大后可以独立增加索引；不能为了限制响应而截断运行证据。

## 内容边界

凭证字段和常见 token 文本会被移除，但这不等于对所有个人信息进行匿名化。模型请求、回复和部分工具结果可能包含业务正文，不应直接上传全部 trace 给裁判或第三方。评估系统使用独立目录与人工准备的测试场景。

## Langfuse v4

`createLangfuseTracer` 与 `readLangfuseConfiguration` 从包公开入口导出。Runtime 在创建 JsonlTracer 时加载专用连接，将同一份脱敏事件分发到本地 JSONL 和 Langfuse。网络发送不阻塞回合；每批至多 64 条、待发请求最多 256 个、每次请求超时 5 秒。请求失败后冷却 5 秒，期间跳过排队记录并报告未上传，避免不可用服务让关闭过程逐条等待超时；实验可从本地证据重新发布。网络失败与队列溢出会追加 `langfuse_export_failed` 本地事件，不能递归上传此事件。关闭 Runtime 时刷新导出；异常中断导致缺少结束事件的步骤标记为不完整。

使用官方 OTLP HTTP/JSON 接口与 Scores API，不注册全局 OpenTelemetry provider、不自动截获其他 HTTP 流量，也不依赖特定 Agent 框架。仅支持当前 Langfuse v4 的实验属性，不保留旧 ingestion 协议。

映射：回合 → agent；模型/Gate/记忆裁判 → generation；工具 → tool；自动召回 → retriever；向量调用 → embedding；其他单点事件 → event。开始/结束根据调用 ID 匹配，不从最终状态猜测路径或耗时。`operationId` 关联 Gate、自动检索和 Embedding 生命周期；模型与工具保留已有调用 ID。工具内部发布的事件携带当前 `toolCallId`。`skill_loaded` 保留正文 SHA-256 哈希，不包含正文。

后台写入和 consolidation 使用独立运行 Trace，保留来源 `sourceRunId` 与 `taskId`；离线实验则将这些步骤附在同一个实验 item 下，便于把最终状态和分数关联起来。静态拓扑仍以 `Graph.describe()` 为准，Langfuse observation 树表示实际执行，不替代静态图。

连接、内容上传边界与部署步骤见 [本地 Langfuse](../../deploy/langfuse/README.md)。

清除全部数据时，若已启用 Langfuse，会先刷新在途导出，再按本地 JSONL 中 runId 对应的 trace ID 分批请求删除远端 traces（含 observations 和 scores），受理成功后才删除本地数据。远端删除失败会报错并保留本地数据供重试；Langfuse 实际删除可能延迟。本地记录已被删除的历史 traces、其他来源 traces 和独立 Evaluation 数据不在此范围内。未启用 Langfuse 时仅清除本地数据。清除会保留 `.everything/langfuse.env` 连接凭证，Langfuse 连接不会被中断。
