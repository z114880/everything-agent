import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parseEnv } from '../../src/agent-runtime/index.ts';
import { EvaluationService, LangfuseEvaluationClient, evaluationWebhook } from '../../src/evaluation/index.ts';
import type { EvaluationInput, LangfuseConfiguration } from '../../src/evaluation/index.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = join(root, '.evaluations', 'langfuse-v4');
let service: EvaluationService | undefined;
let client: LangfuseEvaluationClient | undefined;
let configuration: LangfuseConfiguration | undefined;
let listener: ReturnType<typeof createServer> | undefined;
let token = '';
let connectionError = '';
let starting: Promise<void> | undefined;
const port = Number(process.env.EVERYTHING_EVALUATION_PORT ?? 4319);

/** 开发服务器启动时建立独立回调入口；未配置时页面显示原因，聊天仍可使用。 */
export async function startEvaluation(): Promise<void> {
  if (service) return;
  if (starting) return starting;
  starting = initializeEvaluation().finally(() => { starting = undefined; });
  return starting;
}

async function initializeEvaluation(): Promise<void> {
  try {
    const concurrency = Number(process.env.EVERYTHING_EVALUATION_CONCURRENCY ?? 3);
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('EVERYTHING_EVALUATION_CONCURRENCY 必须是正安全整数');
    let env: Record<string, string> = {};
    try { env = parseEnv(await readFile(join(root, '.langfuse', 'compose.env'), 'utf8')); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    configuration = {
      baseUrl: process.env.LANGFUSE_BASE_URL ?? 'http://localhost:3300',
      publicKey: process.env.LANGFUSE_PUBLIC_KEY ?? env.LANGFUSE_INIT_PROJECT_PUBLIC_KEY ?? '',
      secretKey: process.env.LANGFUSE_SECRET_KEY ?? env.LANGFUSE_INIT_PROJECT_SECRET_KEY ?? '',
      projectId: process.env.LANGFUSE_PROJECT_ID ?? env.LANGFUSE_INIT_PROJECT_ID ?? '',
    };
    if (!configuration.publicKey || !configuration.secretKey || !configuration.projectId) throw new Error('缺少 Langfuse 项目 ID 或 API 凭证');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const tokenFile = join(directory, 'webhook-token');
    try { token = (await readFile(tokenFile, 'utf8')).trim(); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      token = randomBytes(32).toString('hex'); await writeFile(tokenFile, token, { mode: 0o600, flag: 'wx' });
    }
    if (token.length < 32) throw new Error('实验入口令牌无效');
    client = new LangfuseEvaluationClient(configuration);
    const next = new EvaluationService({ directory, sourceHome: join(root, '.everything'), client, concurrency });
    await next.initialize();
    listener = createServer((request, response) => { void evaluationWebhook({ token, projectId: configuration!.projectId, start: input => next.start(input) })(request, response); });
    listener.requestTimeout = 15_000;
    await new Promise<void>((resolve, reject) => { listener!.once('error', reject); listener!.listen(port, '0.0.0.0', () => { listener!.removeListener('error', reject); resolve(); }); });
    service = next; connectionError = '';
  } catch (error) { connectionError = error instanceof Error ? error.message : String(error); }
}
/** 关闭回调监听及进行中的评估，热重启也不会自动重跑。 */
export async function closeEvaluation(): Promise<void> {
  await starting;
  const current = listener; const active = service;
  listener = undefined; service = undefined;
  if (current?.listening) {
    const closed = new Promise<void>(resolve => { current.close(() => resolve()); });
    current.closeAllConnections();
    await closed;
  }
  await active?.close();
}
/** 本地页面的运行摘要；不返回 Langfuse API 凭证。 */
export function evaluationDashboard() {
  return { configured: Boolean(service), error: connectionError, baseUrl: configuration?.baseUrl ?? '', projectId: configuration?.projectId ?? '',
    webhookUrl: 'http://evaluation-gateway/trigger', runs: service?.list() ?? [], approvals: service?.approvals() ?? [] };
}
/** 查询平台连接与数据集，避免每次进度轮询都访问平台。 */
export async function evaluationDatasets() { if (!service) await startEvaluation(); if (!client) throw new Error(connectionError || 'Langfuse 尚未配置'); return { datasets: await client.datasets() }; }
/** 本地页面明确复制配置时才返回专用入口令牌。 */
export function evaluationWebhookHeaders() { if (!service) throw new Error(connectionError); return { Authorization: `Bearer ${token}` }; }
/** 本地管理操作；远程回调入口不能调用此函数。 */
export async function evaluationAction(body: Record<string, unknown>) {
  if (!service) throw new Error(connectionError || '评估服务尚未启动');
  if (body.action === 'start') return service.start(body as unknown as EvaluationInput);
  if (typeof body.runId !== 'string') throw new Error('缺少运行 ID');
  if (body.action === 'cancel') return { cancelled: service.cancel(body.runId) };
  if (body.action === 'refresh') { await service.refresh(body.runId); return { ok: true }; }
  if (body.action === 'approve' && typeof body.itemId === 'string' && typeof body.approvalId === 'string' && typeof body.approved === 'boolean') return { ok: service.approve(body.runId, body.itemId, body.approvalId, body.approved) };
  throw new Error('未知评估操作');
}
