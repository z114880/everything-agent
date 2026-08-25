import { END, START } from "./graph.js";
import { isRecord, State } from "./state.js";

/**
 * 按波次执行图，直到没有可运行节点，或命中全局最大步数。
 *
 * 一个波次包含当前所有就绪节点。波次内并发、波次间串行，使执行既能利用
 * 独立分支的并发，又能让状态合并、事件和 path 保持可复现的顺序。
 */
export async function runGraph(graph, initialState = {}, options = {}) {
  const state = new State(initialState);
  const maxSteps = options.maxSteps ?? 25;
  const observer = options.observer ?? (() => {});

  if (!Number.isInteger(maxSteps) || maxSteps < 1) {
    throw new TypeError("maxSteps 必须是正整数");
  }
  if (typeof observer !== "function") {
    throw new TypeError("observer 必须是函数");
  }

  const edges = graph.edges();
  // incoming 是静态依赖，fired 是本次运行已经完成的入边，二者相等时节点就绪。
  const incoming = new Map(graph.nodeEntries().map(([name]) => [name, new Set()]));
  const fired = new Map(graph.nodeEntries().map(([name]) => [name, new Set()]));
  // visits 独立于 fired：普通 DAG 节点只运行一次，路由跳转可按 maxVisits 重访。
  const visits = new Map(graph.nodeEntries().map(([name]) => [name, 0]));
  const path = [];
  const startedAt = performance.now();

  for (const { source, target } of edges) {
    if (target !== END) incoming.get(target)?.add(source);
    // START 不是真实节点，因此在进入主循环前直接视为已经完成。
    if (source === START && target !== END) fired.get(target)?.add(START);
  }

  const notify = async (kind, event) => {
    await observer(kind, event);
  };

  const nextWave = (jumps = []) => {
    // 路由和错误恢复是强制跳转，不需要等待目标节点的静态入边。
    const candidates = [...jumps];

    // 非跳转节点只有在全部上游完成、且从未运行时才会进入波次。
    for (const [name] of graph.nodeEntries()) {
      const dependencies = incoming.get(name);
      const completed = fired.get(name);
      if (dependencies.size > 0 && dependencies.size === completed.size && visits.get(name) === 0) {
        candidates.push(name);
      }
    }

    const wave = [];
    for (const name of candidates) {
      if (name === END || wave.includes(name)) continue;

      const value = graph.getNode(name);
      if (!value) {
        state.recordError("engine", `尝试运行未知节点 "${name}"`);
        continue;
      }
      if (visits.get(name) >= value.maxVisits) {
        state.recordError(name, `maxVisits=${value.maxVisits} 已达到`);
        continue;
      }

      wave.push(name);
    }
    return wave;
  };

  await notify("graph_start", {
    graph: graph.name,
    nodes: graph.nodeEntries().map(([name]) => name),
  });
  let wave = nextWave();

  while (wave.length > 0) {
    // 整个波次要么执行、要么不执行，避免只运行一半并行分支。
    if (path.length + wave.length > maxSteps) {
      state.recordError("engine", `maxSteps=${maxSteps} 已达到`);
      break;
    }

    for (const name of wave) {
      visits.set(name, visits.get(name) + 1);
      await notify("node_start", {
        graph: graph.name,
        node: name,
        visit: visits.get(name),
      });
    }

    // 每个节点读取同一波次开始前的独立快照，因此并发结果不会互相污染。
    const results = await Promise.all(wave.map(async (name) => {
      const value = graph.getNode(name);
      const nodeStartedAt = performance.now();
      try {
        const update = await value.run(state.snapshot(), {
          emit: (kind, event = {}) => notify(kind, { ...event, node: name }),
          graph: graph.name,
          visit: visits.get(name),
        });
        return { name, update, error: null, ms: Math.round(performance.now() - nodeStartedAt) };
      } catch (error) {
        return { name, update: null, error, ms: Math.round(performance.now() - nodeStartedAt) };
      }
    }));

    // Promise.all 保留输入顺序；这里只合并成功节点，因此合并次序不受耗时影响。
    const successfulWrites = results
      .filter((result) => result.error === null)
      .map((result) => ({ node: result.name, update: result.update }));
    state.mergeWave(successfulWrites);

    // 先合并整个波次，再计算路由，保证路由能看到同波次所有节点的写入。
    const jumps = [];
    for (const result of results) {
      path.push(result.name);
      const keys = result.update && typeof result.update === "object"
        ? Object.keys(result.update).filter((key) => !key.startsWith("_"))
        : [];

      await notify("node_end", {
        graph: graph.name,
        node: result.name,
        ms: result.ms,
        keys,
        error: result.error ? String(result.error) : null,
      });

      const value = graph.getNode(result.name);
      if (result.error) {
        state.recordError(result.name, result.error);
        if (value.onError) jumps.push(value.onError);
        // 失败节点不触发普通出边，否则下游会消费不完整状态。
        continue;
      }

      const router = graph.routerFor(result.name);
      if (router) {
        let label;
        try {
          label = await router.route(state.snapshot());
        } catch (error) {
          state.recordError(result.name, error);
          continue;
        }

        // 必须检查自身属性，避免 toString 等原型属性被误当成合法路由标签。
        const target = Object.hasOwn(router.targets, label) ? router.targets[label] : undefined;
        await notify("route", {
          graph: graph.name,
          node: result.name,
          label,
          target: target ?? END,
        });
        if (!target) {
          state.recordError(result.name, `路由返回了未知标签 "${label}"`);
        } else if (target !== END) {
          jumps.push(target);
        }
        // 有路由的节点由路由独占控制流，不再触发它的普通出边。
        continue;
      }

      // 普通边只记录“哪个上游已完成”；目标是否就绪由下一轮统一判断。
      for (const edge of edges) {
        if (edge.source === result.name && edge.target !== END) {
          fired.get(edge.target)?.add(result.name);
        }
      }
    }

    wave = nextWave(jumps);
  }

  const finalState = state.value();
  const firstError = isRecord(finalState.errors)
    ? Object.values(finalState.errors)[0] ?? null
    : null;
  await notify("graph_end", {
    graph: graph.name,
    ms: Math.round(performance.now() - startedAt),
    steps: path.length,
    path: [...path],
    error: firstError,
  });

  return {
    state: finalState,
    path,
    steps: path.length,
    error: firstError,
  };
}
