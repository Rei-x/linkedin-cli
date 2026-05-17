import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../../src/db/index.js";
import { messages, threads, type MessageRow, type ThreadRow } from "../../src/db/repos.js";

let dir: string;
let handle: ReturnType<typeof openDb>;

const T1 = "urn:li:msg_conversation:t1xxxxxxxx";
const T2 = "urn:li:msg_conversation:t2yyyyyyyy";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lkdb-"));
  handle = openDb(join(dir, "t.db"));
  const t: ThreadRow = {
    id: T1,
    title: null,
    participants: [],
    lastMsgPreview: null,
    lastMsgTs: null,
    unreadCount: 0,
    category: null,
    syncedAt: Date.now(),
  };
  threads.upsert(handle.db, t);
  threads.upsert(handle.db, { ...t, id: T2 });
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

function msg(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: "urn:li:msg:1",
    threadId: T1,
    senderUrn: "urn:li:fsd_profile:ME",
    senderName: "Me",
    body: "hello",
    ts: 1_000_000,
    deliveryState: "confirmed",
    originToken: null,
    rawJson: null,
    ...overrides,
  };
}

describe("messages repo", () => {
  it("insertPending throws on duplicate id", () => {
    messages.insertPending(handle.db, msg({ id: "urn:li:msg:dup", deliveryState: "local-pending" }));
    expect(() =>
      messages.insertPending(handle.db, msg({ id: "urn:li:msg:dup", deliveryState: "local-pending" }))
    ).toThrow();
  });

  it("upsert is idempotent", () => {
    messages.upsert(handle.db, msg({ id: "urn:li:msg:up1", body: "v1" }));
    messages.upsert(handle.db, msg({ id: "urn:li:msg:up1", body: "v2" }));
    const c = handle.db.prepare("SELECT COUNT(*) AS c FROM messages").get() as { c: number };
    expect(c.c).toBe(1);
    const list = messages.listByThread(handle.db, T1);
    expect(list[0]?.body).toBe("v2");
  });

  it("listByThread orders ASC by ts and respects before+limit", () => {
    messages.upsert(handle.db, msg({ id: "urn:li:msg:a", ts: 100, body: "a" }));
    messages.upsert(handle.db, msg({ id: "urn:li:msg:b", ts: 200, body: "b" }));
    messages.upsert(handle.db, msg({ id: "urn:li:msg:c", ts: 300, body: "c" }));
    messages.upsert(handle.db, msg({ id: "urn:li:msg:d", ts: 400, body: "d" }));

    const all = messages.listByThread(handle.db, T1);
    expect(all.map((m) => m.id)).toEqual([
      "urn:li:msg:a",
      "urn:li:msg:b",
      "urn:li:msg:c",
      "urn:li:msg:d",
    ]);

    const before = messages.listByThread(handle.db, T1, { before: 300 });
    expect(before.map((m) => m.id)).toEqual(["urn:li:msg:a", "urn:li:msg:b"]);

    const limited = messages.listByThread(handle.db, T1, { limit: 2 });
    expect(limited.length).toBe(2);

    const both = messages.listByThread(handle.db, T1, { before: 400, limit: 2 });
    expect(both.map((m) => m.id)).toEqual(["urn:li:msg:b", "urn:li:msg:c"]);
  });

  it("listByThread is scoped to threadId", () => {
    messages.upsert(handle.db, msg({ id: "urn:li:msg:t1a", threadId: T1, ts: 1, body: "in t1" }));
    messages.upsert(handle.db, msg({ id: "urn:li:msg:t2a", threadId: T2, ts: 2, body: "in t2" }));
    const list = messages.listByThread(handle.db, T1);
    expect(list.length).toBe(1);
    expect(list[0]?.body).toBe("in t1");
  });

  it("markDelivered transitions local-pending → confirmed and rewrites the id", () => {
    messages.insertPending(handle.db, msg({
      id: "local-temp-1",
      deliveryState: "local-pending",
      originToken: "tok-abc",
      ts: 500,
      body: "outgoing",
    }));
    messages.markDelivered(handle.db, "tok-abc", "urn:li:msg:server-1", 600);

    const list = messages.listByThread(handle.db, T1);
    expect(list.length).toBe(1);
    expect(list[0]?.id).toBe("urn:li:msg:server-1");
    expect(list[0]?.deliveryState).toBe("confirmed");
    expect(list[0]?.ts).toBe(600);
    expect(list[0]?.body).toBe("outgoing");
    expect(list[0]?.originToken).toBe("tok-abc");
  });

  it("markDelivered is a no-op if no pending row has the originToken", () => {
    expect(() =>
      messages.markDelivered(handle.db, "nope-token", "urn:li:msg:server-2", 999)
    ).not.toThrow();
    const list = messages.listByThread(handle.db, T1);
    expect(list.length).toBe(0);
  });

  it("search returns snippet with <b> tags", () => {
    messages.upsert(handle.db, msg({ id: "urn:li:msg:s1", body: "the quick brown fox jumps" }));
    const results = messages.search(handle.db, "quick");
    expect(results.length).toBe(1);
    expect(results[0]?.id).toBe("urn:li:msg:s1");
    expect(results[0]?.snippet).toMatch(/<b>quick<\/b>/i);
  });

  it("search scoped to threadId works", () => {
    messages.upsert(handle.db, msg({ id: "urn:li:msg:scoped1", threadId: T1, body: "needle in t1" }));
    messages.upsert(handle.db, msg({ id: "urn:li:msg:scoped2", threadId: T2, body: "needle in t2" }));
    const results = messages.search(handle.db, "needle", { threadId: T2 });
    expect(results.length).toBe(1);
    expect(results[0]?.id).toBe("urn:li:msg:scoped2");
  });

  it("search handles phrase queries", () => {
    messages.upsert(handle.db, msg({ id: "urn:li:msg:p1", body: "well hello world friends" }));
    messages.upsert(handle.db, msg({ id: "urn:li:msg:p2", body: "hello there, the world is wide" }));
    const results = messages.search(handle.db, '"hello world"');
    expect(results.length).toBe(1);
    expect(results[0]?.id).toBe("urn:li:msg:p1");
  });

  it("search respects limit", () => {
    for (let i = 0; i < 5; i++) {
      messages.upsert(handle.db, msg({ id: `urn:li:msg:lim${i}`, ts: i, body: `keyword ${i}` }));
    }
    const results = messages.search(handle.db, "keyword", { limit: 3 });
    expect(results.length).toBe(3);
  });
});
