import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  parseRealtimeEvent,
  parseSseLine,
} from "../../src/voyager/realtime.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIX = (name: string): string =>
  readFileSync(resolve(here, "fixtures/realtime", name), "utf8");

function fixObj(name: string): unknown {
  return JSON.parse(FIX(name)) as unknown;
}

describe("parseSseLine", () => {
  it("returns null for the empty line (event terminator)", () => {
    expect(parseSseLine("")).toBeNull();
    expect(parseSseLine("\n")).toBeNull();
    expect(parseSseLine("\r\n")).toBeNull();
  });

  it("returns null for SSE comment lines", () => {
    expect(parseSseLine(": heartbeat")).toBeNull();
    expect(parseSseLine(":")).toBeNull();
  });

  it("returns null for SSE event/id/retry lines (we don't use them)", () => {
    expect(parseSseLine("event: ping")).toBeNull();
    expect(parseSseLine("id: abc")).toBeNull();
    expect(parseSseLine("retry: 10000")).toBeNull();
  });

  it("extracts JSON after `data:` with optional single leading space", () => {
    expect(parseSseLine('data: {"foo":1}')).toEqual({
      dataJson: '{"foo":1}',
    });
    expect(parseSseLine('data:{"foo":1}')).toEqual({
      dataJson: '{"foo":1}',
    });
  });

  it("strips a trailing \\r before the newline", () => {
    expect(parseSseLine('data: {"foo":1}\r')).toEqual({
      dataJson: '{"foo":1}',
    });
    expect(parseSseLine('data: {"foo":1}\r\n')).toEqual({
      dataJson: '{"foo":1}',
    });
  });

  it("returns null for unknown SSE field names", () => {
    expect(parseSseLine("garbage line with no prefix")).toBeNull();
  });
});

describe("parseRealtimeEvent", () => {
  it("returns a HeartbeatEvent for the Heartbeat shape", () => {
    const ev = parseRealtimeEvent(fixObj("heartbeat.json"));
    expect(ev).toEqual({ kind: "heartbeat" });
  });

  it("returns a ClientConnectionEvent for the ClientConnection shape", () => {
    const obj = fixObj("clientConnection.json");
    const ev = parseRealtimeEvent(obj);
    expect(ev?.kind).toBe("clientConnection");
    if (ev && ev.kind === "clientConnection") {
      expect(ev.raw).toBe(obj);
    }
  });

  it("returns an IncomingMessageEvent for a DecoratedMessage payload", () => {
    const obj = fixObj("decoratedMessage.json");
    const ev = parseRealtimeEvent(obj);
    expect(ev?.kind).toBe("message");
    if (ev && ev.kind === "message") {
      expect(ev.messageUrn).toBe(
        "urn:li:msg_message:(urn:li:fsd_profile:ACoAAAExample,2-aaaaaaaa)",
      );
      expect(ev.conversationUrn).toBe(
        "urn:li:msg_conversation:(urn:li:fsdProfile:ACoAAAExample,2-bbbbbbbb)",
      );
      expect(ev.senderUrn).toBe(
        "urn:li:msg_messagingParticipant:urn:li:fsd_profile:ACoAAASender",
      );
      expect(ev.senderName).toBe("Alice Smith");
      expect(ev.body).toBe("Hello world");
      expect(ev.deliveredAt).toBe(1747300000000);
    }
  });

  it("returns a ConversationUpdateEvent for a DecoratedConversation payload", () => {
    const ev = parseRealtimeEvent(fixObj("decoratedConversation.json"));
    expect(ev?.kind).toBe("conversation");
    if (ev && ev.kind === "conversation") {
      expect(ev.conversationUrn).toBe(
        "urn:li:msg_conversation:(urn:li:fsdProfile:ACoAAAExample,2-bbbbbbbb)",
      );
    }
  });

  it("returns a TypingEvent for a DecoratedTypingIndicator payload", () => {
    const ev = parseRealtimeEvent(fixObj("decoratedTyping.json"));
    expect(ev?.kind).toBe("typing");
    if (ev && ev.kind === "typing") {
      expect(ev.conversationUrn).toBe(
        "urn:li:msg_conversation:(urn:li:fsdProfile:ACoAAAExample,2-bbbbbbbb)",
      );
      expect(ev.senderUrn).toBe(
        "urn:li:msg_messagingParticipant:urn:li:fsd_profile:ACoAAASender",
      );
    }
  });

  it("returns a ReadReceiptEvent for a DecoratedSeenReceipt payload", () => {
    const ev = parseRealtimeEvent(fixObj("decoratedSeenReceipt.json"));
    expect(ev?.kind).toBe("receipt");
    if (ev && ev.kind === "receipt") {
      expect(ev.conversationUrn).toBe(
        "urn:li:msg_conversation:(urn:li:fsdProfile:ACoAAAExample,2-bbbbbbbb)",
      );
      expect(ev.readerUrn).toBe(
        "urn:li:msg_messagingParticipant:urn:li:fsd_profile:ACoAAAReader",
      );
      expect(ev.lastReadAt).toBe(1747299999000);
    }
  });

  it("returns null for an unrecognized DecoratedEvent decoration", () => {
    expect(parseRealtimeEvent(fixObj("decoratedUnknown.json"))).toBeNull();
  });

  it("returns null for an empty / unrelated object", () => {
    expect(parseRealtimeEvent({})).toBeNull();
    expect(parseRealtimeEvent({ foo: "bar" })).toBeNull();
  });

  it("returns null for non-object input rather than throwing", () => {
    expect(parseRealtimeEvent(null)).toBeNull();
    expect(parseRealtimeEvent("hello")).toBeNull();
    expect(parseRealtimeEvent(42)).toBeNull();
    expect(parseRealtimeEvent([])).toBeNull();
  });
});
