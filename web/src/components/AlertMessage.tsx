import { CircleAlert } from "lucide-react";
import { useEffect, useState } from "react";

/** 页面错误以悬浮消息展示一次；保留原错误状态，避免持续轮询反复提示。 */
export function AlertMessage({ message }: { message: string }) {
  return message ? <TimedAlert key={message} message={message} /> : null;
}

function TimedAlert({ message }: { message: string }) {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const timeout = window.setTimeout(() => setVisible(false), 2_500);
    return () => window.clearTimeout(timeout);
  }, []);

  if (!visible) return null;
  return <div className="save-message save-message--error alert-message" role="alert">
    <CircleAlert size={15} className="shrink-0" />
    <span>{message}</span>
  </div>;
}
