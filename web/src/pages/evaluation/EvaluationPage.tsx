import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Play, RefreshCw, Database, CheckCircle2, AlertCircle, Clock3 } from "lucide-react";
import { PageHeading } from "../../components/PageHeading";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import { DatasetEditor } from "./DatasetEditor";
import { evaluationOverview, evaluationDataset, initializeEvaluationDatasets, saveEvaluationDataset, startEvaluation, getEvaluation, cancelEvaluation, refreshEvaluationScores, type EvaluationDataset, type EvaluationOverview, type EvaluationRun } from "../../evaluation-api";

const labels: Record<string, string> = { queued: "排队中", running: "执行中", waiting_scores: "等待评分", completed: "已完成", cancelled: "已取消", failed: "未通过", passed: "通过", insufficient: "证据不足", pending: "待同步", synced: "已同步", timed_out: "超时", error: "评分错误" };
/** 固定数据集回归总览：配置用例，运行当前 Agent，查看失败证据与平台评分。 */
export function EvaluationPage() {
  const [overview, setOverview] = useState<EvaluationOverview | null>(null);
  const [tab, setTab] = useState<"overview" | "datasets" | "runs">("overview");
  const [draft, setDraft] = useState<EvaluationDataset | null>(null);
  const [run, setRun] = useState<EvaluationRun | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const selectedRun = useRef<string | null>(null);
  const [onlyFailures, setOnlyFailures] = useState(false);
  async function reload() { const value = await evaluationOverview(); if (mounted.current) setOverview(value); }
  useEffect(() => {
    mounted.current = true; let loading = false;
    async function poll() { if (loading) return; loading = true; try { await reload(); } catch (e) { if (mounted.current) setError(String(e)); } finally { loading = false; } }
    void poll(); const timer = setInterval(() => void poll(), 3000);
    return () => { mounted.current = false; clearInterval(timer); };
  }, []);
  useEffect(() => {
    if (!run || !["queued", "running", "waiting_scores"].includes(run.status)) return;
    let disposed = false, loading = false;
    const timer = setInterval(() => { if (loading) return; loading = true; void getEvaluation(run.id).then(value => { if (!disposed) setRun(value); }).catch(e => { if (!disposed) setError(String(e)); }).finally(() => { loading = false; }); }, 2000);
    return () => { disposed = true; clearInterval(timer); };
  }, [run?.id, run?.status]);
  async function perform(action: () => Promise<void>) { setBusy(true); setError(""); try { await action(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } }
  async function openRun(id: string) { selectedRun.current = id; const value = await getEvaluation(id); if (selectedRun.current === id) { setRun(value); setDraft(null); setTab("runs"); } }
  async function start(ids?: string[]) { const result = await startEvaluation(ids); await openRun(result.id); await reload(); }
  const latest = overview?.runs[0];
  const disabled = busy || Boolean(overview?.active) || !overview?.langfuse.configured;
  return <div className="content-wrap space-y-5">
    <PageHeading eyebrow="个人助理 / 回归评估" title="Evaluation" description="用固定场景检查当前 Agent，持续观察个人助理的任务完成质量。" actions={<Button disabled={disabled} onClick={() => void perform(() => start())}><Play size={14} /> Evaluate 默认数据集</Button>} />
    {error && <div role="alert" className="error-message">{error}</div>}
    <nav className="flex gap-2 border-b pb-3" aria-label="评估视图">{(["overview", "datasets", "runs"] as const).map(key => <Button key={key} variant={tab === key ? "secondary" : "ghost"} aria-pressed={tab === key} onClick={() => { setTab(key); setDraft(null); }}>{key === "overview" ? "Overview" : key === "datasets" ? "数据集" : "运行历史"}</Button>)}</nav>
    {!overview && <p role="status">正在读取评估概览…</p>}
    {overview && tab === "overview" && <>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Metric icon={<Database size={17} />} label="固定数据集" value={String(overview.datasets.length)} detail={`${overview.datasets.reduce((n, d) => n + d.count, 0)} 个个人助理用例`} />
        <Metric icon={<CheckCircle2 size={17} />} label="最近通过率" value={latest && latest.report.total ? `${Math.round(latest.report.passed / latest.report.total * 100)}%` : "—"} detail={latest ? `${latest.report.passed} / ${latest.report.total} 个用例通过` : "尚未运行"} />
        <Metric icon={<AlertCircle size={17} />} label="未通过用例" value={latest ? String(latest.report.failed) : "—"} detail="查看断言、回答与执行证据" />
        <Metric icon={<Clock3 size={17} />} label="评估状态" value={overview.active ? labels[overview.active.status]! : latest ? labels[latest.report.decision]! : "未开始"} detail={latest ? `${latest.report.pending} 个用例证据待齐全` : "使用当前 Agent 配置"} />
      </div>
      <section className="panel p-5 space-y-3"><div className="flex justify-between items-center"><h2>Langfuse</h2><Badge variant={overview.langfuse.configured ? "success" : "outline"}>{overview.langfuse.configured ? "已配置" : "未配置"}</Badge></div>
        <p className="text-sm text-muted-foreground">数据集版本、执行轨迹与自动质量评分统一关联到 Langfuse。所有确定性检查通过且质量评分达标后，评估才通过。</p>
        <p>评估正文上传：{overview.langfuse.captureContent ? "已开启（仅使用脱敏测试数据）" : "未开启，语义评分暂不可运行"}</p>
        {overview.langfuse.url && <a className="inline-flex gap-1 items-center underline" href={overview.langfuse.url} target="_blank" rel="noreferrer">打开 Langfuse <ArrowUpRight size={14} /></a>}
        {!overview.langfuse.configured && <p>请先在服务端配置 Langfuse 连接。配置完成后刷新即可。</p>}
        <Button variant="outline" disabled={busy} onClick={() => void perform(reload)}><RefreshCw size={14} />刷新连接与概览</Button>
      </section>
      <section className="panel p-5 space-y-3"><h2>最近评估</h2>{latest ? <><p>{new Date(latest.createdAt).toLocaleString()} · {labels[latest.status]} · {labels[latest.report.decision]}</p><Button variant="outline" onClick={() => void perform(() => openRun(latest.id))}>查看结果与失败详情</Button></> : <p>尚无评估记录。先初始化个人助理数据集，再运行 Evaluate。</p>}</section>
      <p className="text-sm text-muted-foreground">自动化接入：预留统一运行入口，CI 尚未启用。耗时与用量仅作观察指标。</p>
    </>}
    {overview && tab === "datasets" && <>
      <div className="flex gap-2"><Button variant="outline" disabled={disabled} onClick={() => void perform(async () => { await initializeEvaluationDatasets(); await reload(); })}>初始化默认数据集</Button><Button disabled={disabled} onClick={() => setDraft({ id: crypto.randomUUID(), name: "新数据集", description: "", defaultEnabled: false, cases: [] })}>添加数据集</Button></div>
      {!overview.datasets.length && <section className="panel p-5"><p>默认数据集聚焦时间、上下文、记忆、检索与能力边界，仅包含一个文件整理代码场景。</p></section>}
      {draft ? <DatasetEditor key={draft.id} initial={draft} busy={busy} onClose={() => setDraft(null)} onSave={async value => { setBusy(true); try { await saveEvaluationDataset(value); await reload(); setDraft(null); } finally { setBusy(false); } }} /> : <div className="grid gap-4 lg:grid-cols-2">{overview.datasets.map(d => <section key={d.id} className="panel p-5 space-y-3"><div className="flex justify-between"><h2>{d.name}</h2><Badge variant="outline">{d.defaultEnabled ? "默认评估" : "按需运行"}</Badge></div><p className="text-muted-foreground">{d.description}</p><p>{d.count} 个用例 · {new Date(d.version).toLocaleString()}</p><div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy} onClick={() => void perform(async () => setDraft(await evaluationDataset(d.id)))}>浏览与编辑</Button><Button disabled={disabled} onClick={() => void perform(() => start([d.id]))}>运行此数据集</Button>{d.url && <a href={d.url} target="_blank" rel="noreferrer" className="inline-flex items-center text-sm underline">Langfuse <ArrowUpRight size={14} /></a>}</div></section>)}</div>}
    </>}
    {overview && tab === "runs" && <>
      <section className="panel p-5 space-y-3"><h2>运行历史</h2>{!overview.runs.length && <p>暂无评估运行</p>}{overview.runs.map(item => <div key={item.id} className="flex flex-wrap justify-between gap-3 border-b py-3"><Button variant="ghost" onClick={() => void perform(() => openRun(item.id))}>{new Date(item.createdAt).toLocaleString()}</Button><span>{labels[item.status]} · {labels[item.report.decision]} · {item.report.passed}/{item.report.total}</span></div>)}</section>
      {run && <section className="panel p-5 space-y-4"><div className="flex flex-wrap justify-between gap-3"><h2>评估结果 · {labels[run.report.decision]}</h2><div className="flex gap-2">{overview.active?.id === run.id ? <Button variant="destructive-outline" disabled={busy} onClick={() => void perform(async () => { await cancelEvaluation(run.id); await reload(); })}>取消评估</Button> : <Button variant="outline" disabled={busy || Boolean(overview.active) || run.status === "cancelled" || !["score", "gate"].includes(run.stage)} onClick={() => void perform(async () => { setRun(await refreshEvaluationScores(run.id)); await reload(); })}>刷新评分与同步</Button>}</div></div>
        <p>{run.configuration.agent.model} · {labels[run.status]} · 已执行 {run.executions.length}/{run.report.total} 个用例</p>
        {run.error && <p role="alert">{run.error}</p>}
        {run.report.reasons.map(reason => <p key={reason}>{reason}</p>)}
        <label className="flex gap-2"><input type="checkbox" checked={onlyFailures} onChange={e => setOnlyFailures(e.target.checked)} />只看失败与未完成用例</label>
        {run.datasets.map(dataset => <div key={dataset.id}><h3>{dataset.name}</h3>{dataset.cases.map(c => {
          const execution = run.executions.find(e => e.datasetId === dataset.id && e.caseId === c.id);
          const passed = execution?.status === "completed" && execution.sync === "synced" && execution.evidence?.complete && execution.scores.length === c.assertions.length + (c.judge ? 1 : 0) && execution.scores.every(s => s.status === "passed");
          if (onlyFailures && passed) return null;
          return <details key={c.id} className="border rounded-lg my-3 p-3"><summary className="cursor-pointer">{c.name} · {passed ? "通过" : execution?.scores.some(s => s.status === "failed") ? "未通过" : execution ? labels[execution.status] + " / " + (c.judge && !execution.scores.some(s => s.name === c.judge!.scoreName) ? "待质量评分" : "证据待核实") : "尚未执行"}</summary><div className="space-y-3 mt-3"><p>输入：{c.turns.join(" → ")}</p><p>预期：{c.expectedOutput || "按确定性检查判定"}</p>{execution && <><p>Langfuse：{labels[execution.sync]} · 耗时 {execution.evidence?.totalMs ?? "未知"} ms · 费用 {execution.evidence?.agentUsd == null ? "未知" : `$${execution.evidence.agentUsd}`}</p>{execution.error && <p role="alert">{execution.error}</p>}<pre className="whitespace-pre-wrap">{execution.evidence?.replies.join("\n\n")}</pre><ul>{execution.scores.map(score => <li key={score.name}>{score.name} · {labels[score.status]} · {score.score ?? "—"} · {score.reason}</li>)}</ul>{execution.traceUrl && <a href={execution.traceUrl} target="_blank" rel="noreferrer" className="underline">在 Langfuse 查看 Trace</a>}<details><summary>工具、记忆与用量</summary><pre className="overflow-auto max-h-80">{JSON.stringify({ tools: execution.evidence?.toolCalls, memory: execution.evidence?.memory, usage: execution.evidence?.usage }, null, 2)}</pre></details><details><summary>文件改动</summary><div className="grid md:grid-cols-2 gap-3"><div><h4>执行前</h4><pre className="overflow-auto max-h-80">{JSON.stringify(c.files, null, 2)}</pre></div><div><h4>执行后</h4><pre className="overflow-auto max-h-80">{JSON.stringify(execution.evidence?.files, null, 2)}</pre></div></div></details><details><summary>完整执行轨迹</summary><pre className="overflow-auto max-h-80">{JSON.stringify(execution.evidence?.traces, null, 2)}</pre></details></>}</div></details>;
        })}</div>)}
      </section>}
    </>}
  </div>;
}
function Metric({ icon, label, value, detail }: { icon: React.ReactNode; label: string; value: string; detail: string }) { return <section className="panel p-5 space-y-3"><div className="flex gap-2 text-muted-foreground items-center">{icon}{label}</div><p className="text-2xl font-semibold">{value}</p><p className="text-sm text-muted-foreground">{detail}</p></section>; }
