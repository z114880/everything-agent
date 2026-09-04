import { AlertTriangle, FileText, KeyRound, RotateCcw, Save, Server, ShieldCheck, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import {
  loadAgent,
  clearAllAgentData,
  saveAgentConfig,
  resetRuntimeConfig,
  saveSystemPrompt,
  type AgentProvider,
  type AgentSettings,
} from "../agent-api";

export function ConfigPage() {
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [provider, setProvider] = useState<AgentProvider>("anthropic");
  const [model, setModel] = useState("");
  const [smallModel, setSmallModel] = useState("");
  const [sessionSearchWindow, setSessionSearchWindow] = useState(5);
  const [sessionScrollStep, setSessionScrollStep] = useState(10);
  const [sessionRecallMessageLimit, setSessionRecallMessageLimit] = useState(100);
  const [sessionRecallCharacterLimit, setSessionRecallCharacterLimit] = useState(50_000);
  const [contextCharacterLimit, setContextCharacterLimit] = useState(200_000);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [clearApiKey, setClearApiKey] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [savingModel, setSavingModel] = useState(false);
  const [savingPrompt, setSavingPrompt] = useState(false);
  const [modelMessage, setModelMessage] = useState("");
  const [promptMessage, setPromptMessage] = useState("");
  const [forceAvailable, setForceAvailable] = useState(false);
  const [clearingData, setClearingData] = useState(false);
  const [clearMessage, setClearMessage] = useState("");
  const selectedKeyKnown = settings?.provider === provider;

  useEffect(() => {
    loadAgent().then((value) => {
      setSettings(value.settings);
      setProvider(value.settings.provider);
      setModel(value.settings.model);
      setSmallModel(value.settings.smallModel);
      applyRuntimeSettings(value.settings);
      setBaseUrl(value.settings.baseUrl);
      setSystemPrompt(value.systemPrompt);
    }).catch((error: unknown) => setModelMessage(error instanceof Error ? error.message : String(error)));
  }, []);

  async function saveModel(force = false) {
    setSavingModel(true);
    setModelMessage(force ? "正在强制保存…" : "正在保存并按需测试连接…");
    setForceAvailable(false);
    try {
      const result = await saveAgentConfig({
        provider, model, smallModel, baseUrl, apiKey, clearApiKey, force,
        sessionSearchWindow, sessionScrollStep, sessionRecallMessageLimit,
        sessionRecallCharacterLimit, contextCharacterLimit,
      });
      setSettings(result.settings);
      setModels(result.models);
      setApiKey("");
      setClearApiKey(false);
      setModelMessage(result.models.length ? `保存成功，连接测试返回 ${result.models.length} 个模型。` : "保存成功，下一回合立即生效。");
    } catch (error) {
      const value = error as Error & { canForce?: boolean };
      setModelMessage(value.message);
      setForceAvailable(Boolean(value.canForce));
    } finally {
      setSavingModel(false);
    }
  }

  function applyRuntimeSettings(value: AgentSettings) {
    setSessionSearchWindow(value.sessionSearchWindow);
    setSessionScrollStep(value.sessionScrollStep);
    setSessionRecallMessageLimit(value.sessionRecallMessageLimit);
    setSessionRecallCharacterLimit(value.sessionRecallCharacterLimit);
    setContextCharacterLimit(value.contextCharacterLimit);
  }

  async function resetRuntime() {
    try {
      const result = await resetRuntimeConfig();
      setSettings(result.settings);
      applyRuntimeSettings(result.settings);
      setModelMessage("运行配置已恢复默认值；模型连接和 EVERYTHING.md 未修改。");
    } catch (error) {
      setModelMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function savePrompt() {
    setSavingPrompt(true);
    setPromptMessage("正在更新 EVERYTHING.md…");
    try {
      const result = await saveSystemPrompt(systemPrompt);
      setSystemPrompt(result.systemPrompt);
      setPromptMessage("EVERYTHING.md 已保存，下一回合立即生效。");
    } catch (error) {
      setPromptMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingPrompt(false);
    }
  }

  async function clearAllData() {
    if (!window.confirm("确认清除全部记忆、会话、运行记录和数据库数据？此操作不可撤销，仅保留 EVERYTHING.md。")) return;
    setClearingData(true);
    setClearMessage("正在清理本地数据…");
    try {
      await clearAllAgentData();
      setClearMessage("清理完成。数据库、会话、记忆和运行记录已删除，EVERYTHING.md 已保留。");
    } catch (error) {
      setClearMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setClearingData(false);
    }
  }

  return (
    <div className="content-wrap config-page">
      <div className="config-page-header">
        <div className="eyebrow">本地运行 / 安全配置</div>
        <h1>配置</h1>
        <p>模型设置写入项目 <code>.env</code>；System Prompt 写入 <code>.everything/EVERYTHING.md</code>。</p>
      </div>
      <div className="config-grid">
        <section className="panel config-card">
          <div className="panel-header"><span><Server size={15} /> 模型提供方</span><span className="status-pill">热更新</span></div>
          <div className="config-card-body">
            <label className="config-field">Provider
              <select value={provider} onChange={(event) => {
                setProvider(event.target.value as AgentProvider);
                setForceAvailable(false);
                setClearApiKey(false);
              }}>
                <option value="anthropic">Anthropic</option>
                <option value="openai-compatible">OpenAI Compatible</option>
              </select>
            </label>
            <label className="config-field">Model
              <input value={model} onChange={(event) => setModel(event.target.value)} list="agent-model-list" placeholder="输入模型 ID" />
              <datalist id="agent-model-list">{models.map((value) => <option key={value} value={value} />)}</datalist>
            </label>
            <label className="config-field">Small Model
              <input value={smallModel} onChange={(event) => setSmallModel(event.target.value)} list="agent-model-list" placeholder="留空时使用主模型" />
              <span className="field-help">用于 retrieval gate 与 consolidation，复用当前 Provider 和密钥。</span>
            </label>
            <label className="config-field">Session Search Window
              <input type="number" min={settings?.limits.sessionSearchWindow?.min ?? 1} max={settings?.limits.sessionSearchWindow?.max ?? 20} value={sessionSearchWindow} onChange={(event) => setSessionSearchWindow(Number(event.target.value))} />
              <span className="field-help">命中点初始单侧窗口，默认 5。</span>
            </label>
            <label className="config-field">Session Scroll Step
              <input type="number" min={settings?.limits.sessionScrollStep?.min ?? 1} max={settings?.limits.sessionScrollStep?.max ?? 50} value={sessionScrollStep} onChange={(event) => setSessionScrollStep(Number(event.target.value))} />
              <span className="field-help">每次完整扩窗的单侧增量，默认 10。</span>
            </label>
            <label className="config-field">Session Recall Message Limit
              <input type="number" min={settings?.limits.sessionRecallMessageLimit?.min ?? 1} max={settings?.limits.sessionRecallMessageLimit?.max ?? 200} value={sessionRecallMessageLimit} onChange={(event) => setSessionRecallMessageLimit(Number(event.target.value))} />
              <span className="field-help">单次 Session Recall 最多返回条目数，默认 100。</span>
            </label>
            <label className="config-field">Session Recall Character Limit
              <input type="number" min={settings?.limits.sessionRecallCharacterLimit?.min ?? 1000} max={settings?.limits.sessionRecallCharacterLimit?.max ?? 100000} value={sessionRecallCharacterLimit} onChange={(event) => setSessionRecallCharacterLimit(Number(event.target.value))} />
              <span className="field-help">单次 Session Recall 最多返回字符数，默认 50,000。</span>
            </label>
            <label className="config-field">Context Limit（字符）
              <input type="number" min={settings?.limits.contextCharacterLimit?.min ?? 10000} max={settings?.limits.contextCharacterLimit?.max ?? 1000000} value={contextCharacterLimit} onChange={(event) => setContextCharacterLimit(Number(event.target.value))} />
              <span className="field-help">限制每次模型请求的完整输入。项目保持零运行时依赖且支持不同模型，无法可靠复用某一家模型的 tokenizer，因此不使用 token 作为限制单位。</span>
            </label>
            {provider === "openai-compatible" && (
              <label className="config-field">Base URL
                <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.openai.com/v1" />
              </label>
            )}
            <label className="config-field">API Key
              <span className="secret-label"><KeyRound size={13} /> {selectedKeyKnown && settings?.keyConfigured ? `已配置 ····${settings.keyLast4}` : selectedKeyKnown ? "尚未配置" : "切换后由服务端检测已保存的值"}</span>
              <input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={selectedKeyKnown && settings?.keyConfigured ? "留空以保留已保存的值" : "输入 API Key，或留空使用已保存的值"} />
            </label>
            {selectedKeyKnown && settings?.keyConfigured && (
              <label className="clear-secret"><input type="checkbox" checked={clearApiKey} onChange={(event) => setClearApiKey(event.target.checked)} /> 清除当前 Provider 保存的 API Key</label>
            )}
            <div className="config-actions">
              <button className="primary-action" onClick={() => void saveModel(false)} disabled={savingModel || !model.trim()}><Save size={14} /> 保存模型配置</button>
              <button className="ghost-action" onClick={() => void resetRuntime()}><RotateCcw size={14} /> 恢复运行默认值</button>
              {forceAvailable && <button className="danger-ghost" onClick={() => void saveModel(true)} disabled={savingModel}>仍然保存</button>}
              <span>{modelMessage}</span>
            </div>
            <div className="security-note"><ShieldCheck size={15} /><span>密钥仅写入本地 `.env`，读取接口只返回配置状态与末四位。</span></div>
          </div>
        </section>

        <section className="panel config-card system-prompt-card">
          <div className="panel-header"><span><FileText size={15} /> System Prompt</span><code>.everything/EVERYTHING.md</code></div>
          <div className="config-card-body">
            <textarea value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} aria-label="System Prompt" />
            <div className="config-actions">
              <button className="primary-action" onClick={() => void savePrompt()} disabled={savingPrompt || !systemPrompt.trim()}><Save size={14} /> 保存 System Prompt</button>
              <span>{promptMessage}</span>
            </div>
          </div>
        </section>

        <section className="panel config-card config-danger-card">
          <div className="panel-header"><span><AlertTriangle size={15} /> 数据清理</span><span className="status-pill">不可撤销</span></div>
          <div className="config-card-body config-danger-body">
            <div><strong>清除全部本地数据</strong><p>删除数据库、Session、Chat Log、Semantic Memory、Session Recall 索引和全部运行记录，仅保留 <code>.everything/EVERYTHING.md</code>。</p></div>
            <div className="config-danger-actions"><button className="danger-ghost" disabled={clearingData} onClick={() => void clearAllData()}><Trash2 size={14} /> {clearingData ? "正在清理…" : "一键清理"}</button>{clearMessage && <span>{clearMessage}</span>}</div>
          </div>
        </section>
      </div>
    </div>
  );
}
