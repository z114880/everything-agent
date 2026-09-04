import type { ModelRequest, TokenEstimator } from "../agent-loop/agent-loop.ts";

const CJK_DENSE_PATTERN = /[\u1100-\u11ff\u2e80-\u9fff\ua960-\ua97f\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/gu;

/** 使用与模型无关的启发式规则估算文本 token 数。 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  if (/^[\x00-\x7F]*$/.test(text)) return Math.ceil(text.length / 4);
  const sparse = text.replace(CJK_DENSE_PATTERN, "");
  const denseCharacters = text.length - sparse.length;
  return denseCharacters + Math.ceil(Buffer.byteLength(sparse, "utf8") / 4);
}

/** 估算一次模型请求中会占用上下文的主要内容。 */
export function estimateRequestTokens(request: ModelRequest): number {
  return estimateTextTokens(request.system)
    + estimateTextTokens(JSON.stringify(request.messages))
    + estimateTextTokens(JSON.stringify(request.tools));
}

/** Agent Loop 与 Memory 共用的无状态 token 估算器。 */
export class RoughTokenEstimator implements TokenEstimator {
  estimateText(text: string): number { return estimateTextTokens(text) }

  estimateRequest(request: ModelRequest): number { return estimateRequestTokens(request) }
}
