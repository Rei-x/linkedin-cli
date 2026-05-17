// `linkedin status` — quick view of auth state + cache size + last sync time.

import { defineCommand } from "citty";

import { auth as authRepo, watermark } from "../db/repos.js";
import {
  colorize,
  fmtRelativeTime,
  loadContext,
  printJson,
  runCommand,
} from "./_shared.js";

function fmtCookieAge(createdAt: number, now: number = Date.now()): string {
  const days = Math.floor((now - createdAt) / (24 * 60 * 60_000));
  if (days >= 1) return `${days}d`;
  const hours = Math.floor((now - createdAt) / (60 * 60_000));
  if (hours >= 1) return `${hours}h`;
  const mins = Math.floor((now - createdAt) / 60_000);
  return `${mins}m`;
}

export const command = defineCommand({
  meta: { name: "status", description: "Show login & sync status" },
  args: {
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
      });
      try {
        const row = authRepo.get(ctx.db);
        const threadCount = (ctx.db.prepare("SELECT COUNT(*) AS c FROM threads").get() as { c: number }).c;
        const msgCount = (ctx.db.prepare("SELECT COUNT(*) AS c FROM messages").get() as { c: number }).c;
        const lastSyncRaw = watermark.get(ctx.db, "last_sync_at");
        const lastSync = lastSyncRaw ? Number(lastSyncRaw) : null;

        if (ctx.isJson) {
          printJson({
            loggedIn: row !== null,
            profileUrn: row?.profileUrn ?? null,
            profileName: row?.profileName ?? null,
            cookieCreatedAt: row?.createdAt ?? null,
            cookieValidatedAt: row?.validatedAt ?? null,
            threads: threadCount,
            messages: msgCount,
            lastSyncAt: lastSync,
          });
          return;
        }

        const c = colorize(ctx.noColor);
        if (!row) {
          process.stdout.write("Not logged in. Run `linkedin login`.\n");
          process.stdout.write(`Cache: ${threadCount} threads, ${msgCount} messages\n`);
          return;
        }
        const name = row.profileName ?? "(unknown)";
        process.stdout.write(`Logged in as ${c.bold(name)}\n`);
        process.stdout.write(`Profile: ${c.dim(row.profileUrn)}\n`);
        process.stdout.write(`Cookie age: ${fmtCookieAge(row.createdAt)}\n`);
        process.stdout.write(`Cache: ${threadCount} threads, ${msgCount} messages\n`);
        process.stdout.write(
          `Last sync: ${lastSync !== null ? fmtRelativeTime(lastSync) : "never"}\n`,
        );
      } finally {
        close();
      }
    });
  },
});
