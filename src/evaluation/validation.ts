import { isAbsolute, normalize } from "node:path";
import type { EvaluationDataset } from "./types.ts";

/** 校验数据集编辑与远端返回值，阻止路径穿越及凭证字段进入用例。 */
export function validateDataset(value: unknown): EvaluationDataset {
  if (JSON.stringify(value)?.length > 2_000_000) fail("数据集最多 2MB");
  const d = object(value); identifier(d.id); text(d.name); text(d.description, true);
  if (typeof d.defaultEnabled !== "boolean") fail("defaultEnabled 必须为布尔值");
  const cases = array(d.cases, 1, 100); const ids = new Set<string>();
  for (const raw of cases) {
    const c = object(raw); const id = identifier(c.id);
    if (ids.has(id)) fail("用例 ID 重复"); ids.add(id); text(c.name);
    array(c.turns, 1, 30).forEach((turn) => text(turn));
    array(c.history, 0, 100).forEach((row) => { const h = object(row); text(h.prompt); text(h.reply); });
    array(c.memory, 0, 1000).forEach((row) => { const m = object(row); text(m.subject); text(m.content); text(m.source); });
    files(c.files);
    array(c.tools, 0, 100).forEach((row) => {
      const t = object(row); if (!["get_current_time", "search_web", "run_terminal"].includes(String(t.name))) fail("仅支持固定的外部工具环境");
      object(t.arguments); if (!("result" in t)) fail("缺少工具结果");
      if (t.files !== undefined) files(t.files);
      if (t.approval !== undefined && typeof t.approval !== "boolean") fail("审批响应必须为布尔值");
    });
    const assertions = array(c.assertions, 0, 100);
    for (const rawAssertion of assertions) {
      const a = object(rawAssertion);
      if (["reply_contains", "reply_equals", "memory_contains", "memory_absent"].includes(String(a.kind))) text(a.value);
      else if (a.kind === "file_equals") { safeRelativePath(text(a.path)); text(a.value, true); }
      else if (a.kind === "tool_called" || a.kind === "tool_forbidden") { text(a.tool); if (a.arguments !== undefined) object(a.arguments); }
      else fail("未知断言类型");
    }
    text(c.expectedOutput, true); text(c.criteria, true);
    if (!assertions.length && !c.criteria) fail("每个用例至少需要一个评分规则");
    if (typeof c.terminal !== "boolean") fail("terminal 必须为布尔值");
    if (c.terminal && (c.tools as { name: string }[]).some(t => t.name === "run_terminal")) fail("真实终端不能同时配置终端模拟结果");
    if (c.judge !== null) {
      const j = object(c.judge); const name = text(j.scoreName);
      if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,99}$/.test(name)) fail("评分名称无效");
      number(j.threshold, 0, 1); text(c.criteria);
    } else if (c.criteria) fail("语义规则需要指定 Langfuse 评分名称");
    if (!assertions.length && !c.judge) fail("每个用例至少需要一个评分规则");
  }
  rejectSecrets(value);
  return structuredClone(value) as EvaluationDataset;
}
/** 数据集、用例和运行的稳定标识，不允许路径分隔符。 */
export function identifier(value: unknown): string {
  const id = text(value); if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) fail("ID 无效"); return id;
}
/** 文件环境只允许普通相对路径，不允许配置文件、凭证和依赖目录。 */
export function safeRelativePath(path: string): string {
  if (!path || isAbsolute(path) || path.includes("\\") || path.split("/").some((part) => ["..", ".", ".git", "node_modules", ".env"].includes(part)) || normalize(path) !== path) fail("文件路径必须位于隔离工作区内");
  return path;
}
function files(value: unknown) { for (const [path, content] of Object.entries(object(value))) { safeRelativePath(path); text(content, true); } }
function rejectSecrets(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (/^(apiKey|api_key|password|authorization|secret|access_token)$/i.test(key)) fail("数据集不能包含凭证字段");
    rejectSecrets(item);
  }
}
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) fail("需要 JSON 对象"); return value as Record<string, unknown>; }
function array(value: unknown, min: number, max: number): unknown[] { if (!Array.isArray(value) || value.length < min || value.length > max) fail("数组长度超出范围"); return value; }
function text(value: unknown, empty = false): string { if (typeof value !== "string" || (!empty && !value.trim()) || value.length > 100000) fail("文本为空或过长"); return value; }
function number(value: unknown, min: number, max: number): void { if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) fail("数值超出范围"); }
function fail(message: string): never { throw new Error(`评估配置无效：${message}`); }
