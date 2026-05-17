// `linkedin login` — collect li_at + JSESSIONID, validate via /me, persist.
//
// Cookie source priority: flags > env vars > interactive prompt. We strip
// surrounding quotes the browser dev tools sometimes add to the JSESSIONID
// value because LinkedIn returns it wrapped in literal double-quotes.

import { defineCommand } from "citty";
import { password } from "@inquirer/prompts";

import { auth as authRepo } from "../db/repos.js";
import { VoyagerClient } from "../voyager/client.js";
import {
  loadContext,
  printJson,
  runCommand,
} from "./_shared.js";

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
  return t;
}

const HELP =
  "DevTools → Application → Storage → Cookies → https://www.linkedin.com → copy the value of `li_at` and `JSESSIONID`.";

export const command = defineCommand({
  meta: { name: "login", description: "Authenticate via LinkedIn cookies" },
  args: {
    "li-at": { type: "string", description: "li_at cookie value" },
    jsessionid: { type: "string", description: "JSESSIONID cookie value" },
    "cookie-from-browser": {
      type: "string",
      description: "(stub) extract cookies from <chrome|firefox|safari>",
    },
    json: { type: "boolean", description: "Emit JSON" },
    "no-color": { type: "boolean", description: "Disable colors" },
    db: { type: "string", description: "Path to cache.db" },
    verbose: { type: "boolean", alias: "v", description: "Verbose logging" },
  },
  async run({ args }) {
    await runCommand(async () => {
      if (args["cookie-from-browser"]) {
        process.stderr.write(
          "--cookie-from-browser is not implemented yet, paste cookies instead\n",
        );
        process.exitCode = 5;
        return;
      }

      let liAt = (args["li-at"] as string | undefined) ?? process.env["LINKEDIN_LI_AT"];
      let jsessionid =
        (args["jsessionid"] as string | undefined) ?? process.env["LINKEDIN_JSESSIONID"];

      if (!liAt) {
        liAt = await password({
          message: `Paste li_at cookie value (${HELP}):`,
          mask: "*",
        });
      }
      if (!jsessionid) {
        jsessionid = await password({
          message: "Paste JSESSIONID cookie value:",
          mask: "*",
        });
      }
      liAt = unquote(liAt);
      jsessionid = unquote(jsessionid);
      if (!liAt || !jsessionid) {
        throw new Error("li_at and JSESSIONID are both required");
      }

      const cookieHeader = `li_at=${liAt}; JSESSIONID="${jsessionid}"`;
      const client = new VoyagerClient({ cookieHeader });
      const me = await client.me();

      const { ctx, close } = loadContext({
        db: args["db"] as string | undefined,
        json: args["json"] === true,
        noColor: args["no-color"] === true,
        verbose: args["verbose"] === true,
      });
      try {
        const now = Date.now();
        const name = [me.firstName, me.lastName].filter((x): x is string => !!x).join(" ").trim() || null;
        authRepo.save(ctx.db, {
          liAt,
          jsessionid,
          csrfToken: `ajax:${jsessionid.replace(/^ajax:/, "")}`,
          profileUrn: me.profileUrn,
          profileName: name,
          rawCookieHeader: cookieHeader,
          xLiTrack: null,
          xLiPageInstance: null,
          createdAt: now,
          validatedAt: now,
        });

        if (ctx.isJson) {
          printJson({
            ok: true,
            profileUrn: me.profileUrn,
            name,
            publicIdentifier: me.publicIdentifier ?? null,
          });
        } else {
          const id = me.publicIdentifier ?? me.profileUrn;
          process.stdout.write(`Logged in as ${name ?? "(unknown)"} (${id})\n`);
        }
      } finally {
        close();
      }
    });
  },
});
