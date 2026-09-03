/** 判断键盘事件是否应提交 Agent 输入框中的消息。 */
export function shouldSubmitAgentComposer(event: {
  key: string;
  shiftKey: boolean;
  nativeEvent: { isComposing?: boolean };
}): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing;
}
