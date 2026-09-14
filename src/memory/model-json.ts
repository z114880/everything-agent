/**
 * 解析模型返回的 JSON 对象。
 *
 * 模型经常在 JSON 外多写 markdown 围栏或说明文字，严格 `JSON.parse` 会直接抛
 * SyntaxError 并让整个任务重试；这里按首尾花括号截取后再解析，只有真正缺失或
 * 残缺的 JSON 才失败。截取结果必然以 `{` 开头、`}` 结尾，解析成功即为对象。
 */
export function parseModelJsonObject(text: string): Record<string, unknown> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new TypeError("模型未返回 JSON 对象");
  return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
}
