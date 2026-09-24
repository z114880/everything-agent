import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Graph, StateRecord } from "../../src/engine/src/index.ts";

/** 工作流模块的运行时契约；与开发环境的 ssrLoadModule 加载结果保持一致。 */
export interface WorkflowModule {
  graph: Graph<StateRecord>;
  createInitialState?: (input: string) => StateRecord | Promise<StateRecord>;
  maxSteps?: number;
}

/** 校验动态加载出的工作流模块，返回类型收窄后的结果。 */
export function assertWorkflowModule(value: unknown): WorkflowModule {
  const loaded = value as Partial<WorkflowModule> | null | undefined;
  if (!loaded?.graph || typeof loaded.graph.describe !== "function") {
    throw new Error("本地文件必须导出 graph（Graph 实例）");
  }
  if (loaded.createInitialState !== undefined && typeof loaded.createInitialState !== "function") {
    throw new Error("createInitialState 必须是函数");
  }
  if (loaded.maxSteps !== undefined && (!Number.isInteger(loaded.maxSteps) || loaded.maxSteps < 1)) {
    throw new Error("maxSteps 必须是正整数");
  }
  return loaded as WorkflowModule;
}

/** 工作流源码超过该长度时拒绝保存，避免一次性写入异常内容。 */
const MAX_WORKFLOW_SOURCE_LENGTH = 200_000;

/** 列出源码或构建目录中按名称排序的工作流模块。 */
export async function listWorkflowFiles(workflowDirectory: string, extension: ".ts" | ".js"): Promise<string[]> {
  const entries = await readdir(workflowDirectory, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension) && !entry.name.endsWith(".d.ts"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  if (files.length === 0) throw new Error("工作流目录中没有可用的工作流");
  return files;
}

/** 校验并解析页面请求的工作流文件名，默认回退到列表首项。 */
export function resolveWorkflowFile(value: unknown, files: readonly string[]): string {
  if (value === null || value === undefined || value === "") return files[0]!;
  if (typeof value !== "string" || !files.includes(value)) {
    throw new Error("工作流文件不存在或不在工作流目录中");
  }
  return value;
}

/** 读取工作流源码；调用方负责校验文件名合法。 */
export async function readWorkflowSource(workflowDirectory: string, file: string): Promise<string> {
  return readFile(join(workflowDirectory, file), "utf8");
}

/** 校验并写入工作流源码。 */
export async function writeWorkflowSource(workflowDirectory: string, file: string, source: unknown): Promise<void> {
  if (typeof source !== "string" || source.length > MAX_WORKFLOW_SOURCE_LENGTH) {
    throw new Error(`工作流源码必须是小于 ${MAX_WORKFLOW_SOURCE_LENGTH / 1000}KB 的字符串`);
  }
  await writeFile(join(workflowDirectory, file), source, "utf8");
}

/** 把 Graph 静态拓扑转换为页面展示所需的精简结构。 */
export function toWorkflow(graph: Graph<StateRecord>) {
  const description = graph.describe();
  return {
    name: description.name,
    nodes: description.nodes.map((value) => ({
      id: value.name,
      label: value.name,
      kind: value.kind,
      maxVisits: value.maxVisits,
    })),
    edges: description.edges,
  };
}

