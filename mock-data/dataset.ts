import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import { join } from "node:path";

/** 用户在对话中陈述的一条稳定事实，会经 manage_memory 进入 Semantic Memory。 */
export interface DatasetFact {
  attribute: string;
  fact: string;
  statement: string;
}

export interface DatasetTopic {
  title: string;
  subject: string;
  /** 同一主题的多个不同侧面；重复出现的会话轮换使用，避免全部被前置去重拦成 duplicate。 */
  facts: DatasetFact[];
  followUp: string;
  followUpReply: string;
  detailQuestion: string;
  detailReply: string;
}

export interface Dataset {
  id: string;
  version: number;
  description: string;
  recallPrompts: string[];
  topics: DatasetTopic[];
  /** 内容校验和；数据文件被修改后与已写入记录不一致，写入前会给出提示。 */
  checksum: string;
}

const DATASET_DIRECTORY = fileURLToPath(new URL("./datasets/", import.meta.url));

/** 列出 `datasets/` 下全部数据集的 id，按文件名排序。 */
export async function listDatasetIds(): Promise<string[]> {
  const entries = await readdir(DATASET_DIRECTORY);
  return entries.filter((entry) => entry.endsWith(".json")).map((entry) => entry.replace(/\.json$/, "")).sort();
}

/** 读取并校验一个数据集；文件名必须与其中的 id 一致。 */
export async function loadDataset(id: string): Promise<Dataset> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new TypeError(`数据集 id 只能包含小写字母、数字和连字符：${id}`);
  const raw = await readFile(join(DATASET_DIRECTORY, `${id}.json`), "utf8");
  const value = JSON.parse(raw) as Partial<Dataset>;
  if (value.id !== id) throw new TypeError(`数据集 ${id}.json 的 id 字段与文件名不一致`);
  if (!Number.isInteger(value.version) || (value.version ?? 0) < 1) throw new TypeError(`数据集 ${id} 缺少有效 version`);
  if (!Array.isArray(value.topics) || !value.topics.length) throw new TypeError(`数据集 ${id} 至少需要一个 topic`);
  if (!Array.isArray(value.recallPrompts) || !value.recallPrompts.length) throw new TypeError(`数据集 ${id} 至少需要一条 recallPrompt`);
  value.topics.forEach((topic, index) => validateTopic(topic, `${id}.topics[${index}]`));
  return {
    id, version: value.version!, description: String(value.description ?? ""),
    recallPrompts: value.recallPrompts, topics: value.topics,
    checksum: createHash("sha256").update(raw).digest("hex").slice(0, 16),
  };
}

function validateTopic(topic: DatasetTopic, path: string): void {
  for (const key of ["title", "subject", "followUp", "followUpReply", "detailQuestion", "detailReply"] as const) {
    if (typeof topic[key] !== "string" || !topic[key].trim()) throw new TypeError(`${path}.${key} 必须是非空字符串`);
  }
  if (!Array.isArray(topic.facts) || !topic.facts.length) throw new TypeError(`${path}.facts 至少需要一条事实`);
  topic.facts.forEach((fact, index) => {
    for (const key of ["attribute", "fact", "statement"] as const) {
      if (typeof fact[key] !== "string" || !fact[key].trim()) throw new TypeError(`${path}.facts[${index}].${key} 必须是非空字符串`);
    }
  });
}
