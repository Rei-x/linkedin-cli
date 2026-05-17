import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../../src/db/index.js";
import { auth, type AuthRow } from "../../src/db/repos.js";

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

function sample(overrides: Partial<AuthRow> = {}): Omit<AuthRow, "createdAt" | "validatedAt"> & { createdAt?: number; validatedAt?: number } {
  return {
    liAt: "li_at_value",
    jsessionid: "ajax:1234",
    csrfToken: "ajax:1234",
    profileUrn: "urn:li:fsd_profile:ABC",
    profileName: "John Doe",
    rawCookieHeader: "li_at=li_at_value; JSESSIONID=ajax:1234",
    xLiTrack: "{}",
    xLiPageInstance: "page-1",
    ...overrides,
  };
}

describe("auth repo", () => {
  it("save + get round-trips", () => {
    auth.save(handle.db, sample({ createdAt: 100, validatedAt: 200 }));
    const row = auth.get(handle.db);
    expect(row).not.toBeNull();
    expect(row!.liAt).toBe("li_at_value");
    expect(row!.jsessionid).toBe("ajax:1234");
    expect(row!.csrfToken).toBe("ajax:1234");
    expect(row!.profileUrn).toBe("urn:li:fsd_profile:ABC");
    expect(row!.profileName).toBe("John Doe");
    expect(row!.rawCookieHeader).toContain("li_at_value");
    expect(row!.xLiTrack).toBe("{}");
    expect(row!.xLiPageInstance).toBe("page-1");
    expect(row!.createdAt).toBe(100);
    expect(row!.validatedAt).toBe(200);
  });

  it("get returns null when empty", () => {
    expect(auth.get(handle.db)).toBeNull();
  });

  it("second save replaces first (still one row)", () => {
    auth.save(handle.db, sample({ liAt: "first" }));
    auth.save(handle.db, sample({ liAt: "second" }));
    const count = handle.db.prepare("SELECT COUNT(*) AS c FROM auth").get() as { c: number };
    expect(count.c).toBe(1);
    expect(auth.get(handle.db)!.liAt).toBe("second");
  });

  it("clear empties the table", () => {
    auth.save(handle.db, sample());
    auth.clear(handle.db);
    expect(auth.get(handle.db)).toBeNull();
  });

  it("touchValidated updates timestamp without touching cookies", () => {
    auth.save(handle.db, sample({ createdAt: 100, validatedAt: 200, liAt: "ORIG" }));
    auth.touchValidated(handle.db, 999);
    const row = auth.get(handle.db)!;
    expect(row.validatedAt).toBe(999);
    expect(row.createdAt).toBe(100);
    expect(row.liAt).toBe("ORIG");
  });

  it("save uses defaults for createdAt/validatedAt if not provided", () => {
    const before = Date.now();
    auth.save(handle.db, sample());
    const after = Date.now();
    const row = auth.get(handle.db)!;
    expect(row.createdAt).toBeGreaterThanOrEqual(before);
    expect(row.createdAt).toBeLessThanOrEqual(after);
    expect(row.validatedAt).toBeGreaterThanOrEqual(before);
  });
});
