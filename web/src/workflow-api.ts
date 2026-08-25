export type NodeKind = "fn" | "tool" | "llm" | "agent";

export interface WorkflowNode {
  id: string;
  label: string;
  kind: NodeKind;
  maxVisits: number;
}

export interface WorkflowEdge {
  source: string;
  target: string;
  conditional: boolean;
}

export interface Workflow {
  name: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface WaveNodeResult {
  id: string;
  ms: number;
  keys: string[];
  error?: string | null;
}

export interface WaveResult {
  index: number;
  nodes: WaveNodeResult[];
}

export interface GraphExecutionResult {
  state: Record<string, unknown>;
  path: string[];
  steps: number;
  status: "completed" | "failed" | "stalled";
  error: unknown | null;
  totalMs: number;
  waves: WaveResult[];
}

export interface GraphEvent {
  type: string;
  graph?: string;
  wave?: number;
  nodes?: string[];
  activatedEdges?: WorkflowEdge[];
  node?: string;
  target?: string;
  visit?: number;
  ms?: number;
  keys?: string[];
  error?: unknown;
  status?: string;
}

const endpoint = "/api/local-workflow";

/** 从工作区读取真实的 TypeScript 源码及 Graph.describe() 拓扑。 */
export async function loadLocalWorkflow(file?: string): Promise<{
  files: string[];
  selectedFile: string;
  source: string;
  workflow: Workflow;
}> {
  const query = file ? `?file=${encodeURIComponent(file)}` : "";
  return requestJson(`${endpoint}${query}`);
}

/** 把编辑器内容写回本地文件，成功时返回该文件生成的新拓扑。 */
export async function saveLocalWorkflow(file: string, source: string): Promise<{ workflow: Workflow }> {
  return requestJson(endpoint, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file, source }),
  });
}

/** 在本地 Node.js 进程执行 Engine，并逐行消费 observer 事件。 */
export async function runLocalWorkflow(
  file: string,
  input: string,
  onEvent: (kind: string, event: GraphEvent) => void,
): Promise<Omit<GraphExecutionResult, "waves">> {
  const response = await fetch(`${endpoint}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file, input }),
  });
  if (!response.ok || !response.body) throw new Error(await responseError(response));

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: Omit<GraphExecutionResult, "waves"> | null = null;

  const consumeLine = (line: string) => {
    if (!line.trim()) return;
    const message = JSON.parse(line) as {
      type: "event" | "result" | "error";
      kind?: string;
      event?: GraphEvent;
      result?: Omit<GraphExecutionResult, "waves">;
      error?: string;
    };
    if (message.type === "event" && message.kind && message.event) onEvent(message.kind, message.event);
    if (message.type === "result" && message.result) result = message.result;
    if (message.type === "error") throw new Error(message.error || "本地 Engine 执行失败");
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) consumeLine(line);
    if (done) break;
  }
  consumeLine(buffer);
  if (!result) throw new Error("本地 Engine 未返回执行结果");
  return result;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(await responseError(response));
  return response.json() as Promise<T>;
}

async function responseError(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const value = JSON.parse(text) as { error?: string };
    return value.error || text;
  } catch {
    return text || `请求失败（${response.status}）`;
  }
}
