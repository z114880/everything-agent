import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { readContextGauge } from "../src/context-gauge";
import type { ContextUsage } from "../src/agent-api";

function usage(estimatedInputTokens: number, overrides: Partial<ContextUsage> = {}): ContextUsage {
  return {
    contextWindow: 262_144,
    maxTokens: 8_192,
    contextSafetyTokens: 512,
    availableInputTokens: 253_440,
    estimatedInputTokens,
    ...overrides,
  };
}

describe("上下文水位圆环读数", () => {
  it("百分比按可用额度而不是整个 Context Window 计算", () => {
    // 可用额度已经扣掉输出预留与安全余量，与 Loop 的硬限制同口径。
    expect(readContextGauge(usage(126_720))).toMatchObject({ percent: 50, level: "normal" });
  });

  it.each([
    [0, "normal"],
    [177_407, "normal"],
    [177_408, "warn"],
    [228_095, "warn"],
    [228_096, "critical"],
  ])("已用 %i tokens 属于 %s 档", (estimated, level) => {
    expect(readContextGauge(usage(estimated))?.level).toBe(level);
  });

  it("超过额度时数字如实溢出，弧线封顶在一圈", () => {
    const reading = readContextGauge(usage(299_059));
    expect(reading?.percent).toBe(118);
    expect(reading?.arcRatio).toBe(1);
    expect(reading?.level).toBe("critical");
  });

  it("拿不到水位或额度非正数时不渲染，避免显示成 0%", () => {
    expect(readContextGauge(null)).toBeNull();
    expect(readContextGauge(usage(1_000, { availableInputTokens: 0 }))).toBeNull();
    expect(readContextGauge(usage(1_000, { availableInputTokens: -100 }))).toBeNull();
  });
});

describe("上下文水位圆环放置与配色", () => {
  it("位于发送按钮左侧，随会话切换与每轮结束重新估算", async () => {
    const source = (await readFile(new URL("../src/pages/agent/AgentPage.tsx", import.meta.url), "utf8"))
      .replace(/\s+/g, " ");

    const gauge = source.indexOf("<ContextGauge usage={contextUsage} />");
    expect(gauge).toBeGreaterThan(-1);
    expect(source.indexOf('className="send-agent"')).toBeGreaterThan(gauge);
    expect(source).toContain("loadContextUsage(activeSessionId)");
    expect(source).toContain("setContextUsageRevision((value) => value + 1)");
  });

  it("圆环紧凑展示，悬浮卡片提供使用比例与剩余额度", async () => {
    const component = await readFile(new URL("../src/components/ContextGauge.tsx", import.meta.url), "utf8");
    const css = await readFile(new URL("../src/index.css", import.meta.url), "utf8");
    expect(component).toContain("const SIZE = 18;");
    expect(component).toContain('tabIndex={0}');
    expect(component).toContain('<TooltipContent className="grid gap-0.5 border border-border bg-popover text-popover-foreground"');
    expect(css).not.toContain(".context-gauge-tooltip");
    expect(component).toContain("上下文窗口");
    expect(component).toContain("剩余");
    expect(ruleFor(css, ".context-gauge")).toMatch(/width:\s*24px/);
  });

  it("颜色只作用于弧线，圆环中心不显示数字", async () => {
    const css = await readFile(new URL("../src/index.css", import.meta.url), "utf8");

    expect(css).toContain("--warn: #b45309;");
    expect(ruleFor(css, ".context-gauge.level-warn .context-gauge-arc")).toMatch(/stroke:\s*var\(--warn\)/);
    expect(ruleFor(css, ".context-gauge.level-critical .context-gauge-arc")).toMatch(/stroke:\s*var\(--destructive\)/);
    const component = await readFile(new URL("../src/components/ContextGauge.tsx", import.meta.url), "utf8");
    expect(component).not.toContain("context-gauge-value");
    expect(component).toContain("aria-valuenow={reading.percent}");

  });
});

function ruleFor(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  expect(match, `缺少 ${selector} 样式规则`).not.toBeNull();
  return match?.[1] ?? "";
}
