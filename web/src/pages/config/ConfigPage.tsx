import {
  AlertTriangle,
  BrainCircuit,
  Gauge,
  Info,
  KeyRound,
  RotateCcw,
  Save,
  Server,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  loadAgent,
  clearModelApiKey,
  clearEmbeddingApiKey,
  clearAllAgentData,
  saveAgentConfig,
  resetRuntimeConfig,
  rebuildEmbeddingIndex,
  cancelEmbeddingIndexRebuild,
  type AgentProvider,
  type AgentSettings,
  type RetrievalMode,
} from "../../agent-api";
import { withMinimumDuration } from "../../lib/minimum-duration";
import { SaveMessage } from "../../components/SaveMessage";
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../../components/ui/alert-dialog";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { PageHeading } from "../../components/PageHeading";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../../components/ui/tooltip";

type ConfigSection = "model" | "retrieval" | "runtime";
type NumericInputValue = number | "";

export function ConfigPage() {
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [agentProvider, setAgentProvider] =
    useState<AgentProvider>("anthropic");
  const [agentModel, setAgentModel] = useState("");
  const [agentBaseUrl, setAgentBaseUrl] = useState("");
  const [agentApiKey, setAgentApiKey] = useState("");
  const [smallProvider, setSmallProvider] =
    useState<AgentProvider>("anthropic");
  const [smallModel, setSmallModel] = useState("");
  const [smallBaseUrl, setSmallBaseUrl] = useState("");
  const [smallApiKey, setSmallApiKey] = useState("");
  const [sessionSearchWindow, setSessionSearchWindow] =
    useState<NumericInputValue>(5);
  const [sessionRecallMessageLimit, setSessionRecallMessageLimit] =
    useState<NumericInputValue>(100);
  const [sessionRecallTokenLimit, setSessionRecallTokenLimit] =
    useState<NumericInputValue>(32_768);
  const [maxTokens, setMaxTokens] = useState<NumericInputValue>(16_384);
  const [maxIterations, setMaxIterations] = useState<NumericInputValue>(50);
  const [modelContextWindow, setModelContextWindow] =
    useState<NumericInputValue>(131_072);
  const [retrievalMode, setRetrievalMode] =
    useState<RetrievalMode>("lexical_only");
  const [embeddingBaseUrl, setEmbeddingBaseUrl] = useState("");
  const [embeddingModel, setEmbeddingModel] = useState("");
  const [embeddingMinimumSimilarity, setEmbeddingMinimumSimilarity] =
    useState<NumericInputValue>(0.3);
  const [embeddingApiKey, setEmbeddingApiKey] = useState("");
  const [rebuildingEmbedding, setRebuildingEmbedding] = useState(false);
  const [clearingModelKeys, setClearingModelKeys] = useState(false);
  const [models, setModels] = useState<
    Record<"agentModel" | "smallModel", string[]>
  >({ agentModel: [], smallModel: [] });
  const [savingSection, setSavingSection] = useState<ConfigSection | null>(
    null,
  );
  const [saveMessage, setSaveMessage] = useState("");
  const [modelMessage, setModelMessage] = useState("");
  const [forceSection, setForceSection] = useState<ConfigSection | null>(null);
  const [resettingRuntime, setResettingRuntime] = useState(false);
  const [clearingData, setClearingData] = useState(false);
  const [clearMessage, setClearMessage] = useState("");
  const agentKeyKnown = settings?.agentModel.provider === agentProvider;
  const smallKeyKnown = settings?.smallModel.provider === smallProvider;
  useEffect(() => {
    loadAgent()
      .then((value) => {
        setSettings(value.settings);
        setAgentProvider(value.settings.agentModel.provider);
        setAgentModel(value.settings.agentModel.model);
        setAgentBaseUrl(value.settings.agentModel.baseUrl);
        setSmallProvider(value.settings.smallModel.provider);
        setSmallModel(value.settings.smallModel.model);
        setSmallBaseUrl(value.settings.smallModel.baseUrl);
        applyRuntimeInputs(value.settings);
        applyRetrievalInputs(value.settings);
      })
      .catch((error: unknown) =>
        setModelMessage(error instanceof Error ? error.message : String(error)),
      );
  }, []);
  async function saveSection(section: ConfigSection, force = false) {
    if (!settings) return;
    setSavingSection(section);
    setSaveMessage("");
    setModelMessage("");
    setForceSection(null);
    try {
      const result = await withMinimumDuration(() =>
        saveAgentConfig({
          agentModel:
            section === "model"
              ? {
                  provider: agentProvider,
                  model: agentModel,
                  baseUrl: agentBaseUrl,
                  apiKey: agentApiKey,
                  clearApiKey: false,
                }
              : savedModelInput(settings.agentModel),
          smallModel:
            section === "model"
              ? {
                  provider: smallProvider,
                  model: smallModel,
                  baseUrl: smallBaseUrl,
                  apiKey: smallApiKey,
                  clearApiKey: false,
                }
              : savedModelInput(settings.smallModel),
          force,
          sessionSearchWindow:
            section === "runtime"
              ? requiredNumericValue(
                  sessionSearchWindow,
                  "Session Search Window",
                )
              : settings.sessionSearchWindow,
          sessionRecallMessageLimit:
            section === "runtime"
              ? requiredNumericValue(
                  sessionRecallMessageLimit,
                  "Recall Message Limit",
                )
              : settings.sessionRecallMessageLimit,
          sessionRecallTokenLimit:
            section === "runtime"
              ? requiredNumericValue(
                  sessionRecallTokenLimit,
                  "Recall Token Limit",
                )
              : settings.sessionRecallTokenLimit,
          maxTokens: section === "runtime" ? requiredNumericValue(maxTokens, "单次模型输出") : settings.maxTokens,
          maxIterations: section === "runtime" ? requiredNumericValue(maxIterations, "Agent 最大迭代") : settings.maxIterations,
          modelContextWindow:
            section === "runtime"
              ? requiredNumericValue(modelContextWindow, "Model Context Window")
              : settings.modelContextWindow,
          retrievalMode:
            section === "retrieval" ? retrievalMode : settings.retrievalMode,
          embeddingBaseUrl:
            section === "retrieval"
              ? embeddingBaseUrl
              : settings.embeddingBaseUrl,
          embeddingModel:
            section === "retrieval" ? embeddingModel : settings.embeddingModel,
          embeddingQueryTemplate: settings.embeddingQueryTemplate,
          embeddingDocumentTemplate: settings.embeddingDocumentTemplate,
          embeddingMinimumSimilarity:
            section === "retrieval"
              ? requiredNumericValue(
                  embeddingMinimumSimilarity,
                  "Minimum Similarity",
                )
              : settings.embeddingMinimumSimilarity,
          embeddingApiKey: section === "retrieval" ? embeddingApiKey : "",
          clearEmbeddingApiKey: false,
        }),
      );
      setSettings(result.settings);
      if (section === "model") {
        setModels(result.models);
        setAgentApiKey("");
        setSmallApiKey("");
      }
      if (section === "retrieval") setEmbeddingApiKey("");
      setSaveMessage(`${sectionLabel(section)}保存成功，下一回合立即生效。`);
    } catch (error) {
      const value = error as Error & { canForce?: boolean };
      setModelMessage(value.message);
      setForceSection(value.canForce ? section : null);
    } finally {
      setSavingSection(null);
    }
  }

  async function clearSavedModelApiKeys() {
    setClearingModelKeys(true);
    setModelMessage("正在清除 API Key…");
    try {
      await withMinimumDuration(async () => {
        const agentResult = await clearModelApiKey("agentModel");
        setSettings(agentResult.settings);
        const smallResult = await clearModelApiKey("smallModel");
        setSettings(smallResult.settings);
        setAgentApiKey("");
        setSmallApiKey("");
        setModelMessage("模型连接 API Key 已清除。");
      });
    } catch (error) {
      setModelMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setClearingModelKeys(false);
    }
  }

  function applyRuntimeInputs(value: AgentSettings) {
    setSessionSearchWindow(value.sessionSearchWindow);
    setSessionRecallMessageLimit(value.sessionRecallMessageLimit);
    setSessionRecallTokenLimit(value.sessionRecallTokenLimit);
    setModelContextWindow(value.modelContextWindow);
    setMaxTokens(value.maxTokens);
    setMaxIterations(value.maxIterations);
  }

  function applyRetrievalInputs(value: AgentSettings) {
    setRetrievalMode(value.retrievalMode);
    setEmbeddingBaseUrl(value.embeddingBaseUrl);
    setEmbeddingModel(value.embeddingModel);
    setEmbeddingMinimumSimilarity(value.embeddingMinimumSimilarity);
  }

  async function resetRuntime() {
    setResettingRuntime(true);
    setSaveMessage("");
    setModelMessage("");
    try {
      const result = await withMinimumDuration(resetRuntimeConfig);
      setSettings(result.settings);
      applyRuntimeInputs(result.settings);
      setSaveMessage("运行配置已恢复默认值。");
    } catch (error) {
      setModelMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setResettingRuntime(false);
    }
  }

  async function clearAllData() {
    const shouldRebuildEmbeddings = Boolean(
      settings?.embeddingKeyConfigured &&
      settings.embeddingBaseUrl &&
      settings.embeddingModel,
    );
    setClearingData(true);
    setSaveMessage("");
    setClearMessage(
      shouldRebuildEmbeddings
        ? "正在清理本地数据，完成后将自动重建向量索引…"
        : "正在清理本地数据…",
    );
    try {
      const result = await withMinimumDuration(() =>
        clearAllAgentData(shouldRebuildEmbeddings),
      );
      if (result.embeddingRebuild) {
        setSettings(result.embeddingRebuild.settings);
        setClearMessage("");
        setSaveMessage(
          `清理完成，向量索引已自动重建并原子激活，共 ${result.embeddingRebuild.result.chunkCount} 个 chunks。EVERYTHING.md、Skills、config.json 和根目录 .env 密钥已保留。`,
        );
      } else {
        setClearMessage("");
        setSaveMessage(
          "清理完成。数据库、会话、记忆和运行记录已删除，EVERYTHING.md、Skills、config.json 和根目录 .env 密钥已保留。",
        );
      }
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
      const result = await withMinimumDuration(rebuildEmbeddingIndex);
      setSettings(result.settings);
      setModelMessage(
        `索引已原子激活，共 ${result.result.chunkCount} 个 chunks。`,
      );
    } catch (error) {
      setModelMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setRebuildingEmbedding(false);
    }
  }

  async function cancelRebuild() {
    const result = await cancelEmbeddingIndexRebuild();
    setModelMessage(
      result.cancelled
        ? "已请求取消，旧 active generation 保持可用。"
        : "当前没有正在运行的重建任务。",
    );
  }

  async function clearSavedEmbeddingKey() {
    const result = await clearEmbeddingApiKey();
    setSettings(result.settings);
    setRetrievalMode(result.settings.retrievalMode);
    setEmbeddingApiKey("");
    setModelMessage("Embedding API Key 已清除，检索模式已切回 lexical-only。");
  }

  if (!settings) {
    return (
      <div className="content-wrap config-page">
        <PageHeading
          eyebrow="本地运行 / 安全配置"
          title="配置中心"
          description="管理模型连接、记忆检索与运行边界。"
        />
        <div
          className={`panel ${modelMessage ? "error-panel" : "loading-panel"}`}
          role={modelMessage ? "alert" : "status"}
        >
          {modelMessage ? `配置加载失败：${modelMessage}` : "正在加载配置…"}
        </div>
      </div>
    );
  }

  return (
    <div className="content-wrap config-page">
      <PageHeading
        eyebrow="本地运行 / 安全配置"
        title="配置中心"
        description="管理模型连接、记忆检索与运行边界。"
      />
      <SaveMessage message={saveMessage} setMessage={setSaveMessage} />
      <Alert variant="info" className="config-local-alert">
        <ShieldCheck />
        <AlertTitle className="flex items-center gap-2">
          配置仅存储在当前项目中，不会上传或共享
          <Badge variant="success">
            <ShieldCheck size={12} />
            仅存储在本地
          </Badge>
        </AlertTitle>
        <AlertDescription>
          普通配置保存在 <code>.everything/config.json</code>，API Key
          保存在根目录 <code>.env</code>；保存后下一回合立即生效。
        </AlertDescription>
      </Alert>

      <div className="config-grid">
        <Card className="config-card config-model-card">
          <CardHeader className="config-card-header">
            <div className="config-card-icon">
              <Server size={18} />
            </div>
            <div>
              <CardTitle>模型连接</CardTitle>
              <CardDescription>
                Agent Model 与 Small Model 使用完全独立的连接配置。
              </CardDescription>
            </div>
            <Badge variant="outline">热更新</Badge>
          </CardHeader>
          <CardContent className="config-card-content">
            <div className="config-form-grid">
              <div className="config-field-wide">
                <strong>Agent Model</strong>
                <span className="field-help">
                  负责主 Agent 推理、工具调用、记忆写入与 consolidation。
                </span>
              </div>
              <ConfigField label="Provider">
                <Select
                  value={agentProvider}
                  onValueChange={(value) => {
                    setAgentProvider(value as AgentProvider);
                    setForceSection(null);
                  }}
                >
                  <SelectTrigger aria-label="Agent Model Provider">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="anthropic">Anthropic</SelectItem>
                    <SelectItem value="openai-compatible">
                      OpenAI Compatible
                    </SelectItem>
                  </SelectContent>
                </Select>
              </ConfigField>
              <ConfigField label="Model">
                <Input
                  value={agentModel}
                  onChange={(event) => setAgentModel(event.target.value)}
                  list="agent-model-list"
                  placeholder="输入 Agent 模型 ID"
                />
                <datalist id="agent-model-list">
                  {models.agentModel.map((value) => (
                    <option key={value} value={value} />
                  ))}
                </datalist>
              </ConfigField>
              <ConfigField label="Base URL">
                <Input
                  value={agentBaseUrl}
                  onChange={(event) => setAgentBaseUrl(event.target.value)}
                  placeholder={
                    agentProvider === "anthropic"
                      ? "https://api.anthropic.com"
                      : "https://api.openai.com/v1"
                  }
                />
              </ConfigField>
              <ConfigField
                label="API Key"
                help={
                  agentKeyKnown && settings?.agentModel.keyConfigured
                    ? `已配置 ····${settings.agentModel.keyLast4}`
                    : "尚未配置"
                }
                icon={<KeyRound size={13} />}
              >
                <Input
                  type="password"
                  value={agentApiKey}
                  onChange={(event) => setAgentApiKey(event.target.value)}
                  placeholder={
                    agentKeyKnown && settings?.agentModel.keyConfigured
                      ? "留空以保留已保存的值"
                      : "输入 Agent Model API Key"
                  }
                />
              </ConfigField>
              <div className="config-field-wide">
                <strong>Small Model</strong>
                <span className="field-help">仅负责 retrieval gate。</span>
              </div>
              <ConfigField label="Provider">
                <Select
                  value={smallProvider}
                  onValueChange={(value) => {
                    setSmallProvider(value as AgentProvider);
                    setForceSection(null);
                  }}
                >
                  <SelectTrigger aria-label="Small Model Provider">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="anthropic">Anthropic</SelectItem>
                    <SelectItem value="openai-compatible">
                      OpenAI Compatible
                    </SelectItem>
                  </SelectContent>
                </Select>
              </ConfigField>
              <ConfigField label="Model">
                <Input
                  value={smallModel}
                  onChange={(event) => setSmallModel(event.target.value)}
                  list="small-model-list"
                  placeholder="输入 Small 模型 ID"
                />
                <datalist id="small-model-list">
                  {models.smallModel.map((value) => (
                    <option key={value} value={value} />
                  ))}
                </datalist>
              </ConfigField>
              <ConfigField label="Base URL">
                <Input
                  value={smallBaseUrl}
                  onChange={(event) => setSmallBaseUrl(event.target.value)}
                  placeholder={
                    smallProvider === "anthropic"
                      ? "https://api.anthropic.com"
                      : "https://api.openai.com/v1"
                  }
                />
              </ConfigField>
              <ConfigField
                label="API Key"
                help={
                  smallKeyKnown && settings?.smallModel.keyConfigured
                    ? `已配置 ····${settings.smallModel.keyLast4}`
                    : "尚未配置"
                }
                icon={<KeyRound size={13} />}
              >
                <Input
                  type="password"
                  value={smallApiKey}
                  onChange={(event) => setSmallApiKey(event.target.value)}
                  placeholder={
                    smallKeyKnown && settings?.smallModel.keyConfigured
                      ? "留空以保留已保存的值"
                      : "输入 Small Model API Key"
                  }
                />
              </ConfigField>
            </div>
            <div className="config-card-actions">
              <Button
                onClick={() => void saveSection("model")}
                loading={savingSection === "model"}
                disabled={
                  savingSection !== null ||
                  !settings ||
                  !agentModel.trim() ||
                  !smallModel.trim()
                }
              >
                <Save size={14} />
                保存模型连接配置
              </Button>
              {forceSection === "model" && (
                <Button
                  variant="destructive-outline"
                  onClick={() => void saveSection("model", true)}
                  disabled={savingSection !== null}
                >
                  仍然保存
                </Button>
              )}
              {(settings?.agentModel.keyConfigured ||
                settings?.smallModel.keyConfigured) && (
                <ModelKeysClearDialog
                  disabled={clearingModelKeys}
                  onConfirm={() => void clearSavedModelApiKeys()}
                />
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="config-card config-retrieval-card">
          <CardHeader className="config-card-header">
            <div className="config-card-icon">
              <BrainCircuit size={18} />
            </div>
            <div>
              <CardTitle>Memory Retrieval</CardTitle>
              <CardDescription>
                配置 Semantic Memory 的词法、向量或混合检索。
              </CardDescription>
            </div>
            <Badge
              variant={settings?.embeddingIndex.ready ? "success" : "outline"}
            >
              {settings?.embeddingIndex.ready ? "索引就绪" : "本地优先"}
            </Badge>
          </CardHeader>
          <CardContent className="config-card-content">
            <div className="config-form-grid">
              <ConfigField label="Retrieval Mode">
                <Select
                  value={retrievalMode}
                  onValueChange={(value) =>
                    setRetrievalMode(value as RetrievalMode)
                  }
                >
                  <SelectTrigger aria-label="Retrieval Mode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="lexical_only">FTS5 + BM25</SelectItem>
                    <SelectItem value="dense_only">Dense</SelectItem>
                    <SelectItem value="hybrid">Hybrid（RRF + MMR）</SelectItem>
                  </SelectContent>
                </Select>
              </ConfigField>
              <ConfigField
                label="Minimum Similarity"
                labelSuffix={<SimilarityHelp />}
              >
                <Input
                  type="number"
                  min={-1}
                  max={1}
                  step={0.05}
                  value={embeddingMinimumSimilarity}
                  onChange={(event) =>
                    setEmbeddingMinimumSimilarity(
                      parseNumericInput(event.target.value),
                    )
                  }
                />
              </ConfigField>
              <ConfigField label="Embedding Base URL">
                <Input
                  value={embeddingBaseUrl}
                  onChange={(event) => setEmbeddingBaseUrl(event.target.value)}
                  placeholder="https://api.openai.com/v1"
                />
              </ConfigField>
              <ConfigField
                label="Embedding Model"
                help="请求固定 dimensions=1024；维度不一致时直接失败。"
              >
                <Input
                  value={embeddingModel}
                  onChange={(event) => setEmbeddingModel(event.target.value)}
                  placeholder="text-embedding-3-large"
                />
              </ConfigField>
              <ConfigField
                className="config-field-wide"
                label="Embedding API Key"
                help={
                  settings?.embeddingKeyConfigured
                    ? `已配置 ····${settings.embeddingKeyLast4}`
                    : "尚未配置"
                }
                icon={<KeyRound size={13} />}
              >
                <Input
                  type="password"
                  value={embeddingApiKey}
                  onChange={(event) => setEmbeddingApiKey(event.target.value)}
                  placeholder={
                    settings?.embeddingKeyConfigured
                      ? "留空保留已保存的独立密钥"
                      : "输入独立 Embedding API Key"
                  }
                />
              </ConfigField>
            </div>
            <Alert variant="warning" className="mt-5">
              <AlertTriangle />
              <AlertTitle>远程数据边界</AlertTitle>
              <AlertDescription>
                启用 Embedding 后，Semantic Memory
                正文会发送到对应远程服务；Session 历史不会生成向量。
              </AlertDescription>
            </Alert>
            <div className="config-index-status">
              <div className="config-index-copy">
                <strong>向量索引</strong>
                <span>
                  {settings?.embeddingIndex.ready
                    ? `当前配置已就绪 · ${settings.embeddingIndex.generationId?.slice(0, 8)}`
                    : settings?.embeddingIndex.generationId
                      ? `配置待重建 · 旧索引 ${settings.embeddingIndex.generationId.slice(0, 8)} 仍可用`
                      : "尚未建立索引"}
                </span>
              </div>
              <div className="config-index-action">
                <Button
                  size="sm"
                  onClick={() => void rebuildEmbeddings()}
                  loading={rebuildingEmbedding}
                  disabled={
                    clearingData ||
                    !settings?.embeddingKeyConfigured ||
                    !embeddingModel
                  }
                >
                  <RotateCcw size={14} />
                  重建索引
                </Button>
                {rebuildingEmbedding && (
                  <Button
                    variant="destructive-outline"
                    size="sm"
                    onClick={() => void cancelRebuild()}
                  >
                    <Trash2 size={14} />
                    取消重建
                  </Button>
                )}
              </div>
            </div>
            <div className="config-card-actions">
              <Button
                onClick={() => void saveSection("retrieval")}
                loading={savingSection === "retrieval"}
                disabled={
                  savingSection !== null ||
                  !settings ||
                  embeddingMinimumSimilarity === ""
                }
              >
                <Save size={14} />
                保存检索配置
              </Button>
              {settings?.embeddingKeyConfigured && (
                <EmbeddingKeyClearDialog
                  onConfirm={() => void clearSavedEmbeddingKey()}
                />
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="config-card config-runtime-card">
          <CardHeader className="config-card-header">
            <div className="config-card-icon">
              <Gauge size={18} />
            </div>
            <div>
              <CardTitle>运行参数</CardTitle>
              <CardDescription>
                控制会话召回范围和模型上下文预算。
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="config-card-content">
            <div className="config-runtime-grid">
              <ConfigField
                label="Session Search Window"
                help="命中点初始单侧窗口，默认 5。"
              >
                <Input
                  type="number"
                  min={settings?.limits.sessionSearchWindow?.min ?? 1}
                  max={settings?.limits.sessionSearchWindow?.max ?? 20}
                  value={sessionSearchWindow}
                  onChange={(event) =>
                    setSessionSearchWindow(
                      parseNumericInput(event.target.value),
                    )
                  }
                />
              </ConfigField>
              <ConfigField
                label="Recall Message Limit"
                help="单次最多返回条目数，默认 100。"
              >
                <Input
                  type="number"
                  min={settings?.limits.sessionRecallMessageLimit?.min ?? 1}
                  max={settings?.limits.sessionRecallMessageLimit?.max ?? 200}
                  value={sessionRecallMessageLimit}
                  onChange={(event) =>
                    setSessionRecallMessageLimit(
                      parseNumericInput(event.target.value),
                    )
                  }
                />
              </ConfigField>
              <ConfigField
                label="Recall Token Limit"
                help="估算 token 预算，默认 32,768。"
              >
                <Input
                  type="number"
                  min={settings?.limits.sessionRecallTokenLimit?.min ?? 256}
                  max={settings?.limits.sessionRecallTokenLimit?.max ?? 131072}
                  value={sessionRecallTokenLimit}
                  onChange={(event) =>
                    setSessionRecallTokenLimit(
                      parseNumericInput(event.target.value),
                    )
                  }
                />
              </ConfigField>
              <ConfigField label="单次模型输出（tokens）" help="默认 16,384 tokens，每次新运行生效。">
                <Input type="number" min={settings?.limits.maxTokens?.min ?? 1} max={settings?.limits.maxTokens?.max ?? 131072}
                  value={maxTokens} onChange={(event) => setMaxTokens(parseNumericInput(event.target.value))} />
              </ConfigField>
              <ConfigField label="Agent 最大迭代（轮）" help="默认 50 轮，每次新运行生效。">
                <Input type="number" min={settings?.limits.maxIterations?.min ?? 1} max={settings?.limits.maxIterations?.max ?? 1000}
                  value={maxIterations} onChange={(event) => setMaxIterations(parseNumericInput(event.target.value))} />
              </ConfigField>
              <ConfigField
                label="Model Context Window（tokens）"
                help="默认 131,072，需容纳输入、单次输出预算及 512 tokens 安全余量。"
              >
                <Input
                  type="number"
                  min={settings?.limits.modelContextWindow?.min ?? 4096}
                  max={settings?.limits.modelContextWindow?.max ?? 2000000}
                  value={modelContextWindow}
                  onChange={(event) =>
                    setModelContextWindow(parseNumericInput(event.target.value))
                  }
                />
              </ConfigField>
            </div>
            <div className="config-card-actions">
              <Button
                onClick={() => void saveSection("runtime")}
                loading={savingSection === "runtime"}
                disabled={
                  resettingRuntime ||
                  savingSection !== null ||
                  !settings ||
                  [
                    sessionSearchWindow,
                    sessionRecallMessageLimit,
                    sessionRecallTokenLimit,
                    modelContextWindow,
                    maxTokens,
                    maxIterations,
                  ].includes("")
                }
              >
                <Save size={14} />
                保存运行参数
              </Button>
              <Button
                variant="secondary"
                loading={resettingRuntime}
                disabled={savingSection !== null || !settings}
                onClick={() => void resetRuntime()}
              >
                <RotateCcw size={14} />
                恢复默认运行值
              </Button>
            </div>
          </CardContent>
        </Card>

        {modelMessage && (
          <Alert
            className="config-feedback"
            variant={forceSection ? "warning" : "default"}
          >
            <Info />
            <AlertDescription>{modelMessage}</AlertDescription>
          </Alert>
        )}

        <Card className="config-danger-card">
          <CardHeader className="config-card-header">
            <div className="config-card-icon danger">
              <AlertTriangle size={18} />
            </div>
            <div>
              <CardTitle>危险区域</CardTitle>
              <CardDescription>
                永久删除本地运行数据，此操作无法撤销。
              </CardDescription>
            </div>
            <Badge variant="destructive">不可撤销</Badge>
          </CardHeader>
          <CardContent className="config-danger-body">
            <div>
              <strong>清除全部本地数据</strong>
              <p>
                删除数据库、Session、Chat Log、Semantic Memory、Session Recall
                索引和全部 Traces。
                <br />
                保留 <code>.everything/EVERYTHING.md</code>、
                <code>.everything/skills</code>、
                <code>.everything/config.json</code> 和根目录 <code>.env</code>{" "}
                密钥。
              </p>
            </div>
            <AllDataClearDialog
              disabled={clearingData}
              onConfirm={() => void clearAllData()}
            />
            {clearMessage && (
              <span className="config-danger-message">{clearMessage}</span>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function parseNumericInput(value: string): NumericInputValue {
  return value === "" ? "" : Number(value);
}

function requiredNumericValue(value: NumericInputValue, label: string): number {
  if (value === "") throw new TypeError(`${label} 不能为空`);
  return value;
}

function savedModelInput(value: AgentSettings["agentModel"]) {
  return {
    provider: value.provider,
    model: value.model,
    baseUrl: value.baseUrl,
    apiKey: "",
    clearApiKey: false,
  };
}

function sectionLabel(section: ConfigSection): string {
  if (section === "model") return "模型连接配置";
  if (section === "retrieval") return "检索配置";
  return "运行参数";
}

function ConfigField({
  label,
  labelSuffix,
  help,
  icon,
  className = "",
  children,
}: {
  label: string;
  labelSuffix?: React.ReactNode;
  help?: string;
  icon?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={`config-field ${className}`}>
      <span className="config-field-label">
        {label}
        {labelSuffix}
      </span>
      {children}
      {help && (
        <span className="field-help">
          {icon}
          {help}
        </span>
      )}
    </label>
  );
}

function SimilarityHelp() {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="config-help"
            aria-label="最低相似度说明"
            aria-describedby="minimum-similarity-help"
          >
            ?
          </button>
        </TooltipTrigger>
        <TooltipContent id="minimum-similarity-help" role="tooltip">
          建议起点：OpenAI 0.30、BGE 0.45、Qwen3 0.50、GTE/Nomic
          0.40、Multilingual-E5 0.80；需按数据校准。
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function ModelKeysClearDialog({
  disabled,
  onConfirm,
}: {
  disabled: boolean;
  onConfirm(): void;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="destructive-outline" loading={disabled}>
          <Trash2 size={14} />
          清除 API Key
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>清除模型连接 API Key？</AlertDialogTitle>
          <AlertDialogDescription>
            Agent Model 与 Small Model 的 API Key
            都会被清除，其他连接配置保持不变。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>确认清除</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
function EmbeddingKeyClearDialog({ onConfirm }: { onConfirm(): void }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="destructive-outline">
          <Trash2 size={14} />
          清除 API Key
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>清除 Embedding API Key？</AlertDialogTitle>
          <AlertDialogDescription>
            检索模式将回到 FTS5 + BM25。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>确认清除</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
function AllDataClearDialog({
  disabled,
  onConfirm,
}: {
  disabled: boolean;
  onConfirm(): void;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="destructive-outline" loading={disabled}>
          <Trash2 size={14} />
          清除全部数据
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>永久清除全部本地数据？</AlertDialogTitle>
          <AlertDialogDescription>
            数据库、会话、记忆、索引和运行记录都会被删除。EVERYTHING.md、Skills、config.json
            与根目录 .env 密钥将保留；如已完整配置
            Embedding，清理后会自动重建向量索引。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>
            确认永久删除
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
