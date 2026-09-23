import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CompactionNotice, updateCompactionViews } from "../src/pages/agent/CompactionNotice";
import { advanceHarnessMemory } from "../src/harness-playback";
import { agentHarnessGraph } from "../../src/agent-graph/harness-graph.ts";

it("压缩节点和动态边来自真实拓扑，失败仍可明确展示安全降级", () => {
  const graph = agentHarnessGraph.describe();
  expect(graph.nodes.map((node) => node.name)).toContain("compact");
  const topology = new Set(graph.edges.map((edge) => `${edge.source}->${edge.target}`));
  expect([...topology].filter((edge) => edge.split("->").includes("compact"))).toEqual([
    "working_memory->compact", "compact->llm",
  ]);
  for (const iteration of [1, 2]) {
    const started = advanceHarnessMemory("compact_started", { iteration }, {});
    expect(started.states.compact).toBe("running");
    expect(started.edges).toEqual(["working_memory->compact"]);
    for (const edge of started.edges) expect(topology.has(edge)).toBe(true);
    for (const [event, status] of [["compact_completed", "done"], ["compact_failed", "error"]]) {
      const ended = advanceHarnessMemory(event!, {}, started.states);
      expect(ended.states.compact).toBe(status);
      const request = advanceHarnessMemory("model_request", { iteration, compactionId: "c" }, ended.states);
      expect(request.edges).toContain("compact->llm");
      expect(advanceHarnessMemory("model_request", { iteration: iteration + 1 }, request.states).edges).not.toContain("compact->llm");
      for (const edge of request.edges) expect(topology.has(edge)).toBe(true);
    }
  }
});

it("聊天标记按压缩身份更新，展示前后水位、软目标与耗时", () => {
  const started = updateCompactionViews([], "compact_started", { compactionId: "c", beforeTokens: 7000, availableInputTokens: 10000 });
  expect(renderToStaticMarkup(<CompactionNotice item={started[0]!} />)).toContain("正在压缩上下文");
  const done = updateCompactionViews(started, "compact_completed", { compactionId: "c", beforeTokens: 7000, afterTokens: 3500, availableInputTokens: 10000, ms: 1500, targetReached: false });
  expect(done).toHaveLength(1);
  const html = renderToStaticMarkup(<CompactionNotice item={done[0]!} />);
  for (const text of ["上下文已压缩", "70%", "35%", "超过 30% 目标", "1.5s"]) expect(html).toContain(text);
  const failed = updateCompactionViews(started, "compact_failed", { compactionId: "c", beforeTokens: 7000, ms: 200, reasonCode: "persistence_failed" });
  expect(renderToStaticMarkup(<CompactionNotice item={failed[0]!} />)).toContain("保留原上下文");
  expect(renderToStaticMarkup(<CompactionNotice item={failed[0]!} />)).toContain("检查点保存失败");
  expect(updateCompactionViews(done, "compact_started", {})).toBe(done);
});
