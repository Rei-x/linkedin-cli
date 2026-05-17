// LinkedIn Voyager realtime SSE client.
//
// Ground truth: mautrix-linkedin Go reference under
// /tmp/mautrix-linkedin/pkg/linkedingo/realtime.go (lines 89-285). This file
// preserves the same shape:
//
//   * Long-lived GET /realtime/connect?rc=1 with Accept: text/event-stream
//   * 60-second POST heartbeat loop to
//     /realtime/realtimeFrontendClientConnectivityTracking?action=sendHeartbeat
//   * Reconnect with exponential backoff `attempts * 2s`, capped at 60s, max 50
//   * Regenerate the realtime session UUID on a 400 from /realtime/connect
//   * Honor the li_at=delete me sentinel: emit `tokenInvalidated`, do not reconnect
//
// The parser (parseSseLine / parseRealtimeEvent) is a pure function and is
// exported so unit tests can exercise SSE parsing without any network.

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { request, type Dispatcher } from "undici";

import { CookieStore } from "./cookies.js";
import {
  DEFAULT_USER_AGENT,
  DEFAULT_X_LI_PAGE_INSTANCE,
  DEFAULT_X_LI_TRACK,
  defaultHeaders,
  withRealtimeHeaders,
  withXLIHeaders,
  type HeaderContext,
} from "./headers.js";
import { BASE } from "./queryIds.js";
import { X_LI_QUERY_MAP, X_LI_RECIPE_MAP } from "./realtimeMaps.js";

// ────────────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────────────

export interface RealtimeConfig {
  cookieHeader: string;
  userAgent?: string;
  xLiTrack?: string;
  xLiPageInstance?: string;
  actorUrn: string;
}

export type IncomingMessageEvent = {
  kind: "message";
  conversationUrn: string;
  messageUrn: string;
  senderUrn: string;
  senderName: string | null;
  body: string;
  deliveredAt: number;
  raw: unknown;
};

export type ConversationUpdateEvent = {
  kind: "conversation";
  conversationUrn: string;
  raw: unknown;
};

export type TypingEvent = {
  kind: "typing";
  conversationUrn: string;
  senderUrn: string;
  raw: unknown;
};

export type ReadReceiptEvent = {
  kind: "receipt";
  conversationUrn: string;
  readerUrn: string;
  lastReadAt: number;
  raw: unknown;
};

export type HeartbeatEvent = { kind: "heartbeat" };

export type ClientConnectionEvent = {
  kind: "clientConnection";
  raw: unknown;
};

export type RealtimeEvent =
  | IncomingMessageEvent
  | ConversationUpdateEvent
  | TypingEvent
  | ReadReceiptEvent
  | HeartbeatEvent
  | ClientConnectionEvent;

export type DisconnectReason = {
  type: "eof" | "error" | "closed";
  error?: Error;
};

// ────────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────────

const REALTIME_CONNECT_URL = `${BASE}/realtime/connect`;
const REALTIME_HEARTBEAT_URL = `${BASE}/realtime/realtimeFrontendClientConnectivityTracking`;

const MAX_CONNECTION_ATTEMPTS = 50;
const HEARTBEAT_INTERVAL_MS = 60_000;
const SERVICE_VERSION_FALLBACK = "1.13.40953";

// ────────────────────────────────────────────────────────────────────────────
// Untyped JSON helpers (local copies; intentional, since this file is meant
// to be standalone and we want noUncheckedIndexedAccess-friendly access).
// ────────────────────────────────────────────────────────────────────────────

type Json = unknown;

function asObj(v: Json): Record<string, Json> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, Json>)
    : null;
}

function asString(v: Json): string | null {
  return typeof v === "string" ? v : null;
}

function asNumber(v: Json): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function attrText(v: Json): string | null {
  if (typeof v === "string") return v;
  const o = asObj(v);
  if (!o) return null;
  return asString(o.text);
}

// ────────────────────────────────────────────────────────────────────────────
// Pure parsing — exported for unit tests
// ────────────────────────────────────────────────────────────────────────────

/**
 * Parse a single line from an SSE stream. Returns the JSON payload string if
 * this line is `data: <json>`, otherwise null. Tolerant of `\r\n` and `\n`,
 * single optional leading space after the colon, comment lines (`:`),
 * and unrelated SSE fields (`event:`, `id:`, `retry:`).
 *
 * We DO NOT JSON-parse here; that's parseRealtimeEvent's job.
 */
export function parseSseLine(line: string): { dataJson: string } | null {
  // Strip trailing CR/LF so callers can pass whatever the stream gave them.
  let l = line;
  if (l.endsWith("\n")) l = l.slice(0, -1);
  if (l.endsWith("\r")) l = l.slice(0, -1);

  if (l.length === 0) return null;
  if (l.startsWith(":")) return null; // SSE comment

  if (!l.startsWith("data:")) return null;
  let rest = l.slice("data:".length);
  // The SSE spec says a single leading space after the colon is consumed.
  if (rest.startsWith(" ")) rest = rest.slice(1);
  return { dataJson: rest };
}

/**
 * Convert a parsed-JSON realtime event object into a discriminated RealtimeEvent.
 * Returns null for unrecognized payloads (and never throws on shape — JSON.parse
 * errors are caught by the caller).
 */
export function parseRealtimeEvent(json: Json): RealtimeEvent | null {
  const root = asObj(json);
  if (!root) return null;

  // 1) Heartbeat
  if ("com.linkedin.realtimefrontend.Heartbeat" in root) {
    return { kind: "heartbeat" };
  }

  // 2) Client connection
  const clientConn = asObj(root["com.linkedin.realtimefrontend.ClientConnection"]);
  if (clientConn) {
    return { kind: "clientConnection", raw: root };
  }

  // 3) Decorated event
  const decorated = asObj(root["com.linkedin.realtimefrontend.DecoratedEvent"]);
  if (!decorated) return null;

  const payload = asObj(decorated.payload);
  if (!payload) return null;
  const data = asObj(payload.data);
  if (!data) return null;

  // Message
  const msgDec = asObj(data.doDecorateMessageMessengerRealtimeDecoration);
  if (msgDec) {
    const result = asObj(msgDec.result);
    if (!result) return null;
    const messageUrn = asString(result.entityUrn);
    const deliveredAt = asNumber(result.deliveredAt);
    if (!messageUrn || deliveredAt === null) return null;
    const conversationUrn =
      asString(result.conversationUrn) ??
      asString(result.backendConversationUrn) ??
      "";
    const body = attrText(result.body) ?? "";

    let senderUrn = "";
    let senderName: string | null = null;
    const sender = asObj(result.sender);
    if (sender) {
      senderUrn = asString(sender.entityUrn) ?? "";
      const pt = asObj(sender.participantType);
      if (pt) {
        const member = asObj(pt.member);
        if (member) {
          const fn = attrText(member.firstName);
          const ln = attrText(member.lastName);
          const parts: string[] = [];
          if (fn) parts.push(fn);
          if (ln) parts.push(ln);
          if (parts.length > 0) senderName = parts.join(" ");
        }
        if (senderName === null) {
          const org = asObj(pt.organization);
          if (org) {
            const n = attrText(org.name);
            if (n) senderName = n;
          }
        }
      }
    }

    return {
      kind: "message",
      conversationUrn,
      messageUrn,
      senderUrn,
      senderName,
      body,
      deliveredAt,
      raw: root,
    };
  }

  // Conversation update (also covers conversation-delete decoration since both
  // carry a Conversation in `.result`; treating them identically here is fine
  // because higher-level consumers see the raw payload too).
  const convDec =
    asObj(data.doDecorateConversationMessengerRealtimeDecoration) ??
    asObj(data.doDecorateConversationDeleteMessengerRealtimeDecoration);
  if (convDec) {
    const result = asObj(convDec.result);
    if (!result) return null;
    const conversationUrn = asString(result.entityUrn);
    if (!conversationUrn) return null;
    return { kind: "conversation", conversationUrn, raw: root };
  }

  // Typing indicator
  const typingDec = asObj(
    data.doDecorateTypingIndicatorMessengerRealtimeDecoration,
  );
  if (typingDec) {
    const result = asObj(typingDec.result);
    if (!result) return null;
    const participant = asObj(result.typingParticipant);
    const conversation = asObj(result.conversation);
    const senderUrn = participant ? asString(participant.entityUrn) : null;
    const conversationUrn = conversation
      ? asString(conversation.entityUrn)
      : null;
    if (!senderUrn || !conversationUrn) return null;
    return { kind: "typing", conversationUrn, senderUrn, raw: root };
  }

  // Seen receipt
  const seenDec = asObj(data.doDecorateSeenReceiptMessengerRealtimeDecoration);
  if (seenDec) {
    const result = asObj(seenDec.result);
    if (!result) return null;
    const seenAt = asNumber(result.seenAt);
    const reader = asObj(result.seenByParticipant);
    const readerUrn = reader ? asString(reader.entityUrn) : null;
    const message = asObj(result.message);
    const conversationUrn = message
      ? asString(message.conversationUrn) ??
        asString(message.backendConversationUrn)
      : null;
    if (seenAt === null || !readerUrn || !conversationUrn) return null;
    return {
      kind: "receipt",
      conversationUrn,
      readerUrn,
      lastReadAt: seenAt,
      raw: root,
    };
  }

  // Unknown decoration — caller's responsibility to ignore.
  return null;
}

/**
 * Extract the `mpVersion` field from a stringified x-li-track JSON blob.
 * Falls back to the same hardcoded service version the rest of this client
 * uses so heartbeats keep working even when an x-li-track override is malformed.
 */
export function extractMpVersion(xLiTrack: string): string {
  try {
    const parsed = JSON.parse(xLiTrack) as unknown;
    const obj = asObj(parsed);
    if (obj) {
      const v = asString(obj.mpVersion);
      if (v && v.length > 0) return v;
    }
  } catch {
    // fall through
  }
  return SERVICE_VERSION_FALLBACK;
}

// ────────────────────────────────────────────────────────────────────────────
// RealtimeStream
// ────────────────────────────────────────────────────────────────────────────

// Declaration merging gives `on/once/off/emit` strongly-typed overloads without
// having to override the underlying implementation. The runtime behavior is
// unchanged — these are pure type-level signatures.
export interface RealtimeStream {
  on(event: "event", listener: (e: RealtimeEvent) => void): this;
  on(event: "connect", listener: () => void): this;
  on(event: "disconnect", listener: (reason: DisconnectReason) => void): this;
  on(event: "tokenInvalidated", listener: () => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  once(event: "event", listener: (e: RealtimeEvent) => void): this;
  once(event: "connect", listener: () => void): this;
  once(event: "disconnect", listener: (reason: DisconnectReason) => void): this;
  once(event: "tokenInvalidated", listener: () => void): this;
  once(event: "error", listener: (err: Error) => void): this;
  off(
    event: "event" | "connect" | "disconnect" | "tokenInvalidated" | "error",
    listener: (...args: never[]) => void,
  ): this;
  emit(event: "event", e: RealtimeEvent): boolean;
  emit(event: "connect"): boolean;
  emit(event: "disconnect", reason: DisconnectReason): boolean;
  emit(event: "tokenInvalidated"): boolean;
  emit(event: "error", err: Error): boolean;
}

export class RealtimeStream extends EventEmitter {
  private readonly cookies: CookieStore;
  private readonly userAgent: string;
  private readonly xLiTrack: string;
  private readonly xLiPageInstance: string;
  private readonly actorUrn: string;
  private readonly mpVersion: string;

  private _sessionId: string;
  private stopped = false;
  private startResolved = false;
  private startPromise: Promise<void> | null = null;
  private startResolve: (() => void) | null = null;
  private startReject: ((err: Error) => void) | null = null;

  private currentBody: Dispatcher.ResponseData["body"] | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private connectLoopExited: Promise<void> | null = null;

  constructor(config: RealtimeConfig) {
    super();
    this.cookies = CookieStore.fromHeader(config.cookieHeader);
    this.userAgent = config.userAgent ?? DEFAULT_USER_AGENT;
    this.xLiTrack = config.xLiTrack ?? DEFAULT_X_LI_TRACK;
    this.xLiPageInstance =
      config.xLiPageInstance ?? DEFAULT_X_LI_PAGE_INSTANCE;
    this.actorUrn = config.actorUrn;
    this.mpVersion = extractMpVersion(this.xLiTrack);
    this._sessionId = randomUUID();
  }

  get sessionId(): string {
    return this._sessionId;
  }

  /**
   * Open the SSE stream. Resolves once the initial HTTP response is received
   * with a 2xx status code. Subsequent disconnects/reconnects happen in the
   * background and do not re-trigger this promise.
   */
  async start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.stopped = false;
    this.startPromise = new Promise<void>((resolve, reject) => {
      this.startResolve = resolve;
      this.startReject = reject;
    });
    this.connectLoopExited = this.runConnectLoop().catch((err: unknown) => {
      // Final connect loop exit shouldn't bubble — the consumer gets disconnect
      // events instead. Surface unexpected errors via the `error` event.
      const e = err instanceof Error ? err : new Error(String(err));
      this.emit("error", e);
    });
    return this.startPromise;
  }

  /**
   * Cancel reconnects, close the active stream, stop the heartbeat loop.
   * Sends a best-effort isLastHeartbeat=true. Resolves once the connect loop
   * has exited.
   */
  async stop(): Promise<void> {
    if (this.stopped) {
      if (this.connectLoopExited) await this.connectLoopExited;
      return;
    }
    this.stopped = true;

    // Stop heartbeats and send the final one (best-effort).
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    try {
      await this.sendHeartbeat({ isFirst: false, isLast: true });
    } catch {
      // swallow — disconnect is what matters
    }

    // Close the active SSE body if we have one.
    const body = this.currentBody;
    if (body) {
      this.currentBody = null;
      try {
        await body.dump();
      } catch {
        try {
          body.destroy();
        } catch {
          // ignore
        }
      }
    }

    if (this.connectLoopExited) {
      await this.connectLoopExited;
    }

    // If start() was awaiting connect and never resolved, reject it so the
    // caller gets a clean signal rather than hanging forever.
    if (!this.startResolved && this.startReject) {
      this.startReject(new Error("RealtimeStream stopped before connect"));
      this.startResolve = null;
      this.startReject = null;
      this.startResolved = true;
    }
  }

  // ── internals ───────────────────────────────────────────────────────────

  private headerCtx(): HeaderContext {
    const jsess = this.cookies.get("JSESSIONID");
    if (!jsess) {
      throw new Error(
        "JSESSIONID cookie is required for realtime stream (csrf-token)",
      );
    }
    return {
      jsessionid: jsess,
      userAgent: this.userAgent,
      xLiTrack: this.xLiTrack,
      xLiPageInstance: this.xLiPageInstance,
    };
  }

  private buildConnectHeaders(): Record<string, string> {
    const ctx = this.headerCtx();
    const base = defaultHeaders(ctx);
    const merged = withRealtimeHeaders(
      base,
      ctx,
      this._sessionId,
      X_LI_QUERY_MAP,
      X_LI_RECIPE_MAP,
    );
    return {
      ...merged,
      Accept: "text/event-stream",
      Cookie: this.cookies.toCookieHeader(),
    };
  }

  private buildHeartbeatHeaders(): Record<string, string> {
    const ctx = this.headerCtx();
    const base = withXLIHeaders(
      {
        ...defaultHeaders(ctx),
        "Content-Type": "text/plain;charset=UTF-8",
        Accept: "*/*",
        Priority: "u=1, i",
      },
      ctx,
    );
    return {
      ...base,
      Cookie: this.cookies.toCookieHeader(),
    };
  }

  private async runConnectLoop(): Promise<void> {
    let attempts = 0;

    while (!this.stopped) {
      let res: Dispatcher.ResponseData;
      try {
        res = await request(`${REALTIME_CONNECT_URL}?rc=1`, {
          method: "GET",
          headers: this.buildConnectHeaders(),
        });
      } catch (err) {
        if (this.stopped) return;
        attempts += 1;
        const e = err instanceof Error ? err : new Error(String(err));
        this.emit("disconnect", { type: "error", error: e });
        if (attempts > MAX_CONNECTION_ATTEMPTS) {
          if (!this.startResolved && this.startReject) {
            this.startReject(e);
            this.startResolve = null;
            this.startReject = null;
            this.startResolved = true;
          }
          this.emit("error", e);
          return;
        }
        await this.backoffSleep(attempts);
        continue;
      }

      // Merge any Set-Cookie that came back BEFORE inspecting outcome — a 3xx
      // with li_at=delete me is the canonical token-invalidated signal.
      const setCookie = collectSetCookie(res.headers);
      if (setCookie.length > 0) {
        this.cookies.setFromSetCookie(setCookie);
      }
      if (this.cookies.isInvalidated()) {
        try {
          await res.body.dump();
        } catch {
          // ignore
        }
        if (this.heartbeatTimer !== null) {
          clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = null;
        }
        this.emit("tokenInvalidated");
        if (!this.startResolved && this.startReject) {
          this.startReject(new Error("LinkedIn token invalidated"));
          this.startResolve = null;
          this.startReject = null;
          this.startResolved = true;
        }
        return;
      }

      const status = res.statusCode;
      if (status !== 200) {
        try {
          await res.body.dump();
        } catch {
          // ignore
        }
        if (status === 400) {
          // Stale session id — regenerate.
          this._sessionId = randomUUID();
        }
        attempts += 1;
        const err = new Error(`Realtime connect failed: HTTP ${status}`);
        this.emit("disconnect", { type: "error", error: err });
        if (attempts > MAX_CONNECTION_ATTEMPTS) {
          if (!this.startResolved && this.startReject) {
            this.startReject(err);
            this.startResolve = null;
            this.startReject = null;
            this.startResolved = true;
          }
          this.emit("error", err);
          return;
        }
        await this.backoffSleep(attempts);
        continue;
      }

      // Successful connect.
      attempts = 0;
      this.currentBody = res.body;
      this.emit("connect");
      this.ensureHeartbeatLoop();

      if (!this.startResolved && this.startResolve) {
        this.startResolve();
        this.startResolve = null;
        this.startReject = null;
        this.startResolved = true;
      }

      // Stream until EOF or error. We buffer bytes and split on \n; each
      // complete line is fed to parseSseLine.
      let reason: DisconnectReason;
      try {
        await this.readSse(res.body);
        reason = { type: "eof" };
      } catch (err) {
        if (this.stopped) {
          reason = { type: "closed" };
        } else {
          const e = err instanceof Error ? err : new Error(String(err));
          reason = { type: "error", error: e };
        }
      } finally {
        this.currentBody = null;
      }

      this.emit("disconnect", reason);

      if (this.stopped) return;
      // Reconnect immediately on a clean EOF; otherwise back off.
      if (reason.type === "error") {
        attempts += 1;
        if (attempts > MAX_CONNECTION_ATTEMPTS) {
          this.emit("error", reason.error ?? new Error("unknown error"));
          return;
        }
        await this.backoffSleep(attempts);
      }
    }
  }

  private async readSse(
    body: Dispatcher.ResponseData["body"],
  ): Promise<void> {
    let buf = "";
    const decoder = new TextDecoder("utf-8");
    for await (const chunk of body) {
      if (this.stopped) return;
      // chunk is a Buffer in undici; TextDecoder handles both.
      const text =
        typeof chunk === "string"
          ? chunk
          : decoder.decode(chunk as Uint8Array, { stream: true });
      buf += text;

      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const rawLine = buf.slice(0, nl + 1);
        buf = buf.slice(nl + 1);
        this.handleLine(rawLine);
      }
    }
    // Flush any trailing decoder state.
    buf += decoder.decode();
    if (buf.length > 0) this.handleLine(buf);
  }

  private handleLine(line: string): void {
    const parsed = parseSseLine(line);
    if (!parsed) return;

    let json: unknown;
    try {
      json = JSON.parse(parsed.dataJson) as unknown;
    } catch {
      // Malformed JSON: surface as a non-fatal error event and move on.
      // (The Go code treats this as a transient disconnect; we keep the stream
      // open, since one bad line should not cost us the connection.)
      this.emit("error", new Error("Failed to parse realtime SSE JSON"));
      return;
    }

    const event = parseRealtimeEvent(json);
    if (!event) return;
    this.emit("event", event);
  }

  private ensureHeartbeatLoop(): void {
    if (this.heartbeatTimer !== null) return;
    // Fire the first heartbeat immediately, then every 60s. Note the Go
    // reference's payload encodes the FIRST heartbeat with
    // `isFirstHeartbeat: !isFirst` — which is `false` on the first call. We
    // mirror that quirk verbatim so the server-side state machine matches.
    void this.sendHeartbeat({ isFirst: true, isLast: false }).catch(() => {
      // Tracking failures don't kill the loop.
    });
    this.heartbeatTimer = setInterval(() => {
      void this.sendHeartbeat({ isFirst: false, isLast: false }).catch(() => {
        // ignore — keep ticking
      });
    }, HEARTBEAT_INTERVAL_MS);
    // Don't keep the process alive just for heartbeats.
    if (typeof this.heartbeatTimer.unref === "function") {
      this.heartbeatTimer.unref();
    }
  }

  private async sendHeartbeat(args: {
    isFirst: boolean;
    isLast: boolean;
  }): Promise<void> {
    // Mirrors realtime.go:111-156. `isFirstHeartbeat` here is `!isFirst`,
    // which is `false` on the very first call. We send it that way to match.
    const payload = {
      isFirstHeartbeat: !args.isFirst,
      isLastHeartbeat: args.isLast,
      realtimeSessionId: this._sessionId,
      mpName: "voyager-web",
      mpVersion: this.mpVersion,
      clientId: "voyager-web",
      actorUrn: this.actorUrn,
      contextUrns: [this.actorUrn],
    };
    const headers = this.buildHeartbeatHeaders();
    const res = await request(
      `${REALTIME_HEARTBEAT_URL}?action=sendHeartbeat`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      },
    );
    // Drain to release the connection — we don't care about the body.
    try {
      await res.body.dump();
    } catch {
      // ignore
    }
  }

  private async backoffSleep(attempt: number): Promise<void> {
    let backoff = attempt * 2 * 1000;
    if (backoff > 60_000) backoff = 60_000;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, backoff);
      if (typeof t.unref === "function") t.unref();
    });
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Header helpers
// ────────────────────────────────────────────────────────────────────────────

function collectSetCookie(
  headers: Record<string, string | string[] | undefined>,
): string[] {
  const raw = headers["set-cookie"];
  if (raw === undefined) return [];
  if (Array.isArray(raw)) return raw;
  return [raw];
}
