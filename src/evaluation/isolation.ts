import { cp, mkdir, writeFile, lstat, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { createLocalConfig } from '../agent-runtime/index.ts';

/** 固定配置与可选记忆快照；备份 SQLite 而非复制 WAL 文件，清除待执行后台任务。 */
export async function prepareEvaluationHome(source: string, target: string, memorySnapshot: boolean): Promise<void> {
  await mkdir(target, { recursive: true, mode: 0o700 });
  for (const name of ['config.json', '.env', 'EVERYTHING.md', 'skills']) {
    try {
      const path = join(source, name);
      if ((await lstat(path)).isSymbolicLink()) throw new Error('评估配置不能引用符号链接');
      await cp(path, join(target, name), { recursive: true, filter: async entry => {
        if ((await lstat(entry)).isSymbolicLink()) throw new Error('评估配置不能引用符号链接');
        return true;
      } });
    } catch (error) { if (!isMissing(error)) throw error; }
  }
  const config = createLocalConfig({ home: target, defaultSystemPromptPath: join(source, 'EVERYTHING.md') });
  await config.initialize();
  const sourceValues = await createLocalConfig({ home: source, defaultSystemPromptPath: join(source, 'EVERYTHING.md') }).readValues();
  const secretKeys = new Set(['EVERYTHING_AGENT_API_KEY', 'EVERYTHING_SMALL_API_KEY', 'EVERYTHING_EMBEDDING_API_KEY', 'TAVILY_API_KEY']);
  await config.updateConfigFile({ ...Object.fromEntries(Object.entries(sourceValues).filter(([key]) => !secretKeys.has(key))), EVERYTHING_SANDBOX_WORKSPACE_ROOT: join(target, 'sandbox') });
  await config.updateSecretEnvFile(Object.fromEntries(Object.entries(sourceValues).filter(([key]) => secretKeys.has(key))), []);
  if (!memorySnapshot) return;
  const databasePath = join(source, 'database', 'state.db');
  // 缺少记忆库时明确失败，不把空记忆伪装成成功快照。
  await lstat(databasePath);
  await mkdir(join(target, 'database'), { recursive: true });
  const sourceDb = new DatabaseSync(databasePath, { readOnly: true });
  try { await backup(sourceDb, join(target, 'database', 'state.db')); } finally { sourceDb.close(); }
  const snapshot = new DatabaseSync(join(target, 'database', 'state.db'));
  try { snapshot.exec('DELETE FROM memory_tasks; DELETE FROM consolidation_days;'); } finally { snapshot.close(); }
}

/** 提取运行凭证用于评估脱敏，文件缺失时使用进程允许的密钥。 */
export async function evaluationSecrets(home: string): Promise<string[]> {
  const values = await createLocalConfig({ home, defaultSystemPromptPath: join(home, 'EVERYTHING.md') }).readValues();
  return Object.entries(values).filter(([key]) => /API_KEY$/.test(key)).map(([, value]) => value).filter(Boolean);
}

/** 原子写入运行状态，避免进程中断留下半个 JSON。 */
export async function writeEvaluationJson(path: string, value: unknown): Promise<void> {
  await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}

function isMissing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT'; }
