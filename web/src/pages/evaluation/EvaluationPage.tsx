import { useEffect, useState } from 'react';
import { RefreshCw, ExternalLink, Copy, Play, Square, FlaskConical, PlugZap, ListChecks, SlidersHorizontal, BookOpen, ChevronRight } from 'lucide-react';
import { PageHeading } from '../../components/PageHeading';
import { SaveMessage } from '../../components/SaveMessage';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '../../components/ui/alert-dialog';
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
/** 数据集 metadata 默认值，页面在两个分区里引用同一份文本，避免两处示例漂移。 */
const datasetMetadataJson = '{"terminal":false,"memorySnapshot":false}';
/** Remote experiment trigger 的 Default config 文本，同样只保留一份。 */
const defaultConfigJson = '{"name":"Everything Agent"}';
/** 提取错误文案：Error 对象只取 message，避免 String(error) 自带的「Error:」前缀让同一条提示出现两种写法。 */
function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
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
  /** 按运行标识绑定刷新动画，切换记录时不会误显示在其他 Experiment 上。 */
  const [refreshingRunId, setRefreshingRunId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const result = await evaluationRequest<EvaluationDashboard>(); if (!disposed) { setData(result); setError(''); } }
      catch (cause) { if (!disposed) setError(errorText(cause)); }
      finally { if (!disposed) timer = setTimeout(() => { void poll(); }, 2000); }
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, []);
  const act = async (body: Record<string, unknown>) => {
    if (busy) return;
    const refreshing = body.action === 'refresh';
    setBusy(true); setMessage(''); setActError('');
    if (refreshing) setRefreshingRunId(String(body.runId));
    try {
      const execute = async () => { await evaluationRequest('', body); return evaluationRequest<EvaluationDashboard>(); };
      setData(await (refreshing ? withMinimumDuration(execute) : execute()));
      if (refreshing) setMessage('评分刷新／同步重试已完成，请查看最新评分与同步状态。');
    }
    catch (cause) { setActError(errorText(cause)); }
    finally { setBusy(false); if (refreshing) setRefreshingRunId(null); }
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
    catch (cause) {
      setConnected(false);
      const text = errorText(cause);
      // 轮询已在 alert 区常驻展示同一个连接错误时，不再改写 alert（避免文案跳动与页面漂移），改为浮层再提示一次。
      if (text && text === (error || data?.error)) setMessage(text);
      else setActError(text);
    }
    finally { setBusy(false); setConnecting(false); }
  };
  const copyHeaders = async () => {
    setActError('');
    try { const headers = await evaluationRequest<{ Authorization: string }>('/webhook-headers', {}); await navigator.clipboard.writeText(headers.Authorization); setMessage('authorization 值已复制，请在 Langfuse 添加请求头。'); }
    catch (cause) { setMessage(''); setActError(errorText(cause)); }
  };
  const run = data?.runs.find(item => item.id === selected) ?? data?.runs[0];
  const pageCount = Math.max(1, Math.ceil((data?.runs.length ?? 0) / 10));
  const currentPage = Math.min(page, pageCount);
  const visibleRuns = data?.runs.slice((currentPage - 1) * 10, currentPage * 10) ?? [];
  const active = data?.runs.some(item => ['queued', 'running'].includes(item.status));
  const projectUrl = data ? `${data.baseUrl}/project/${encodeURIComponent(data.projectId)}` : '';
  /** 轮询错误与操作错误合并展示；两者同时存在时优先展示操作失败原因。 */
  const alert = actError || error || data?.error || '';
  const finishedCount = run ? run.items.filter(item => ['completed', 'failed', 'cancelled'].includes(item.status)).length : 0;
  const syncedCount = run ? run.items.filter(item => item.sync === 'synced').length : 0;
  return <div className="content-wrap evaluation-page">
    <PageHeading eyebrow="真实环境评估" title="Evaluation" description="用真实 Everything Agent 执行 Langfuse 数据集，独立保存评估会话和记忆。" />
    <SaveMessage message={message} setMessage={setMessage} />
    {alert && <div className="error-message" role="alert">{alert}</div>}

    <section className="eval-panel" aria-label="Langfuse 连接">
      <header className="eval-panel-header">
        <span className="eval-panel-icon"><PlugZap size={15} /></span>
        <div className="eval-panel-heading">
          <h2>Langfuse 连接</h2>
          <p>
            {connected ? '平台连接正常' : data?.configured ? '本地入口已就绪，点击连接平台检查' : '等待配置'}
            {data?.baseUrl && <code>{data.baseUrl}</code>}
          </p>
        </div>
        <div className="eval-panel-actions">
          <Button variant="outline" disabled={busy} loading={connecting} onClick={() => void connect()}><RefreshCw size={14} />连接平台</Button>
          {data?.configured && <a className="eval-link" href={projectUrl} target="_blank" rel="noreferrer">打开 Langfuse <ExternalLink size={14} /></a>}
        </div>
      </header>
    </section>

    <section className="eval-panel eval-panel-config" aria-label="运行前配置">
      <header className="eval-panel-header">
        <span className="eval-panel-icon"><SlidersHorizontal size={15} /></span>
        <div className="eval-panel-heading">
          <h2>运行前配置</h2>
          <p>在 Langfuse 以下位置填写配置，示例均为默认值。</p>
        </div>
      </header>
      <div className="eval-panel-body">
        <div className="eval-config-grid">
          <article className="eval-config-card">
            <header><h3>数据集 Metadata</h3><span>作用于该数据集全部用例</span></header>
            <code className="eval-code-block p-3">{datasetMetadataJson}</code>
            <dl className="eval-field-list">
              <div><dt>terminal</dt><dd>默认 false，全部用例关闭终端。设为 true 时，还需要日常工具配置启用终端且沙箱可用。</dd></div>
              <div><dt>memorySnapshot</dt><dd>默认 false，使用空白评估记忆；true 使用日常记忆快照。</dd></div>
            </dl>
            <p className="eval-config-footnote">两项配置统一作用于该数据集的全部用例，本地与平台启动均读取；未填写等同于 false。</p>
          </article>
          <article className="eval-config-card">
            <header><h3>Remote experiment trigger → Default config</h3><span>仅配置 Experiment 名称前缀</span></header>
            <code className="eval-code-block p-3">{defaultConfigJson}</code>
            <dl className="eval-field-list">
              <div><dt>name</dt><dd>Experiment 名称前缀，默认 Everything Agent；最终名称自动附加运行 ID 短码。留空表示不发送 config。</dd></div>
            </dl>
            <p className="eval-config-footnote">此处仅配置名称，不填写 terminal 或 memorySnapshot。每次点击 Run 时该 config 可在 Run remote dataset run 弹窗里临时修改；本地启动在下方「数据集与实验」里填写同一个名称前缀，留空时同样使用默认值。</p>
          </article>
        </div>
      </div>
    </section>

    <section className="eval-panel eval-launch" aria-label="数据集与实验">
      <header className="eval-panel-header">
        <span className="eval-panel-icon"><FlaskConical size={15} /></span>
        <div className="eval-panel-heading">
          <h2>数据集与实验</h2>
          {/* 说明保持标题块内的普通文本，与其余分区的标题块同高；入口按钮拆到标题块之外。 */}
          <p>选择 Langfuse 数据集后在本机启动 Experiment，执行过程与平台入口共用，需要审批时暂停该用例。</p>
        </div>
        {/* 入口是标题块的兄弟项：宽屏与标题、说明共用一条中线，放不下时整行换到标题块下方，不撑高说明行。 */}
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="outline" className="eval-guide-trigger">Langfuse Experiment 配置说明</Button>
          </AlertDialogTrigger>
          <AlertDialogContent className="eval-guide-dialog">
            <AlertDialogHeader>
              <AlertDialogTitle className="eval-guide-title">从 Langfuse 管理平台触发 Experiment</AlertDialogTitle>
              <AlertDialogDescription className="eval-guide-note">按下面的顺序在 Langfuse 界面完成一次性配置，之后即可触发评估。</AlertDialogDescription>
            </AlertDialogHeader>
            {/* 步骤编号由 CSS 计数器生成，正文仍是普通段落，长句可在窄屏内正常换行。 */}
            <div className="eval-steps">
              <p><span>打开数据集 → 进入 <strong>Experiments</strong> 标签页 → 右上角 <strong>Run experiment</strong> → 在 Run Experiment 弹窗里选 <strong>via Webhook</strong> 卡片。</span></p>
              <p><span>首次点击卡片上的 Configure，进入 <strong>Set up remote experiment trigger in UI</strong>：<strong>URL</strong> 填回调地址 <code className="eval-code-inline">{data?.webhookUrl}</code></span></p>
              <p><span><strong>Default config</strong> 填 <code className="eval-code-inline">{defaultConfigJson}</code></span></p>
              <p><span><strong>Sign requests</strong> 保持关闭，我们的网关只校验 authorization，不校验 x-langfuse-signature。</span></p>
              <p><span><strong>Enabled</strong> 打开，否则实验无法触发。</span></p>
              <p><span>展开 <strong>Advanced Options</strong> → <strong>Custom headers</strong>：名称填 <code className="eval-code-inline">authorization</code>，值用下方按钮复制后粘贴，最后保存。</span></p>
            </div>
            <AlertDialogFooter className="eval-guide-footer">
              <span>本地 Web 服务需保持运行。平台评估器需在 Langfuse 中配置，目标为本次 Experiment 的根 Agent observation。未收到评分时显示等待评分，不推断通过。</span>
              <div className="eval-guide-actions">
                <AlertDialogCancel className="eval-copy-button" onClick={() => void copyHeaders()} disabled={!data?.configured}><Copy size={14} />复制 authorization 值</AlertDialogCancel>
                <AlertDialogCancel>关闭</AlertDialogCancel>
              </div>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </header>
      <div className="eval-panel-body">
        <div className="eval-launch-form">
          <div className="eval-field">
            <span id="evaluation-dataset-label" className="eval-field-label">Langfuse 数据集</span>
            <Select value={dataset || noDataset} onValueChange={value => setDataset(value === noDataset ? '' : value)}>
              <SelectTrigger aria-labelledby="evaluation-dataset-label" className="eval-control"><SelectValue placeholder="选择数据集" /></SelectTrigger>
              <SelectContent><SelectItem value={noDataset}><span className="eval-option-placeholder">选择数据集</span></SelectItem>{datasets.map(item => <SelectItem key={item.id} value={item.name}>{item.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="eval-field">
            <span id="evaluation-name-label" className="eval-field-label">Experiment 名称前缀（可选）</span>
            <Input aria-labelledby="evaluation-name-label" className="eval-control" value={name} maxLength={maxNameLength} spellCheck={false} placeholder="留空时使用 Everything Agent" onChange={event => setName(event.target.value)} />
          </div>
          <Button className="h-10" disabled={busy || active || !dataset} onClick={() => void act({ action: 'start', datasetName: dataset, ...(name.trim() ? { name: name.trim() } : {}) })}><Play size={14} />Run Experiment</Button>
        </div>
        <p className="eval-note pt-2">输入支持字符串、{'{ prompt }'} 或 {'{ turns: ["第一轮", "第二轮"] }'}。</p>
      </div>
    </section>

    {Boolean(data?.approvals.length) && <section className="eval-panel eval-panel-approval" aria-label="待确认操作">
      <header className="eval-panel-header">
        <span className="eval-panel-icon"><ListChecks size={15} /></span>
        <div className="eval-panel-heading">
          <h2>待确认操作</h2>
          <p>运行暂停在这些外部写操作上，批准或拒绝后继续该用例。</p>
        </div>
      </header>
      <div className="eval-panel-body">
        <div className="eval-approval-list">
          {data!.approvals.map(approval => <article className="eval-approval" key={approval.id}>
            <div className="eval-approval-meta">
              <span>Experiment {approval.runId.slice(0, 8)}</span>
              <span>用例 {approval.itemId}</span>
            </div>
            <p className="eval-approval-reason">{approval.reason}</p>
            <pre className="eval-pre eval-approval-command">{approval.command}</pre>
            {approval.detail && <p className="eval-approval-detail">{approval.detail}</p>}
            <div className="eval-approval-actions">{[true, false].map(approved => <Button key={String(approved)} variant={approved ? 'default' : 'outline'} disabled={busy} onClick={() => void act({ action: 'approve', runId: approval.runId, itemId: approval.itemId, approvalId: approval.id, approved })}>{approved ? '批准本次操作' : '拒绝'}</Button>)}</div>
          </article>)}
        </div>
      </div>
    </section>}

    <div className="eval-workspace">
      <section className="eval-panel eval-runs" aria-label="Experiment 记录">
        <header className="eval-runs-header">
          <h2>Experiment 记录</h2>
          <span className="eval-count">共 {data?.runs.length ?? 0} 条</span>
        </header>
        <div className="eval-panel-body">
          {!data?.runs.length && <p className="eval-empty">尚无 Experiment。从平台或本页启动后，记录会显示在这里。</p>}
          {visibleRuns.map(item => <button type="button" aria-pressed={run?.id === item.id} key={item.id} className="eval-run" onClick={() => setSelected(item.id)}>
            <strong className="eval-run-name">{item.name}</strong>
            <span className="eval-run-meta">
              <span className="eval-run-dataset">{item.datasetName}</span>
              <span className={`eval-status eval-status-${item.status}`}>{labels[item.status]}</span>
            </span>
            <time className="eval-run-time" dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time>
          </button>)}
        </div>
        <nav className="eval-pagination" aria-label="Experiment 记录分页">
          <Button variant="outline" size="sm" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>上一页</Button>
          <span className="eval-pagination-page">第 {currentPage} / {pageCount} 页</span>
          <Button variant="outline" size="sm" disabled={currentPage === pageCount} onClick={() => setPage(currentPage + 1)}>下一页</Button>
        </nav>
      </section>

      <section className="eval-panel eval-detail" aria-label="Experiment 详情">
        {!run ? <p className="eval-empty">选择 Experiment 查看用例详情。</p> : <>
          <header className="eval-detail-header">
            <div className="eval-detail-heading">
              <h2>{run.name}</h2>
              <p>
                <span className={`eval-status eval-status-${run.status}`}>{labels[run.status]}</span>
                <span>{finishedCount} / {run.items.length} 条用例已结束</span>
                <span>{run.memorySnapshot ? '日常记忆快照' : '空白评估记忆'}</span>
              </p>
            </div>
            <div className="eval-detail-actions">
              {['queued', 'running'].includes(run.status)
                ? <Button variant="outline" disabled={busy} onClick={() => void act({ action: 'cancel', runId: run.id })}><Square size={14} />取消运行</Button>
                : <Button variant="outline" disabled={busy} loading={refreshingRunId === run.id} onClick={() => void act({ action: 'refresh', runId: run.id })}><RefreshCw size={14} />刷新评分／重试同步</Button>}
            </div>
          </header>
          <div className="eval-panel-body">
            {/* 冒号写在标签内，复制文本时仍能读成“terminal：true”。 */}
            <div className="eval-facts">
              <p className="eval-fact-name"><span>Experiment 名称：</span><strong className="eval-fact-value">{run.name}</strong></p>
              <p><span>terminal：</span><code className="eval-fact-value">{String(run.terminalEnabled)}</code></p>
              <p><span>memorySnapshot：</span><code className="eval-fact-value">{String(run.memorySnapshot)}</code></p>
              <p className="eval-fact-version"><span>数据集版本：</span><code className="eval-fact-value">{run.datasetVersion}</code></p>
              <p><span>同步成功：</span><span className="eval-fact-value">{syncedCount} 条</span></p>
            </div>
            <p className="eval-note">上方开关为本次运行读取的数据集配置；terminal 为 true 表示数据集允许终端，实际可用性取决于日常配置与沙箱。执行完成不代表质量通过。</p>
            {(run.error || run.scoreError) && <p className="eval-error-text" role="alert">{run.error || run.scoreError}</p>}
            <div className="eval-items">
              {run.items.map(item => <details className="eval-item" key={item.id}>
                <summary className="eval-item-summary">
                  <strong>{item.id}</strong>
                  <span className={`eval-status eval-status-${item.status}`}>{labels[item.status]}</span>
                  <span className={`eval-status eval-status-${item.sync}`}>{labels[item.sync]}</span>
                  <span className="eval-item-duration">{item.ms === undefined ? '—' : `${(item.ms / 1000).toFixed(1)}s`}</span>
                </summary>
                <div className="eval-item-body">
                  <p className="eval-run-metrics">{item.model ?? '模型尚未返回'} · 工具 {item.toolCalls} 次 · 输入 {item.inputTokens ?? '—'} / 输出 {item.outputTokens ?? '—'} tokens</p>
                  {item.error && <p className="eval-error-text">{item.error}</p>}
                  {item.syncError && <p className="eval-error-text">回传失败：{item.syncError}</p>}
                  <div className="eval-value-grid">
                    {([['输入', item.input], ['预期结果', item.expectedOutput ?? '未设置'], ['实际输出', item.output]] as const).map(([title, value]) => <section className="eval-value" key={title}>
                      <h3 className="eval-value-title">{title}</h3>
                      <pre className="eval-pre eval-value-body">{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre>
                    </section>)}
                  </div>
                  <section className="eval-scores">
                    <h3 className="eval-value-title">平台评分</h3>
                    {!item.scores.length
                      ? <p className="eval-scores-empty">{item.sync === 'synced' ? '等待平台评分／尚未配置评估器' : '等待执行结果同步'}</p>
                      : item.scores.map(score => <p key={score.id}>{score.name}：{String(score.value)} {score.comment && `· ${score.comment}`}</p>)}

                  </section>
                  <a className="eval-link" href={`${projectUrl}/traces/${item.traceId}`} target="_blank" rel="noreferrer">打开 Langfuse Trace</a>
                  <details className="eval-events">
                    <summary><ChevronRight className="eval-events-chevron" size={14} aria-hidden="true" />执行事件（{item.events.length}）</summary>
                    <div className="eval-events-list">
                      {item.events.map(event => <div className="eval-event" key={event.sequence}>{event.sequence}. {new Date(event.timestamp).toLocaleTimeString()} {event.kind} {JSON.stringify(event.data)}</div>)}
                    </div>
                  </details>
                </div>
              </details>)}
            </div>
          </div>
        </>}
      </section>
    </div>
  </div>;
}
