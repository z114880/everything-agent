import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ConfigPage } from "../src/pages/config/ConfigPage";

const source = readFileSync(fileURLToPath(new URL("../src/pages/config/ConfigPage.tsx", import.meta.url)), "utf8");

it("配置首次加载时不提前渲染会改变状态的按钮", () => {
  const html = renderToStaticMarkup(<ConfigPage />);

  expect(html).toContain("正在加载配置…");
  expect(html).not.toContain('data-slot="button"');
});

it("召回模式和最低相似度位于原配置页，模板不再提供输入", () => {
  const retrieval = source.slice(source.indexOf("Memory Retrieval"), source.indexOf("运行参数"));
  expect(retrieval).toContain("Retrieval Mode");
  expect(retrieval).toContain("Minimum Similarity");
  expect(retrieval).toContain("Hybrid（RRF + MMR）");
  expect(source).toContain("useState<NumericInputValue>(0.3)");
  expect(source).not.toContain("Query Template");
  expect(source).not.toContain("Document Template");
});

it("最低相似度提供可聚焦的帮助入口和页面内提示内容", () => {
  expect(source).toContain('aria-describedby="minimum-similarity-help"');
  expect(source).toContain('role="tooltip"');
  expect(source).toContain("<TooltipContent");
});
