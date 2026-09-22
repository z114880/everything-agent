import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { EvaluationInput } from './types.ts';

/** 仅暴露鉴权后的实验触发接口；不提供本地管理、文件访问和审批能力。 */
export function evaluationWebhook(options: { token: string; projectId: string; start: (input: EvaluationInput) => Promise<{ id: string }> }) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const send = (status: number, body: unknown) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(body)); };
    try {
      if (request.url !== '/trigger' || request.method !== 'POST') { send(404, { error: '接口不存在' }); return; }
      const provided = Buffer.from(request.headers.authorization ?? '');
      const expected = Buffer.from(`Bearer ${options.token}`);
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) { send(401, { error: '实验入口鉴权失败' }); return; }
      request.setEncoding('utf8');
      let body = '';
      for await (const chunk of request) { body += String(chunk); if (Buffer.byteLength(body) > 16_384) { send(413, { error: '触发请求过大' }); return; } }
      const value = JSON.parse(body) as Record<string, unknown>;
      if (value.projectId !== options.projectId || typeof value.datasetId !== 'string' || typeof value.datasetName !== 'string') { send(400, { error: '项目或数据集参数不正确' }); return; }
      const payload: unknown = typeof value.payload === 'string' ? JSON.parse(value.payload) : value.payload ?? {};
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) { send(400, { error: 'payload 必须为对象' }); return; }
      const config = payload as Record<string, unknown>;
      if (Object.keys(config).some(key => !['name'].includes(key))) { send(400, { error: '不支持的实验配置字段' }); return; }
      if (config.name !== undefined && typeof config.name !== 'string') { send(400, { error: '实验配置类型不正确' }); return; }
      const run = await options.start({ datasetId: value.datasetId, datasetName: value.datasetName,
        ...(typeof config.name === 'string' ? { name: config.name } : {}) });
      send(202, { runId: run.id });
    } catch { send(400, { error: '无法启动实验，请检查配置或当前运行状态' }); }
  };
}
