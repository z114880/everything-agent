import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const tracePage = fileURLToPath(new URL("../src/components/TracePage.tsx", import.meta.url));

describe("运行记录页面", () => {
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
});
