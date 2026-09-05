import { AlertTriangle, Gauge, KeyRound, RotateCcw, Save, Server, ShieldCheck, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import {
  loadAgent,
  clearProviderApiKey,
  clearEmbeddingApiKey,
  clearAllAgentData,
  saveAgentConfig,
  resetRuntimeConfig,
  rebuildEmbeddingIndex,
  cancelEmbeddingIndexRebuild,
  type AgentProvider,
  type AgentSettings,
  type RetrievalMode,
} from "../agent-api";

export function ConfigPage() {
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [provider, setProvider] = useState<AgentProvider>("anthropic");
  const [model, setModel] = useState("");
  const [consolidationSessionInterval, setConsolidationSessionInterval] = useState(6);
  const [smallModel, setSmallModel] = useState("");
  const [sessionSearchWindow, setSessionSearchWindow] = useState(5);
  const [sessionScrollStep, setSessionScrollStep] = useState(10);
  const [sessionRecallMessageLimit, setSessionRecallMessageLimit] = useState(100);
  const [sessionRecallTokenLimit, setSessionRecallTokenLimit] = useState(8_192);
  const [modelContextWindow, setModelContextWindow] = useState(32_768);
  const [retrievalMode, setRetrievalMode] = useState<RetrievalMode>("lexical_only");
  const [embeddingBaseUrl, setEmbeddingBaseUrl] = useState("");
  const [embeddingModel, setEmbeddingModel] = useState("");
  const [embeddingQueryTemplate, setEmbeddingQueryTemplate] = useState("{text}");
  const [embeddingDocumentTemplate, setEmbeddingDocumentTemplate] = useState("{text}");
  const [embeddingMinimumSimilarity, setEmbeddingMinimumSimilarity] = useState(0.30);
  const [embeddingApiKey, setEmbeddingApiKey] = useState("");
  const [rebuildingEmbedding, setRebuildingEmbedding] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [clearingApiKey, setClearingApiKey] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [savingModel, setSavingModel] = useState(false);
  const [modelMessage, setModelMessage] = useState("");
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
    }).catch((error: unknown) => setModelMessage(error instanceof Error ? error.message : String(error)));
  }, []);

  async function saveModel(force = false) {
    setSavingModel(true);
    setModelMessage(force ? "正在强制保存…" : "正在保存并按需测试连接…");
    setForceAvailable(false);
    try {
      const result = await saveAgentConfig({
        provider, model, smallModel, baseUrl, apiKey, clearApiKey: false, force,
        consolidationSessionInterval, sessionSearchWindow, sessionScrollStep, sessionRecallMessageLimit,
        sessionRecallTokenLimit, modelContextWindow,
        retrievalMode, embeddingBaseUrl, embeddingModel,
        embeddingQueryTemplate, embeddingDocumentTemplate, embeddingMinimumSimilarity,
        embeddingApiKey, clearEmbeddingApiKey: false,
      });
      setSettings(result.settings);
      setModels(result.models);
      setApiKey("");
      setEmbeddingApiKey("");
      setModelMessage(result.models.length ? `保存成功，连接测试返回 ${result.models.length} 个模型。` : "保存成功，下一回合立即生效。");
    } catch (error) {
      const value = error as Error & { canForce?: boolean };
      setModelMessage(value.message);
      setForceAvailable(Boolean(value.canForce));
    } finally {
      setSavingModel(false);
    }
  }

  async function clearSavedApiKey() {
    if (!window.confirm(`确认清除 ${provider} 已保存的 API Key？清除后 Agent 将无法调用该 Provider，直到重新配置密钥。`)) return;
    setClearingApiKey(true);
    setModelMessage("正在清除 API Key…");
    try {
      const result = await clearProviderApiKey(provider);
      setSettings(result.settings);
      setApiKey("");
      setModelMessage("API Key 已清除。");
    } catch (error) {
      setModelMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setClearingApiKey(false);
    }
  }

  function applyRuntimeSettings(value: AgentSettings) {
    setSessionSearchWindow(value.sessionSearchWindow);
    setConsolidationSessionInterval(value.consolidationSessionInterval);
    setSessionScrollStep(value.sessionScrollStep);
    setSessionRecallMessageLimit(value.sessionRecallMessageLimit);
    setSessionRecallTokenLimit(value.sessionRecallTokenLimit);
    setModelContextWindow(value.modelContextWindow);
    setRetrievalMode(value.retrievalMode);
    setEmbeddingBaseUrl(value.embeddingBaseUrl);
    setEmbeddingModel(value.embeddingModel);
    setEmbeddingQueryTemplate(value.embeddingQueryTemplate);
    setEmbeddingDocumentTemplate(value.embeddingDocumentTemplate);
    setEmbeddingMinimumSimilarity(value.embeddingMinimumSimilarity);
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

  async function rebuildEmbeddings() {
    setRebuildingEmbedding(true);
    setModelMessage("正在串行建立影子向量索引…");
    try {
      const result = await rebuildEmbeddingIndex();
      setSettings(result.settings);
      setModelMessage(`索引已原子激活，共 ${result.result.chunkCount} 个 chunks。`);
    } catch (error) {
      setModelMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setRebuildingEmbedding(false);
    }
  }

  async function cancelRebuild() {
    const result = await cancelEmbeddingIndexRebuild();
    setModelMessage(result.cancelled ? "已请求取消，旧 active generation 保持可用。" : "当前没有正在运行的重建任务。");
  }

  async function clearSavedEmbeddingKey() {
    if (!window.confirm("确认清除独立 Embedding API Key？检索模式将回到 FTS5 + BM25。")) return;
    const result = await clearEmbeddingApiKey();
    setSettings(result.settings);
    applyRuntimeSettings(result.settings);
    setEmbeddingApiKey("");
    setModelMessage("Embedding API Key 已清除，检索模式已切回 lexical-only。");
  }

  return (
    <div className="content-wrap config-page">
      <div className="config-page-header">
        <div className="eyebrow">本地运行 / 安全配置</div>
        <h1>配置</h1>
        <p className="config-storage-warning">所有模型与运行配置仅保存在本项目的本地 <code>.env</code> 文件中，不会上传或同步至云端；保存后下一回合立即生效。</p>
      </div>
      <div className="config-grid">
        <section className="panel config-card config-settings-card">
          <div className="panel-header"><span><Server size={15} /> Agent 配置</span><span className="status-pill">热更新</span></div>
          <div className="config-settings-grid">
            <div className="config-section">
              <div className="config-section-heading"><Server size={16} /><div><strong>模型连接</strong><p>选择模型提供方，并配置访问凭证。</p></div></div>
              <label className="config-field">Provider
                <select value={provider} onChange={(event) => {
                  setProvider(event.target.value as AgentProvider);
                  setForceAvailable(false);
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
              {provider === "openai-compatible" && (
                <label className="config-field">Base URL
                  <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.openai.com/v1" />
                </label>
              )}
              <label className="config-field">API Key
                <span className="secret-label"><KeyRound size={13} /> {selectedKeyKnown && settings?.keyConfigured ? `已配置 ····${settings.keyLast4}` : selectedKeyKnown ? "尚未配置" : "切换后由服务端检测已保存的值"}</span>
                <input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={selectedKeyKnown && settings?.keyConfigured ? "留空以保留已保存的值" : "输入 API Key，或留空使用已保存的值"} />
              </label>
              <div className="security-note"><ShieldCheck size={15} /><span>API Key 仅写入本地 `.env`，不会由本项目上传或同步至云端；本地服务仅在调用所选模型提供商时使用，读取接口只返回配置状态与末四位。</span></div>
            </div>

            <div className="config-section">
              <div className="config-section-heading"><Gauge size={16} /><div><strong>Memory Retrieval</strong><p>Semantic Memory 与 Session Recall 共用检索模式，Dense 仅调用远程 OpenAI-compatible API。</p></div></div>
              <label className="config-field">Retrieval Mode
                <select value={retrievalMode} onChange={(event) => setRetrievalMode(event.target.value as RetrievalMode)}>
                  <option value="lexical_only">FTS5 + BM25</option>
                  <option value="dense_only">Dense</option>
                  <option value="hybrid">Hybrid（RRF + MMR）</option>
                </select>
              </label>
              <label className="config-field">Embedding Base URL
                <input value={embeddingBaseUrl} onChange={(event) => setEmbeddingBaseUrl(event.target.value)} placeholder="https://api.openai.com/v1" />
              </label>
              <label className="config-field">Embedding Model
                <input value={embeddingModel} onChange={(event) => setEmbeddingModel(event.target.value)} placeholder="text-embedding-3-large" />
                <span className="field-help">请求固定 dimensions=1024；模型不支持或返回其他维度时直接失败。</span>
              </label>
              <label className="config-field">Embedding API Key
                <span className="secret-label"><KeyRound size={13} /> {settings?.embeddingKeyConfigured ? `已配置 ····${settings.embeddingKeyLast4}` : "尚未配置"}</span>
                <input type="password" value={embeddingApiKey} onChange={(event) => setEmbeddingApiKey(event.target.value)} placeholder={settings?.embeddingKeyConfigured ? "留空保留已保存的独立密钥" : "输入独立 Embedding API Key"} />
              </label>
              <div className="security-note"><AlertTriangle size={15} /><span>配置 Embedding 后，Semantic Memory 与历史成功 run 的正文会发送到该远程服务；失败 run、工具调用和工具结果不会发送。</span></div>
              <label className="config-field">Query Template
                <input value={embeddingQueryTemplate} onChange={(event) => setEmbeddingQueryTemplate(event.target.value)} />
              </label>
              <label className="config-field">Document Template
                <input value={embeddingDocumentTemplate} onChange={(event) => setEmbeddingDocumentTemplate(event.target.value)} />
              </label>
              <label className="config-field">Minimum Similarity <span title="建议起点：OpenAI 0.30、BGE 0.45、Qwen3 0.50、GTE/Nomic 0.40、Multilingual-E5 0.80；需按数据校准。">?</span>
                <input type="number" min={-1} max={1} step={0.05} value={embeddingMinimumSimilarity} onChange={(event) => setEmbeddingMinimumSimilarity(Number(event.target.value))} />
              </label>
              <div className="security-note"><ShieldCheck size={15} /><span>向量索引状态：{settings?.embeddingIndex.ready
                ? `当前配置已就绪 · ${settings.embeddingIndex.generationId?.slice(0, 8)}`
                : settings?.embeddingIndex.generationId
                  ? `当前配置待重建 · 旧索引 ${settings.embeddingIndex.generationId.slice(0, 8)} 仍可用`
                  : "未建立"}。保存 profile 后需重建；失败不会替换旧索引。</span></div>
              {rebuildingEmbedding
                ? <button className="danger-ghost" onClick={() => void cancelRebuild()}><Trash2 size={14} /> 取消重建</button>
                : <button className="ghost-action" onClick={() => void rebuildEmbeddings()} disabled={!settings?.embeddingKeyConfigured || !embeddingModel}><RotateCcw size={14} /> 重建 Embedding 索引</button>}
              {settings?.embeddingKeyConfigured && <button className="danger-ghost" onClick={() => void clearSavedEmbeddingKey()}><Trash2 size={14} /> 清除 Embedding Key</button>}
            </div>

            <div className="config-section config-runtime-section">
              <div className="config-section-heading"><Gauge size={16} /><div><strong>运行参数</strong><p>控制记忆召回范围和模型上下文上限。</p></div></div>
              <label className="config-field">Session Search Window
                <input type="number" min={settings?.limits.sessionSearchWindow?.min ?? 1} max={settings?.limits.sessionSearchWindow?.max ?? 20} value={sessionSearchWindow} onChange={(event) => setSessionSearchWindow(Number(event.target.value))} />
                <span className="field-help">命中点初始单侧窗口，默认 5。</span>
              </label>
              <label>后台整理间隔（Session 数）
                <input type="number" min={1} max={100} value={consolidationSessionInterval} onChange={(event) => setConsolidationSessionInterval(Number(event.target.value))} />
                <small>默认积攒 6 个对话，在新建下一个对话时后台整理。</small>
              </label>
              <label className="config-field">Session Scroll Step
                <input type="number" min={settings?.limits.sessionScrollStep?.min ?? 1} max={settings?.limits.sessionScrollStep?.max ?? 50} value={sessionScrollStep} onChange={(event) => setSessionScrollStep(Number(event.target.value))} />
                <span className="field-help">每次完整扩窗的单侧增量，默认 10。</span>
              </label>
              <label className="config-field">Session Recall Message Limit
                <input type="number" min={settings?.limits.sessionRecallMessageLimit?.min ?? 1} max={settings?.limits.sessionRecallMessageLimit?.max ?? 200} value={sessionRecallMessageLimit} onChange={(event) => setSessionRecallMessageLimit(Number(event.target.value))} />
                <span className="field-help">单次 Session Recall 最多返回条目数，默认 100。</span>
              </label>
              <label className="config-field">Session Recall Token Limit
                <input type="number" min={settings?.limits.sessionRecallTokenLimit?.min ?? 256} max={settings?.limits.sessionRecallTokenLimit?.max ?? 131072} value={sessionRecallTokenLimit} onChange={(event) => setSessionRecallTokenLimit(Number(event.target.value))} />
                <span className="field-help">单次 Session Recall 的估算 token 预算，默认 8,192。</span>
              </label>
              <label className="config-field">Model Context Window（tokens）
                <input type="number" min={settings?.limits.modelContextWindow?.min ?? 4096} max={settings?.limits.modelContextWindow?.max ?? 2000000} value={modelContextWindow} onChange={(event) => setModelContextWindow(Number(event.target.value))} />
                <span className="field-help">输入按统一启发式规则估算；默认 32,768，并预留 2,048 output tokens 与 512-token 安全余量。</span>
              </label>
            </div>
          </div>
          <div className="config-save-bar">
            <div className="config-actions">
              <button className="primary-action" onClick={() => void saveModel(false)} disabled={savingModel || !model.trim()}><Save size={14} /> 保存配置</button>
              <button className="ghost-action" onClick={() => void resetRuntime()}><RotateCcw size={14} /> 恢复运行默认值</button>
              {selectedKeyKnown && settings?.keyConfigured && (
                <button className="danger-ghost" type="button" disabled={clearingApiKey} onClick={() => void clearSavedApiKey()}><Trash2 size={13} /> {clearingApiKey ? "正在清除…" : "清除 API Key"}</button>
              )}
              {forceAvailable && <button className="danger-ghost" onClick={() => void saveModel(true)} disabled={savingModel}>仍然保存</button>}
              <span>{modelMessage}</span>
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
