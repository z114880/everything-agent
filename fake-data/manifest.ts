import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MANIFEST_FILE = "fake-data-manifest.json";

/** 一个数据集在目标目录中的写入记录。 */
export interface AppliedRecord {
  datasetId: string;
  version: number;
  checksum: string;
  appliedAt: string;
  sessionCount: number;
  /** 写入时创建的 Session ID；用于判断这批数据是否仍然存在。 */
  sessionIds: string[];
}

export interface Manifest {
  version: 1;
  applied: AppliedRecord[];
}

/** 读取目标目录的写入清单；不存在或损坏时返回空清单。 */
export async function readManifest(home: string): Promise<Manifest> {
  try {
    const value = JSON.parse(await readFile(join(home, MANIFEST_FILE), "utf8")) as Partial<Manifest>;
    if (value.version !== 1 || !Array.isArray(value.applied)) return { version: 1, applied: [] };
    return { version: 1, applied: value.applied };
  } catch { return { version: 1, applied: [] } }
}

/** 写回清单；同一 datasetId 只保留最后一次记录。 */
export async function writeManifest(home: string, record: AppliedRecord): Promise<void> {
  const manifest = await readManifest(home);
  const applied = manifest.applied.filter((item) => item.datasetId !== record.datasetId);
  applied.push(record);
  await writeFile(join(home, MANIFEST_FILE), `${JSON.stringify({ version: 1, applied }, null, 2)}\n`, "utf8");
}

export type SkipReason = "already-applied";

export interface ApplyDecision {
  skip: boolean;
  reason?: SkipReason;
  /** 数据文件内容已变更，但同一 datasetId 已写入过。 */
  checksumChanged?: boolean;
  previous?: AppliedRecord;
}

/**
 * 判断一个数据集是否需要写入。
 * 清单记录只有在对应 Session 仍然存在于数据库时才算数：数据被清空后可以重新写入，
 * 避免清单与实际数据不一致造成"记录说写过、库里其实没有"。
 */
export function decideApply(
  manifest: Manifest,
  datasetId: string,
  checksum: string,
  existingSessionIds: ReadonlySet<string>,
): ApplyDecision {
  const previous = manifest.applied.find((item) => item.datasetId === datasetId);
  if (!previous) return { skip: false };
  const survived = previous.sessionIds.some((id) => existingSessionIds.has(id));
  if (!survived) return { skip: false, previous };
  return {
    skip: true, reason: "already-applied", previous,
    ...(previous.checksum === checksum ? {} : { checksumChanged: true }),
  };
}
