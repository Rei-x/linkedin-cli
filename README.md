# linkedin-cli

Command-line client for LinkedIn messaging. Login with browser cookies, list
conversations, read threads, send messages, watch realtime events — all from
your terminal, all backed by a local SQLite cache.

TypeScript port of selected pieces of [mautrix-linkedin][mautrix] (the
Matrix↔LinkedIn bridge). See [`NOTICE`](./NOTICE) for attribution.

## Disclaimer

**This is an unofficial, third-party project.** It is **not affiliated with,
endorsed by, sponsored by, or otherwise connected to LinkedIn Corporation
or its parent Microsoft Corporation in any way.** "LinkedIn" is a registered
trademark of LinkedIn Corporation, used here only descriptively to identify
the service this tool interacts with (nominative fair use).

This tool talks to LinkedIn's private internal "Voyager" API by replaying
the requests a logged-in web browser would make, using session cookies the
user supplies. It does **not** use any official LinkedIn API or developer
program.

**Use at your own risk:**

- Automated or scripted access to LinkedIn may violate
  [LinkedIn's User Agreement][ua] and
  [Professional Community Policies][pcp]. Using this tool against your own
  account could result in **temporary restriction, permanent suspension, or
  termination** of your account.
- LinkedIn's private API surface changes without notice; commands may break
  at any time.
- This project's authors and contributors accept **no liability** for any
  loss of access, data, time, or anything else arising from use of this
  software. See the [LICENSE](./LICENSE) (AGPLv3, §§ 15-16) for the full
  warranty/liability disclaimer.

Run this only against accounts you own and control, and only for your own
personal use. Do not use it to scrape, harvest, or otherwise interact with
data belonging to other LinkedIn members at scale.

If you are a representative of LinkedIn Corporation and have concerns about
this project, please open a GitHub issue.

[ua]: https://www.linkedin.com/legal/user-agreement
[pcp]: https://www.linkedin.com/legal/professional-community-policies

## Status

Personal-use tool. Works against LinkedIn's unofficial Voyager API. LinkedIn
rotates GraphQL query hashes every few frontend releases, so commands that
depend on them (`chats`, `sync`) may break and need their hashes refreshed;
`read` and `send` use stabler endpoints.

## Install

```sh
git clone https://github.com/Rei-x/linkedin-cli
cd linkedin-cli
npm install
npm run build
npm link        # adds `linkedin` to $PATH
```

Or run directly with `node --import tsx src/cli.ts <command>` during development.

Requires Node ≥ 22.

## Authentication

LinkedIn's login form has captcha/2FA — there's no realistic password flow,
so this CLI uses cookie auth. Grab two values from your logged-in browser:

1. DevTools → Application → Cookies → `https://www.linkedin.com`
2. Copy the `li_at` and `JSESSIONID` values

Then:

```sh
linkedin login                                     # interactive masked prompts
LINKEDIN_LI_AT=... LINKEDIN_JSESSIONID='"ajax:..."' linkedin login   # non-interactive
linkedin login --li-at <value> --jsessionid '"ajax:..."'             # via flags
```

`JSESSIONID` includes the surrounding double quotes — keep them when pasting.

## Commands

```
linkedin login | logout | status
linkedin chats [--limit N] [--unread]
linkedin read <thread-prefix> [--limit N] [--no-refresh]
linkedin send <thread-prefix> "<message>"
linkedin compose <profile-urn> "<message>"
linkedin sync [--full]
linkedin watch [--thread <id>] [-v]
linkedin search "<query>"
linkedin contacts [--search <q>]
linkedin mark-read <thread-prefix>
```

Every command accepts `--json` (machine output), `--no-color`, `--db <path>`,
and `-v`/`--verbose`. Thread arguments accept the full URN or a ≥ 4-char prefix
of the conversation's short id (visible in `linkedin chats`).

## How it works

- **Auth:** cookies in a singleton row of a SQLite table. `csrf-token` is
  derived from `JSESSIONID` (with surrounding quotes stripped — what real
  LinkedIn traffic does).
- **Cache:** `~/.linkedin-cli/cache.db` (SQLite + FTS5 for search).
- **Reads:** the legacy REST `/voyager/api/messaging/conversations/<id>/events`
  endpoint — no rotating GraphQL hash required.
- **Conversation list:** GraphQL `voyagerMessagingGraphQL` (this one *does*
  depend on a query hash; if `chats` starts 400-ing, refresh
  `messengerConversations` in `src/voyager/queryIds.ts` from DevTools).
- **Send:** `voyagerMessagingDashMessengerMessages?action=createMessage`,
  `Content-Type: text/plain;charset=UTF-8`. The `trackingId` field is 16 raw
  bytes interpreted as a latin1 string (a Go ↔ JS porting subtlety mautrix
  gets for free with `string(bytes)`).
- **Realtime:** SSE on `/realtime/connect` + a 60 s POST heartbeat loop.

## Tests

```sh
npm test                  # 163 unit + e2e tests, no network
```

Live tests against linkedin.com are gated on env vars and skipped without
them:

```sh
LINKEDIN_LI_AT=... LINKEDIN_JSESSIONID='"ajax:..."' \
  node_modules/.bin/vitest run test/integration/

# Opt-in live send (actually DMs the recipient):
LINKEDIN_LIVE_SEND_TO='urn:li:msg_conversation:(...)' \
LINKEDIN_LI_AT=... LINKEDIN_JSESSIONID='"ajax:..."' \
  node_modules/.bin/vitest run test/integration/voyager.test.ts
```

## License

[AGPLv3](./LICENSE). Matches the upstream [mautrix-linkedin][mautrix] license.
The `LICENSE.exceptions` carve-outs granted to Beeper and Element by
mautrix-linkedin do **not** apply to this project. See [`NOTICE`](./NOTICE)
for attribution.

If you run this as part of a hosted service that users interact with over a
network, AGPLv3 requires you to offer those users the corresponding source.

[mautrix]: https://github.com/mautrix/linkedin
