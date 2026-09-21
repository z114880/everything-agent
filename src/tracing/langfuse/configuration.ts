import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

export interface LangfuseConfiguration {
  baseUrl: string;
  publicKey: string;
  secretKey: string;
  projectId?: string | undefined;
  captureContent: boolean;
}

/** 仅从宿主环境和专用服务端文件读取凭证；不向客户端返回此对象。 */
export function readLangfuseConfiguration(home: string): LangfuseConfiguration | null {
  let local: Record<string, string | undefined> = {};
  try { local = parseEnv(readFileSync(join(home, "langfuse.env"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const env = { ...local, ...process.env };
  if (env.LANGFUSE_ENABLED !== "true") return null;
  const baseUrl = env.LANGFUSE_BASE_URL ?? "http://localhost:3300";
  const url = new URL(baseUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Langfuse 地址必须是无凭证、查询或片段的 HTTP(S) 地址");
  if (!env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) throw new Error("Langfuse 已启用，但缺少服务端项目密钥");
  return { baseUrl: baseUrl.replace(/\/+$/, ""), publicKey: env.LANGFUSE_PUBLIC_KEY, secretKey: env.LANGFUSE_SECRET_KEY, projectId: env.LANGFUSE_PROJECT_ID, captureContent: env.LANGFUSE_CAPTURE_CONTENT === "true" };
}
