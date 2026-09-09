import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { SkillsPage } from "../src/components/SkillsPage";

const stylePath = new URL("../src/index.css", import.meta.url);

vi.mock("../src/agent-api", () => ({
  loadSkills: vi.fn(async () => ({ skills: [] })),
  saveSkill: vi.fn(),
  deleteSkill: vi.fn(),
}));

describe("Skills 页面", () => {
  it("展示磁盘事实来源和结构化编辑器", async () => {
    const html = renderToStaticMarkup(<SkillsPage />);
    const source = await readFile(new URL("../src/components/SkillsPage.tsx", import.meta.url), "utf8");

    expect(html).toContain("Skills");
    expect(html).toContain(".everything/skills/&lt;skill-name&gt;/SKILL.md");
    expect(html).toContain("read_skill");
    expect(source).toContain("<span>Name</span>");
    expect(source).toContain("<span>Description</span>");
    expect(source).toContain("<span>Instructions</span>");
    expect(html).toContain("新建 Skill");
  });

  it("初次读取时展示独立加载态，并反馈刷新状态", () => {
    const html = renderToStaticMarkup(<SkillsPage />);

    expect(html).toContain('data-mode="loading"');
    expect(html).toContain("正在准备编辑器");
    expect(html).not.toContain("未保存的新 Skill");
    expect(html).toContain('aria-label="正在重新读取 Skills"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("读取中");
    expect(html).toContain("animate-spin");
  });

  it("新建动作进入独立草稿态并自动聚焦名称", async () => {
    const source = await readFile(new URL("../src/components/SkillsPage.tsx", import.meta.url), "utf8");

    expect(source).toContain('data-mode={isInitialLoading ? "loading" : isCreating ? "create" : "edit"}');
    expect(source).toContain("未保存的新 Skill");
    expect(source).toContain("定义一个可复用能力");
    expect(source).toContain("nameInputRef.current?.focus()");
    expect(source.indexOf("未保存的新 Skill")).toBeGreaterThan(source.indexOf("skills.map((skill)"));
  });

  it("手动刷新至少展示 300ms 加载反馈", async () => {
    const source = await readFile(new URL("../src/components/SkillsPage.tsx", import.meta.url), "utf8");

    expect(source).toContain("MINIMUM_REFRESH_DURATION_MS = 300");
    expect(source).toContain("reload(undefined, MINIMUM_REFRESH_DURATION_MS)");
    expect(source).toContain("if (remainingDuration > 0) await wait(remainingDuration)");
  });

  it("为创建态、刷新态和未保存状态提供清晰样式", async () => {
    const css = await readFile(stylePath, "utf8");

    expect(css).toMatch(/\.skill-list-item-draft\s*\{[^}]*border:\s*1px dashed/);
    expect(css).not.toMatch(/\.skill-list-item-draft\s*\{[^}]*margin-top:\s*auto/);
    expect(css).toMatch(/\.skill-editor-panel\[data-mode="create"\]\s*\{[^}]*border-color:/);
    expect(css).toMatch(/\.skills-refresh\[aria-busy="true"\]\s*\{[^}]*cursor:\s*wait/);
    expect(css).toMatch(/\.skill-editor-actions > span > i\s*\{[^}]*border-radius:\s*999px/);
  });
});
