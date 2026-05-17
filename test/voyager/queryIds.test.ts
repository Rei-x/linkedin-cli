import { describe, expect, it } from "vitest";
import {
  BASE,
  GRAPHQL_URL,
  HEARTBEAT_URL,
  MESSAGES_URL,
  messengerConversations,
  messengerConversationsWithCursor,
  messengerConversationsWithSyncToken,
  messengerMessagesByAnchorTimestamp,
  messengerMessagesByPrevCursor,
  REALTIME_URL,
  VOYAGER,
} from "../../src/voyager/queryIds.js";

describe("queryIds constants", () => {
  it("graphQL query IDs are non-empty strings", () => {
    for (const id of [
      messengerConversations,
      messengerConversationsWithSyncToken,
      messengerConversationsWithCursor,
      messengerMessagesByAnchorTimestamp,
      messengerMessagesByPrevCursor,
    ]) {
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);
      // The IDs look like "name.hexhash"
      expect(id).toMatch(/^[a-zA-Z]+\.[0-9a-f]+$/);
    }
  });

  it("URL constants start with https://www.linkedin.com", () => {
    for (const url of [BASE, VOYAGER, GRAPHQL_URL, MESSAGES_URL, REALTIME_URL, HEARTBEAT_URL]) {
      expect(url.startsWith("https://www.linkedin.com")).toBe(true);
    }
  });

  it("VOYAGER is BASE + /voyager/api", () => {
    expect(VOYAGER).toBe(BASE + "/voyager/api");
  });

  it("GRAPHQL_URL points at the messaging GraphQL endpoint", () => {
    expect(GRAPHQL_URL).toBe(VOYAGER + "/voyagerMessagingGraphQL/graphql");
  });

  it("MESSAGES_URL points at the messenger messages endpoint", () => {
    expect(MESSAGES_URL).toBe(VOYAGER + "/voyagerMessagingDashMessengerMessages");
  });

  it("REALTIME_URL and HEARTBEAT_URL match mautrix", () => {
    expect(REALTIME_URL).toBe(BASE + "/realtime/connect");
    expect(HEARTBEAT_URL).toBe(BASE + "/realtime/realtimeFrontendClientConnectivityTracking");
  });
});
