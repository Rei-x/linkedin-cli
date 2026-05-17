import { describe, expect, it } from "vitest";

import { extractMpVersion } from "../../src/voyager/realtime.js";
import { DEFAULT_X_LI_TRACK } from "../../src/voyager/headers.js";
import {
  X_LI_QUERY_MAP,
  X_LI_RECIPE_MAP,
} from "../../src/voyager/realtimeMaps.js";

describe("extractMpVersion", () => {
  it("returns the mpVersion field from a valid x-li-track JSON blob", () => {
    expect(extractMpVersion('{"mpVersion":"1.13.40953"}')).toBe("1.13.40953");
  });

  it("returns the mpVersion from DEFAULT_X_LI_TRACK (round-trip)", () => {
    const v = extractMpVersion(DEFAULT_X_LI_TRACK);
    expect(typeof v).toBe("string");
    expect(v.length).toBeGreaterThan(0);
  });

  it("falls back to a non-empty default when mpVersion is missing", () => {
    expect(extractMpVersion('{"clientVersion":"1.2.3"}').length).toBeGreaterThan(
      0,
    );
  });

  it("falls back to a non-empty default for malformed JSON", () => {
    expect(extractMpVersion("not-json-at-all").length).toBeGreaterThan(0);
  });
});

describe("realtime maps are valid compact JSON", () => {
  it("X_LI_QUERY_MAP parses and contains the messagesTopic entry", () => {
    const obj = JSON.parse(X_LI_QUERY_MAP) as Record<string, unknown>;
    expect(obj.topicToGraphQLQueryParams).toBeDefined();
    const t = obj.topicToGraphQLQueryParams as Record<string, unknown>;
    expect(t.messagesTopic).toBeDefined();
  });

  it("X_LI_RECIPE_MAP parses and contains the inAppAlertsTopic entry", () => {
    const obj = JSON.parse(X_LI_RECIPE_MAP) as Record<string, unknown>;
    expect(typeof obj.inAppAlertsTopic).toBe("string");
  });

  it("both maps are compact (no extraneous whitespace)", () => {
    // JSON.stringify with no spacing arg produces compact JSON, which is what
    // the Go reference also produces (Marshal after Unmarshal).
    expect(X_LI_QUERY_MAP).not.toMatch(/\n\s+/);
    expect(X_LI_RECIPE_MAP).not.toMatch(/\n\s+/);
  });
});
