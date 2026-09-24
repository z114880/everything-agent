import { expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeLangfuseEnvironment, syncComposeEnvToReleases } from '../configuration.ts';
import { parseEnv } from '../../../src/agent-runtime/index.ts';

it('首次生成独立随机凭证，重复配置保留账号及数据库密码', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'langfuse-config-'));
  try {
    const file = await initializeLangfuseEnvironment(directory);
    const before = await readFile(file, 'utf8'); const values = parseEnv(before);
    expect(values.DATABASE_URL).toContain(values.POSTGRES_PASSWORD);
    expect(values.LANGFUSE_INIT_PROJECT_PUBLIC_KEY).toMatch(/^pk-lf-/);
    expect(values.LANGFUSE_INIT_USER_PASSWORD!.length).toBeGreaterThan(20);
    expect(values.REDIS_AUTH).not.toBe(values.POSTGRES_PASSWORD);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await initializeLangfuseEnvironment(directory);
    expect(await readFile(file, 'utf8')).toBe(before);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('把同一份凭证同步到所有 release 产物目录，忽略无关目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'langfuse-sync-'));
  try {
    const envFile = join(root, 'compose.env');
    await writeFile(envFile, 'A=1\n', { mode: 0o600 });
    for (const name of ['everything-agent-darwin-arm64', 'everything-agent-linux-x64', 'other-dir']) {
      await mkdir(join(root, 'release', name), { recursive: true });
    }
    await writeFile(join(root, 'release', 'everything-agent.txt'), 'x');
    expect(await syncComposeEnvToReleases(root, envFile)).toBe(2);
    for (const name of ['everything-agent-darwin-arm64', 'everything-agent-linux-x64']) {
      const destination = join(root, 'release', name, '.langfuse', 'compose.env');
      expect(await readFile(destination, 'utf8')).toBe('A=1\n');
      expect((await stat(destination)).mode & 0o777).toBe(0o600);
    }
    await expect(stat(join(root, 'release', 'other-dir', '.langfuse'))).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('没有 release 目录时同步静默返回 0', async () => {
  const root = await mkdtemp(join(tmpdir(), 'langfuse-sync-empty-'));
  try {
    const envFile = join(root, 'compose.env');
    await writeFile(envFile, 'A=1\n', { mode: 0o600 });
    expect(await syncComposeEnvToReleases(root, envFile)).toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
