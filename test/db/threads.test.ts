import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../../src/db/index.js";
import { threads, type ThreadRow } from "../../src/db/repos.js";

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

function thread(overrides: Partial<ThreadRow> = {}): ThreadRow {
  return {
    id: "urn:li:msg_conversation:(urn:li:fsd_profile:ME,2-aaaa1111bbbb2222cccc3333dddd4444==)",
    title: null,
    participants: ["urn:li:fsd_profile:ME", "urn:li:fsd_profile:OTHER"],
    lastMsgPreview: null,
    lastMsgTs: null,
    unreadCount: 0,
    category: null,
    syncedAt: Date.now(),
    ...overrides,
  };
}

describe("threads repo", () => {
  it("upsert is idempotent on id", () => {
    threads.upsert(handle.db, thread({ id: "urn:li:msg_conversation:abc1234567", title: "first" }));
    threads.upsert(handle.db, thread({ id: "urn:li:msg_conversation:abc1234567", title: "second" }));
    const count = handle.db.prepare("SELECT COUNT(*) AS c FROM threads").get() as { c: number };
    expect(count.c).toBe(1);
    const row = threads.get(handle.db, "urn:li:msg_conversation:abc1234567");
    expect(row?.title).toBe("second");
  });

  it("get parses participants_json back into array", () => {
    const id = "urn:li:msg_conversation:xyz1111111";
    threads.upsert(handle.db, thread({ id, participants: ["urn:li:fsd_profile:A", "urn:li:fsd_profile:B"] }));
    const got = threads.get(handle.db, id);
    expect(got?.participants).toEqual(["urn:li:fsd_profile:A", "urn:li:fsd_profile:B"]);
  });

  it("get returns null when missing", () => {
    expect(threads.get(handle.db, "urn:li:msg_conversation:nope")).toBeNull();
  });

  it("list sorts by last_msg_ts DESC (nulls last)", () => {
    threads.upsert(handle.db, thread({ id: "urn:li:msg_conversation:t1aaaaaaaa", lastMsgTs: 100 }));
    threads.upsert(handle.db, thread({ id: "urn:li:msg_conversation:t2bbbbbbbb", lastMsgTs: 300 }));
    threads.upsert(handle.db, thread({ id: "urn:li:msg_conversation:t3cccccccc", lastMsgTs: 200 }));
    threads.upsert(handle.db, thread({ id: "urn:li:msg_conversation:t4dddddddd", lastMsgTs: null }));

    const list = threads.list(handle.db);
    expect(list.map((r) => r.id)).toEqual([
      "urn:li:msg_conversation:t2bbbbbbbb",
      "urn:li:msg_conversation:t3cccccccc",
      "urn:li:msg_conversation:t1aaaaaaaa",
      "urn:li:msg_conversation:t4dddddddd",
    ]);
  });

  it("list respects limit", () => {
    for (let i = 0; i < 5; i++) {
      threads.upsert(handle.db, thread({ id: `urn:li:msg_conversation:limit${i}xxxx`, lastMsgTs: 1000 - i }));
    }
    const list = threads.list(handle.db, { limit: 2 });
    expect(list.length).toBe(2);
  });

  it("list unreadOnly filters", () => {
    threads.upsert(handle.db, thread({ id: "urn:li:msg_conversation:unr1aaaaaa", unreadCount: 0, lastMsgTs: 1 }));
    threads.upsert(handle.db, thread({ id: "urn:li:msg_conversation:unr2bbbbbb", unreadCount: 2, lastMsgTs: 2 }));
    threads.upsert(handle.db, thread({ id: "urn:li:msg_conversation:unr3cccccc", unreadCount: 0, lastMsgTs: 3 }));

    const list = threads.list(handle.db, { unreadOnly: true });
    expect(list.length).toBe(1);
    expect(list[0]?.id).toBe("urn:li:msg_conversation:unr2bbbbbb");
  });

  it("findByIdOrPrefix matches full id", () => {
    const id = "urn:li:msg_conversation:fullid12345678";
    threads.upsert(handle.db, thread({ id }));
    const row = threads.findByIdOrPrefix(handle.db, id);
    expect(row?.id).toBe(id);
  });

  it("findByIdOrPrefix matches unique 4+char prefix of last colon segment", () => {
    threads.upsert(handle.db, thread({ id: "urn:li:msg_conversation:abcdef1234" }));
    threads.upsert(handle.db, thread({ id: "urn:li:msg_conversation:xyz9876543" }));
    const row = threads.findByIdOrPrefix(handle.db, "abcd");
    expect(row?.id).toBe("urn:li:msg_conversation:abcdef1234");
  });

  it("findByIdOrPrefix returns null on ambiguity", () => {
    threads.upsert(handle.db, thread({ id: "urn:li:msg_conversation:dup123aaaa" }));
    threads.upsert(handle.db, thread({ id: "urn:li:msg_conversation:dup123bbbb" }));
    expect(threads.findByIdOrPrefix(handle.db, "dup1")).toBeNull();
  });

  it("findByIdOrPrefix returns null when prefix < 4 chars", () => {
    threads.upsert(handle.db, thread({ id: "urn:li:msg_conversation:zzzzzzzzzz" }));
    expect(threads.findByIdOrPrefix(handle.db, "zzz")).toBeNull();
    expect(threads.findByIdOrPrefix(handle.db, "z")).toBeNull();
  });

  it("findByIdOrPrefix returns null when prefix matches nothing", () => {
    threads.upsert(handle.db, thread({ id: "urn:li:msg_conversation:realid1234" }));
    expect(threads.findByIdOrPrefix(handle.db, "nope")).toBeNull();
  });

  it("markRead zeroes unread_count", () => {
    const id = "urn:li:msg_conversation:read12345a";
    threads.upsert(handle.db, thread({ id, unreadCount: 7 }));
    threads.markRead(handle.db, id);
    expect(threads.get(handle.db, id)?.unreadCount).toBe(0);
  });
});
