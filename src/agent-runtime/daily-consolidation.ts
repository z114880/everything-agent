/** 每日自动整理的兜底触发时刻，按服务端本地时区的整点计算。 */
export const DAILY_CONSOLIDATION_HOUR = 15;

const DEFAULT_INTERVAL_MS = 60_000;

export interface DailyConsolidationCheckOptions {
  /** 发起一次 daily 整理；当天是否真正入队由 Runtime 与每日去重决定。 */
  consolidate: () => Promise<unknown>;
  /** 上报发起过程本身的异常；整理任务自身的失败由后台队列记录。 */
  onError?: (error: unknown) => void;
  /** 注入当前时刻，供测试控制本地日期与小时。 */
  now?: () => Date;
  intervalMs?: number;
}

export interface DailyConsolidationCheck {
  /** 停止后续轮询；可重复调用。 */
  stop(): void;
}

/**
 * 服务端兜底：页面只在挂载时触发 daily 整理，进程长期运行且页面不刷新时当天不会再触发。
 * 轮询比较本地时间而不是一次性定时到点，因此休眠唤醒、进程中途启动和系统时钟调整都能补跑当天检查。
 */
export function startDailyConsolidationCheck(options: DailyConsolidationCheckOptions): DailyConsolidationCheck {
  const now = options.now ?? (() => new Date());
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  let lastCheckedDay: string | undefined;

  function check(): void {
    const current = now();
    if (current.getHours() < DAILY_CONSOLIDATION_HOUR) return;
    const day = localDay(current);
    if (day === lastCheckedDay) return;
    // 先记录当天已检查，避免整理耗时超过轮询间隔时重复发起。
    lastCheckedDay = day;
    // 立即发起，同时把同步抛出的异常也转成 onError，避免定时器回调抛出未处理异常。
    void (async () => options.consolidate())().catch((error: unknown) => options.onError?.(error));
  }

  check();
  const timer = setInterval(check, intervalMs);
  // 兜底检查不应阻止进程退出；库调用方和测试进程不因此挂起。
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}

/** 与每日整理去重一致，使用本地时区的自然日。 */
function localDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
