import { isAbsolute, normalize } from "node:path";
import type { EvaluationPlan, EvaluationModel } from "./types.ts";

/** 校验不可信的实验 JSON；拒绝路径穿越、内嵌凭证及无评分用例。 */
export function validateEvaluationPlan(value: unknown): EvaluationPlan {
  if (JSON.stringify(value)?.length > 2_000_000) fail("实验配置最多 2MB");
  const p = object(value);
  text(p.name); const d = object(p.dataset); text(d.name); text(d.version);
  const cases = array(d.cases, 1, 200); const ids = new Set<string>();
  for (const raw of cases) {
    const c = object(raw); const id = text(c.id); if (!/^[a-zA-Z0-9_-]+$/.test(id) || ids.has(id)) fail("用例 ID 无效或重复"); ids.add(id);
    text(c.name); if (typeof c.critical !== "boolean") fail("critical 必须为布尔值");
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
    if (c.criteria && !p.judge) fail("语义评分需要配置裁判模型");
  }
  for (const raw of [p.baseline, p.candidate]) {
    const v = object(raw); text(v.name); if (!isAbsolute(text(v.sourceRoot))) fail("源码目录必须为绝对路径");
    text(v.systemPrompt, true); model(v.agent); model(v.small);
    const retrieval = object(v.retrieval);
    if (!["lexical_only", "dense_only", "hybrid"].includes(String(retrieval.mode))) fail("检索模式无效");
    number(retrieval.minimumSimilarity, -1, 1);
    if (retrieval.embedding !== null) { model(retrieval.embedding); if (retrieval.embedding.provider !== "openai-compatible") fail("Embedding 必须使用 OpenAI 兼容协议"); }
    if (retrieval.mode !== "lexical_only" && !retrieval.embedding) fail("Dense/Hybrid 需要 Embedding 配置");
    integer(v.maxIterations, 1, 1000); integer(v.maxTokens, 1, 131072); integer(v.modelContextWindow, 1024, 2000000);
    if (Number(v.maxTokens) + 512 >= Number(v.modelContextWindow)) fail("上下文预算不足");
    const names = new Set<string>();
    array(v.skills, 0, 100).forEach((rawSkill) => { const s = object(rawSkill); const name = text(s.name); if (!/^[a-z0-9][a-z0-9-]*$/.test(name) || names.has(name)) fail("Skill 名称无效或重复"); names.add(name); text(s.content); });
  }
  integer(p.repetitions, 1, 30); integer(p.timeoutMs, 1000, 3600000);
  if (cases.length * Number(p.repetitions) * 2 > 2000) fail("单次实验最多 2000 次执行");
  if (p.judge !== null) model(p.judge);
  const g = object(p.gate);
  for (const key of ["maxSuccessRateDrop", "minimumPassRate", "judgeThreshold"]) number(g[key], 0, 1);
  integer(g.minimumRepetitions, 1, 30);
  for (const key of ["maxAgentUsd", "maxJudgeUsd"]) if (g[key] !== null) number(g[key], 0, 1000000);
  rejectSecrets(value);
  return structuredClone(value) as EvaluationPlan;
}

/** 文件环境只允许普通相对路径，不允许配置文件、凭证和依赖目录。 */
export function safeRelativePath(path: string): string {
  if (!path || isAbsolute(path) || path.includes("\\") || path.split("/").some((part) => ["..", ".", ".git", "node_modules", ".env"].includes(part)) || normalize(path) !== path) fail("文件路径必须位于隔离工作区内");
  return path;
}
function files(value: unknown) { for (const [path, content] of Object.entries(object(value))) { safeRelativePath(path); text(content, true); } }
function model(value: unknown): asserts value is EvaluationModel {
  const m = object(value); if (!["anthropic", "openai-compatible"].includes(String(m.provider))) fail("模型协议不支持");
  text(m.model); const url = new URL(text(m.baseUrl)); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail("模型地址无效或包含凭证");
  if (!/^[A-Z][A-Z0-9_]*$/.test(text(m.apiKeyEnv))) fail("apiKeyEnv 必须为环境变量名称");
  if (["HOME", "PATH", "TMPDIR", "TZ", "NODE_OPTIONS", "DEEPEVAL_TELEMETRY_OPT_OUT", "CONFIDENT_API_KEY"].includes(String(m.apiKeyEnv))) fail("模型凭证不能占用执行环境控制变量");
  for (const k of ["inputUsdPerMillion", "outputUsdPerMillion"]) if (m[k] !== undefined) number(m[k], 0, 1000000);
}
function rejectSecrets(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (/^(apiKey|api_key|password|authorization|secret|access_token)$/i.test(key)) fail("实验不能包含凭证字段，请使用 apiKeyEnv");
    rejectSecrets(item);
  }
}
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) fail("需要 JSON 对象"); return value as Record<string, unknown>; }
function array(value: unknown, min: number, max: number): unknown[] { if (!Array.isArray(value) || value.length < min || value.length > max) fail("数组长度超出范围"); return value; }
function text(value: unknown, empty = false): string { if (typeof value !== "string" || (!empty && !value.trim()) || value.length > 100000) fail("文本为空或过长"); return value; }
function number(value: unknown, min: number, max: number): void { if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) fail("数值超出范围"); }
function integer(value: unknown, min: number, max: number): void { number(value, min, max); if (!Number.isInteger(value)) fail("需要整数"); }
function fail(message: string): never { throw new Error(`评估配置无效：${message}`); }
