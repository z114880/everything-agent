import { afterEach, describe, expect, it, vi } from "vitest";
import { clearAllAgentData } from "../src/agent-api";

afterEach(() => vi.unstubAllGlobals());

describe("清除全部数据后的向量索引维护", () => {
  it("已配置 Embedding 时在清理成功后自动重建索引", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, cleared: true })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        settings: { embeddingIndex: { ready: true, generationId: "generation-1", profileHash: "profile-1" } },
        result: { rebuildId: "rebuild-1", generationId: "generation-1", chunkCount: 0 },
      })));
    vi.stubGlobal("fetch", fetchMock);

    const result = await clearAllAgentData(true);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/local-agent/clear-data",
      "/api/local-agent/config/rebuild-embeddings",
    ]);
    expect(result.embeddingRebuild?.result.chunkCount).toBe(0);
  });

  it("未配置 Embedding 时只清理数据", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, cleared: true })));
    vi.stubGlobal("fetch", fetchMock);

    const result = await clearAllAgentData(false);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.embeddingRebuild).toBeNull();
  });

  it("自动重建失败时明确说明本地数据已经清理", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, cleared: true })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Embedding 服务不可用" }), { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(clearAllAgentData(true)).rejects.toThrow(
      "本地数据已清理，但自动重建向量索引失败：Embedding 服务不可用",
    );
  });
});
