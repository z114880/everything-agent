import { fileURLToPath, URL } from "node:url";
import { listDatasetIds } from "./dataset.ts";
import { seedFakeData } from "./seed.ts";

/**
 * 命令行入口：`pnpm run fake-data`。
 * 默认把假数据合并进仓库根的 `.everything`，即 Web 控制台读取的真实数据目录。
 */
const args = parseArguments(process.argv.slice(2));
if (args.help) {
  console.log(`用法：pnpm run fake-data [选项]

  --home <路径>        目标数据目录，默认 .everything
  --dataset <id>       只写入指定数据集，可重复；默认写入全部未写入的数据集
  --sessions <数量>    每个数据集生成的会话数，默认 20
  --seed <整数>        伪随机种子，默认 1；相同种子产生相同数据
  --force              忽略已写入判断，强制再写一遍（会产生重复数据）
  --consolidate        结束后触发一次 consolidation
  --list               只列出可用数据集
  --help               显示本说明

已写入过的数据集会被自动跳过。数据由本地假模型驱动真实 Runtime 生成，
不发生任何外部网络调用；目标目录的模型配置与密钥在运行后原样恢复。`);
  process.exit(0);
}
if (args.list) {
  for (const id of await listDatasetIds()) console.log(id);
  process.exit(0);
}

const result = await seedFakeData({
  home: args.home ?? fileURLToPath(new URL("../.everything/", import.meta.url)),
  ...(args.datasets.length ? { datasetIds: args.datasets } : {}),
  sessionCount: args.sessions ?? 20,
  seed: args.seed ?? 1,
  force: args.force,
  consolidate: args.consolidate,
  onProgress: (message) => console.log(`· ${message}`),
});

console.log(`\n目标目录 ${result.home}`);
for (const outcome of result.outcomes) {
  console.log(outcome.skipped
    ? `  ${outcome.datasetId}：跳过（${outcome.reason}）`
    : `  ${outcome.datasetId}：写入 ${outcome.sessionCount} 个会话 / ${outcome.runCount} 个回合 / ${outcome.toolCallCount} 次工具调用`);
}
if (result.sessionsCreated) {
  console.log(`
本次新增
  会话 / 回合     ${result.sessionsCreated} / ${result.runsExecuted}
  Chat Log 记录   ${result.chatLogAdded}
  Semantic Memory ${result.semanticMemoryAdded}
  Consolidation   ${result.consolidationRan ? "已执行" : "未执行"}
  用时            ${result.ms} ms`);
  if (result.embeddingIndexPresent) {
    console.log(`
注意：目标目录已有向量索引，但本次写入的 Semantic Memory 没有生成向量
（假向量会污染真实索引）。需要 Dense/Hybrid 检索时请在配置页重建 Embedding 索引。`);
  }
} else {
  console.log("\n没有需要写入的数据集。");
}

interface CliArguments {
  home?: string;
  datasets: string[];
  sessions?: number;
  seed?: number;
  force: boolean;
  consolidate: boolean;
  list: boolean;
  help: boolean;
}

function parseArguments(argv: string[]): CliArguments {
  const parsed: CliArguments = { datasets: [], force: false, consolidate: false, list: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    // pnpm run 会把分隔符本身也传给脚本。
    if (flag === "--") continue;
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new TypeError(`${flag} 缺少取值`);
      index += 1;
      return value;
    };
    if (flag === "--home") parsed.home = next();
    else if (flag === "--dataset") parsed.datasets.push(next());
    else if (flag === "--sessions") parsed.sessions = positiveInteger(next(), "--sessions");
    else if (flag === "--seed") parsed.seed = positiveInteger(next(), "--seed");
    else if (flag === "--force") parsed.force = true;
    else if (flag === "--consolidate") parsed.consolidate = true;
    else if (flag === "--list") parsed.list = true;
    else if (flag === "--help" || flag === "-h") parsed.help = true;
    else throw new TypeError(`未知参数：${flag}`);
  }
  return parsed;
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new TypeError(`${flag} 必须是正整数`);
  return parsed;
}
