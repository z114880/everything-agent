import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { initializeLangfuseEnvironment } from './configuration.ts';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const directory = resolve(root, '.langfuse');
const envFile = resolve(directory, 'compose.env');
const command = process.argv[2] ?? 'up';
if (!['up', 'down', 'status'].includes(command)) throw new Error('支持的命令：up、down、status');
execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' });
if (command === 'up') await initializeLangfuseEnvironment(directory);
else await readFile(envFile);
const args = ['compose', '--env-file', envFile, '-f', resolve(root, 'deploy/langfuse/compose.yaml')];
// config --quiet 校验时不会把展开后的凭证打印到终端。
execFileSync('docker', [...args, 'config', '--quiet'], { stdio: 'inherit' });
const action = command === 'up' ? ['up', '-d', '--wait', '--wait-timeout', '240'] : command === 'down' ? ['down'] : ['ps'];
execFileSync('docker', [...args, ...action], { stdio: 'inherit' });
if (command === 'up') {
  console.log('Langfuse 已启动：http://localhost:3300');
  console.log('登录邮箱及随机密码位于 .langfuse/compose.env 的 LANGFUSE_INIT_USER_EMAIL / LANGFUSE_INIT_USER_PASSWORD。');
  console.log('启动 Agent：pnpm run dev:web，然后打开 Evaluation 页面。');
}
