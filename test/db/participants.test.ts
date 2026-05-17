import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../../src/db/index.js";
import { participants, type ParticipantRow } from "../../src/db/repos.js";

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

function p(overrides: Partial<ParticipantRow> = {}): ParticipantRow {
  return {
    urn: "urn:li:fsd_profile:ABC",
    name: "Alice Anderson",
    headline: "Engineer",
    publicIdentifier: "alice-a",
    pictureUrl: null,
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("participants repo", () => {
  it("upsert idempotent", () => {
    participants.upsert(handle.db, p({ urn: "urn:li:fsd_profile:X", name: "first" }));
    participants.upsert(handle.db, p({ urn: "urn:li:fsd_profile:X", name: "second" }));
    const count = handle.db.prepare("SELECT COUNT(*) AS c FROM participants").get() as { c: number };
    expect(count.c).toBe(1);
    expect(participants.get(handle.db, "urn:li:fsd_profile:X")?.name).toBe("second");
  });

  it("get returns null when missing", () => {
    expect(participants.get(handle.db, "urn:li:fsd_profile:missing")).toBeNull();
  });

  it("list with search filters by name LIKE", () => {
    participants.upsert(handle.db, p({ urn: "urn:li:fsd_profile:1", name: "Alice Anderson" }));
    participants.upsert(handle.db, p({ urn: "urn:li:fsd_profile:2", name: "Bob Brown" }));
    participants.upsert(handle.db, p({ urn: "urn:li:fsd_profile:3", name: "Alicia Alvarez" }));
    const list = participants.list(handle.db, { search: "Ali" });
    const names = list.map((r) => r.name).sort();
    expect(names).toEqual(["Alice Anderson", "Alicia Alvarez"]);
  });

  it("list honors limit", () => {
    for (let i = 0; i < 5; i++) {
      participants.upsert(handle.db, p({ urn: `urn:li:fsd_profile:lim${i}`, name: `User ${i}` }));
    }
    const list = participants.list(handle.db, { limit: 2 });
    expect(list.length).toBe(2);
  });

  it("list returns all when no opts", () => {
    participants.upsert(handle.db, p({ urn: "urn:li:fsd_profile:a", name: "A" }));
    participants.upsert(handle.db, p({ urn: "urn:li:fsd_profile:b", name: "B" }));
    const list = participants.list(handle.db);
    expect(list.length).toBe(2);
  });
});
