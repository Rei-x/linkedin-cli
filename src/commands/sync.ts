// `linkedin sync` — pull recent conversations + recent messages. Incremental
// mode walks back through pages until it sees a thread it already has synced
// recently; --full disables that short-circuit.

import { defineCommand } from "citty";

import {
  messages as messagesRepo,
  participants as partsRepo,
  threads as threadsRepo,
  watermark,
} from "../db/repos.js";
import type { Conversation, Message } from "../voyager/client.js";
import {
  loadContext,
  NotLoggedInError,
  printJson,
  runCommand,
} from "./_shared.js";

function upsertConv(
  db: import("better-sqlite3").Database,
  c: Conversation,
  now: number,
): void {
  threadsRepo.upsert(db, {
    id: c.urn,
    title: c.title,
    participants: c.participants.map((p) => p.urn),
    lastMsgPreview: c.lastMessagePreview,
    lastMsgTs: c.lastMessageAt,
    unreadCount: c.unreadCount,
    category: c.category,
    syncedAt: now,
  });
  for (const p of c.participants) {
    const name = [p.firstName, p.lastName].filter((x): x is string => !!x).join(" ").trim();
    if (!name) continue;
    partsRepo.upsert(db, {
      urn: p.urn,
      name,
      headline: null,
      publicIdentifier: p.publicIdentifier ?? null,
      pictureUrl: null,
      updatedAt: now,
    });
  }
}

function upsertMsg(db: import("better-sqlite3").Database, m: Message): void {
  messagesRepo.upsert(db, {
    id: m.urn,
    threadId: m.conversationUrn,
    senderUrn: m.senderUrn,
    senderName: m.senderName,
    body: m.body,
    ts: m.deliveredAt,
    deliveryState: "confirmed",
    originToken: null,
    rawJson: null,
  });
}

export const command = defineCommand({
  meta: { name: "sync", description: "Pull conversations + recent messages" },
  args: {
    full: { type: "boolean", description: "Do a full sync (no early-exit)" },
    "page-size": { type: "string", description: "Conversations per page", default: "50" },
    "max-pages": { type: "string", description: "Cap on pages walked", default: "10" },
    "messages-per-thread": {
      type: "string",
      description: "Messages to fetch per thread",
      default: "20",
    },
    json: { type: "boolean", description: "Emit JSON" },
    "no-color": { type: "boolean", description: "Disable colors" },
    db: { type: "string", description: "Path to cache.db" },
    verbose: { type: "boolean", alias: "v", description: "Verbose logging" },
  },
  async run({ args }) {
    await runCommand(async () => {
      const { ctx, close } = loadContext({
        db: args["db"] as string | undefined,
        json: args["json"] === true,
        noColor: args["no-color"] === true,
        verbose: args["verbose"] === true,
        requireAuth: true,
      });
      try {
        if (!ctx.client) throw new NotLoggedInError();
        const pageSize = Math.max(1, Number(args["page-size"] ?? 50));
        const maxPages = Math.max(1, Number(args["max-pages"] ?? 10));
        const msgsPerThread = Math.max(1, Number(args["messages-per-thread"] ?? 20));
        const isFull = args["full"] === true;

        const lastSyncRaw = watermark.get(ctx.db, "last_sync_at");
        const lastSync = lastSyncRaw ? Number(lastSyncRaw) : 0;

        let lastUpdatedBefore: number | undefined = undefined;
        let pagesWalked = 0;
        let threadsSeen = 0;
        let newMessages = 0;
        let seenKnownThread = false;
        const now = Date.now();

        while (pagesWalked < maxPages) {
          const result: Awaited<ReturnType<typeof ctx.client.listConversations>> =
            await ctx.client.listConversations({
              count: pageSize,
              ...(lastUpdatedBefore !== undefined ? { lastUpdatedBefore } : {}),
            });
          pagesWalked += 1;
          if (result.items.length === 0) break;

          let oldestTs: number | null = null;
          for (const conv of result.items) {
            // Short-circuit (incremental only).
            if (!isFull && conv.lastMessageAt !== null && conv.lastMessageAt <= lastSync) {
              seenKnownThread = true;
            }
            upsertConv(ctx.db, conv, now);
            threadsSeen += 1;
            if (conv.lastMessageAt !== null) {
              if (oldestTs === null || conv.lastMessageAt < oldestTs) oldestTs = conv.lastMessageAt;
            }

            // Pull recent messages for this thread.
            const msgRes: Awaited<ReturnType<typeof ctx.client.listMessages>> =
              await ctx.client.listMessages(conv.urn, {
                countBefore: msgsPerThread,
                deliveredAt: now,
              });
            for (const m of msgRes.items) {
              upsertMsg(ctx.db, m);
              newMessages += 1;
            }
          }

          if (!isFull && seenKnownThread) break;
          if (oldestTs === null) break;
          lastUpdatedBefore = oldestTs;
        }

        watermark.set(ctx.db, "last_sync_at", String(now));

        if (ctx.isJson) {
          printJson({
            ok: true,
            threads: threadsSeen,
            messages: newMessages,
            pages: pagesWalked,
            full: isFull,
          });
          return;
        }
        process.stdout.write(
          `Synced ${newMessages} new messages across ${threadsSeen} threads.\n`,
        );
      } finally {
        close();
      }
    });
  },
});
