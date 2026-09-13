import { fileURLToPath, URL } from "node:url";
import { seedEverythingData } from "./seed-runner.ts";
import type { RetrievalMode } from "../memory/index.ts";

/**
 * 命令行入口：`pnpm run seed -- --sessions 60`。
 * 默认写入仓库根的 `.everything-seed/`，不会触碰真实的 `.everything/`。
 */
const args = parseArguments(process.argv.slice(2));
if (args.help) {
  console.log(`用法：pnpm run seed -- [选项]

  --home <路径>        数据写入目录，默认 .everything-seed
  --sessions <数量>    生成的会话数，默认 20
  --seed <整数>        伪随机种子，默认 1；相同种子产生相同数据
  --retrieval <模式>   lexical_only | dense_only | hybrid，默认 hybrid
  --no-embedding       跳过向量索引，检索退化为 lexical_only
  --consolidate        结束后触发一次 consolidation
  --help               显示本说明

数据全部由本地假模型驱动真实 Runtime 生成，不发生任何外部网络调用。`);
  process.exit(0);
}

const result = await seedEverythingData({
  home: args.home ?? fileURLToPath(new URL("../../.everything-seed/", import.meta.url)),
  sessionCount: args.sessions ?? 20,
  seed: args.seed ?? 1,
  ...(args.retrieval ? { retrievalMode: args.retrieval } : {}),
  buildEmbeddingIndex: !args.noEmbedding,
  consolidate: args.consolidate,
  onProgress: (message) => console.log(`· ${message}`),
});

console.log(`
生成完成，用时 ${result.ms} ms
  目录            ${result.home}
  会话 / 回合     ${result.sessionCount} / ${result.runCount}
  Chat Log 记录   ${result.chatLogCount}（可检索消息 ${result.indexedMessageCount}）
  工具调用        ${result.toolCallCount}
  Semantic Memory ${result.semanticMemoryCount}
  向量 chunk      ${result.embeddingChunkCount}
  Trace 文件      ${result.traceFileCount}
  Consolidation   ${result.consolidationCount}
  假模型请求      gate ${result.providerStats.gate} / 主模型 ${result.providerStats.agent} / 记忆决策 ${result.providerStats.memoryDecision} / 整理 ${result.providerStats.consolidation} / embedding ${result.providerStats.embedding}`);

interface CliArguments {
  home?: string;
  sessions?: number;
  seed?: number;
  retrieval?: RetrievalMode;
  noEmbedding: boolean;
  consolidate: boolean;
  help: boolean;
}

function parseArguments(argv: string[]): CliArguments {
  const parsed: CliArguments = { noEmbedding: false, consolidate: false, help: false };
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
    else if (flag === "--sessions") parsed.sessions = positiveInteger(next(), "--sessions");
    else if (flag === "--seed") parsed.seed = positiveInteger(next(), "--seed");
    else if (flag === "--retrieval") parsed.retrieval = retrievalMode(next());
    else if (flag === "--no-embedding") parsed.noEmbedding = true;
    else if (flag === "--consolidate") parsed.consolidate = true;
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

function retrievalMode(value: string): RetrievalMode {
  if (value !== "lexical_only" && value !== "dense_only" && value !== "hybrid") {
    throw new TypeError("--retrieval 必须是 lexical_only、dense_only 或 hybrid");
  }
  return value;
}
