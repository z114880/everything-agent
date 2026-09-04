import { estimateTextTokens } from "../../../model/token-estimator.ts";

export interface TextChunk {
  index: number;
  text: string;
  estimatedTokens: number;
  startOffset: number;
  endOffset: number;
}

export interface ChunkOptions {
  targetTokens?: number;
  maxTokens?: number;
  overlapTokens?: number;
  minimumTailTokens?: number;
}

const DEFAULTS = { targetTokens: 400, maxTokens: 512, overlapTokens: 64, minimumTailTokens: 80 } as const;
export const CHUNKING_VERSION = 1;
const SENTENCE_BOUNDARY = /[\n。！？!?；;]/u;
type ResolvedChunkOptions = Required<ChunkOptions>;

/** 按估算 token 预算切块，并优先在段落或中英文句末附近截断。 */
export function chunkText(text: string, options: ChunkOptions = {}): TextChunk[] {
  const settings = { ...DEFAULTS, ...options };
  validateSettings(settings);
  if (!text) return [];
  const positions = codePointPositions(text);
  const prefixUnits = quarterTokenPrefix(text, positions);
  const chunks: TextChunk[] = [];
  let start = 0;
  while (start < positions.length) {
    let end = maximumEnd(prefixUnits, start, settings.maxTokens);
    if (end < positions.length) {
      const preferredEnd = maximumEnd(prefixUnits, start, settings.targetTokens);
      const minimumEnd = Math.max(start + 1, maximumEnd(prefixUnits, start, settings.overlapTokens + 1));
      end = findBoundary(text, positions, preferredEnd, end, minimumEnd);
      while (end > start + 1) {
        const next = overlapStart(prefixUnits, start, end, settings.overlapTokens);
        if (estimatedBetween(prefixUnits, next, positions.length) >= settings.minimumTailTokens) break;
        end -= 1;
      }
    }
    const startOffset = positions[start]!.start;
    const endOffset = positions[end - 1]!.end;
    const chunk = text.slice(startOffset, endOffset);
    chunks.push({ index: chunks.length, text: chunk, estimatedTokens: estimateTextTokens(chunk), startOffset, endOffset });
    if (end === positions.length) break;
    start = overlapStart(prefixUnits, start, end, settings.overlapTokens);
  }
  return chunks;
}

function findBoundary(
  text: string,
  positions: readonly CharacterPosition[],
  preferredEnd: number,
  hardEnd: number,
  minimumEnd: number,
): number {
  for (let index = preferredEnd; index >= minimumEnd; index -= 1) {
    const position = positions[index - 1];
    if (position && SENTENCE_BOUNDARY.test(text.slice(position.start, position.end))) return index;
  }
  for (let index = Math.max(preferredEnd + 1, minimumEnd); index <= hardEnd; index += 1) {
    const position = positions[index - 1];
    if (position && SENTENCE_BOUNDARY.test(text.slice(position.start, position.end))) return index;
  }
  return hardEnd;
}

interface CharacterPosition { start: number; end: number }

function codePointPositions(text: string): CharacterPosition[] {
  const output: CharacterPosition[] = [];
  let offset = 0;
  for (const character of text) {
    output.push({ start: offset, end: offset + character.length });
    offset += character.length;
  }
  return output;
}

function quarterTokenPrefix(text: string, positions: readonly CharacterPosition[]): number[] {
  const output = [0];
  let total = 0;
  for (const position of positions) {
    const character = text.slice(position.start, position.end);
    total += isDenseCharacter(character) ? 4 : Buffer.byteLength(character, "utf8");
    output.push(total);
  }
  return output;
}

function isDenseCharacter(character: string): boolean {
  return /^[\u1100-\u11ff\u2e80-\u9fff\ua960-\ua97f\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]$/u.test(character);
}

function maximumEnd(prefix: readonly number[], start: number, budget: number): number {
  const maximum = prefix[start]! + budget * 4;
  let low = start + 1;
  let high = prefix.length - 1;
  let result = start + 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (prefix[middle]! <= maximum) {
      result = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return result;
}

function overlapStart(prefix: readonly number[], chunkStart: number, end: number, overlap: number): number {
  const minimum = prefix[end]! - overlap * 4;
  let start = end - 1;
  while (start > chunkStart && prefix[start]! >= minimum) start -= 1;
  return Math.max(chunkStart + 1, prefix[start]! < minimum ? start + 1 : start);
}

function estimatedBetween(prefix: readonly number[], start: number, end: number): number {
  return Math.ceil((prefix[end]! - prefix[start]!) / 4);
}

function validateSettings(settings: ResolvedChunkOptions): void {
  for (const [name, value] of Object.entries(settings)) {
    if (!Number.isInteger(value) || value < 1) throw new TypeError(`${name} 必须是正整数`);
  }
  if (settings.targetTokens > settings.maxTokens) throw new TypeError("targetTokens 不能超过 maxTokens");
  if (settings.overlapTokens >= settings.maxTokens) throw new TypeError("overlapTokens 必须小于 maxTokens");
}
