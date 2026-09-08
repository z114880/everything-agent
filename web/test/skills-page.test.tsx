import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SkillsPage } from "../src/components/SkillsPage";

vi.mock("../src/agent-api", () => ({
  loadSkills: vi.fn(async () => ({ skills: [] })),
  saveSkill: vi.fn(),
  deleteSkill: vi.fn(),
}));

describe("Skills 页面", () => {
  it("展示磁盘事实来源、结构化编辑器和受确认保护的删除入口", () => {
    const html = renderToStaticMarkup(<SkillsPage />);
    expect(html).toContain("Skills");
    expect(html).toContain(".everything/skills/&lt;skill-name&gt;/SKILL.md");
    expect(html).toContain("read_skill");
    expect(html).toContain("Name");
    expect(html).toContain("Description");
    expect(html).toContain("Instructions");
    expect(html).toContain("新建 Skill");
  });
});
