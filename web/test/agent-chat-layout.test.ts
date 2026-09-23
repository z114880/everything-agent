import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylePath = fileURLToPath(new URL("../src/index.css", import.meta.url));

describe("Agent 会话窗口布局", () => {
  it("停止按钮保持发送按钮尺寸和文字，图标使用圆环包围实心方块", async () => {
    const source = await readFile(new URL("../src/pages/agent/AgentPage.tsx", import.meta.url), "utf8");
    const css = await readFile(stylePath, "utf8");
    expect(source).toContain('aria-label="停止生成"');
    expect(source).toContain('<CircleStop size={15} className="[&_rect]:fill-current" aria-hidden="true" /> 停止');
    expect(source).toMatch(/size="sm"\s+className="stop-agent"/);
    expect(css).not.toContain(".agent-composer-actions .stop-agent");
  });

  it("历史列表超出浮层高度时滚动，条目不收缩裁切标题和记录数", async () => {
    const css = await readFile(stylePath, "utf8");
    expect(ruleFor(css, ".session-list button")).toMatch(/flex-shrink:\s*0\s*;/);
    expect(ruleFor(css, ".session-list")).toMatch(/overflow-y:\s*auto\s*;/);
  });

  it("聊天区保持 420px 宽度且历史列表浮层不占据消息布局", async () => {
    const css = await readFile(stylePath, "utf8");
    expect(ruleFor(css, ".agent-page-layout")).toMatch(/grid-template-columns:\s*minmax\(var\(--agent-main-min-width\), 1fr\) 420px/);
    expect(ruleFor(css, ".agent-page-layout")).toMatch(/transition:\s*grid-template-columns 180ms ease/);
    expect(ruleFor(css, ".agent-chat-dock")).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\)/);
    expect(ruleFor(css, ".session-rail")).toMatch(/max-height:\s*220px/);
    expect(ruleFor(css, ".session-rail")).toMatch(/position:\s*absolute/);
    expect(css).not.toContain(".session-rail-collapsed");
    expect(ruleFor(css, ".session-rail[hidden]")).toMatch(/display:\s*none/);
  });

  it("主画布保持最小宽度，窗口更窄时改为布局整体横向滚动", async () => {
    const css = await readFile(stylePath, "utf8");

    expect(ruleFor(css, ".agent-page-layout")).toMatch(/--agent-main-min-width:\s*calc\(var\(--agent-canvas-min-width\) \+ 2 \* var\(--page-padding-inline\)\)/);
    expect(ruleFor(css, ".agent-page-layout")).toMatch(/overflow-x:\s*auto/);
    expect(ruleFor(css, ".agent-harness-svg")).toMatch(/min-width:\s*var\(--agent-canvas-min-width, 850px\)/);
    // 窄屏改为单列堆叠，最小宽度不再生效，画布沿用自身滚动容器。
    expect(css).toContain(".agent-page-layout { height: auto; min-height: 100vh; grid-template-columns: minmax(0, 1fr); }");
  });

  it("提供始终可用且标明展开状态的对话列表切换按钮", async () => {
    const source = compactSource(await readFile(new URL("../src/pages/agent/AgentPage.tsx", import.meta.url), "utf8"));
    expect(source).toContain('[sessionRailCollapsed, setSessionRailCollapsed] = useState(true)');
    expect(source).toContain('hidden={sessionRailCollapsed}');
    expect(source).not.toContain("当前 Session 全部完整回合进入上下文");
    expect(source).toContain('aria-label="消息内容"');
    expect(source.indexOf('className="new-session"')).toBeLessThan(source.indexOf('<div id="agent-session-rail"'));
    expect(source.indexOf('className="model-chip"')).toBeGreaterThan(source.indexOf('className="history-toggle"'));
    expect(source.indexOf('className="model-chip"')).toBeLessThan(source.indexOf('<div id="agent-session-rail"'));
    expect(source.indexOf('className="model-chip"')).toBeGreaterThan(source.indexOf('aria-label="删除会话"'));
    expect(source).not.toContain('composer-model-row');
    const railIndex = source.indexOf('<div id="agent-session-rail"');
    expect(railIndex).toBeGreaterThan(source.indexOf('<div className="agent-dock-header">'));
    expect(railIndex).toBeLessThan(source.indexOf('<div className="agent-chat-log"'));
    expect(source).toContain('aria-expanded={!sessionRailCollapsed}');
    expect(source).toContain('aria-controls="agent-session-rail"');
    expect(source).toContain('setSessionRailCollapsed((collapsed) => !collapsed)');
    expect(source).toContain('sessionRailCollapsed ? "展开对话列表" : "收起对话列表"');
    expect(source.indexOf('aria-controls="agent-session-rail"')).toBeGreaterThan(source.indexOf('<div className="chat-pane">'));
    expect(ruleFor(await readFile(stylePath, "utf8"), '.new-session:not(:disabled):hover')).toMatch(/background:\s*var\(--accent-soft\)/);
    expect(ruleFor(await readFile(stylePath, "utf8"), '.history-toggle:hover, .history-toggle[aria-expanded="true"]')).toMatch(/background:\s*var\(--accent-soft\)/);
  });

  it("新建对话与历史对话复用同一套按钮尺寸和排版", async () => {
    const source = await readFile(new URL("../src/pages/agent/AgentPage.tsx", import.meta.url), "utf8");
    const css = await readFile(stylePath, "utf8");

    expect(source.match(/session-toolbar-button/g)).toHaveLength(2);
    expect(ruleFor(css, ".session-toolbar-button")).toMatch(/min-height:\s*34px/);
    expect(ruleFor(css, ".session-toolbar-button")).toMatch(/padding:\s*0 10px/);
    expect(ruleFor(css, ".session-toolbar-button")).toMatch(/font-size:\s*12px/);
    expect(ruleFor(css, ".session-toolbar-button")).toMatch(/font-weight:\s*650/);
    expect(ruleFor(css, ".session-toolbar-button")).toMatch(/box-shadow:\s*none/);
  });

  it("新建对话不展示 loading，创建期间仍阻止重复请求", async () => {
    const source = await readFile(new URL("../src/pages/agent/AgentPage.tsx", import.meta.url), "utf8");

    expect(source).not.toContain("loading={creatingSession}");
    expect(source).not.toContain("setCreatingSession");
    expect(source).toContain("creatingSessionRef.current = true");
    expect(source).toContain("creatingSessionRef.current = false");
  });

  it("标题右侧保留编辑和删除，最右侧提供保留内容的收起入口", async () => {
    const source = await readFile(new URL("../src/pages/agent/AgentPage.tsx", import.meta.url), "utf8");
    const css = await readFile(stylePath, "utf8");
    const heading = source.indexOf('className="agent-session-heading"');
    expect(source.indexOf('aria-label="重命名会话"')).toBeGreaterThan(heading);
    expect(source.indexOf('aria-label="删除会话"')).toBeGreaterThan(heading);
    expect(source.indexOf('className="panel-collapse-toggle chat-collapse-toggle"')).toBeGreaterThan(heading);
    expect(source).toContain('aria-expanded={!chatCollapsed}');
    expect(source).toContain('aria-controls="agent-chat-content"');
    expect(source).toContain('hidden={chatCollapsed}');
    expect(source).toContain('setChatCollapsed((collapsed) => !collapsed)');
    expect(ruleFor(css, '.agent-chat-content[hidden]')).toMatch(/display:\s*none/);
    expect(ruleFor(css, '.agent-page-layout[data-chat-collapsed="true"]')).toMatch(/grid-template-columns:\s*minmax\(var\(--agent-main-min-width\), 1fr\) 0/);
    expect(ruleFor(css, '.agent-page-layout[data-chat-collapsed="true"] .agent-chat-dock')).toMatch(/border-left:\s*0/);
  });

  it("收起聊天区时按钮沿用展开时的落点，不在两个状态之间漂移", async () => {
    const css = await readFile(stylePath, "utf8");
    const collapsedHeader = ruleFor(css, '.agent-page-layout[data-chat-collapsed="true"] .agent-dock-header');

    // 贴视口定位保证横向滚动时按钮仍可点击，锚点取视口右上角。
    expect(ruleFor(css, ".agent-dock-header")).toMatch(/margin:\s*0 var\(--chat-inline-padding\)/);
    // 横向滚动条不能再撑出纵向滚动条，否则 Dock 右边界会离开视口边缘。
    expect(ruleFor(css, ".agent-page-layout")).toMatch(/overflow-x:\s*auto;\s*overflow-y:\s*hidden/);
    expect(collapsedHeader).toMatch(/position:\s*fixed/);
    expect(collapsedHeader).toMatch(/top:\s*0\s*;/);
    expect(collapsedHeader).toMatch(/right:\s*0\s*;/);
    // 收起时不再覆盖标题区的高度、内外边距与底边线，按钮纵向落点因此与展开时一致。
    expect(collapsedHeader).not.toMatch(/min-height/);
    expect(collapsedHeader).not.toMatch(/margin/);
    expect(collapsedHeader).not.toMatch(/padding/);
    expect(collapsedHeader).toMatch(/border-bottom-color:\s*transparent/);
    // 保持标题区原有的右对齐，不额外覆盖 auto 外边距。
    expect(ruleFor(css, ".chat-collapse-toggle")).toMatch(/margin-left:\s*auto/);
    expect(ruleFor(css, '.agent-page-layout[data-chat-collapsed="true"] .chat-collapse-toggle')).not.toMatch(/margin-left/);
    // 窄屏聊天区在画布下方，收起后按钮固定在视口右上角。
    expect(css).toContain('.agent-page-layout[data-chat-collapsed="true"] .agent-dock-header { top: 18px; right: 8px; min-height: 0; margin: 0; padding: 0; }');
  });

  it("让 Dock 收缩到视口内并把超长会话交给日志区域滚动", async () => {
    const css = await readFile(stylePath, "utf8");

    expect(ruleFor(css, ".agent-chat-dock")).toMatch(/min-height:\s*0\s*;/);
    expect(ruleFor(css, ".agent-chat-dock")).toMatch(/overflow:\s*hidden\s*;/);
    expect(ruleFor(css, ".agent-chat-log")).toMatch(/overflow-y:\s*auto\s*;/);
  });

  it("将整理操作收拢为带语义状态的紧凑控件", async () => {
    const source = compactSource(await readFile(new URL("../src/pages/agent/AgentPage.tsx", import.meta.url), "utf8"));
    const css = await readFile(stylePath, "utf8");

    expect(source).toContain('className="agent-intro-actions"');
    expect(source).toContain('className="consolidation-action" data-status={consolidationTone}');
    expect(source).toContain('className="consolidation-status" role="status"');
    expect(source).toContain('className="consolidation-button" variant="secondary"');
    expect(source).toContain('<RefreshCw size={13} aria-hidden="true" /> Consolidate');
    expect(source).toContain('result?.status === "skipped" && result.reason === "no_semantic_memory"');
    expect(source).toContain('setConsolidationStatus("暂无 Semantic Memory，无需整理")');
    expect(source).toContain('!bootstrap.settings.agentModel.keyConfigured || semanticCount === 0');
    expect(source.indexOf('className="agent-intro-actions"')).toBeGreaterThan(source.indexOf('title="Agent"'));
    expect(ruleFor(css, ".agent-intro-actions")).toMatch(/align-items:\s*center/);
    expect(ruleFor(css, ".consolidation-action")).toMatch(/display:\s*inline-flex/);
    expect(ruleFor(css, ".consolidation-action")).toMatch(/align-items:\s*center/);
    expect(ruleFor(css, '.consolidation-action[data-status="success"] .consolidation-status')).toMatch(/color:\s*#047857/);
    expect(ruleFor(css, '.consolidation-action[data-status="success"] .consolidation-status i')).toMatch(/background:\s*#10b981/);
    expect(ruleFor(css, '.consolidation-action[data-status="error"]')).toMatch(/border-color:\s*#efd7d4/);
    expect(ruleFor(css, ".consolidation-status i")).toMatch(/border-radius:\s*999px/);
  });

  it("切换到 Agent 时静默检查每日整理，不触发按钮动画", async () => {
    const source = compactSource(await readFile(new URL("../src/pages/agent/AgentPage.tsx", import.meta.url), "utf8"));

    expect(source).toContain('if (trigger === "manual") setConsolidating(true)');
    expect(source).toContain('trigger === "manual" ? await withMinimumDuration(task) : await task()');
    expect(source).toContain('await consolidate("daily")');
  });

  it("Agent 回复期间禁用发送时输入框仍保持白色", async () => {
    const css = await readFile(stylePath, "utf8");
    const disabledTextarea = ruleFor(css, ".agent-composer textarea:disabled");

    expect(disabledTextarea).toMatch(/background:\s*white\s*;/);
    expect(disabledTextarea).toMatch(/opacity:\s*1\s*;/);
  });

  it("首次进入 Agent 页面立即滚动到底部，后续消息保留平滑过渡", async () => {
    const source = await readFile(new URL("../src/pages/agent/AgentPage.tsx", import.meta.url), "utf8");

    expect(source).toContain("useLayoutEffect");
    expect(source).toContain('behavior: initialChatScrollRef.current ? "auto" : "smooth"');
    expect(source).toContain("initialChatScrollRef.current = false");
  });
});

function ruleFor(css: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
  expect(match, `缺少 ${selector} 样式规则`).not.toBeNull();
  return match?.[1] ?? "";
}

function compactSource(source: string): string {
  return source.replace(/\s+/g, " ");
}
