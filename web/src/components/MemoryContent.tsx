/** 展示召回内容，保留结构缩进与正文换行；仅用于阅读，不作为 JSON 导出。 */
export function MemoryContent({ value }: { value: unknown }) {
  if (typeof value === "string") {
    const original = value;
    try {
      value = JSON.parse(value);
    } catch {
      // 普通消息不要求 JSON 格式，解析失败时原样展示。
      return <pre className="recall-content">{original}</pre>;
    }
  }
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2)
    // 按完整转义对处理，避免把路径中的字面反斜杠误当成换行。
    ?.replace(/\\(?:\\|n|r|t|")/g, (escape) => {
      if (escape === "\\n") return "\n";
      if (escape === "\\r") return "\r";
      if (escape === "\\t") return "\t";
      return escape;
    });
  return <pre className="recall-content">{text}</pre>;
}
