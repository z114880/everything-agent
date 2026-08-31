interface EdgePlaybackOptions {
  minimumVisibleMs?: number;
}

interface EdgeFrame {
  edges: Set<string>;
  key: string;
}

/**
 * 串行播放 observer 产生的活动边，避免同一响应分块中的快速事件被 React 合并后不可见。
 *
 * 队列只控制展示节奏，不参与或阻塞 Agent 的真实执行。
 */
export function createEdgePlayback(
  render: (edges: Set<string>) => void,
  options: EdgePlaybackOptions = {},
) {
  const minimumVisibleMs = options.minimumVisibleMs ?? 160;
  if (!Number.isFinite(minimumVisibleMs) || minimumVisibleMs < 0) {
    throw new TypeError("minimumVisibleMs 必须是非负有限数");
  }

  const queue: EdgeFrame[] = [];
  let currentKey: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let finishing = false;
  let finishPromise: Promise<void> | null = null;
  let resolveFinish: (() => void) | null = null;

  function show(edges: Iterable<string>): void {
    if (finishing) return;
    const frame = toFrame(edges);
    const lastKey = queue.at(-1)?.key ?? currentKey;
    if (frame.key === lastKey) return;

    if (timer === null) {
      renderFrame(frame);
    } else {
      queue.push(frame);
    }
  }

  function renderFrame(frame: EdgeFrame): void {
    currentKey = frame.key;
    render(new Set(frame.edges));
    timer = setTimeout(advance, minimumVisibleMs);
  }

  function advance(): void {
    timer = null;
    const next = queue.shift();
    if (next) {
      renderFrame(next);
      return;
    }
    if (finishing) complete();
  }

  function finish(): Promise<void> {
    finishing = true;
    if (timer === null && queue.length === 0) {
      complete();
      return Promise.resolve();
    }
    finishPromise ??= new Promise<void>((resolve) => {
      resolveFinish = resolve;
    });
    return finishPromise;
  }

  function complete(): void {
    render(new Set());
    currentKey = null;
    finishing = false;
    finishPromise = null;
    const resolve = resolveFinish;
    resolveFinish = null;
    resolve?.();
  }

  function reset(): void {
    cancel();
    render(new Set());
  }

  function cancel(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    queue.length = 0;
    currentKey = null;
    finishing = false;
    finishPromise = null;
    const resolve = resolveFinish;
    resolveFinish = null;
    resolve?.();
  }

  return { show, finish, reset, cancel };
}

function toFrame(edges: Iterable<string>): EdgeFrame {
  const values = [...new Set(edges)];
  return {
    edges: new Set(values),
    key: [...values].sort().join("\0"),
  };
}
