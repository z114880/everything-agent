import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEdgePlayback } from "../src/edge-playback";

describe("活动边播放队列", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("快速到达的后续事件不会覆盖尚未展示满最短时间的边", () => {
    const rendered: string[][] = [];
    const playback = createEdgePlayback((edges) => rendered.push([...edges]), {
      minimumVisibleMs: 160,
    });

    playback.show(["llm->tools"]);
    playback.show(["tools->llm"]);

    expect(rendered).toEqual([["llm->tools"]]);
    vi.advanceTimersByTime(159);
    expect(rendered).toEqual([["llm->tools"]]);

    vi.advanceTimersByTime(1);
    expect(rendered).toEqual([["llm->tools"], ["tools->llm"]]);
  });

  it("连续重复的边不会堆积，结束时等待队列播放完再清空", async () => {
    const rendered: string[][] = [];
    const playback = createEdgePlayback((edges) => rendered.push([...edges]), {
      minimumVisibleMs: 100,
    });

    playback.show(["llm->tools"]);
    playback.show(["tools->llm"]);
    playback.show(["tools->llm"]);
    const finished = playback.finish();

    await vi.advanceTimersByTimeAsync(100);
    expect(rendered).toEqual([["llm->tools"], ["tools->llm"]]);

    await vi.advanceTimersByTimeAsync(100);
    await finished;
    expect(rendered).toEqual([["llm->tools"], ["tools->llm"], []]);
  });
});
