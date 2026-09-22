// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EvaluationPage } from '../src/pages/evaluation/EvaluationPage';
import type { EvaluationDashboard } from '../src/evaluation-api';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/evaluation-api', () => ({ evaluationRequest: request }));
let container: HTMLDivElement; let root: ReturnType<typeof createRoot>;
const dashboard: EvaluationDashboard = { configured: true, error: '', baseUrl: 'http://localhost:3300', projectId: 'p', webhookUrl: 'http://evaluation-gateway/trigger', approvals: [], runs: [{
  id: 'run', name: '真实实验', datasetId: 'dataset', datasetName: '测试集', datasetVersion: '2026-09-20T00:00:00Z', memorySnapshot: false, terminalEnabled: false, createdAt: '2026-09-20T00:00:00Z', status: 'completed', items: [{ id: 'item', input: '问题', expectedOutput: '期望', output: ['回答'], traceId: 'trace', observationId: 'span', status: 'completed', sync: 'synced', events: [], scores: [], toolCalls: 1, inputTokens: null, outputTokens: null, approvalDenied: false }],
}] };
beforeEach(() => { vi.useFakeTimers(); vi.resetAllMocks(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); container = document.createElement('div'); document.body.append(container); root = createRoot(container); request.mockResolvedValue(structuredClone(dashboard)); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });
async function click(label: string) { const button = [...container.querySelectorAll('button')].find(button => button.textContent?.includes(label)); expect(button).toBeDefined(); await act(async () => button!.click()); }
it('保留本地启动但不提供或发送记忆快照开关', async () => {
  await act(async () => root.render(<EvaluationPage />));
  expect(container.querySelector('input[type="checkbox"]')).toBeNull();
  expect(container.querySelector('select[aria-label="评估数据集"]')).not.toBeNull();
  expect([...container.querySelectorAll('button')].some(button => button.textContent?.includes('启动实验'))).toBe(true);
  expect(container.textContent).toContain('memorySnapshot');
  expect(container.querySelector('a')?.href).toBe('http://localhost:3300/project/p');
  request.mockResolvedValueOnce({ datasets: [{ id: 'dataset', name: '测试集' }] });
  await click('连接平台');
  await click('启动实验');
  expect(request).toHaveBeenCalledWith('', { action: 'start', datasetName: '测试集' });
});
it('执行完成但没有评分时明确等待，不宣称质量通过', async () => {
  await act(async () => root.render(<EvaluationPage />));
  expect(container.textContent).toContain('执行完成不代表质量通过'); expect(container.textContent).toContain('等待平台评分');
  await click('刷新评分'); expect(request).toHaveBeenCalledWith('', { action: 'refresh', runId: 'run' });
});
it('审批请求携带实验和用例身份，离开页面不取消后台运行', async () => {
  const waiting = structuredClone(dashboard); waiting.runs[0]!.status = 'running'; waiting.approvals = [{ id: 'approval', runId: 'run', itemId: 'item', command: 'git push', reason: '外部写入' }]; request.mockResolvedValue(waiting);
  await act(async () => root.render(<EvaluationPage />));
  expect(container.textContent).toContain('git push'); await click('拒绝');
  expect(request).toHaveBeenCalledWith('', { action: 'approve', runId: 'run', itemId: 'item', approvalId: 'approval', approved: false });
  await act(async () => root.render(null)); expect(request.mock.calls.some(([, body]) => body?.action === 'cancel')).toBe(false);
});
it('连接失败展示错误，不把失败伪装为空数据集', async () => {
  await act(async () => root.render(<EvaluationPage />)); request.mockRejectedValueOnce(new Error('平台断开')); await click('连接平台'); expect(container.textContent).toContain('平台断开');
});
it('复制的是 Authorization 值，能够直接粘贴到平台请求头字段', async () => {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  await act(async () => root.render(<EvaluationPage />));
  request.mockResolvedValueOnce({ Authorization: 'Bearer dedicated-test-token' });
  await click('复制 authorization 值');
  expect(writeText).toHaveBeenCalledWith('Bearer dedicated-test-token');
  expect(writeText).not.toHaveBeenCalledWith(expect.stringContaining('{'));
});

it('配置入口常驻展示默认值，并展示实验采用的配置', async () => {
  const data = structuredClone(dashboard); data.runs[0]!.terminalEnabled = true; request.mockResolvedValue(data);
  await act(async () => root.render(<EvaluationPage />));
  expect(container.textContent).toContain('{"terminal":false,"memorySnapshot":false}');
  expect(container.textContent).toContain('{"name":"Everything Agent"}');
  expect(container.textContent).toContain('terminal：true');
  expect(container.textContent).toContain('memorySnapshot：false');
  expect(container.textContent).toContain('名称填 authorization');
  expect([...container.querySelectorAll('details')].some(item => item.textContent?.includes('从 Langfuse 管理平台发起实验'))).toBe(false);
});
it('实验记录每页十条，翻页及轮询保留选中实验', async () => {
  const data = structuredClone(dashboard);
  data.runs = Array.from({ length: 12 }, (_, i) => ({ ...structuredClone(dashboard.runs[0]!), id: String(i), name: `实验记录-${i}` }));
  request.mockResolvedValue(data);
  await act(async () => root.render(<EvaluationPage />));
  const records = () => container.querySelector('[aria-label="实验记录"]')!;
  expect(records().querySelectorAll('button[aria-pressed]').length).toBe(10);
  await click('下一页');
  expect(records().querySelectorAll('button[aria-pressed]').length).toBe(2);
  await click('实验记录-11');
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(records().textContent).toContain('第 2 / 2 页');
  expect(records().querySelector('[aria-pressed="true"]')?.textContent).toContain('实验记录-11');
  await click('上一页');
  expect(container.querySelector('[aria-label="实验详情"]')?.textContent).toContain('实验记录-11');
});
