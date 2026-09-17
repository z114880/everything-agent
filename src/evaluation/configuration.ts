import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { createLocalConfig } from "../agent-runtime/index.ts";
import { SkillStore } from "../skills/index.ts";
import type { EvaluationConfiguration, EvaluationModel } from "./types.ts";

/** 冻结当前 Agent 配置；密钥仅返回给运行闭包，不进入报告或浏览器。 */
export async function readEvaluationConfiguration(home: string): Promise<{ configuration: EvaluationConfiguration; credentials: Record<string, string> }> {
  const config = createLocalConfig({ home, defaultSystemPromptPath: join(home, "EVERYTHING.md") });
  const values = await config.readValues();
  const credentials: Record<string, string> = {};
  function model(source: "AGENT" | "SMALL" | "EMBEDDING"): EvaluationModel {
    const prefix = `EVERYTHING_${source}`;
    const apiKeyEnv = `${prefix}_API_KEY`;
    const secret = values[apiKeyEnv];
    if (!secret || /[\r\n]/.test(secret)) throw new Error(`请先在配置页面设置 ${source} 模型密钥`);
    credentials[apiKeyEnv] = secret;
    const baseUrl = values[`${prefix}_BASE_URL`] ?? "";
    const url = new URL(baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("模型地址无效");
    return { provider: source === "EMBEDDING" ? "openai-compatible" : values[`${prefix}_PROVIDER`] as EvaluationModel["provider"], model: values[`${prefix}_MODEL`] ?? "", baseUrl, apiKeyEnv };
  }
  const mode = (values.EVERYTHING_RETRIEVAL_MODE || "lexical_only") as EvaluationConfiguration["retrieval"]["mode"];
  const skills = await new SkillStore(home).list();
  return { configuration: {
    agent: model("AGENT"), small: model("SMALL"), systemPrompt: await config.readSystemPrompt(),
    maxIterations: Number(values.EVERYTHING_AGENT_MAX_ITERATIONS ?? 10),
    maxTokens: Number(values.EVERYTHING_AGENT_MAX_TOKENS ?? 4096),
    modelContextWindow: Number(values.EVERYTHING_MODEL_CONTEXT_WINDOW ?? 32768),
    retrieval: { mode, embedding: mode === "lexical_only" ? null : model("EMBEDDING"), minimumSimilarity: Number(values.EVERYTHING_EMBEDDING_MINIMUM_SIMILARITY ?? 0.3) },
    skills: await Promise.all(skills.map(async skill => ({ name: skill.name, content: await readFile(join(home, "skills", skill.name, "SKILL.md"), "utf8") }))),
  }, credentials };
}
