/** 移除凭证字段和已知密钥；调用方决定哪些正文允许进入评估记录。 */
export function redactEvaluation(value: unknown, secrets: readonly string[] = []): unknown {
  if (typeof value === 'string') {
    let result = value.replace(/\b(?:sk|pk|key|token)-[A-Za-z0-9_-]{8,}\b/gi, '[凭证已移除]').replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [凭证已移除]');
    for (const secret of secrets) if (secret.length >= 4) result = result.split(secret).join('[凭证已移除]');
    return result;
  }
  if (Array.isArray(value)) return value.map(item => redactEvaluation(item, secrets));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
    /api.?key|authorization|cookie|password|secret|^(access|refresh)?_?token$/i.test(key) ? '[凭证已移除]' : redactEvaluation(child, secrets)]));
}
