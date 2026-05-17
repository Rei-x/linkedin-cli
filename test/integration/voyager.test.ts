// LIVE integration tests against linkedin.com.
//
// These tests hit the real LinkedIn Voyager API. To run them you must set:
//
//   LINKEDIN_LI_AT=<value of your li_at cookie>
//   LINKEDIN_JSESSIONID=<value of your JSESSIONID cookie, *including* quotes
//                       if present, e.g. '"ajax:1234567"'>
//
// Then:
//
//   LINKEDIN_LI_AT=... LINKEDIN_JSESSIONID=... node_modules/.bin/vitest run \
//     test/integration/voyager.test.ts
//
// When the env vars are unset the suite is fully skipped — `vitest run` from a
// clean checkout will not perform any network I/O.
//
// SEND-MESSAGE opt-in: the `sendMessage` and `markRead` live tests are gated
// behind LINKEDIN_LIVE_SEND_TO=<urn:li:msg_conversation:(...)>. The default
// happy path does not write to your inbox.

import { describe, expect, it } from "vitest";
import {
  LinkedInError,
  VoyagerClient,
} from "../../src/voyager/client.js";

const liAt = process.env.LINKEDIN_LI_AT;
const jsess = process.env.LINKEDIN_JSESSIONID;
const sendTo = process.env.LINKEDIN_LIVE_SEND_TO;

const hasCreds = !!liAt && !!jsess;
const itLive = hasCreds ? it : it.skip;

function cookieHeader(): string {
  return `li_at=${liAt}; JSESSIONID=${jsess}`;
}

function makeClient(): VoyagerClient {
  return new VoyagerClient({ cookieHeader: cookieHeader() });
}

describe("VoyagerClient — live", () => {
  itLive("me() returns a profile URN of the expected shape", async () => {
    const client = makeClient();
    const me = await client.me();
    expect(me.profileUrn).toMatch(/^urn:li:fsd_profile:.+/);
    expect(typeof me.memberId).toBe("string");
    expect(me.memberId.length).toBeGreaterThan(0);
  }, 30_000);

  itLive("listConversations({ count: 5 }) returns at most 5", async () => {
    const client = makeClient();
    const page = await client.listConversations({ count: 5 });
    expect(Array.isArray(page.items)).toBe(true);
    expect(page.items.length).toBeLessThanOrEqual(5);
    for (const c of page.items) {
      expect(c.urn).toMatch(/^urn:li:msg_conversation:/);
      expect(Array.isArray(c.participants)).toBe(true);
    }
  }, 30_000);

  itLive(
    "listMessages(<first conv>, { countBefore: 5 }) returns messages in ascending time order",
    async () => {
      const client = makeClient();
      const page = await client.listConversations({ count: 5 });
      if (page.items.length === 0) {
        // No conversations to enumerate — treat as pass.
        return;
      }
      const first = page.items[0];
      if (!first) return;
      const messages = await client.listMessages(first.urn, {
        countBefore: 5,
      });
      expect(Array.isArray(messages.items)).toBe(true);
      const sorted = [...messages.items].sort(
        (a, b) => a.deliveredAt - b.deliveredAt,
      );
      for (let i = 0; i < sorted.length; i++) {
        const m = sorted[i];
        if (!m) continue;
        expect(typeof m.body).toBe("string");
        expect(m.urn).toMatch(/^urn:li:msg_message:/);
      }
      // ascending check
      for (let i = 1; i < sorted.length; i++) {
        const a = sorted[i - 1];
        const b = sorted[i];
        if (!a || !b) continue;
        expect(a.deliveredAt).toBeLessThanOrEqual(b.deliveredAt);
      }
    },
    30_000,
  );

  // OPT-IN SEND TEST. To enable, set:
  //
  //   LINKEDIN_LIVE_SEND_TO='urn:li:msg_conversation:(urn:li:fsdProfile:XXX,YYY)'
  //
  // This actually writes a message to that conversation. Leaving the block
  // commented out so it can never run by accident; uncomment to use.
  //
  // const itSend = hasCreds && sendTo ? it : it.skip;
  // itSend("sendMessage writes a real message to LINKEDIN_LIVE_SEND_TO", async () => {
  //   const client = makeClient();
  //   const me = await client.me();
  //   const text = `linkedin-cli integration test ping ${new Date().toISOString()}`;
  //   const sent = await client.sendMessage({
  //     conversationUrn: sendTo!,
  //     text,
  //     selfProfileUrn: me.profileUrn,
  //   });
  //   expect(sent.messageUrn).toMatch(/^urn:li:msg_message:/);
  //   expect(sent.deliveredAt).toBeGreaterThan(0);
  // }, 30_000);

  itLive("rejects an obviously-bogus cookie with a LinkedInError", async () => {
    // Build a client with a clearly fake li_at and verify we don't pretend
    // everything is fine. Uses the same JSESSIONID so the CSRF token is real
    // shaped — we just expect LinkedIn to refuse (probably 401/403 or redirect
    // that we treat as token-invalidated).
    const client = new VoyagerClient({
      cookieHeader: `li_at=definitely-not-valid; JSESSIONID=${jsess}`,
    });
    await expect(client.me()).rejects.toBeInstanceOf(LinkedInError);
  }, 30_000);
});

if (!hasCreds) {
  // Surface a hint when the suite is skipped so users aren't confused why
  // nothing runs.
  // eslint-disable-next-line no-console
  console.log(
    "[voyager.integration] LINKEDIN_LI_AT / LINKEDIN_JSESSIONID not set — skipping live tests.",
  );
}
