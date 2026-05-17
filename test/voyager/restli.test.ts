import { describe, expect, it } from "vitest";
import { encodeRestLi } from "../../src/voyager/restli.js";

describe("encodeRestLi", () => {
  it("encodes a single string URN value", () => {
    expect(encodeRestLi({ mailboxUrn: "urn:li:fsd_profile:abc" })).toBe(
      "(mailboxUrn:urn%3Ali%3Afsd_profile%3Aabc)",
    );
  });

  it("encodes an integer value verbatim", () => {
    expect(encodeRestLi({ count: 20 })).toBe("(count:20)");
  });

  it("encodes multiple primitive keys in declared order", () => {
    expect(
      encodeRestLi({
        mailboxUrn: "u",
        count: 20,
        lastUpdatedBefore: 1700000000000,
      }),
    ).toBe("(mailboxUrn:u,count:20,lastUpdatedBefore:1700000000000)");
  });

  it("encodes nested object with list of objects", () => {
    expect(
      encodeRestLi({
        query: {
          predicateUnions: [
            { conversationCategoryPredicate: { category: "PRIMARY_INBOX" } },
          ],
        },
      }),
    ).toBe(
      "(query:(predicateUnions:List((conversationCategoryPredicate:(category:PRIMARY_INBOX)))))",
    );
  });

  it("encodes comma inside string value", () => {
    expect(encodeRestLi({ items: ["a,b", "c"] })).toBe(
      "(items:List(a%2Cb,c))",
    );
  });

  it("percent-encodes structural chars in string values: ( ) , : & #", () => {
    expect(encodeRestLi({ v: "(a):b,c&d#e" })).toBe(
      "(v:%28a%29%3Ab%2Cc%26d%23e)",
    );
  });

  it("encodes boolean values verbatim", () => {
    expect(encodeRestLi({ enabled: true, disabled: false })).toBe(
      "(enabled:true,disabled:false)",
    );
  });

  it("encodes empty object as ()", () => {
    expect(encodeRestLi({})).toBe("()");
  });

  it("encodes empty list inside object as List()", () => {
    expect(encodeRestLi({ items: [] })).toBe("(items:List())");
  });

  it("encodes list of primitives", () => {
    expect(encodeRestLi({ nums: [1, 2, 3] })).toBe("(nums:List(1,2,3))");
  });

  it("encodes deeply nested object", () => {
    expect(
      encodeRestLi({ a: { b: { c: { d: "x" } } } }),
    ).toBe("(a:(b:(c:(d:x))))");
  });

  it("leaves keys unchanged even if they contain unusual chars (caller's responsibility)", () => {
    // Keys are assumed to be safe identifiers; only values are encoded.
    expect(encodeRestLi({ camelCaseKey: 1 })).toBe("(camelCaseKey:1)");
  });

  it("encodes spaces and slashes inside strings", () => {
    expect(encodeRestLi({ s: "a b/c" })).toBe("(s:a%20b%2Fc)");
  });

  it("encodes percent sign inside strings", () => {
    expect(encodeRestLi({ s: "50%" })).toBe("(s:50%25)");
  });

  it("encodes mixed nested list/object", () => {
    expect(
      encodeRestLi({
        a: [
          { k: "v1" },
          { k: "v2" },
        ],
      }),
    ).toBe("(a:List((k:v1),(k:v2)))");
  });
});
