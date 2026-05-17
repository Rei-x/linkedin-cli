// LIVE integration tests for the realtime SSE stream.
//
// Gate: requires LINKEDIN_LI_AT and LINKEDIN_JSESSIONID. Without them the
// suite is fully skipped so a clean `vitest run` does not hit the network.

import { describe, expect, it } from "vitest";

import { VoyagerClient } from "../../src/voyager/client.js";
import { RealtimeStream } from "../../src/voyager/realtime.js";

const liAt = process.env.LINKEDIN_LI_AT;
const jsess = process.env.LINKEDIN_JSESSIONID;
const hasCreds = !!liAt && !!jsess;
const itLive = hasCreds ? it : it.skip;

function cookieHeader(): string {
  return `li_at=${liAt}; JSESSIONID=${jsess}`;
}

describe("RealtimeStream — live", () => {
  itLive(
    "start() connects and stop() shuts down cleanly; receives at least one event",
    { timeout: 120_000 },
    async () => {
      const client = new VoyagerClient({ cookieHeader: cookieHeader() });
      const me = await client.me();

      const stream = new RealtimeStream({
        cookieHeader: cookieHeader(),
        actorUrn: me.profileUrn,
      });

      let eventCount = 0;
      stream.on("event", () => {
        eventCount += 1;
      });

      const errors: Error[] = [];
      stream.on("error", (err) => errors.push(err));

      const startedAt = Date.now();
      await stream.start();
      const connectMs = Date.now() - startedAt;
      expect(connectMs).toBeLessThan(15_000);

      // Wait up to 90s for at least one event (ClientConnection arrives near
      // immediately; otherwise a Heartbeat shows up within ~30s).
      const deadline = Date.now() + 90_000;
      while (eventCount === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(eventCount).toBeGreaterThan(0);

      const stopStartedAt = Date.now();
      await stream.stop();
      const stopMs = Date.now() - stopStartedAt;
      expect(stopMs).toBeLessThan(5_000);

      // No fatal errors observed during the run.
      expect(errors).toEqual([]);
    },
  );
});

if (!hasCreds) {
  // eslint-disable-next-line no-console
  console.log(
    "[realtime.integration] LINKEDIN_LI_AT / LINKEDIN_JSESSIONID not set — skipping live tests.",
  );
}
