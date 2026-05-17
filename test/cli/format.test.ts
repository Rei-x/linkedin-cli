import { describe, expect, it } from "vitest";

import {
  colorize,
  fmtRelativeTime,
  shortThreadId,
  truncate,
  padRight,
  displayName,
} from "../../src/commands/_shared.js";

describe("fmtRelativeTime", () => {
  const NOW = new Date("2026-05-15T12:00:00Z").getTime();

  it('returns "now" for <1min', () => {
    expect(fmtRelativeTime(NOW - 30_000, NOW)).toBe("now");
    expect(fmtRelativeTime(NOW, NOW)).toBe("now");
  });

  it('returns "Xm ago" for <60min', () => {
    expect(fmtRelativeTime(NOW - 5 * 60_000, NOW)).toBe("5m ago");
    expect(fmtRelativeTime(NOW - 59 * 60_000, NOW)).toBe("59m ago");
  });

  it('returns "Xh ago" for <24h', () => {
    expect(fmtRelativeTime(NOW - 2 * 60 * 60_000, NOW)).toBe("2h ago");
    expect(fmtRelativeTime(NOW - 23 * 60 * 60_000, NOW)).toBe("23h ago");
  });

  it('returns "yday" for <2d', () => {
    expect(fmtRelativeTime(NOW - 25 * 60 * 60_000, NOW)).toBe("yday");
  });

  it("returns weekday for <7d", () => {
    // 3 days before 2026-05-15 (Fri) is 2026-05-12 (Tue).
    const ts = NOW - 3 * 24 * 60 * 60_000;
    const out = fmtRelativeTime(ts, NOW);
    expect(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]).toContain(out);
  });

  it("returns Month Day for older than a week", () => {
    const ts = new Date("2026-03-14T10:00:00Z").getTime();
    const out = fmtRelativeTime(ts, NOW);
    expect(out).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
  });
});

describe("colorize", () => {
  it("identity functions when noColor=true", () => {
    const c = colorize(true);
    expect(c.bold("x")).toBe("x");
    expect(c.dim("x")).toBe("x");
    expect(c.cyan("x")).toBe("x");
    expect(c.senderColor("alice")("x")).toBe("x");
  });

  it("senderColor is stable for the same key", () => {
    const c = colorize(false);
    const a1 = c.senderColor("alice")("hello");
    const a2 = c.senderColor("alice")("hello");
    expect(a1).toBe(a2);
  });

  it("senderColor differs for different keys (best effort)", () => {
    const c = colorize(false);
    // Different keys should USUALLY hash differently — sample many to make
    // collisions vanishingly unlikely without depending on a specific palette.
    const samples = new Set<string>();
    for (let i = 0; i < 12; i++) {
      samples.add(c.senderColor(`name-${i}`)("x"));
    }
    expect(samples.size).toBeGreaterThan(1);
  });
});

describe("shortThreadId", () => {
  it("takes first 7 chars of the conversation local id for simple URNs", () => {
    expect(shortThreadId("urn:li:msg_conversation:abcdef1234")).toBe("abcdef1");
  });

  it("extracts the variable tail from a compound URN, dropping the mailbox prefix", () => {
    // The "2-" prefix is shared across threads — slice from the variable bytes.
    expect(
      shortThreadId(
        "urn:li:msg_conversation:(urn:li:fsdProfile:ME,2-aaaa1111bbbb2222cccc3333dddd4444==)",
      ),
    ).toBe("aaaa111");
  });

  it("returns no more than 7 chars", () => {
    expect(
      shortThreadId(
        "urn:li:msg_conversation:(urn:li:fsdProfile:ME,2-NDU4N2VjMjctNGNiZi00NjA2LWE0M2EtMGE3NjFlOWY1NWYzXzAxMA==)",
      ).length,
    ).toBeLessThanOrEqual(7);
  });
});

describe("truncate / padRight", () => {
  it("truncate adds ellipsis when over width", () => {
    expect(truncate("hello world", 5)).toBe("hell…");
    expect(truncate("ok", 10)).toBe("ok");
  });
  it("padRight extends with spaces", () => {
    expect(padRight("ok", 5)).toBe("ok   ");
    expect(padRight("hello", 3)).toBe("hello");
  });
});

describe("displayName", () => {
  it("returns single name when one other participant", () => {
    expect(
      displayName(
        [
          { urn: "urn:li:fsd_profile:SELF" },
          { urn: "urn:li:fsd_profile:ALICE", firstName: "Alice", lastName: "Nguyen" },
        ],
        "urn:li:fsd_profile:SELF",
      ),
    ).toBe("Alice Nguyen");
  });

  it("returns first plus +N for groups", () => {
    expect(
      displayName(
        [
          { urn: "urn:li:fsd_profile:SELF" },
          { urn: "urn:li:fsd_profile:A", firstName: "Alice" },
          { urn: "urn:li:fsd_profile:B", firstName: "Bob" },
          { urn: "urn:li:fsd_profile:C", firstName: "Carl" },
        ],
        "urn:li:fsd_profile:SELF",
      ),
    ).toBe("Alice +2");
  });

  it("returns (you) when alone", () => {
    expect(displayName([{ urn: "urn:li:fsd_profile:SELF" }], "urn:li:fsd_profile:SELF")).toBe("(you)");
  });
});
