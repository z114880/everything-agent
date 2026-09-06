import { readdir, rm } from "node:fs/promises";
import { join, parse, resolve } from "node:path";

const PRESERVED_FILES = new Set(["EVERYTHING.md", ".env"]);

/** 删除本地 Agent 数据目录中的全部内容，保留 procedural memory 和 .env 配置。 */
export async function clearEverythingData(home: string): Promise<void> {
  const target = resolve(home);
  if (target === parse(target).root) throw new TypeError("拒绝清理文件系统根目录");
  let entries: string[];
  try {
    entries = await readdir(target);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  await Promise.all(entries
    .filter((entry) => !PRESERVED_FILES.has(entry))
    .map((entry) => rm(join(target, entry), { recursive: true, force: true })));
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
