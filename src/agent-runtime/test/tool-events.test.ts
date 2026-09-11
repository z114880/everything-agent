import { describe, expect, it } from "vitest";
import { publicToolEvent } from "../events/tool-events.ts";
import type { ToolCallRecord } from "../../agent-loop/types.ts";

function failedCall(tool: string, message: string): ToolCallRecord {
  return {
    tool,
    args: { action: "submit" },
    result: `工具 ${tool} 执行失败：${message}`,
    output: `工具 ${tool} 执行失败：${message}`,
    toolUseId: "call-1",
    iteration: 1,
    isError: true,
  };
}

describe("publicToolEvent 失败态", () => {
  it("manage_memory 失败时保留真实错误信息，而不是 {redacted:true}", () => {
    const event = publicToolEvent(failedCall("manage_memory", "submit 缺少必填字段：intent、subject、attribute、content"));
    expect(event.result).toContain("submit 缺少必填字段");
  });

  it("read_skill 失败时保留真实错误信息，而不是 {redacted:true}", () => {
    const event = publicToolEvent(failedCall("read_skill", "未找到指定技能"));
    expect(event.result).toContain("未找到指定技能");
  });
});
