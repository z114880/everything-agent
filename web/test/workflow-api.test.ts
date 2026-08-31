import { afterEach, describe, expect, it, vi } from "vitest";
import { loadLocalWorkflow, runLocalWorkflow, saveLocalWorkflow } from "../src/workflow-api";

describe("本地工作流接口", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("读取指定文件并保留服务端返回的文件列表", async () => {
    const payload = {
      files: ["morning-brief.ts", "weather.ts"],
      selectedFile: "weather.ts",
      source: "export const graph = graphValue;",
      workflow: { name: "天气", nodes: [], edges: [] },
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadLocalWorkflow("weather.ts")).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/local-workflow?file=weather.ts",
      undefined,
    );
  });

  it("保存和执行请求始终携带当前文件名", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        workflow: { name: "晨间简报", nodes: [], edges: [] },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response([
        JSON.stringify({ type: "event", kind: "graph_start", event: { graph: "晨间简报" } }),
        JSON.stringify({
          type: "result",
          result: { state: {}, path: [], steps: 0, status: "completed", error: null, totalMs: 1 },
        }),
        "",
      ].join("\n"), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await saveLocalWorkflow("morning-brief.ts", "source");
    const observer = vi.fn();
    await runLocalWorkflow("morning-brief.ts", "今天做什么", observer);

    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({
      file: "morning-brief.ts",
      source: "source",
    });
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual({
      file: "morning-brief.ts",
      input: "今天做什么",
    });
    expect(observer).toHaveBeenCalledWith("graph_start", { graph: "晨间简报" });
  });
});
