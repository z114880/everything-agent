import { CheckCircle2, CircleAlert } from "lucide-react";
import { type Dispatch, type SetStateAction, useEffect } from "react";

interface SaveMessageProps {
  message: string;
  setMessage: Dispatch<SetStateAction<string>>;
  /** 提示类型：默认成功样式；error 使用与页面 alert 一致的红色警告样式。 */
  variant?: "success" | "error";
}

/** 展示短暂的操作反馈，并在 2.5 秒后自动清除消息；error 变体使用红色警告样式。 */
export function SaveMessage({ message, setMessage, variant = "success" }: SaveMessageProps) {
  useEffect(() => {
    if (!message) return;
    const timeout = window.setTimeout(() => setMessage(""), 2_500);
    return () => window.clearTimeout(timeout);
  }, [message, setMessage]);

  if (!message) return null;
  const error = variant === "error";
  return <div className={error ? "save-message save-message--error" : "save-message"} role="status" aria-live="polite">
    {error ? <CircleAlert size={15} /> : <CheckCircle2 size={15} />}
    {message}
  </div>;
}
