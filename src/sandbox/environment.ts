/**
 * 允许透传给沙箱子进程的变量名。
 *
 * 采用白名单而非按名称模式剔除敏感变量：模式匹配挡不住 `TAVILY_API_KEY` 之外
 * 那些名字里不含 KEY、TOKEN 的凭证，而 `.everything/.env` 里的值全都在
 * `process.env` 中。
 */
const INHERITED_KEYS = ["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "USER", "LOGNAME"] as const;

/**
 * 构造沙箱子进程的完整环境变量。
 *
 * 调用方负责保证 `overrides` 不含凭证；本函数只保证父进程环境不会被整体继承。
 */
export function buildSandboxEnv(
  overrides: Record<string, string> = {},
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of INHERITED_KEYS) {
    const value = source[key];
    if (typeof value === "string" && value !== "") env[key] = value;
  }
  // 关闭彩色与交互式渲染：无人值守执行读不到终端，控制序列只会污染模型输入。
  env.TERM = "dumb";
  env.NO_COLOR = "1";
  return { ...env, ...overrides };
}
