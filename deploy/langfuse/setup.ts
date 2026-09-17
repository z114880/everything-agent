import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile, access } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const directory = resolve(root, ".langfuse");
await mkdir(directory, { recursive: true, mode: 0o700 });
const secret = () => randomBytes(32).toString("hex");
const file = resolve(directory, "compose.env");
for (const target of [file, resolve(root, ".everything/langfuse.env")]) {
  try { await access(target); throw new Error("部署或应用配置已存在，不覆盖现有凭证；请使用现有配置启动服务"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
const postgres = secret(), redis = secret(), clickhouse = secret(), minio = secret();
const publicKey = `pk-lf-${randomUUID()}`, secretKey = `sk-lf-${secret()}`;
const projectId = "everything-agent";
const values = {
  POSTGRES_PASSWORD: postgres, DATABASE_URL: `postgresql://postgres:${postgres}@postgres:5432/postgres`,
  REDIS_AUTH: redis, CLICKHOUSE_PASSWORD: clickhouse, MINIO_ROOT_PASSWORD: minio,
  SALT: secret(), ENCRYPTION_KEY: secret(), NEXTAUTH_SECRET: secret(),
  LANGFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY: minio, LANGFUSE_S3_MEDIA_UPLOAD_SECRET_ACCESS_KEY: minio, LANGFUSE_S3_BATCH_EXPORT_SECRET_ACCESS_KEY: minio,
  LANGFUSE_INIT_ORG_ID: "everything-agent", LANGFUSE_INIT_ORG_NAME: "Everything Agent",
  LANGFUSE_INIT_PROJECT_ID: projectId, LANGFUSE_INIT_PROJECT_NAME: "Everything Agent",
  LANGFUSE_INIT_PROJECT_PUBLIC_KEY: publicKey, LANGFUSE_INIT_PROJECT_SECRET_KEY: secretKey,
  LANGFUSE_INIT_USER_EMAIL: "admin@everything.local", LANGFUSE_INIT_USER_NAME: "本地管理员", LANGFUSE_INIT_USER_PASSWORD: secret(),
};
await writeFile(file, Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n") + "\n", { mode: 0o600, flag: "wx" });
await mkdir(resolve(root, ".everything"), { recursive: true });
await writeFile(resolve(root, ".everything/langfuse.env"), `LANGFUSE_ENABLED=true\nLANGFUSE_BASE_URL=http://localhost:3300\nLANGFUSE_PROJECT_ID=${projectId}\nLANGFUSE_PUBLIC_KEY=${publicKey}\nLANGFUSE_SECRET_KEY=${secretKey}\nLANGFUSE_CAPTURE_CONTENT=false\nLANGFUSE_EVALUATION_CAPTURE_CONTENT=false\n`, { mode: 0o600, flag: "wx" });
console.log("本地配置已生成。登录账号为 admin@everything.local，密码位于 .langfuse/compose.env 的 LANGFUSE_INIT_USER_PASSWORD。密钥不会输出到终端。运行 pnpm run langfuse:up 启动服务。");
