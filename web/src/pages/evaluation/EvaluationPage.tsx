import { useEffect, useState } from 'react';
import { RefreshCw, ExternalLink, Copy, Play, Square } from 'lucide-react';
import { PageHeading } from '../../components/PageHeading';
import { SaveMessage } from '../../components/SaveMessage';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { evaluationRequest } from '../../evaluation-api';
import { withMinimumDuration } from '../../lib/minimum-duration';
import type { EvaluationDashboard } from '../../evaluation-api';

const labels: Record<string, string> = { queued: '排队中', running: '执行中', waiting_approval: '等待审批', completed: '执行完成', failed: '失败', cancelled: '已取消', interrupted: '进程中断', pending: '待同步', synced: '已同步' };
/** Radix Select 不允许用空字符串作为选项值，未选择数据集时用该占位值表示“尚未选择”。 */
const noDataset = 'none';
/** 服务端对 Experiment 名称前缀的限制是 1–120 字符，这里同步限制输入长度。 */
const maxNameLength = 120;
/** 真实评估控制台；运行留在服务端，离开页面不会取消 Experiment。 */
export function EvaluationPage() {
  const [data, setData] = useState<EvaluationDashboard>();
  const [datasets, setDatasets] = useState<{ id: string; name: string }[]>([]);
  const [dataset, setDataset] = useState('');
  const [name, setName] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  /** 操作失败提示，留在页面内常驻展示，与轮询错误合并显示。 */
  const [actError, setActError] = useState('');
  /** 操作成功反馈，交给 SaveMessage 浮层展示并在 2.5 秒后消失，不在页面里占位。 */
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  /** 连接平台动画：与 busy 分开，避免其他操作顺带在连接按钮上转圈。 */
  const [connecting, setConnecting] = useState(false);
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
    setBusy(true); setMessage(''); setActError('');
    try { await evaluationRequest('', body); setData(await evaluationRequest<EvaluationDashboard>()); }
    catch (cause) { setActError(String(cause)); }
    finally { setBusy(false); }
  };
  /** 连接平台：最短反馈时长保证旋转动画可见，成功后给出已发现的数据集数量。 */
  const connect = async () => {
    if (busy || connecting) return;
    setBusy(true); setConnecting(true); setActError('');
    try {
      const result = await withMinimumDuration(() => evaluationRequest<{ datasets: typeof datasets }>('/datasets'));
      setDatasets(result.datasets); setDataset(result.datasets[0]?.name ?? ''); setConnected(true);
      setMessage(`平台连接正常，已发现 ${result.datasets.length} 个数据集。`);
    }
    catch (cause) { setActError(String(cause)); setConnected(false); }
    finally { setBusy(false); setConnecting(false); }
  };
  const copyHeaders = async () => {
    setActError('');
    try { const headers = await evaluationRequest<{ Authorization: string }>('/webhook-headers', {}); await navigator.clipboard.writeText(headers.Authorization); setMessage('authorization 值已复制。在 Langfuse 添加同名请求头，粘贴该值并标记 Secret。'); }
    catch (cause) { setMessage(''); setActError(String(cause)); }
  };
  const run = data?.runs.find(item => item.id === selected) ?? data?.runs[0];
  const pageCount = Math.max(1, Math.ceil((data?.runs.length ?? 0) / 10));
  const currentPage = Math.min(page, pageCount);
  const visibleRuns = data?.runs.slice((currentPage - 1) * 10, currentPage * 10) ?? [];
  const active = data?.runs.some(item => ['queued', 'running'].includes(item.status));
  const projectUrl = data ? `${data.baseUrl}/project/${encodeURIComponent(data.projectId)}` : '';
  return <div className="p-4 sm:p-6 space-y-6 max-w-[1440px] mx-auto w-full overflow-auto">
    <PageHeading eyebrow="真实环境评估" title="Evaluation" description="用真实 Everything Agent 执行 Langfuse 数据集，独立保存评估会话和记忆。" />
    <SaveMessage message={message} setMessage={setMessage} />
    {Boolean(error || actError || data?.error) && <div role="alert" className="rounded-lg border p-3 text-sm">{error || actError || data?.error}</div>}
    <section className="rounded-xl border p-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-4"><div><h2 className="font-semibold">Langfuse 连接</h2><p className="text-sm text-muted-foreground">{connected ? '平台连接正常' : data?.configured ? '本地入口已就绪，点击连接平台检查' : '等待配置'} · {data?.baseUrl}</p></div>
        <div className="flex gap-2"><Button variant="outline" disabled={busy} loading={connecting} onClick={() => void connect()}><RefreshCw size={14} />连接平台</Button>{data?.configured && <a className="text-sm underline flex items-center gap-1" href={projectUrl} target="_blank" rel="noreferrer">打开 Langfuse <ExternalLink size={14} /></a>}</div></div>
      <section className="border-t pt-4 text-sm"><h2 className="font-semibold">从 Langfuse 管理平台发起 Experiment</h2><div className="mt-3 space-y-3 text-muted-foreground">
        <p>打开数据集 → 进入 <strong>Experiments</strong> 标签页 → 右上角 <strong>Run experiment</strong> → 在 Run Experiment 弹窗里选 <strong>via Webhook</strong> 卡片。</p>
        <p>首次点击卡片上的 Configure，进入 <strong>Set up remote experiment trigger in UI</strong>：<strong>URL</strong> 填回调地址 <code className="inline-block rounded-md bg-muted p-3 text-xs break-all">{data?.webhookUrl}</code></p>
        <p><strong>Default config</strong> 填 <code className="inline-block rounded-md bg-muted p-3 text-xs break-all">{'{"name":"Everything Agent"}'}</code></p>
        <p><strong>Sign requests</strong> 保持关闭，我们的网关只校验 authorization，不校验 x-langfuse-signature。</p>
        <p><strong>Enabled</strong> 打开，否则实验无法触发。</p>
        <p>展开 <strong>Advanced Options</strong> → <strong>Custom headers</strong>：名称填 <code>authorization</code>，值粘贴下方复制的内容，最后保存。</p>
        <div><Button variant="outline" size="sm" onClick={() => void copyHeaders()} disabled={!data?.configured}><Copy size={14} />复制 authorization 值</Button></div>
        <p>本地 Web 服务需保持运行。平台评估器需在 Langfuse 中配置，目标为本次 Experiment 的根 Agent observation。未收到评分时显示等待评分，不推断通过。</p>
      </div></section>
    </section>
    <section className="rounded-xl border border-primary/30 bg-muted/20 p-5 space-y-4">
      <div><h2 className="font-semibold">运行前配置</h2><p className="text-sm text-muted-foreground mt-1">在 Langfuse 以下位置填写配置，示例均为默认值。</p></div>
      <div className="grid md:grid-cols-2 gap-4">
        <div className="rounded-lg border bg-background p-4 space-y-3">
          <h3 className="text-sm font-semibold">数据集 Metadata</h3>
          <code className="block rounded-md bg-muted p-3 text-xs break-all">{'{"terminal":false,"memorySnapshot":false}'}</code>
          <p className="text-sm"><strong>terminal</strong>：默认 false，全部用例关闭终端。设为 true 时，还需要日常工具配置启用终端且沙箱可用。</p>
          <p className="text-sm"><strong>memorySnapshot</strong>：默认 false，使用空白评估记忆；true 使用日常记忆快照。</p>
          <p className="text-xs text-muted-foreground">两项配置统一作用于该数据集的全部用例，本地与平台启动均读取；未填写等同于 false。</p>
        </div>
        <div className="rounded-lg border bg-background p-4 space-y-3">
          <h3 className="text-sm font-semibold">Remote experiment trigger → Default config</h3>
          <code className="block rounded-md bg-muted p-3 text-xs break-all">{'{"name":"Everything Agent"}'}</code>
          <p className="text-sm"><strong>name</strong>：Experiment 名称前缀，默认 Everything Agent；最终名称自动附加运行 ID 短码。留空表示不发送 config。</p>
          <p className="text-xs text-muted-foreground">此处仅配置名称，不填写 terminal 或 memorySnapshot。每次点击 Run 时该 config 可在 Run remote dataset run 弹窗里临时修改；本地启动在下方「数据集与实验」里填写同一个名称前缀，留空时同样使用默认值。</p>
        </div>
      </div>
    </section>
    <section className="rounded-xl border p-5 space-y-3"><h2 className="font-semibold">数据集与实验</h2><div className="flex flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-end">
      <div className="flex min-w-0 w-full flex-col gap-1.5 sm:max-w-96"><span id="evaluation-dataset-label" className="text-xs font-medium">Langfuse 数据集</span>
        <Select value={dataset || noDataset} onValueChange={value => setDataset(value === noDataset ? '' : value)}>
          <SelectTrigger aria-labelledby="evaluation-dataset-label" className="w-full min-w-0"><SelectValue placeholder="选择数据集" /></SelectTrigger>
          <SelectContent><SelectItem value={noDataset}><span className="text-muted-foreground">选择数据集</span></SelectItem>{datasets.map(item => <SelectItem key={item.id} value={item.name}>{item.name}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <div className="flex min-w-0 w-full flex-col gap-1.5 sm:max-w-96"><span id="evaluation-name-label" className="text-xs font-medium">Experiment 名称前缀（可选）</span>
        <Input aria-labelledby="evaluation-name-label" className="w-full min-w-0" value={name} maxLength={maxNameLength} spellCheck={false} placeholder="留空时使用 Everything Agent" onChange={event => setName(event.target.value)} />
      </div>
      <Button disabled={busy || active || !dataset} onClick={() => void act({ action: 'start', datasetName: dataset, ...(name.trim() ? { name: name.trim() } : {}) })}><Play size={14} />Run Experiment</Button>
    </div>
    <p className="text-xs text-muted-foreground">
      1. 与平台入口共用同一执行过程，但不创建 Langfuse Experiment 记录，只把执行轨迹回传到对应数据集条目；需要审批时暂停该用例。
      <br />
      2. 输入支持字符串、{'{ prompt }'} 或 {'{ turns: ["第一轮", "第二轮"] }'}。
    </p>
    </section>
    {Boolean(data?.approvals.length) && <section className="rounded-xl border border-amber-500 p-5 space-y-3"><h2 className="font-semibold">待确认操作</h2>{data!.approvals.map(approval => <div key={approval.id} className="rounded-lg border p-4 space-y-2"><p className="text-xs text-muted-foreground">Experiment {approval.runId.slice(0, 8)} · 用例 {approval.itemId}</p><p>{approval.reason}</p><pre className="whitespace-pre-wrap break-all text-sm">{approval.command}</pre>{approval.detail && <p className="text-sm">{approval.detail}</p>}<div className="flex gap-2">{[true, false].map(approved => <Button key={String(approved)} variant={approved ? 'default' : 'outline'} disabled={busy} onClick={() => void act({ action: 'approve', runId: approval.runId, itemId: approval.itemId, approvalId: approval.id, approved })}>{approved ? '批准本次操作' : '拒绝'}</Button>)}</div></div>)}</section>}
    <div className="grid lg:grid-cols-[280px_minmax(0,1fr)] items-start gap-5"><section aria-label="Experiment 记录" className="rounded-xl border p-4 space-y-3"><div className="flex items-center justify-between"><h2 className="font-semibold">Experiment 记录</h2><span className="text-xs text-muted-foreground">共 {data?.runs.length ?? 0} 条</span></div>{!data?.runs.length && <p className="text-sm text-muted-foreground">尚无 Experiment。从平台或本页启动后，记录会显示在这里。</p>}{visibleRuns.map(item => <button aria-pressed={run?.id === item.id} key={item.id} className={`w-full rounded-lg border p-3 text-left space-y-1 ${run?.id === item.id ? 'border-primary bg-muted' : 'hover:bg-muted/50'}`} onClick={() => setSelected(item.id)}><strong className="block text-sm break-all">{item.name}</strong><span className="block text-xs">{item.datasetName} · {labels[item.status]}</span><span className="block text-xs text-muted-foreground">{new Date(item.createdAt).toLocaleString()}</span></button>)}
      <nav aria-label="Experiment 记录分页" className="flex items-center justify-between gap-2 border-t pt-3">
        <Button variant="outline" size="sm" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>上一页</Button>
        <span className="text-xs text-muted-foreground">第 {currentPage} / {pageCount} 页</span>
        <Button variant="outline" size="sm" disabled={currentPage === pageCount} onClick={() => setPage(currentPage + 1)}>下一页</Button>
      </nav>
    </section>
    <section aria-label="Experiment 详情" className="min-w-0 rounded-xl border p-5 space-y-4">{!run ? <p className="text-sm text-muted-foreground">选择 Experiment 查看用例详情。</p> : <>
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold">{run.name}</h2><p className="text-sm text-muted-foreground">{labels[run.status]} · {run.items.filter(item => ['completed', 'failed', 'cancelled'].includes(item.status)).length} / {run.items.length} 条 · {run.memorySnapshot ? '日常记忆快照' : '空白评估记忆'}</p></div><div className="flex gap-2">{['queued', 'running'].includes(run.status) ? <Button variant="outline" disabled={busy} onClick={() => void act({ action: 'cancel', runId: run.id })}><Square size={14} />取消运行</Button> : <Button variant="outline" disabled={busy} onClick={() => void act({ action: 'refresh', runId: run.id })}><RefreshCw size={14} />刷新评分／重试同步</Button>}</div></div>
      <div className="rounded-lg bg-muted/50 p-3 space-y-2 text-sm">
        <h3 className="font-medium">本次 Experiment 配置</h3>
        <p className="break-all">Experiment 名称：{run.name}</p>
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
