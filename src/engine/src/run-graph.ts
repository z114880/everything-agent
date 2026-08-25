import { END, START } from "./graph.js";
import type { Graph } from "./graph.js";
import { isRecord, State } from "./state.js";
import type { AnyState, StateRecord, StateWrite } from "./state.js";

type InputDecision = "pending" | "fired" | "skipped" | "failed";

interface InputSummary {
  ready: boolean;
  impossible: boolean;
  failed: boolean;
  inputCount: number;
  pending: string[];
  fired: boolean;
}

interface NodeExecutionResult {
  name: string;
  update: StateRecord | null;
  error: unknown | null;
  ms: number;
}

/** Graph 运行事件的接收函数。 */
export type GraphObserver = (
  kind: string,
  event: StateRecord,
) => void | Promise<void>;

/** `runGraph` 的执行限制与事件出口。 */
export interface GraphRunOptions {
  maxSteps?: number;
  observer?: GraphObserver;
}

/** 无法继续调度的节点及其尚未决议的上游。 */
export interface BlockedNode {
  node: string;
  waitingFor: string[];
}

/** Graph 的最终运行状态。 */
export type GraphRunStatus = "completed" | "failed" | "stalled";

/** `runGraph` 的可观察结果。 */
export interface GraphRunResult<TState extends StateRecord> {
  state: TState;
  path: string[];
  steps: number;
  error: unknown | null;
  status: GraphRunStatus;
  blockedNodes: BlockedNode[];
}

/**
 * 按波次执行图，直到没有可运行节点，或命中全局最大步数。
 *
 * 一个波次包含当前所有就绪节点。波次内并发、波次间串行，使执行既能利用
 * 独立分支的并发，又能让状态合并、事件和 path 保持可复现的顺序。
 */
export async function runGraph<TState extends StateRecord = AnyState>(
  graph: Graph<TState>,
  initialState: TState = {} as TState,
  options: GraphRunOptions = {},
): Promise<GraphRunResult<TState>> {
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
  // 普通入边构成汇合依赖；条件入边是独立的激活入口。每条边必须明确变为
  // fired、skipped 或 failed，避免把未选中的静态分支误认为仍在运行。
  const incoming = new Map<string, Map<string, InputDecision>>(
    graph.nodeEntries().map(([name]) => [name, new Map()]),
  );
  const conditionalIncoming = new Map<string, Map<string, InputDecision>>(
    graph.nodeEntries().map(([name]) => [name, new Map()]),
  );
  const propagated = new Map<string, InputDecision>();
  // visits 独立于边决议：普通 DAG 节点只运行一次，路由跳转可按 maxVisits 重访。
  const visits = new Map<string, number>(graph.nodeEntries().map(([name]) => [name, 0]));
  const path: string[] = [];
  const startedAt = performance.now();

  for (const { source, target } of edges) {
    if (target !== END) incoming.get(target)?.set(source, "pending");
    // START 不是真实节点，因此在进入主循环前直接视为已经完成。
    if (source === START && target !== END) incoming.get(target)?.set(START, "fired");
  }
  for (const [source, router] of graph.routerEntries()) {
    for (const target of new Set(Object.values(router.targets))) {
      if (target !== END) conditionalIncoming.get(target)?.set(source, "pending");
    }
  }

  const notify = async (kind: string, event: StateRecord): Promise<void> => {
    await observer(kind, event);
  };

  const setDecision = (
    target: string,
    source: string,
    decision: InputDecision,
    conditional = false,
  ): void => {
    const decisions = (conditional ? conditionalIncoming : incoming).get(target);
    if (decisions?.has(source)) decisions.set(source, decision);
  };

  const resolveOutgoing = (name: string, decision: InputDecision): void => {
    for (const edge of edges) {
      if (edge.source === name && edge.target !== END) {
        setDecision(edge.target, name, decision);
      }
    }
    const router = graph.routerFor(name);
    if (router) {
      for (const target of new Set(Object.values(router.targets))) {
        if (target !== END) setDecision(target, name, decision, true);
      }
    }
  };

  const summarizeInputs = (name: string): InputSummary => {
    const ordinary = [...(incoming.get(name)?.entries() ?? [])];
    const conditional = [...(conditionalIncoming.get(name)?.entries() ?? [])];
    const isResolved = ([, decision]: [string, InputDecision]) => decision !== "pending";
    const isFired = ([, decision]: [string, InputDecision]) => decision === "fired";
    const isFailed = ([, decision]: [string, InputDecision]) => decision === "failed";

    const ordinaryReady = ordinary.length > 0
      && ordinary.every(isResolved)
      && ordinary.some(isFired)
      && !ordinary.some(isFailed);
    const conditionalReady = conditional.some(isFired);
    const ordinaryImpossible = ordinary.length === 0
      || (ordinary.every(isResolved)
        && (!ordinary.some(isFired) || ordinary.some(isFailed)));
    const conditionalImpossible = conditional.length === 0
      || (conditional.every(isResolved) && !conditional.some(isFired));

    return {
      ready: ordinaryReady || conditionalReady,
      impossible: ordinaryImpossible && conditionalImpossible,
      failed: ordinary.some(isFailed) || conditional.some(isFailed),
      inputCount: ordinary.length + conditional.length,
      pending: [...ordinary, ...conditional]
        .filter(([, decision]) => decision === "pending")
        .map(([source]) => source),
      fired: [...ordinary, ...conditional].some(isFired),
    };
  };

  const settleInactiveNodes = (protectedNodes: ReadonlySet<string>): void => {
    let changed = true;
    while (changed) {
      changed = false;
      for (const [name] of graph.nodeEntries()) {
        if ((visits.get(name) ?? 0) > 0 || protectedNodes.has(name)) continue;

        const summary = summarizeInputs(name);
        // 没有入口的孤立节点不是被跳过的分支，保留 pending 才能报告错误汇合。
        if (summary.ready || !summary.impossible || summary.inputCount === 0) continue;

        const decision = summary.failed ? "failed" : "skipped";
        if (propagated.get(name) === decision) continue;
        propagated.set(name, decision);
        resolveOutgoing(name, decision);
        changed = true;
      }
    }
  };

  const nextWave = (jumps: readonly string[] = []): string[] => {
    // 路由和错误恢复是强制跳转，不需要等待目标节点的静态入边。
    const candidates = [...jumps];
    settleInactiveNodes(new Set(jumps));

    // 普通汇合等待所有入边完成决议；skipped 不阻塞汇合，failed 则阻止执行。
    for (const [name] of graph.nodeEntries()) {
      if (visits.get(name) === 0 && summarizeInputs(name).ready) {
        candidates.push(name);
      }
    }

    const wave: string[] = [];
    for (const name of candidates) {
      if (name === END || wave.includes(name)) continue;

      const value = graph.getNode(name);
      if (!value) {
        state.recordError("engine", `尝试运行未知节点 "${name}"`);
        continue;
      }
      if ((visits.get(name) ?? 0) >= value.maxVisits) {
        state.recordError(name, `maxVisits=${value.maxVisits} 已达到`);
        continue;
      }

      wave.push(name);
    }
    return wave;
  };

  const activatedEdgesFor = (nodes: readonly string[]) => {
    const activatedEdges: Array<{ source: string; target: string; conditional: boolean }> = [];
    const seen = new Set<string>();
    const append = (source: string, target: string, conditional: boolean) => {
      const key = `${conditional ? "conditional" : "ordinary"}:${source}->${target}`;
      if (seen.has(key)) return;
      seen.add(key);
      activatedEdges.push({ source, target, conditional });
    };

    for (const target of nodes) {
      for (const [source, decision] of incoming.get(target)?.entries() ?? []) {
        if (decision === "fired") append(source, target, false);
      }
      for (const [source, decision] of conditionalIncoming.get(target)?.entries() ?? []) {
        if (decision === "fired") append(source, target, true);
      }
    }
    return activatedEdges;
  };

  await notify("graph_start", {
    graph: graph.name,
    nodes: graph.nodeEntries().map(([name]) => name),
  });
  let wave = nextWave();
  let waveIndex = 0;

  while (wave.length > 0) {
    // 整个波次要么执行、要么不执行，避免只运行一半并行分支。
    if (path.length + wave.length > maxSteps) {
      state.recordError("engine", `maxSteps=${maxSteps} 已达到`);
      break;
    }

    waveIndex += 1;
    await notify("wave_start", {
      graph: graph.name,
      wave: waveIndex,
      nodes: [...wave],
      activatedEdges: activatedEdgesFor(wave),
    });

    for (const name of wave) {
      visits.set(name, (visits.get(name) ?? 0) + 1);
      await notify("node_start", {
        graph: graph.name,
        node: name,
        wave: waveIndex,
        visit: visits.get(name),
      });
    }

    // 每个节点读取同一波次开始前的独立快照，因此并发结果不会互相污染。
    const results: NodeExecutionResult[] = await Promise.all(wave.map(async (name) => {
      const value = graph.getNode(name)!;
      const nodeStartedAt = performance.now();
      try {
        const update = await value.run(state.snapshot(), {
          emit: (kind, event = {}) => notify(kind, { ...event, node: name }),
          graph: graph.name,
          visit: visits.get(name) ?? 0,
        });
        return { name, update, error: null, ms: Math.round(performance.now() - nodeStartedAt) };
      } catch (error) {
        return { name, update: null, error, ms: Math.round(performance.now() - nodeStartedAt) };
      }
    }));

    // Promise.all 保留输入顺序；这里只合并成功节点，因此合并次序不受耗时影响。
    const successfulWrites: StateWrite[] = results
      .filter((result) => result.error === null)
      .map((result) => ({ node: result.name, update: result.update ?? {} }));
    state.mergeWave(successfulWrites);

    // 先合并整个波次，再计算路由，保证路由能看到同波次所有节点的写入。
    const jumps: string[] = [];
    for (const result of results) {
      path.push(result.name);
      const keys = result.update && typeof result.update === "object"
        ? Object.keys(result.update).filter((key) => !key.startsWith("_"))
        : [];

      await notify("node_end", {
        graph: graph.name,
        node: result.name,
        wave: waveIndex,
        ms: result.ms,
        keys,
        error: result.error ? String(result.error) : null,
      });

      const value = graph.getNode(result.name)!;
      if (result.error) {
        state.recordError(result.name, result.error);
        resolveOutgoing(result.name, "failed");
        if (value.onError) jumps.push(value.onError);
        // 失败节点不触发普通出边，否则下游会消费不完整状态。
        continue;
      }

      const router = graph.routerFor(result.name);
      if (router) {
        let label: string;
        try {
          label = await router.route(state.snapshot());
        } catch (error) {
          state.recordError(result.name, error);
          resolveOutgoing(result.name, "failed");
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
          resolveOutgoing(result.name, "failed");
        } else {
          // 路由独占控制流：普通出边本次全部跳过，条件目标则完整记录选中与未选中。
          for (const edge of edges) {
            if (edge.source === result.name && edge.target !== END) {
              setDecision(edge.target, result.name, "skipped");
            }
          }
          for (const candidate of new Set(Object.values(router.targets))) {
            if (candidate !== END) {
              setDecision(
                candidate,
                result.name,
                candidate === target ? "fired" : "skipped",
                true,
              );
            }
          }
          if (target !== END) jumps.push(target);
        }
        // 有路由的节点由路由独占控制流，不再触发它的普通出边。
        continue;
      }

      // 普通边只记录“哪个上游已完成”；目标是否就绪由下一轮统一判断。
      for (const edge of edges) {
        if (edge.source === result.name && edge.target !== END) {
          setDecision(edge.target, result.name, "fired");
        }
      }
    }

    wave = nextWave(jumps);
  }

  const blockedNodes = graph.nodeEntries()
    .filter(([name]) => visits.get(name) === 0)
    .map(([name]) => ({ name, summary: summarizeInputs(name) }))
    .filter(({ summary }) => summary.fired && summary.pending.length > 0)
    .map(({ name, summary }) => ({
      node: name,
      waitingFor: [...new Set(summary.pending)],
    }));
  if (blockedNodes.length > 0) {
    state.recordError(
      "engine",
      `运行停滞，节点仍在等待未解决的上游: ${blockedNodes.map(({ node }) => node).join(", ")}`,
    );
    await notify("graph_stalled", {
      graph: graph.name,
      blockedNodes,
    });
  }

  const finalState = state.value();
  const firstError = isRecord(finalState.errors)
    ? Object.values(finalState.errors)[0] ?? null
    : null;
  const status: GraphRunStatus = blockedNodes.length > 0
    ? "stalled"
    : firstError
      ? "failed"
      : "completed";
  await notify("graph_end", {
    graph: graph.name,
    ms: Math.round(performance.now() - startedAt),
    steps: path.length,
    path: [...path],
    error: firstError,
    status,
    blockedNodes,
  });

  return {
    state: finalState,
    path,
    steps: path.length,
    error: firstError,
    status,
    blockedNodes,
  };
}
