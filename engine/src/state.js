/**
 * State 是整次运行共享的“黑板”。节点不会直接修改黑板，而是读取快照、
 * 返回增量，再由引擎在波次结束时统一合并。这样并发执行仍然具有确定性。
 */

/** 同一波次的并行节点写入了相同状态键。 */
export class StateCollisionError extends Error {
  constructor(key, firstNode, secondNode) {
    super(`节点 "${firstNode}" 与 "${secondNode}" 在同一波次写入了状态键 "${key}"`);
    this.name = "StateCollisionError";
    this.key = key;
    this.firstNode = firstNode;
    this.secondNode = secondNode;
  }
}

/**
 * 创建一次引擎运行所持有的状态容器。
 * 节点只能拿到快照，写入必须通过 mergeWave 统一合并。
 */
export class State {
  #value;

  constructor(initialValue = {}) {
    if (!isRecord(initialValue)) {
      throw new TypeError("初始状态必须是普通对象");
    }

    this.#value = { ...initialValue };
  }

  snapshot() {
    // 首版只复制顶层对象，约定节点把状态视为只读数据，不原地修改嵌套值。
    return { ...this.#value };
  }

  value() {
    // 不泄露内部对象引用，调用方修改返回结果不会覆盖容器的顶层状态。
    return { ...this.#value };
  }

  /**
   * 按节点声明顺序合并一个波次的结果，保证输出和并发完成顺序无关。
   */
  mergeWave(writes) {
    const owners = new Map();

    for (const { node, update } of writes) {
      if (!isRecord(update)) {
        throw new TypeError(`节点 "${node}" 必须返回普通对象`);
      }

      for (const [key, value] of Object.entries(update)) {
        // 下划线键属于引擎内部上下文，不进入持久状态。
        if (key.startsWith("_")) continue;

        const owner = owners.get(key);
        if (owner && owner !== node) {
          throw new StateCollisionError(key, owner, node);
        }

        owners.set(key, node);
        this.#value[key] = value;
      }
    }
  }

  recordError(source, error) {
    // errors 是引擎保留键；旧值不合法时直接归一化，保证最终结果可序列化。
    const current = isRecord(this.#value.errors) ? this.#value.errors : {};
    this.#value.errors = {
      ...current,
      [source]: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
  }
}

export function isRecord(value) {
  // 数组虽然 typeof 为 object，但不能表达按名称合并的状态增量。
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
