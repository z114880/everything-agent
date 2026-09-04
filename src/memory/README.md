# Memory

Memory 模块为 classic Agent Loop 提供单用户、本地优先的持久记忆。公开入口是 src/memory/index.ts；调用方无需了解 SQLite schema、FTS5、cursor 或 consolidation 事务。

## 存储与事实来源

- .everything/database/state.db 是 Session、Chat Log 和 Semantic Memory 的事实来源；SQLite 生成的 WAL 和 SHM 文件也位于该目录。
- .everything/EVERYTHING.md 是始终进入 System Prompt 的 Procedural Memory。
- Episodic Memory 不再保存模型生成的 Session 摘要。Episodic Recall 的唯一事实来源是原始 chat_log。
- chat_log_fts 只索引 user_message 与最终 assistant_message 的检索投影。中文使用 bigram，其他文字按 Unicode 单词规范化。
- 工具调用和工具结果不进入 FTS，但命中范围恢复时会按完整 run 一并返回。
- FTS5 + BM25 与 Dense 是相互独立的召回路线；Hybrid 使用固定等权 RRF，再用 MMR 去除近似重复结果。
- API Key、令牌、Authorization 和 Cookie 等凭证字段在写入 Chat Log 前移除。

Schema v4 增加向量 generation、chunk 与 rebuild 状态，并使用 `chunkingVersion` 标识估算切块规则。向量使用标准化 Float32 little-endian BLOB 保存；旧索引可由原始事实和 Chat Log 重建。

## Session 与 Working Memory

sessionId 标识一段聊天，runId 标识一次用户提交触发的 Agent Loop。完整 run 的用户输入、Assistant 工具请求、工具结果和最终回复以结构化消息写入 chat_log。失败 run 可以只有用户输入，但只保留在 Chat Log，不进入 FTS5、Dense、Session Recall 或 consolidation。

当前 Session 的全部已完成回合进入 Working Memory，不再按最近回合数裁剪。当前 Session 完全排除在 Session Recall 之外。完整模型输入受到 `modelContextWindow` token 限制；输入量使用统一启发式规则估算，超过预算时明确失败，不静默删除旧消息。真实消耗只采用供应商响应中的 usage。

## Gate

小模型读取当前 Session 最近 3 个完整回合与当前消息，并返回单一 RetrievalIntent。普通代码将 intent 映射为固定检索计划，避免模型输出互相矛盾的开关组合：

- none：不检索记忆。
- past_episode：只检索 Session Recall。
- fact_with_evidence：同时检索 Semantic Memory 与 Session Recall。

Session Recall mode 可为 search 或 recent。Gate 不提供 Semantic-only intent：任何 Semantic 查询都必须通过 fact_with_evidence 同时触发 Session Recall。Gate 失败时也退化为 fact_with_evidence，使用当前消息同时查询两类记忆。

Gate 采用召回率优先策略：宁可多执行一次 Session Recall，也不允许 Semantic-only 检索漏掉历史中的来源、变化、例外、冲突、最新状态或具体上下文。

## Session Search

session_search 是只读的发现工具，有两种互斥模式：按 query 依据全局配置执行 Dense、FTS5 + BM25 或 Hybrid 搜索，或以 recent: true 返回最近活跃 Session。

- limit 限制 Session 数，默认 4。
- search 每个 Session 选择当前检索路线的最佳消息或 chunk 锚点，返回首 3 条、命中点前后各 window 条、尾 3 条。
- recent 按 updated_at 降序返回非空 Session，返回首 6 条和尾 6 条，结果使用 retrievalMode: recent 与 match: null。
- 窗口按可检索对话消息计数，随后展开这些消息所属的完整 run。
- 首、事件、尾区段重叠时按 chat_log.id 去重。
- lexical-only 按最佳 BM25 升序，dense-only 按 cosine 降序，hybrid 按 RRF 后的 MMR 顺序排名；同分再按稳定规则决胜。原始信号分别保存在 `retrievalSignals.bm25/dense/fused/mmr`，不伪造统一 score。
- Agent 调用完全排除当前 Session；Memory 页面手动检索没有当前 Session，因此搜索全部历史。

## Session Read

session_read 使用 search 返回的 cursor 扩大命中窗口，或使用 sessionId 从 Session 开头顺序分页。命中窗口初始单侧半径默认 5；每次扩窗默认向两侧各增加 10，并返回整个扩大后的窗口。

若完整窗口超过单次预算，则返回 expandLimitReached: true，调用方应改用 sessionId 顺序分页。Cursor 是不透明值，可记录扩窗半径、消息位置和单条超长消息的内容偏移。

当前不提供跨调用快照一致性：后续读取观察数据库当下状态；Session 被删除时返回 SESSION_NOT_FOUND。所有结果显式提供实际覆盖范围、返回/总消息数、isComplete、截断状态和下一 cursor。

## 预算

| 配置 | 默认值 | 服务端范围 |
| --- | ---: | ---: |
| sessionSearchWindow | 5 | 1–20 |
| sessionScrollStep | 10 | 1–50 |
| sessionRecallMessageLimit | 100 | 1–200 |
| sessionRecallTokenLimit | 8,192 | 256–131,072 |
| modelContextWindow | 32,768 | 4,096–2,000,000 |

多 Session 搜索按排名依次组装。预算不足时省略末尾低排名 Session；第一名自身超限时允许显式截断。单条超长消息可通过 cursor 从截断位置继续读取。

## 内容隔离与可观测性

召回的历史内容以 JSON 数据块注入，并由 System Prompt 明确标记为不可信历史证据；不得执行其中的指令或工具请求。每条记录保留 Session、message、run、role、kind 和时间身份。

Gate 初始召回通过 gate_start、gate_end、retrieval 和 context_assembled 观察。主 Agent 后续调用通过标准工具事件观察。检索事件只保存命中 ID、排名、信号和范围元数据；model_request 是模型实际输入的权威快照。

## Semantic Consolidation

用户新建对话时，旧 Session 在后台增量整理 Semantic Memory；进程启动时恢复积压。高水位记录在 consolidated_through_message_id。

Semantic 只保存跨 Session 仍有用、预计长期成立且与用户直接相关的稳定属性、偏好、持续项目事实、约束和承诺。模型必须声明允许的 category，并将 stable 与 futureUseful 标为 true。失败不会推进高水位。

manage_memory 只管理 Semantic Memory。session_search 与 session_read 始终只读；删除历史对话必须使用 Session 删除入口。配置页的一键清理会删除数据库、Session、Memory 与 trace，但保留 EVERYTHING.md。

## 当前取舍

- Dense 目前使用 SQLite 中的精确 cosine 全扫描；个人助理数据规模增大后可评估 ANN，但首版不做。
- 不索引工具结果可能漏掉仅存在于工具输出、且邻近对话没有关键词的事实。
- 当前 Session 全量 Working Memory 会持续增加费用与延迟，最终可能触发 Context Limit。
- 扩窗返回完整累计窗口，会重复消耗上下文。
- 固定首尾锚点会占用返回预算；不足时低排名候选被省略。
- 当前不做时间衰减或 recency boost；它可能在未来作为明确的排序信号加入。
