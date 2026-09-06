import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ConfigPage } from "../src/components/ConfigPage";

it("召回模式和最低相似度位于原配置页，模板不再提供输入", () => {
  const html = renderToStaticMarkup(<ConfigPage />);
  const retrieval = html.slice(html.indexOf("Memory Retrieval"), html.indexOf("运行参数"));
  expect(retrieval).toContain("Retrieval Mode");
  expect(retrieval).toContain("Minimum Similarity");
  expect(retrieval).toContain("Hybrid（RRF + MMR）");
  expect(retrieval).toContain('value="0.3"');
  expect(html).not.toContain("Query Template");
  expect(html).not.toContain("Document Template");
});

it("最低相似度提供可聚焦的帮助入口和页面内提示内容", () => {
  const html = renderToStaticMarkup(<ConfigPage />);
  expect(html).toContain('aria-describedby="minimum-similarity-help"');
  expect(html).toContain('role="tooltip"');
  expect(html).toContain('tabindex="0"');
});
