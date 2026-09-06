export const MEMORY_SCHEMA_VERSION = 8;

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
  search_text, content='chat_log', content_rowid='id', tokenize="unicode61 remove_diacritics 0 tokenchars '_-.+#@/'"
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
  search_subject TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT NOT NULL,
  search_text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS semantic_memory_fts USING fts5(
  search_subject, search_text, content='semantic_memory', content_rowid='id', tokenize="unicode61 remove_diacritics 0 tokenchars '_-.+#@/'"
);
CREATE TRIGGER IF NOT EXISTS semantic_memory_ai AFTER INSERT ON semantic_memory BEGIN
  INSERT INTO semantic_memory_fts(rowid, search_subject, search_text) VALUES (new.id, new.search_subject, new.search_text);
END;
CREATE TRIGGER IF NOT EXISTS semantic_memory_ad AFTER DELETE ON semantic_memory BEGIN
  INSERT INTO semantic_memory_fts(semantic_memory_fts, rowid, search_subject, search_text)
  VALUES ('delete', old.id, old.search_subject, old.search_text);
END;
CREATE TRIGGER IF NOT EXISTS semantic_memory_au AFTER UPDATE ON semantic_memory BEGIN
  INSERT INTO semantic_memory_fts(semantic_memory_fts, rowid, search_subject, search_text)
  VALUES ('delete', old.id, old.search_subject, old.search_text);
  INSERT INTO semantic_memory_fts(rowid, search_subject, search_text) VALUES (new.id, new.search_subject, new.search_text);
END;

CREATE TABLE IF NOT EXISTS memory_tasks (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('memory_write', 'consolidation')),
  status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'failed')),
  payload_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  error_type TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS memory_tasks_status ON memory_tasks(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS consolidation_days (day TEXT PRIMARY KEY, task_id TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS consolidation_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL UNIQUE,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  total_batches INTEGER NOT NULL DEFAULT 0,
  completed_batches INTEGER NOT NULL DEFAULT 0,
  unresolved_conflicts INTEGER NOT NULL DEFAULT 0,
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

CREATE TABLE IF NOT EXISTS embedding_generations (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('building', 'active', 'failed', 'cancelled', 'interrupted')),
  profile_json TEXT NOT NULL,
  profile_hash TEXT NOT NULL,
  chunking_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  activated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS embedding_single_active_generation
ON embedding_generations(status) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS embedding_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  generation_id TEXT NOT NULL REFERENCES embedding_generations(id) ON DELETE CASCADE,
  corpus TEXT NOT NULL CHECK (corpus IN ('semantic', 'session')),
  source_id TEXT NOT NULL,
  session_id TEXT,
  anchor_message_id INTEGER,
  chunk_index INTEGER NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  estimated_tokens INTEGER NOT NULL,
  vector BLOB NOT NULL,
  UNIQUE(generation_id, corpus, source_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS embedding_chunks_generation_corpus
ON embedding_chunks(generation_id, corpus);
CREATE INDEX IF NOT EXISTS embedding_chunks_source
ON embedding_chunks(generation_id, corpus, source_id);

CREATE TABLE IF NOT EXISTS embedding_rebuilds (
  id TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL REFERENCES embedding_generations(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled', 'interrupted')),
  total_chunks INTEGER NOT NULL DEFAULT 0,
  processed_chunks INTEGER NOT NULL DEFAULT 0,
  error_type TEXT,
  error_message TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

-- 全库单调版本覆盖新增与删除，避免检索后并发新增造成重复；所有写入入口均由触发器递增。
CREATE TABLE IF NOT EXISTS semantic_clock (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL);
INSERT OR IGNORE INTO semantic_clock VALUES (1, 0);
CREATE TRIGGER IF NOT EXISTS semantic_clock_ai AFTER INSERT ON semantic_memory BEGIN
  UPDATE semantic_clock SET version=version+1 WHERE id=1;
END;
CREATE TRIGGER IF NOT EXISTS semantic_clock_au AFTER UPDATE ON semantic_memory BEGIN
  UPDATE semantic_clock SET version=version+1 WHERE id=1;
END;
CREATE TRIGGER IF NOT EXISTS semantic_clock_ad AFTER DELETE ON semantic_memory BEGIN
  UPDATE semantic_clock SET version=version+1 WHERE id=1;
END;
CREATE TABLE IF NOT EXISTS semantic_sources (
  memory_id INTEGER NOT NULL REFERENCES semantic_memory(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(memory_id, session_id, message_id)
);
CREATE TABLE IF NOT EXISTS memory_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_id INTEGER,
  reason_code TEXT NOT NULL,
  deleted_ids TEXT NOT NULL,
  evidence_ids TEXT NOT NULL,
  session_id TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS memory_changes_operation ON memory_changes(run_id, candidate_id);
CREATE INDEX IF NOT EXISTS memory_changes_run_action ON memory_changes(run_id, action);
`;
