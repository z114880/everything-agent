import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAILY_CONSOLIDATION_HOUR, startDailyConsolidationCheck } from "../index.ts";

/** 构造服务端本地时区的时刻，避免断言依赖运行机器的时区偏移。 */
function localTime(year: number, month: number, day: number, hour: number, minute = 0): Date {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

const INTERVAL_MS = 60_000;

describe("每日 consolidation 兜底检查", () => {
  let clock: Date;
  const now = () => clock;

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("未到当天触发时刻不发起整理，过点后发起一次", () => {
    clock = localTime(2026, 9, 11, DAILY_CONSOLIDATION_HOUR - 1, 59);
    const consolidate = vi.fn(async () => null);
    const check = startDailyConsolidationCheck({ consolidate, now, intervalMs: INTERVAL_MS });

    vi.advanceTimersByTime(INTERVAL_MS);
    expect(consolidate).not.toHaveBeenCalled();

    clock = localTime(2026, 9, 11, DAILY_CONSOLIDATION_HOUR, 0);
    vi.advanceTimersByTime(INTERVAL_MS);
    expect(consolidate).toHaveBeenCalledTimes(1);

    check.stop();
  });

  it("进程在触发时刻之后启动时立即补跑当天的检查", () => {
    clock = localTime(2026, 9, 11, DAILY_CONSOLIDATION_HOUR + 1, 30);
    const consolidate = vi.fn(async () => null);
    const check = startDailyConsolidationCheck({ consolidate, now, intervalMs: INTERVAL_MS });

    expect(consolidate).toHaveBeenCalledTimes(1);
    check.stop();
  });

  it("同一天内多次轮询只发起一次检查", () => {
    clock = localTime(2026, 9, 11, DAILY_CONSOLIDATION_HOUR, 0);
    const consolidate = vi.fn(async () => null);
    const check = startDailyConsolidationCheck({ consolidate, now, intervalMs: INTERVAL_MS });

    for (let minute = 1; minute <= 5; minute++) {
      clock = localTime(2026, 9, 11, DAILY_CONSOLIDATION_HOUR, minute);
      vi.advanceTimersByTime(INTERVAL_MS);
    }
    expect(consolidate).toHaveBeenCalledTimes(1);

    check.stop();
  });

  it("跨到第二天重新具备触发资格", () => {
    clock = localTime(2026, 9, 11, DAILY_CONSOLIDATION_HOUR, 0);
    const consolidate = vi.fn(async () => null);
    const check = startDailyConsolidationCheck({ consolidate, now, intervalMs: INTERVAL_MS });
    expect(consolidate).toHaveBeenCalledTimes(1);

    clock = localTime(2026, 9, 12, DAILY_CONSOLIDATION_HOUR - 1, 0);
    vi.advanceTimersByTime(INTERVAL_MS);
    expect(consolidate).toHaveBeenCalledTimes(1);

    clock = localTime(2026, 9, 12, DAILY_CONSOLIDATION_HOUR, 0);
    vi.advanceTimersByTime(INTERVAL_MS);
    expect(consolidate).toHaveBeenCalledTimes(2);

    check.stop();
  });

  it("休眠跨过触发时刻后在下一次轮询补跑", () => {
    clock = localTime(2026, 9, 11, DAILY_CONSOLIDATION_HOUR - 1, 0);
    const consolidate = vi.fn(async () => null);
    const check = startDailyConsolidationCheck({ consolidate, now, intervalMs: INTERVAL_MS });
    expect(consolidate).not.toHaveBeenCalled();

    clock = localTime(2026, 9, 11, DAILY_CONSOLIDATION_HOUR + 3, 0);
    vi.advanceTimersByTime(INTERVAL_MS);
    expect(consolidate).toHaveBeenCalledTimes(1);

    check.stop();
  });

  it("整理入队失败报告给 onError，且不影响次日触发", async () => {
    clock = localTime(2026, 9, 11, DAILY_CONSOLIDATION_HOUR, 0);
    const failure = new Error("读取运行配置失败");
    const consolidate = vi.fn(async () => {
      throw failure;
    });
    const onError = vi.fn();
    const check = startDailyConsolidationCheck({ consolidate, onError, now, intervalMs: INTERVAL_MS });

    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledWith(failure);

    clock = localTime(2026, 9, 12, DAILY_CONSOLIDATION_HOUR, 0);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(consolidate).toHaveBeenCalledTimes(2);

    check.stop();
  });

  it("stop 之后不再发起检查，且可以重复调用", () => {
    clock = localTime(2026, 9, 11, DAILY_CONSOLIDATION_HOUR - 1, 0);
    const consolidate = vi.fn(async () => null);
    const check = startDailyConsolidationCheck({ consolidate, now, intervalMs: INTERVAL_MS });

    check.stop();
    check.stop();
    clock = localTime(2026, 9, 11, DAILY_CONSOLIDATION_HOUR, 0);
    vi.advanceTimersByTime(INTERVAL_MS * 5);
    expect(consolidate).not.toHaveBeenCalled();
  });
});
