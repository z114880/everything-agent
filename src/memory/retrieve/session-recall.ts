import type { ChatLogEntry, RecallRange, SessionReadResult, SessionRecallResult, SessionRecallSettings, SessionSearchResult } from "../types.ts";
import type { Row } from "../storage/records.ts";
import { chatFromRow } from "../storage/records.ts";
import type { SearchCandidate, MemorySearch } from "./memory-search.ts";
import { SEARCH_SESSION_LIMIT } from "./memory-search.ts";
import type { SessionStore } from "../storage/session-store.ts";
import type { EmbeddingIndex } from "./embedding-index.ts";

/** Session 召回窗口、预算截断与游标分页。 */
export class SessionRecall {
  private readonly embedding: EmbeddingIndex;
  private readonly sessions: SessionStore;
  private readonly search: MemorySearch;

  constructor(embedding: EmbeddingIndex, sessions: SessionStore, search: MemorySearch) {
    this.embedding = embedding;
    this.sessions = sessions;
    this.search = search;
  }

  /**
   * 按关键词或最近活跃时间发现历史 Session。query 与 recent 必须二选一；
   * Agent 调用通过 currentSessionId 排除当前会话。
   */
  async searchSessions(
    input: { query?: string; recent?: boolean; limit?: number; currentSessionId?: string },
    settings: SessionRecallSettings,
    providedQueryVector?: Float32Array,
    runId?: string,
    observer = this.embedding.retrieval.observer,
  ): Promise<SessionSearchResult> {
    const query = input.query?.trim() ?? "";
    if (Boolean(query) === Boolean(input.recent)) throw new TypeError("query 与 recent=true 必须且只能提供一个");
    const requestedLimit = boundedInteger(input.limit ?? 4, 1, SEARCH_SESSION_LIMIT, "limit");
    const radius = settings.searchWindow;
    const candidates = query
      ? (await this.search.sessionSearchCandidates(query, input.currentSessionId, providedQueryVector, runId, observer)).slice(0, requestedLimit)
      : this.search.recentCandidates(input.currentSessionId, requestedLimit);
    const sessions: SessionRecallResult[] = [];
    let usedMessages = 0; let usedTokens = 0; let anyTruncated = false;
    for (let index = 0; index < candidates.length; index += 1) {
      const remainingMessages = settings.messageLimit - usedMessages;
      const remainingTokens = settings.tokenLimit - usedTokens;
      if (remainingMessages <= 0 || remainingTokens <= 0) break;
      const candidate = candidates[index]!;
      let result = this.buildRecallResult(candidate, index + 1, query ? radius : 0, query ? "search" : "recent");
      let size = settings.tokenEstimator.estimateText(JSON.stringify(result.entries));
      // 预算是整次调用的总额：装不下整段就按剩余额度截断，不整体丢弃，
      // 否则高排名 Session 用不完的额度会白白浪费。
      if (result.entries.length > remainingMessages || size > remainingTokens) {
        result = this.truncateRecallResult(result, { ...settings, messageLimit: remainingMessages, tokenLimit: remainingTokens });
        if (!result.entries.length) break;
        size = settings.tokenEstimator.estimateText(JSON.stringify(result.entries));
        anyTruncated = true;
      }
      sessions.push(result);
      usedMessages += result.entries.length; usedTokens += size;
    }
    const droppedSessionCount = candidates.length - sessions.length;
    return {
      retrievalMode: query ? "search" : "recent", ...(query ? { query } : {}), requestedLimit,
      returnedSessionCount: sessions.length, droppedSessionCount,
      truncated: anyTruncated || droppedSessionCount > 0, sessions,
    };
  }

  /**
   * 从 cursor 记录的位置继续顺序读取，或用 sessionId 从 Session 开头读取。
   * 两个参数必须二选一；cursor 只有「从该位置往后连续读」一种语义。
   */
  async readSession(input: { sessionId?: string; cursor?: string; currentSessionId?: string }, settings: SessionRecallSettings): Promise<SessionReadResult> {
    if (Boolean(input.sessionId) === Boolean(input.cursor)) throw new TypeError("sessionId 与 cursor 必须且只能提供一个");
    const cursor: Cursor = input.cursor ? decodeCursor(input.cursor) : {
      version: 1, sessionId: input.sessionId!, afterId: 0, contentOffset: 0,
    };
    if (input.currentSessionId && cursor.sessionId === input.currentSessionId) {
      throw new Error("当前 Session 不参与 Session Recall");
    }
    return this.readSequential(cursor, settings);
  }

  private buildRecallResult(candidate: SearchCandidate, rank: number, radius: number, mode: "search" | "recent"): SessionRecallResult {
    const session = this.sessions.requireSession(candidate.sessionId);
    // 失败 run 仍保存在 Chat Log，但 Session Recall 的发现与读取都完全忽略它。
    const rows = this.sessions.completedRunRows(candidate.sessionId);
    const indexed = rows.filter((row) => row.kind === "user_message" || row.kind === "assistant_message");
    const chosen = new Set<number>();
    let anchorIndex = -1;
    const add = (items: Row[]) => items.forEach((row) => chosen.add(Number(row.id)));
    if (mode === "recent") {
      add(indexed.slice(0, 6)); add(indexed.slice(-6));
    } else {
      add(indexed.slice(0, 3)); add(indexed.slice(-3));
      anchorIndex = indexed.findIndex((row) => Number(row.id) === candidate.messageId);
      if (anchorIndex >= 0) add(indexed.slice(Math.max(0, anchorIndex - radius), anchorIndex + radius + 1));
    }
    const selectedRuns = new Set(rows.filter((row) => chosen.has(Number(row.id))).map((row) => String(row.run_id)));
    const selectedRows = rows.filter((row) => selectedRuns.has(String(row.run_id)));
    const entries = this.sessions.decorateEntries(selectedRows);
    const isComplete = entries.length === rows.length;
    // 窗口含尾 3 条，整段 entries 的右边界通常就是 Session 末尾；续读必须从锚点窗口的
    // 右边界开始，才能读到锚点之后、尾部之前被跳过的那一段。
    const resumeAfterId = isComplete || anchorIndex < 0 ? 0 : runEndRowId(rows, indexed[Math.min(anchorIndex + radius, indexed.length - 1)]!);
    const nextCursor = resumeAfterId && resumeAfterId !== Number(rows[rows.length - 1]?.id)
      ? encodeCursor({ version: 1, sessionId: candidate.sessionId, afterId: resumeAfterId, contentOffset: 0 })
      : null;
    return {
      session, rank, retrievalSignals: {
        ...(candidate.bm25 === undefined ? {} : { bm25: candidate.bm25 }),
        ...(candidate.dense === undefined ? {} : { dense: candidate.dense }),
        ...(candidate.fused === undefined ? {} : { fused: candidate.fused }),
        ...(candidate.mmr === undefined ? {} : { mmr: candidate.mmr }),
      },
      match: candidate.messageId === undefined ? null : {
        messageId: candidate.messageId, totalMatches: candidate.totalMatches,
        ...(candidate.bm25 === undefined ? {} : { bm25: candidate.bm25 }),
        ...(candidate.dense === undefined ? {} : { dense: candidate.dense }),
      },
      entries, totalMessageCount: rows.length, returnedMessageCount: entries.length, indexedMessageCount: indexed.length,
      returnedRanges: rangesFor(entries, rows), isComplete, truncated: false, nextCursor,
    };
  }

  private truncateRecallResult(result: SessionRecallResult, settings: SessionRecallSettings): SessionRecallResult {
    const allRows = this.sessions.completedRunRows(result.session.id);
    const entries = fitEntriesAroundAnchor(result.entries, result.match?.messageId, settings);
    return {
      ...result, entries, returnedMessageCount: entries.length, returnedRanges: rangesFor(entries, allRows),
      isComplete: false, truncated: true,
      // 截断结果只保留命中点附近的一段，其前后都有缺口；从头分页才能保证不跳过中间消息。
      nextCursor: encodeCursor({ version: 1, sessionId: result.session.id, afterId: 0, contentOffset: 0 }),
    };
  }

  private async readSequential(cursor: Cursor, settings: SessionRecallSettings): Promise<SessionReadResult> {
    const session = this.sessions.requireSession(cursor.sessionId);
    const allRows = this.sessions.completedRunRows(cursor.sessionId);
    const startIndex = cursor.afterId === 0 ? 0 : Math.max(0, allRows.findIndex((row) => Number(row.id) === cursor.afterId));
    const selected: ChatLogEntry[] = []; let next: Cursor | null = null;
    for (let index = startIndex; index < allRows.length && selected.length < settings.messageLimit; index += 1) {
      const row = allRows[index]!;
      if (cursor.afterId !== 0 && Number(row.id) === cursor.afterId && cursor.contentOffset === 0) continue;
      const raw = String(row.content_json); const offset = Number(row.id) === cursor.afterId ? cursor.contentOffset : 0;
      const baseEntry = chatFromRow(row);
      const entry = baseEntry;
      if (offset > 0) { entry.content = raw.slice(offset); entry.contentFragment = true; entry.contentOffset = offset }
      if (settings.tokenEstimator.estimateText(JSON.stringify([...selected, entry])) > settings.tokenLimit) {
        const fragment = await fitEntryPrefix(selected, entry, raw, offset, settings);
        if (fragment) {
          selected.push(fragment.entry);
          next = { version: 1, sessionId: cursor.sessionId, afterId: Number(row.id), contentOffset: fragment.nextOffset };
        } else {
          throw new Error("Session Recall Token Limit 过小，无法容纳单条记录元数据");
        }
        break;
      }
      selected.push(entry);
      if (index < allRows.length - 1) next = { version: 1, sessionId: cursor.sessionId, afterId: Number(row.id), contentOffset: 0 };
      else next = null;
    }
    const decorated = this.sessions.decorateEntriesFromEntries(selected, allRows);
    return {
      session, entries: decorated, totalMessageCount: allRows.length,
      returnedMessageCount: decorated.length, returnedRanges: rangesFor(decorated, allRows),
      // isComplete 严格表示「本次返回覆盖 Session 全部行」；从锚点续读时它必为 false。
      // 「往后是否还有内容」由 nextCursor 表达，两个字段不重叠。
      isComplete: decorated.length === allRows.length, truncated: next !== null,
      nextCursor: next ? encodeCursor(next) : null,
    };
  }
}

/** Cursor 只有一种语义：从 afterId / contentOffset 记录的位置往后连续读。 */
interface Cursor { version: 1; sessionId: string; afterId: number; contentOffset: number }

/** 返回某条消息所属 run 在 rows 中的最后一行 id，保证续读起点落在 run 边界上。 */
function runEndRowId(rows: Row[], anchor: Row): number {
  const runId = String(anchor.run_id);
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (String(rows[index]!.run_id) === runId) return Number(rows[index]!.id);
  }
  return 0;
}

/**
 * 预算不足时保留命中点周围的连续片段：先放下锚点所在的那条消息，再在消息数与
 * token 额度内交替向后、向前扩展。截断绝不能丢掉命中内容，否则搜索结果只剩
 * Session 开头的无关语境。recent 模式没有锚点，从首条开始保留。
 */
function fitEntriesAroundAnchor(entries: ChatLogEntry[], anchorId: number | undefined, settings: SessionRecallSettings): ChatLogEntry[] {
  if (!entries.length || settings.messageLimit <= 0) return [];
  const anchorIndex = Math.max(0, anchorId === undefined ? 0 : entries.findIndex((entry) => entry.id === anchorId));
  const fits = (from: number, to: number): boolean =>
    to - from + 1 <= settings.messageLimit
    && settings.tokenEstimator.estimateText(JSON.stringify(entries.slice(from, to + 1))) <= settings.tokenLimit;
  if (!fits(anchorIndex, anchorIndex)) return [];
  let low = anchorIndex; let high = anchorIndex;
  for (let grew = true; grew;) {
    grew = false;
    if (high + 1 < entries.length && fits(low, high + 1)) { high += 1; grew = true }
    if (low > 0 && fits(low - 1, high)) { low -= 1; grew = true }
  }
  return entries.slice(low, high + 1);
}

function rangesFor(entries: ChatLogEntry[], allRows: Array<Row | ChatLogEntry>): RecallRange[] {
  if (!entries.length) return [];
  const positions = new Map(allRows.map((row, index) => [Number("id" in row ? row.id : 0), index]));
  const sorted = [...entries].sort((a, b) => (positions.get(a.id) ?? 0) - (positions.get(b.id) ?? 0));
  const ranges: RecallRange[] = []; let start = sorted[0]!.id; let previousId = start; let previousPosition = positions.get(start) ?? 0;
  for (const entry of sorted.slice(1)) {
    const position = positions.get(entry.id) ?? previousPosition + 1;
    if (position !== previousPosition + 1) { ranges.push({ fromMessageId: start, toMessageId: previousId }); start = entry.id }
    previousId = entry.id; previousPosition = position;
  }
  ranges.push({ fromMessageId: start, toMessageId: previousId }); return ranges;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, field: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw new TypeError(`${field} 必须是 ${minimum}–${maximum} 的整数`);
  return number;
}

async function fitEntryPrefix(
  previous: ChatLogEntry[],
  baseEntry: ChatLogEntry,
  raw: string,
  offset: number,
  settings: SessionRecallSettings,
): Promise<{ entry: ChatLogEntry; nextOffset: number } | null> {
  let low = 0;
  let high = raw.length - offset;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = {
      ...baseEntry, content: raw.slice(offset, offset + middle), contentTruncated: true,
      contentFragment: true, contentOffset: offset,
    };
    if (settings.tokenEstimator.estimateText(JSON.stringify([...previous, candidate])) <= settings.tokenLimit) low = middle;
    else high = middle - 1;
  }
  if (low < 1) return null;
  return {
    entry: {
      ...baseEntry, content: raw.slice(offset, offset + low), contentTruncated: true,
      contentFragment: true, contentOffset: offset,
    },
    nextOffset: offset + low,
  };
}

function encodeCursor(value: Cursor): string { return Buffer.from(JSON.stringify(value)).toString("base64url") }

function decodeCursor(value: string): Cursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Cursor;
    if (parsed.version !== 1 || !parsed.sessionId) throw new Error();
    return parsed;
  } catch { throw new TypeError("Session cursor 无效") }
}
