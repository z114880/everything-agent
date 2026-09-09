import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const tracePage = fileURLToPath(new URL("../src/components/TracePage.tsx", import.meta.url));

describe("Trace 页面", () => {
  it("JSONL 文件默认展开且可折叠，文件内每条 JSON 默认折叠", async () => {
    const source = await readFile(tracePage, "utf8");

    expect(source).toContain("file.path");
    expect(source).toContain('<details className="panel trace-file" open');
    expect(source).toContain('className="trace-file-summary"');
    expect(source).toContain('className="trace-file-chevron"');
    expect(source).toContain('<details className="trace-record"');
    expect(source).toContain("<summary>");
    expect(source).toContain('className="trace-record-chevron"');
    expect(source).not.toMatch(/<details className="trace-record"[^>]*\sopen(?:\s|=|>)/);
    expect(source).toContain("record.type");
    expect(source).toContain("record.timestamp");
    expect(source).toContain("JSON.stringify(record, null, 2)");
    expect(source).not.toContain("groupTraceRecords");
  });

  it("把刷新操作放在统一页面头部的副标题后", async () => {
    const source = await readFile(tracePage, "utf8");

    expect(source).toMatch(/<PageHeading eyebrow="JSONL traces" title="Traces" description="按文件查看已脱敏的 JSONL 事件。" descriptionActions=\{<Button size="sm"[^\n]*刷新数据/);
    expect(source).toContain("No traces yet.");
    expect(source).not.toContain("运行记录");
  });
});
