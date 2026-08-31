import { Node } from "./node.js";
import type { AnyState, StateRecord } from "./state.js";

type RouteFunction<TState extends StateRecord> = (
  state: Readonly<TState>,
) => string | Promise<string>;

interface Edge {
  source: string;
  target: string;
}

interface Router<TState extends StateRecord> {
  route: RouteFunction<TState>;
  targets: Record<string, string>;
}

/** `describe` 输出中的节点元数据。 */
export interface GraphNodeDescription {
  name: string;
  kind: Node["kind"];
  maxVisits: number;
}

/** `describe` 输出中的普通边或条件边。 */
export interface GraphEdgeDescription extends Edge {
  conditional: boolean;
}

/** 可序列化的静态 Graph 拓扑。 */
export interface GraphDescription {
  name: string;
  nodes: GraphNodeDescription[];
  edges: GraphEdgeDescription[];
}

export const START = "START";
export const END = "END";

/**
 * Graph 只负责声明拓扑；实际调度完全封装在 runGraph 中。
 * Map 保留节点声明顺序，这个顺序也会成为 wave 合并与 path 记录的稳定顺序。
 */
export class Graph<TState extends StateRecord = AnyState> {
  #nodes = new Map<string, Node<TState>>();
  #edges: Edge[] = [];
  #routers = new Map<string, Router<TState>>();
  readonly name: string;

  constructor(name: string) {
    if (!name || typeof name !== "string") {
      throw new TypeError("图名称必须是非空字符串");
    }
    this.name = name;
  }

  addNode(value: Node<TState>): this {
    if (!(value instanceof Node)) {
      throw new TypeError("addNode 只接受 Node 实例");
    }
    if (value.name === START || value.name === END) {
      throw new Error(`"${value.name}" 是保留名称`);
    }
    if (this.#nodes.has(value.name)) {
      throw new Error(`节点 "${value.name}" 已存在`);
    }

    this.#nodes.set(value.name, value);
    return this;
  }

  addEdge(source: string, target: string): this {
    // 拓扑错误在建图阶段暴露，避免工作流运行到一半才发现目标不存在。
    this.#assertEndpoint(source, true);
    this.#assertEndpoint(target, false);

    if (source === END) throw new Error("END 不能作为边的起点");
    if (target === START) throw new Error("START 不能作为边的终点");
    if (this.#edges.some((edge) => edge.source === source && edge.target === target)) {
      throw new Error(`边 "${source}" -> "${target}" 已存在`);
    }

    this.#edges.push({ source, target });
    return this;
  }

  addRouter(
    source: string,
    route: RouteFunction<TState>,
    targets: Record<string, string>,
  ): this {
    if (!this.#nodes.has(source)) {
      throw new Error(`未知路由节点 "${source}"`);
    }
    if (typeof route !== "function") {
      throw new TypeError(`节点 "${source}" 的 route 必须是函数`);
    }
    if (!targets || typeof targets !== "object" || Array.isArray(targets)) {
      throw new TypeError(`节点 "${source}" 的 targets 必须是对象`);
    }

    const entries = Object.entries(targets);
    if (entries.length === 0) {
      throw new Error(`节点 "${source}" 的路由目标不能为空`);
    }
    for (const [label, target] of entries) {
      if (!label) throw new Error("路由标签不能为空");
      this.#assertEndpoint(target, false);
      if (target === START) throw new Error("路由目标不能是 START");
    }

    // 复制 targets，防止调用方在建图后修改原对象，导致 describe 与运行漂移。
    this.#routers.set(source, { route, targets: { ...targets } });
    return this;
  }

  describe(): GraphDescription {
    return describe(this);
  }

  // 以下读取方法只服务于引擎实现，不向调用方暴露可变集合。
  getNode(name: string): Node<TState> | undefined {
    return this.#nodes.get(name);
  }

  nodeEntries(): [string, Node<TState>][] {
    return [...this.#nodes.entries()];
  }

  edges(): Edge[] {
    return this.#edges.map((edge) => ({ ...edge }));
  }

  routerFor(name: string): Router<TState> | undefined {
    const router = this.#routers.get(name);
    return router ? { route: router.route, targets: { ...router.targets } } : undefined;
  }

  routerEntries(): [string, Router<TState>][] {
    return [...this.#routers.entries()].map(([source, router]) => [
      source,
      { route: router.route, targets: { ...router.targets } },
    ]);
  }

  #assertEndpoint(name: string, allowStart: boolean): void {
    if (this.#nodes.has(name) || name === END || (allowStart && name === START)) return;
    throw new Error(`未知节点 "${name}"`);
  }
}

/**
 * 将实际拓扑转换为可序列化数据，供日志、调试器或 UI 使用。
 */
export function describe<TState extends StateRecord>(graph: Graph<TState>): GraphDescription {
  // 普通边与条件边使用同一数据结构，UI 无需理解路由函数本身。
  const edges = graph.edges().map(({ source, target }) => ({
    source,
    target,
    conditional: false,
  }));

  for (const [source, router] of graph.routerEntries()) {
    // 多个标签可通往同一节点；拓扑图只需画一条目标边。
    const uniqueTargets = [...new Set(Object.values(router.targets))];
    for (const target of uniqueTargets) {
      edges.push({ source, target, conditional: true });
    }
  }

  return {
    name: graph.name,
    nodes: graph.nodeEntries().map(([, value]) => ({
      name: value.name,
      kind: value.kind,
      maxVisits: value.maxVisits,
    })),
    edges,
  };
}
