import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const buttonSource = fileURLToPath(new URL("../src/components/ui/button.tsx", import.meta.url));
const textareaSource = fileURLToPath(new URL("../src/components/ui/textarea.tsx", import.meta.url));
const styleSheet = fileURLToPath(new URL("../src/index.css", import.meta.url));
const pageHeadingSource = fileURLToPath(new URL("../src/components/PageHeading.tsx", import.meta.url));
const pageSources = ["App.tsx", "components/AgentPage.tsx", "components/ConfigPage.tsx", "components/DatabasePage.tsx", "components/MemoryPage.tsx", "components/SkillsPage.tsx", "components/TracePage.tsx"]
  .map((path) => fileURLToPath(new URL(`../src/${path}`, import.meta.url)));

describe("管理页面视觉一致性", () => {
  it("文本输入区域不绘制 textarea 默认或聚焦外部轮廓", async () => {
    const textarea = await readFile(textareaSource, "utf8");

    expect(textarea).toContain("outline-none");
    expect(textarea).not.toContain("shadow-xs");
    expect(textarea).not.toMatch(/focus-visible:ring(?:-|\b)/);
  });

  it("统一页面标题层级，并让标准与危险操作按钮使用实心底色", async () => {
    const [buttons, styles, pageHeading] = await Promise.all([
      readFile(buttonSource, "utf8"),
      readFile(styleSheet, "utf8"),
      readFile(pageHeadingSource, "utf8"),
    ]);

    expect(pageHeading).toContain('className="page-heading"');
    expect(pageHeading).toContain('className="page-heading-actions"');
    expect(styles).toMatch(/\.eyebrow\s*\{[^}]*font-size:\s*11px/);
    expect(styles).toMatch(/\.page-heading h1\s*\{[^}]*font-size:\s*30px/);
    expect(styles).toMatch(/\.page-heading p\s*\{[^}]*font-size:\s*13px/);
    expect(buttons).toContain('outline: "border border-secondary bg-secondary');
    expect(buttons).toContain('"destructive-outline": "border border-destructive bg-destructive text-white');
    expect(buttons).not.toContain("bg-destructive/5");
  });

  it("所有一级页面复用同一个头部组件和页面 padding", async () => {
    const [styles, ...pages] = await Promise.all([
      readFile(styleSheet, "utf8"),
      ...pageSources.map((path) => readFile(path, "utf8")),
    ]);

    for (const page of pages) expect(page).toContain("<PageHeading");
    expect(styles).toContain("--page-padding-inline: clamp(20px, 3vw, 46px);");
    expect(styles).toMatch(/\.content-wrap\s*\{[^}]*padding:\s*var\(--page-padding-top\) var\(--page-padding-inline\) var\(--page-padding-bottom\)/);
    expect(styles).toMatch(/\.agent-main-column\s*\{[^}]*padding:\s*var\(--page-padding-top\) var\(--page-padding-inline\) var\(--page-padding-bottom\)/);
  });
});
