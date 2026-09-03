import { describe, expect, it } from "vitest";
import { shouldSubmitAgentComposer } from "../src/agent-composer";

describe("Agent 聊天输入框", () => {
  it("中文输入法正在选词时，回车只确认候选词而不发送消息", () => {
    expect(shouldSubmitAgentComposer({
      key: "Enter",
      shiftKey: false,
      nativeEvent: { isComposing: true },
    })).toBe(false);
  });

  it("非组合输入态下，Enter 发送消息，Shift+Enter 保留换行", () => {
    expect(shouldSubmitAgentComposer({
      key: "Enter",
      shiftKey: false,
      nativeEvent: { isComposing: false },
    })).toBe(true);
    expect(shouldSubmitAgentComposer({
      key: "Enter",
      shiftKey: true,
      nativeEvent: { isComposing: false },
    })).toBe(false);
  });
});
