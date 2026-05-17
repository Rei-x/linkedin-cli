// Live CLI integration. Gated on real cookies. Each test exercises one
// command path end-to-end against the real LinkedIn API and a fresh temp DB.
//
// Run with:
//   LINKEDIN_LI_AT=... LINKEDIN_JSESSIONID=... npx vitest run test/integration/cli.test.ts

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openDb } from "../../src/db/index.js";
import { auth as authRepo } from "../../src/db/repos.js";

import { command as statusCmd } from "../../src/commands/status.js";
import { command as syncCmd } from "../../src/commands/sync.js";
import { command as chatsCmd } from "../../src/commands/chats.js";

const live = process.env["LINKEDIN_LI_AT"] && process.env["LINKEDIN_JSESSIONID"];
const dscribe = live ? describe : describe.skip;

let dir: string;
let dbPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lkcli-live-"));
  dbPath = join(dir, "t.db");
  if (live) {
    const h = openDb(dbPath);
    const liAt = process.env["LINKEDIN_LI_AT"]!;
    const jsess = process.env["LINKEDIN_JSESSIONID"]!;
    authRepo.save(h.db, {
      liAt,
      jsessionid: jsess,
      csrfToken: `ajax:${jsess.replace(/^ajax:/, "")}`,
      profileUrn: "urn:li:fsd_profile:UNKNOWN",
      profileName: null,
      rawCookieHeader: `li_at=${liAt}; JSESSIONID="${jsess}"`,
      xLiTrack: null,
      xLiPageInstance: null,
    });
    h.close();
  }
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function captureStdout<T>(fn: () => Promise<T>): Promise<{ out: string; result: T }> {
  const original = process.stdout.write.bind(process.stdout);
  let buf = "";
  (process.stdout.write as unknown as (s: string | Uint8Array) => boolean) = (s) => {
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

async function callRun<A>(
  cmd: { run?: (ctx: { args: A; rawArgs: string[]; cmd: unknown }) => unknown },
  args: A,
): Promise<void> {
  if (!cmd.run) throw new Error("no run");
  await cmd.run({ args, rawArgs: [], cmd: {} });
}

dscribe("live CLI", () => {
  it("status emits JSON", async () => {
    const { out } = await captureStdout(() =>
      callRun(statusCmd, { db: dbPath, json: true, _: [] }),
    );
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed["loggedIn"]).toBe(true);
  });

  it(
    "sync pulls a page without erroring",
    async () => {
      await captureStdout(() =>
        callRun(syncCmd, {
          db: dbPath,
          json: true,
          "page-size": "5",
          "max-pages": "1",
          "messages-per-thread": "5",
          _: [],
        }),
      );
      expect(process.exitCode === 0 || process.exitCode === undefined).toBe(true);
    },
    60_000,
  );

  it(
    "chats --no-refresh lists what sync populated",
    async () => {
      const { out } = await captureStdout(() =>
        callRun(chatsCmd, {
          db: dbPath,
          json: true,
          "no-refresh": true,
          limit: "10",
          _: [],
        }),
      );
      const arr = JSON.parse(out) as unknown[];
      expect(Array.isArray(arr)).toBe(true);
    },
  );
});
