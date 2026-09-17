import { useState } from "react";
import { Button } from "../../components/ui/button";
import { Textarea } from "../../components/ui/textarea";
import type { EvaluationCase, EvaluationDataset } from "../../evaluation-api";

const kinds = { reply_contains: "回答包含", reply_equals: "回答等于", memory_contains: "记忆包含", memory_absent: "记忆不包含", tool_called: "成功调用工具", tool_forbidden: "禁止调用工具", file_equals: "文件内容等于" };
const freshCase = (): EvaluationCase => ({ id: crypto.randomUUID(), name: "新用例", turns: [""], history: [], memory: [], files: {}, terminal: false, tools: [], assertions: [], expectedOutput: "", criteria: "", judge: null });

/** 数据集编辑围绕用例与预期展开；运行配置统一使用当前 Agent。 */
export function DatasetEditor({ initial, busy, onSave, onClose }: { initial: EvaluationDataset; busy: boolean; onSave: (value: EvaluationDataset) => Promise<void>; onClose: () => void }) {
  const [dataset, setDataset] = useState(initial);
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState("");
  const testCase = dataset.cases[selected];
  const updateCase = (value: EvaluationCase) => setDataset(d => ({ ...d, cases: d.cases.map((c, i) => i === selected ? value : c) }));
  return <section className="panel p-5 space-y-4" aria-label="数据集编辑">
    <div className="flex justify-between gap-3"><h2>编辑数据集</h2><Button variant="ghost" onClick={onClose} disabled={busy}>关闭编辑</Button></div>
    <label className="block">数据集名称<input className="w-full border rounded p-2" aria-label="数据集名称" value={dataset.name} onChange={e => setDataset({ ...dataset, name: e.target.value })} /></label>
    <label className="block">说明<Textarea aria-label="数据集说明" value={dataset.description} onChange={e => setDataset({ ...dataset, description: e.target.value })} /></label>
    <label className="flex gap-2 items-center"><input type="checkbox" checked={dataset.defaultEnabled} onChange={e => setDataset({ ...dataset, defaultEnabled: e.target.checked })} />包含在默认 Evaluate 中</label>
    <div className="flex flex-wrap gap-2">{dataset.cases.map((c, index) => <Button key={c.id} variant={index === selected ? "secondary" : "ghost"} onClick={() => setSelected(index)}>{c.name}</Button>)}<Button variant="outline" onClick={() => { setDataset({ ...dataset, cases: [...dataset.cases, freshCase()] }); setSelected(dataset.cases.length); }}>添加用例</Button></div>
    {testCase && <div className="border rounded-lg p-4 space-y-4" key={testCase.id}>
      <div className="flex gap-3 items-end"><label className="flex-1">用例名称<input className="w-full border rounded p-2" aria-label="用例名称" value={testCase.name} onChange={e => updateCase({ ...testCase, name: e.target.value })} /></label><Button variant="destructive-outline" disabled={dataset.cases.length <= 1} onClick={() => { setDataset({ ...dataset, cases: dataset.cases.filter((_, i) => i !== selected) }); setSelected(0); }}>删除用例</Button></div>
      {testCase.turns.map((turn, i) => <div key={i} className="flex gap-2"><label className="flex-1">第 {i + 1} 轮输入<Textarea aria-label={`第 ${i + 1} 轮输入`} value={turn} onChange={e => updateCase({ ...testCase, turns: testCase.turns.map((t, index) => index === i ? e.target.value : t) })} /></label><Button variant="ghost" disabled={testCase.turns.length === 1} onClick={() => updateCase({ ...testCase, turns: testCase.turns.filter((_, index) => index !== i) })}>删除轮次</Button></div>)}
      <Button variant="outline" onClick={() => updateCase({ ...testCase, turns: [...testCase.turns, ""] })}>添加轮次</Button>
      <label className="block">预期结果<Textarea aria-label="预期结果" value={testCase.expectedOutput} onChange={e => updateCase({ ...testCase, expectedOutput: e.target.value })} /></label>
      <h3>确定性检查</h3>
      {testCase.assertions.map((assertion, i) => <div className="flex flex-wrap gap-2" key={i}>
        <select className="border rounded p-2" aria-label={`检查 ${i + 1} 类型`} value={assertion.kind} onChange={e => {
          const kind = e.target.value as EvaluationCase["assertions"][number]["kind"];
          const next = kind === "tool_called" || kind === "tool_forbidden" ? { kind, tool: "" } : kind === "file_equals" ? { kind, path: "", value: "" } : { kind, value: "" };
          updateCase({ ...testCase, assertions: testCase.assertions.map((a, index) => index === i ? next : a) });
        }}>{Object.entries(kinds).map(([kind, name]) => <option key={kind} value={kind}>{name}</option>)}</select>
        {"path" in assertion && <input className="border rounded p-2" aria-label={`检查 ${i + 1} 文件路径`} value={assertion.path} placeholder="相对文件路径" onChange={e => updateCase({ ...testCase, assertions: testCase.assertions.map((a, index) => index === i ? { ...assertion, path: e.target.value } : a) })} />}
        <Textarea className="flex-1" aria-label={`检查 ${i + 1} 预期`} value={"tool" in assertion ? assertion.tool : assertion.value} onChange={e => updateCase({ ...testCase, assertions: testCase.assertions.map((a, index) => index === i ? "tool" in assertion ? { ...assertion, tool: e.target.value } : { ...assertion, value: e.target.value } : a) })} />
        <Button variant="ghost" onClick={() => updateCase({ ...testCase, assertions: testCase.assertions.filter((_, index) => index !== i) })}>移除检查</Button>
      </div>)}
      <Button variant="outline" onClick={() => updateCase({ ...testCase, assertions: [...testCase.assertions, { kind: "reply_contains", value: "" }] })}>添加检查</Button>
      <label className="flex gap-2"><input type="checkbox" checked={testCase.judge !== null} onChange={e => updateCase({ ...testCase, judge: e.target.checked ? { scoreName: "task_quality", threshold: 0.8 } : null, criteria: e.target.checked ? testCase.criteria : "" })} />Langfuse 质量评分</label>
      {testCase.judge && <div className="space-y-3"><p className="text-sm text-muted-foreground">在 Langfuse 为 evaluation 环境的评估根节点配置自动裁判，评分名称须一致，输出范围为 0–1。</p><div className="flex gap-3"><label>评分名称<input className="block border rounded p-2" aria-label="评分名称" value={testCase.judge.scoreName} onChange={e => updateCase({ ...testCase, judge: { ...testCase.judge!, scoreName: e.target.value } })} /></label><label>通过阈值<input className="block border rounded p-2" aria-label="通过阈值" type="number" min="0" max="1" step="0.05" value={testCase.judge.threshold} onChange={e => updateCase({ ...testCase, judge: { ...testCase.judge!, threshold: Number(e.target.value) } })} /></label></div><label className="block">评分标准<Textarea aria-label="评分标准" value={testCase.criteria} onChange={e => updateCase({ ...testCase, criteria: e.target.value })} /></label></div>}
      <details><summary className="cursor-pointer">初始环境与工具</summary><div className="space-y-3 mt-3">
        <label className="flex gap-2"><input type="checkbox" checked={testCase.terminal} onChange={e => updateCase({ ...testCase, terminal: e.target.checked })} />在隔离沙箱中执行真实 Terminal（无网络）</label>
        <JsonField label="历史对话" value={testCase.history} onChange={history => updateCase({ ...testCase, history })} />
        <JsonField label="初始记忆" value={testCase.memory} onChange={memory => updateCase({ ...testCase, memory })} />
        <JsonField label="初始文件" value={testCase.files} onChange={files => updateCase({ ...testCase, files })} />
        <JsonField label="模拟工具" value={testCase.tools} onChange={tools => updateCase({ ...testCase, tools })} />
      </div></details>
    </div>}
    {error && <p role="alert">{error}</p>}
    <p className="text-sm text-muted-foreground">只填写虚构或脱敏的测试数据。保存到 Langfuse 后生成新版本，已有运行保留原始用例。</p>
    <Button disabled={busy} onClick={event => { setError(""); if (event.currentTarget.closest("section")?.querySelector('[aria-invalid="true"]')) { setError("请先修正初始环境中的 JSON 格式"); return; } void onSave(dataset).catch(e => setError(String(e instanceof Error ? e.message : e))); }}>保存数据集</Button>
  </section>;
}
function JsonField<T>({ label, value, onChange }: { label: string; value: T; onChange: (value: T) => void }) {
  const [text, setText] = useState(JSON.stringify(value, null, 2));
  const [error, setError] = useState("");
  return <label className="block">{label}<Textarea aria-label={label} aria-invalid={Boolean(error)} value={text} onChange={e => { setText(e.target.value); try { onChange(JSON.parse(e.target.value) as T); setError(""); } catch { setError("JSON 格式无效，请修正后保存"); } }} />{error && <span role="alert">{error}</span>}</label>;
}
