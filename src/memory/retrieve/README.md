# Memory Retrieval 设计

> 状态：规划中，尚未实现。本文记录 Dense、Lexical、RRF、MMR、Tokenizer 和向量索引的已确认设计，不代表当前代码已经具备这些能力。当前实现仍以 `src/memory/README.md` 描述为准。

## 目标与范围

Memory Retrieval 为两个互相隔离的语料域提供相关性检索：

- Semantic Memory：consolidation 后形成的稳定属性、偏好、持续项目事实、约束和承诺。
- Session Recall：历史 Session 中已经成功完成的 run，用于恢复事件经过和原始证据。

两个语料域都支持 Dense 与 FTS5 + BM25，但分别生成候选、融合和执行 MMR。Semantic Memory 与 Session Recall 不进入同一个候选池，也不互相竞争名额。

Session Recall 的 `recent` 模式只按时间读取；`session_read` 只按 Session ID 或 cursor 读取。二者都不经过 Dense、BM25、RRF 或 MMR。

## 目录与模块

计划目录如下：

```text
src/memory/retrieve/
├── index.ts
├── retrieval-engine.ts
├── types.ts
├── lexical/
│   ├── lexical-retriever.ts
│   ├── search-text.ts
│   ├── semantic-search.ts
│   └── session-search.ts
├── dense/
│   ├── embedding-client.ts
│   ├── tokenizer.ts
│   ├── chunker.ts
│   ├── vector-store.ts
│   ├── semantic-search.ts
│   └── session-search.ts
├── fusion/
│   ├── rrf.ts
│   └── mmr.ts
└── test/
    └── retrieval-engine.test.ts
```

`MemoryRuntime` 保持主要公开门面。调用方不需要了解远程 Embedding 协议、Tokenizer 文件、向量存储、候选聚合、RRF 或 MMR。

`RetrievalEngine` 是深模块，负责隐藏模式选择、两路召回、融合、多样化和错误语义。远程 Embedding 是内部 seam：生产使用 HTTP adapter，测试使用内存 adapter。`fusion/` 只包含确定性的纯计算，不访问网络或 SQLite。

`lexical/` 不导入 Dense 实现，保证没有 Embedding 配置时 lexical-only 仍可独立工作。公共类和函数需要中文 JSDoc；内部注释解释排序不变量、事务语义、隐私约束和错误模式，不逐行复述代码。

## 检索模式

配置页提供一个全局模式，同时作用于 Semantic Memory、Session Recall、`manage_memory search` 和 `session_search`：

```ts
type RetrievalMode = "dense_only" | "lexical_only" | "hybrid";
```

- `dense_only`：Dense 候选经过相似度阈值和 MMR。
- `lexical_only`：只使用 FTS5 + BM25，不执行 RRF 或 MMR。
- `hybrid`：Dense 与 BM25 各自产生候选，经过 RRF，再经过 MMR。

新安装和数据库升级后的默认模式是 `lexical_only`。没有完整有效的 active generation 时，不允许启用 `dense_only` 或 `hybrid`。

模式只决定查询路线，不决定是否维护向量。只要已经配置 Embedding，三种模式下的成功 run 和 Semantic Memory 变更都同步维护向量；Embedding 失败会使该次记忆写入失败。只有完全没有配置 Embedding 时，lexical-only 写入才不调用远程服务。

任何需要 Dense 的查询只要遇到远程错误、维度错误或不完整索引，就立即抛出异常并终止当前运行。系统不重试、不静默回退到 BM25，也不返回部分 Dense 结果。相似度阈值过滤后没有候选属于正常空结果，不属于故障降级。

## Embedding 协议与配置

首版只支持 OpenAI-compatible `POST /v1/embeddings`。Embedding 配置与聊天模型配置完全分离，禁止隐式复用聊天密钥。

必要配置包括：

| 配置 | 约定 |
| --- | --- |
| Base URL | 独立于聊天模型 |
| API Key | 使用独立凭证，不回退到 `OPENAI_API_KEY` |
| Model | 远程 Embedding 模型名 |
| Dimensions | 固定发送 `1024` |
| Embedding Tokenizer ID | 公开 Hugging Face `repository@40位commit` |
| Query Template | 默认 `{text}` |
| Document Template | 默认 `{text}` |
| Minimum Similarity | 默认 `0.30` |

Query Template 与 Document Template 只能包含一个 `{text}` 占位符，不支持任意代码或复杂模板。建索引只使用 Document Template，查询只使用 Query Template。模板增加的 token 计入输入限制。

所有请求固定发送 `dimensions: 1024`。服务不支持该参数、忽略参数、返回非 1024 维向量，或者同一 generation 内维度发生变化时，直接抛出异常。

远程向量先在本地执行 L2 normalization，再以 Float32 little-endian BLOB 保存。零向量、NaN、Infinity、缺失响应、重复或缺失 `index`、维度不一致都使整批请求失败。

### 批处理

- 每批最多 16 个 chunk。
- 每批最多 8,192 embedding tokens。
- 两个限制取先达到者。
- 批次严格串行，并发数为 1。
- 单次 HTTP 超时 60 秒。
- 429、5xx、超时和网络错误均不自动重试。
- 查询向量始终单独请求。

同一次 `retrieve()` 内，如果 Semantic Query 与 Session Query 在应用 Query Template 后完全相同，则复用一次查询向量。查询向量和查询文本不写入 SQLite，不做跨 run 持久缓存。

## Tokenizer 与 token 预算

### Tokenizer 来源

计划使用 `@huggingface/tokenizers`，加载 Embedding 模型或聊天模型对应的 `tokenizer.json` 与 `tokenizer_config.json`。Tokenizer 是本地分词规则，不包含或运行本地 Embedding 模型。

首版只允许公开 Hugging Face repository，并要求固定 40 位 commit SHA：

```text
owner/repository@0123456789abcdef0123456789abcdef01234567
```

不接受任意 URL，不支持私有或 gated repository，也不管理 HF Token。下载需要限制响应体积、校验 Content-Type、解析 JSON 并记录 SHA-256。缓存放入 `.everything/tokenizers/`，不得提交 Git。

### Dense 切块

Dense 使用 Embedding 模型自己的 tokenizer，天然兼容中文、英文和混合文本，不使用 `Intl.Segmenter` 或 Jieba。

| 参数 | 默认值 |
| --- | ---: |
| 目标 chunk | 400 tokens |
| chunk 硬上限 | 512 tokens |
| 相邻重叠 | 64 tokens |
| 最小尾块 | 80 tokens |

不设置字符上限。切块优先靠近段落和中英文句末标点；单个句子超过 512 tokens 时，才按 tokenizer offset 硬切。Tokenizer offset 用于把 token 范围准确映射回原始文本。尾块少于 80 tokens 时，在不超过 512 tokens 的前提下合并或扩大前一块。

应用 Query Template 后的查询超过 512 tokens 时直接失败，不截断，也不拆成多个查询向量。

### Chat Context

旧的字符预算将直接删除，不保留兼容字段：

| 配置 | 默认值 |
| --- | ---: |
| Session Recall Token Limit | 8,192 |
| Model Context Window | 32,768 |
| Max Output Tokens | 2,048 |
| 安全余量 | 512 |

实际输入预算为：

```text
inputBudget = modelContextWindow - maxOutputTokens - 512
```

完整计数需要覆盖 System Prompt、Working Memory、Semantic Memory、Session Recall、当前消息、工具 schema、工具调用、工具结果和协议包装。

Agent Loop 接受异步 `TokenCounter` 依赖，而不在核心调度中判断 Provider：

```ts
interface TokenCounter {
  countRequest(request: ModelRequest): Promise<number>;
  countText(text: string): Promise<number>;
}
```

Anthropic adapter 使用官方 `/v1/messages/count_tokens` 计算完整请求。OpenAI-compatible adapter 使用配置的 Chat Tokenizer；任意兼容服务没有统一的精确计数端点，因此保留 512-token安全余量。Session Recall 使用 Chat Tokenizer/TokenCounter，因为召回内容最终进入聊天模型；Dense chunk 使用 Embedding Tokenizer。

超过预算直接抛出异常，不静默裁剪 Working Memory 或工具结果。

## 索引语义

### Semantic Memory

一条事实是一个语义单元，只有超过 512 tokens 时才分块。Embedding 文档格式固定并版本化：

```text
主题：{subject}
内容：{content}
```

### Session Recall

一个成功完成的 run 是一个语义单元，正文超过 512 tokens 时再切块。Embedding 文档格式固定并版本化：

```text
用户：{userText}
助手：{finalAssistantText}
```

Session ID、run ID、message ID、时间、Session 标题、工具请求、工具结果、trace 和运行状态都不进入 Embedding 正文。

失败或未完成 run 只保留在 Chat Log 中供当前 Session UI 和审计查看：

- 不进入 FTS5。
- 不生成 chunk 或向量。
- 不参与 Semantic consolidation。
- Session 摘要仍可统计 `incompleteRunCount`。

所有模式都继续向用户流式展示模型回复。模型回复已经展示后，完整 run 的 Embedding 仍可能失败；此时 trace 同时保留“模型已生成回复”和“run 持久化失败”的事实，最终回复不保存为完成 run，也不进入任何检索索引。

成功 run 的流程是：模型生成最终回复，拼接固定文档格式，执行 Tokenizer 切块和远程 Embedding，最后在同一 SQLite 事务中保存最终回复、FTS5 投影和 active generation 向量。

## Lexical 检索

FTS5 继续使用现有中英文检索投影：

- 连续汉字生成二元组。
- 拉丁字母和数字保留连续 Unicode 单词。
- 使用 NFKC 与小写规范化。

Embedding Tokenizer 不参与 FTS5。模型 tokenizer 的 subword、词表 ID 和字节标记不适合作为通用 lexical 检索词。

Semantic Memory 使用 subject 与 content 的加权 BM25。Session Recall 仍在消息级 FTS5 上搜索，但在进入 RRF 前将命中映射为 `run_id`。

## 候选聚合

同一事实或 run 的多个 chunk/消息命中不累加：

- Dense 按事实 ID 或 `run_id` 分组，取最高 cosine 的 chunk 作为查询 anchor。
- BM25 按事实 ID 或 `run_id` 分组，取最佳 BM25 消息作为 anchor。
- 分组完成后再取每路 Top 50，避免长文因 chunk 多而获得不公平优势。
- 命中总数只进入 trace，不参与排序。

Dense 命中 Session chunk 后，最终仍从原始 Chat Log 恢复上下文，而不是把切块文本当成新的事实。

## 相似度阈值

Dense 候选在 RRF 或 MMR 之前应用 `minimumSimilarity`，默认值为 `0.30`。配置页字段旁提供 `?` 帮助，说明以下数值只是校准起点，不是官方通用阈值：

| 模型系列 | 建议起始值 |
| --- | ---: |
| OpenAI `text-embedding-3-*` | 0.30 |
| BGE / BGE-M3 | 0.45 |
| Qwen3-Embedding | 0.50 |
| GTE | 0.40 |
| Nomic Embed | 0.40 |
| Multilingual-E5 | 0.80 |
| 未知 OpenAI-compatible 模型 | 0.30 |

召回无关内容时可每次提高 0.05，经常漏掉同义表达时可每次降低 0.05。Query/Document Template 变化后需要重新校准。

配置页应提供测试查询，展示 Top 10 相似度和可供用户判断的文本摘要。低于阈值的候选被过滤后结果可以为空。

## RRF 融合

RRF 只在 hybrid 模式运行。Dense 与 BM25 各取 Top 50 个不同事实/run，使用固定等权公式：

```text
rrfScore(candidate) = Σ 1 / (60 + rankInRoute)
```

- `k=60`，不开放到配置页。
- Dense 与 BM25 权重固定为 1:1。
- 候选缺席某一路时，只贡献存在路线的分数。
- 分数相同时依次按 Dense rank、BM25 rank 和稳定 ID 决胜。

Semantic Memory 以 memory ID 为候选身份。Session Recall 以 `run_id` 为候选身份，避免同一 run 的多个消息或 chunk 挤占候选位。

## MMR 原理与代码语义

### MMR 解决什么问题

RRF 负责把 Dense 与 BM25 的排名合并，但不会阻止语义近似的候选同时占据前列。MMR（Maximal Marginal Relevance）在相关性与结果多样性之间做逐轮选择：

```text
MMR(candidate) =
  λ × relevance(candidate)
  - (1 - λ) × maxSimilarity(candidate, selected)
```

本设计固定 `λ=0.7`：70% 权重保留查询相关性，30% 权重惩罚与已选结果的重复度。λ 越大越偏向“最相关”，越小越偏向“彼此不同”。个人记忆需要优先保证准确，因此首版不把 λ 做成配置项；应在建立离线相关性评估集后再调整。

MMR 不是普通排序。它每选中一个候选，都要重新计算剩余候选与“已选集合”的最大相似度：

1. 第一个结果选择 relevance 最高者。
2. 对每个剩余候选，找出它与任一已选候选的最高 cosine。
3. 用公式计算新的 MMR score。
4. 选择本轮最高者，加入已选集合。
5. 重复直到达到 limit，或者没有可选候选。

### relevance 如何得到

- Dense-only：使用查询向量与候选向量的 cosine similarity。
- Hybrid：使用 `rrfScore / 当前最高 rrfScore` 归一化到 `[0,1]`。
- Lexical-only：不执行 MMR，因此完全不依赖向量。

候选间 cosine 截断到 `[0,1]` 后作为 redundancy；负相关不应给候选额外奖励。

### 多 chunk 候选

一个事实或 run 可能包含多个 chunk：

- 与查询的 relevance 取最高 chunk cosine。
- 两个候选间的 redundancy 取双方所有 chunk 两两 cosine 的最大值。

使用最大值是保守去重：只要两个长 run 中存在高度重复片段，就应承认这部分重复；不能用大量无关 chunk 的平均值稀释它。

### MMR 不是必然去重

普通 MMR 只给重复候选扣分，并不保证删除它。例如：

```text
重复候选：0.7 × 1.0 - 0.3 × 1.0 = 0.40
较弱新候选：0.7 × 0.5 - 0.3 × 0.0 = 0.35
```

重复候选仍可能获胜。因此本设计把完全重复保护放在 MMR 内部：

- 与任一已选候选 cosine `>= 0.999` 时，标记为 `excludedAsDuplicate`，不再选择。
- `0.90–0.999` 不硬删除，只使用标准 MMR 公式降权。
- 如果剩余候选全部被排除，结果可以少于请求数量。
- 不在 MMR 前使用内容 hash 折叠，也不因检索去重删除数据库内容。

### 示例

查询为“我喜欢喝什么”，初始候选如下：

```text
A：用户喜欢红茶
B：用户喜欢红茶
C：用户平时喝咖啡
```

第一轮 A 的 relevance 最高，因此先选 A。第二轮中，B 与 A 的 cosine 接近 1，被完全重复规则排除；C 虽然 relevance 略低，但提供了不同信息，因此被选择。数据库中的 B 不会被删除，只是不出现在本次结果中。

### 稳定性与 trace

MMR 分数相同时，按进入 MMR 前的排名和稳定 ID 决胜，保证相同输入产生可重复结果。

Trace 为每个候选记录：

- relevance
- 与已选集合的最大 redundancy
- MMR score
- 是否入选
- 是否因 `>=0.999` 被排除
- 造成最大冗余或排除它的候选 ID

Trace 不记录候选正文、查询正文或向量。

## 返回数量与上下文预算

不同调用方保留当前各自的 limit：

- 自动 `retrieve()`：Semantic Memory 最多 4 条，Session Recall 最多 4 个不同 Session。
- `manage_memory search`：最多 20 条。
- `session_search`：默认 4，最多 20 个 Session。
- Memory 管理页：全量浏览不经过 MMR；手动搜索最多 100 条。

MMR 的目标数量取调用方 limit。相似度阈值和完全重复排除都可能使实际数量少于 limit，系统不会用低质量或重复内容补足。

Session Recall 按排名顺序组装上下文。高排名 Session 尽可能使用完整窗口并优先消耗 8,192-token预算；剩余预算再分给后续 Session。预算不足时，后续 Session 按 Chat Tokenizer 的 token offset 截断或省略，不采用平均或轮转分配。

## 时间排序的明确取舍

当前设计不在 Dense、BM25、RRF 或 MMR 中加入 recency boost、时间衰减或新近权重。长期偏好、约束和承诺不应仅因为保存较早就变得难以检索。

用户明确要求最近历史时使用 `recent` 模式。时间只能在所有相关性信号完全相同时作为最终稳定决胜项，优先较新内容，不进入 score。

未来可以基于真实评估集研究时间权重，但这是未实现的路线图候选。若新事实覆盖旧事实，应优先在 Semantic consolidation 的更新与冲突规则中解决，而不是用时间衰减掩盖矛盾。

## Generation 与影子重建

Embedding Model、固定维度、Embedding Tokenizer revision、Tokenizer 文件哈希、Document Template、文档格式版本、切块参数、规范化版本中任一变化，都产生新的索引 generation。Query Template 和最低相似度变化不要求重建，但需要重新校准检索质量。

配置页使用“保存并重建”创建单一后台作业：

1. 返回 `rebuildId`，页面轮询状态。
2. 暂停新的 Agent run 和所有会改变检索语料的 Memory 写操作。
3. 保留当前配置与 active generation。
4. 使用新配置串行构建影子 generation。
5. 全部 chunk 成功、维度一致且数量校验通过后，在一个 SQLite 事务中切换 active generation。
6. 激活成功后删除旧 generation，再解除写入阻止。

任一批失败会立即停止作业、写 trace、删除影子 generation，并继续保留旧配置与旧索引，不自动重试。进程退出后，启动时把未完成作业标记为 `interrupted`、清理影子 generation，用户需要手动重试。

配置页提供取消按钮。取消中止当前 HTTP 请求，将作业标记为 `cancelled`，清理影子 generation，保留旧索引并解除写入阻止。页面关闭不等于取消。

没有旧 generation 的首次启用若失败，Dense/Hybrid 继续不可用。升级数据库不会自动上传历史数据或生成向量；首次 Dense/Hybrid 必须由用户显式配置并触发完整重建。

## 隐私与安全

启用 Dense/Hybrid 前，配置页必须明确提示 Semantic Memory 和历史成功 run 的正文会发送到远程 Embedding 服务。

Embedding trace 不记录：

- 原始查询或 Query Template 替换后的正文
- chunk 正文
- 向量
- API Key、Authorization 或其他凭证

Trace 只记录 corpus、稳定候选 ID、generation、模型、Tokenizer revision、token 数、批大小、维度、排名、分数、耗时、HTTP 状态和脱敏错误摘要。

SQLite 不重复保存不必要的私人正文；chunk 优先保存原始事实/run 的引用和 offset。删除原始记忆时在同一事务中删除派生向量。配置页提供“删除全部向量索引”，但该操作不删除原始记忆、FTS5 或 tokenizer cache。

## Observer 与 trace 事件

计划以分阶段事件替换旧的单一 `retrieval` 事件：

```text
embedding_started
embedding_completed
embedding_failed
dense_retrieval_completed
lexical_retrieval_completed
rrf_completed
mmr_completed
retrieval_completed
embedding_rebuild_started
embedding_rebuild_progress
embedding_rebuild_completed
embedding_rebuild_failed
embedding_rebuild_cancelled
embedding_generation_activated
```

事件需要关联 run、corpus、generation 和有序时间信息。重建事件关联 `rebuildId`。不同模式只发出真正执行过的阶段：lexical-only 不伪造 Dense/RRF/MMR，dense-only 不伪造 Lexical/RRF。

`embedding_failed` 的 purpose 至少区分 `query`、`memory_create`、`run_complete`、`rebuild` 和 `config_probe`。事件名称、关键字段和相对顺序必须通过行为测试验证。

## 实现与验证顺序

建议按以下顺序实现，每一步保持公开接口可运行：

1. 引入 Tokenizer 与 TokenCounter，把字符预算替换为 token 预算。
2. 拆出 `retrieve/lexical/`，保持现有 lexical 行为并排除失败 run。
3. 增加 Embedding HTTP adapter、切块器、向量 generation 和精确 cosine 搜索。
4. 为 Semantic 与 Session 分别实现 Dense 候选及 run 聚合。
5. 实现纯函数 RRF 与 MMR，并补充公式级和稳定性测试。
6. 接入三种全局模式与自动 Recall/工具的既有限制。
7. 增加影子重建、取消、原子切换和配置 UI。
8. 增加分阶段 observer/trace 与页面展示。
9. 更新根 README、Memory README、Agent Loop README 和配置说明，将规划能力改为已实现能力。

完成实现前，现有文档中的“当前只有 FTS5 + BM25”仍然是事实，不应提前改写。

## 最低行为测试

- 中文、英文、混合文本按目标 tokenizer 的真实 token 与 offset 切块。
- 400/512/64/80 token 规则覆盖段落、长句和短尾块。
- 维度、非法浮点、缺失 index、超时和 HTTP 错误立即失败且零重试。
- Semantic 与 Session 候选池严格隔离。
- 多 chunk/run 只以最高命中参与排名。
- Dense/BM25 Top 50、RRF `k=60`、等权和平分决胜确定可重复。
- MMR λ=0.7、多 chunk 最大相似度及 `>=0.999` 排除符合本文公式。
- 三种模式只执行并观察真实阶段。
- 失败 run 不进入 FTS5、Dense 或 consolidation。
- 已配置 Embedding 时，lexical-only 写入仍同步维护 active generation。
- 未配置 Embedding 时 lexical-only 不发起远程请求。
- 影子重建成功原子切换；失败、取消和重启中断都保留旧 generation。
- Session Recall 按排名优先消耗 8,192-token预算，截断发生在 token 边界。
- 自动 Recall、Agent 工具和 Memory 管理页分别保持既有限制。
- Trace 不泄露正文、向量或凭证。
- Context Window 计算包含完整请求并预留输出和 512 tokens。

