// LinkedIn Voyager HTTP client.
//
// Ground truth: mautrix-linkedin Go reference under
// /tmp/mautrix-linkedin/pkg/linkedingo/ — particularly request.go (retry,
// redirect, token-invalidated), self.go (Me), conversations.go (list), and
// messages.go (send/list). This file matches the request shapes line-for-line
// where it matters; deviations are commented.

import { randomBytes, randomUUID } from "node:crypto";
import { request, type Dispatcher } from "undici";

import { CookieStore } from "./cookies.js";
import {
  DEFAULT_USER_AGENT,
  DEFAULT_X_LI_PAGE_INSTANCE,
  DEFAULT_X_LI_TRACK,
  defaultHeaders,
  withXLIHeaders,
} from "./headers.js";
import {
  GRAPHQL_URL,
  MESSAGES_URL,
  VOYAGER,
  messengerConversations,
  messengerConversationsWithCursor,
} from "./queryIds.js";
import { encodeRestLi } from "./restli.js";
import { conversationLocalId, profileUrn, withPrefix } from "./urn.js";

// ────────────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────────────

export interface ClientConfig {
  cookieHeader: string;
  userAgent?: string;
  xLiTrack?: string;
  xLiPageInstance?: string;
  retries?: number;
}

export interface MeResponse {
  profileUrn: string;
  memberId: string;
  firstName?: string;
  lastName?: string;
  publicIdentifier?: string;
}

export interface ConversationParticipant {
  urn: string;
  firstName?: string;
  lastName?: string;
  publicIdentifier?: string;
}

export interface Conversation {
  urn: string;
  title: string | null;
  participants: ConversationParticipant[];
  lastMessageAt: number | null;
  lastMessagePreview: string | null;
  unreadCount: number;
  category: string | null;
  raw: unknown;
}

export interface Message {
  urn: string;
  conversationUrn: string;
  senderUrn: string;
  senderName: string | null;
  body: string;
  deliveredAt: number;
  raw: unknown;
}

export interface ListResult<T> {
  items: T[];
  nextCursor: string | null;
  prevCursor: string | null;
}

// ────────────────────────────────────────────────────────────────────────────
// Errors
// ────────────────────────────────────────────────────────────────────────────

export class LinkedInError extends Error {
  public readonly status: number | null;
  public readonly body?: unknown;
  constructor(message: string, status: number | null, body?: unknown) {
    super(message);
    this.name = "LinkedInError";
    this.status = status;
    this.body = body;
  }
}

export class TokenInvalidatedError extends LinkedInError {
  constructor(message = "LinkedIn token invalidated (li_at deleted by server)") {
    super(message, null);
    this.name = "TokenInvalidatedError";
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Internal helpers (untyped JSON walking)
// ────────────────────────────────────────────────────────────────────────────

type Json = unknown;

function asObj(v: Json): Record<string, Json> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, Json>)
    : null;
}

function asArray(v: Json): Json[] | null {
  return Array.isArray(v) ? v : null;
}

function asString(v: Json): string | null {
  return typeof v === "string" ? v : null;
}

function asNumber(v: Json): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function pickPath(root: Json, path: string[]): Json {
  let cur: Json = root;
  for (const seg of path) {
    const o = asObj(cur);
    if (!o) return undefined;
    cur = o[seg];
  }
  return cur;
}

// Pulls a "text" string out of either a plain string or an AttributedText.
function attrText(v: Json): string | null {
  if (typeof v === "string") return v;
  const o = asObj(v);
  if (!o) return null;
  return asString(o.text);
}

// ────────────────────────────────────────────────────────────────────────────
// Header normalization
// ────────────────────────────────────────────────────────────────────────────

function collectSetCookie(
  headers: Record<string, string | string[] | undefined>,
): string[] {
  // undici lowercases header names. The Set-Cookie key may be `set-cookie` and
  // typically arrives as a string[] (one entry per cookie), but some shapes
  // return a single string.
  const raw = headers["set-cookie"];
  if (raw === undefined) return [];
  if (Array.isArray(raw)) return raw;
  return [raw];
}

// ────────────────────────────────────────────────────────────────────────────
// VoyagerClient
// ────────────────────────────────────────────────────────────────────────────

export class VoyagerClient {
  private readonly cookies: CookieStore;
  private readonly userAgent: string;
  private readonly xLiTrack: string;
  private readonly xLiPageInstance: string;
  private readonly maxRetries: number;

  constructor(config: ClientConfig) {
    this.cookies = CookieStore.fromHeader(config.cookieHeader);
    this.userAgent = config.userAgent ?? DEFAULT_USER_AGENT;
    this.xLiTrack = config.xLiTrack ?? DEFAULT_X_LI_TRACK;
    this.xLiPageInstance =
      config.xLiPageInstance ?? DEFAULT_X_LI_PAGE_INSTANCE;
    this.maxRetries = config.retries ?? 5;
  }

  // ── core request ───────────────────────────────────────────────────────

  private jsessionidOrThrow(): string {
    const v = this.cookies.get("JSESSIONID");
    if (!v) {
      throw new LinkedInError(
        "JSESSIONID cookie is required (used as csrf-token)",
        null,
      );
    }
    return v;
  }

  private baseHeaderCtx(): {
    jsessionid: string;
    userAgent: string;
    xLiTrack: string;
    xLiPageInstance: string;
  } {
    return {
      jsessionid: this.jsessionidOrThrow(),
      userAgent: this.userAgent,
      xLiTrack: this.xLiTrack,
      xLiPageInstance: this.xLiPageInstance,
    };
  }

  private mergeHeaders(extra: Record<string, string>): Record<string, string> {
    const headers = {
      ...defaultHeaders(this.baseHeaderCtx()),
      ...extra,
      Cookie: this.cookies.toCookieHeader(),
    };
    return headers;
  }

  /**
   * Low-level request: handles retries, redirects, token invalidation,
   * cookie jar updates. Returns parsed JSON (or null if body is empty).
   */
  private async doRequest(opts: {
    method: Dispatcher.HttpMethod;
    url: string;
    rawQuery?: string;
    headers: Record<string, string>;
    body?: string;
    // If false, even a 2xx response is not parsed as JSON. We default to true.
    parseJson?: boolean;
  }): Promise<{ status: number; json: Json; raw: string }> {
    let attempt = 0;
    let delayMs = 2000;
    let lastError: unknown = null;
    const fullUrl = opts.rawQuery
      ? `${opts.url}?${opts.rawQuery}`
      : opts.url;

    while (attempt <= this.maxRetries) {
      attempt += 1;
      try {
        // undici.request does not follow redirects by default — exactly
        // what we want: a 3xx with `li_at=delete me` is the reliable
        // token-invalidated signal (see request.go checkHTTPRedirect).
        const res = await request(fullUrl, {
          method: opts.method,
          headers: opts.headers,
          body: opts.body,
        });

        // Pull and merge any Set-Cookie BEFORE we decide outcome — even on a
        // 3xx that we treat as failure, we want to see whether li_at was
        // killed.
        const setCookie = collectSetCookie(res.headers);
        if (setCookie.length > 0) {
          this.cookies.setFromSetCookie(setCookie);
        }
        if (this.cookies.isInvalidated()) {
          // Drain and throw.
          await res.body.dump();
          throw new TokenInvalidatedError();
        }

        const status = res.statusCode;

        // 50x → retry. Anything else (success or 4xx) → return / error.
        if (status === 502 || status === 503 || status === 504) {
          await res.body.dump();
          if (attempt > this.maxRetries) {
            throw new LinkedInError(
              `Upstream ${status} after ${attempt - 1} retries`,
              status,
            );
          }
          await sleep(delayMs);
          delayMs *= 2;
          continue;
        }

        const raw = await res.body.text();

        // Treat 3xx (which we did NOT follow) as failure: LinkedIn redirecting
        // unauthenticated traffic to login is the typical case here.
        if (status >= 300 && status < 400) {
          throw new LinkedInError(
            `Unexpected redirect ${status} from ${opts.url}`,
            status,
            safeJson(raw),
          );
        }

        if (status >= 400) {
          throw new LinkedInError(
            `HTTP ${status} from ${opts.url}`,
            status,
            safeJson(raw),
          );
        }

        if (opts.parseJson === false) {
          return { status, json: null, raw };
        }
        return { status, json: safeJson(raw), raw };
      } catch (err) {
        // TokenInvalidatedError and LinkedInError-with-status are terminal.
        if (err instanceof TokenInvalidatedError) throw err;
        if (err instanceof LinkedInError && err.status !== null) throw err;
        lastError = err;
        if (attempt > this.maxRetries) {
          throw new LinkedInError(
            `Network error after ${attempt - 1} retries: ${errMessage(err)}`,
            null,
            err,
          );
        }
        await sleep(delayMs);
        delayMs *= 2;
      }
    }

    throw new LinkedInError(
      `Retry loop exited unexpectedly: ${errMessage(lastError)}`,
      null,
    );
  }

  // ── /me ────────────────────────────────────────────────────────────────

  async me(): Promise<MeResponse> {
    // me() is one of the few endpoints that only needs csrf-token + UA + cookie
    // (no x-li-* headers). See self.go:47-55.
    const headers = this.mergeHeaders({});
    const { json } = await this.doRequest({
      method: "GET",
      url: `${VOYAGER}/me`,
      headers,
    });

    const mini = asObj(pickPath(json, ["miniProfile"]));
    if (!mini) {
      throw new LinkedInError(
        "Unexpected /me response: missing miniProfile",
        200,
        json,
      );
    }
    const entityUrn = asString(mini.entityUrn);
    if (!entityUrn) {
      throw new LinkedInError(
        "Unexpected /me response: missing miniProfile.entityUrn",
        200,
        json,
      );
    }
    // entityUrn is `urn:li:fs_miniProfile:<id>` — convert to fsd_profile.
    const fsd = withPrefix(entityUrn, "urn:li:fsd_profile");
    const memberId = fsd.slice("urn:li:fsd_profile:".length);

    const out: MeResponse = {
      profileUrn: fsd,
      memberId,
    };
    const fn = asString(mini.firstName);
    if (fn) out.firstName = fn;
    const ln = asString(mini.lastName);
    if (ln) out.lastName = ln;
    const pi = asString(mini.publicIdentifier);
    if (pi) out.publicIdentifier = pi;
    return out;
  }

  // ── conversations ─────────────────────────────────────────────────────

  async listConversations(opts?: {
    lastUpdatedBefore?: number;
    count?: number;
    category?: "PRIMARY_INBOX" | "OTHER";
  }): Promise<ListResult<Conversation>> {
    const me = await this.me();
    // mailboxUrn is the self profile URN, URL-encoded so the outer Rest.li
    // grammar doesn't choke on the inner colons. We pass it as a *pre-encoded*
    // value via encodeRestLi("string") — which means we need to encode our
    // value here manually and then trust restli's percent re-encoding to be
    // idempotent on already-percent-encoded chars.
    //
    // To match the Go ref exactly (which feeds url.QueryEscape into
    // queriesToString verbatim), we sidestep our higher-level encodeRestLi
    // for the value and build the variables string by hand.
    const mailboxUrn = encodeURIComponent(me.profileUrn);
    const useCursor = typeof opts?.lastUpdatedBefore === "number";
    const category = opts?.category ?? "PRIMARY_INBOX";

    let queryId: string;
    let variables: string;
    if (useCursor) {
      const count = opts?.count ?? 20;
      // (mailboxUrn:<enc>,lastUpdatedBefore:<n>,count:<n>,query:(predicateUnions:List((conversationCategoryPredicate:(category:PRIMARY_INBOX)))))
      const queryPredicate =
        `(predicateUnions:List((conversationCategoryPredicate:(category:${category}))))`;
      variables =
        `(mailboxUrn:${mailboxUrn},lastUpdatedBefore:${opts!.lastUpdatedBefore},count:${count},query:${queryPredicate})`;
      queryId = messengerConversationsWithCursor;
    } else {
      variables = `(mailboxUrn:${mailboxUrn})`;
      queryId = messengerConversations;
    }

    const rawQuery = `queryId=${queryId}&variables=${variables}`;
    const headers = this.mergeHeaders(
      withXLIHeaders(defaultHeaders(this.baseHeaderCtx()), this.baseHeaderCtx()),
    );

    const { json } = await this.doRequest({
      method: "GET",
      url: GRAPHQL_URL,
      rawQuery,
      headers,
    });

    return parseConversationList(json, opts?.count);
  }

  // ── messages ──────────────────────────────────────────────────────────

  async listMessages(
    conversationUrn: string,
    opts?: {
      deliveredAt?: number;
      countBefore?: number;
      countAfter?: number;
      prevCursor?: string;
    },
  ): Promise<ListResult<Message>> {
    // We use the legacy REST `/voyager/api/messaging/conversations/<id>/events`
    // endpoint rather than the messengerMessages GraphQL queries. The GraphQL
    // hashes rotate every few LinkedIn frontend releases and are hard to
    // discover automatically; the REST endpoint takes a stable conversation
    // id and a `createdBefore` cursor instead.
    const convLocal = conversationLocalId(conversationUrn);
    const url = `${VOYAGER}/messaging/conversations/${encodeURIComponent(convLocal)}/events`;
    const params: string[] = ["keyVersion=LEGACY_INBOX"];
    const count = opts?.countBefore ?? 20;
    params.push(`count=${count}`);
    if (opts?.deliveredAt !== undefined) {
      params.push(`createdBefore=${opts.deliveredAt}`);
    }
    if (opts?.prevCursor) {
      // `prevCursor` is repurposed as a createdBefore timestamp for the legacy
      // endpoint when the GraphQL client used to surface it.
      params.push(`createdBefore=${encodeURIComponent(opts.prevCursor)}`);
    }
    const rawQuery = params.join("&");

    const headers = this.mergeHeaders(
      withXLIHeaders(defaultHeaders(this.baseHeaderCtx()), this.baseHeaderCtx()),
    );

    const { json } = await this.doRequest({
      method: "GET",
      url,
      rawQuery,
      headers,
    });

    return parseLegacyEventList(json, conversationUrn);
  }

  // ── send ──────────────────────────────────────────────────────────────

  async sendMessage(args: {
    conversationUrn: string;
    text: string;
    selfProfileUrn: string;
    originToken?: string;
  }): Promise<{
    messageUrn: string;
    deliveredAt: number;
    originToken: string;
  }> {
    const originToken = args.originToken ?? randomUUID();
    const trackingId = randomTrackingId();

    const body = {
      message: {
        body: { text: args.text, attributes: [] as unknown[] },
        renderContentUnions: [] as unknown[],
        conversationUrn: args.conversationUrn,
        originToken,
      },
      mailboxUrn: args.selfProfileUrn,
      trackingId,
      dedupeByClientGeneratedToken: false,
    };

    // LinkedIn requires text/plain;charset=UTF-8 here. JSON is in the body.
    const headers = this.mergeHeaders(
      withXLIHeaders(
        {
          ...defaultHeaders(this.baseHeaderCtx()),
          "Content-Type": "text/plain;charset=UTF-8",
        },
        this.baseHeaderCtx(),
      ),
    );

    const { json } = await this.doRequest({
      method: "POST",
      url: MESSAGES_URL,
      rawQuery: "action=createMessage",
      headers,
      body: JSON.stringify(body),
    });

    // Response: { value: { entityUrn, deliveredAt, ... } } (per messages.go
    // MessageSentResponse → `Data Message json:"value"`).
    const value = asObj(pickPath(json, ["value"]));
    if (!value) {
      throw new LinkedInError(
        "Send response missing `value` field",
        200,
        json,
      );
    }
    const messageUrn =
      asString(value.entityUrn) ?? asString(value.backendUrn) ?? null;
    const deliveredAt = asNumber(value.deliveredAt);
    if (!messageUrn || deliveredAt === null) {
      throw new LinkedInError(
        "Send response missing entityUrn / deliveredAt",
        200,
        json,
      );
    }
    return { messageUrn, deliveredAt, originToken };
  }

  async startConversation(args: {
    recipientProfileUrns: string[];
    text: string;
    selfProfileUrn: string;
    title?: string;
  }): Promise<{
    conversationUrn: string;
    messageUrn: string;
    deliveredAt: number;
  }> {
    const originToken = randomUUID();
    const trackingId = randomTrackingId();

    const body: Record<string, unknown> = {
      message: {
        body: { text: args.text, attributes: [] as unknown[] },
        renderContentUnions: [] as unknown[],
        originToken,
      },
      mailboxUrn: args.selfProfileUrn,
      trackingId,
      dedupeByClientGeneratedToken: false,
      hostRecipientUrns: args.recipientProfileUrns,
    };
    if (args.title) body.conversationTitle = args.title;

    const headers = this.mergeHeaders(
      withXLIHeaders(
        {
          ...defaultHeaders(this.baseHeaderCtx()),
          "Content-Type": "text/plain;charset=UTF-8",
        },
        this.baseHeaderCtx(),
      ),
    );

    const { json } = await this.doRequest({
      method: "POST",
      url: MESSAGES_URL,
      rawQuery: "action=createMessage",
      headers,
      body: JSON.stringify(body),
    });

    const value = asObj(pickPath(json, ["value"]));
    if (!value) {
      throw new LinkedInError(
        "startConversation response missing `value`",
        200,
        json,
      );
    }
    const messageUrn = asString(value.entityUrn);
    const deliveredAt = asNumber(value.deliveredAt);
    const conversationUrn =
      asString(pickPath(value, ["conversationUrn"])) ??
      asString(pickPath(value, ["conversation", "entityUrn"])) ??
      null;
    if (!messageUrn || deliveredAt === null || !conversationUrn) {
      throw new LinkedInError(
        "startConversation response missing conversationUrn / entityUrn / deliveredAt",
        200,
        json,
      );
    }
    return { conversationUrn, messageUrn, deliveredAt };
  }

  // ── markRead ──────────────────────────────────────────────────────────

  async markRead(conversationUrn: string): Promise<void> {
    // See receipts.go:60-91. The request is a POST to
    // .../voyagerMessagingDashMessengerConversations with rawQuery
    //   ids=List(<urlescaped(convUrn)>)
    // and body
    //   { "entities": { "<convUrn>": { "patch": { "$set": { "read": true } } } } }
    const url =
      VOYAGER + "/voyagerMessagingDashMessengerConversations";
    const encConv = encodeURIComponent(conversationUrn);
    const rawQuery = `ids=List(${encConv})`;

    const body = {
      entities: {
        [conversationUrn]: {
          patch: { $set: { read: true } },
        },
      },
    };

    const headers = this.mergeHeaders(
      withXLIHeaders(
        {
          ...defaultHeaders(this.baseHeaderCtx()),
          "Content-Type": "text/plain;charset=UTF-8",
          Accept: "application/json",
        },
        this.baseHeaderCtx(),
      ),
    );

    await this.doRequest({
      method: "POST",
      url,
      rawQuery,
      headers,
      body: JSON.stringify(body),
      parseJson: false,
    });
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Parsing: conversations
// ────────────────────────────────────────────────────────────────────────────

function parseConversationList(
  json: Json,
  cap: number | undefined,
): ListResult<Conversation> {
  const data = asObj(pickPath(json, ["data"]));
  if (!data) {
    return { items: [], nextCursor: null, prevCursor: null };
  }

  // The GraphQL response keys we accept (mirroring GraphQLData in
  // conversations.go:37-42).
  const candidateKeys = [
    "messengerConversationsByCategoryQuery",
    "messengerConversationsBySyncToken",
    "messengerConversationsByCategory",
    "messengerConversationsByAnchor",
    "messengerConversationsByCategoryQueryWithCursor",
  ];
  let payload: Record<string, Json> | null = null;
  for (const k of candidateKeys) {
    const v = asObj(data[k]);
    if (v) {
      payload = v;
      break;
    }
  }
  if (!payload) {
    // Fall back: pick the first object child that has an `elements` array.
    for (const [, v] of Object.entries(data)) {
      const o = asObj(v);
      if (o && asArray(o.elements)) {
        payload = o;
        break;
      }
    }
  }
  if (!payload) {
    return { items: [], nextCursor: null, prevCursor: null };
  }

  const elements = asArray(payload.elements) ?? [];
  const metadata = asObj(payload.metadata);
  const nextCursor = metadata ? asString(metadata.nextCursor) : null;
  const prevCursor = metadata ? asString(metadata.prevCursor) : null;

  let items = elements
    .map((e) => parseConversation(e))
    .filter((c): c is Conversation => c !== null);
  if (typeof cap === "number" && items.length > cap) {
    items = items.slice(0, cap);
  }

  return { items, nextCursor, prevCursor };
}

function parseConversation(node: Json): Conversation | null {
  const obj = asObj(node);
  if (!obj) return null;
  const urn = asString(obj.entityUrn);
  if (!urn) return null;

  const title = asString(obj.title) ?? null;
  const lastMessageAt = asNumber(obj.lastActivityAt) ?? null;
  const read = obj.read === true;
  // LinkedIn doesn't return a per-conversation unread count here; we surface
  // 0 vs 1 as a proxy based on the `read` flag (see Conversation.Read in
  // conversations.go:128). Consumers can compute a more accurate count from
  // listMessages if needed.
  const unreadCount = read ? 0 : 1;
  const categories = asArray(obj.categories);
  const category =
    categories && categories.length > 0
      ? asString(categories[0]) ?? null
      : null;

  // Last message preview: the embedded `messages.elements[0].body.text`.
  let lastMessagePreview: string | null = null;
  const messages = asObj(obj.messages);
  if (messages) {
    const msgEls = asArray(messages.elements);
    if (msgEls && msgEls.length > 0) {
      const first = asObj(msgEls[0]);
      if (first) {
        lastMessagePreview = attrText(first.body);
      }
    }
  }

  const participants: ConversationParticipant[] = [];
  const partsArr = asArray(obj.conversationParticipants);
  if (partsArr) {
    for (const p of partsArr) {
      const po = asObj(p);
      if (!po) continue;
      const pUrn = asString(po.entityUrn);
      if (!pUrn) continue;
      const part: ConversationParticipant = { urn: pUrn };
      const pType = asObj(po.participantType);
      if (pType) {
        const member = asObj(pType.member);
        if (member) {
          const fn = attrText(member.firstName);
          if (fn) part.firstName = fn;
          const ln = attrText(member.lastName);
          if (ln) part.lastName = ln;
          const pubId = profilePublicId(asString(member.profileUrl));
          if (pubId) part.publicIdentifier = pubId;
        }
        const org = asObj(pType.organization);
        if (org && !part.firstName) {
          const name = attrText(org.name);
          if (name) part.firstName = name;
        }
      }
      participants.push(part);
    }
  }

  return {
    urn,
    title,
    participants,
    lastMessageAt,
    lastMessagePreview,
    unreadCount,
    category,
    raw: node,
  };
}

function profilePublicId(profileUrl: string | null): string | null {
  if (!profileUrl) return null;
  // e.g. "https://www.linkedin.com/in/some-id-12345"
  const m = /\/in\/([^/?#]+)/.exec(profileUrl);
  return m && m[1] ? m[1] : null;
}

// ────────────────────────────────────────────────────────────────────────────
// Parsing: messages
// ────────────────────────────────────────────────────────────────────────────

function parseMessageList(json: Json): ListResult<Message> {
  const data = asObj(pickPath(json, ["data"]));
  if (!data) return { items: [], nextCursor: null, prevCursor: null };
  const candidates = [
    "messengerMessagesByAnchorTimestamp",
    "messengerMessagesByConversation",
    "messengerMessagesByPrevCursor",
  ];
  let payload: Record<string, Json> | null = null;
  for (const k of candidates) {
    const v = asObj(data[k]);
    if (v) {
      payload = v;
      break;
    }
  }
  if (!payload) {
    for (const [, v] of Object.entries(data)) {
      const o = asObj(v);
      if (o && asArray(o.elements)) {
        payload = o;
        break;
      }
    }
  }
  if (!payload) return { items: [], nextCursor: null, prevCursor: null };

  const elements = asArray(payload.elements) ?? [];
  const metadata = asObj(payload.metadata);
  const nextCursor = metadata ? asString(metadata.nextCursor) : null;
  const prevCursor = metadata ? asString(metadata.prevCursor) : null;

  const items = elements
    .map((e) => parseMessage(e))
    .filter((m): m is Message => m !== null);

  return { items, nextCursor, prevCursor };
}

function parseMessage(node: Json): Message | null {
  const obj = asObj(node);
  if (!obj) return null;
  const urn = asString(obj.entityUrn);
  const deliveredAt = asNumber(obj.deliveredAt);
  if (!urn || deliveredAt === null) return null;
  const conversationUrn =
    asString(obj.conversationUrn) ?? asString(obj.backendConversationUrn) ?? "";
  const body = attrText(obj.body) ?? "";

  let senderUrn = "";
  let senderName: string | null = null;
  const sender = asObj(obj.sender);
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
      if (!senderName) {
        const org = asObj(pt.organization);
        if (org) {
          const n = attrText(org.name);
          if (n) senderName = n;
        }
      }
    }
  }

  return {
    urn,
    conversationUrn,
    senderUrn,
    senderName,
    body,
    deliveredAt,
    raw: node,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Parsing: legacy REST events (messaging/conversations/<id>/events)
// ────────────────────────────────────────────────────────────────────────────

function parseLegacyEventList(
  json: Json,
  conversationUrn: string,
): ListResult<Message> {
  const obj = asObj(json);
  if (!obj) return { items: [], nextCursor: null, prevCursor: null };
  const elements = asArray(obj.elements) ?? [];
  const items = elements
    .map((e) => parseLegacyEvent(e, conversationUrn))
    .filter((m): m is Message => m !== null);
  // The REST endpoint paginates via `createdBefore` on the next call rather
  // than returning a cursor. Surface the oldest message's timestamp as the
  // prev cursor so callers can keep walking back in time.
  const oldest = items.length > 0
    ? items.reduce((a, b) => (a.deliveredAt < b.deliveredAt ? a : b))
    : null;
  return {
    items,
    nextCursor: null,
    prevCursor: oldest ? String(oldest.deliveredAt) : null,
  };
}

function parseLegacyEvent(node: Json, conversationUrn: string): Message | null {
  const obj = asObj(node);
  if (!obj) return null;
  const dashEntityUrn = asString(obj.dashEntityUrn);
  const entityUrn = asString(obj.entityUrn);
  const urn = dashEntityUrn ?? entityUrn;
  const deliveredAt = asNumber(obj.createdAt);
  if (!urn || deliveredAt === null) return null;

  // Body: eventContent["com.linkedin.voyager.messaging.event.MessageEvent"].{attributedBody.text || body}
  let body = "";
  const eventContent = asObj(obj.eventContent);
  if (eventContent) {
    const msgEvent = asObj(
      eventContent["com.linkedin.voyager.messaging.event.MessageEvent"],
    );
    if (msgEvent) {
      const attributed = asObj(msgEvent.attributedBody);
      const attributedText = attributed ? asString(attributed.text) : null;
      body = attributedText ?? asString(msgEvent.body) ?? "";
    }
  }

  let senderUrn = "";
  let senderName: string | null = null;
  const from = asObj(obj.from);
  if (from) {
    const member = asObj(
      from["com.linkedin.voyager.messaging.MessagingMember"],
    );
    if (member) {
      const mini = asObj(member.miniProfile);
      if (mini) {
        const dashUrn = asString(mini.dashEntityUrn);
        if (dashUrn) senderUrn = dashUrn;
        else {
          const miniUrn = asString(mini.entityUrn);
          if (miniUrn) senderUrn = withPrefix(miniUrn, "urn:li:fsd_profile");
        }
        const fn = asString(mini.firstName);
        const ln = asString(mini.lastName);
        const parts: string[] = [];
        if (fn) parts.push(fn);
        if (ln) parts.push(ln);
        if (parts.length > 0) senderName = parts.join(" ");
      }
    }
  }

  return {
    urn,
    conversationUrn,
    senderUrn,
    senderName,
    body,
    deliveredAt,
    raw: node,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Misc helpers
// ────────────────────────────────────────────────────────────────────────────

function safeJson(text: string): Json {
  if (text === "" || text === null) return null;
  try {
    return JSON.parse(text) as Json;
  } catch {
    return text;
  }
}

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

// LinkedIn's trackingId is 16 raw bytes interpreted as a string — confirmed
// from real browser traffic, where JSON.stringify then encodes bytes >= 0x80
// as \uXXXX escapes. Using `latin1` gives us a 1-byte-per-char string suitable
// for that round-trip. Mirrors mautrix-Go's `string(random16)`.
function randomTrackingId(): string {
  return randomBytes(16).toString("latin1");
}

// Re-export a few convenience symbols so consumers can stay on one import.
export { profileUrn };
