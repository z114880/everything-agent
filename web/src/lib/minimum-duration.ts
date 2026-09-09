export const MINIMUM_FEEDBACK_DURATION_MS = 300;

/**
 * 执行异步任务，并在任务过快完成时补足最短反馈时长。
 * 任务成功与失败都遵循同一时长，调用方可用现有 loading 状态驱动界面。
 */
export async function withMinimumDuration<T>(
  task: () => T | PromiseLike<T>,
  minimumDurationMs = MINIMUM_FEEDBACK_DURATION_MS,
): Promise<T> {
  const startedAt = Date.now();
  try {
    return await task();
  } finally {
    const remainingMs = Math.max(
      0,
      minimumDurationMs - Math.max(0, Date.now() - startedAt),
    );
    if (remainingMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, remainingMs));
    }
  }
}
