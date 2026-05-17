import { describe, expect, it } from "vitest";
import { CookieStore } from "../../src/voyager/cookies.js";

describe("CookieStore.fromHeader", () => {
  it("parses a multi-cookie header and extracts named values", () => {
    const store = CookieStore.fromHeader(
      'li_at=abc; JSESSIONID="ajax:123"',
    );
    expect(store.get("li_at")).toBe("abc");
    expect(store.get("JSESSIONID")).toBe('"ajax:123"');
  });

  it("returns undefined for missing cookies", () => {
    const store = CookieStore.fromHeader("li_at=abc");
    expect(store.get("nope")).toBeUndefined();
  });

  it("handles leading/trailing whitespace around tokens", () => {
    const store = CookieStore.fromHeader("  li_at=abc ;  foo=bar  ");
    expect(store.get("li_at")).toBe("abc");
    expect(store.get("foo")).toBe("bar");
  });

  it("ignores empty input", () => {
    const store = CookieStore.fromHeader("");
    expect(store.get("li_at")).toBeUndefined();
  });
});

describe("CookieStore.setFromSetCookie", () => {
  it("updates existing cookies and adds new ones", () => {
    const store = CookieStore.fromHeader("li_at=abc; JSESSIONID=old");
    store.setFromSetCookie([
      "JSESSIONID=new; Path=/; HttpOnly",
      "lang=v=2&lang=en-us; Path=/",
    ]);
    expect(store.get("JSESSIONID")).toBe("new");
    expect(store.get("li_at")).toBe("abc");
    expect(store.get("lang")).toBe("v=2&lang=en-us");
  });

  it("compounds multiple update calls", () => {
    const store = CookieStore.fromHeader("li_at=abc");
    store.setFromSetCookie(["foo=1; Path=/"]);
    store.setFromSetCookie(["bar=2; Path=/"]);
    store.setFromSetCookie(["foo=3; Path=/"]);
    expect(store.get("foo")).toBe("3");
    expect(store.get("bar")).toBe("2");
    expect(store.get("li_at")).toBe("abc");
  });

  it("ignores Set-Cookie strings it cannot parse", () => {
    const store = CookieStore.fromHeader("li_at=abc");
    store.setFromSetCookie(["", "not a cookie", "ok=yes; Path=/"]);
    expect(store.get("li_at")).toBe("abc");
    expect(store.get("ok")).toBe("yes");
  });
});

describe("CookieStore.isInvalidated", () => {
  it("returns true when li_at is set to the literal 'delete me'", () => {
    const store = CookieStore.fromHeader("li_at=abc");
    store.setFromSetCookie(["li_at=delete me; Path=/; Domain=.linkedin.com"]);
    expect(store.isInvalidated()).toBe(true);
  });

  it("also detects the percent-encoded form 'delete%20me'", () => {
    const store = CookieStore.fromHeader("li_at=abc");
    store.setFromSetCookie(["li_at=delete%20me; Path=/"]);
    expect(store.isInvalidated()).toBe(true);
  });

  it("returns false when li_at has a real value", () => {
    const store = CookieStore.fromHeader("li_at=abc");
    expect(store.isInvalidated()).toBe(false);
    store.setFromSetCookie(["li_at=newvalue; Path=/"]);
    expect(store.isInvalidated()).toBe(false);
  });

  it("returns false when li_at is absent", () => {
    const store = CookieStore.fromHeader("JSESSIONID=x");
    expect(store.isInvalidated()).toBe(false);
  });
});

describe("CookieStore.toCookieHeader", () => {
  it("round-trips the original header (order-insensitive)", () => {
    const original = 'li_at=abc; JSESSIONID="ajax:123"';
    const store = CookieStore.fromHeader(original);
    const out = store.toCookieHeader();
    expect(out).toContain("li_at=abc");
    expect(out).toContain('JSESSIONID="ajax:123"');
    // standard "; " separator
    expect(out.split("; ").length).toBe(2);
  });

  it("includes cookies added via Set-Cookie", () => {
    const store = CookieStore.fromHeader("li_at=abc");
    store.setFromSetCookie(["bcookie=v=2&xyz; Path=/"]);
    const out = store.toCookieHeader();
    expect(out).toContain("li_at=abc");
    expect(out).toContain("bcookie=v=2&xyz");
  });

  it("is stable across repeated calls (deterministic ordering)", () => {
    const store = CookieStore.fromHeader("a=1; b=2; c=3");
    expect(store.toCookieHeader()).toBe(store.toCookieHeader());
  });
});
