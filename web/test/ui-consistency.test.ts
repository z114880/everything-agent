import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "../src/components/ui/button";
import { withMinimumDuration } from "../src/lib/minimum-duration";

const buttonSource = fileURLToPath(new URL("../src/components/ui/button.tsx", import.meta.url));
const textareaSource = fileURLToPath(new URL("../src/components/ui/textarea.tsx", import.meta.url));
const styleSheet = fileURLToPath(new URL("../src/index.css", import.meta.url));
const indexDocument = fileURLToPath(new URL("../index.html", import.meta.url));
const faviconSource = fileURLToPath(new URL("../public/favicon.svg", import.meta.url));
const pageHeadingSource = fileURLToPath(new URL("../src/components/PageHeading.tsx", import.meta.url));
const componentsDirectory = fileURLToPath(new URL("../src/components", import.meta.url));
const pageSources = [
  "pages/agent/AgentPage.tsx",
  "pages/config/ConfigPage.tsx",
  "pages/database/DatabasePage.tsx",
  "pages/memory/MemoryPage.tsx",
  "pages/skills/SkillsPage.tsx",
  "pages/tools/ToolsPage.tsx",
  "pages/trace/TracePage.tsx",
  "pages/workflow/WorkflowPage.tsx",
]
  .map((path) => fileURLToPath(new URL(`../src/${path}`, import.meta.url)));

describe("管理页面视觉一致性", () => {
  afterEach(() => vi.useRealTimers());

  it("页面实现不放入公共 components 目录", async () => {
    const entries = await readdir(componentsDirectory);

    expect(entries.filter((name) => name.endsWith("Page.tsx"))).toEqual([]);
  });

  it("页面使用与主题主色一致的矢量 favicon", async () => {
    const [document, favicon] = await Promise.all([
      readFile(indexDocument, "utf8"),
      readFile(faviconSource, "utf8"),
    ]);

    expect(document).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg" />');
    expect(document).toContain('<meta name="theme-color" content="#f5f8ff" />');
    expect(favicon).toContain('fill="#2563eb"');
    expect(favicon).toContain('fill="#fff"');
  });

  it("文本输入区域不绘制 textarea 默认或聚焦外部轮廓", async () => {
    const textarea = await readFile(textareaSource, "utf8");

    expect(textarea).toContain("outline-none");
    expect(textarea).not.toContain("shadow-xs");
    expect(textarea).not.toMatch(/focus-visible:ring(?:-|\b)/);
  });

  it("统一页面标题层级，并让标准与危险操作按钮使用清晰的语义层级", async () => {
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
    expect(buttons).toContain('outline: "border-input bg-card');
    expect(buttons).toContain('"destructive-outline": "border-destructive/35 bg-[var(--destructive-soft)]');
    expect(buttons).toContain("disabled:bg-[var(--button-disabled)]");
  });

  it("按钮加载时展示统一进度反馈并自动进入不可点击状态", () => {
    const html = renderToStaticMarkup(
      createElement(Button, { loading: true }, "保存"),
    );

    expect(html).toContain('data-loading="true"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("disabled");
    expect(html).toContain("animate-spin");
    expect(html).toContain("保存");
  });

  it("按钮在两种状态间切换图标并保留文字与原图标占位", () => {
    const normalHtml = renderToStaticMarkup(
      createElement(
        Button,
        null,
        createElement("svg", { width: 14, height: 14 }),
        "保存",
      ),
    );
    const loadingHtml = renderToStaticMarkup(
      createElement(
        Button,
        { loading: true },
        createElement("svg", { width: 14, height: 14 }),
        "保存",
      ),
    );

    expect(normalHtml).not.toContain("animate-spin");
    expect(normalHtml).toContain("保存");
    expect(loadingHtml).toContain("absolute");
    expect(loadingHtml).toContain("[&amp;&gt;svg]:invisible");
    expect(loadingHtml).toContain('data-slot="button-loading-indicator"');
    expect(loadingHtml.indexOf('data-slot="button-loading-indicator"')).toBeGreaterThan(loadingHtml.indexOf("</span>"));
    expect(loadingHtml).toContain("保存");
  });

  it("按钮进入 loading 时文字保持可见", () => {
    const html = renderToStaticMarkup(
      createElement(Button, { loading: true }, "保存"),
    );

    expect(html).not.toContain('class="contents invisible"');
  });

  it("按钮和菜单在悬停及点击时不产生缩放或位移", async () => {
    const buttons = await readFile(buttonSource, "utf8");

    expect(buttons).not.toContain("enabled:hover:-translate-y-px");
    expect(buttons).not.toContain("enabled:active:translate-y-0");
    expect(buttons).not.toMatch(/(?:hover|active):scale-/);
    expect(buttons).not.toContain("box-shadow,transform");
  });

  it("loading 只隐藏原图标并保留文字，不允许调用方传入另一套文案", async () => {
    const buttons = await readFile(buttonSource, "utf8");

    expect(buttons).toContain('loading && "[&>svg]:invisible"');
    expect(buttons).not.toContain("[&>svg]:hidden");
    expect(buttons).not.toContain("loadingText");
  });

  it("瞬时操作的 loading 至少保留 300ms，慢操作结束后不追加等待", async () => {
    vi.useFakeTimers();
    let completed = false;
    const task = withMinimumDuration(() => Promise.resolve()).then(() => {
      completed = true;
    });

    await vi.advanceTimersByTimeAsync(299);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await task;
    expect(completed).toBe(true);
  });

  it("页面切换后的首次读取不强制展示 300ms loading", async () => {
    const [tools, database, memory, traces, skills] = await Promise.all(
      [
        "pages/tools/ToolsPage.tsx",
        "pages/database/DatabasePage.tsx",
        "pages/memory/MemoryPage.tsx",
        "pages/trace/TracePage.tsx",
        "pages/skills/SkillsPage.tsx",
      ].map((path) => readFile(fileURLToPath(new URL(`../src/${path}`, import.meta.url)), "utf8")),
    );

    expect(tools).toContain("applyCatalog(await loadTools())");
    for (const source of [database, memory, traces, skills]) {
      expect(source).toContain("minimumDurationMs = 0");
      expect(source).toContain("void reload();");
    }
  });

  it("使用清爽活力蓝主题，并为不可用按钮提供独立的可读色阶", async () => {
    const styles = await readFile(styleSheet, "utf8");

    expect(styles).toContain("--primary: #2563eb;");
    expect(styles).toContain("--accent-surface: #e8f0ff;");
    expect(styles).toContain("--good: #1f9d72;");
    expect(styles).toContain("--button-disabled: #e7ecf3;");
    expect(styles).toContain("--button-disabled-foreground: #8b98aa;");
    expect(styles).toContain(".brand-mark");
    expect(styles).toMatch(/\.brand-mark\s*\{[^}]*background:\s*var\(--primary\)/);
    expect(styles).toMatch(/\.sidebar\s*\{[^}]*background:\s*#f7faff/);
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
