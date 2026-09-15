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
- Web 列表按运行翻页，选择运行后才加载完整详情；单个事件默认折叠。

## 性能边界

当前按 JSONL 扫描构造运行摘要，分页限制响应大小，但尚未引入持久化运行索引。详情也会扫描文件寻找关联任务。数据量增大后可以独立增加索引；不能为了限制响应而截断运行证据。

## 内容边界

凭证字段和常见 token 文本会被移除，但这不等于对所有个人信息进行匿名化。模型请求、回复和部分工具结果可能包含业务正文，不应直接上传全部 trace 给裁判或第三方。评估系统使用独立目录与人工准备的测试场景。
