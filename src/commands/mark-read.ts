// `linkedin mark-read <thread>` — POST a markRead patch upstream, then
// zero the unread count in the local cache.

import { defineCommand } from "citty";

import { threads as threadsRepo } from "../db/repos.js";
import {
  loadContext,
  NotLoggedInError,
  printJson,
  runCommand,
} from "./_shared.js";

export const command = defineCommand({
  meta: { name: "mark-read", description: "Mark a conversation as read" },
  args: {
    thread: { type: "positional", description: "Thread id, URN, or prefix" },
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
        const threadArg = (args["thread"] as string | undefined) ?? "";
        if (!threadArg) throw new Error("Thread id required");
        const thread = threadsRepo.findByIdOrPrefix(ctx.db, threadArg);
        if (!thread) throw new Error(`No thread matches "${threadArg}".`);

        await ctx.client.markRead(thread.id);
        threadsRepo.markRead(ctx.db, thread.id);

        if (ctx.isJson) printJson({ ok: true, threadId: thread.id });
        else process.stdout.write("Marked read.\n");
      } finally {
        close();
      }
    });
  },
});
