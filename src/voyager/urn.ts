// LinkedIn URN parsing/building primitives.
//
// Two URN shapes exist:
//   - Simple:   "urn:li:fsd_profile:ABC123"
//   - Compound: "urn:li:msg_conversation:(urn:li:fsdProfile:SELF,CONV-ID)"
//
// In a compound URN, the "id" segment is the entire parenthesised block,
// which itself contains commas/colons. This mirrors mautrix-linkedin's
// `urnRegex` in pkg/linkedingo/urn.go.

export type Urn = { prefix: string; id: string; raw: string };

const URN_REGEX = /^(.*?):(\(.*\)|[^:]*)$/;

export function parseUrn(s: string): Urn {
  if (!isUrn(s)) {
    throw new Error(`Not a valid URN: ${JSON.stringify(s)}`);
  }
  const m = URN_REGEX.exec(s);
  if (!m || m[1] === undefined || m[2] === undefined) {
    throw new Error(`Malformed URN: ${JSON.stringify(s)}`);
  }
  return { prefix: m[1], id: m[2], raw: s };
}

export function isUrn(s: string): boolean {
  if (!s.startsWith("urn:")) return false;
  // After the leading "urn:" there must be at least one more colon.
  const rest = s.slice(4);
  return rest.includes(":");
}

export function buildUrn(prefix: string, id: string): string {
  return `${prefix}:${id}`;
}

export function withPrefix(urn: string, newPrefix: string): string {
  const parsed = parseUrn(urn);
  return buildUrn(newPrefix, parsed.id);
}

export function urnId(urn: string): string {
  return parseUrn(urn).id;
}

// Convenience builders that mirror the mautrix Go helpers.

export function profileUrn(id: string): string {
  return `urn:li:fsd_profile:${id}`;
}

export function profileUrnCamelCase(id: string): string {
  return `urn:li:fsdProfile:${id}`;
}

export function conversationUrn(selfId: string, conversationId: string): string {
  return `urn:li:msg_conversation:(urn:li:fsdProfile:${selfId},${conversationId})`;
}

export function messageUrn(
  selfId: string,
  conversationId: string,
  messageId: string,
): string {
  return `urn:li:msg_message:(urn:li:fsdProfile:${selfId},${conversationId},${messageId})`;
}

// Extract the bare conversation id from any URN form.
//   urn:li:msg_conversation:(urn:li:fsdProfile:SELF,CONV-ID) → "CONV-ID"
//   urn:li:msg_thread:abc123                                → "abc123"
//   2-MTIzNDU=                                              → "2-MTIzNDU="
// Compound URNs that nest deeper still return the LAST comma-separated chunk
// of the parenthesised payload, which is the convention LinkedIn uses for the
// conversation id position.
export function conversationLocalId(urn: string): string {
  if (!urn.startsWith("urn:")) return urn;
  const id = urnId(urn);
  if (id.startsWith("(") && id.endsWith(")")) {
    const inner = id.slice(1, -1);
    const lastComma = inner.lastIndexOf(",");
    return lastComma >= 0 ? inner.slice(lastComma + 1) : inner;
  }
  return id;
}
