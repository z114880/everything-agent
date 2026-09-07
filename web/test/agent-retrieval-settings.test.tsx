import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ConfigPage } from "../src/components/ConfigPage";

const source = readFileSync(fileURLToPath(new URL("../src/components/ConfigPage.tsx", import.meta.url)), "utf8");

it("召回模式和最低相似度位于原配置页，模板不再提供输入", () => {
  const html = renderToStaticMarkup(<ConfigPage />);
  const retrieval = html.slice(html.indexOf("Memory Retrieval"), html.indexOf("运行参数"));
  expect(retrieval).toContain("Retrieval Mode");
  expect(retrieval).toContain("Minimum Similarity");
  // Radix Select 的浮层选项不会参与服务端静态标记，直接验证声明源。
  expect(source).toContain("Hybrid（RRF + MMR）");
  expect(retrieval).toContain('value="0.3"');
  expect(html).not.toContain("Query Template");
  expect(html).not.toContain("Document Template");
});

it("最低相似度提供可聚焦的帮助入口和页面内提示内容", () => {
  const html = renderToStaticMarkup(<ConfigPage />);
  expect(html).toContain('aria-describedby="minimum-similarity-help"');
  expect(source).toContain('role="tooltip"');
  expect(source).toContain("<TooltipContent");
});
