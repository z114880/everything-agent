import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { createEvaluationService, emptyEvaluationCase, readLangfuseConfiguration } from "../../src/index.ts";
import { startMockProvider } from "../../mock-data/mock-provider.ts";

// 只构造合成数据与本地模型，不读取现有 Session、记忆或模型凭证。
const root = resolve(import.meta.dirname, "../..");
const configHome = join(root, ".everything");
const config = readLangfuseConfiguration(configHome);
if (!config) throw new Error("请先启用本地 Langfuse 连接");
const directory = await mkdtemp(join(tmpdir(), "langfuse-verification-"));
const provider = await startMockProvider({ plan: () => ({ reply: "合成验证完成", toolCalls: [
  { name: "read_skill", input: { name: "verification" } },
  { name: "session_search", input: { query: "合成" } },
  { name: "manage_memory", input: { action: "submit", intent: "remember", subject: "合成用户", attribute: "偏好", content: "合成用户喜欢蓝色" } },
] }) });
try {
  const testCase = { ...emptyEvaluationCase("verification"), name: "记忆、历史检索与技能", turns: ["合成用户喜欢蓝色，请记住这个偏好。"], assertions: [
    { kind: "reply_contains" as const, value: "合成验证完成" }, { kind: "tool_called" as const, tool: "read_skill" }, { kind: "tool_called" as const, tool: "session_search" }, { kind: "memory_contains" as const, value: "蓝色" },
  ] };
  const isolatedConfig = join(directory, "configuration");
  await mkdir(isolatedConfig);
  await writeFile(join(isolatedConfig, "langfuse.env"), Object.entries({ LANGFUSE_ENABLED: "true", LANGFUSE_BASE_URL: config.baseUrl, LANGFUSE_PUBLIC_KEY: config.publicKey, LANGFUSE_SECRET_KEY: config.secretKey, LANGFUSE_PROJECT_ID: config.projectId ?? "" }).map(([key, value]) => `${key}=${value}`).join("\n"), { mode: 0o600 });
  await writeFile(join(isolatedConfig, "config.json"), JSON.stringify({ models: { agent: { provider: "openai-compatible", baseUrl: provider.baseUrl, model: "mock-agent" }, small: { provider: "openai-compatible", baseUrl: provider.baseUrl, model: "mock-small" } }, retrieval: { mode: "lexical_only" } }));
  await writeFile(join(isolatedConfig, ".env"), "EVERYTHING_AGENT_API_KEY=synthetic-local-model\nEVERYTHING_SMALL_API_KEY=synthetic-local-model\n", { mode: 0o600 });
  await mkdir(join(isolatedConfig, "skills", "verification"), { recursive: true });
  await writeFile(join(isolatedConfig, "skills", "verification", "SKILL.md"), "---\nname: verification\ndescription: 合成验收\n---\n验证本地执行。\n");
  const service = createEvaluationService(join(directory, "evaluations"), isolatedConfig, { sourceRoot: root });
  await service.saveDataset({ id: "verification", name: "合成验收", description: "本地模拟模型与真实 Langfuse API", defaultEnabled: true, cases: [testCase] });
  const id = await service.start(); await service.wait();
  const run = await service.get(id);
  if (run.report.decision !== "passed") throw new Error(`验收执行或同步失败：${JSON.stringify({ report: run.report, error: run.error })}`);
  const traceId = run.executions[0]!.traceId;
  const headers = { Authorization: `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64")}` };
  async function read(path: string) {
    const response = await fetch(`${config!.baseUrl}${path}`, { headers, signal: AbortSignal.timeout(5000), redirect: "error" });
    if (!response.ok) throw new Error(`Langfuse 验收查询失败：HTTP ${response.status}`);
    return await response.json() as { data: Array<{ type?: string; name?: string; id?: string; experimentId?: string }> };
  }
  const from = encodeURIComponent(run.createdAt);
  let verified = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    const observations = await read(`/api/public/v2/observations?traceId=${traceId}&fromStartTime=${from}&limit=100`);
    const scores = await read(`/api/public/v3/scores?traceId=${traceId}&fields=subject`);
    const experiments = await read(`/api/public/experiments?fromStartTime=${from}&limit=100`);
    if (observations.data.some((item) => item.name === "read_skill") && observations.data.some((item) => item.name === "memory_model") && scores.data.some((item) => item.name === "1:reply_contains") && experiments.data.some((item) => item.id === `${id}-verification`)) {
      console.log(JSON.stringify({ decision: "passed", observations: observations.data.length, scores: scores.data.length, url: run.executions[0]!.traceUrl }));
      verified = true; break;
    }
    await setTimeout(1000);
  }
  if (!verified) throw new Error("Langfuse 尚未查询到完整实验、执行步骤和评分，请检查 Worker 的接收状态");
} finally { await provider.close(); await rm(directory, { recursive: true, force: true }); }
