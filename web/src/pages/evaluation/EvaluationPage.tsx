import { useEffect, useState } from 'react';
import { RefreshCw, ExternalLink, Copy, Play, Square } from 'lucide-react';
import { PageHeading } from '../../components/PageHeading';
import { Button } from '../../components/ui/button';
import { evaluationRequest } from '../../evaluation-api';
import type { EvaluationDashboard } from '../../evaluation-api';

const labels: Record<string, string> = { queued: '排队中', running: '执行中', waiting_approval: '等待审批', completed: '执行完成', failed: '失败', cancelled: '已取消', interrupted: '进程中断', pending: '待同步', synced: '已同步' };
/** 真实评估控制台；运行留在服务端，离开页面不会取消实验。 */
export function EvaluationPage() {
  const [data, setData] = useState<EvaluationDashboard>();
  const [datasets, setDatasets] = useState<{ id: string; name: string }[]>([]);
  const [dataset, setDataset] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const result = await evaluationRequest<EvaluationDashboard>(); if (!disposed) { setData(result); setError(''); } }
      catch (cause) { if (!disposed) setError(String(cause)); }
      finally { if (!disposed) timer = setTimeout(() => { void poll(); }, 2000); }
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, []);
  const act = async (body: Record<string, unknown>) => {
    setBusy(true); setMessage('');
    try { await evaluationRequest('', body); setData(await evaluationRequest<EvaluationDashboard>()); }
    catch (cause) { setMessage(String(cause)); }
    finally { setBusy(false); }
  };
  const connect = async () => {
    setBusy(true); setMessage('');
    try { const result = await evaluationRequest<{ datasets: typeof datasets }>('/datasets'); setDatasets(result.datasets); setDataset(result.datasets[0]?.name ?? ''); setConnected(true); }
    catch (cause) { setMessage(String(cause)); setConnected(false); }
    finally { setBusy(false); }
  };
  const copyHeaders = async () => {
    try { const headers = await evaluationRequest<{ Authorization: string }>('/webhook-headers', {}); await navigator.clipboard.writeText(headers.Authorization); setMessage('authorization 值已复制。在 Langfuse 添加同名请求头，粘贴该值并标记 Secret。'); }
    catch (cause) { setMessage(String(cause)); }
  };
  const run = data?.runs.find(item => item.id === selected) ?? data?.runs[0];
  const pageCount = Math.max(1, Math.ceil((data?.runs.length ?? 0) / 10));
  const currentPage = Math.min(page, pageCount);
  const visibleRuns = data?.runs.slice((currentPage - 1) * 10, currentPage * 10) ?? [];
  const active = data?.runs.some(item => ['queued', 'running'].includes(item.status));
  const projectUrl = data ? `${data.baseUrl}/project/${encodeURIComponent(data.projectId)}` : '';
  return <div className="p-4 sm:p-6 space-y-6 max-w-[1440px] mx-auto w-full overflow-auto">
    <PageHeading eyebrow="真实环境评估" title="Evaluation" description="用真实 Everything Agent 执行 Langfuse 数据集，独立保存评估会话和记忆。" />
    {(error || data?.error || message) && <div role="status" className="rounded-lg border p-3 text-sm">{error || data?.error || message}</div>}
    <section className="rounded-xl border p-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-4"><div><h2 className="font-semibold">Langfuse 连接</h2><p className="text-sm text-muted-foreground">{connected ? '平台连接正常' : data?.configured ? '本地入口已就绪，点击连接平台检查' : '等待配置'} · {data?.baseUrl}</p></div>
        <div className="flex gap-2"><Button variant="outline" disabled={busy || !data?.configured} onClick={() => void connect()}><RefreshCw size={14} />连接平台</Button>{data?.configured && <a className="text-sm underline flex items-center gap-1" href={projectUrl} target="_blank" rel="noreferrer">打开 Langfuse <ExternalLink size={14} /></a>}</div></div>
      <section className="border-t pt-4 text-sm"><h2 className="font-semibold">从 Langfuse 管理平台发起实验</h2><div className="mt-3 space-y-3 text-muted-foreground">
        <p>打开数据集 → Start Experiment → Custom Experiment → ⚡，填入回调地址：</p><code className="block break-all text-foreground">{data?.webhookUrl}</code>
        <p>Advanced Options → Custom headers：名称填 authorization，值粘贴下方复制的内容，并标记 Secret。Default payload 填写 <code>{'{"name":"Everything Agent"}'}</code>，保存后点击 Run。</p>
        <Button variant="outline" size="sm" onClick={() => void copyHeaders()} disabled={!data?.configured}><Copy size={14} />复制 authorization 值</Button>
        <p>本地 Web 服务需保持运行。平台评估器需在 Langfuse 中配置，目标为本实验的根 Agent observation。未收到评分时显示等待评分，不推断通过。</p>
      </div></section>
    </section>
    <section className="rounded-xl border border-primary/30 bg-muted/20 p-5 space-y-4">
      <div><h2 className="font-semibold">运行前配置</h2><p className="text-sm text-muted-foreground mt-1">在 Langfuse 对应位置填写以下配置。示例均为默认值。</p></div>
      <div className="grid md:grid-cols-2 gap-4">
        <div className="rounded-lg border bg-background p-4 space-y-3">
          <h3 className="text-sm font-semibold">数据集 → Metadata</h3>
          <code className="block rounded-md bg-muted p-3 text-xs break-all">{'{"terminal":false,"memorySnapshot":false}'}</code>
          <p className="text-sm"><strong>terminal</strong>：默认 false，全部用例关闭终端。设为 true 时，还需要日常工具配置启用终端且沙箱可用。</p>
          <p className="text-sm"><strong>memorySnapshot</strong>：默认 false，使用空白评估记忆；true 使用日常记忆快照。</p>
          <p className="text-xs text-muted-foreground">两项配置统一作用于该数据集的全部用例，本地与平台启动均读取；未填写等同于 false。</p>
        </div>
        <div className="rounded-lg border bg-background p-4 space-y-3">
          <h3 className="text-sm font-semibold">Custom Experiment → Default payload</h3>
          <code className="block rounded-md bg-muted p-3 text-xs break-all">{'{"name":"Everything Agent"}'}</code>
          <p className="text-sm"><strong>name</strong>：实验名称前缀，默认 Everything Agent；最终名称自动附加运行 ID 短码。</p>
          <p className="text-xs text-muted-foreground">此处仅配置名称，不填写 terminal 或 memorySnapshot。本地启动使用默认名称前缀。</p>
        </div>
      </div>
    </section>
    <section className="rounded-xl border p-5 space-y-3"><h2 className="font-semibold">本地启动实验</h2><div className="flex flex-wrap items-center gap-3">
      <select aria-label="评估数据集" className="rounded-md border bg-background p-2 w-full sm:w-auto sm:min-w-64 max-w-full" value={dataset} onChange={event => setDataset(event.target.value)}><option value="">选择 Langfuse 数据集</option>{datasets.map(item => <option key={item.id} value={item.name}>{item.name}</option>)}</select>
      <Button disabled={busy || active || !dataset} onClick={() => void act({ action: 'start', datasetName: dataset })}><Play size={14} />运行真实 Agent</Button>
    </div><p className="text-xs text-muted-foreground">每条用例独立会话和工作目录，并行数由服务端配置；需要审批时暂停该用例。输入支持字符串、{'{ prompt }'} 或 {'{ turns: ["第一轮", "第二轮"] }'}。</p></section>
    {Boolean(data?.approvals.length) && <section className="rounded-xl border border-amber-500 p-5 space-y-3"><h2 className="font-semibold">待确认操作</h2>{data!.approvals.map(approval => <div key={approval.id} className="rounded-lg border p-4 space-y-2"><p className="text-xs text-muted-foreground">实验 {approval.runId.slice(0, 8)} · 用例 {approval.itemId}</p><p>{approval.reason}</p><pre className="whitespace-pre-wrap break-all text-sm">{approval.command}</pre>{approval.detail && <p className="text-sm">{approval.detail}</p>}<div className="flex gap-2">{[true, false].map(approved => <Button key={String(approved)} variant={approved ? 'default' : 'outline'} disabled={busy} onClick={() => void act({ action: 'approve', runId: approval.runId, itemId: approval.itemId, approvalId: approval.id, approved })}>{approved ? '批准本次操作' : '拒绝'}</Button>)}</div></div>)}</section>}
    <div className="grid lg:grid-cols-[280px_minmax(0,1fr)] items-start gap-5"><section aria-label="实验记录" className="rounded-xl border p-4 space-y-3"><div className="flex items-center justify-between"><h2 className="font-semibold">实验记录</h2><span className="text-xs text-muted-foreground">共 {data?.runs.length ?? 0} 条</span></div>{!data?.runs.length && <p className="text-sm text-muted-foreground">尚无实验。从平台或本页启动后，记录会显示在这里。</p>}{visibleRuns.map(item => <button aria-pressed={run?.id === item.id} key={item.id} className={`w-full rounded-lg border p-3 text-left space-y-1 ${run?.id === item.id ? 'border-primary bg-muted' : 'hover:bg-muted/50'}`} onClick={() => setSelected(item.id)}><strong className="block text-sm break-all">{item.name}</strong><span className="block text-xs">{item.datasetName} · {labels[item.status]}</span><span className="block text-xs text-muted-foreground">{new Date(item.createdAt).toLocaleString()}</span></button>)}
      <nav aria-label="实验记录分页" className="flex items-center justify-between gap-2 border-t pt-3">
        <Button variant="outline" size="sm" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>上一页</Button>
        <span className="text-xs text-muted-foreground">第 {currentPage} / {pageCount} 页</span>
        <Button variant="outline" size="sm" disabled={currentPage === pageCount} onClick={() => setPage(currentPage + 1)}>下一页</Button>
      </nav>
    </section>
    <section aria-label="实验详情" className="min-w-0 rounded-xl border p-5 space-y-4">{!run ? <p className="text-sm text-muted-foreground">选择实验查看用例详情。</p> : <>
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold">{run.name}</h2><p className="text-sm text-muted-foreground">{labels[run.status]} · {run.items.filter(item => ['completed', 'failed', 'cancelled'].includes(item.status)).length} / {run.items.length} 条 · {run.memorySnapshot ? '日常记忆快照' : '空白评估记忆'}</p></div><div className="flex gap-2">{['queued', 'running'].includes(run.status) ? <Button variant="outline" disabled={busy} onClick={() => void act({ action: 'cancel', runId: run.id })}><Square size={14} />取消运行</Button> : <Button variant="outline" disabled={busy} onClick={() => void act({ action: 'refresh', runId: run.id })}><RefreshCw size={14} />刷新评分／重试同步</Button>}</div></div>
      <div className="rounded-lg bg-muted/50 p-3 space-y-2 text-sm">
        <h3 className="font-medium">本次实验配置</h3>
        <p className="break-all">实验名称：{run.name}</p>
        <div className="flex flex-wrap gap-x-6 gap-y-2"><span>terminal：{String(run.terminalEnabled)}</span><span>memorySnapshot：{String(run.memorySnapshot)}</span></div>
        <p className="text-xs text-muted-foreground">开关为本次运行读取的数据集配置；terminal 为 true 表示数据集允许终端，实际可用性取决于日常配置与沙箱。</p>
      </div>
      <p className="text-xs text-muted-foreground">数据集版本：{run.datasetVersion} · 同步成功 {run.items.filter(item => item.sync === 'synced').length} 条。执行完成不代表质量通过。</p>
      {(run.error || run.scoreError) && <p role="alert" className="text-sm text-destructive">{run.error || run.scoreError}</p>}
      {run.items.map(item => <details key={item.id} className="rounded-lg border p-4"><summary className="cursor-pointer text-sm"><strong>{item.id}</strong> · {labels[item.status]} · {labels[item.sync]} · {item.ms === undefined ? '—' : `${(item.ms / 1000).toFixed(1)}s`}</summary><div className="mt-4 space-y-3 text-sm">
        <p>{item.model ?? '模型尚未返回'} · 工具 {item.toolCalls} 次 · 输入 {item.inputTokens ?? '—'} / 输出 {item.outputTokens ?? '—'} tokens</p>
        {item.error && <p className="text-destructive">{item.error}</p>}{item.syncError && <p className="text-destructive">回传失败：{item.syncError}</p>}
        <div className="grid xl:grid-cols-3 gap-3">{[['输入', item.input], ['预期结果', item.expectedOutput ?? '未设置'], ['实际输出', item.output]].map(([title, value]) => <div key={String(title)} className="min-w-0"><h3 className="font-medium mb-2">{String(title)}</h3><pre className="bg-muted rounded p-3 whitespace-pre-wrap break-all max-h-72 overflow-auto text-xs">{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre></div>)}</div>
        <div><h3 className="font-medium">平台评分</h3>{!item.scores.length ? <p className="text-muted-foreground">{item.sync === 'synced' ? '等待平台评分／尚未配置评估器' : '等待执行结果同步'}</p> : item.scores.map(score => <p key={score.id}>{score.name}：{String(score.value)} {score.comment && `· ${score.comment}`}</p>)}</div>
        <a href={`${projectUrl}/traces/${item.traceId}`} target="_blank" rel="noreferrer" className="underline">打开 Langfuse Trace</a>
        <details><summary className="cursor-pointer">执行事件（{item.events.length}）</summary><div className="max-h-72 overflow-auto mt-2 space-y-1">{item.events.map(event => <div key={event.sequence} className="font-mono text-xs break-all">{event.sequence}. {new Date(event.timestamp).toLocaleTimeString()} {event.kind} {JSON.stringify(event.data)}</div>)}</div></details>
      </div></details>)}
    </>}</section></div>
  </div>;
}
