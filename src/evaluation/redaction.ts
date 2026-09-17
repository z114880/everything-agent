import type { EvaluationExecution } from "./types.ts";

/** 正常结果与进程中断后的 Trace 回收使用同一凭证脱敏规则。 */
export function redactExecution(value: EvaluationExecution, credentials: string[]): EvaluationExecution {
  const secrets = credentials.filter(Boolean);
  function clean(item: unknown): unknown {
    if (typeof item === "string") return secrets.reduce((text, secret) => text.replaceAll(secret, "[凭证已移除]"), item);
    if (Array.isArray(item)) return item.map(clean);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, clean(child)]));
    return item;
  }
  return clean(value) as EvaluationExecution;
}
