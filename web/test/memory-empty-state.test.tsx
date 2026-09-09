import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { MemoryPage } from "../src/pages/memory/MemoryPage";

const { useState } = vi.hoisted(() => ({ useState: vi.fn() }));
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useState,
}));

beforeEach(() => useState.mockReset());

it.each(["semantic", "episodic"])("%s 搜索无结果时保留搜索提示", (tab) => {
  const values = [
    tab,
    { semantic: [] },
    "",
    "没有匹配的关键词",
    tab === "semantic" ? [] : null,
    tab === "episodic" ? { sessions: [], retrievalMode: "search", requestedLimit: 4, returnedSessionCount: 0 } : null,
    "",
    "",
    false,
  ];
  for (const value of values) useState.mockReturnValueOnce([value, vi.fn()]);
  const html = renderToStaticMarkup(<MemoryPage />);
  expect(html).toContain('class="recall-hint');
  expect(html).toContain(tab === "semantic" ? "搜索语义记忆" : "搜索历史会话");
  expect(html).toContain(tab === "semantic" ? "输入关键词查找相关记忆，或留空查看记忆列表。" : "输入关键词查找相关内容，或留空查看最近活跃的会话。");
});


it("会话查询统计合并到搜索说明中，数量使用响应值", () => {
  const values = [
    "episodic", { semantic: [] }, "", "", null,
    { sessions: [], retrievalMode: "recent", requestedLimit: 6, returnedSessionCount: 0, truncated: true, droppedSessionCount: 2 },
    "", "", false,
  ];
  for (const value of values) useState.mockReturnValueOnce([value, vi.fn()]);
  const html = renderToStaticMarkup(<MemoryPage />);
  expect(html).toContain("查询上限 6 个会话");
  expect(html).toContain("已返回 0 个");
  expect(html).not.toContain("页码");
  expect(html).toContain("部分结果已截断或省略（省略 2 个会话）。");
  expect(html).not.toContain("最近活跃 · 返回");
  expect(html).not.toContain('class="memory-message"');
});


it("语义搜索返回记忆后仍保留搜索说明", () => {
  const values = [
    "semantic", { semantic: [] }, "", "偏好",
    [{ id: 1, subject: "偏好", content: "喜欢简洁回答", source: "用户", createdAt: "2026-09-07", updatedAt: "2026-09-07" }],
    null, "", "", false,
  ];
  for (const value of values) useState.mockReturnValueOnce([value, vi.fn()]);
  const html = renderToStaticMarkup(<MemoryPage />);
  expect(html).toContain("喜欢简洁回答");
  expect(html).toContain("搜索语义记忆");
  expect(html).toContain("输入关键词查找相关记忆，或留空查看记忆列表。");
});
