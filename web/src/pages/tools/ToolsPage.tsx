import { CheckCircle2, Clock3, FolderTree, KeyRound, LockKeyhole, Search, Terminal, Wrench } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { loadTools, saveTools, type AgentTool, type ToolsCatalog } from "../../agent-api";
import { withMinimumDuration } from "../../lib/minimum-duration";
import { PageHeading } from "../../components/PageHeading";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "../../components/ui/alert-dialog";

/** 展示 Agent 的真实工具目录，并管理允许用户修改的工具开关与凭证。 */
export function ToolsPage() {
  const [catalog, setCatalog] = useState<ToolsCatalog | null>(null);
  const [getCurrentTimeEnabled, setGetCurrentTimeEnabled] = useState(true);
  const [searchWebEnabled, setSearchWebEnabled] = useState(false);
  const [tavilyApiKey, setTavilyApiKey] = useState("");
  const [tavilyDialogOpen, setTavilyDialogOpen] = useState(false);
  const [terminalEnabled, setTerminalEnabled] = useState(false);
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [terminalDialogOpen, setTerminalDialogOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [savingTools, setSavingTools] = useState<Set<string>>(new Set());
  const saving = savingTools.has("search_web");
  const savedCatalog = useRef<ToolsCatalog | null>(null);
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve());
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => { void reload(); }, []);
  useEffect(() => {
    if (!message) return;
    const timeout = window.setTimeout(() => setMessage(""), 2_500);
    return () => window.clearTimeout(timeout);
  }, [message]);

  const groups = useMemo(() => {
    const tools = catalog?.tools ?? [];
    return [
      { name: "内置工具", description: "随 Runtime 提供，不依赖外部服务。", tools: tools.filter((tool) => tool.origin === "内置") },
      { name: "外部集成", description: "通过本地凭证连接第三方只读服务。", tools: tools.filter((tool) => tool.origin !== "内置") },
    ];
  }, [catalog]);

  async function reload() {
    setLoading(true);
    setError("");
    try {
      applyCatalog(await loadTools());
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setLoading(false);
    }
  }

  function applyCatalog(next: ToolsCatalog) {
    savedCatalog.current = next;
    setCatalog(next);
    setGetCurrentTimeEnabled(next.tools.find((tool) => tool.name === "get_current_time")?.enabled ?? true);
    setSearchWebEnabled(next.tools.find((tool) => tool.name === "search_web")?.enabled ?? false);
    setTavilyApiKey("");
    setTerminalEnabled(next.tools.find((tool) => tool.name === "run_terminal")?.enabled ?? false);
    setWorkspaceRoot(next.terminal.workspaceRoot);
  }

  async function persist({
    nextGetCurrentTimeEnabled,
    nextSearchWebEnabled,
    nextTerminalEnabled,
    nextWorkspaceRoot,
    clearTavilyApiKey = false,
    closeDialog = false,
    closeTerminalDialog = false,
  }: {
    nextGetCurrentTimeEnabled?: boolean;
    nextSearchWebEnabled?: boolean;
    nextTerminalEnabled?: boolean;
    nextWorkspaceRoot?: string;
    clearTavilyApiKey?: boolean;
    closeDialog?: boolean;
    closeTerminalDialog?: boolean;
  } = {}): Promise<boolean> {
    const terminalChange = nextTerminalEnabled !== undefined || nextWorkspaceRoot !== undefined || closeTerminalDialog;
    const toolName = terminalChange
      ? "run_terminal"
      : nextGetCurrentTimeEnabled !== undefined ? "get_current_time" : "search_web";
    setSavingTools((current) => new Set(current).add(toolName));
    const previousSave = saveQueue.current;
    let release!: () => void;
    saveQueue.current = new Promise<void>((resolve) => { release = resolve; });
    setMessage("");
    setError("");
    try {
      // 接口保存完整配置：排队后读取最近成功结果，避免不同开关覆盖彼此。
      await previousSave;
      const current = savedCatalog.current;
      const next = await withMinimumDuration(() =>
        saveTools({
          getCurrentTimeEnabled: nextGetCurrentTimeEnabled ?? current?.tools.find((tool) => tool.name === "get_current_time")?.enabled ?? true,
          searchWebEnabled: clearTavilyApiKey ? false : nextSearchWebEnabled ?? (closeDialog ? searchWebEnabled : current?.tools.find((tool) => tool.name === "search_web")?.enabled ?? false),
          tavilyApiKey: toolName === "search_web" ? tavilyApiKey : "",
          clearTavilyApiKey,
          terminalEnabled: nextTerminalEnabled ?? (terminalChange ? terminalEnabled : undefined),
          terminalWorkspaceRoot: nextWorkspaceRoot ?? (terminalChange ? workspaceRoot : undefined),
        }),
      );
      savedCatalog.current = next;
      setCatalog(next);
      // 仅同步本次操作的工具，保留另一个开关尚未完成的用户操作。
      if (toolName === "run_terminal") {
        setTerminalEnabled(next.tools.find((tool) => tool.name === toolName)?.enabled ?? false);
        setWorkspaceRoot(next.terminal.workspaceRoot);
      } else if (toolName === "get_current_time") {
        setGetCurrentTimeEnabled(next.tools.find((tool) => tool.name === toolName)?.enabled ?? true);
      } else {
        setSearchWebEnabled(next.tools.find((tool) => tool.name === toolName)?.enabled ?? false);
        setTavilyApiKey("");
      }
      setMessage(clearTavilyApiKey ? "Tavily API Key 已清除，search_web 已停用。" : "工具配置已保存，下一回合立即生效。");
      if (closeDialog) setTavilyDialogOpen(false);
      if (closeTerminalDialog) setTerminalDialogOpen(false);
      return true;
    } catch (reason) {
      setError(errorMessage(reason));
      return false;
    } finally {
      setSavingTools((current) => {
        const next = new Set(current);
        next.delete(toolName);
        return next;
      });
      release();
    }
  }

  async function handleGetCurrentTimeToggle(enabled: boolean) {
    const previous = getCurrentTimeEnabled;
    setGetCurrentTimeEnabled(enabled);
    if (!await persist({ nextGetCurrentTimeEnabled: enabled })) setGetCurrentTimeEnabled(previous);
  }

  async function handleSearchWebToggle(enabled: boolean) {
    const previous = searchWebEnabled;
    setSearchWebEnabled(enabled);
    if (enabled && !catalog?.tavily.keyConfigured) {
      setTavilyDialogOpen(true);
      return;
    }
    if (!await persist({ nextSearchWebEnabled: enabled })) setSearchWebEnabled(previous);
  }

  async function handleTerminalToggle(enabled: boolean) {
    const previous = terminalEnabled;
    setTerminalEnabled(enabled);
    // 沙箱不可用或尚未指定工作区时，先让用户看到原因和输入框，不直接失败。
    if (enabled && (!workspaceRoot || catalog?.terminal.unavailableReason)) {
      setTerminalDialogOpen(true);
      return;
    }
    if (!await persist({ nextTerminalEnabled: enabled })) setTerminalEnabled(previous);
  }

  function handleTerminalDialogOpenChange(open: boolean) {
    setTerminalDialogOpen(open);
    if (!open) {
      setTerminalEnabled(catalog?.tools.find((tool) => tool.name === "run_terminal")?.enabled ?? false);
      setWorkspaceRoot(catalog?.terminal.workspaceRoot ?? "");
    }
  }

  function handleTavilyDialogOpenChange(open: boolean) {
    setTavilyDialogOpen(open);
    if (!open) {
      setTavilyApiKey("");
      if (!catalog?.tavily.keyConfigured) {
        setSearchWebEnabled(catalog?.tools.find((tool) => tool.name === "search_web")?.enabled ?? false);
      }
    }
  }

  function effectiveTool(tool: AgentTool): AgentTool {
    if (tool.name === "get_current_time") return { ...tool, enabled: getCurrentTimeEnabled };
    if (tool.name === "search_web") return { ...tool, enabled: searchWebEnabled, configured: Boolean(tavilyApiKey || catalog?.tavily.keyConfigured) };
    if (tool.name === "run_terminal") {
      return { ...tool, enabled: terminalEnabled, configured: Boolean(workspaceRoot) && !catalog?.terminal.unavailableReason };
    }
    return tool;
  }

  return <div className="content-wrap tools-page">
    <PageHeading eyebrow="Agent 能力 / 受控执行" title="Tools" description="查看 Agent 当前可用的工具，并配置允许修改的能力。" />
    <div className="intro-note"><Wrench size={16} /><p><strong>工具注册表是运行时事实来源。</strong> 固定内置工具始终可用；开关保存在 <code>.everything/config.json</code>，Tavily 凭证保存在 <code>.everything/.env</code>，密钥不会返回浏览器。</p></div>
    {message && <div className="tools-toast" role="status" aria-live="polite"><CheckCircle2 size={15} />{message}</div>}
    {error && <div className="error-message" role="alert">{error}</div>}
    {loading ? <div className="panel tools-loading">正在读取工具目录…</div> : <>
      {groups.map((group) => <section className="tools-section" key={group.name}>
        <div className="tools-section-heading"><div><h2>{group.name}</h2><p>{group.description}</p></div><Badge variant="outline">{group.tools.length} tools</Badge></div>
        <div className="tools-grid">
          {group.tools.map((rawTool) => {
            const tool = effectiveTool(rawTool);
            return <ToolCard
              key={tool.name}
              tool={tool}
              disabled={savingTools.has(tool.name)}
              onToggle={tool.name === "get_current_time"
                ? handleGetCurrentTimeToggle
                : tool.name === "search_web"
                  ? handleSearchWebToggle
                  : tool.name === "run_terminal" ? handleTerminalToggle : undefined}
              onConfigure={tool.name === "search_web"
                ? () => setTavilyDialogOpen(true)
                : tool.name === "run_terminal" ? () => setTerminalDialogOpen(true) : undefined}
            />;
          })}
        </div>
      </section>)}
      <AlertDialog open={terminalDialogOpen} onOpenChange={handleTerminalDialogOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>终端执行配置</AlertDialogTitle>
            <AlertDialogDescription>
              <code>run_terminal</code> 只能在这个工作区内写入，命令由操作系统沙箱约束。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="tavily-config-body">
            <label className="config-field">
              <span className="config-field-label">工作区根目录</span>
              <Input
                value={workspaceRoot}
                onChange={(event) => setWorkspaceRoot(event.target.value)}
                placeholder="/Users/you/project"
                autoComplete="off"
                spellCheck={false}
              />
              <span className="field-help">
                <FolderTree size={13} />必须是已存在目录的绝对路径；其中的 <code>.git</code> 与 <code>.everything</code> 不可写。
              </span>
            </label>
            <p className="field-help">
              {catalog?.terminal.unavailableReason
                ? `当前环境无法建立沙箱：${catalog.terminal.unavailableReason}`
                : `当前沙箱：${catalog?.terminal.sandboxKind ?? "未知"}。出站网络默认切断，放行需要逐次确认。`}
            </p>
            {error && <div className="error-message" role="alert">{error}</div>}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>取消</AlertDialogCancel>
            <Button
              loading={saving}
              disabled={Boolean(catalog?.terminal.unavailableReason)}
              onClick={() => void persist({ nextTerminalEnabled: true, nextWorkspaceRoot: workspaceRoot, closeTerminalDialog: true })}
            >
              保存并启用
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={tavilyDialogOpen} onOpenChange={handleTavilyDialogOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Tavily 配置</AlertDialogTitle>
            <AlertDialogDescription>为 <code>search_web</code> 配置只读网页搜索凭证，密钥只会保存在本机。</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="tavily-config-body">
            <label className="config-field"><span className="config-field-label">Tavily API Key</span><Input type="password" value={tavilyApiKey} onChange={(event) => setTavilyApiKey(event.target.value)} placeholder={catalog?.tavily.keyConfigured ? `已配置 ····${catalog.tavily.keyLast4}` : "tvly-…"} autoComplete="off" spellCheck={false} /><span className="field-help"><KeyRound size={13} />留空会保留已保存的密钥。</span></label>
            {error && <div className="error-message" role="alert">{error}</div>}
            <div className="tavily-config-actions"><a href="https://app.tavily.com" target="_blank" rel="noreferrer">获取 API Key</a>{catalog?.tavily.keyConfigured && <Button variant="destructive-outline" size="sm" disabled={saving} onClick={() => void persist({ clearTavilyApiKey: true, closeDialog: true })}>清除密钥</Button>}</div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>取消</AlertDialogCancel>
            <Button loading={saving} onClick={() => void persist({ closeDialog: true })}>保存 Tavily 配置</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>}
  </div>;
}

function ToolCard({ tool, disabled = false, onToggle, onConfigure }: { tool: AgentTool; disabled?: boolean; onToggle?: (enabled: boolean) => void; onConfigure?: () => void }) {
  return <Card className={`tool-card ${tool.enabled ? "enabled" : "disabled"}`}>
    <CardHeader className="tool-card-header">
      <div className="tool-card-icon">{tool.name === "get_current_time" ? <Clock3 size={17} /> : tool.name === "search_web" ? <Search size={17} /> : tool.name === "run_terminal" ? <Terminal size={17} /> : <Wrench size={17} />}</div>
      <div><CardTitle><code>{tool.name}</code></CardTitle><CardDescription>{tool.description}</CardDescription></div>
      {tool.configurable
        ? <button className="tool-switch" type="button" role="switch" aria-checked={tool.enabled} aria-label={`${tool.name} ${tool.enabled ? "已启用" : "已停用"}`} disabled={disabled} onClick={() => onToggle?.(!tool.enabled)}><span /></button>
        : <LockKeyhole className="tool-lock" size={15} aria-label="固定启用" />}
    </CardHeader>
    <CardContent className="tool-card-footer"><Badge variant={tool.enabled ? "success" : "outline"}>{tool.enabled ? "已启用" : "已停用"}</Badge>{onConfigure ? <button type="button" className="tool-configure" aria-label={`配置 ${tool.name}`} onClick={onConfigure}>{tool.configured && <CheckCircle2 size={12} />}{tool.configured ? "配置就绪" : "需要配置"}</button> : <span>{tool.configurable ? tool.configured ? <><CheckCircle2 size={12} /> 配置就绪</> : "需要配置" : "固定内置能力"}</span>}</CardContent>
  </Card>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
