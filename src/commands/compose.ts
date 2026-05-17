// `linkedin compose <recipient> <message>` — start a new conversation.
//
// recipient resolution order:
//   1. Already a fsd_profile URN → use verbatim.
//   2. linkedin.com/in/<handle> URL or bare handle → look up in participants
//      cache by public_identifier.
// If we can't resolve, we exit 4 with an actionable hint.

import { defineCommand } from "citty";

import {
  messages as messagesRepo,
  threads as threadsRepo,
} from "../db/repos.js";
import { isUrn } from "../voyager/urn.js";
import {
  loadContext,
  NotLoggedInError,
  printJson,
  runCommand,
  shortThreadId,
} from "./_shared.js";

function extractHandle(input: string): string | null {
  const m = /linkedin\.com\/in\/([^/?#]+)/i.exec(input);
  if (m && m[1]) return m[1];
  if (/^[A-Za-z0-9_-]{2,100}$/.test(input)) return input;
  return null;
}

function resolveRecipient(
  db: import("better-sqlite3").Database,
  raw: string,
): string | null {
  if (isUrn(raw) && raw.startsWith("urn:li:fsd_profile:")) return raw;
  const handle = extractHandle(raw);
  if (!handle) return null;
  const row = db
    .prepare("SELECT urn FROM participants WHERE public_identifier = ? LIMIT 1")
    .get(handle) as { urn: string } | undefined;
  return row?.urn ?? null;
}

export const command = defineCommand({
  meta: { name: "compose", description: "Start a new conversation" },
  args: {
    recipient: { type: "positional", description: "Profile URN, /in/<handle> URL, or handle" },
    message: { type: "positional", description: "First message body" },
    title: { type: "string", description: "Optional conversation title" },
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
        if (!ctx.client || !ctx.selfProfileUrn) throw new NotLoggedInError();
        const recipientArg = (args["recipient"] as string | undefined) ?? "";
        const text = (args["message"] as string | undefined) ?? "";
        if (!recipientArg || !text) throw new Error("Both recipient and message are required");

        const recipientUrn = resolveRecipient(ctx.db, recipientArg);
        if (!recipientUrn) {
          process.stderr.write(
            "Unknown recipient. Provide a URN like `urn:li:fsd_profile:...`\n",
          );
          process.exitCode = 4;
          return;
        }

        const title = args["title"] as string | undefined;
        const result = await ctx.client.startConversation({
          recipientProfileUrns: [recipientUrn],
          text,
          selfProfileUrn: ctx.selfProfileUrn,
          ...(title ? { title } : {}),
        });

        const now = Date.now();
        threadsRepo.upsert(ctx.db, {
          id: result.conversationUrn,
          title: title ?? null,
          participants: [ctx.selfProfileUrn, recipientUrn],
          lastMsgPreview: text.slice(0, 200),
          lastMsgTs: result.deliveredAt,
          unreadCount: 0,
          category: null,
          syncedAt: now,
        });
        messagesRepo.upsert(ctx.db, {
          id: result.messageUrn,
          threadId: result.conversationUrn,
          senderUrn: ctx.selfProfileUrn,
          senderName: ctx.selfProfileName,
          body: text,
          ts: result.deliveredAt,
          deliveryState: "confirmed",
          originToken: null,
          rawJson: null,
        });

        if (ctx.isJson) {
          printJson({
            ok: true,
            conversationUrn: result.conversationUrn,
            messageUrn: result.messageUrn,
            deliveredAt: result.deliveredAt,
          });
          return;
        }
        process.stdout.write(`New thread: ${shortThreadId(result.conversationUrn)}\n`);
      } finally {
        close();
      }
    });
  },
});
