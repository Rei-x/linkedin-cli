// End-to-end style: drive each citty command via its exported `run` against a
// real temp SQLite DB. No mocking. Commands that need network are exercised
// only at the "wiring" level — we ensure their `run` function exists and
// argument shape is sound.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openDb } from "../../src/db/index.js";
import {
  auth as authRepo,
  messages as messagesRepo,
  participants as partsRepo,
  threads as threadsRepo,
} from "../../src/db/repos.js";

import { command as statusCmd } from "../../src/commands/status.js";
import { command as chatsCmd } from "../../src/commands/chats.js";
import { command as readCmd } from "../../src/commands/read.js";
import { command as searchCmd } from "../../src/commands/search.js";
import { command as logoutCmd } from "../../src/commands/logout.js";
import { command as contactsCmd } from "../../src/commands/contacts.js";
import { command as composeCmd } from "../../src/commands/compose.js";
import { command as sendCmd } from "../../src/commands/send.js";
import { command as markReadCmd } from "../../src/commands/mark-read.js";
import { command as syncCmd } from "../../src/commands/sync.js";
import { command as loginCmd } from "../../src/commands/login.js";
import { command as watchCmd } from "../../src/commands/watch.js";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lkcli-"));
  dbPath = join(dir, "t.db");
  // Seed the DB upfront so commands can find their state file.
  const h = openDb(dbPath);
  h.close();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  // Reset any exit code our error mapper may have left behind.
  process.exitCode = 0;
});

// ────────────────────────────────────────────────────────────────────────────
// Small stdout-capture helper. Replaces the underlying write with a buffer
// for the duration of the callback. Restored even when the callback throws.
// ────────────────────────────────────────────────────────────────────────────

async function captureStdout<T>(fn: () => Promise<T>): Promise<{ out: string; result: T }> {
  const original = process.stdout.write.bind(process.stdout);
  let buf = "";
  (process.stdout.write as unknown as (s: string | Uint8Array) => boolean) = (
    s: string | Uint8Array,
  ) => {
    buf += typeof s === "string" ? s : Buffer.from(s).toString("utf8");
    return true;
  };
  try {
    const result = await fn();
    return { out: buf, result };
  } finally {
    process.stdout.write = original;
  }
}

async function captureStderr<T>(fn: () => Promise<T>): Promise<{ err: string; result: T }> {
  const original = process.stderr.write.bind(process.stderr);
  let buf = "";
  (process.stderr.write as unknown as (s: string | Uint8Array) => boolean) = (
    s: string | Uint8Array,
  ) => {
    buf += typeof s === "string" ? s : Buffer.from(s).toString("utf8");
    return true;
  };
  try {
    const result = await fn();
    return { err: buf, result };
  } finally {
    process.stderr.write = original;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Seed helpers
// ────────────────────────────────────────────────────────────────────────────

function seedAuth(path: string): void {
  const h = openDb(path);
  authRepo.save(h.db, {
    liAt: "test-li-at",
    jsessionid: "ajax:12345",
    csrfToken: "ajax:12345",
    profileUrn: "urn:li:fsd_profile:SELF",
    profileName: "Test User",
    rawCookieHeader: 'li_at=test-li-at; JSESSIONID="ajax:12345"',
    xLiTrack: null,
    xLiPageInstance: null,
  });
  h.close();
}

function seedThreadsAndMessages(path: string): void {
  const h = openDb(path);
  const now = Date.now();
  threadsRepo.upsert(h.db, {
    id: "urn:li:msg_conversation:alice12345",
    title: null,
    participants: ["urn:li:fsd_profile:SELF", "urn:li:fsd_profile:ALICE"],
    lastMsgPreview: "hey are we still on for thursday?",
    lastMsgTs: now - 2 * 60 * 60_000,
    unreadCount: 0,
    category: "PRIMARY_INBOX",
    syncedAt: now,
  });
  threadsRepo.upsert(h.db, {
    id: "urn:li:msg_conversation:bob1234567",
    title: null,
    participants: ["urn:li:fsd_profile:SELF", "urn:li:fsd_profile:BOB"],
    lastMsgPreview: "sent you the doc",
    lastMsgTs: now - 25 * 60 * 60_000,
    unreadCount: 3,
    category: "PRIMARY_INBOX",
    syncedAt: now,
  });
  partsRepo.upsert(h.db, {
    urn: "urn:li:fsd_profile:ALICE",
    name: "Alice Nguyen",
    headline: "Engineer",
    publicIdentifier: "alice-nguyen",
    pictureUrl: null,
    updatedAt: now,
  });
  partsRepo.upsert(h.db, {
    urn: "urn:li:fsd_profile:BOB",
    name: "Bob Patel",
    headline: null,
    publicIdentifier: "bob-patel",
    pictureUrl: null,
    updatedAt: now,
  });

  messagesRepo.upsert(h.db, {
    id: "urn:li:msg_message:1",
    threadId: "urn:li:msg_conversation:alice12345",
    senderUrn: "urn:li:fsd_profile:ALICE",
    senderName: "Alice Nguyen",
    body: "hey are we still on for thursday?",
    ts: now - 2 * 60 * 60_000,
    deliveryState: "confirmed",
    originToken: null,
    rawJson: null,
  });
  messagesRepo.upsert(h.db, {
    id: "urn:li:msg_message:2",
    threadId: "urn:li:msg_conversation:alice12345",
    senderUrn: "urn:li:fsd_profile:SELF",
    senderName: "Test User",
    body: "yep, 3pm works",
    ts: now - 1 * 60 * 60_000,
    deliveryState: "confirmed",
    originToken: null,
    rawJson: null,
  });
  messagesRepo.upsert(h.db, {
    id: "urn:li:msg_message:3",
    threadId: "urn:li:msg_conversation:bob1234567",
    senderUrn: "urn:li:fsd_profile:BOB",
    senderName: "Bob Patel",
    body: "hello there friend",
    ts: now - 24 * 60 * 60_000,
    deliveryState: "confirmed",
    originToken: null,
    rawJson: null,
  });
  h.close();
}

// Citty's `run` function signature; we synthesize the context shape it'd
// hand a command.
async function callRun<A>(
  cmd: { run?: (ctx: { args: A; rawArgs: string[]; cmd: unknown }) => unknown },
  args: A,
): Promise<void> {
  if (!cmd.run) throw new Error("command has no run");
  await cmd.run({ args, rawArgs: [], cmd: {} });
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe("status command", () => {
  it("emits JSON with seeded auth + cache counts", async () => {
    seedAuth(dbPath);
    seedThreadsAndMessages(dbPath);

    const { out } = await captureStdout(() =>
      callRun(statusCmd, { db: dbPath, json: true, _: [] }),
    );

    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed["loggedIn"]).toBe(true);
    expect(parsed["profileUrn"]).toBe("urn:li:fsd_profile:SELF");
    expect(parsed["threads"]).toBe(2);
    expect(parsed["messages"]).toBe(3);
  });

  it("reports not-logged-in cleanly when no auth row exists", async () => {
    const { out } = await captureStdout(() =>
      callRun(statusCmd, { db: dbPath, json: true, _: [] }),
    );
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed["loggedIn"]).toBe(false);
  });
});

describe("chats command", () => {
  it("returns seeded threads in last_msg_ts DESC order with --no-refresh", async () => {
    seedAuth(dbPath);
    seedThreadsAndMessages(dbPath);

    const { out } = await captureStdout(() =>
      callRun(chatsCmd, {
        db: dbPath,
        json: true,
        "no-refresh": true,
        limit: "10",
        _: [],
      }),
    );
    const arr = JSON.parse(out) as Array<{ id: string }>;
    expect(arr.length).toBe(2);
    expect(arr[0]?.id).toBe("urn:li:msg_conversation:alice12345");
    expect(arr[1]?.id).toBe("urn:li:msg_conversation:bob1234567");
  });

  it("--unread filters", async () => {
    seedAuth(dbPath);
    seedThreadsAndMessages(dbPath);
    const { out } = await captureStdout(() =>
      callRun(chatsCmd, {
        db: dbPath,
        json: true,
        "no-refresh": true,
        unread: true,
        _: [],
      }),
    );
    const arr = JSON.parse(out) as Array<{ id: string; unreadCount: number }>;
    expect(arr.length).toBe(1);
    expect(arr[0]?.id).toBe("urn:li:msg_conversation:bob1234567");
  });
});

describe("read command", () => {
  it("returns cached messages oldest-first with --no-refresh", async () => {
    seedAuth(dbPath);
    seedThreadsAndMessages(dbPath);
    const { out } = await captureStdout(() =>
      callRun(readCmd, {
        db: dbPath,
        json: true,
        "no-refresh": true,
        thread: "alice12345",
        _: [],
      }),
    );
    const arr = JSON.parse(out) as Array<{ id: string; ts: number; body: string }>;
    expect(arr.length).toBe(2);
    expect(arr[0]?.body).toBe("hey are we still on for thursday?");
    expect(arr[1]?.body).toBe("yep, 3pm works");
    expect(arr[0]!.ts).toBeLessThan(arr[1]!.ts);
  });

  it("resolves by 4+ char prefix", async () => {
    seedAuth(dbPath);
    seedThreadsAndMessages(dbPath);
    const { out } = await captureStdout(() =>
      callRun(readCmd, {
        db: dbPath,
        json: true,
        "no-refresh": true,
        thread: "alice",
        _: [],
      }),
    );
    const arr = JSON.parse(out) as Array<unknown>;
    expect(arr.length).toBe(2);
  });

  it("fails cleanly for an unknown thread", async () => {
    seedAuth(dbPath);
    seedThreadsAndMessages(dbPath);
    const { err } = await captureStderr(() =>
      callRun(readCmd, {
        db: dbPath,
        json: true,
        "no-refresh": true,
        thread: "nope1234",
        _: [],
      }),
    );
    expect(err).toContain("No thread matches");
    expect(process.exitCode).not.toBe(0);
  });
});

describe("search command", () => {
  it("finds a seeded message", async () => {
    seedAuth(dbPath);
    seedThreadsAndMessages(dbPath);
    const { out } = await captureStdout(() =>
      callRun(searchCmd, {
        db: dbPath,
        json: true,
        query: "thursday",
        _: [],
      }),
    );
    const arr = JSON.parse(out) as Array<{ body: string; snippet: string }>;
    expect(arr.length).toBeGreaterThan(0);
    expect(arr[0]?.body).toContain("thursday");
    expect(arr[0]?.snippet).toContain("<b>");
  });

  it("scopes by --thread", async () => {
    seedAuth(dbPath);
    seedThreadsAndMessages(dbPath);
    const { out } = await captureStdout(() =>
      callRun(searchCmd, {
        db: dbPath,
        json: true,
        query: "hello",
        thread: "bob1234567",
        _: [],
      }),
    );
    const arr = JSON.parse(out) as Array<{ threadId: string }>;
    expect(arr.length).toBe(1);
    expect(arr[0]?.threadId).toBe("urn:li:msg_conversation:bob1234567");
  });
});

describe("logout command", () => {
  it("clears auth and data tables (default)", async () => {
    seedAuth(dbPath);
    seedThreadsAndMessages(dbPath);
    await captureStdout(() => callRun(logoutCmd, { db: dbPath, json: true, _: [] }));

    const h = openDb(dbPath);
    try {
      expect(authRepo.get(h.db)).toBeNull();
      const tc = (h.db.prepare("SELECT COUNT(*) AS c FROM threads").get() as { c: number }).c;
      const mc = (h.db.prepare("SELECT COUNT(*) AS c FROM messages").get() as { c: number }).c;
      const pc = (h.db.prepare("SELECT COUNT(*) AS c FROM participants").get() as { c: number }).c;
      expect(tc).toBe(0);
      expect(mc).toBe(0);
      expect(pc).toBe(0);
    } finally {
      h.close();
    }
  });

  it("keeps the cache when --keep-cache is passed", async () => {
    seedAuth(dbPath);
    seedThreadsAndMessages(dbPath);
    await captureStdout(() =>
      callRun(logoutCmd, { db: dbPath, json: true, "keep-cache": true, _: [] }),
    );

    const h = openDb(dbPath);
    try {
      expect(authRepo.get(h.db)).toBeNull();
      const tc = (h.db.prepare("SELECT COUNT(*) AS c FROM threads").get() as { c: number }).c;
      expect(tc).toBe(2);
    } finally {
      h.close();
    }
  });
});

describe("contacts command", () => {
  it("lists cached participants in JSON", async () => {
    seedThreadsAndMessages(dbPath);
    const { out } = await captureStdout(() =>
      callRun(contactsCmd, { db: dbPath, json: true, _: [] }),
    );
    const arr = JSON.parse(out) as Array<{ name: string }>;
    expect(arr.length).toBe(2);
    expect(arr.map((p) => p.name).sort()).toEqual(["Alice Nguyen", "Bob Patel"]);
  });

  it("filters by --search", async () => {
    seedThreadsAndMessages(dbPath);
    const { out } = await captureStdout(() =>
      callRun(contactsCmd, { db: dbPath, json: true, search: "alice", _: [] }),
    );
    const arr = JSON.parse(out) as Array<{ name: string }>;
    expect(arr.length).toBe(1);
    expect(arr[0]?.name).toBe("Alice Nguyen");
  });
});

describe("compose unknown recipient", () => {
  it("exits 4 when handle isn't cached", async () => {
    seedAuth(dbPath);
    const { err } = await captureStderr(() =>
      callRun(composeCmd, {
        db: dbPath,
        json: true,
        recipient: "nobody-cached",
        message: "hi",
        _: [],
      }),
    );
    expect(err).toContain("Unknown recipient");
    expect(process.exitCode).toBe(4);
  });
});

describe("auth-required commands without auth", () => {
  it("send exits 2 when not logged in", async () => {
    const { err } = await captureStderr(() =>
      callRun(sendCmd, {
        db: dbPath,
        json: true,
        thread: "alice1234",
        message: "hi",
        _: [],
      }),
    );
    expect(err).toContain("login");
    expect(process.exitCode).toBe(2);
  });

  it("mark-read exits 2 when not logged in", async () => {
    const { err } = await captureStderr(() =>
      callRun(markReadCmd, {
        db: dbPath,
        json: true,
        thread: "alice1234",
        _: [],
      }),
    );
    expect(err).toContain("login");
    expect(process.exitCode).toBe(2);
  });

  it("sync exits 2 when not logged in", async () => {
    const { err } = await captureStderr(() =>
      callRun(syncCmd, { db: dbPath, json: true, _: [] }),
    );
    expect(err).toContain("login");
    expect(process.exitCode).toBe(2);
  });
});

describe("command registry", () => {
  it("all commands expose a `run` function", () => {
    for (const cmd of [
      statusCmd,
      chatsCmd,
      readCmd,
      searchCmd,
      logoutCmd,
      contactsCmd,
      composeCmd,
      sendCmd,
      markReadCmd,
      syncCmd,
      loginCmd,
      watchCmd,
    ]) {
      expect(typeof cmd.run).toBe("function");
    }
  });
});
