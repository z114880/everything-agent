export const MEMORY_SCHEMA_VERSION = 2;

export const MEMORY_SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 3000;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  consolidated_through_message_id INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  kind TEXT NOT NULL CHECK (kind IN ('user_message', 'assistant_tool_call', 'tool_result', 'assistant_message')),
  content_json TEXT NOT NULL,
  search_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_log_session_id_id ON chat_log(session_id, id);
CREATE INDEX IF NOT EXISTS chat_log_run_id ON chat_log(run_id);

CREATE VIRTUAL TABLE IF NOT EXISTS chat_log_fts USING fts5(
  search_text, content='chat_log', content_rowid='id', tokenize='unicode61'
);
CREATE TRIGGER IF NOT EXISTS chat_log_ai AFTER INSERT ON chat_log
WHEN new.kind IN ('user_message', 'assistant_message') BEGIN
  INSERT INTO chat_log_fts(rowid, search_text) VALUES (new.id, new.search_text);
END;
CREATE TRIGGER IF NOT EXISTS chat_log_ad AFTER DELETE ON chat_log
WHEN old.kind IN ('user_message', 'assistant_message') BEGIN
  INSERT INTO chat_log_fts(chat_log_fts, rowid, search_text)
  VALUES ('delete', old.id, old.search_text);
END;
CREATE TRIGGER IF NOT EXISTS chat_log_au AFTER UPDATE OF search_text, kind ON chat_log BEGIN
  INSERT INTO chat_log_fts(chat_log_fts, rowid, search_text)
  SELECT 'delete', old.id, old.search_text WHERE old.kind IN ('user_message', 'assistant_message');
  INSERT INTO chat_log_fts(rowid, search_text)
  SELECT new.id, new.search_text WHERE new.kind IN ('user_message', 'assistant_message');
END;

CREATE TABLE IF NOT EXISTS semantic_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT NOT NULL,
  search_text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS semantic_memory_fts USING fts5(
  subject, search_text, content='semantic_memory', content_rowid='id', tokenize='unicode61'
);
CREATE TRIGGER IF NOT EXISTS semantic_memory_ai AFTER INSERT ON semantic_memory BEGIN
  INSERT INTO semantic_memory_fts(rowid, subject, search_text) VALUES (new.id, new.subject, new.search_text);
END;
CREATE TRIGGER IF NOT EXISTS semantic_memory_ad AFTER DELETE ON semantic_memory BEGIN
  INSERT INTO semantic_memory_fts(semantic_memory_fts, rowid, subject, search_text)
  VALUES ('delete', old.id, old.subject, old.search_text);
END;
CREATE TRIGGER IF NOT EXISTS semantic_memory_au AFTER UPDATE ON semantic_memory BEGIN
  INSERT INTO semantic_memory_fts(semantic_memory_fts, rowid, subject, search_text)
  VALUES ('delete', old.id, old.subject, old.search_text);
  INSERT INTO semantic_memory_fts(rowid, subject, search_text) VALUES (new.id, new.subject, new.search_text);
END;

CREATE TABLE IF NOT EXISTS consolidation_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  through_message_id INTEGER NOT NULL DEFAULT 0,
  facts_created INTEGER NOT NULL DEFAULT 0,
  facts_updated INTEGER NOT NULL DEFAULT 0,
  facts_skipped INTEGER NOT NULL DEFAULT 0,
  error_type TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS memory_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_type TEXT NOT NULL,
  memory_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;
