import { cp, mkdir, writeFile, lstat, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLocalConfig } from '../agent-runtime/index.ts';

/** 固定配置与可选记忆快照；用 SQLite 生成一致副本，不复制 WAL 文件，并清除待执行后台任务。 */
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
  try {
    // 用 VACUUM INTO 而不是 node:sqlite 的 backup()：两者都产出内容一致的副本，但 backup()
    // 是 libuv 线程池任务，其完成回调依赖事件循环被唤醒；进程空闲时这个唤醒可能延迟数十秒
    // （实测在 Vitest 里第 2 次备份稳定卡 30 秒，加任意定时器则立刻恢复）。VACUUM INTO 是
    // 同步 SQL，不经过线程池。代价是复制期间阻塞事件循环，评估属于离线场景，可以接受。
    // 目标文件必须不存在，VACUUM INTO 不会覆盖已有文件。
    sourceDb.exec(`VACUUM INTO ${sqlString(join(target, 'database', 'state.db'))}`);
  } finally { sourceDb.close(); }
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

/** VACUUM INTO 的文件名是 SQL 字符串字面量，路径里的单引号必须成对转义。 */
function sqlString(value: string): string { return `'${value.replaceAll("'", "''")}'`; }
