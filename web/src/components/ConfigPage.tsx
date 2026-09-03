import { FileText, KeyRound, Save, Server, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import {
  loadAgent,
  saveAgentConfig,
  saveSystemPrompt,
  type AgentProvider,
  type AgentSettings,
} from "../agent-api";

export function ConfigPage() {
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [provider, setProvider] = useState<AgentProvider>("anthropic");
  const [model, setModel] = useState("");
  const [smallModel, setSmallModel] = useState("");
  const [historyTurns, setHistoryTurns] = useState(10);
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
  const selectedKeyKnown = settings?.provider === provider;

  useEffect(() => {
    loadAgent().then((value) => {
      setSettings(value.settings);
      setProvider(value.settings.provider);
      setModel(value.settings.model);
      setSmallModel(value.settings.smallModel);
      setHistoryTurns(value.settings.historyTurns);
      setBaseUrl(value.settings.baseUrl);
      setSystemPrompt(value.systemPrompt);
    }).catch((error: unknown) => setModelMessage(error instanceof Error ? error.message : String(error)));
  }, []);

  async function saveModel(force = false) {
    setSavingModel(true);
    setModelMessage(force ? "正在强制保存…" : "正在保存并按需测试连接…");
    setForceAvailable(false);
    try {
      const result = await saveAgentConfig({ provider, model, smallModel, historyTurns, baseUrl, apiKey, clearApiKey, force });
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
            <label className="config-field">History Turns
              <input type="number" min={1} max={50} value={historyTurns} onChange={(event) => setHistoryTurns(Number(event.target.value))} />
              <span className="field-help">每次发送当前 Session 最近 1–50 个完整回合，默认 10。</span>
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
      </div>
    </div>
  );
}
