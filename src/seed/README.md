# Seed 测试数据生成

用本地假模型驱动**真实** Agent Runtime，生成完整的本地数据：SQLite（Session、Chat Log、FTS5 索引、Semantic Memory、审计与变更记录）、JSONL trace 与向量索引。

全程没有任何外部网络调用，也不消耗模型额度。同一 `seed` 与 `sessions` 永远产生完全相同的数据。

## 用法

```bash
pnpm run seed -- --sessions 60 --consolidate
```

| 选项 | 说明 |
| --- | --- |
| `--home <路径>` | 数据写入目录，默认仓库根的 `.everything-seed/` |
| `--sessions <数量>` | 会话数，默认 20 |
| `--seed <整数>` | 伪随机种子，默认 1 |
| `--retrieval <模式>` | `lexical_only` / `dense_only` / `hybrid`，默认 `hybrid` |
| `--no-embedding` | 跳过向量索引，检索退化为 `lexical_only` |
| `--consolidate` | 结束后触发一次 consolidation |

要在 Web 页面里直接查看生成的数据，把 `--home` 指向真实目录：

```bash
pnpm run seed -- --home ./.everything --sessions 40
```

这会与真实数据混在一起，只在明确需要时使用。

## 为什么不直接写数据库

数据全部由真实执行路径产生：真实的 Gate 判定、真实的检索与融合、真实的工具执行、真实的记忆决策与校验、真实的 trace 写入。
被替换的只有模型响应本身——一个 OpenAI 兼容的本地 HTTP 服务，按 system prompt 的特征区分四类请求：

| 请求 | 识别特征 | 假响应 |
| --- | --- | --- |
| Gate 判定 | `只输出 JSON：{"intent"` | 按用户消息选择 `past_episode` / `fact_with_evidence` / `none` |
| 主模型 | 其余 | 按会话脚本发起工具调用，或给出最终回复 |
| 记忆决策 | `记忆管理模型` | 从候选自带的 `evidenceMessageIds` 回填，输出 `create` 或 `delete` |
| Semantic 整理 | `Semantic Memory 整理模型` | 空操作 `noop` / `no_change` |

因此数据结构、字段与事件顺序与真实运行完全一致；直接写 SQL 做不到这一点。

Embedding 使用确定性词袋向量：共享词越多的文本向量越接近，保证 Dense 检索结果稳定可复现。它不表达真实语义，只保证同一文本每次得到同一向量。

## 生成的数据覆盖范围

以 60 个会话为例（约 2 秒）：

- 227 个回合、714 条 Chat Log（454 条可检索消息）、130 次工具调用
- 28 条 Semantic Memory，记忆变更覆盖 `create` / `delete` / `noop(duplicate)` / `noop(no_change)`
- 133 个 trace 文件、5,390 个事件、40 种事件类型，包含 `gate_*`、`dense_retrieval_completed`、`rrf_completed`、`mmr_completed`、`tool_*`、`memory_*`、`consolidation_*`
- 后台任务全部 `completed`，无失败任务

## 向量只覆盖 Semantic

生成的向量索引只有 `semantic` 语料，Session 召回不产生向量。这不是 Seed 的限制，而是产品的既定设计：
`src/memory/retrieve/README.md` 明确规定「Session Recall 始终只使用 FTS5 + BM25，不生成向量，不执行 RRF 或 MMR」，
成功 run 只维护消息级 FTS 投影。因此 `embeddingChunkCount` 等于 Semantic Memory 条数是预期结果。

附带一个观察：数据库为这个不做的能力保留了若干未使用结构——`embedding_chunks.corpus` 的 `'session'` 取值、
`session_id` 与 `anchor_message_id` 两列、`VectorStore.deleteActiveSession()`（仅被测试调用）以及
`EmbeddingCallContext.purpose` 的 `"run_complete"`。它们在生产代码中没有任何调用方。
