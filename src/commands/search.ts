// `linkedin search <query>` — FTS over the local message cache. The DB layer
// returns an FTS snippet with `<b>…</b>` tags around matches; we strip them
// for human output (underlining the matched span) and pass them through in
// JSON mode.

import { defineCommand } from "citty";

import {
  messages as messagesRepo,
  threads as threadsRepo,
} from "../db/repos.js";
import {
  colorize,
  fmtMessageTime,
  loadContext,
  printJson,
  runCommand,
  shortThreadId,
} from "./_shared.js";

function renderSnippet(
  snippet: string,
  c: ReturnType<typeof colorize>,
): string {
  let out = "";
  let i = 0;
  while (i < snippet.length) {
    const open = snippet.indexOf("<b>", i);
    if (open === -1) {
      out += snippet.slice(i);
      break;
    }
    out += snippet.slice(i, open);
    const close = snippet.indexOf("</b>", open + 3);
    if (close === -1) {
      out += snippet.slice(open);
      break;
    }
    const matched = snippet.slice(open + 3, close);
    out += c.underline(matched);
    i = close + 4;
  }
  return out;
}

export const command = defineCommand({
  meta: { name: "search", description: "Full-text search over cached messages" },
  args: {
    query: { type: "positional", description: "Search query" },
    thread: { type: "string", description: "Limit to one thread" },
    limit: { type: "string", description: "Max hits", default: "50" },
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
        const query = (args["query"] as string | undefined) ?? "";
        if (!query) throw new Error("Query required");
        const limit = Math.max(1, Number(args["limit"] ?? 50));

        let threadId: string | undefined;
        if (args["thread"]) {
          const t = threadsRepo.findByIdOrPrefix(ctx.db, args["thread"] as string);
          if (!t) throw new Error(`No thread matches "${args["thread"]}"`);
          threadId = t.id;
        }

        const opts: { limit: number; threadId?: string } = { limit };
        if (threadId) opts.threadId = threadId;
        const hits = messagesRepo.search(ctx.db, query, opts);

        if (ctx.isJson) {
          printJson(hits);
          return;
        }

        const c = colorize(ctx.noColor);
        for (const hit of hits) {
          const tShort = c.dim(`[${shortThreadId(hit.threadId)}]`);
          const time = c.dim(fmtMessageTime(hit.ts));
          const sender = c.senderColor(hit.senderName ?? hit.senderUrn)(
            hit.senderName ?? "unknown",
          );
          process.stdout.write(
            `${tShort} ${time}  ${sender}  ${renderSnippet(hit.snippet, c)}\n`,
          );
        }
      } finally {
        close();
      }
    });
  },
});
