import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { EvaluationService, evaluationTurns, evaluationWebhook, LangfuseEvaluationClient, prepareEvaluationHome, redactEvaluation, createEvaluationRuntime } from '../index.ts';
import type { EvaluationOptions, EvaluationRun, EvaluationItem } from '../index.ts';
import { createAgentRuntime } from '../../agent-runtime/index.ts';

const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await Promise.all(dirs.map(path => rm(path, { recursive: true, force: true }))); dirs.length = 0; });
async function setup(run?: ReturnType<NonNullable<EvaluationOptions['createRuntime']>>['run']) {
  const directory = await mkdtemp(join(tmpdir(), 'evaluation-test-')); dirs.push(directory);
  const sourceHome = join(directory, 'source'); await mkdir(sourceHome);
  await writeFile(join(sourceHome, 'config.json'), JSON.stringify({ sandbox: { workspaceRoot: '/original' } }));
  await writeFile(join(sourceHome, '.env'), 'EVERYTHING_AGENT_API_KEY=secret-actual-key');
  const client = { dataset: vi.fn(async () => ({ id: 'dataset', items: [{ id: 'case', input: { turns: ['一', '二'] }, expectedOutput: '答案' }] })), publish: vi.fn(async () => {}), scores: vi.fn(async () => [{ id: 'score', name: '质量', value: 0.5 }]) };
  const execute = vi.fn<ReturnType<NonNullable<EvaluationOptions['createRuntime']>>['run']>(run ?? (async () => ({ reply: '答案', runId: 'agent-run', iterations: 1, stopReason: 'end_turn', toolCallCount: 0, failedToolCallCount: 0, derivedTaskIds: [], model: 'real-model', provider: 'anthropic' as const, ms: 1, retrievalMs: 0, modelMs: 1, toolMs: 0, contextWindow: 10000, contextSafetyTokens: 512, maxTokens: 100, availableInputTokens: 9388, peakEstimatedInputTokens: null, peakInputTokens: null })));
  const close = vi.fn(async () => {});
  const createRuntime: NonNullable<EvaluationOptions['createRuntime']> = () => ({ run: execute, close, createSession: async () => ({ id: 'session', title: '新会话', createdAt: '', updatedAt: '', messageCount: 0, completedRunCount: 0, incompleteRunCount: 0 }), listPendingApprovals: () => [], settleApproval: () => false });
  const options = { directory: join(directory, 'runs'), sourceHome, client, createRuntime };
  const service = new EvaluationService(options); await service.initialize(); return { service, client, execute, close, options, sourceHome };
}

describe('真实评估编排', () => {
  it('多轮用例复用会话，固定数据集版本并分别回传与评分', async () => {
    const { service, client, execute, sourceHome, options } = await setup();
    const started = await service.start({ datasetName: '测试集' }); await service.wait(started.id);
    const run = service.list()[0]!; expect(run.status).toBe('completed'); expect(run.items[0]?.output).toEqual(['答案', '答案']);
    expect(execute.mock.calls.map(([input]) => input.sessionId)).toEqual(['session', 'session']);
    expect(client.dataset).toHaveBeenCalledWith('测试集', started.datasetVersion);
    expect(client.publish).toHaveBeenCalledTimes(1); expect(run.items[0]?.scores).toEqual([]);
    await service.refresh(run.id); expect(service.list()[0]?.items[0]?.scores[0]?.value).toBe(0.5);
    expect(client.publish).toHaveBeenCalledTimes(1);
    const home = join(options.directory, run.id, run.items[0]!.traceId);
    expect(JSON.parse(await readFile(join(home, 'config.json'), 'utf8')).sandbox.workspaceRoot).toBe(join(home, 'sandbox'));
    expect(JSON.parse(await readFile(join(sourceHome, 'config.json'), 'utf8')).sandbox.workspaceRoot).toBe('/original');
    run.items[0]!.output.push('篡改'); expect(service.list()[0]?.items[0]?.output).toHaveLength(2);
  });
  it('同步失败可重试，真实操作不会重复执行；评分错误不会变为通过', async () => {
    const { service, client, execute } = await setup(); client.publish.mockRejectedValueOnce(new Error('断网'));
    const { id } = await service.start({ datasetName: '测试集' }); await service.wait(id);
    expect(service.list()[0]?.items[0]?.sync).toBe('failed');
    client.scores.mockRejectedValueOnce(new Error('评分不可用'));
    await service.refresh(id); expect(execute).toHaveBeenCalledTimes(2); expect(service.list()[0]?.scoreError).toBe('评分不可用');
    expect(service.list()[0]?.items[0]?.sync).toBe('synced');
  });
  it('模型失败留下可回传错误，凭证与模型上下文不进入评估事件', async () => {
    const { service } = await setup(async (_, options) => {
      await options.observer('model_request', { modelCallId: 'm1', request: { messages: '私人记忆' } });
      await options.observer('model_response', { modelCallId: 'm1', tokenUsage: { inputTokens: 3, outputTokens: 4 }, response: '私人记忆' });
      throw new Error('失败 secret-actual-key');
    });
    const { id } = await service.start({ datasetName: '测试集' }); await service.wait(id);
    const run = service.list()[0]!; expect(run.status).toBe('failed'); expect(run.items[0]?.inputTokens).toBe(3);
    expect(run.items[0]?.events.map(event => event.sequence)).toEqual([1, 2]);
    expect(JSON.stringify(run)).not.toContain('私人记忆'); expect(JSON.stringify(run)).not.toContain('secret-actual-key');
  });
  it('取消信号中止正在等待的用例，拒绝同时启动第二个实验', async () => {
    let ready!: () => void; const started = new Promise<void>(resolve => { ready = resolve; });
    const { service } = await setup(async (_, { signal }) => { ready(); await new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); throw new Error('不应继续'); });
    const { id } = await service.start({ datasetName: '测试集' }); await started;
    await expect(service.start({ datasetName: '第二个' })).rejects.toThrow('已有评估');
    expect(service.cancel(id)).toBe(true); await service.wait(id); expect(service.list()[0]?.status).toBe('cancelled');
    expect(service.approve(id, 'case', 'expired', true)).toBe(false); await service.close();
  });
  it('待审批请求绑定用例，批准后继续，重新提交过期审批无效', async () => {
    const context = await setup();
    let release!: (approved: boolean) => void;
    let visible!: () => void; const waiting = new Promise<void>(resolve => { visible = resolve; });
    let pending = true;
    const originalFactory = context.options.createRuntime;
    const originalRun = context.execute.getMockImplementation()!;
    context.options.createRuntime = home => ({ ...originalFactory(home),
      run: async (input, options) => {
        await options.observer('approval_requested', { approvalId: 'approval', command: 'git push' });
        const approved = await new Promise<boolean>(resolve => { release = resolve; visible(); });
        await options.observer('approval_resolved', { approvalId: 'approval', approved });
        return originalRun(input, options);
      },
      listPendingApprovals: () => pending ? [{ id: 'approval', kind: 'irreversible', command: 'git push', reason: '外部写操作', createdAt: '' }] : [],
      settleApproval: (id, approved) => { if (id !== 'approval' || !pending) return false; pending = false; release(approved); return true; },
    });
    context.client.dataset.mockResolvedValueOnce({ id: 'dataset', items: [{ id: 'case', input: { turns: ['一'] }, expectedOutput: '答案' }] });
    const { id } = await context.service.start({ datasetName: '审批' }); await waiting;
    expect(context.service.list()[0]?.items[0]?.status).toBe('waiting_approval');
    expect(context.service.approvals()[0]).toMatchObject({ runId: id, itemId: 'case', command: 'git push' });
    expect(context.service.approve(id, 'other', 'approval', true)).toBe(false);
    expect(context.service.approve(id, 'case', 'approval', true)).toBe(true);
    expect(context.service.approve(id, 'case', 'approval', true)).toBe(false);
    await context.service.wait(id); expect(context.service.list()[0]?.status).toBe('completed');
  });
  it('无效输入、空数据集和数据集身份不匹配都失败且不运行 Agent', async () => {
    const { service, client, execute } = await setup();
    await expect(service.start({ datasetName: '' })).rejects.toThrow();
    client.dataset.mockResolvedValueOnce({ id: 'dataset', items: [] });
    let run = await service.start({ datasetName: '空' }); await service.wait(run.id); expect(service.list()[0]?.error).toContain('没有启用');
    run = await service.start({ datasetName: '错误', datasetId: 'other' }); await service.wait(run.id); expect(service.list()[0]?.error).toContain('不匹配');
    client.dataset.mockResolvedValueOnce({ id: 'dataset', items: [{ id: 'bad', input: null as unknown as { turns: string[] }, expectedOutput: '' }] });
    run = await service.start({ datasetName: '错误输入' }); await service.wait(run.id); expect(service.list()[0]?.items[0]?.status).toBe('failed'); expect(execute).not.toHaveBeenCalled();
  });
  it('重启将未完成记录标记中断，不自动执行真实任务', async () => {
    const { service, options, execute } = await setup();
    const { id } = await service.start({ datasetName: '测试' }); await service.wait(id);
    const run = service.list()[0]!; run.status = 'running'; run.items[0]!.status = 'waiting_approval';
    await writeFile(join(options.directory, `${id}.json`), JSON.stringify(run));
    const restored = new EvaluationService(options); await restored.initialize();
    expect(restored.list()[0]?.status).toBe('interrupted'); expect(execute).toHaveBeenCalledTimes(2);
  });
  it('审批拒绝即使用模型回复也不能视为完整执行', async () => {
    const { service } = await setup(async (_, options) => {
      await options.observer('approval_requested', { approvalId: 'a', command: 'git push', reason: '外部写入' });
      await options.observer('approval_resolved', { approvalId: 'a', approved: false });
      throw new Error('审批拒绝');
    });
    const { id } = await service.start({ datasetName: '审批' }); await service.wait(id);
    expect(service.list()[0]?.items[0]?.approvalDenied).toBe(true); expect(service.list()[0]?.status).toBe('failed');
  });
  it('空白评估库在真实 Embedding 配置下自动建立空索引', async () => {
    const { sourceHome } = await setup();
    await writeFile(join(sourceHome, 'config.json'), JSON.stringify({ retrieval: { mode: 'hybrid', embedding: { baseUrl: 'https://embedding.invalid/v1', model: 'embedding-test' } } }));
    await writeFile(join(sourceHome, '.env'), 'EVERYTHING_EMBEDDING_API_KEY=embedding-test-secret');
    const runtime = await createEvaluationRuntime(sourceHome, new AbortController().signal);
    expect((await runtime.getSettings()).embeddingIndex.ready).toBe(true);
    await runtime.close();
    await expect(createEvaluationRuntime(sourceHome, AbortSignal.abort(new Error('取消初始化')))).rejects.toThrow('取消初始化');
  });
  it('支持单轮输入和凭证递归脱敏', () => {
    expect(evaluationTurns('你好')).toEqual(['你好']); expect(evaluationTurns({ prompt: '你好' })).toEqual(['你好']);
    expect(() => evaluationTurns({ turns: [] })).toThrow();
    expect(redactEvaluation({ apiKey: 'value', nested: ['Bearer abc123', 'secret-value'] }, ['secret-value'])).toEqual({ apiKey: '[凭证已移除]', nested: ['Bearer [凭证已移除]', '[凭证已移除]'] });
  });
  it('配置快照固定进程模型参数，嵌套 Skill 链接被拒绝', async () => {
    const { sourceHome, options } = await setup();
    vi.stubEnv('EVERYTHING_AGENT_MODEL', 'snapshot-model');
    const target = join(options.directory, 'frozen');
    await prepareEvaluationHome(sourceHome, target, false);
    vi.stubEnv('EVERYTHING_AGENT_MODEL', 'changed-model');
    expect(JSON.parse(await readFile(join(target, 'config.json'), 'utf8')).models.agent.model).toBe('snapshot-model');
    await mkdir(join(sourceHome, 'skills'));
    await symlink(join(sourceHome, '.env'), join(sourceHome, 'skills', 'secret-link'));
    await expect(prepareEvaluationHome(sourceHome, join(options.directory, 'blocked'), false)).rejects.toThrow('符号链接');
  });
  it('终端默认关闭，只有显式标记的用例保留日常终端开关', async () => {
    const { service, sourceHome, options, client } = await setup();
    await writeFile(join(sourceHome, 'config.json'), JSON.stringify({ tools: { runTerminalEnabled: true } }));
    const { id } = await service.start({ datasetName: '工具边界' }); await service.wait(id);
    let record = service.list().find(run => run.id === id)!;
    let config = JSON.parse(await readFile(join(options.directory, id, record.items[0]!.traceId, 'config.json'), 'utf8'));
    expect(config.tools.runTerminalEnabled).toBe(false);
    client.dataset.mockResolvedValueOnce({ id: 'dataset', items: [{ id: 'case', input: { turns: ['运行命令'] }, expectedOutput: '结果', terminalEnabled: true } as { id: string; input: { turns: string[] }; expectedOutput: string }] });
    const next = await service.start({ datasetName: '工具边界' }); await service.wait(next.id);
    record = service.list().find(run => run.id === next.id)!;
    config = JSON.parse(await readFile(join(options.directory, next.id, record.items[0]!.traceId, 'config.json'), 'utf8'));
    expect(config.tools.runTerminalEnabled).toBe(true);
  });
  it('SQLite 快照保留事实但不会写回日常数据库', async () => {
    const { sourceHome, options } = await setup();
    const original = createAgentRuntime({ home: sourceHome, defaultSystemPromptPath: join(sourceHome, 'EVERYTHING.md') });
    original.memory.createSemantic('城市', '上海', 'ui');
    const target = join(options.directory, 'snapshot'); await prepareEvaluationHome(sourceHome, target, true);
    const copy = createAgentRuntime({ home: target, defaultSystemPromptPath: join(target, 'EVERYTHING.md') });
    expect(copy.memory.listSemantic()[0]?.content).toBe('上海'); copy.memory.createSemantic('评估', '新事实', 'ui');
    expect(original.memory.listSemantic()).toHaveLength(1); await copy.close(); await original.close();
  });
});

async function webhook(body: unknown, token = 'secret', url = '/trigger') {
  const request = Object.assign(Readable.from([JSON.stringify(body)]), { method: 'POST', url, headers: { authorization: `Bearer ${token}` } }) as unknown as IncomingMessage;
  let status = 0; let result = '';
  const response = { writeHead(code: number) { status = code; }, end(value: string) { result = value; } } as unknown as ServerResponse;
  const start = vi.fn(async () => ({ id: 'run' }));
  await evaluationWebhook({ token: 'secret', projectId: 'project', start })(request, response);
  return { status, result: JSON.parse(result), start };
}
describe('平台回调边界', () => {
  it('仅接收正确项目和专用令牌，立即返回运行 ID', async () => {
    const result = await webhook({ projectId: 'project', datasetId: 'dataset', datasetName: '测试', payload: JSON.stringify({ memorySnapshot: true }) });
    expect(result.status).toBe(202); expect(result.start).toHaveBeenCalledWith({ datasetId: 'dataset', datasetName: '测试', memorySnapshot: true });
    expect((await webhook({}, 'wrong')).status).toBe(401); expect((await webhook({}, 'secret', '/api/local-agent')).status).toBe(404);
  });
  it('拒绝跨项目、路径覆盖和非布尔审批策略', async () => {
    const base = { projectId: 'project', datasetId: 'dataset', datasetName: '测试' };
    for (const body of [{ ...base, projectId: 'other' }, { ...base, payload: { home: '/private' } }, { ...base, payload: { memorySnapshot: 'yes' } }, { ...base, payload: [] }]) expect((await webhook(body)).status).toBe(400);
  });
});

describe('Langfuse v4 协议', () => {
  it('OTLP 根节点关联实验与用例，部分拒收必须失败', async () => {
    const { service } = await setup(); const { id } = await service.start({ datasetName: '测试' }); await service.wait(id);
    const run = service.list()[0]!; const item = run.items[0]!;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ partialSuccess: { rejectedSpans: '1' } }), { status: 200 })); vi.stubGlobal('fetch', fetchMock);
    const client = new LangfuseEvaluationClient({ baseUrl: 'http://localhost:3300', publicKey: 'pk', secretKey: 'sk', projectId: 'p' });
    await expect(client.publish(run, item)).rejects.toThrow('未完整接收');
    const init = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    const payload = JSON.parse(init[1].body as string); const root = payload.resourceSpans[0].scopeSpans[0].spans[0];
    expect(root.traceId).toBe(item.traceId); expect(root.attributes).toContainEqual({ key: 'langfuse.experiment.item.root_observation_id', value: { stringValue: item.observationId } });
  });
  it('模型和工具子节点保持根关联、错误状态和真实用量，重传 ID 稳定', async () => {
    const { service } = await setup(async (_, options) => {
      await options.observer('model_request', { modelCallId: 'model', request: { model: 'model-a', system: '私有系统提示' } });
      await options.observer('model_response', { modelCallId: 'model', tokenUsage: { inputTokens: 10, outputTokens: 20 } });
      await options.observer('tool_started', { toolCallId: 'tool', tool: 'get_current_time' });
      await options.observer('tool_failed', { toolCallId: 'tool', tool: 'get_current_time', isError: true });
      throw new Error('工具失败');
    });
    const { id } = await service.start({ datasetName: '失败轨迹' }); await service.wait(id);
    const record = service.list()[0]!;
    const mocked = vi.fn(async (_url: unknown, _init: RequestInit) => Response.json({})); vi.stubGlobal('fetch', mocked);
    const client = new LangfuseEvaluationClient({ baseUrl: 'http://localhost:3300', publicKey: 'pk', secretKey: 'sk', projectId: 'p' });
    await client.publish(record, record.items[0]!); await client.publish(record, record.items[0]!);
    const spans = JSON.parse(mocked.mock.calls[0]![1].body as string).resourceSpans[0].scopeSpans[0].spans;
    const retry = JSON.parse(mocked.mock.calls[1]![1].body as string).resourceSpans[0].scopeSpans[0].spans;
    expect(spans).toHaveLength(3); expect(spans[0].status.code).toBe(2); expect(spans[2].status.code).toBe(2);
    expect(spans[1].parentSpanId).toBe(spans[0].spanId); expect(spans[1].spanId).toBe(retry[1].spanId);
    expect(spans[1].attributes).toContainEqual({ key: 'langfuse.observation.usage_details', value: { stringValue: '{"input":10,"output":20}' } });
    expect(JSON.stringify(spans)).not.toContain('私有系统提示');
  });
  it('执行痕迹只带统计字段，命令与工具正文既不入记录也不回传平台', async () => {
    const { service } = await setup(async (_, options) => {
      await options.observer('tool_completed', { toolCallId: 't1', tool: 'run_terminal', isError: false, ms: 12, outputLength: 0, summary: '工具执行完成',
        result: { command: 'cat .everything/.env', workdir: '/tmp/ws', exitCode: 0, stdoutLength: 431, stderrLength: 0, timeout_ms: 1_000 } });
      await options.observer('tool_completed', { toolCallId: 't2', tool: 'search_web', isError: false, ms: 30, outputLength: 120, summary: '工具执行完成',
        result: { query: '私密查询', results: [{ title: '私密标题' }] } });
      await options.observer('tool_failed', { toolCallId: 't3', tool: 'run_terminal', isError: true, ms: 5_000, outputLength: 8_192, summary: '工具执行失败',
        result: { command: 'sleep 999', stdoutLength: 4_096, stderrLength: 0, timedOut: true, truncated: true } });
      throw new Error('本轮结束');
    });
    const { id } = await service.start({ datasetName: '痕迹' }); await service.wait(id);
    const record = service.list()[0]!;
    expect(record.items[0]?.events[0]?.data).toMatchObject({ tool: 'run_terminal', outputLength: 0, result: { exitCode: 0, stdoutLength: 431, stderrLength: 0 } });
    // search_web 没有专用脱敏结果，按键名投影后不保留任何结果字段。
    expect(record.items[0]?.events[1]?.data.result).toBeUndefined();
    expect(JSON.stringify(record)).not.toContain('.everything/.env');
    expect(JSON.stringify(record)).not.toContain('私密查询');
    const mocked = vi.fn(async (_url: unknown, _init: RequestInit) => Response.json({})); vi.stubGlobal('fetch', mocked);
    const client = new LangfuseEvaluationClient({ baseUrl: 'http://localhost:3300', publicKey: 'pk', secretKey: 'sk', projectId: 'p' });
    await client.publish(record, record.items[0]!);
    const body = mocked.mock.calls[0]![1].body as string;
    const root = JSON.parse(body).resourceSpans[0].scopeSpans[0].spans[0];
    const trace = root.attributes.find((item: { key: string }) => item.key === 'langfuse.observation.metadata.execution_trace').value.stringValue as string;
    expect(trace).toContain('run_terminal | exit=0 | stdout=431B | stderr=0B | 返回=0字符 | 成功');
    expect(trace).toContain('search_web | 返回=120字符 | 成功');
    expect(trace).toContain('run_terminal | stdout=4096B | stderr=0B | 返回=8192字符 | 超时 | 输出被截断 | 失败');
    expect(body).not.toContain('.everything/.env');
    expect(body).not.toContain('私密查询');
  });
  it('SDK 读取固定版本并排除归档用例，保留显式终端标记', async () => {
    const fetched = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/dataset-items')) return Response.json({ data: [
        { id: 'active', status: 'ACTIVE', input: '测试', expectedOutput: '答案', metadata: { terminal: true } },
        { id: 'archived', status: 'ARCHIVED', input: '旧测试' },
      ], meta: { totalPages: 1 } });
      return Response.json({ id: 'dataset', name: '测试' });
    }); vi.stubGlobal('fetch', fetched);
    const client = new LangfuseEvaluationClient({ baseUrl: 'http://localhost:3300', publicKey: 'pk', secretKey: 'sk', projectId: 'p' });
    const version = '2026-09-20T00:00:00Z'; const result = await client.dataset('测试', version);
    expect(result.items).toEqual([{ id: 'active', input: '测试', expectedOutput: '答案', terminalEnabled: true }]);
    expect(fetched.mock.calls.some(([url]) => decodeURIComponent(String(url)).includes(version))).toBe(true);
  });
  it('平台数据集和评分完整分页，HTTP 失败不返回空结果', async () => {
    const client = new LangfuseEvaluationClient({ baseUrl: 'http://localhost:3300', publicKey: 'pk', secretKey: 'sk', projectId: 'p' });
    const mocked = vi.fn().mockResolvedValueOnce(Response.json({ data: [{ id: '1', name: '一' }], meta: { totalPages: 2 } })).mockResolvedValueOnce(Response.json({ data: [{ id: '2', name: '二' }], meta: { totalPages: 2 } })); vi.stubGlobal('fetch', mocked);
    expect(await client.datasets()).toHaveLength(2);
    mocked.mockResolvedValueOnce(Response.json({ data: [{ id: 's1', name: '质量', value: true }], meta: { cursor: 'next' } })).mockResolvedValueOnce(Response.json({ data: [], meta: {} }));
    expect(await client.scores({ traceId: 't', observationId: 'o' } as EvaluationItem)).toHaveLength(1);
    mocked.mockResolvedValueOnce(new Response('', { status: 401 })); await expect(client.datasets()).rejects.toThrow('401');
  });
});
