import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylePath = fileURLToPath(new URL("../src/index.css", import.meta.url));

/** 取出某个选择器紧跟冒号的声明块，缺少规则时让断言失败。 */
function ruleFor(css: string, selector: string): string {
  const match = css.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`));
  expect(match, `缺少 ${selector} 样式规则`).not.toBeNull();
  return match?.[1] ?? "";
}

/** 取出以 query 开头的媒体查询或容器查询块内容，按花括号配对结束，避免跨块匹配。 */
function blockFor(css: string, query: string): string {
  const start = css.indexOf(query);
  expect(start, `缺少 ${query} 查询块`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    if (css[index] === "}") depth -= 1;
    if (depth === 0) return css.slice(open + 1, index);
  }
  throw new Error(`${query} 查询块缺少结束花括号`);
}

describe("Evaluation 配置事实卡片布局", () => {
  it("按自身可用宽度决定列数，而不是跟随视口宽度断点", async () => {
    const css = await readFile(stylePath, "utf8");
    const facts = ruleFor(css, ".eval-facts");

    // 卡片会被 232px 侧栏和详情卡片内边距压缩，必须用容器查询判断真实可用宽度。
    expect(facts).toMatch(/container-type:\s*inline-size/);
    expect(facts).not.toMatch(/grid-template-columns/);
    // 两列只在卡片确实够宽时生效，保证分列后每列仍有 290px 以上。
    const wide = blockFor(css, "@container eval-facts (width >= 640px)");
    expect(ruleFor(wide, ".eval-facts")).toMatch(/grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
    // 详情卡片里放不下三列，会出现被挤成逐字换行的值列。
    expect(css).not.toMatch(/\.eval-facts\s*\{[^}]*repeat\(3,/);
  });

  it("不再在窄列里用不可收缩的标签列挤压配置值", async () => {
    const css = await readFile(stylePath, "utf8");
    const row = ruleFor(css, ".eval-facts > p");

    // 标签列一旦是纯 max-content，值列在窄卡片里只剩几十像素，长名称和版本号会被逐字挤断。
    expect(row).toMatch(/grid-template-columns:\s*minmax\(\d+px,\s*max-content\)\s+minmax\(0,\s*1fr\)/);
    expect(row).toMatch(/min-width:\s*0/);
    expect(ruleFor(css, ".eval-facts > p > span")).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it("卡片过窄时标签与值上下堆叠", async () => {
    const css = await readFile(stylePath, "utf8");

    const narrow = blockFor(css, "@container eval-facts (width < 400px)");
    expect(ruleFor(narrow, ".eval-facts > p")).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    // 是否堆叠由卡片宽度决定，媒体查询里不应再重复声明列数。
    expect(blockFor(css, "@media (max-width: 760px)")).not.toContain(".eval-facts");
  });
});
