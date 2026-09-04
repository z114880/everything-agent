import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { searchSemanticLexical, searchSessionLexical, SqliteVectorStore } from "../index.ts";

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((database) => database.close()));

describe("SQLite Vector Store", () => {
  it("维护 building、active、替换、Session 删除与失败 generation", () => {
    const database = createDatabase();
    const store = new SqliteVectorStore(database);
    expect(searchSemanticLexical(database, " ", 10)).toEqual([]);
    expect(searchSessionLexical(database, " ")).toEqual([]);
    expect(store.activeGenerationId()).toBeNull();
    expect(store.activeProfileHash()).toBeNull();
    expect(store.activeProfileJson()).toBeNull();
    expect(() => store.listActive("semantic")).toThrow("不存在");
    expect(() => store.replaceActiveSource("semantic", "missing", [])).toThrow("不存在");
    store.deleteActiveSource("semantic", "missing");
    store.deleteActiveSession("missing");

    const active = store.createGeneration("{}", "profile-a", 1);
    store.insertChunks(active, [chunk("semantic", "1", 0)]);
    store.activate(active);
    expect(store.activeGenerationId()).toBe(active);
    expect(store.activeProfileHash()).toBe("profile-a");
    expect(store.activeProfileJson()).toBe("{}");
    expect(store.listActive("semantic")).toMatchObject([{ sourceId: "1", chunkIndex: 0 }]);

    store.replaceActiveSource("semantic", "1", [chunk("semantic", "1", 1)]);
    expect(store.listActive("semantic")).toMatchObject([{ sourceId: "1", chunkIndex: 1 }]);
    store.deleteActiveSource("semantic", "1");
    expect(store.listActive("semantic")).toEqual([]);

    store.insertChunks(active, [chunk("session", "run", 0, "session")]);
    store.deleteActiveSession("session");
    expect(store.listActive("session")).toEqual([]);

    const failed = store.createGeneration("{}", "profile-b", 1);
    store.insertChunks(failed, [chunk("semantic", "2", 0)]);
    store.discardGeneration(failed, "failed");
    expect(database.prepare("SELECT status FROM embedding_generations WHERE id=?").get(failed)).toMatchObject({ status: "failed" });
    store.deleteGeneration(failed);
    expect(database.prepare("SELECT id FROM embedding_generations WHERE id=?").get(failed)).toBeUndefined();
    expect(() => store.activate("missing")).toThrow("不存在");
  });
});

function createDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE embedding_generations (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, profile_json TEXT NOT NULL,
      profile_hash TEXT NOT NULL, chunking_version INTEGER NOT NULL, created_at TEXT NOT NULL, activated_at TEXT
    );
    CREATE TABLE embedding_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      generation_id TEXT NOT NULL REFERENCES embedding_generations(id) ON DELETE CASCADE,
      corpus TEXT NOT NULL, source_id TEXT NOT NULL, session_id TEXT, anchor_message_id INTEGER,
      chunk_index INTEGER NOT NULL, start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL,
      estimated_tokens INTEGER NOT NULL, vector BLOB NOT NULL,
      UNIQUE(generation_id, corpus, source_id, chunk_index)
    );
  `);
  return database;
}

function chunk(corpus: "semantic" | "session", sourceId: string, chunkIndex: number, sessionId?: string) {
  const vector = new Float32Array(1024); vector[0] = 1;
  return {
    corpus, sourceId, ...(sessionId ? { sessionId, anchorMessageId: 1 } : {}),
    chunkIndex, startOffset: 0, endOffset: 1, estimatedTokens: 1, vector,
  };
}
