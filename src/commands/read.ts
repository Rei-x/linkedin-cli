// `linkedin read <thread>` — fetch messages from the server (optional) and
// render them oldest-first. Falls through to cache when --no-refresh is set
// or when the network call would require a login we don't have.

import { defineCommand } from "citty";

import {
  messages as messagesRepo,
  participants as partsRepo,
  threads as threadsRepo,
  type MessageRow,
} from "../db/repos.js";
import type { Message } from "../voyager/client.js";
import {
  colorize,
  fmtMessageTime,
  loadContext,
  NotLoggedInError,
  printJson,
  runCommand,
  truncate,
} from "./_shared.js";

function upsertMessages(
  db: import("better-sqlite3").Database,
  msgs: Message[],
): void {
  for (const m of msgs) {
    // Ensure thread row exists so foreign key holds. (For new threads, status
    // will be filled in by the next chats/sync run.)
    if (threadsRepo.get(db, m.conversationUrn) === null) {
      threadsRepo.upsert(db, {
        id: m.conversationUrn,
        title: null,
        participants: [],
        lastMsgPreview: m.body.slice(0, 200),
        lastMsgTs: m.deliveredAt,
        unreadCount: 0,
        category: null,
        syncedAt: Date.now(),
      });
    }
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
}

function senderLabel(
  row: MessageRow,
  selfUrn: string | null,
  db: import("better-sqlite3").Database,
): { label: string; isSelf: boolean } {
  if (row.senderUrn === selfUrn) return { label: "you", isSelf: true };
  if (row.senderName) return { label: row.senderName, isSelf: false };
  const cached = partsRepo.get(db, row.senderUrn);
  if (cached) return { label: cached.name, isSelf: false };
  return { label: row.senderUrn, isSelf: false };
}

export const command = defineCommand({
  meta: { name: "read", description: "Show messages in a thread" },
  args: {
    thread: { type: "positional", description: "Thread id, URN, or prefix" },
    limit: { type: "string", description: "Max messages", default: "50" },
    before: { type: "string", description: "Anchor unix-ms timestamp" },
    "no-refresh": { type: "boolean", description: "Skip network, use cache" },
    json: { type: "boolean", description: "Emit JSON" },
    "no-color": { type: "boolean", description: "Disable colors" },
    db: { type: "string", description: "Path to cache.db" },
    verbose: { type: "boolean", alias: "v", description: "Verbose logging" },
  },
  async run({ args }) {
    await runCommand(async () => {
      const limit = Math.max(1, Number(args["limit"] ?? 50));
      const noRefresh = args["no-refresh"] === true;

      const { ctx, close } = loadContext({
        db: args["db"] as string | undefined,
        json: args["json"] === true,
        noColor: args["no-color"] === true,
        verbose: args["verbose"] === true,
        requireAuth: !noRefresh,
      });
      try {
        const threadArg = (args["thread"] as string | undefined) ?? "";
        if (!threadArg) throw new Error("Thread id required");
        const thread = threadsRepo.findByIdOrPrefix(ctx.db, threadArg);
        if (!thread) {
          throw new Error(`No thread matches "${threadArg}". Try \`linkedin chats\` first.`);
        }

        if (!noRefresh) {
          if (!ctx.client) throw new NotLoggedInError();
          const before = args["before"] ? Number(args["before"]) : Date.now();
          const result = await ctx.client.listMessages(thread.id, {
            countBefore: limit,
            deliveredAt: before,
          });
          upsertMessages(ctx.db, result.items);
        }

        const cacheOpts: { limit: number; before?: number } = { limit };
        if (args["before"]) cacheOpts.before = Number(args["before"]);
        const rows = messagesRepo.listByThread(ctx.db, thread.id, cacheOpts);

        if (ctx.isJson) {
          printJson(rows);
          return;
        }

        const c = colorize(ctx.noColor);
        for (const row of rows) {
          const { label, isSelf } = senderLabel(row, ctx.selfProfileUrn, ctx.db);
          const time = c.dim(fmtMessageTime(row.ts));
          const senderColored = isSelf ? c.dim(label) : c.senderColor(label)(label);
          const body = truncate(row.body.replace(/\r?\n/g, " "), 500);
          process.stdout.write(`${time}  ${senderColored}  ${body}\n`);
        }
      } finally {
        close();
      }
    });
  },
});
