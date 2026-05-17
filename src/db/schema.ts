import type Database from "better-sqlite3";

const CURRENT_USER_VERSION = 1;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS auth (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  li_at               TEXT    NOT NULL,
  jsessionid          TEXT    NOT NULL,
  csrf_token          TEXT    NOT NULL,
  profile_urn         TEXT    NOT NULL,
  profile_name        TEXT,
  raw_cookie_header   TEXT    NOT NULL,
  x_li_track          TEXT,
  x_li_page_instance  TEXT,
  created_at          INTEGER NOT NULL,
  validated_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS threads (
  id                 TEXT PRIMARY KEY,
  title              TEXT,
  participants_json  TEXT    NOT NULL,
  last_msg_preview   TEXT,
  last_msg_ts        INTEGER,
  unread_count       INTEGER NOT NULL DEFAULT 0,
  category           TEXT,
  synced_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_threads_last_msg_ts ON threads(last_msg_ts DESC);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  thread_id       TEXT    NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  sender_urn      TEXT    NOT NULL,
  sender_name     TEXT,
  body            TEXT    NOT NULL,
  ts              INTEGER NOT NULL,
  delivery_state  TEXT    NOT NULL CHECK (delivery_state IN ('local-pending','sent','confirmed','failed')),
  origin_token    TEXT,
  raw_json        TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_thread_ts ON messages(thread_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_messages_ts        ON messages(ts DESC);

CREATE TABLE IF NOT EXISTS participants (
  urn                TEXT PRIMARY KEY,
  name               TEXT    NOT NULL,
  headline           TEXT,
  public_identifier  TEXT,
  picture_url        TEXT,
  updated_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS watermark (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  body,
  content='messages',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, body) VALUES (new.rowid, new.body);
END;

CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body) VALUES('delete', old.rowid, old.body);
END;

CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body) VALUES('delete', old.rowid, old.body);
  INSERT INTO messages_fts(rowid, body) VALUES (new.rowid, new.body);
END;
`;

export function applyMigrations(db: Database.Database): void {
  db.exec(SCHEMA_SQL);
  db.pragma(`user_version = ${CURRENT_USER_VERSION}`);
}
