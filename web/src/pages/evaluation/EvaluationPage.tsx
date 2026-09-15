import { useEffect, useState } from "react";
import { Button } from "../../components/ui/button";
import { Textarea } from "../../components/ui/textarea";
import { PageHeading } from "../../components/PageHeading";
import { cancelEvaluation, getEvaluation, listEvaluations, reviewEvaluation, startEvaluation, type EvaluationExperiment, type EvaluationList } from "../../evaluation-api";
import { exampleEvaluationPlan } from "../../../../src/evaluation/example";

const labels: Record<string, string> = { passed: "通过", failed: "失败", insufficient: "证据不足", running: "执行中", queued: "排队中", completed: "已完成", cancelled: "已取消", interrupted: "已中断", improved: "改善", regressed: "退化", unchanged: "持平" };

/** 本地实验中心：固定配置、配对比较、原始证据和独立人工复核。 */
export function EvaluationPage() {
  const [list, setList] = useState<EvaluationList | null>(null);
  const [page, setPage] = useState(1);
  const [draft, setDraft] = useState("");
  const [experiment, setExperiment] = useState<EvaluationExperiment | null>(null);
  const [selectedCase, setSelectedCase] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState("");
  const [editing, setEditing] = useState(false);
  const active = experiment?.status === "running" || experiment?.status === "queued";
  useEffect(() => {
    let disposed = false;
    void listEvaluations(page).then((value) => { if (!disposed) setList(value); }).catch((e) => { if (!disposed) setError(String(e)); });
    return () => { disposed = true; };
  }, [page, experiment?.status]);
  useEffect(() => {
    if (!active || !experiment) return;
    let disposed = false;
    const timer = setInterval(() => { void getEvaluation(experiment.id).then((value) => { if (!disposed) setExperiment(value); }).catch((e) => { if (!disposed) setError(String(e)); }); }, 1500);
    return () => { disposed = true; clearInterval(timer); };
  }, [active, experiment?.id]);
  async function perform(action: () => Promise<void>) { setBusy(true); setError(""); try { await action(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } }
  function exportJson(name: string, value: unknown) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
  }
  const testCase = experiment?.plan.dataset.cases.find((c) => c.id === selectedCase);
  return <div className="content-wrap">
    <PageHeading eyebrow="Regression evaluations" title="Evaluation" description="固定测试条件，比较 Agent 版本与执行证据。" />
    {error && <div role="alert" className="error-message">{error}</div>}
    <div className="flex gap-2 my-4">
      <Button onClick={() => { setDraft(JSON.stringify(exampleEvaluationPlan(list?.sourceRoot ?? ""), null, 2)); setEditing(true); }}>新建实验</Button>
      <Button disabled={busy} onClick={() => void perform(async () => setList(await listEvaluations(page)))}>刷新列表</Button>
    </div>
    {editing && <section className="panel p-4 mb-4">
      <h2>实验与测试集配置</h2>
      <p>填写两个版本、固定用例和评分规则。密钥只填写服务端环境变量名称。创建后配置冻结，修改后需新建实验。</p>
      <Textarea aria-label="实验 JSON" className="min-h-80 font-mono my-3" value={draft} onChange={(e) => setDraft(e.target.value)} />
      <Button disabled={busy} onClick={() => void perform(async () => { const { id } = await startEvaluation(JSON.parse(draft)); setExperiment(await getEvaluation(id)); setSelectedCase(""); setEditing(false); })}>创建并运行</Button>
    </section>}
    <section className="panel p-4">
      <h2>实验列表</h2>
      {!list?.items.length && <p>暂无实验</p>}
      {list?.items.map((item) => <div className="flex items-center justify-between gap-3 py-2" key={item.id}>
        <Button variant="ghost" onClick={() => void perform(async () => { setExperiment(await getEvaluation(item.id)); setSelectedCase(""); })}>{item.name}</Button>
        <span>{labels[item.status] ?? item.status} · {item.completed}/{item.total} · {item.decision ? labels[item.decision] : "待评分"}</span>
      </div>)}
      <div className="flex gap-3 mt-3"><Button disabled={page === 1} onClick={() => setPage(page - 1)}>上一页</Button><span>第 {page} 页</span><Button disabled={!list || page * 20 >= list.total} onClick={() => setPage(page + 1)}>下一页</Button></div>
    </section>
    {experiment && <section className="panel p-4 mt-4">
      <h2>{experiment.plan.name} · {labels[experiment.status]}</h2>
      <p>已完成 {experiment.executions.length}/{experiment.plan.dataset.cases.length * experiment.plan.repetitions * 2} 次执行</p>
      {experiment.error && <p role="alert">{experiment.error}</p>}
      <div className="flex gap-2 my-3">
        {active && <Button disabled={busy} onClick={() => void perform(async () => { await cancelEvaluation(experiment.id); setExperiment(await getEvaluation(experiment.id)); })}>取消实验</Button>}
        <Button onClick={() => exportJson(`evaluation-${experiment.id}.json`, experiment)}>导出报告与证据</Button>
        <Button onClick={() => { setDraft(JSON.stringify(experiment.plan, null, 2)); setEditing(true); }}>复制配置重跑</Button>
      </div>
      <div className="grid md:grid-cols-2 gap-3 my-3">{(["baseline", "candidate"] as const).map((side) => {
        const runs = experiment.executions.filter((execution) => execution.variant === side);
        const known = runs.filter((execution) => execution.evidence !== null);
        const usd = runs.length && runs.every((execution) => execution.evidence?.agentUsd != null) ? runs.reduce((sum, execution) => sum + execution.evidence!.agentUsd!, 0) : null;
        return <div key={side}><strong>{side === "baseline" ? "基线" : "候选"}</strong><p>平均响应：{known.length ? Math.round(known.reduce((sum, execution) => sum + execution.evidence!.responseMs, 0) / known.length) : "未知"} ms · 累计成本：{money(usd)}</p></div>;
      })}</div>
      {experiment.report && <>
        <h3>发布门槛：{active ? "执行中，以下为阶段统计" : labels[experiment.report.decision]}</h3>
        <p>基线通过率 {(experiment.report.baselineRate * 100).toFixed(1)}% → 候选通过率 {(experiment.report.candidateRate * 100).toFixed(1)}%</p>
        <p>Agent 成本：{money(experiment.report.agentUsd)} · 评分成本：{money(experiment.report.judgeUsd)}</p>
        <ul>{experiment.report.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
        <table className="w-full text-left my-4"><thead><tr><th>用例</th><th>基线</th><th>候选</th><th>变化</th></tr></thead><tbody>
          {experiment.report.comparisons.slice().sort((a, b) => Number(b.change === "regressed") - Number(a.change === "regressed")).map((row) => <tr key={row.caseId}>
            <td><Button variant="ghost" onClick={() => setSelectedCase(row.caseId)}>{row.caseId}</Button></td><td>{(row.baselineRate * 100).toFixed(0)}%</td><td>{(row.candidateRate * 100).toFixed(0)}%</td><td>{labels[row.change]}</td>
          </tr>)}
        </tbody></table>
      </>}
      {testCase && <>
        <h3>{testCase.name}{testCase.critical ? " · 关键用例" : ""}</h3>
        <div className="grid md:grid-cols-2 gap-4 my-3">{(["baseline", "candidate"] as const).map((side) => <div key={side}>
          <h4>{side === "baseline" ? "基线" : "候选"} · {experiment.plan[side].name}</h4>
          {experiment.executions.filter((e) => e.caseId === selectedCase && e.variant === side).map((e) => <div className="border rounded p-3 my-2" key={e.id}>
            <p>第 {e.repetition} 次 · {labels[e.status] ?? e.status}</p>{e.evidence && !e.evidence.complete && <p>进程中断，仅展示已保存的部分证据</p>}<p>{e.error}</p>
            <pre className="whitespace-pre-wrap">{e.evidence?.replies.join("\n\n")}</pre>
            <p>响应 {e.evidence?.responseMs ?? "未知"} ms · 完成 {e.evidence?.totalMs ?? "未知"} ms</p>
            <ul>{e.scores.map((score) => <li key={score.name}>{score.name}：{labels[score.status] ?? score.status} {score.score} · {score.reason}</li>)}</ul>
            <details><summary>记忆、文件与工具证据</summary><pre className="overflow-auto">{JSON.stringify({ memory: e.evidence?.memory, files: e.evidence?.files, tools: e.evidence?.toolCalls }, null, 2)}</pre></details>
            <details><summary>完整 Trace（包含后台任务）</summary><pre className="overflow-auto max-h-96">{JSON.stringify(e.evidence?.traces, null, 2)}</pre></details>
          </div>)}
        </div>)}</div>
        <Textarea aria-label="人工复核" value={review} onChange={(e) => setReview(e.target.value)} placeholder="记录退化原因和复核结论，不覆盖自动评分" />
        <Button disabled={busy || active || !review.trim()} onClick={() => void perform(async () => { setExperiment(await reviewEvaluation(experiment.id, selectedCase, review)); setReview(""); })}>保存复核</Button>
        <Button onClick={() => { setDraft(JSON.stringify({ ...experiment.plan, dataset: { ...experiment.plan.dataset, version: `${experiment.plan.dataset.version}-regression`, cases: [testCase] } }, null, 2)); setEditing(true); }}>整理为回归实验</Button>
        {experiment.reviews.filter((r) => r.caseId === selectedCase).map((r, i) => <p key={i}>{r.createdAt} · {r.conclusion}</p>)}
      </>}
    </section>}
  </div>;
}
function money(value: number | null) { return value === null ? "未知" : `$${value.toFixed(6)}`; }
