import { describe, expect, it } from "vitest";
import {
  buildUrn,
  conversationUrn,
  isUrn,
  messageUrn,
  parseUrn,
  profileUrn,
  profileUrnCamelCase,
  urnId,
  withPrefix,
} from "../../src/voyager/urn.js";

describe("parseUrn", () => {
  it("parses simple URN", () => {
    const u = parseUrn("urn:li:fsd_profile:ABC123");
    expect(u.prefix).toBe("urn:li:fsd_profile");
    expect(u.id).toBe("ABC123");
    expect(u.raw).toBe("urn:li:fsd_profile:ABC123");
  });

  it("parses compound URN", () => {
    const u = parseUrn("urn:li:msg_conversation:(urn:li:fsdProfile:S,C)");
    expect(u.prefix).toBe("urn:li:msg_conversation");
    expect(u.id).toBe("(urn:li:fsdProfile:S,C)");
    expect(u.raw).toBe("urn:li:msg_conversation:(urn:li:fsdProfile:S,C)");
  });

  it("parses nested compound URN (msg_message)", () => {
    const raw = "urn:li:msg_message:(urn:li:fsdProfile:S,CONV-1,MSG-1)";
    const u = parseUrn(raw);
    expect(u.prefix).toBe("urn:li:msg_message");
    expect(u.id).toBe("(urn:li:fsdProfile:S,CONV-1,MSG-1)");
  });

  it("throws on malformed input (no colon)", () => {
    expect(() => parseUrn("notaurn")).toThrow();
  });

  it("throws on empty input", () => {
    expect(() => parseUrn("")).toThrow();
  });
});

describe("isUrn", () => {
  it("returns true for valid URNs", () => {
    expect(isUrn("urn:li:fsd_profile:abc")).toBe(true);
    expect(isUrn("urn:li:msg_conversation:(urn:li:fsdProfile:a,b)")).toBe(true);
  });

  it("returns false for non-URNs", () => {
    expect(isUrn("notaurn")).toBe(false);
    expect(isUrn("urn:")).toBe(false);
    expect(isUrn("")).toBe(false);
    expect(isUrn("http://example.com")).toBe(false);
  });
});

describe("buildUrn", () => {
  it("joins prefix and id", () => {
    expect(buildUrn("urn:li:fsd_profile", "abc")).toBe("urn:li:fsd_profile:abc");
  });
});

describe("withPrefix", () => {
  it("swaps prefix while keeping id", () => {
    expect(withPrefix("urn:li:fsdProfile:abc", "urn:li:fsd_profile")).toBe(
      "urn:li:fsd_profile:abc",
    );
  });

  it("works on compound URNs", () => {
    expect(
      withPrefix("urn:li:msg_conversation:(urn:li:fsdProfile:S,C)", "urn:li:new_prefix"),
    ).toBe("urn:li:new_prefix:(urn:li:fsdProfile:S,C)");
  });
});

describe("urnId", () => {
  it("returns trailing segment of simple URN", () => {
    expect(urnId("urn:li:fsd_profile:abc")).toBe("abc");
  });

  it("returns paren-block of compound URN", () => {
    expect(urnId("urn:li:msg_conversation:(urn:li:fsdProfile:S,C)")).toBe(
      "(urn:li:fsdProfile:S,C)",
    );
  });
});

describe("convenience builders", () => {
  it("profileUrn (snake_case)", () => {
    expect(profileUrn("abc")).toBe("urn:li:fsd_profile:abc");
  });

  it("profileUrnCamelCase", () => {
    expect(profileUrnCamelCase("abc")).toBe("urn:li:fsdProfile:abc");
  });

  it("conversationUrn", () => {
    expect(conversationUrn("SELF", "CONV-1")).toBe(
      "urn:li:msg_conversation:(urn:li:fsdProfile:SELF,CONV-1)",
    );
  });

  it("messageUrn", () => {
    expect(messageUrn("SELF", "CONV-1", "MSG-1")).toBe(
      "urn:li:msg_message:(urn:li:fsdProfile:SELF,CONV-1,MSG-1)",
    );
  });
});
