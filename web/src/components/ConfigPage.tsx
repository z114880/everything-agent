import { AlertTriangle, BrainCircuit, Gauge, Info, KeyRound, RotateCcw, Save, Server, ShieldCheck, Trash2 } from "lucide-react";
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
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "./ui/alert-dialog";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";

export function ConfigPage() {
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [provider, setProvider] = useState<AgentProvider>("anthropic");
  const [model, setModel] = useState("");
  const [smallModel, setSmallModel] = useState("");
  const [sessionSearchWindow, setSessionSearchWindow] = useState(5);
  const [sessionScrollStep, setSessionScrollStep] = useState(10);
  const [sessionRecallMessageLimit, setSessionRecallMessageLimit] = useState(100);
  const [sessionRecallTokenLimit, setSessionRecallTokenLimit] = useState(8_192);
  const [modelContextWindow, setModelContextWindow] = useState(32_768);
  const [retrievalMode, setRetrievalMode] = useState<RetrievalMode>("lexical_only");
  const [embeddingBaseUrl, setEmbeddingBaseUrl] = useState("");
  const [embeddingModel, setEmbeddingModel] = useState("");
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
        sessionSearchWindow, sessionScrollStep, sessionRecallMessageLimit,
        sessionRecallTokenLimit, modelContextWindow,
        retrievalMode, embeddingBaseUrl, embeddingModel,
        embeddingQueryTemplate: "{text}", embeddingDocumentTemplate: "{text}", embeddingMinimumSimilarity,
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
    setSessionScrollStep(value.sessionScrollStep);
    setSessionRecallMessageLimit(value.sessionRecallMessageLimit);
    setSessionRecallTokenLimit(value.sessionRecallTokenLimit);
    setModelContextWindow(value.modelContextWindow);
    setRetrievalMode(value.retrievalMode);
    setEmbeddingBaseUrl(value.embeddingBaseUrl);
    setEmbeddingModel(value.embeddingModel);
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
    setClearingData(true);
    setClearMessage("正在清理本地数据…");
    try {
      await clearAllAgentData();
      setClearMessage("清理完成。数据库、会话、记忆和运行记录已删除，EVERYTHING.md 和 .env 配置已保留。");
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
    const result = await clearEmbeddingApiKey();
    setSettings(result.settings);
    applyRuntimeSettings(result.settings);
    setEmbeddingApiKey("");
    setModelMessage("Embedding API Key 已清除，检索模式已切回 lexical-only。");
  }

  return (
    <div className="content-wrap config-page">
      <div className="config-page-header">
        <div>
          <div className="eyebrow">本地运行 / 安全配置</div>
          <h1>配置中心</h1>
          <p>管理模型连接、记忆检索与运行边界。</p>
        </div>
        <Badge variant="success"><ShieldCheck size={12} />仅存储在本地</Badge>
      </div>
      <Alert variant="info" className="config-local-alert">
        <ShieldCheck />
        <AlertTitle>配置不会离开当前项目</AlertTitle>
        <AlertDescription>模型与运行配置保存在本地 <code>.env</code> 文件中；保存后下一回合立即生效。</AlertDescription>
      </Alert>

      <div className="config-grid">
        <Card className="config-card config-model-card">
          <CardHeader className="config-card-header">
            <div className="config-card-icon"><Server size={18} /></div>
            <div><CardTitle>模型连接</CardTitle><CardDescription>选择模型提供方，并配置主模型和访问凭证。</CardDescription></div>
            <Badge variant="outline">热更新</Badge>
          </CardHeader>
          <CardContent className="config-card-content">
            <div className="config-form-grid">
              <ConfigField label="Provider">
                <Select value={provider} onValueChange={(value) => { setProvider(value as AgentProvider); setForceAvailable(false); }}>
                  <SelectTrigger aria-label="Provider"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="anthropic">Anthropic</SelectItem><SelectItem value="openai-compatible">OpenAI Compatible</SelectItem></SelectContent>
                </Select>
              </ConfigField>
              <ConfigField label="Model">
                <Input value={model} onChange={(event) => setModel(event.target.value)} list="agent-model-list" placeholder="输入模型 ID" />
                <datalist id="agent-model-list">{models.map((value) => <option key={value} value={value} />)}</datalist>
              </ConfigField>
              <ConfigField label="Small Model" help="用于 retrieval gate 与 consolidation，复用当前 Provider 和密钥。">
                <Input value={smallModel} onChange={(event) => setSmallModel(event.target.value)} list="agent-model-list" placeholder="留空时使用主模型" />
              </ConfigField>
              {provider === "openai-compatible" && (
                <ConfigField label="Base URL"><Input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.openai.com/v1" /></ConfigField>
              )}
              <ConfigField className="config-field-wide" label="API Key" help={selectedKeyKnown && settings?.keyConfigured ? `已配置 ····${settings.keyLast4}` : selectedKeyKnown ? "尚未配置" : "切换 Provider 后由服务端检测已保存的值"} icon={<KeyRound size={13} />}>
                <Input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={selectedKeyKnown && settings?.keyConfigured ? "留空以保留已保存的值" : "输入 API Key，或留空使用已保存的值"} />
              </ConfigField>
            </div>
            {selectedKeyKnown && settings?.keyConfigured && <div className="config-card-actions"><ApiKeyClearDialog provider={provider} disabled={clearingApiKey} onConfirm={() => void clearSavedApiKey()} /></div>}
          </CardContent>
        </Card>

        <Card className="config-card config-retrieval-card">
          <CardHeader className="config-card-header">
            <div className="config-card-icon"><BrainCircuit size={18} /></div>
            <div><CardTitle>Memory Retrieval</CardTitle><CardDescription>配置 Semantic Memory 的词法、向量或混合检索。</CardDescription></div>
            <Badge variant={settings?.embeddingIndex.ready ? "success" : "outline"}>{settings?.embeddingIndex.ready ? "索引就绪" : "本地优先"}</Badge>
          </CardHeader>
          <CardContent className="config-card-content">
            <div className="config-form-grid">
              <ConfigField label="Retrieval Mode">
                <Select value={retrievalMode} onValueChange={(value) => setRetrievalMode(value as RetrievalMode)}>
                  <SelectTrigger aria-label="Retrieval Mode"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="lexical_only">FTS5 + BM25</SelectItem><SelectItem value="dense_only">Dense</SelectItem><SelectItem value="hybrid">Hybrid（RRF + MMR）</SelectItem></SelectContent>
                </Select>
              </ConfigField>
              <ConfigField label="Minimum Similarity" labelSuffix={<SimilarityHelp />}>
                <Input type="number" min={-1} max={1} step={0.05} value={embeddingMinimumSimilarity} onChange={(event) => setEmbeddingMinimumSimilarity(Number(event.target.value))} />
              </ConfigField>
              <ConfigField label="Embedding Base URL"><Input value={embeddingBaseUrl} onChange={(event) => setEmbeddingBaseUrl(event.target.value)} placeholder="https://api.openai.com/v1" /></ConfigField>
              <ConfigField label="Embedding Model" help="请求固定 dimensions=1024；维度不一致时直接失败。"><Input value={embeddingModel} onChange={(event) => setEmbeddingModel(event.target.value)} placeholder="text-embedding-3-large" /></ConfigField>
              <ConfigField className="config-field-wide" label="Embedding API Key" help={settings?.embeddingKeyConfigured ? `已配置 ····${settings.embeddingKeyLast4}` : "尚未配置"} icon={<KeyRound size={13} />}>
                <Input type="password" value={embeddingApiKey} onChange={(event) => setEmbeddingApiKey(event.target.value)} placeholder={settings?.embeddingKeyConfigured ? "留空保留已保存的独立密钥" : "输入独立 Embedding API Key"} />
              </ConfigField>
            </div>
            <Alert variant="warning" className="mt-5"><AlertTriangle /><AlertTitle>远程数据边界</AlertTitle><AlertDescription>启用 Embedding 后，Semantic Memory 正文会发送到对应远程服务；Session 历史不会生成向量。</AlertDescription></Alert>
            <div className="config-index-status">
              <div><strong>向量索引</strong><span>{settings?.embeddingIndex.ready
                ? `当前配置已就绪 · ${settings.embeddingIndex.generationId?.slice(0, 8)}`
                : settings?.embeddingIndex.generationId ? `配置待重建 · 旧索引 ${settings.embeddingIndex.generationId.slice(0, 8)} 仍可用` : "尚未建立索引"}</span></div>
              <div className="config-inline-actions">{rebuildingEmbedding
                ? <Button variant="destructive-outline" size="sm" onClick={() => void cancelRebuild()}><Trash2 size={14} />取消重建</Button>
                : <Button variant="outline" size="sm" onClick={() => void rebuildEmbeddings()} disabled={!settings?.embeddingKeyConfigured || !embeddingModel}><RotateCcw size={14} />重建索引</Button>}
                {settings?.embeddingKeyConfigured && <EmbeddingKeyClearDialog onConfirm={() => void clearSavedEmbeddingKey()} />}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="config-card config-runtime-card">
          <CardHeader className="config-card-header"><div className="config-card-icon"><Gauge size={18} /></div><div><CardTitle>运行参数</CardTitle><CardDescription>控制会话召回范围和模型上下文预算。</CardDescription></div></CardHeader>
          <CardContent className="config-card-content">
            <div className="config-runtime-grid">
              <ConfigField label="Session Search Window" help="命中点初始单侧窗口，默认 5。"><Input type="number" min={settings?.limits.sessionSearchWindow?.min ?? 1} max={settings?.limits.sessionSearchWindow?.max ?? 20} value={sessionSearchWindow} onChange={(event) => setSessionSearchWindow(Number(event.target.value))} /></ConfigField>
              <ConfigField label="Session Scroll Step" help="每次完整扩窗的单侧增量，默认 10。"><Input type="number" min={settings?.limits.sessionScrollStep?.min ?? 1} max={settings?.limits.sessionScrollStep?.max ?? 50} value={sessionScrollStep} onChange={(event) => setSessionScrollStep(Number(event.target.value))} /></ConfigField>
              <ConfigField label="Recall Message Limit" help="单次最多返回条目数，默认 100。"><Input type="number" min={settings?.limits.sessionRecallMessageLimit?.min ?? 1} max={settings?.limits.sessionRecallMessageLimit?.max ?? 200} value={sessionRecallMessageLimit} onChange={(event) => setSessionRecallMessageLimit(Number(event.target.value))} /></ConfigField>
              <ConfigField label="Recall Token Limit" help="估算 token 预算，默认 8,192。"><Input type="number" min={settings?.limits.sessionRecallTokenLimit?.min ?? 256} max={settings?.limits.sessionRecallTokenLimit?.max ?? 131072} value={sessionRecallTokenLimit} onChange={(event) => setSessionRecallTokenLimit(Number(event.target.value))} /></ConfigField>
              <ConfigField className="config-field-wide" label="Model Context Window（tokens）" help="默认 32,768，并预留 2,048 output tokens 与 512-token 安全余量。"><Input type="number" min={settings?.limits.modelContextWindow?.min ?? 4096} max={settings?.limits.modelContextWindow?.max ?? 2000000} value={modelContextWindow} onChange={(event) => setModelContextWindow(Number(event.target.value))} /></ConfigField>
            </div>
            <div className="config-card-actions"><Button variant="outline" onClick={() => void resetRuntime()}><RotateCcw size={14} />恢复运行默认值</Button></div>
          </CardContent>
        </Card>

        <div className="config-global-actions">
          <div><strong>保存配置</strong><span>模型连接、检索和运行参数将在下一回合统一生效。</span></div>
          <div className="config-inline-actions"><Button onClick={() => void saveModel(false)} disabled={savingModel || !model.trim()}><Save size={14} />{savingModel ? "正在保存…" : "保存全部配置"}</Button>{forceAvailable && <Button variant="destructive-outline" onClick={() => void saveModel(true)} disabled={savingModel}>仍然保存</Button>}</div>
        </div>

        {modelMessage && <Alert className="config-feedback" variant={forceAvailable ? "warning" : "default"}><Info /><AlertDescription>{modelMessage}</AlertDescription></Alert>}

        <Card className="config-danger-card">
          <CardHeader className="config-card-header"><div className="config-card-icon danger"><AlertTriangle size={18} /></div><div><CardTitle>危险区域</CardTitle><CardDescription>永久删除本地运行数据，此操作无法撤销。</CardDescription></div><Badge variant="destructive">不可撤销</Badge></CardHeader>
          <CardContent className="config-danger-body"><div><strong>清除全部本地数据</strong><p>删除数据库、Session、Chat Log、Semantic Memory、Session Recall 索引和全部运行记录，保留 <code>.everything/EVERYTHING.md</code> 和 <code>.env</code> 配置。</p></div><AllDataClearDialog disabled={clearingData} onConfirm={() => void clearAllData()} />{clearMessage && <span className="config-danger-message">{clearMessage}</span>}</CardContent>
        </Card>
      </div>
    </div>
  );
}

function ConfigField({ label, labelSuffix, help, icon, className = "", children }: { label: string; labelSuffix?: React.ReactNode; help?: string; icon?: React.ReactNode; className?: string; children: React.ReactNode }) {
  return <label className={`config-field ${className}`}><span className="config-field-label">{label}{labelSuffix}</span>{children}{help && <span className="field-help">{icon}{help}</span>}</label>;
}

function SimilarityHelp() {
  return <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" className="config-help" aria-label="最低相似度说明" aria-describedby="minimum-similarity-help">?</button></TooltipTrigger><TooltipContent id="minimum-similarity-help" role="tooltip">建议起点：OpenAI 0.30、BGE 0.45、Qwen3 0.50、GTE/Nomic 0.40、Multilingual-E5 0.80；需按数据校准。</TooltipContent></Tooltip></TooltipProvider>;
}

function ApiKeyClearDialog({ provider, disabled, onConfirm }: { provider: AgentProvider; disabled: boolean; onConfirm(): void }) {
  return <AlertDialog><AlertDialogTrigger asChild><Button variant="destructive-outline" disabled={disabled}><Trash2 size={14} />{disabled ? "正在清除…" : "清除 API Key"}</Button></AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>清除 {provider} API Key？</AlertDialogTitle><AlertDialogDescription>清除后 Agent 将无法调用该 Provider，直到重新配置密钥。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction onClick={onConfirm}>确认清除</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>;
}
function EmbeddingKeyClearDialog({ onConfirm }: { onConfirm(): void }) {
  return <AlertDialog><AlertDialogTrigger asChild><Button variant="destructive-outline" size="sm"><Trash2 size={14} />清除密钥</Button></AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>清除 Embedding API Key？</AlertDialogTitle><AlertDialogDescription>检索模式将回到 FTS5 + BM25。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction onClick={onConfirm}>确认清除</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>;
}
function AllDataClearDialog({ disabled, onConfirm }: { disabled: boolean; onConfirm(): void }) {
  return <AlertDialog><AlertDialogTrigger asChild><Button variant="destructive-outline" disabled={disabled}><Trash2 size={14} />{disabled ? "正在清理…" : "清除全部数据"}</Button></AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>永久清除全部本地数据？</AlertDialogTitle><AlertDialogDescription>数据库、会话、记忆、索引和运行记录都会被删除。EVERYTHING.md 与 .env 配置将保留。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction onClick={onConfirm}>确认永久删除</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>;
}
