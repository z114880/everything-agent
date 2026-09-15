import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile, readdir, lstat, symlink } from "node:fs/promises";
import { join } from "node:path";
import type { EvaluationExperiment } from "./types.ts";

export function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export function idPath(home: string, id: string): string { if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("实验 ID 无效"); return join(home, id); }
export async function writeJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${crypto.randomUUID()}.tmp`; await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 }); await rename(temp, path);
}
/** 实验元数据原子写入，不覆盖独立保存的执行证据。 */
export async function saveExperiment(home: string, experiment: EvaluationExperiment): Promise<void> {
  const directory = idPath(home, experiment.id); await mkdir(directory, { recursive: true }); await writeJson(join(directory, "experiment.json"), experiment);
}
export async function readExperiment(home: string, id: string): Promise<EvaluationExperiment> { return JSON.parse(await readFile(join(idPath(home, id), "experiment.json"), "utf8")) as EvaluationExperiment; }
export async function listExperiments(home: string): Promise<EvaluationExperiment[]> {
  await mkdir(home, { recursive: true }); const result: EvaluationExperiment[] = [];
  for (const entry of await readdir(home, { withFileTypes: true })) if (entry.isDirectory()) {
    try { result.push(await readExperiment(home, entry.name)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}
/** 固化实际执行源码并记录依赖锁文件摘要；拒绝源码符号链接。 */
export async function snapshotCode(sourceRoot: string, destination: string): Promise<string> {
  const entries: [string, string][] = [];
  async function visit(relative: string): Promise<void> {
    const path = join(sourceRoot, relative); const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error("评估源码快照不能包含符号链接");
    if (stat.isDirectory()) { for (const name of (await readdir(path)).sort()) await visit(`${relative}/${name}`); }
    else if (stat.isFile()) entries.push([relative, await readFile(path, "utf8")]);
  }
  await visit("src"); await visit("package.json"); await visit("pnpm-lock.yaml");
  for (const [relative, text] of entries) { const target = join(destination, relative); await mkdir(join(target, ".."), { recursive: true }); await writeFile(target, text); }
  await symlink(join(sourceRoot, "node_modules"), join(destination, "node_modules"), "dir");
  return hash(entries);
}
