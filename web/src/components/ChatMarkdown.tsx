import { memo } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const components: Components = {
  a: ({ children, href, title }) => <a href={href} title={title} target="_blank" rel="noopener noreferrer">{children}</a>,
  table: ({ children }) => <div className="chat-markdown-table"><table>{children}</table></div>,
};
const remarkPlugins = [remarkGfm];

/** 渲染聊天 Markdown；保留默认 URL 过滤且不执行原始 HTML，支持流式追加的正文。 */
export const ChatMarkdown = memo(function ChatMarkdown({ content }: { content: string }) {
  return <div className="chat-markdown"><Markdown remarkPlugins={remarkPlugins} components={components}>{content}</Markdown></div>;
});
