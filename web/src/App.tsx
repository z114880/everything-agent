import { Activity, Bot, BookOpen, Brain, ChevronLeft, ChevronRight, Database, GitBranch, Settings, Sparkles, Wrench } from "lucide-react";
import { useState } from "react";
import { Button } from "./components/ui/button";
import { AgentPage } from "./pages/agent/AgentPage";
import { ConfigPage } from "./pages/config/ConfigPage";
import { DatabasePage } from "./pages/database/DatabasePage";
import { MemoryPage } from "./pages/memory/MemoryPage";
import { SkillsPage } from "./pages/skills/SkillsPage";
import { ToolsPage } from "./pages/tools/ToolsPage";
import { TracePage } from "./pages/trace/TracePage";
import { WorkflowPage } from "./pages/workflow/WorkflowPage";

type Page = "agent" | "workflow" | "skills" | "tools" | "memory" | "database" | "traces" | "config";

export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [page, setPage] = useState<Page>("agent");

  const pageContent = page === "agent"
    ? null
    : page === "config"
      ? <ConfigPage />
      : page === "skills"
        ? <SkillsPage />
        : page === "tools"
          ? <ToolsPage />
          : page === "memory"
            ? <MemoryPage />
            : page === "database"
              ? <DatabasePage />
              : page === "traces"
                ? <TracePage />
                : <WorkflowPage />;

  return (
    <div className="app-shell">
      <aside id="app-sidebar" className={`sidebar ${sidebarOpen ? "open" : "closed"}`}>
        <div className="brand-row">
          <div className="brand-mark"><Sparkles size={15} /></div>
          <div className="brand-copy"><strong>Everything Agent</strong><span>可视化Agent控制台</span></div>
          <Button variant="ghost" size="icon-sm" className="panel-collapse-toggle sidebar-toggle" onClick={() => setSidebarOpen(false)} aria-label="收起侧边栏" aria-expanded={sidebarOpen} aria-controls="app-sidebar"><ChevronLeft size={16} /></Button>
        </div>
        <Button variant="ghost" className={`nav-item ${page === "workflow" ? "active" : ""}`} onClick={() => setPage("workflow")}><GitBranch size={15} /><span>Workflow</span></Button>
        <div className="nav-divider" aria-hidden="true" />
        <Button variant="ghost" className={`nav-item mb-1 ${page === "agent" ? "active" : ""}`} onClick={() => setPage("agent")}><Bot size={15} /><span>Agent</span></Button>
        <Button variant="ghost" className={`nav-item mb-1 ${page === "skills" ? "active" : ""}`} onClick={() => setPage("skills")}><BookOpen size={15} /><span>Skills</span></Button>
        <Button variant="ghost" className={`nav-item mb-1 ${page === "tools" ? "active" : ""}`} onClick={() => setPage("tools")}><Wrench size={15} /><span>Tools</span></Button>
        <Button variant="ghost" className={`nav-item mb-1 ${page === "memory" ? "active" : ""}`} onClick={() => setPage("memory")}><Brain size={15} /><span>Memory</span></Button>
        <Button variant="ghost" className={`nav-item mb-1 ${page === "database" ? "active" : ""}`} onClick={() => setPage("database")}><Database size={15} /><span>Database</span></Button>
        <Button variant="ghost" className={`nav-item mb-1 ${page === "traces" ? "active" : ""}`} onClick={() => setPage("traces")}><Activity size={15} /><span>Trace</span></Button>
        <Button variant="ghost" className={`nav-item mb-1 ${page === "config" ? "active" : ""}`} onClick={() => setPage("config")}><Settings size={15} /><span>配置</span></Button>
        <div className="sidebar-note"><span className="signal bg-emerald-500" />本地 Engine 已连接</div>
      </aside>
      {!sidebarOpen && <Button variant="ghost" size="icon-sm" className="panel-collapse-toggle sidebar-reopen" onClick={() => setSidebarOpen(true)} aria-label="展开侧边栏" aria-expanded={sidebarOpen} aria-controls="app-sidebar"><ChevronRight size={16} /></Button>}

      {/* 页面导航只隐藏 Agent，保留运行请求、事件订阅和会话状态。 */}
      <main className="main-content agent-main-content" hidden={page !== "agent"}>
        <AgentPage active={page === "agent"} onOpenConfig={() => setPage("config")} />
      </main>
      {page !== "agent" && <main className="main-content">{pageContent}</main>}
    </div>
  );
}
