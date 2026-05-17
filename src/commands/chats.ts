// `linkedin chats` — list recent conversations. Optionally refreshes from
// the network first, then renders the local cache (so output is consistent
// with what `read`/`search` would see).

import { defineCommand } from "citty";

import {
  participants as partsRepo,
  threads as threadsRepo,
  type ThreadRow,
} from "../db/repos.js";
import type { Conversation } from "../voyager/client.js";
import {
  colorize,
  displayName,
  fmtRelativeTime,
  loadContext,
  NotLoggedInError,
  padRight,
  printJson,
  runCommand,
  shortThreadId,
  truncate,
} from "./_shared.js";

function upsertConversations(
  db: import("better-sqlite3").Database,
  convs: Conversation[],
  now: number,
): void {
  for (const c of convs) {
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
}

function participantInfo(
  db: import("better-sqlite3").Database,
  urn: string,
): { urn: string; firstName?: string; lastName?: string } {
  const p = partsRepo.get(db, urn);
  if (!p) return { urn };
  // We don't track first/last separately in the participant cache, so the
  // full name lands in firstName for display purposes.
  return { urn, firstName: p.name };
}

function renderRow(
  row: ThreadRow,
  selfUrn: string | null,
  db: import("better-sqlite3").Database,
  width: number,
  c: ReturnType<typeof colorize>,
): string {
  const tid = padRight(shortThreadId(row.id), 10);
  const who = row.title
    ? row.title
    : displayName(
        row.participants.map((u) => participantInfo(db, u)),
        selfUrn,
      );
  const colored = c.senderColor(who)(padRight(truncate(who, 16), 16));
  const when = padRight(row.lastMsgTs ? fmtRelativeTime(row.lastMsgTs) : "—", 8);
  const status = row.unreadCount > 0 ? c.yellow("UNREAD") : "";
  // Compute remaining width for the preview.
  const fixed = 10 + 1 + 16 + 1 + 1 + 8 + 1 + 6;
  const previewWidth = Math.max(8, width - fixed);
  const previewRaw = row.lastMsgPreview ?? "";
  const preview = padRight(truncate(previewRaw.replace(/\s+/g, " "), previewWidth), previewWidth);
  return `${tid} ${colored} ${preview} ${when} ${status}`.trimEnd();
}

export const command = defineCommand({
  meta: { name: "chats", description: "List conversations" },
  args: {
    limit: { type: "string", description: "Number of threads to show", default: "20" },
    unread: { type: "boolean", description: "Only unread threads" },
    "no-refresh": { type: "boolean", description: "Skip network call, show cache" },
    category: { type: "string", description: "PRIMARY_INBOX | OTHER" },
    json: { type: "boolean", description: "Emit JSON" },
    "no-color": { type: "boolean", description: "Disable colors" },
    db: { type: "string", description: "Path to cache.db" },
    verbose: { type: "boolean", alias: "v", description: "Verbose logging" },
  },
  async run({ args }) {
    await runCommand(async () => {
      const limit = Math.max(1, Number(args["limit"] ?? 20));
      const noRefresh = args["no-refresh"] === true;

      const { ctx, close } = loadContext({
        db: args["db"] as string | undefined,
        json: args["json"] === true,
        noColor: args["no-color"] === true,
        verbose: args["verbose"] === true,
        requireAuth: !noRefresh,
      });
      try {
        if (!noRefresh) {
          if (!ctx.client) throw new NotLoggedInError();
          const category = args["category"] as "PRIMARY_INBOX" | "OTHER" | undefined;
          const opts: { count: number; category?: "PRIMARY_INBOX" | "OTHER" } = {
            count: limit,
          };
          if (category === "PRIMARY_INBOX" || category === "OTHER") {
            opts.category = category;
          }
          const result = await ctx.client.listConversations(opts);
          upsertConversations(ctx.db, result.items, Date.now());
        }

        const rows = threadsRepo.list(ctx.db, {
          limit,
          unreadOnly: args["unread"] === true,
        });

        if (ctx.isJson) {
          printJson(rows);
          return;
        }

        const c = colorize(ctx.noColor);
        const width = process.stdout.columns ?? 100;
        process.stdout.write(
          c.dim(
            `${padRight("THREAD", 10)} ${padRight("WHO", 16)} ${padRight("LAST", Math.max(8, width - 43))} ${padRight("WHEN", 8)} STATUS\n`,
          ),
        );
        for (const row of rows) {
          process.stdout.write(renderRow(row, ctx.selfProfileUrn, ctx.db, width, c) + "\n");
        }
      } finally {
        close();
      }
    });
  },
});
