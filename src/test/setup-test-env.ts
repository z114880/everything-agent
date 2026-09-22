/**
 * 测试进程的环境隔离。
 *
 * Langfuse 配置的合并顺序是「宿主环境变量覆盖 langfuse.env 文件」，而开发机上常常带着真实
 * 评估凭证（LANGFUSE_BASE_URL、项目密钥等）。它们会让 Runtime 测试里的导出请求绕过 fetch
 * 桩打向真实地址：每个请求 5 秒网络超时再叠加 5 秒退避，最后表现为用例超时；LANGFUSE_CAPTURE_CONTENT
 * 还会让「正文不进入导出」的断言失效。这里在加载任何测试文件之前清空这套变量，用例需要时
 * 再用 vi.stubEnv 显式设置。
 */
const LANGFUSE_ENV_KEYS = [
  "LANGFUSE_ENABLED",
  "LANGFUSE_BASE_URL",
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "LANGFUSE_PROJECT_ID",
  "LANGFUSE_CAPTURE_CONTENT",
] as const;

for (const key of LANGFUSE_ENV_KEYS) delete process.env[key];
