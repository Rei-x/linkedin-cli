import { describe, expect, it } from "vitest";
import {
  csrfTokenFor,
  DEFAULT_USER_AGENT,
  DEFAULT_X_LI_PAGE_INSTANCE,
  DEFAULT_X_LI_TRACK,
  defaultHeaders,
  withRealtimeHeaders,
  withXLIHeaders,
} from "../../src/voyager/headers.js";

describe("csrfTokenFor", () => {
  it("strips surrounding double quotes from JSESSIONID", () => {
    expect(csrfTokenFor('"ajax:1234567"')).toBe("ajax:1234567");
  });

  it("returns the value unchanged when no quotes are present", () => {
    expect(csrfTokenFor("ajax:1234567")).toBe("ajax:1234567");
  });

  it("does not strip unmatched leading or trailing quote", () => {
    expect(csrfTokenFor('"ajax:1234567')).toBe('"ajax:1234567');
    expect(csrfTokenFor('ajax:1234567"')).toBe('ajax:1234567"');
  });
});

describe("defaults", () => {
  it("DEFAULT_USER_AGENT looks like a recent Chrome", () => {
    expect(DEFAULT_USER_AGENT).toMatch(/Chrome\/1\d\d/);
  });

  it("DEFAULT_X_LI_TRACK parses as JSON with clientVersion", () => {
    const parsed = JSON.parse(DEFAULT_X_LI_TRACK) as Record<string, unknown>;
    expect(typeof parsed.clientVersion).toBe("string");
    expect((parsed.clientVersion as string).length).toBeGreaterThan(0);
  });

  it("DEFAULT_X_LI_PAGE_INSTANCE starts with urn:li:page:", () => {
    expect(DEFAULT_X_LI_PAGE_INSTANCE.startsWith("urn:li:page:")).toBe(true);
  });
});

describe("defaultHeaders", () => {
  it("contains required headers", () => {
    const h = defaultHeaders({ jsessionid: '"ajax:1234567"' });
    expect(h["csrf-token"]).toBe("ajax:1234567");
    expect(h["User-Agent"]).toContain("Chrome");
    expect(h["Accept-Language"]).toBe("en-US,en;q=0.9");
    expect(h["Accept"]).toBeDefined();
    expect(h["Sec-Ch-Ua"]).toContain("Chrome");
    expect(h["Sec-Ch-Ua-Mobile"]).toBe("?0");
    expect(h["Sec-Ch-Ua-Platform"]).toContain("macOS");
    expect(h["Origin"]).toBe("https://www.linkedin.com");
    expect(h["Sec-Fetch-Dest"]).toBeDefined();
    expect(h["Sec-Fetch-Mode"]).toBeDefined();
    expect(h["Sec-Fetch-Site"]).toBeDefined();
  });

  it("uses provided userAgent override", () => {
    const h = defaultHeaders({ jsessionid: "x", userAgent: "Custom/1.0" });
    expect(h["User-Agent"]).toBe("Custom/1.0");
  });
});

describe("withXLIHeaders", () => {
  it("adds the four LinkedIn-specific headers", () => {
    const base = defaultHeaders({ jsessionid: "x" });
    const h = withXLIHeaders(base, { jsessionid: "x" });
    expect(h["x-restli-protocol-version"]).toBe("2.0.0");
    expect(h["x-li-page-instance"]).toBeDefined();
    expect(h["x-li-track"]).toBeDefined();
    expect(h["Referer"]).toContain("https://www.linkedin.com");
  });

  it("respects ctx overrides", () => {
    const base = defaultHeaders({ jsessionid: "x" });
    const h = withXLIHeaders(base, {
      jsessionid: "x",
      xLiPageInstance: "urn:li:page:custom",
      xLiTrack: '{"clientVersion":"custom"}',
    });
    expect(h["x-li-page-instance"]).toBe("urn:li:page:custom");
    expect(h["x-li-track"]).toBe('{"clientVersion":"custom"}');
  });

  it("does not mutate the input headers object", () => {
    const base = defaultHeaders({ jsessionid: "x" });
    const snapshot = { ...base };
    withXLIHeaders(base, { jsessionid: "x" });
    expect(base).toEqual(snapshot);
  });
});

describe("withRealtimeHeaders", () => {
  it("includes session id, query map, recipe map and accept headers", () => {
    const base = defaultHeaders({ jsessionid: "x" });
    const h = withRealtimeHeaders(
      base,
      { jsessionid: "x" },
      "session-uuid-1",
      '{"q":"map"}',
      '{"r":"map"}',
    );
    expect(h["x-li-realtime-session"]).toBe("session-uuid-1");
    expect(h["x-li-query-map"]).toBe('{"q":"map"}');
    expect(h["x-li-recipe-map"]).toBe('{"r":"map"}');
    expect(h["x-li-accept"]).toContain("linkedin.normalized");
    expect(h["x-li-query-accept"]).toBe("application/graphql");
    expect(h["x-li-recipe-accept"]).toContain("linkedin.normalized");
    // And it includes XLI headers too
    expect(h["x-restli-protocol-version"]).toBe("2.0.0");
  });
});
