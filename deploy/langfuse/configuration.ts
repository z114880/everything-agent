import { chmod, cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

/** 首次生成私有部署凭证；重复调用只收紧文件权限，绝不覆盖已有账号和密钥。 */
export async function initializeLangfuseEnvironment(directory: string): Promise<string> {
  const file = resolve(directory, 'compose.env');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try { await readFile(file); }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    const password = randomBytes(24).toString('hex');
    const values = {
      POSTGRES_PASSWORD: password, DATABASE_URL: `postgresql://postgres:${password}@postgres:5432/postgres`,
      REDIS_AUTH: randomBytes(24).toString('hex'), CLICKHOUSE_PASSWORD: randomBytes(24).toString('hex'),
      MINIO_ROOT_PASSWORD: randomBytes(24).toString('hex'), SALT: randomBytes(32).toString('hex'),
      ENCRYPTION_KEY: randomBytes(32).toString('hex'), NEXTAUTH_SECRET: randomBytes(32).toString('hex'),
      LANGFUSE_INIT_ORG_ID: 'everything-agent', LANGFUSE_INIT_ORG_NAME: 'Everything Agent',
      LANGFUSE_INIT_PROJECT_ID: 'everything-agent', LANGFUSE_INIT_PROJECT_NAME: 'Everything Agent',
      LANGFUSE_INIT_PROJECT_PUBLIC_KEY: `pk-lf-${randomUUID()}`, LANGFUSE_INIT_PROJECT_SECRET_KEY: `sk-lf-${randomUUID()}`,
      LANGFUSE_INIT_USER_EMAIL: 'admin@everything.local', LANGFUSE_INIT_USER_NAME: '本地管理员',
      LANGFUSE_INIT_USER_PASSWORD: randomBytes(18).toString('base64url'),
    };
    await writeFile(file, Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n')+'\n', { mode: 0o600, flag: 'wx' });
  }
  await chmod(file, 0o600);
  return file;
}

/**
 * 把已生成的私有凭证同步到每个 release 构建产物目录，返回同步的产物数量。
 * 没有 release 目录或目录里没有 `everything-agent-*` 产物时静默返回 0。
 */
export async function syncComposeEnvToReleases(root: string, envFile: string): Promise<number> {
  const releaseDirectory = resolve(root, 'release');
  let entries: Dirent[];
  try { entries = await readdir(releaseDirectory, { withFileTypes: true }); }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    return 0;
  }
  const targets = entries.filter((entry) => entry.isDirectory() && entry.name.startsWith('everything-agent-'));
  for (const target of targets) {
    const directory = resolve(releaseDirectory, target.name, '.langfuse');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const destination = resolve(directory, 'compose.env');
    await cp(envFile, destination);
    await chmod(destination, 0o600);
  }
  return targets.length;
}
