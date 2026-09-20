import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeLangfuseEnvironment } from '../configuration.ts';
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
