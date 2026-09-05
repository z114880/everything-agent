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
    input: { query?: string; recent?: boolean; limit?: number; window?: number; currentSessionId?: string },
    settings: SessionRecallSettings,
    providedQueryVector?: Float32Array,
    runId?: string,
    observer = this.embedding.retrieval.observer,
  ): Promise<SessionSearchResult> {
    const query = input.query?.trim() ?? "";
    if (Boolean(query) === Boolean(input.recent)) throw new TypeError("query 与 recent=true 必须且只能提供一个");
    const requestedLimit = boundedInteger(input.limit ?? 4, 1, SEARCH_SESSION_LIMIT, "limit");
    const radius = Math.min(boundedInteger(input.window ?? settings.searchWindow, 1, 20, "window"), settings.searchWindow);
    const candidates = query
      ? (await this.search.sessionSearchCandidates(query, input.currentSessionId, providedQueryVector, runId, observer)).slice(0, requestedLimit)
      : this.search.recentCandidates(input.currentSessionId, requestedLimit);
    const sessions: SessionRecallResult[] = [];
    let usedMessages = 0; let usedTokens = 0; let firstTruncated = false;
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index]!;
      let result = this.buildRecallResult(candidate, index + 1, query ? radius : 0, query ? "search" : "recent");
      const size = settings.tokenEstimator.estimateText(JSON.stringify(result.entries));
      if (usedMessages + result.entries.length > settings.messageLimit || usedTokens + size > settings.tokenLimit) {
        if (sessions.length) break;
        result = await this.truncateRecallResult(result, settings);
        firstTruncated = true;
      }
      sessions.push(result);
      usedMessages += result.entries.length; usedTokens += size;
    }
    const droppedSessionCount = candidates.length - sessions.length;
    return {
      retrievalMode: query ? "search" : "recent", ...(query ? { query } : {}), requestedLimit,
      returnedSessionCount: sessions.length, droppedSessionCount,
      truncated: firstTruncated || droppedSessionCount > 0, sessions,
    };
  }

  /**
   * 使用 search 返回的 cursor 扩大完整窗口，或用 sessionId 从头顺序分页。
   * 两个参数必须二选一。
   */
  async readSession(input: { sessionId?: string; cursor?: string; currentSessionId?: string }, settings: SessionRecallSettings): Promise<SessionReadResult> {
    if (Boolean(input.sessionId) === Boolean(input.cursor)) throw new TypeError("sessionId 与 cursor 必须且只能提供一个");
    const cursor: Cursor = input.cursor ? decodeCursor(input.cursor) : {
      version: 1, mode: "sequential", sessionId: input.sessionId!, afterId: 0, contentOffset: 0,
    };
    if (input.currentSessionId && cursor.sessionId === input.currentSessionId) {
      throw new Error("当前 Session 不参与 Session Recall");
    }
    if (cursor.mode === "expand") {
      const candidate: SearchCandidate = { sourceId: cursor.sessionId, sessionId: cursor.sessionId, messageId: cursor.anchorMessageId, totalMatches: 1 };
      const expanded = this.buildRecallResult(candidate, 1, cursor.radius + settings.scrollStep, "search");
      const size = settings.tokenEstimator.estimateText(JSON.stringify(expanded.entries));
      if (expanded.entries.length > settings.messageLimit || size > settings.tokenLimit) {
        return {
          mode: "expand", session: expanded.session, entries: [], totalMessageCount: expanded.totalMessageCount,
          returnedMessageCount: 0, returnedRanges: [], isComplete: false, truncated: true,
          expandLimitReached: true, nextCursor: null,
        };
      }
      return {
        mode: "expand", session: expanded.session, entries: expanded.entries,
        totalMessageCount: expanded.totalMessageCount, returnedMessageCount: expanded.returnedMessageCount,
        returnedRanges: expanded.returnedRanges, isComplete: expanded.isComplete, truncated: false,
        expandLimitReached: false, nextCursor: expanded.nextCursor,
      };
    }
    return this.readSequential(cursor, settings);
  }

  private buildRecallResult(candidate: SearchCandidate, rank: number, radius: number, mode: "search" | "recent"): SessionRecallResult {
    const session = this.sessions.requireSession(candidate.sessionId);
    // 失败 run 仍保存在 Chat Log，但 Session Recall 的发现、展开和读取都完全忽略它。
    const rows = this.sessions.completedRunRows(candidate.sessionId);
    const indexed = rows.filter((row) => row.kind === "user_message" || row.kind === "assistant_message");
    const chosen = new Set<number>();
    const add = (items: Row[]) => items.forEach((row) => chosen.add(Number(row.id)));
    if (mode === "recent") {
      add(indexed.slice(0, 6)); add(indexed.slice(-6));
    } else {
      add(indexed.slice(0, 3)); add(indexed.slice(-3));
      const anchorIndex = indexed.findIndex((row) => Number(row.id) === candidate.messageId);
      if (anchorIndex >= 0) add(indexed.slice(Math.max(0, anchorIndex - radius), anchorIndex + radius + 1));
    }
    const selectedRuns = new Set(rows.filter((row) => chosen.has(Number(row.id))).map((row) => String(row.run_id)));
    const selectedRows = rows.filter((row) => selectedRuns.has(String(row.run_id)));
    const entries = this.sessions.decorateEntries(selectedRows);
    const isComplete = entries.length === rows.length;
    const nextCursor = mode === "search" && candidate.messageId !== undefined && !isComplete
      ? encodeCursor({ version: 1, mode: "expand", sessionId: candidate.sessionId, anchorMessageId: candidate.messageId, radius })
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
      returnedRanges: rangesFor(entries, rows), isComplete, truncated: false, expandLimitReached: false, nextCursor,
    };
  }

  private async truncateRecallResult(result: SessionRecallResult, settings: SessionRecallSettings): Promise<SessionRecallResult> {
    const entries: ChatLogEntry[] = [];
    const allRows = this.sessions.completedRunRows(result.session.id);
    for (const entry of result.entries.slice(0, settings.messageLimit)) {
      const candidate = [...entries, entry];
      if (settings.tokenEstimator.estimateText(JSON.stringify(candidate)) > settings.tokenLimit) break;
      entries.push(entry);
    }
    return {
      ...result, entries, returnedMessageCount: entries.length, returnedRanges: rangesFor(entries, allRows),
      isComplete: false, truncated: true,
      // 截断的 search 结果可能包含不连续的首/事件/尾区间；从头分页才能保证不跳过中间消息。
      nextCursor: encodeCursor({ version: 1, mode: "sequential", sessionId: result.session.id, afterId: 0, contentOffset: 0 }),
    };
  }

  private async readSequential(cursor: Extract<Cursor, { mode: "sequential" }>, settings: SessionRecallSettings): Promise<SessionReadResult> {
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
          next = { version: 1, mode: "sequential", sessionId: cursor.sessionId, afterId: Number(row.id), contentOffset: fragment.nextOffset };
        } else {
          throw new Error("Session Recall Token Limit 过小，无法容纳单条记录元数据");
        }
        break;
      }
      selected.push(entry);
      if (index < allRows.length - 1) next = { version: 1, mode: "sequential", sessionId: cursor.sessionId, afterId: Number(row.id), contentOffset: 0 };
      else next = null;
    }
    const decorated = this.sessions.decorateEntriesFromEntries(selected, allRows);
    return {
      mode: "sequential", session, entries: decorated, totalMessageCount: allRows.length,
      returnedMessageCount: decorated.length, returnedRanges: rangesFor(decorated, allRows),
      isComplete: next === null, truncated: next !== null, expandLimitReached: false, nextCursor: next ? encodeCursor(next) : null,
    };
  }
}

type Cursor =
  | { version: 1; mode: "expand"; sessionId: string; anchorMessageId: number; radius: number }
  | { version: 1; mode: "sequential"; sessionId: string; afterId: number; contentOffset: number };

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
    if (parsed.version !== 1 || (parsed.mode !== "expand" && parsed.mode !== "sequential") || !parsed.sessionId) throw new Error();
    return parsed;
  } catch { throw new TypeError("Session cursor 无效") }
}
