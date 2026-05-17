import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../../src/db/index.js";
import { watermark } from "../../src/db/repos.js";

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

describe("watermark repo", () => {
  it("set + get round-trips", () => {
    watermark.set(handle.db, "conversations_sync_token", "tok-abc");
    expect(watermark.get(handle.db, "conversations_sync_token")).toBe("tok-abc");
  });

  it("set updates same key", () => {
    watermark.set(handle.db, "last_event_id", "evt-1");
    watermark.set(handle.db, "last_event_id", "evt-2");
    expect(watermark.get(handle.db, "last_event_id")).toBe("evt-2");
    const c = handle.db.prepare("SELECT COUNT(*) AS c FROM watermark WHERE key = ?").get("last_event_id") as { c: number };
    expect(c.c).toBe(1);
  });

  it("get unknown returns null", () => {
    expect(watermark.get(handle.db, "nonexistent")).toBeNull();
  });

  it("multiple keys coexist", () => {
    watermark.set(handle.db, "a", "1");
    watermark.set(handle.db, "b", "2");
    expect(watermark.get(handle.db, "a")).toBe("1");
    expect(watermark.get(handle.db, "b")).toBe("2");
  });
});
