// `linkedin contacts` — read-only view of the cached participants table.

import { defineCommand } from "citty";

import { participants as partsRepo } from "../db/repos.js";
import {
  colorize,
  loadContext,
  padRight,
  printJson,
  runCommand,
  truncate,
} from "./_shared.js";

export const command = defineCommand({
  meta: { name: "contacts", description: "List cached participants" },
  args: {
    search: { type: "string", description: "Filter by substring of name" },
    limit: { type: "string", description: "Max rows", default: "50" },
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
        const limit = Math.max(1, Number(args["limit"] ?? 50));
        const listOpts: { limit: number; search?: string } = { limit };
        if (args["search"]) listOpts.search = args["search"] as string;
        const rows = partsRepo.list(ctx.db, listOpts);

        if (ctx.isJson) {
          printJson(rows);
          return;
        }

        const c = colorize(ctx.noColor);
        const width = process.stdout.columns ?? 100;
        for (const row of rows) {
          const name = c.senderColor(row.name)(padRight(truncate(row.name, 24), 24));
          const handle = c.dim(padRight(row.publicIdentifier ?? "", 24));
          const headline = truncate(row.headline ?? "", Math.max(8, width - 50));
          process.stdout.write(`${name} ${handle} ${headline}\n`);
        }
      } finally {
        close();
      }
    });
  },
});
