import type { AnyState, StateRecord } from "./state.ts";

/** 节点的可视化分类，不改变调度行为。 */
export type NodeKind = "fn" | "tool" | "llm" | "agent";

/** 节点运行时可使用的受控上下文。 */
export interface NodeContext {
  emit(kind: string, event?: StateRecord): Promise<void>;
  graph: string;
  visit: number;
}

/** 节点构造选项。 */
export interface NodeOptions {
  kind?: NodeKind;
  maxVisits?: number;
  onError?: string | null;
}

/** 节点处理函数：只读状态快照换取状态增量。 */
export type NodeHandler<
  TState extends StateRecord = AnyState,
  TUpdate extends StateRecord = StateRecord,
> = (
  state: Readonly<TState>,
  context: NodeContext,
) => TUpdate | void | Promise<TUpdate | void>;

const NODE_KINDS = new Set<NodeKind>(["fn", "tool", "llm", "agent"]);

/**
 * 图中的最小执行单元：读取状态快照，返回需要合并的状态增量。
 *
 * kind 只用于 describe、日志和可视化，不改变执行行为；maxVisits 与
 * onError 则由 runGraph 读取，用来控制循环次数和失败后的恢复路径。
 */
export class Node<
  TState extends StateRecord = AnyState,
  TUpdate extends StateRecord = StateRecord,
> {
  readonly name: string;
  readonly handler: NodeHandler<TState, TUpdate>;
  readonly kind: NodeKind;
  readonly maxVisits: number;
  readonly onError: string | null;

  constructor(name: string, handler: NodeHandler<TState, TUpdate>, options: NodeOptions = {}) {
    if (!name || typeof name !== "string") {
      throw new TypeError("节点名称必须是非空字符串");
    }
    if (typeof handler !== "function") {
      throw new TypeError(`节点 "${name}" 的 handler 必须是函数`);
    }

    const kind = options.kind ?? "fn";
    if (!NODE_KINDS.has(kind)) {
      throw new TypeError(`节点 "${name}" 的 kind 不受支持: ${kind}`);
    }

    const maxVisits = options.maxVisits ?? 1;
    if (!Number.isInteger(maxVisits) || maxVisits < 1) {
      throw new TypeError(`节点 "${name}" 的 maxVisits 必须是正整数`);
    }

    this.name = name;
    this.handler = handler;
    this.kind = kind;
    this.maxVisits = maxVisits;
    this.onError = options.onError ?? null;
  }

  async run(state: Readonly<TState>, context: NodeContext): Promise<TUpdate> {
    // 统一同步和异步 handler，同时允许“只产生副作用事件”的节点不写状态。
    return ((await this.handler(state, context)) ?? {}) as TUpdate;
  }
}

/**
 * 用较短的写法创建节点。
 */
export function node<
  TState extends StateRecord = AnyState,
  TUpdate extends StateRecord = StateRecord,
>(name: string, handler: NodeHandler<TState, TUpdate>, options?: NodeOptions): Node<TState, TUpdate> {
  return new Node(name, handler, options);
}
