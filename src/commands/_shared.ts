// Shared helpers for command modules.
//
// Owns the lifecycle of a CommandContext (db open + optional VoyagerClient),
// JSON/text output helpers, time formatting, color palette wrapping, and the
// top-level runCommand() error mapper so every subcommand maps known errors
// to consistent exit codes.

import type Database from "better-sqlite3";
import { Chalk } from "chalk";

// Force ANSI codes regardless of TTY detection. We gate emission entirely on
// the explicit `noColor` flag passed to colorize() — callers detect TTY/json
// themselves and pass noColor=true when appropriate.
const chalk = new Chalk({ level: 3 });

import { openDb } from "../db/index.js";
import { auth as authRepo } from "../db/repos.js";
import { defaultDbPath } from "../util/paths.js";
import { LinkedInError, TokenInvalidatedError, VoyagerClient } from "../voyager/client.js";
import { conversationLocalId } from "../voyager/urn.js";

// ────────────────────────────────────────────────────────────────────────────
// Types & errors
// ────────────────────────────────────────────────────────────────────────────

export interface CommandContext {
  db: Database.Database;
  client: VoyagerClient | null;
  isJson: boolean;
  noColor: boolean;
  selfProfileUrn: string | null;
  selfProfileName: string | null;
}

export class NotLoggedInError extends Error {
  constructor(message = "Run `linkedin login` first.") {
    super(message);
    this.name = "NotLoggedInError";
  }
}

export class CookieExpiredError extends Error {
  constructor(message = "Cookie expired or invalid — run `linkedin login` again.") {
    super(message);
    this.name = "CookieExpiredError";
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Context bootstrap
// ────────────────────────────────────────────────────────────────────────────

export interface LoadContextOpts {
  db?: string;
  json?: boolean;
  noColor?: boolean;
  requireAuth?: boolean;
  verbose?: boolean;
}

export function loadContext(opts: LoadContextOpts): {
  ctx: CommandContext;
  close: () => void;
} {
  if (opts.verbose) {
    process.env["DEBUG"] = process.env["DEBUG"] ?? "linkedin:*";
  }

  const dbPath = opts.db ?? defaultDbPath();
  const handle = openDb(dbPath);
  const row = authRepo.get(handle.db);

  let client: VoyagerClient | null = null;
  let selfUrn: string | null = null;
  let selfName: string | null = null;
  if (row) {
    client = new VoyagerClient({
      cookieHeader: row.rawCookieHeader,
      xLiTrack: row.xLiTrack ?? undefined,
      xLiPageInstance: row.xLiPageInstance ?? undefined,
    });
    selfUrn = row.profileUrn;
    selfName = row.profileName;
  } else if (opts.requireAuth) {
    handle.close();
    throw new NotLoggedInError();
  }

  return {
    ctx: {
      db: handle.db,
      client,
      isJson: opts.json === true,
      noColor:
        opts.noColor === true ||
        opts.json === true ||
        process.env["NO_COLOR"] !== undefined ||
        !process.stdout.isTTY,
      selfProfileUrn: selfUrn,
      selfProfileName: selfName,
    },
    close: handle.close,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Output
// ────────────────────────────────────────────────────────────────────────────

export function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

export function printJsonLine(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + "\n");
}

// ────────────────────────────────────────────────────────────────────────────
// Time formatting
// ────────────────────────────────────────────────────────────────────────────

const DAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export function fmtRelativeTime(ts: number, now: number = Date.now()): string {
  const diff = now - ts;
  if (diff < 60_000) return "now";
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 24 * 60 * 60_000) return `${Math.floor(diff / (60 * 60_000))}h ago`;
  if (diff < 2 * 24 * 60 * 60_000) return "yday";
  if (diff < 7 * 24 * 60 * 60_000) {
    const d = new Date(ts);
    return DAYS_SHORT[d.getDay()] ?? "?";
  }
  const d = new Date(ts);
  return `${MONTHS_SHORT[d.getMonth()] ?? "?"} ${d.getDate()}`;
}

export function fmtClockTime(ts: number): string {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

export function fmtMessageTime(ts: number, now: number = Date.now()): string {
  const day = DAYS_SHORT[new Date(ts).getDay()] ?? "?";
  const time = fmtClockTime(ts);
  const diffDays = (now - ts) / (24 * 60 * 60_000);
  if (diffDays < 7) return `${day} ${time}`;
  const d = new Date(ts);
  return `${MONTHS_SHORT[d.getMonth()] ?? "?"} ${d.getDate()} ${time}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Color palette
// ────────────────────────────────────────────────────────────────────────────

type Color = (s: string) => string;

const SENDER_PALETTE_NAMES = [
  "cyan",
  "green",
  "yellow",
  "magenta",
  "blue",
  "red",
  "blueBright",
  "magentaBright",
] as const;

type SenderColorName = (typeof SENDER_PALETTE_NAMES)[number];

const senderPalette: Color[] = SENDER_PALETTE_NAMES.map((n: SenderColorName) => {
  return (s: string) => chalk[n](s);
});

function hashKey(key: string): number {
  let h = 5381;
  for (let i = 0; i < key.length; i++) {
    h = ((h << 5) + h + key.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export interface Colorizer {
  dim: Color;
  bold: Color;
  cyan: Color;
  yellow: Color;
  red: Color;
  green: Color;
  underline: Color;
  senderColor: (key: string) => Color;
}

const identity: Color = (s) => s;

export function colorize(noColor: boolean): Colorizer {
  if (noColor) {
    return {
      dim: identity,
      bold: identity,
      cyan: identity,
      yellow: identity,
      red: identity,
      green: identity,
      underline: identity,
      senderColor: () => identity,
    };
  }
  return {
    dim: (s) => chalk.dim(s),
    bold: (s) => chalk.bold(s),
    cyan: (s) => chalk.cyan(s),
    yellow: (s) => chalk.yellow(s),
    red: (s) => chalk.red(s),
    green: (s) => chalk.green(s),
    underline: (s) => chalk.underline(s),
    senderColor: (key: string) => {
      const fn = senderPalette[hashKey(key) % senderPalette.length];
      return fn ?? identity;
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Error mapping
// ────────────────────────────────────────────────────────────────────────────

export async function runCommand(body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (err) {
    if (err instanceof NotLoggedInError) {
      process.stderr.write("Run `linkedin login` first.\n");
      process.exitCode = 2;
      return;
    }
    if (err instanceof TokenInvalidatedError) {
      process.stderr.write("Cookie expired or invalid — run `linkedin login` again.\n");
      process.exitCode = 3;
      return;
    }
    if (err instanceof CookieExpiredError) {
      process.stderr.write(`${err.message}\n`);
      process.exitCode = 3;
      return;
    }
    if (err instanceof LinkedInError) {
      const status = err.status === null ? "" : ` (HTTP ${err.status})`;
      process.stderr.write(`LinkedIn error${status}: ${err.message}\n`);
      if (err.body !== undefined && err.body !== null) {
        const bodyStr =
          typeof err.body === "string"
            ? err.body
            : JSON.stringify(err.body);
        if (bodyStr.length > 0 && bodyStr !== "{}") {
          process.stderr.write(`  response: ${bodyStr.slice(0, 800)}\n`);
        }
      }
      process.exitCode = 4;
      return;
    }
    if (err instanceof Error) {
      process.stderr.write(`Error: ${err.message}\n`);
    } else {
      process.stderr.write(`Error: ${String(err)}\n`);
    }
    process.exitCode = 1;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Misc helpers
// ────────────────────────────────────────────────────────────────────────────

export function truncate(s: string, width: number): string {
  if (s.length <= width) return s;
  if (width <= 1) return s.slice(0, width);
  return s.slice(0, width - 1) + "…";
}

export function padRight(s: string, width: number): string {
  if (s.length >= width) return s;
  return s + " ".repeat(width - s.length);
}

export function shortThreadId(threadUrn: string): string {
  // LinkedIn conversation ids look like "2-NDU4N2VjMjctNGNiZi00...XzAxMA==".
  // Trailing chars are base64 padding shared across threads, so we slice from
  // the front of the variable portion (after a "2-" / "3-" mailbox prefix).
  const local = conversationLocalId(threadUrn);
  const variable = local.replace(/^\d+-/, "");
  return variable.slice(0, 7) || local.slice(0, 7);
}

export function displayName(
  participants: { firstName?: string; lastName?: string; urn: string }[],
  selfUrn: string | null,
): string {
  const others = participants.filter((p) => p.urn !== selfUrn);
  if (others.length === 0) return "(you)";
  const head = others[0]!;
  const headName = [head.firstName, head.lastName].filter((x): x is string => !!x).join(" ") || head.urn;
  if (others.length === 1) return headName;
  return `${headName} +${others.length - 1}`;
}

export async function readStdin(): Promise<string> {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return data;
}
