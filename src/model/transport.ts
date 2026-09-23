// 模型协议共用 HTTP 与 SSE 传输；由公开客户端统一校验连接配置。
export async function* iterateSse(response: Response): AsyncGenerator<Record<string, any>> {
  if (!response.body) throw new Error("模型响应缺少可读取的流");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    // 在累计缓冲区归一化，CR 与 LF 可能来自不同网络分片。
    buffer = (buffer + decoder.decode(value, { stream: !done })).replaceAll("\r\n", "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = raw.split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (data && data !== "[DONE]") yield JSON.parse(data) as Record<string, any>;
      boundary = buffer.indexOf("\n\n");
    }
    if (done) break;
  }
}

export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw await responseError(response);
  return response.json();
}

export async function postStream(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw await responseError(response);
  return response;
}

async function responseError(response: Response): Promise<Error> {
  const text = await response.text();
  try {
    return providerError(JSON.parse(text));
  } catch {
    return new Error(`模型服务返回 HTTP ${response.status}：${text.slice(0, 300)}`);
  }
}

export function providerError(value: unknown): Error {
  if (typeof value === "string") return new Error(value);
  const record = value && typeof value === "object" ? value as Record<string, any> : {};
  const nested = record.error && typeof record.error === "object" ? record.error : record;
  return new Error(String(nested.message ?? nested.error ?? "模型服务请求失败"));
}
