import { CheckCircle2, Clock3, KeyRound, LockKeyhole, Search, Wrench } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { loadTools, saveTools, type AgentTool, type ToolsCatalog } from "../agent-api";
import { PageHeading } from "./PageHeading";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "./ui/alert-dialog";

/** 展示 Agent 的真实工具目录，并管理允许用户修改的工具开关与凭证。 */
export function ToolsPage() {
  const [catalog, setCatalog] = useState<ToolsCatalog | null>(null);
  const [getCurrentTimeEnabled, setGetCurrentTimeEnabled] = useState(true);
  const [searchWebEnabled, setSearchWebEnabled] = useState(false);
  const [tavilyApiKey, setTavilyApiKey] = useState("");
  const [tavilyDialogOpen, setTavilyDialogOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
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
    setCatalog(next);
    setGetCurrentTimeEnabled(next.tools.find((tool) => tool.name === "get_current_time")?.enabled ?? true);
    setSearchWebEnabled(next.tools.find((tool) => tool.name === "search_web")?.enabled ?? false);
    setTavilyApiKey("");
  }

  async function persist({
    nextGetCurrentTimeEnabled = getCurrentTimeEnabled,
    nextSearchWebEnabled = searchWebEnabled,
    clearTavilyApiKey = false,
    closeDialog = false,
  }: {
    nextGetCurrentTimeEnabled?: boolean;
    nextSearchWebEnabled?: boolean;
    clearTavilyApiKey?: boolean;
    closeDialog?: boolean;
  } = {}): Promise<boolean> {
    setSaving(true);
    setMessage("");
    setError("");
    try {
      const next = await saveTools({
        getCurrentTimeEnabled: nextGetCurrentTimeEnabled,
        searchWebEnabled: clearTavilyApiKey ? false : nextSearchWebEnabled,
        tavilyApiKey,
        clearTavilyApiKey,
      });
      applyCatalog(next);
      setMessage(clearTavilyApiKey ? "Tavily API Key 已清除，search_web 已停用。" : "工具配置已保存，下一回合立即生效。");
      if (closeDialog) setTavilyDialogOpen(false);
      return true;
    } catch (reason) {
      setError(errorMessage(reason));
      return false;
    } finally {
      setSaving(false);
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
    return tool;
  }

  return <div className="content-wrap tools-page">
    <PageHeading eyebrow="Agent 能力 / 受控执行" title="Tools" description="查看 Agent 当前可用的工具，并配置允许修改的能力。" />
    <div className="intro-note"><Wrench size={16} /><p><strong>工具注册表是运行时事实来源。</strong> 固定内置工具始终可用；开关保存在 <code>.everything/config.json</code>，Tavily 凭证保存在根目录 <code>.env</code>，密钥不会返回浏览器。</p></div>
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
              disabled={saving}
              onToggle={tool.name === "get_current_time" ? handleGetCurrentTimeToggle : tool.name === "search_web" ? handleSearchWebToggle : undefined}
              onConfigure={tool.name === "search_web" ? () => setTavilyDialogOpen(true) : undefined}
            />;
          })}
        </div>
      </section>)}
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
            <Button disabled={saving} onClick={() => void persist({ closeDialog: true })}>{saving ? "正在保存…" : "保存 Tavily 配置"}</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>}
  </div>;
}

function ToolCard({ tool, disabled = false, onToggle, onConfigure }: { tool: AgentTool; disabled?: boolean; onToggle?: (enabled: boolean) => void; onConfigure?: () => void }) {
  return <Card className={`tool-card ${tool.enabled ? "enabled" : "disabled"}`}>
    <CardHeader className="tool-card-header">
      <div className="tool-card-icon">{tool.name === "get_current_time" ? <Clock3 size={17} /> : tool.name === "search_web" ? <Search size={17} /> : <Wrench size={17} />}</div>
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
