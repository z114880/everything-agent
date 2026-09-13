# 模拟数据

把一批可复现的模拟数据合并进现有的 Everything Agent 数据目录，用于在有真实体量的数据上测试检索、召回与页面展示。

数据由本地模拟模型驱动**真实** Agent Runtime 产生，全程没有外部网络调用，也不消耗模型额度。

```bash
pnpm run mock-data
```

默认把 `datasets/` 下全部尚未写入的数据集合并进仓库根的 `.everything/`——也就是 Web 控制台读取的真实数据目录。

| 选项 | 说明 |
| --- | --- |
| `--home <路径>` | 目标数据目录，默认 `.everything` |
| `--dataset <id>` | 只写入指定数据集，可重复 |
| `--sessions <数量>` | 每个数据集生成的会话数，默认 20 |
| `--seed <整数>` | 伪随机种子，默认 1 |
| `--force` | 忽略已写入判断，强制再写一遍 |
| `--consolidate` | 结束后触发一次 consolidation |
| `--list` | 只列出可用数据集 |

运行前请先停掉 `pnpm run dev:web`，避免两个进程同时写同一个 SQLite 库。

## 目录

```text
mock-data/
├── datasets/                    数据：每个 JSON 是一个独立数据集
│   └── personal-assistant.json
├── dataset.ts                   数据集加载与校验
├── conversations.ts             从数据集构建确定性会话
├── mock-provider.ts             本地模拟模型服务
├── manifest.ts                  写入清单与幂等判断
├── seed.ts                      合并写入编排
├── cli.ts                       命令行入口
└── test/
```

## 幂等：写过的数据不会重复写

每次写入都会在目标目录的 `mock-data-manifest.json` 中记录数据集 id、校验和与创建的 Session ID。再次运行时该数据集被跳过。

判断不只看清单，还会核对记录中的 Session 是否仍然存在于数据库：

- 会话仍在 → 跳过
- 会话已被清空 → 清单记录失效，**重新写入**
- 数据文件内容变了 → 仍然跳过，但提示内容已变更，需要 `--force` 才重写

这样避免了"清单说写过、库里其实没有"的不一致。`--force` 会在现有数据上追加，产生重复内容。

## 对现有数据的影响

**模型配置与密钥**：运行前备份 `config.json` 与 `.env`，运行后原样恢复。期间配置被临时指向本地模拟模型。

**向量索引不受影响**：写入时强制 `lexical_only` 并清空 Embedding 配置。这样 Semantic 写入不会调用远程服务，也不会向 active generation 写入模拟向量；`lexical_only` 同时绕过「配置与 active generation 一致」的校验，因此已有真实索引的目录也能安全写入。

代价是本次写入的 Semantic Memory **没有向量**。目标目录已有索引时命令行会提示：需要 Dense/Hybrid 检索时请在配置页重建 Embedding 索引。

**已有数据只增不改**：会话追加到现有库，不删除也不覆盖任何既有记录。

## 为什么不直接写数据库

数据全部由真实执行路径产生：真实的 Gate 判定、真实的检索、真实的工具执行、真实的记忆决策与校验、真实的 trace 写入。
被替换的只有模型响应本身——一个 OpenAI 兼容的本地 HTTP 服务，按 system prompt 的特征区分四类请求：

| 请求 | 识别特征 | 模拟响应 |
| --- | --- | --- |
| Gate 判定 | `只输出 JSON：{"intent"` | 按用户消息选择 `past_episode` / `fact_with_evidence` / `none` |
| 主模型 | 其余 | 按会话脚本发起工具调用，或给出最终回复 |
| 记忆决策 | `记忆管理模型` | 从候选自带的 `evidenceMessageIds` 回填，输出 `create` 或 `delete` |
| Semantic 整理 | `Semantic Memory 整理模型` | 空操作 `noop` / `no_change` |

因此数据结构、字段与事件顺序与真实运行完全一致；直接写 SQL 做不到这一点。

## 生成内容

单个数据集 20 个会话约 1 秒，产生约 70 个回合、200 余条 Chat Log、40 余次工具调用与十余条 Semantic Memory，记忆变更覆盖 `create`、`delete` 与两类 `noop`，trace 包含 `gate_*`、`lexical_retrieval_completed`、`tool_*`、`memory_*` 等事件。

Session 召回不生成向量，这是产品既定设计（见 `src/memory/retrieve/README.md`），不是这里的限制。

## 新增数据集

在 `datasets/` 下新建 JSON，文件名即数据集 id（小写字母、数字、连字符）：

```json
{
  "id": "your-dataset",
  "version": 1,
  "description": "一句话说明",
  "recallPrompts": ["上次我们聊到的那个安排，你还记得结论吗？"],
  "topics": [
    {
      "title": "会话标题",
      "subject": "用户",
      "facts": [{ "attribute": "属性名", "fact": "写入记忆的事实", "statement": "用户说出这个事实的原话" }],
      "followUp": "追问",
      "followUpReply": "助理回复",
      "detailQuestion": "细节追问",
      "detailReply": "助理回复"
    }
  ]
}
```

同一 topic 的多条 `facts` 会被重复出现的会话轮换使用，避免相同事实被前置去重全部拦成 `duplicate`。
