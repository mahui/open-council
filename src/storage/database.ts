import Database from 'better-sqlite3';
import { setSchemaVersion } from './migration.js';

const CURRENT_SCHEMA_VERSION = 1;

export function initDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);

  // Enable WAL mode for concurrent read/write performance
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  // Check and execute migration
  migrate(db);

  return db;
}

function migrate(db: Database.Database): void {
  const version = db.pragma('user_version', { simple: true }) as number;

  if (version < 1) {
    db.exec(`
      -- Main sessions table
      CREATE TABLE IF NOT EXISTS sessions (
        session_id        TEXT PRIMARY KEY,
        question_hash     TEXT NOT NULL,
        question_normalized TEXT,
        question_preview  TEXT,
        synthesis_preview TEXT,
        mode              TEXT NOT NULL,
        resolved_mode     TEXT,
        status            TEXT NOT NULL,
        consensus_score   REAL,
        models_used       TEXT,
        created_at        TEXT NOT NULL,
        completed_at      TEXT,
        total_elapsed_ms  INTEGER,
        user_rating       INTEGER,
        parent_session_id TEXT,
        auto_suggested_mode TEXT,
        user_override_mode  TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_question_hash ON sessions(question_hash);
      CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
      CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_consensus ON sessions(consensus_score);
      CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_rating ON sessions(user_rating);

      -- FTS5 full-text index
      CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
        question_preview, synthesis_preview,
        content=sessions, content_rowid=rowid
      );

      -- FTS5 content-sync triggers (keep FTS in sync with sessions table)
      CREATE TRIGGER IF NOT EXISTS sessions_ai AFTER INSERT ON sessions BEGIN
        INSERT INTO sessions_fts(rowid, question_preview, synthesis_preview)
          VALUES (new.rowid, new.question_preview, new.synthesis_preview);
      END;
      CREATE TRIGGER IF NOT EXISTS sessions_ad AFTER DELETE ON sessions BEGIN
        INSERT INTO sessions_fts(sessions_fts, rowid, question_preview, synthesis_preview)
          VALUES ('delete', old.rowid, old.question_preview, old.synthesis_preview);
      END;
      CREATE TRIGGER IF NOT EXISTS sessions_au AFTER UPDATE ON sessions BEGIN
        INSERT INTO sessions_fts(sessions_fts, rowid, question_preview, synthesis_preview)
          VALUES ('delete', old.rowid, old.question_preview, old.synthesis_preview);
        INSERT INTO sessions_fts(rowid, question_preview, synthesis_preview)
          VALUES (new.rowid, new.question_preview, new.synthesis_preview);
      END;

      -- Session tags
      CREATE TABLE IF NOT EXISTS session_tags (
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        tag        TEXT NOT NULL,
        PRIMARY KEY (session_id, tag)
      );

      -- Model performance stats
      CREATE TABLE IF NOT EXISTS model_stats (
        session_id          TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        model_id            TEXT NOT NULL,
        invocation_mode     TEXT,
        avg_peer_score      REAL,
        was_chairman        INTEGER NOT NULL DEFAULT 0,
        was_devil_advocate  INTEGER NOT NULL DEFAULT 0,
        response_elapsed_ms INTEGER,
        token_usage_input   INTEGER,
        token_usage_output  INTEGER,
        PRIMARY KEY (session_id, model_id)
      );

      -- Concurrency scheduling (runtime state, safe to clear on startup)
      CREATE TABLE IF NOT EXISTS resource_slots (
        slot_id       INTEGER PRIMARY KEY AUTOINCREMENT,
        model_id      TEXT NOT NULL,
        pid           INTEGER NOT NULL,
        acquired_at   TEXT NOT NULL,
        resource_cost INTEGER NOT NULL DEFAULT 1
      );

      CREATE INDEX IF NOT EXISTS idx_resource_slots_model ON resource_slots(model_id);
      CREATE INDEX IF NOT EXISTS idx_resource_slots_pid ON resource_slots(pid);
    `);

    setSchemaVersion(db, CURRENT_SCHEMA_VERSION);
  }
}

export function closeDatabase(db: Database.Database): void {
  db.close();
}
