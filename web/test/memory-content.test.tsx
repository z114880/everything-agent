import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MemoryContent } from "../src/components/MemoryContent";

describe("召回内容展示", () => {
  it("结构化内容保留缩进并显示实际换行", () => {
    const html = renderToStaticMarkup(<MemoryContent value={{ text: "第一行\n第二行", count: 2 }} />);
    expect(html).toContain("第一行\n第二行");
    expect(html).toContain('\n  &quot;count&quot;: 2\n');
    expect(html).not.toContain('第一行\\n第二行');
  });

  it("JSON 字符串也按结构格式化", () => {
    const html = renderToStaticMarkup(<MemoryContent value={'{"text":"第一行\\n第二行"}'} />);
    expect(html).toContain('\n  &quot;text&quot;: &quot;第一行\n第二行&quot;\n');
  });

  it("普通文本与字面的反斜杠不被错误替换，HTML 保持转义", () => {
    expect(renderToStaticMarkup(<MemoryContent value={'C:\\new\\test <script>'} />)).toContain('C:\\new\\test &lt;script&gt;');
    expect(renderToStaticMarkup(<MemoryContent value={{ path: 'C:\\new' }} />)).toContain('C:\\\\new');
  });
});
