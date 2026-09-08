import type { ToolExecutionContext } from "../agent-loop/types.ts";

export const SEARCH_WEB_TOOL = "search_web";

export const searchWebSchema = {
  name: SEARCH_WEB_TOOL,
  description: "使用 Tavily 搜索实时网页信息。需要当前事实、新闻或互联网资料时调用此工具。",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "清晰、具体的搜索查询。" },
      max_results: { type: "integer", minimum: 1, maximum: 10, description: "返回结果数量，默认 5。" },
    },
    required: ["query"],
    additionalProperties: false,
  },
} as const;

export interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
  score: number | null;
}

/** 通过 Tavily Search API 执行受控的只读网页搜索。 */
export class TavilySearchTool {
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async execute(value: unknown, context: ToolExecutionContext): Promise<{
    query: string;
    results: TavilySearchResult[];
    responseTime: string | null;
    requestId: string | null;
  }> {
    const input = parseSearchInput(value);
    if (!this.apiKey) throw new Error("Tavily API Key 尚未配置");
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: input.query,
        search_depth: "basic",
        max_results: input.maxResults,
        include_answer: false,
        include_raw_content: false,
      }),
      ...(context.signal ? { signal: context.signal } : {}),
    });
    if (!response.ok) throw new Error(`Tavily 搜索失败（HTTP ${response.status}）`);
    const payload = await response.json() as Record<string, unknown>;
    if (!Array.isArray(payload.results)) throw new Error("Tavily 返回了无效的搜索结果");
    return {
      query: input.query,
      results: payload.results.map(publicResult).filter((item): item is TavilySearchResult => item !== null),
      responseTime: typeof payload.response_time === "string" ? payload.response_time : null,
      requestId: typeof payload.request_id === "string" ? payload.request_id : null,
    };
  }
}

function parseSearchInput(value: unknown): { query: string; maxResults: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("search_web 参数必须是对象");
  const input = value as Record<string, unknown>;
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (!query || query.length > 2_000) throw new TypeError("query 必须是 1–2000 字符的字符串");
  const maxResults = input.max_results === undefined ? 5 : Number(input.max_results);
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 10) {
    throw new TypeError("max_results 必须是 1–10 的整数");
  }
  const unknownKeys = Object.keys(input).filter((key) => !["query", "max_results"].includes(key));
  if (unknownKeys.length > 0) throw new TypeError(`search_web 不支持参数：${unknownKeys.join("、")}`);
  return { query, maxResults };
}

function publicResult(value: unknown): TavilySearchResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  if (typeof result.title !== "string" || typeof result.url !== "string" || typeof result.content !== "string") return null;
  return {
    title: result.title,
    url: result.url,
    content: result.content,
    score: typeof result.score === "number" && Number.isFinite(result.score) ? result.score : null,
  };
}
