import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRuntime, toMatchQuery, toSearchText, type SessionRecallSettings } from "../index.ts";

const resources: { memory: MemoryRuntime; home: string }[] = [];
const recall: SessionRecallSettings = { searchWindow: 5, scrollStep: 10, messageLimit: 100, tokenLimit: 50_000, tokenEstimator: { estimateText: (text) => text.length } };
afterEach(async () => {
  for (const { memory, home } of resources.splice(0)) { memory.close(); await rm(home, { recursive: true, force: true }); }
});

describe("统一 FTS 分词", () => {
  it("中文使用搜索模式，保留单字和停用词，移除任意 bigram", () => {
    const tokens = toSearchText("南京市长江大桥 数据库 的 猫").split(" ");
    expect(tokens).toEqual(expect.arrayContaining(["南京市", "长江大桥", "长江", "大桥", "数据库", "的", "猫"]));
    expect(tokens).not.toContain("江大");
  });

  it("英文和 identifier 保留整体、拆分驼峰，并统一 NFKC 与小写", () => {
    const tokens = toSearchText("getUserInfo HTTPServer get_user_info node.js gpt-4o C++ C# @Scope/Pkg ＡＢＣ１２３").split(" ");
    expect(tokens).toEqual(expect.arrayContaining(["getuserinfo", "get", "user", "info", "httpserver", "http", "server", "get_user_info", "node.js", "node", "js", "gpt-4o", "gpt", "4o", "c++", "c#", "@scope/pkg", "scope", "pkg", "abc123"]));
    expect(tokens).not.toContain("4");
  });

  it("路径按目录和文件名索引，不索引完整路径", () => {
    const tokens = toSearchText("/src/memory/search-text.ts C:\\Work\\Config.json").split(" ");
    expect(tokens).toEqual(expect.arrayContaining(["src", "memory", "search-text.ts", "search", "text", "ts", "work", "config.json"]));
    expect(tokens).not.toContain("/src/memory/search-text.ts");
  });

  it("中英文紧邻时分别处理，保留下划线前后缀和 Unicode 字母", () => {
    expect(toSearchText("数据库getUserInfo配置 __init__ user__name Café").split(" ")).toEqual(expect.arrayContaining([
      "数据库", "getuserinfo", "get", "user", "info", "配置", "__init__", "init", "user__name", "name", "café",
    ]));
  });

  it("保留不同位置的词频，同一位置扩展去重，查询去重且不解释操作符", () => {
    expect(toSearchText("foo foo fooFoo").split(" ")).toEqual(["foo", "foo", "foofoo", "foo", "foo"]);
    expect(toSearchText("数据库 数据库").split(" ").filter((word) => word === "数据库")).toHaveLength(2);
    expect(toMatchQuery("foo foo")).toBe('"foo"');
    expect(toMatchQuery('foo " OR *')).toBe('"foo" OR "or"');
    expect(toMatchQuery(" \n ! 🙂")).toBe("");
  });

  for (const corpus of ["semantic", "session"] as const) {
    it(`${corpus} 使用相同规则召回中文、完整 identifier 和组成词`, async () => {
      const memory = await createMemory();
      await insert(memory, corpus, "南京市长江大桥 数据库 getUserInfo node.js gpt-4o C++ C# @Scope/Pkg");
      for (const query of ["长江大桥", "数据库", "GETUSERINFO", "user", "node.js", "node", "4o", "C++", "C#", "@scope/pkg", "pkg"]) {
        expect(await search(memory, corpus, query), query).toHaveLength(1);
      }
      expect(await search(memory, corpus, "江大")).toHaveLength(0);
      expect(await search(memory, corpus, "不存在的代号xyz OR 数据库")).toHaveLength(1);
      expect(await search(memory, corpus, "!!!")).toHaveLength(0);
    });

    it(`${corpus} 完整 identifier 是独立词元，排序优于只有组成词的记录`, async () => {
      const memory = await createMemory();
      const partial = await insert(memory, corpus, "node js spare");
      const complete = await insert(memory, corpus, "node.js");
      const hits = await search(memory, corpus, "node.js");
      expect(hits).toEqual([complete, partial]);
    });

    it(`${corpus} 同组成词的名称仍能利用完整符号区分评分`, async () => {
      const memory = await createMemory();
      const sharp = await insert(memory, corpus, "C#");
      const plus = await insert(memory, corpus, "C++");
      expect(await search(memory, corpus, "C++")).toEqual([plus, sharp]);
      expect(await search(memory, corpus, "C#")).toEqual([sharp, plus]);
      expect(await search(memory, corpus, "c")).toHaveLength(2);
    });

    it(`${corpus} BM25 利用原文重复词频`, async () => {
      const memory = await createMemory();
      const low = await insert(memory, corpus, "alpha beta beta");
      const high = await insert(memory, corpus, "alpha alpha beta");
      expect(await search(memory, corpus, "alpha")).toEqual([high, low]);
    });
  }

  it("Semantic 主题也分词并保留原文，更新删除同步维护索引", async () => {
    const memory = await createMemory();
    const item = await memory.createSemantic("南京市长江大桥 C++", "说明");
    expect((await memory.searchSemantic("长江大桥"))[0]?.subject).toBe("南京市长江大桥 C++");
    await memory.updateSemantic(item.id, "数据库 C#", "替换");
    expect(await memory.searchSemantic("长江大桥")).toEqual([]);
    expect((await memory.searchSemantic("数据库"))[0]?.id).toBe(item.id);
    memory.deleteSemantic(item.id);
    expect(await memory.searchSemantic("数据库")).toEqual([]);
  });

  it("Semantic 主题的中文词元按更高权重评分", async () => {
    const memory = await createMemory();
    const body = await memory.createSemantic("咖啡", "数据库");
    const title = await memory.createSemantic("数据库", "咖啡");
    expect((await memory.searchSemantic("数据库")).map((item) => item.id)).toEqual([title.id, body.id]);
  });

  it("删除 Session 后清除带符号名称的索引", async () => {
    const memory = await createMemory();
    const session = memory.createSession();
    memory.startRun(session.id, "delete", "@scope/pkg");
    await memory.completeRun(session.id, "delete", [{ role: "assistant", content: "收到" }]);
    memory.deleteSession(session.id);
    expect(await search(memory, "session", "@scope/pkg")).toEqual([]);
  });

  it("数据库版本不匹配时直接清空重建，当前版本重开保留新记录", async () => {
    const memory = await createMemory();
    const resource = resources.pop()!;
    await memory.createSemantic("旧记录", "不保留");
    memory.close();
    const database = new DatabaseSync(memory.databasePath);
    database.exec("UPDATE schema_migrations SET version = 0");
    database.close();
    const fresh = new MemoryRuntime(resource.home);
    resources.push({ ...resource, memory: fresh });
    expect(fresh.listSemantic()).toEqual([]);
    const item = await fresh.createSemantic("新记录", "数据库");
    fresh.close();
    resources.pop();
    const reopened = new MemoryRuntime(resource.home);
    resources.push({ ...resource, memory: reopened });
    expect((await reopened.searchSemantic("数据库"))[0]?.id).toBe(item.id);
  });
});

async function createMemory(): Promise<MemoryRuntime> {
  const home = await mkdtemp(join(tmpdir(), "jieba-fts-"));
  const memory = new MemoryRuntime(home);
  memory.configureRetrieval({ mode: "lexical_only" });
  resources.push({ memory, home });
  return memory;
}

async function insert(memory: MemoryRuntime, corpus: "semantic" | "session", text: string): Promise<string | number> {
  if (corpus === "semantic") return (await memory.createSemantic("主题", text)).id;
  const session = memory.createSession();
  memory.startRun(session.id, session.id, text);
  await memory.completeRun(session.id, session.id, [{ role: "assistant", content: "收到" }]);
  return session.id;
}

async function search(memory: MemoryRuntime, corpus: "semantic" | "session", query: string): Promise<(string | number)[]> {
  if (corpus === "semantic") return (await memory.searchSemantic(query)).map((item) => item.id);
  return (await memory.searchSessions({ query }, recall)).sessions.map((item) => item.session.id);
}
