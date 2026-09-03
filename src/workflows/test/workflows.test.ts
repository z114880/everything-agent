import { afterEach, describe, expect, it, vi } from "vitest";
import { runGraph } from "../../engine/src/index.ts";
import {
  createInitialState as createInboxState,
  graph as inboxGraph,
} from "../inbox-triage.ts";
import {
  createInitialState as createMeetingState,
  graph as meetingGraph,
} from "../meeting-prep.ts";

describe("本地可视化工作流", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("收件箱分拣通过代码路由选择紧急分支", async () => {
    vi.useFakeTimers();
    const execution = runGraph(
      inboxGraph,
      createInboxState("线上故障阻塞发布，请尽快处理"),
    );
    await vi.runAllTimersAsync();
    const result = await execution;

    expect(result.status).toBe("completed");
    expect(result.path).toContain("紧急处理建议");
    expect(result.path).not.toContain("普通处理建议");
    expect(result.state.finalAnswer).toContain("立即确认负责人和影响范围");
  });

  it("会议准备工作流并发读取三类上下文后生成清单", async () => {
    vi.useFakeTimers();
    const waves: string[][] = [];
    const execution = runGraph(
      meetingGraph,
      createMeetingState("准备季度产品评审"),
      {
        observer(kind, event) {
          if (kind === "wave_start" && Array.isArray(event.nodes)) {
            waves.push(event.nodes.map(String));
          }
        },
      },
    );
    await vi.runAllTimersAsync();
    const result = await execution;

    expect(waves).toContainEqual(["读取会议议程", "读取参会人", "检索相关记忆"]);
    expect(result.status).toBe("completed");
    expect(result.state.finalAnswer).toContain("会前准备清单");
    expect(result.state.finalAnswer).toContain("异常流程说明");
  });
});
