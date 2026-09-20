import { createServer } from 'node:http';

// Langfuse Webhook 只允许 80/443；该网关没有宿主端口映射，也不代理管理接口。
createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/trigger') { response.writeHead(404).end(); return; }
  try {
    request.setEncoding('utf8');
    let body = '';
    for await (const chunk of request) { body += String(chunk); if (Buffer.byteLength(body) > 16_384) { response.writeHead(413).end(); return; } }
    const result = await fetch(`http://host.docker.internal:${process.env.EVALUATION_PORT ?? 4319}/trigger`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: request.headers.authorization ?? '' }, body, signal: AbortSignal.timeout(10_000),
    });
    response.writeHead(result.status, { 'Content-Type': 'application/json' }).end(await result.text());
  } catch { response.writeHead(502, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: '本地评估服务未启动或无法连接' })); }
}).listen(80, '0.0.0.0');
