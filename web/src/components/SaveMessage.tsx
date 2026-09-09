import { CheckCircle2 } from "lucide-react";
import { type Dispatch, type SetStateAction, useEffect } from "react";

interface SaveMessageProps {
  message: string;
  setMessage: Dispatch<SetStateAction<string>>;
}

/** 展示短暂的成功反馈，并在 2.5 秒后自动清除消息。 */
export function SaveMessage({ message, setMessage }: SaveMessageProps) {
  useEffect(() => {
    if (!message) return;
    const timeout = window.setTimeout(() => setMessage(""), 2_500);
    return () => window.clearTimeout(timeout);
  }, [message, setMessage]);

  if (!message) return null;
  return <div className="save-message" role="status" aria-live="polite">
    <CheckCircle2 size={15} />
    {message}
  </div>;
}
