// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EvaluationPage } from '../src/pages/evaluation/EvaluationPage';
import { MINIMUM_FEEDBACK_DURATION_MS } from '../src/lib/minimum-duration';
import type { EvaluationDashboard } from '../src/evaluation-api';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/evaluation-api', () => ({ evaluationRequest: request }));
let container: HTMLDivElement; let root: ReturnType<typeof createRoot>;
const dashboard: EvaluationDashboard = { configured: true, error: '', baseUrl: 'http://localhost:3300', projectId: 'p', webhookUrl: 'http://evaluation-gateway/trigger', approvals: [], runs: [{
  id: 'run', name: '真实 Experiment', datasetId: 'dataset', datasetName: '测试集', datasetVersion: '2026-09-20T00:00:00Z', memorySnapshot: false, terminalEnabled: false, createdAt: '2026-09-20T00:00:00Z', status: 'completed', items: [{ id: 'item', input: '问题', expectedOutput: '期望', output: ['回答'], traceId: 'trace', observationId: 'span', status: 'completed', sync: 'synced', events: [], scores: [], toolCalls: 1, inputTokens: null, outputTokens: null, approvalDenied: false }],
}] };
beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks();
  // Radix Select 依赖指针捕获与滚动 API，happy-dom 未实现，这里补最小组件桩
  const proto = globalThis.Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture = () => false;
  proto.setPointerCapture = () => {};
  proto.releasePointerCapture = () => {};
  proto.scrollIntoView = () => {};
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container); request.mockResolvedValue(structuredClone(dashboard));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });
async function click(label: string) { const button = [...container.querySelectorAll('button')].find(button => button.textContent?.includes(label)); expect(button).toBeDefined(); await act(async () => button!.click()); }
/** 打开数据集下拉框并选中指定项；选项渲染在 portal 中，因此从 document 查找。 */
async function pickDataset(name: string) {
  const trigger = container.querySelector<HTMLElement>('[role="combobox"]'); expect(trigger).not.toBeNull();
  await act(async () => { trigger!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' })); trigger!.click(); });
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(item => item.textContent?.includes(name)); expect(option).toBeDefined();
  await act(async () => { option!.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true })); option!.click(); });
}
/** 通过原生 setter 更新受控输入，确保 React 收到 input 事件。 */
async function enterName(value: string) {
  const input = container.querySelector('input');
  expect(input).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
it('本地启动可临时填写 Experiment 名称前缀，留空时不提交名称', async () => {
  await act(async () => root.render(<EvaluationPage />));
  const trigger = container.querySelector('[role="combobox"]');
  expect(trigger).not.toBeNull();
  expect(trigger!.textContent).toContain('选择数据集');
  expect(container.textContent).toContain('Langfuse 数据集');
  expect([...container.querySelectorAll('button')].some(button => button.textContent?.includes('Run Experiment'))).toBe(true);
  expect(container.textContent).toContain('不创建 Langfuse Experiment 记录');
  expect(container.querySelector('input')?.placeholder).toBe('留空时使用 Everything Agent');
  expect(container.querySelector('a')?.href).toBe('http://localhost:3300/project/p');
  request.mockResolvedValueOnce({ datasets: [{ id: 'dataset', name: '测试集' }] });
  await connectToPlatform();
  await pickDataset('测试集');
  expect(trigger!.textContent).toContain('测试集');
  const starts = () => request.mock.calls.filter(([, body]) => (body as { action?: string } | undefined)?.action === 'start').map(([, body]) => body);
  await click('Run Experiment');
  expect(starts()).toEqual([{ action: 'start', datasetName: '测试集' }]);
  await enterName('本地临时前缀');
  await click('Run Experiment');
  expect(starts().at(-1)).toEqual({ action: 'start', datasetName: '测试集', name: '本地临时前缀' });
  // 只输入空格等同于未填写，仍走默认名称前缀
  await enterName('   ');
  await click('Run Experiment');
  expect(starts().at(-1)).toEqual({ action: 'start', datasetName: '测试集' });
});
it('本地启动只提供名称输入，不提供 terminal 与 memorySnapshot 开关', async () => {
  await act(async () => root.render(<EvaluationPage />));
  expect(container.querySelector('input[type="checkbox"]')).toBeNull();
  expect(container.querySelectorAll('input').length).toBe(1);
  expect(container.textContent).toContain('memorySnapshot');
  expect(container.textContent).toContain('terminal');
});
it('执行完成但没有评分时明确等待，不宣称质量通过', async () => {
  await act(async () => root.render(<EvaluationPage />));
  expect(container.textContent).toContain('执行完成不代表质量通过'); expect(container.textContent).toContain('等待平台评分');
  await click('刷新评分'); expect(request).toHaveBeenCalledWith('', { action: 'refresh', runId: 'run' });
});
it('审批请求携带 Experiment 和用例身份，离开页面不取消后台运行', async () => {
  const waiting = structuredClone(dashboard); waiting.runs[0]!.status = 'running'; waiting.approvals = [{ id: 'approval', runId: 'run', itemId: 'item', command: 'git push', reason: '外部写入' }]; request.mockResolvedValue(waiting);
  await act(async () => root.render(<EvaluationPage />));
  expect(container.textContent).toContain('git push'); await click('拒绝');
  expect(request).toHaveBeenCalledWith('', { action: 'approve', runId: 'run', itemId: 'item', approvalId: 'approval', approved: false });
  await act(async () => root.render(null)); expect(request.mock.calls.some(([, body]) => body?.action === 'cancel')).toBe(false);
});
it('连接失败展示错误，不把失败伪装为空数据集', async () => {
  await act(async () => root.render(<EvaluationPage />)); request.mockRejectedValueOnce(new Error('平台断开')); await connectToPlatform(); expect(container.textContent).toContain('平台断开'); expect(container.querySelector('[role="alert"]')?.textContent).toContain('平台断开');
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
it('复制成功的提示用浮层展示并自动消失，不在页面里占位', async () => {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  await act(async () => root.render(<EvaluationPage />));
  request.mockResolvedValueOnce({ Authorization: 'Bearer dedicated-test-token' });
  await click('复制 authorization 值');
  const toast = container.querySelector('[role="status"]');
  expect(toast?.className).toBe('save-message');
  expect(toast?.textContent).toContain('authorization 值已复制');
  expect(toast?.textContent).toContain('Secret');
  // 与配置页一致：浮层挂在页面根节点下，不进入任何内容区块
  expect(toast?.closest('section')).toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(2_500));
  expect(container.querySelector('[role="status"]')).toBeNull();
});
it('复制失败按错误提示留在页面内，不显示成功浮层', async () => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async () => { throw new Error('剪贴板不可用'); }) } });
  await act(async () => root.render(<EvaluationPage />));
  request.mockResolvedValueOnce({ Authorization: 'Bearer dedicated-test-token' });
  await click('复制 authorization 值');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('剪贴板不可用');
  expect(container.querySelector('[role="status"]')).toBeNull();
});
/** 找到连接平台按钮，并取出它当前的加载动画状态。 */
function connectButton() {
  const button = [...container.querySelectorAll('button')].find(item => item.textContent?.includes('连接平台'));
  expect(button).toBeDefined();
  return { button: button!, spinning: button!.getAttribute('data-loading') === 'true', indicator: button!.querySelector('[data-slot="button-loading-indicator"]') };
}
/** 点击连接平台并走完最短反馈时长：按钮在动画期间保持禁用，等待结束后才能继续操作。 */
async function connectToPlatform() {
  await click('连接平台');
  await act(async () => vi.advanceTimersByTimeAsync(MINIMUM_FEEDBACK_DURATION_MS));
}
it('连接平台期间按钮转圈并禁用，最短反馈时长后给出成功提示', async () => {
  await act(async () => root.render(<EvaluationPage />));
  expect(connectButton().spinning).toBe(false);
  let release: (value: unknown) => void = () => {};
  request.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  await click('连接平台');
  const pending = connectButton();
  expect(pending.spinning).toBe(true);
  expect(pending.indicator).not.toBeNull();
  expect(pending.button.disabled).toBe(true);
  // 平台很快返回也要保留最短动画时间，先不结束加载状态
  await act(async () => { release({ datasets: [{ id: 'dataset', name: '测试集' }, { id: 'other', name: '第二集' }] }); await Promise.resolve(); });
  expect(connectButton().spinning).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(MINIMUM_FEEDBACK_DURATION_MS));
  expect(connectButton().spinning).toBe(false);
  const toast = container.querySelector('[role="status"]');
  expect(toast?.className).toBe('save-message');
  expect(toast?.textContent).toContain('平台连接正常，已发现 2 个数据集');
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
it('连接平台失败时停止动画，只用页面内错误提示', async () => {
  await act(async () => root.render(<EvaluationPage />));
  request.mockRejectedValueOnce(new Error('平台断开'));
  await connectToPlatform();
  expect(connectButton().spinning).toBe(false);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('平台断开');
  expect(container.querySelector('[role="status"]')).toBeNull();
});

it('配置入口常驻展示默认值，并展示 Experiment 采用的配置', async () => {
  const data = structuredClone(dashboard); data.runs[0]!.terminalEnabled = true; request.mockResolvedValue(data);
  await act(async () => root.render(<EvaluationPage />));
  expect(container.textContent).toContain('{"terminal":false,"memorySnapshot":false}');
  expect(container.textContent).toContain('{"name":"Everything Agent"}');
  expect(container.textContent).toContain('terminal：true');
  expect(container.textContent).toContain('memorySnapshot：false');
  expect([...container.querySelectorAll('code')].some(code => code.textContent === 'authorization')).toBe(true);
  expect(container.textContent).toContain('via Webhook');
  expect(container.textContent).toContain('Set up remote experiment trigger in UI');
  expect([...container.querySelectorAll('details')].some(item => item.textContent?.includes('从 Langfuse 管理平台发起 Experiment'))).toBe(false);
});
it('实验配置的示例框与回调地址、Default config 使用各自合适的代码框样式', async () => {
  await act(async () => root.render(<EvaluationPage />));
  const blocks = [...container.querySelectorAll('code')].map(code => ({ text: code.textContent ?? '', classes: code.className }));
  const metadata = blocks.find(block => block.text === '{"terminal":false,"memorySnapshot":false}');
  // 数据集 Metadata 示例是整行示例，保留块级代码框的内边距
  expect(metadata?.classes).toContain('eval-code-block');
  expect(metadata?.classes).toContain('p-3');
  const webhook = [...container.querySelectorAll('code')].find(code => code.textContent === dashboard.webhookUrl);
  expect(webhook).toBeDefined();
  // 回调地址紧跟在“URL 填回调地址”之后，同一段落内不另起一行
  expect(webhook!.previousSibling?.nodeType).toBe(Node.TEXT_NODE);
  expect(webhook!.closest('p')?.textContent).toContain('URL 填回调地址');
  expect(webhook!.closest('p')?.querySelector('br')).toBeNull();
  for (const text of [dashboard.webhookUrl, '{"name":"Everything Agent"}', 'authorization']) {
    const block = blocks.find(item => item.text === text);
    expect(block).toBeDefined();
    // 短值用内联代码框（CSS 里按行高给内边距），不套用块级示例的 p-3，否则框明显大于文字
    expect(block!.classes).toContain('eval-code-inline');
    expect(block!.classes).not.toContain('eval-code-block');
    expect(block!.classes).not.toContain('p-3');
  }
});
it('运行区说明用换行分隔用例边界与输入格式', async () => {
  await act(async () => root.render(<EvaluationPage />));
  const note = [...container.querySelectorAll('p')].find(item => item.textContent?.includes('与平台入口共用同一执行过程'));
  expect(note).toBeDefined();
  const br = note!.querySelector('br');
  // JSX 源码里的换行会被折叠成空格，这一处换行必须由 <br /> 产生
  expect(br).not.toBeNull();
  expect(br!.previousSibling?.textContent).toContain('需要审批时暂停该用例。');
  expect(br!.nextSibling?.textContent).toContain('输入支持字符串');
});
it('平台启动说明与 Langfuse v4 实际界面一致，不残留不存在的老文案', async () => {
  await act(async () => root.render(<EvaluationPage />));
  expect(container.textContent).toContain('Run experiment');
  expect(container.textContent).toContain('Experiments');
  expect(container.textContent).toContain('Default config');
  expect(container.textContent).toContain('Sign requests');
  expect(container.textContent).toContain('Run remote dataset run');
  for (const outdated of ['Start Experiment', 'Custom Experiment', 'Default payload']) expect(container.textContent).not.toContain(outdated);
});
it('Experiment 记录每页十条，翻页及轮询保留选中 Experiment', async () => {
  const data = structuredClone(dashboard);
  data.runs = Array.from({ length: 12 }, (_, i) => ({ ...structuredClone(dashboard.runs[0]!), id: String(i), name: `Experiment 记录-${i}` }));
  request.mockResolvedValue(data);
  await act(async () => root.render(<EvaluationPage />));
  const records = () => container.querySelector('[aria-label="Experiment 记录"]')!;
  expect(records().querySelectorAll('button[aria-pressed]').length).toBe(10);
  await click('下一页');
  expect(records().querySelectorAll('button[aria-pressed]').length).toBe(2);
  await click('Experiment 记录-11');
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(records().textContent).toContain('第 2 / 2 页');
  expect(records().querySelector('[aria-pressed="true"]')?.textContent).toContain('Experiment 记录-11');
  await click('上一页');
  expect(container.querySelector('[aria-label="Experiment 详情"]')?.textContent).toContain('Experiment 记录-11');
});
