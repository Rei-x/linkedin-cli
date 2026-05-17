import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../../src/db/index.js";
import { applyMigrations } from "../../src/db/schema.js";

let dir: string;
let handle: ReturnType<typeof openDb>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lkdb-"));
  handle = openDb(join(dir, "t.db"));
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("schema", () => {
  it("applyMigrations is idempotent", () => {
    // Already called once via openDb; calling again should not throw.
    expect(() => applyMigrations(handle.db)).not.toThrow();
    expect(() => applyMigrations(handle.db)).not.toThrow();
  });

  it("creates all required tables", () => {
    const rows = handle.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name"
      )
      .all() as Array<{ name: string }>;
    const names = rows.map((r) => r.name);
    expect(names).toContain("auth");
    expect(names).toContain("threads");
    expect(names).toContain("messages");
    expect(names).toContain("participants");
    expect(names).toContain("watermark");
    expect(names).toContain("messages_fts");
  });

  it("enables foreign keys (insert message with bogus thread_id throws)", () => {
    const stmt = handle.db.prepare(
      "INSERT INTO messages (id, thread_id, sender_urn, sender_name, body, ts, delivery_state, origin_token, raw_json) VALUES (?,?,?,?,?,?,?,?,?)"
    );
    expect(() =>
      stmt.run(
        "urn:li:msg:1",
        "urn:li:thread:does-not-exist",
        "urn:li:fsd_profile:abc",
        "Test User",
        "hello",
        Date.now(),
        "confirmed",
        null,
        null
      )
    ).toThrow(/FOREIGN KEY/i);
  });

  it("FTS triggers fire on insert and delete", () => {
    handle.db
      .prepare(
        "INSERT INTO threads (id, title, participants_json, last_msg_preview, last_msg_ts, unread_count, category, synced_at) VALUES (?,?,?,?,?,?,?,?)"
      )
      .run(
        "urn:li:thread:1",
        "Test",
        JSON.stringify([]),
        null,
        null,
        0,
        null,
        Date.now()
      );

    handle.db
      .prepare(
        "INSERT INTO messages (id, thread_id, sender_urn, sender_name, body, ts, delivery_state, origin_token, raw_json) VALUES (?,?,?,?,?,?,?,?,?)"
      )
      .run(
        "urn:li:msg:1",
        "urn:li:thread:1",
        "urn:li:fsd_profile:abc",
        null,
        "hello world from FTS",
        Date.now(),
        "confirmed",
        null,
        null
      );

    const matched = handle.db
      .prepare(
        "SELECT m.id FROM messages_fts f JOIN messages m ON m.rowid = f.rowid WHERE messages_fts MATCH ?"
      )
      .all("hello") as Array<{ id: string }>;
    expect(matched.length).toBe(1);
    expect(matched[0]?.id).toBe("urn:li:msg:1");

    handle.db.prepare("DELETE FROM messages WHERE id = ?").run("urn:li:msg:1");
    const afterDel = handle.db
      .prepare(
        "SELECT m.id FROM messages_fts f JOIN messages m ON m.rowid = f.rowid WHERE messages_fts MATCH ?"
      )
      .all("hello");
    expect(afterDel.length).toBe(0);
  });

  it("bumps PRAGMA user_version", () => {
    const v = handle.db.pragma("user_version", { simple: true });
    expect(Number(v)).toBeGreaterThan(0);
  });

  it("enables WAL journal mode", () => {
    const mode = handle.db.pragma("journal_mode", { simple: true });
    expect(String(mode).toLowerCase()).toBe("wal");
  });
});
