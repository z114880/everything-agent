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

## 已知空缺

向量索引只覆盖 `semantic` 语料。`embedding_chunks` 的 `corpus` 允许 `session`，`vector-store.ts` 也有对应的删除语句，但生产代码中**没有任何写入方**，`EmbeddingCallContext` 的 `run_complete` 用途同样没有使用点。
因此 Session 召回的 Dense 部分始终为空，实际只有 BM25 生效。这是产品当前状态，不是 Seed 的限制。
