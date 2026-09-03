# Memory

Memory 模块为 classic Agent Loop 提供单用户、本地优先的持久记忆。公开入口是 `src/memory/index.ts`；调用方无需了解 SQLite schema、FTS5 索引、高水位或 consolidation 事务。

## 存储

- `.everything/state.db` 是 Session、Chat Log、Semantic 和 Episodic memory 的唯一事实来源。
- `.everything/EVERYTHING.md` 是始终进入 System Prompt 的 Procedural memory。
- Semantic 与 Episodic 原文保持对话语言。派生的 `search_text` 对中文生成 bigram，对其他文字按 Unicode 单词规范化。
- FTS5 索引只保存检索投影，并使用 BM25 在各自索引内排序；索引可由主表重建。
- 时间以 UTC ISO 8601 保存，精确到秒；注入 Prompt 时转换为本地时间并携带时区偏移。

## Session 与工作记忆

`sessionId` 标识一段聊天，`runId` 标识一次用户提交触发的 Agent Loop。一次完整 run 的用户输入、Assistant 工具请求、工具结果和最终回复以结构化消息写入 `chat_log`。失败 run 可以只有用户输入，不会进入后续工作记忆或 consolidation。

聊天页初始化通过幂等的 `ensureSession()` 确保至少存在一个 Session。即使开发模式重复触发页面初始化，空数据库也只会创建一个默认 Session。

工作记忆默认读取当前 Session 最近 10 个完整回合，可在配置页设为 1–50。工具过程会一并恢复；API Key、令牌、Authorization 和 Cookie 等凭证字段在持久化前移除。

## 检索

每次用户输入后，小模型读取当前 Session 最近 3 个完整回合与当前消息，判断是否需要长期记忆。判定失败时 fail-open，使用当前消息执行本地查询。默认分别返回 4 条 Semantic 和 3 条 Episodic memory；两类 BM25 分数不跨索引比较。

检索结果附加到 System Prompt，并包含 memory ID 与精确到秒的时间。没有跨语言扩展、embedding 或向量检索。

## Consolidation

活跃 Session 内不执行 consolidation。用户新建对话时，旧 Session 在后台增量整理；进程启动时会恢复所有存在完整增量的 Session。每个 Session 通过 `consolidated_through_message_id` 记录已经检查过的高水位。

- Semantic 只保存跨 Session 仍有用、预计长期成立且与用户直接相关的稳定用户属性、长期偏好、持续项目事实、明确约束和承诺。当前时间、天气、新闻、价格、汇率、一次性查询结果、通用知识、寒暄、临时请求和普通问答答案不得写入。
- Semantic 可以参考 user 或 assistant 内容，但 assistant 内容只有在记录用户项目的持久变化或明确承诺时才可提炼。模型必须为 create/update 声明允许的 category，并明确标记 `stable` 与 `futureUseful`；运行时会再次校验，不合格的候选记为 skipped。
- Semantic 只允许 create、精确 ID update 或 noop。
- 每个 Session 最多有一条自动 Episodic memory。历史 Session 继续聊天后，再次离开时更新原 episode。
- 不值得长期回忆的 Session 可以没有 episode。
- 自动整理不能删除记忆；失败不会推进高水位，下次继续重试。

## 管理与删除

`manage_memory` 统一放在 `src/tools/manage-memory.ts`。聊天侧可以搜索 Semantic/Episodic、创建或更新 Semantic；模型驱动的 create/update 必须通过与 consolidation 相同的 category、`stable` 和 `futureUseful` 声明校验。聊天侧不能创建或修改 Episodic，也不能修改 Procedural memory。删除需要先取得与目标 ID 绑定的短期确认令牌。

UI 可以直接管理 Semantic 和 Episodic。删除会同步移除主表原文和 FTS5 索引，审计记录只保存类型、原 ID、动作、来源和时间，不保留旧内容。

配置页提供带二次确认的全局“一键清理”。服务端会拒绝并发中的 Agent 回合、等待后台 consolidation 完成、关闭 SQLite，再删除 `.everything/` 下的数据库、Session、Memory 和 trace；`EVERYTHING.md` 作为 Procedural memory 被保留，清理动作本身不会新建 trace。
