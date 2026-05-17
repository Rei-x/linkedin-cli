import Database from "better-sqlite3";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { applyMigrations } from "./schema.js";

export interface DbHandle {
  db: Database.Database;
  close: () => void;
}

export function openDb(path: string): DbHandle {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  applyMigrations(db);
  return {
    db,
    close: () => db.close(),
  };
}
