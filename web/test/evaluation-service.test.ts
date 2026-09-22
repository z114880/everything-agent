import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  construct: vi.fn(),
  missing: false, portBusy: false, listens: 0, closes: 0,
  start: vi.fn(async () => ({ id: 'run' })), refresh: vi.fn(async () => {}), approve: vi.fn(() => true),
}));
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(async () => {}), writeFile: vi.fn(async () => {}),
  readFile: vi.fn(async (path: string) => path.endsWith('compose.env')
    ? state.missing ? '' : 'LANGFUSE_INIT_PROJECT_PUBLIC_KEY=public\nLANGFUSE_INIT_PROJECT_SECRET_KEY=private\nLANGFUSE_INIT_PROJECT_ID=project'
    : 'dedicated-webhook-token-at-least-32-characters'),
}));
vi.mock('node:http', () => ({ createServer: () => {
  const server = Object.assign(new EventEmitter(), {
    listening: false, requestTimeout: 0,
    listen(_port: number, _host: string, ready: () => void) {
      state.listens++;
      queueMicrotask(() => { if (state.portBusy) server.emit('error', new Error('端口被占用')); else { server.listening = true; ready(); } });
    },
    close(done: () => void) { server.listening = false; state.closes++; done(); }, closeAllConnections() {},
  });
  return server;
} }));
vi.mock('../../src/evaluation/index.ts', () => ({
  EvaluationService: class {
    constructor(options: unknown) { state.construct(options); }
    async initialize() {} async close() {}
    list() { return []; } approvals() { return []; }
    start = state.start; refresh = state.refresh; approve = state.approve;
    cancel() { return true; }
  },
  LangfuseEvaluationClient: class { async datasets() { return [{ id: 'dataset', name: '测试集' }]; } },
  evaluationWebhook: vi.fn(() => vi.fn()),
}));
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); state.missing = false; state.portBusy = false; state.listens = 0; state.closes = 0;
  for (const key of ['EVERYTHING_EVALUATION_CONCURRENCY', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGFUSE_PROJECT_ID']) vi.stubEnv(key, undefined);
});
afterEach(() => vi.unstubAllEnvs());
it('并发初始化只绑定一次端口，关闭后可重新启动且不泄露平台凭证', async () => {
  const service = await import('../server/evaluation-service.ts');
  await Promise.all([service.startEvaluation(), service.startEvaluation()]);
  expect(state.listens).toBe(1); expect(service.evaluationDashboard().configured).toBe(true);
  expect(JSON.stringify(service.evaluationDashboard())).not.toContain('private');
  expect(service.evaluationWebhookHeaders().Authorization).toMatch(/^Bearer /);
  await service.closeEvaluation(); expect(state.closes).toBe(1);
  await service.startEvaluation(); expect(state.listens).toBe(2); await service.closeEvaluation();
});
it('端口恢复后连接平台会重新初始化入口，操作只走本地服务', async () => {
  const service = await import('../server/evaluation-service.ts'); state.portBusy = true;
  await service.startEvaluation(); expect(service.evaluationDashboard().error).toBe('端口被占用');
  state.portBusy = false; expect(await service.evaluationDatasets()).toEqual({ datasets: [{ id: 'dataset', name: '测试集' }] });
  expect(service.evaluationDashboard().configured).toBe(true);
  await service.evaluationAction({ action: 'approve', runId: 'run', itemId: 'item', approvalId: 'approval', approved: true });
  expect(state.approve).toHaveBeenCalledWith('run', 'item', 'approval', true);
  await service.evaluationAction({ action: 'refresh', runId: 'run' }); expect(state.refresh).toHaveBeenCalledWith('run');
  await expect(service.evaluationAction({ action: 'cancel' })).rejects.toThrow('运行 ID');
  await service.closeEvaluation();
});
it('没有凭证时页面提供明确原因，不启动回调端口', async () => {
  state.missing = true; const service = await import('../server/evaluation-service.ts');
  await service.startEvaluation(); expect(state.listens).toBe(0);
  expect(service.evaluationDashboard()).toMatchObject({ configured: false, error: '缺少 Langfuse 项目 ID 或 API 凭证' });
  await expect(service.evaluationAction({ action: 'start' })).rejects.toThrow('缺少');
});

it.each([[undefined, 3], ['1', 1], ['5', 5]] as const)('后端读取并发环境变量 %s，默认 3', async (value, expected) => {
  vi.stubEnv('EVERYTHING_EVALUATION_CONCURRENCY', value);
  const service = await import('../server/evaluation-service.ts');
  await service.startEvaluation();
  expect(state.construct).toHaveBeenCalledWith(expect.objectContaining({ concurrency: expected }));
  await service.closeEvaluation();
});
it.each(['', ' ', '0', '-1', '1.5', 'abc', 'Infinity', '9007199254740992'])('非法并发配置阻止启动并显示错误：%s', async (value) => {
  vi.stubEnv('EVERYTHING_EVALUATION_CONCURRENCY', value);
  const service = await import('../server/evaluation-service.ts');
  await service.startEvaluation();
  expect(service.evaluationDashboard()).toMatchObject({ configured: false, error: 'EVERYTHING_EVALUATION_CONCURRENCY 必须是正安全整数' });
  expect(state.listens).toBe(0);
  expect(state.construct).not.toHaveBeenCalled();
});
