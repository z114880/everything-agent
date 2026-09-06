import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatMarkdown } from "../src/components/ChatMarkdown";

describe("聊天 Markdown", () => {
  it("将强调、标题、列表、引用和代码渲染成语义元素", () => {
    const html = renderToStaticMarkup(<ChatMarkdown content={'## 操作步骤\n\n**重点**与*说明*，使用 `pnpm test`。\n\n1. 打开设置\n2. 保存\n\n- 检查结果\n\n> 提示\n\n```ts\nconst value = "<内容>";\n```'} />);
    expect(html).toContain("<h2>操作步骤</h2>");
    expect(html).toContain("<strong>重点</strong>");
    expect(html).toContain("<em>说明</em>");
    expect(html).toContain("<code>pnpm test</code>");
    expect(html).toContain("<ol>");
    expect(html).toContain("<li>打开设置</li>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<blockquote>");
    expect(html).toContain('<pre><code class="language-ts">const value = &quot;&lt;内容&gt;&quot;;\n</code></pre>');
    expect(html).not.toContain("**重点**");
  });

  it("支持表格、任务列表、删除线和链接", () => {
    const html = renderToStaticMarkup(<ChatMarkdown content={"| 项目 | 状态 |\n| --- | --- |\n| 聊天 | 完成 |\n\n- [x] 已完成\n\n~~过期~~ [文档](https://example.com/docs)"} />);
    expect(html).toContain("<table>");
    expect(html).toContain("<th>项目</th>");
    expect(html).toContain("<td>完成</td>");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('checked=""');
    expect(html).toContain("<del>过期</del>");
    expect(html).toContain('href="https://example.com/docs"');
  });

  it("不会把消息内的 HTML 或危险链接作为可执行内容", () => {
    const html = renderToStaticMarkup(<ChatMarkdown content={'<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[危险](javascript:alert%281%29)'} />);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("javascript:");
  });

  it("流式消息的未闭合代码块和补全后的内容都能展示", () => {
    const partial = renderToStaticMarkup(<ChatMarkdown content={'```ts\nconst value = 1;'} />);
    expect(partial).toContain('<pre><code class="language-ts">const value = 1;\n</code></pre>');
    const complete = renderToStaticMarkup(<ChatMarkdown content={'```ts\nconst value = 1;\n```\n\n**完成**'} />);
    expect(complete).toContain("<strong>完成</strong>");
  });
});
