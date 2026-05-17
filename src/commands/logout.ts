// `linkedin logout` — drop auth row. Optionally also clear cached threads,
// messages, and participants (default), or keep them via --keep-cache.

import { defineCommand } from "citty";

import { auth as authRepo } from "../db/repos.js";
import { loadContext, printJson, runCommand } from "./_shared.js";

export const command = defineCommand({
  meta: { name: "logout", description: "Forget LinkedIn cookies" },
  args: {
    "keep-cache": {
      type: "boolean",
      description: "Keep threads/messages/participants tables",
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
      });
      try {
        authRepo.clear(ctx.db);
        if (args["keep-cache"] !== true) {
          ctx.db.exec(`DELETE FROM messages; DELETE FROM threads; DELETE FROM participants; DELETE FROM watermark;`);
        }
        if (ctx.isJson) printJson({ ok: true });
        else process.stdout.write("Logged out.\n");
      } finally {
        close();
      }
    });
  },
});
