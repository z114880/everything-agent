const NODE_KINDS = new Set(["fn", "tool", "llm", "agent"]);

/**
 * 图中的最小执行单元：读取状态快照，返回需要合并的状态增量。
 *
 * kind 只用于 describe、日志和可视化，不改变执行行为；maxVisits 与
 * onError 则由 loop 读取，用来控制循环次数和失败后的恢复路径。
 */
export class Node {
  constructor(name, handler, options = {}) {
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

  async run(state, context) {
    // 统一同步和异步 handler，同时允许“只产生副作用事件”的节点不写状态。
    return (await this.handler(state, context)) ?? {};
  }
}

/**
 * 用较短的写法创建节点。
 */
export function node(name, handler, options) {
  return new Node(name, handler, options);
}
