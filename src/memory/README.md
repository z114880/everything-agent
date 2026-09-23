# Memory

Memory 模块为 classic Agent Loop 提供单用户、本地优先的持久记忆。公开入口是 src/memory/index.ts；调用方无需了解 SQLite schema、FTS5、cursor 或 consolidation 事务。

## 内部模块划分

`MemoryRuntime` 提供公开接口，负责依赖组装、Gate 检索计划、历史上下文隔离与概览。内部服务不从 `index.ts` 导出，测试继续通过公开入口验证行为。

| 模块 | 职责 |
| --- | --- |
| `storage/schema.ts` | SQLite 表、索引与 Schema 版本声明 |
| `storage/database.ts` | SQLite 连接、Schema 初始化、FTS5 检查与同步事务 |
| `storage/session-store.ts` | Session、Chat Log、完整回合读取及检索投影写入 |
| `storage/semantic-store.ts` | 语义事实增删改查与事务内审计 |
| `retrieve/embedding-index.ts` | Embedding 配置、文档/查询向量、重建生命周期及写入保护 |
| `retrieve/memory-search.ts` | Lexical/Dense 候选检索、RRF/MMR 排序与 Session 去重 |
| `retrieve/retrieval-gate.ts` | 小模型检索意图判断及失败回退 |
| `retrieve/session-recall.ts` | 召回窗口、预算截断与游标分页 |
| `management.ts` | 逐条检索、Agent Model 五类决策、证据校验与版本冲突重试 |
| `background-tasks.ts` | 后台串行队列、每日去重、持久任务恢复 |
| `consolidation.ts` | 全量事实审查、预算分批、版本校验与提交检查点 |
| `model-json.ts` | 模型 JSON 输出解析，容忍围栏与说明文字 |
| `storage/records.ts` | 数据库记录转换、消息分类与凭证字段移除 |

根目录保留公开入口 `index.ts`、公共类型 `types.ts`、运行时编排 `memory-runtime.ts` 、统一变更流程 `management.ts` 和后台整理 `background-tasks.ts`。`storage/` 集中管理持久化与记录转换；`retrieve/` 集中管理检索策略、索引和召回，并按 `lexical/`、`dense/`、`fusion/` 划分底层算法。测试保留在 `test/` 和 `retrieve/test/`，通过公开入口验证行为。

各服务共享同一个数据库连接和向量索引实例。Semantic 存储先完成远程嵌入，再在同一事务内提交事实、FTS 投影、向量与审计；Session 仅在本地事务中提交原文与 FTS；索引服务集中维护重建状态和语料变更版本，防止并发写入后激活过期索引。检索排序与召回分页分别维护候选相关性和内容预算，后台整理复用现有检索与事实写入服务。

## 存储与事实来源

- .everything/database/state.db 是 Session、Chat Log 和 Semantic Memory 的事实来源；SQLite 生成的 WAL 和 SHM 文件也位于该目录。
- .everything/EVERYTHING.md 是始终进入 System Prompt 的 Procedural Memory。
- Episodic Memory 不再保存模型生成的 Session 摘要。Episodic Recall 的唯一事实来源是原始 chat_log。
- chat_log_fts 只索引 user_message 与最终 assistant_message 的检索投影。Session 与 Semantic 统一使用 nodejieba 搜索模式、英文连续字母数字和 identifier 整体/组成词投影；使用 NFKC 与 lowercase，保留原文词频。
- 工具调用和工具结果不进入 FTS，但命中范围恢复时会按完整 run 一并返回。
- FTS5 + BM25 与 Dense 是相互独立的召回路线；Hybrid 使用固定等权 RRF，再用 MMR 去除近似重复结果。
- API Key、令牌、Authorization 和 Cookie 等凭证字段在写入 Chat Log 前移除。

Schema v5 新增语义语料单调版本、来源引用和变更审计表；保留向量 generation、chunk 与 rebuild 状态，并使用 `chunkingVersion` 标识估算切块规则。向量使用标准化 Float32 little-endian BLOB 保存；旧索引可由原始事实和 Chat Log 重建。

## Session 与 Working Memory

sessionId 标识一段聊天，runId 标识一次用户提交触发的 Agent Loop。完整 run 的用户输入、Assistant 工具请求、工具结果和最终回复以结构化消息写入 chat_log。失败 run 可以只有用户输入，但只保留在 Chat Log，不进入 FTS5、Dense或 Session Recall。

当前 Session 的全部已完成回合进入 Working Memory，不再按最近回合数裁剪。当前 Session 完全排除在 Session Recall 之外。完整模型输入受到 `modelContextWindow` token 限制；输入量使用统一启发式规则估算，超过预算时明确失败，不静默删除旧消息。真实消耗只采用供应商响应中的 usage。

## Gate

小模型读取当前 Session 最近 3 个完整回合与当前消息，并返回单一 RetrievalIntent。普通代码将 intent 映射为固定检索计划，避免模型输出互相矛盾的开关组合：

- none：不检索记忆。
- past_episode：只检索 Session Recall。
- fact_with_evidence：同时检索 Semantic Memory 与 Session Recall。

Session Recall mode 可为 search 或 recent。Gate 不提供 Semantic-only intent：任何 Semantic 查询都必须通过 fact_with_evidence 同时触发 Session Recall。Gate 失败时也退化为 fact_with_evidence，使用当前消息同时查询两类记忆。

Gate 采用召回率优先策略：宁可多执行一次 Session Recall，也不允许 Semantic-only 检索漏掉历史中的来源、变化、例外、冲突、最新状态或具体上下文。

## Session Search

session_search 是只读的发现工具，有两种互斥模式：按 query 执行 FTS5 + BM25 搜索（不受全局 Semantic 检索模式影响），或以 recent: true 返回最近活跃 Session。

- limit 限制 Session 数，默认 4。
- search 每个 Session 选择 FTS 的最佳消息锚点，返回首 4 条、命中点前后各 Session Search Window 条（默认 5，由运行配置决定，Agent 不能通过参数调整）、尾 4 条；内容不够时用返回的 cursor 交给 session_read 继续往后读。
- 返回量由窗口结构决定，没有条数预算：limit 个 Session 各自拿到完整窗口，不会被按条数裁剪。
- recent 按 updated_at 降序返回非空 Session，返回首 6 条和尾 6 条，结果使用 retrievalMode: recent 与 match: null。
- 窗口按可检索对话消息计数，随后展开这些消息所属的完整 run。
- session_search 是扫描工具：单条正文超过 Recall Entry Token Limit（默认 8,192）时截断，标记 `contentTruncated`，并给出原文总长 `contentLength` 与该条的 `contentCursor`；search 与 recent 两种模式都适用。
- 首、事件、尾区段重叠时按 chat_log.id 去重。
- lexical-only 按最佳 BM25 升序，dense-only 按 cosine 降序，hybrid 按 RRF 后的 MMR 顺序排名；同分再按稳定规则决胜。原始信号分别保存在 `retrievalSignals.bm25/dense/fused/mmr`，不伪造统一 score。
- Agent 调用完全排除当前 Session；Memory 页面手动检索没有当前 Session，因此搜索全部历史。

## Session Read

session_read 只做一件事：从某个位置开始往后连续读。传 sessionId 从 Session 开头读，传 cursor 从 cursor 记录的位置继续读。Cursor 是不透明值，记录消息位置与单条超长消息的内容偏移。

session_read 不受 Recall Entry Token Limit 约束：它是按需取全文的工具，页大小由召回总额决定，单条超过一页时按 `contentOffset` 逐页推进，最终能读到完整正文。

cursor 有三种来源，语义相同（都是「从这里往后连续读」），只是起点不同：

- search 正常返回时，结果的 nextCursor 指向**锚点窗口的右边界**。窗口含尾 4 条，整段结果的右边界通常就是 Session 末尾，因此续读必须从锚点窗口右边界开始，才能读到锚点之后、尾部之前被跳过的那一段。
- 某条消息正文被单条上限截断时，该 entry 自带 `contentCursor`，指向这条消息的断点。它是读回完整单条的唯一出口，与 Session 级 nextCursor 不重叠。
- search 因总额被收缩时，结果的 nextCursor 指向 Session 开头。收缩结果只保留命中点附近的若干 run，其前后都有缺口，只有从头读才能保证不跳过中间消息。

每次调用都返回一段连续的、未读过的内容，不会空手返回，也不存在需要中途改换读取方式的死路。代价是 cursor 单向向后：锚点之前的内容只能用 sessionId 从头分页读取。

`isComplete` 严格表示「本次返回覆盖 Session 全部行」，从锚点续读时必为 false；「往后是否还有内容」由 `nextCursor` 是否为空表达，两个字段不重叠。

当前不提供跨调用快照一致性：后续读取观察数据库当下状态；Session 被删除时返回 SESSION_NOT_FOUND。所有结果显式提供实际覆盖范围、返回/总消息数、isComplete、截断状态和下一 cursor。

## 预算

| 配置 | 默认值 | 服务端范围 |
| --- | ---: | ---: |
| sessionSearchWindow | 5 | 1–20 |
| sessionRecallEntryTokenLimit | 8,192 | 256–16,384 |
| modelContextWindow | 262,144 | 4,096–2,000,000 |
| 单次 session_search 总额 | modelContextWindow × 25% | 派生，不可配置 |

预算不控制返回条数，只有三层防护：

1. **单条正文上限**（`sessionRecallEntryTokenLimit`）。这是唯一压得住成本的一层：个别超长记录（如大段工具结果）被截断到上限内，窗口结构与 Session 数完全不受影响，全文通过 `contentCursor` 交给 session_read 读取。
2. **单次调用的 token 总额**，由 `modelContextWindow` 派生。只有第 1 层压完仍超额时才触发，裁剪单位是整个 Session：从最低排名开始丢弃，绝不切碎已经给出的窗口，并在结果中如实上报 `droppedSessionCount` 与 `droppedReason: "token_budget"`。排名第一的 Session 不能空手返回，按 run 粒度从尾部、首部交替向命中所在 run 收缩；只剩命中 run 仍超额时在 run 内围绕命中消息收缩，保证总额是硬上界。
3. **`modelContextWindow` 硬失败**，由 Agent Loop 在请求前判定，不静默裁剪。

`estimatedTokens`、`droppedReason` 与每个 Session 的 `truncatedEntryCount` 都进入检索事件，预算去向可在 trace 中解释。

## 内容隔离与可观测性

召回的历史内容以 JSON 数据块注入，并由 System Prompt 明确标记为不可信历史证据；不得执行其中的指令或工具请求。每条记录保留 Session、message、run、role、kind 和时间身份。

Gate 初始召回通过 gate_start、gate_end、retrieval_start、retrieval_completed 和 context_assembled 观察。主 Agent 后续调用通过标准工具事件观察。检索事件只保存命中 ID、排名、信号和范围元数据；model_request 是模型实际输入的权威快照。

## 统一 Semantic Memory 管理

聊天提交先通过 `enqueueMemory` 持久入队并立即返回 `{status: "queued", taskId}`；后台写入使用 `MemoryRuntime.manageMemory(candidate, options)`：

1. 提交独立事实或明确忘记意图，携带 `subject`、`attribute`、`content`、`intent: remember | forget` 和 `evidenceMessageIds`。
2. 校验证据属于当前 Session 的有效用户消息。聊天允许本次运行已落库的用户消息；后台仅允许已完成回合的用户消息。Assistant 和工具结果不能作为事实证据。
3. 按“主体 + 属性 + 内容”逐条检索最多 12 条相关旧记忆，使用全局 `lexical_only / dense_only / hybrid`。管理检索保留 MMR 原本会隐藏的重复候选，供 Agent Model 判断合并；普通回答召回继续去重。
4. 将用户原文、旧记忆内容、ID、来源时间和语料版本交给配置的 Agent Model，生成一项决策。
5. 代码校验决策、证据引用、目标候选、长期价值声明和版本，提交后返回操作结果。

| 决策 | 执行语义 |
| --- | --- |
| `create` | 未找到对应旧事实时新增；只是主题相关的命中不阻止保存独立事实 |
| `update` | 明确纠正或补充一条旧事实，保留 ID 和仍有效的信息 |
| `delete` | 根据明确忘记意图直接删除已定位的记忆，无需确认令牌 |
| `merge` | 至少两条旧记忆描述同一事实且重复或互补；保留 `targetId`，删除 `sourceIds` |
| `noop` | 重复、不值得长期保存、证据不足或目标不明确，本次不修改 |

没有 `clarify` 操作。Agent Model 返回简短 `reason` 供后续判断是否追问；后台直接跳过。`reasonCode` 为可持久化的固定原因代码（如 `duplicate`、`uncertain`），未提供时使用对应操作的通用代码。

`create/update/merge` 必须声明允许的 `category`、`stable=true`、`futureUseful=true`。语义判断由 Agent Model 负责；代码强制引用范围和写入约束。删除仅接受 `forget` 候选；事实变化通常是 `update`。矛盾且缺少可靠证据时应 `noop`，不能直接拼接为 `merge`。

合并在单个 SQLite 事务中更新保留项、合并来源引用、维护 FTS/向量、删除冗余项并写入审计，任一步失败整体回滚。`semantic_sources` 只保存 Session、消息 ID 和时间，不复制原文。全库单调版本由数据库触发器维护，覆盖手动及自动新增、更新和删除。检索或模型判断后发生并发变更时，重新检索和判断，最多尝试 3 次（含首次）；持续冲突、检索失败或模型失败均报错，不降级为新增。

每条管理操作最多 30 秒，支持取消；入队前检查 Loop 截止时间和取消信号，已入队任务不继承聊天取消。模型、查询及提交均检查取消，迟到响应不能提交写入。同一后台批次按顺序处理，后续候选能够看到前面的已提交变更。

### 聊天工具

`manage_memory` 只开放 `search` 与 `submit`，移除了直接 `create/update/delete` 和 `request_delete`、确认令牌参数。Runtime 为每个回合绑定当前用户消息 ID、Agent Model 与 observer，模型不能提供或伪造证据 ID。

工具 schema 按 action 声明必填字段：`search` 需要 `query`；`submit` 需要 `intent`、`subject`、`attribute`、`content`。提交缺少字段时会明确列出字段名，便于模型修正参数；不会自动猜测意图或主体。

```json
{"action":"submit","intent":"remember","subject":"用户","attribute":"饮品偏好","content":"喜欢红茶，通常上午喝"}
```

忘记请求使用 `intent: "forget"`，`content` 描述用户明确要求删除的内容。`search` 继续使用 `query`，只读返回相关记忆。手动管理页使用的显式 CRUD 接口继续可用。

### 后台 consolidation

Agent 页面每日首次进入时调用 `runtime.consolidate("daily")`，按服务端本地自然日持久化去重；刷新、重启不重复创建。页面 **Consolidate** 按钮调用 `runtime.consolidate("manual")`，允许额外执行。同一时刻只保留一个待执行或运行中的整理任务，自动和手动重复请求返回现有任务。Semantic Memory 为空时返回 `{ status: "skipped", reason: "no_semantic_memory" }`，不创建任务、run、trace 或每日占用记录。未配置模型时自动入口不占配额，手动入口明确报错。底层 `memory.consolidate(trigger)` 可在依赖尚未注入时持久入队。

整理仅输入全量 semantic facts 与已有元数据，不读取聊天或 Session Recall，不做漏记补偿或 episodic evidence 提炼。模型返回 update、merge、delete 及未解决冲突；无实际操作时必须返回显式 `noop` outcome，无变化使用 `no_change`，只有未解决冲突使用 `unresolved_conflict`。代码校验 ID、原因、重复目标和版本，直接修改现有事实，不保留旧版本；证据不足的冲突保留事实并记录跳过。聊天的 create/update/delete/merge/noop 管理与本流程独立。

模型固定使用 agentModel。请求按 Model Context Window 估算预算，预留最多 4096 输出 tokens（不超过窗口四分之一）及 512 安全余量。能一次处理则全量提交；否则按主题排序、按预算分组，逐对合并分组进行审查，覆盖跨组关联。最多 256 个子任务，超限或单条事实无法放入时明确失败，不截断正文。分组后发生内容增长导致超限也明确报告；该机制提供共同审查机会，不保证自然语言语义判断绝对正确。

`memory_tasks` 保留父任务与子任务检查点。只持久保存事实 ID 和待提交的新建议，不保存旧事实快照。每次修改与检查点在同一事务提交；恢复不重放已提交操作。事实版本变化使未提交建议失效，重新读取当前批次审查。失败最多执行三次，间隔 1 秒、2 秒；单次整理尝试最多 5 分钟，不继承聊天取消信号。服务启动只恢复已有任务，新建 Session 不触发整理。

每个父任务独立一个 `consolidation-<taskId>.jsonl`，所有子任务与重试共用文件，整理过程不额外产生 `system.jsonl`；记录触发来源、模型调用、批次进度、变更类型和错误，不记录事实正文。画布 consolidation 独立成区，与其他流程无连线；整理连线与记忆写入连线分别播放，新回合只重置记忆写入动画。完整机制与限制见 [Consolidation](./CONSOLIDATION.md)。

整理 trace 层级统一为 `consolidation → batch → model / reviewed / change`，不再包装 `memory_task`。根生命周期为 `consolidation_started`（trigger、attempt、createdAt）与 `consolidation_completed`（completedBatches）；失败后发出 `consolidation_retry`（等待重试）或 `consolidation_failed`（最终失败），包含 errorType、nextAttemptAt。所有整理事件关联 runId 和 attempt，不携带 taskId、taskKind、taskCreatedAt；创建时间仅保存在根开始事件。

批次按顺序发出 `consolidation_batch_started` → `consolidation_snapshot`（当前批次 factCount）→ `consolidation_model_started/completed/failed` → `consolidation_reviewed`（decisionCount、unresolvedConflicts）→ `consolidation_change`（action、reasonCode、targetId、deletedIds）→ `consolidation_batch_completed/failed`。无实际修改时仍发出 action 为 `noop` 的 `consolidation_change`，使 `no_change` 与 `unresolved_conflict` 可观察并计入跳过统计。批次事件携带零基 batchIndex、totalBatches；模型事件用 modelCallId 配对并记录模型名称、耗时或错误类型。空库没有批次或模型事件；断点恢复仍产生批次开始事件，已有建议直接进入 reviewed，不伪造快照或模型调用。所有批次及重试写入同一 `consolidation-<runId>.jsonl`，JSONL 保持扁平事件流。

### 事件与隐私

每条候选按以下顺序产生 observer 事件：

- `memory_candidate_extracted`：候选 ID、意图、证据 ID。
- `memory_search_completed`：候选 ID、检索结果 ID、语料版本和重试次数。
- `memory_model_started/completed/failed`：模型调用 ID、模型名称、耗时或错误类型；仅用于普通记忆写入。
- `memory_decision_completed` → `memory_validation_completed` → `memory_change_completed`：操作、固定原因代码、目标和被删除的 ID、耗时。
- 版本冲突产生 `memory_conflict` 并重新检索；失败产生 `memory_change_failed`。

事件关联 `runId`、`sessionId` 和 `candidateId`；JSONL 为事件添加时间戳与 sequence。新增管理事件与聊天记忆工具摘要不默认记录事实正文、查询或自由文本理由。`memory_changes` 保存来源、目标、证据引用和固定原因代码，不保留删除正文。模型判断必须读取相关原文；现有主模型请求 trace 的内容策略不由此流程改变。

`manage_memory` 只管理 Semantic Memory；历史对话通过只读 `session_search/session_read` 访问，删除 Session 使用 Session 入口。全库定期去重尚未实现，`merge` 只处理本次检索发现的重复记录。

## 当前取舍

- Dense 目前使用 SQLite 中的精确 cosine 全扫描；个人助理数据规模增大后可评估 ANN，但首版不做。
- 不索引工具结果可能漏掉仅存在于工具输出、且邻近对话没有关键词的事实。
- 当前 Session 全量 Working Memory 会持续增加费用与延迟，最终可能触发 Context Limit。
- session_read 只能向后连续读；锚点之前的内容需要用 sessionId 从头分页，人工检索场景下比双向扩窗多几步。
- 固定首尾锚点会占用返回预算；不足时低排名候选被省略。
- 当前不做时间衰减或 recency boost；它可能在未来作为明确的排序信号加入。

## Gate 的两路查询改写

一次 Gate 模型调用同时返回 `denseQuery`、`lexicalQuery` 与 `sessionRecall`：

- `denseQuery` 用于 Semantic Dense：结合近期对话补全指代，保留主体、关系、否定和约束，生成自然语言查询；套用 `queryTemplate` 后直接送入 Embedding，不经过 jieba 分词。
- `lexicalQuery` 用于 Semantic Lexical：提取稳定属性、实体和约束关键词，再通过 jieba 搜索分词与 FTS5 / BM25 召回。
- `sessionRecall.query` 保持事件、对象、时间或结果线索的关键词改写；Session Recall 仍只执行 Lexical。

例如“我喜欢喝什么”可生成 `denseQuery: "用户偏好的饮品"` 与 `lexicalQuery: "喜欢 偏好 饮品"`。所有改写只使用当前消息与近期对话已有信息，不猜测答案或补造实体。

Semantic 检索按全局模式执行所需路线，Hybrid 将两路独立候选融合。任一路查询缺失或空白时，该路回退到当前消息；Gate 失败时，两路及 Session 搜索一起回退到当前消息。手动 `searchSemantic` 和记忆管理检索不调用 Gate，直接把调用方提供的文本用于两路。

`retrieval_completed.semantic` 使用 `denseQuery`、`lexicalQuery` 和 `hits`，不再使用单一 `query`；JSONL 记录继续对两路查询递归脱敏。阶段事件只表示实际执行过的路线。

Gate、自动检索和每批 Embedding 调用的开始/结束事件携带相同 `operationId`；Gate 与 Embedding 同时携带模型名称，Embedding 还携带独立向量 Provider。Gate、记忆裁判和整理模型完成事件补充供应商返回的真实 `tokenUsage`，缺失时不估算。运行时导出详见 [Tracing](../tracing/README.md)。
