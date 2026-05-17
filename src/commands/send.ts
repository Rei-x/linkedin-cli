// `linkedin send <thread> <message>` — append a message to an existing thread.
//
// Flow:
//   1. resolve thread (full URN, full id, or 4+ char prefix)
//   2. insert local-pending row with a generated originToken
//   3. POST to LinkedIn; on success, mark the row delivered with the
//      server-assigned messageUrn and deliveredAt
//
// The local-pending insertion happens FIRST so a crash mid-send still leaves
// a record we can reconcile later.

import { randomUUID } from "node:crypto";
import { defineCommand } from "citty";

import {
  messages as messagesRepo,
  threads as threadsRepo,
} from "../db/repos.js";
import {
  loadContext,
  NotLoggedInError,
  printJson,
  readStdin,
  runCommand,
  shortThreadId,
} from "./_shared.js";

export const command = defineCommand({
  meta: { name: "send", description: "Send a message to an existing thread" },
  args: {
    thread: { type: "positional", description: "Thread id, URN, or prefix" },
    message: {
      type: "positional",
      description: "Message body (omit when using --stdin)",
      required: false,
    },
    stdin: { type: "boolean", description: "Read body from stdin" },
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

        const threadArg = (args["thread"] as string | undefined) ?? "";
        if (!threadArg) throw new Error("Thread id required");
        const thread = threadsRepo.findByIdOrPrefix(ctx.db, threadArg);
        if (!thread) throw new Error(`No thread matches "${threadArg}".`);

        const useStdin = args["stdin"] === true;
        let text = (args["message"] as string | undefined) ?? "";
        if (useStdin) text = (await readStdin()).trimEnd();
        if (!text) throw new Error("Message body is required");

        const originToken = randomUUID();
        const now = Date.now();
        const localId = `local:${originToken}`;
        messagesRepo.insertPending(ctx.db, {
          id: localId,
          threadId: thread.id,
          senderUrn: ctx.selfProfileUrn,
          senderName: ctx.selfProfileName,
          body: text,
          ts: now,
          deliveryState: "local-pending",
          originToken,
          rawJson: null,
        });

        const result = await ctx.client.sendMessage({
          conversationUrn: thread.id,
          text,
          selfProfileUrn: ctx.selfProfileUrn,
          originToken,
        });

        messagesRepo.markDelivered(ctx.db, originToken, result.messageUrn, result.deliveredAt);

        if (ctx.isJson) {
          printJson({
            ok: true,
            messageUrn: result.messageUrn,
            deliveredAt: result.deliveredAt,
            threadId: thread.id,
          });
          return;
        }
        const recipient = thread.title ?? "thread";
        process.stdout.write(`Sent → ${recipient} [${shortThreadId(result.messageUrn)}]\n`);
      } finally {
        close();
      }
    });
  },
});
