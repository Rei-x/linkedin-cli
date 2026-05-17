// `linkedin watch` — long-lived realtime stream. Persists new messages and
// optionally emits NDJSON for piping.

import { defineCommand } from "citty";

import {
  messages as messagesRepo,
  threads as threadsRepo,
} from "../db/repos.js";
import {
  RealtimeStream,
  type IncomingMessageEvent,
  type RealtimeEvent,
} from "../voyager/realtime.js";
import { auth as authRepo } from "../db/repos.js";
import {
  colorize,
  fmtClockTime,
  loadContext,
  NotLoggedInError,
  printJsonLine,
  runCommand,
  shortThreadId,
} from "./_shared.js";

function persistIncoming(
  db: import("better-sqlite3").Database,
  ev: IncomingMessageEvent,
): void {
  if (threadsRepo.get(db, ev.conversationUrn) === null) {
    threadsRepo.upsert(db, {
      id: ev.conversationUrn,
      title: null,
      participants: [],
      lastMsgPreview: ev.body.slice(0, 200),
      lastMsgTs: ev.deliveredAt,
      unreadCount: 1,
      category: null,
      syncedAt: Date.now(),
    });
  }
  messagesRepo.upsert(db, {
    id: ev.messageUrn,
    threadId: ev.conversationUrn,
    senderUrn: ev.senderUrn,
    senderName: ev.senderName,
    body: ev.body,
    ts: ev.deliveredAt,
    deliveryState: "confirmed",
    originToken: null,
    rawJson: null,
  });
}

export const command = defineCommand({
  meta: { name: "watch", description: "Stream realtime events" },
  args: {
    thread: { type: "string", description: "Filter to a specific thread id/URN" },
    catchup: {
      type: "boolean",
      description: "Run a quick sync before opening the stream",
    },
    json: { type: "boolean", description: "Emit NDJSON" },
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
        if (!ctx.client || !ctx.selfProfileUrn) throw new NotLoggedInError();
        const row = authRepo.get(ctx.db);
        if (!row) throw new NotLoggedInError();

        if (args["catchup"] === true) {
          // Inline a minimal one-page sync to avoid coupling commands.
          const result = await ctx.client.listConversations({ count: 20 });
          const now = Date.now();
          for (const conv of result.items) {
            threadsRepo.upsert(ctx.db, {
              id: conv.urn,
              title: conv.title,
              participants: conv.participants.map((p) => p.urn),
              lastMsgPreview: conv.lastMessagePreview,
              lastMsgTs: conv.lastMessageAt,
              unreadCount: conv.unreadCount,
              category: conv.category,
              syncedAt: now,
            });
          }
        }

        const stream = new RealtimeStream({
          cookieHeader: row.rawCookieHeader,
          xLiTrack: row.xLiTrack ?? undefined,
          xLiPageInstance: row.xLiPageInstance ?? undefined,
          actorUrn: ctx.selfProfileUrn,
        });

        const threadFilter = args["thread"] as string | undefined;
        const c = colorize(ctx.noColor);
        const verbose = args["verbose"] === true;

        if (verbose) {
          stream.on("connect", () => process.stderr.write("[watch] connected\n"));
          stream.on("disconnect", (r) =>
            process.stderr.write(`[watch] disconnected: ${r.type}${r.error ? " " + r.error.message : ""}\n`),
          );
          stream.on("event", (ev) => {
            if (ev.kind !== "message") {
              process.stderr.write(`[watch] event: ${ev.kind}\n`);
            }
          });
        }

        stream.on("event", (ev: RealtimeEvent) => {
          if (ev.kind !== "message") return;
          if (threadFilter && !ev.conversationUrn.includes(threadFilter)) return;
          persistIncoming(ctx.db, ev);
          if (ctx.isJson) {
            printJsonLine({
              ts: new Date(ev.deliveredAt).toISOString(),
              thread: shortThreadId(ev.conversationUrn),
              from: ev.senderName ?? ev.senderUrn,
              body: ev.body,
              kind: "message",
            });
            return;
          }
          const tShort = shortThreadId(ev.conversationUrn);
          const from = ev.senderName ?? ev.senderUrn;
          process.stdout.write(
            `[${fmtClockTime(ev.deliveredAt)}] ${c.dim(tShort)}  ${c.senderColor(from)(from)}: ${ev.body}\n`,
          );
        });

        const stopPromise = new Promise<void>((resolve) => {
          stream.once("tokenInvalidated", () => {
            process.stderr.write("Cookie expired or invalid — run `linkedin login` again.\n");
            process.exitCode = 3;
            void stream.stop().finally(() => resolve());
          });
          stream.once("error", (err) => {
            process.stderr.write(`watch error: ${err.message}\n`);
            void stream.stop().finally(() => resolve());
          });
          const onSig = (): void => {
            void stream.stop().finally(() => resolve());
          };
          process.once("SIGINT", onSig);
          process.once("SIGTERM", onSig);
        });

        await stream.start();
        await stopPromise;
      } finally {
        close();
      }
    });
  },
});
