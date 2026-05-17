import type Database from "better-sqlite3";

import { conversationLocalId } from "../voyager/urn.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AuthRow {
  liAt: string;
  jsessionid: string;
  csrfToken: string;
  profileUrn: string;
  profileName: string | null;
  rawCookieHeader: string;
  xLiTrack: string | null;
  xLiPageInstance: string | null;
  createdAt: number;
  validatedAt: number;
}

export interface ThreadRow {
  id: string;
  title: string | null;
  participants: string[];
  lastMsgPreview: string | null;
  lastMsgTs: number | null;
  unreadCount: number;
  category: string | null;
  syncedAt: number;
}

export type DeliveryState = "local-pending" | "sent" | "confirmed" | "failed";

export interface MessageRow {
  id: string;
  threadId: string;
  senderUrn: string;
  senderName: string | null;
  body: string;
  ts: number;
  deliveryState: DeliveryState;
  originToken: string | null;
  rawJson: string | null;
}

export interface ParticipantRow {
  urn: string;
  name: string;
  headline: string | null;
  publicIdentifier: string | null;
  pictureUrl: string | null;
  updatedAt: number;
}

// ─── Prepared statement cache (per-DB) ───────────────────────────────────────

interface Stmts {
  // auth
  authSave: Database.Statement;
  authGet: Database.Statement;
  authClear: Database.Statement;
  authTouch: Database.Statement;
  // threads
  threadUpsert: Database.Statement;
  threadGet: Database.Statement;
  threadList: Database.Statement;
  threadListLimit: Database.Statement;
  threadListUnread: Database.Statement;
  threadListUnreadLimit: Database.Statement;
  threadMarkRead: Database.Statement;
  threadFindByPrefix: Database.Statement;
  // messages
  msgUpsert: Database.Statement;
  msgInsertPending: Database.Statement;
  msgListByThread: Database.Statement;
  msgListByThreadLimit: Database.Statement;
  msgListByThreadBefore: Database.Statement;
  msgListByThreadBeforeLimit: Database.Statement;
  msgFindPendingByToken: Database.Statement;
  msgDeleteById: Database.Statement;
  msgSearch: Database.Statement;
  msgSearchLimit: Database.Statement;
  msgSearchThread: Database.Statement;
  msgSearchThreadLimit: Database.Statement;
  // participants
  partUpsert: Database.Statement;
  partGet: Database.Statement;
  partList: Database.Statement;
  partListLimit: Database.Statement;
  partListSearch: Database.Statement;
  partListSearchLimit: Database.Statement;
  // watermark
  wmGet: Database.Statement;
  wmSet: Database.Statement;
}

const cache: WeakMap<Database.Database, Stmts> = new WeakMap();

function stmts(db: Database.Database): Stmts {
  const cached = cache.get(db);
  if (cached) return cached;

  const prepared: Stmts = {
    authSave: db.prepare(
      `INSERT INTO auth
        (id, li_at, jsessionid, csrf_token, profile_urn, profile_name,
         raw_cookie_header, x_li_track, x_li_page_instance, created_at, validated_at)
       VALUES (1, @liAt, @jsessionid, @csrfToken, @profileUrn, @profileName,
               @rawCookieHeader, @xLiTrack, @xLiPageInstance, @createdAt, @validatedAt)
       ON CONFLICT(id) DO UPDATE SET
         li_at = excluded.li_at,
         jsessionid = excluded.jsessionid,
         csrf_token = excluded.csrf_token,
         profile_urn = excluded.profile_urn,
         profile_name = excluded.profile_name,
         raw_cookie_header = excluded.raw_cookie_header,
         x_li_track = excluded.x_li_track,
         x_li_page_instance = excluded.x_li_page_instance,
         created_at = excluded.created_at,
         validated_at = excluded.validated_at`
    ),
    authGet: db.prepare(
      `SELECT li_at AS liAt, jsessionid, csrf_token AS csrfToken,
              profile_urn AS profileUrn, profile_name AS profileName,
              raw_cookie_header AS rawCookieHeader,
              x_li_track AS xLiTrack, x_li_page_instance AS xLiPageInstance,
              created_at AS createdAt, validated_at AS validatedAt
       FROM auth WHERE id = 1`
    ),
    authClear: db.prepare(`DELETE FROM auth`),
    authTouch: db.prepare(`UPDATE auth SET validated_at = ? WHERE id = 1`),

    threadUpsert: db.prepare(
      `INSERT INTO threads
        (id, title, participants_json, last_msg_preview, last_msg_ts,
         unread_count, category, synced_at)
       VALUES (@id, @title, @participants_json, @lastMsgPreview, @lastMsgTs,
               @unreadCount, @category, @syncedAt)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         participants_json = excluded.participants_json,
         last_msg_preview = excluded.last_msg_preview,
         last_msg_ts = excluded.last_msg_ts,
         unread_count = excluded.unread_count,
         category = excluded.category,
         synced_at = excluded.synced_at`
    ),
    threadGet: db.prepare(
      `SELECT id, title, participants_json, last_msg_preview AS lastMsgPreview,
              last_msg_ts AS lastMsgTs, unread_count AS unreadCount,
              category, synced_at AS syncedAt
       FROM threads WHERE id = ?`
    ),
    threadList: db.prepare(
      `SELECT id, title, participants_json, last_msg_preview AS lastMsgPreview,
              last_msg_ts AS lastMsgTs, unread_count AS unreadCount,
              category, synced_at AS syncedAt
       FROM threads
       ORDER BY (last_msg_ts IS NULL), last_msg_ts DESC`
    ),
    threadListLimit: db.prepare(
      `SELECT id, title, participants_json, last_msg_preview AS lastMsgPreview,
              last_msg_ts AS lastMsgTs, unread_count AS unreadCount,
              category, synced_at AS syncedAt
       FROM threads
       ORDER BY (last_msg_ts IS NULL), last_msg_ts DESC
       LIMIT ?`
    ),
    threadListUnread: db.prepare(
      `SELECT id, title, participants_json, last_msg_preview AS lastMsgPreview,
              last_msg_ts AS lastMsgTs, unread_count AS unreadCount,
              category, synced_at AS syncedAt
       FROM threads
       WHERE unread_count > 0
       ORDER BY (last_msg_ts IS NULL), last_msg_ts DESC`
    ),
    threadListUnreadLimit: db.prepare(
      `SELECT id, title, participants_json, last_msg_preview AS lastMsgPreview,
              last_msg_ts AS lastMsgTs, unread_count AS unreadCount,
              category, synced_at AS syncedAt
       FROM threads
       WHERE unread_count > 0
       ORDER BY (last_msg_ts IS NULL), last_msg_ts DESC
       LIMIT ?`
    ),
    threadMarkRead: db.prepare(`UPDATE threads SET unread_count = 0 WHERE id = ?`),
    threadFindByPrefix: db.prepare(
      `SELECT id, title, participants_json, last_msg_preview AS lastMsgPreview,
              last_msg_ts AS lastMsgTs, unread_count AS unreadCount,
              category, synced_at AS syncedAt
       FROM threads
       WHERE id LIKE ? ESCAPE '\\'
       LIMIT 2`
    ),

    msgUpsert: db.prepare(
      `INSERT INTO messages
        (id, thread_id, sender_urn, sender_name, body, ts,
         delivery_state, origin_token, raw_json)
       VALUES (@id, @threadId, @senderUrn, @senderName, @body, @ts,
               @deliveryState, @originToken, @rawJson)
       ON CONFLICT(id) DO UPDATE SET
         thread_id = excluded.thread_id,
         sender_urn = excluded.sender_urn,
         sender_name = excluded.sender_name,
         body = excluded.body,
         ts = excluded.ts,
         delivery_state = excluded.delivery_state,
         origin_token = excluded.origin_token,
         raw_json = excluded.raw_json`
    ),
    msgInsertPending: db.prepare(
      `INSERT INTO messages
        (id, thread_id, sender_urn, sender_name, body, ts,
         delivery_state, origin_token, raw_json)
       VALUES (@id, @threadId, @senderUrn, @senderName, @body, @ts,
               @deliveryState, @originToken, @rawJson)`
    ),
    msgListByThread: db.prepare(
      `SELECT id, thread_id AS threadId, sender_urn AS senderUrn,
              sender_name AS senderName, body, ts,
              delivery_state AS deliveryState,
              origin_token AS originToken, raw_json AS rawJson
       FROM messages
       WHERE thread_id = ?
       ORDER BY ts ASC, id ASC`
    ),
    msgListByThreadLimit: db.prepare(
      // Take the most recent N rows (DESC + LIMIT), then re-order ASC for the
      // caller so callers always see oldest-to-newest. Matches the wrap-around
      // pattern used by msgListByThreadBeforeLimit.
      `SELECT * FROM (
         SELECT id, thread_id AS threadId, sender_urn AS senderUrn,
                sender_name AS senderName, body, ts,
                delivery_state AS deliveryState,
                origin_token AS originToken, raw_json AS rawJson
         FROM messages
         WHERE thread_id = ?
         ORDER BY ts DESC, id DESC
         LIMIT ?
       ) ORDER BY ts ASC, id ASC`
    ),
    msgListByThreadBefore: db.prepare(
      `SELECT id, thread_id AS threadId, sender_urn AS senderUrn,
              sender_name AS senderName, body, ts,
              delivery_state AS deliveryState,
              origin_token AS originToken, raw_json AS rawJson
       FROM messages
       WHERE thread_id = ? AND ts < ?
       ORDER BY ts ASC, id ASC`
    ),
    msgListByThreadBeforeLimit: db.prepare(
      `SELECT * FROM (
         SELECT id, thread_id AS threadId, sender_urn AS senderUrn,
                sender_name AS senderName, body, ts,
                delivery_state AS deliveryState,
                origin_token AS originToken, raw_json AS rawJson
         FROM messages
         WHERE thread_id = ? AND ts < ?
         ORDER BY ts DESC, id DESC
         LIMIT ?
       ) ORDER BY ts ASC, id ASC`
    ),
    msgFindPendingByToken: db.prepare(
      `SELECT id, thread_id AS threadId, sender_urn AS senderUrn,
              sender_name AS senderName, body, ts,
              delivery_state AS deliveryState,
              origin_token AS originToken, raw_json AS rawJson
       FROM messages
       WHERE origin_token = ? AND delivery_state = 'local-pending'
       LIMIT 1`
    ),
    msgDeleteById: db.prepare(`DELETE FROM messages WHERE id = ?`),

    msgSearch: db.prepare(
      `SELECT m.id, m.thread_id AS threadId, m.sender_urn AS senderUrn,
              m.sender_name AS senderName, m.body, m.ts,
              m.delivery_state AS deliveryState,
              m.origin_token AS originToken, m.raw_json AS rawJson,
              snippet(messages_fts, 0, '<b>', '</b>', '...', 16) AS snippet
       FROM messages_fts
       JOIN messages m ON m.rowid = messages_fts.rowid
       WHERE messages_fts MATCH ?
       ORDER BY rank`
    ),
    msgSearchLimit: db.prepare(
      `SELECT m.id, m.thread_id AS threadId, m.sender_urn AS senderUrn,
              m.sender_name AS senderName, m.body, m.ts,
              m.delivery_state AS deliveryState,
              m.origin_token AS originToken, m.raw_json AS rawJson,
              snippet(messages_fts, 0, '<b>', '</b>', '...', 16) AS snippet
       FROM messages_fts
       JOIN messages m ON m.rowid = messages_fts.rowid
       WHERE messages_fts MATCH ?
       ORDER BY rank
       LIMIT ?`
    ),
    msgSearchThread: db.prepare(
      `SELECT m.id, m.thread_id AS threadId, m.sender_urn AS senderUrn,
              m.sender_name AS senderName, m.body, m.ts,
              m.delivery_state AS deliveryState,
              m.origin_token AS originToken, m.raw_json AS rawJson,
              snippet(messages_fts, 0, '<b>', '</b>', '...', 16) AS snippet
       FROM messages_fts
       JOIN messages m ON m.rowid = messages_fts.rowid
       WHERE messages_fts MATCH ? AND m.thread_id = ?
       ORDER BY rank`
    ),
    msgSearchThreadLimit: db.prepare(
      `SELECT m.id, m.thread_id AS threadId, m.sender_urn AS senderUrn,
              m.sender_name AS senderName, m.body, m.ts,
              m.delivery_state AS deliveryState,
              m.origin_token AS originToken, m.raw_json AS rawJson,
              snippet(messages_fts, 0, '<b>', '</b>', '...', 16) AS snippet
       FROM messages_fts
       JOIN messages m ON m.rowid = messages_fts.rowid
       WHERE messages_fts MATCH ? AND m.thread_id = ?
       ORDER BY rank
       LIMIT ?`
    ),

    partUpsert: db.prepare(
      `INSERT INTO participants
        (urn, name, headline, public_identifier, picture_url, updated_at)
       VALUES (@urn, @name, @headline, @publicIdentifier, @pictureUrl, @updatedAt)
       ON CONFLICT(urn) DO UPDATE SET
         name = excluded.name,
         headline = excluded.headline,
         public_identifier = excluded.public_identifier,
         picture_url = excluded.picture_url,
         updated_at = excluded.updated_at`
    ),
    partGet: db.prepare(
      `SELECT urn, name, headline,
              public_identifier AS publicIdentifier,
              picture_url AS pictureUrl,
              updated_at AS updatedAt
       FROM participants WHERE urn = ?`
    ),
    partList: db.prepare(
      `SELECT urn, name, headline,
              public_identifier AS publicIdentifier,
              picture_url AS pictureUrl,
              updated_at AS updatedAt
       FROM participants
       ORDER BY name ASC`
    ),
    partListLimit: db.prepare(
      `SELECT urn, name, headline,
              public_identifier AS publicIdentifier,
              picture_url AS pictureUrl,
              updated_at AS updatedAt
       FROM participants
       ORDER BY name ASC
       LIMIT ?`
    ),
    partListSearch: db.prepare(
      `SELECT urn, name, headline,
              public_identifier AS publicIdentifier,
              picture_url AS pictureUrl,
              updated_at AS updatedAt
       FROM participants
       WHERE name LIKE ? ESCAPE '\\'
       ORDER BY name ASC`
    ),
    partListSearchLimit: db.prepare(
      `SELECT urn, name, headline,
              public_identifier AS publicIdentifier,
              picture_url AS pictureUrl,
              updated_at AS updatedAt
       FROM participants
       WHERE name LIKE ? ESCAPE '\\'
       ORDER BY name ASC
       LIMIT ?`
    ),

    wmGet: db.prepare(`SELECT value FROM watermark WHERE key = ?`),
    wmSet: db.prepare(
      `INSERT INTO watermark (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ),
  };

  cache.set(db, prepared);
  return prepared;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface ThreadRowDb {
  id: string;
  title: string | null;
  participants_json: string;
  lastMsgPreview: string | null;
  lastMsgTs: number | null;
  unreadCount: number;
  category: string | null;
  syncedAt: number;
}

function decodeThread(row: ThreadRowDb): ThreadRow {
  const parsed: unknown = JSON.parse(row.participants_json);
  const participants: string[] =
    Array.isArray(parsed) && parsed.every((v) => typeof v === "string") ? (parsed as string[]) : [];
  return {
    id: row.id,
    title: row.title,
    participants,
    lastMsgPreview: row.lastMsgPreview,
    lastMsgTs: row.lastMsgTs,
    unreadCount: row.unreadCount,
    category: row.category,
    syncedAt: row.syncedAt,
  };
}

function escapeLike(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

// ─── auth ────────────────────────────────────────────────────────────────────

export const auth = {
  save(
    db: Database.Database,
    row: Omit<AuthRow, "createdAt" | "validatedAt"> & {
      createdAt?: number;
      validatedAt?: number;
    }
  ): void {
    const now = Date.now();
    stmts(db).authSave.run({
      liAt: row.liAt,
      jsessionid: row.jsessionid,
      csrfToken: row.csrfToken,
      profileUrn: row.profileUrn,
      profileName: row.profileName,
      rawCookieHeader: row.rawCookieHeader,
      xLiTrack: row.xLiTrack,
      xLiPageInstance: row.xLiPageInstance,
      createdAt: row.createdAt ?? now,
      validatedAt: row.validatedAt ?? now,
    });
  },

  get(db: Database.Database): AuthRow | null {
    const row = stmts(db).authGet.get() as AuthRow | undefined;
    return row ?? null;
  },

  clear(db: Database.Database): void {
    stmts(db).authClear.run();
  },

  touchValidated(db: Database.Database, ts: number): void {
    stmts(db).authTouch.run(ts);
  },
};

// ─── threads ─────────────────────────────────────────────────────────────────

export const threads = {
  upsert(db: Database.Database, row: ThreadRow): void {
    stmts(db).threadUpsert.run({
      id: row.id,
      title: row.title,
      participants_json: JSON.stringify(row.participants),
      lastMsgPreview: row.lastMsgPreview,
      lastMsgTs: row.lastMsgTs,
      unreadCount: row.unreadCount,
      category: row.category,
      syncedAt: row.syncedAt,
    });
  },

  list(
    db: Database.Database,
    opts: { limit?: number; unreadOnly?: boolean } = {}
  ): ThreadRow[] {
    const s = stmts(db);
    let rows: ThreadRowDb[];
    if (opts.unreadOnly && opts.limit !== undefined) {
      rows = s.threadListUnreadLimit.all(opts.limit) as ThreadRowDb[];
    } else if (opts.unreadOnly) {
      rows = s.threadListUnread.all() as ThreadRowDb[];
    } else if (opts.limit !== undefined) {
      rows = s.threadListLimit.all(opts.limit) as ThreadRowDb[];
    } else {
      rows = s.threadList.all() as ThreadRowDb[];
    }
    return rows.map(decodeThread);
  },

  get(db: Database.Database, id: string): ThreadRow | null {
    const row = stmts(db).threadGet.get(id) as ThreadRowDb | undefined;
    return row ? decodeThread(row) : null;
  },

  findByIdOrPrefix(db: Database.Database, idOrPrefix: string): ThreadRow | null {
    // Try exact match first.
    const exact = stmts(db).threadGet.get(idOrPrefix) as ThreadRowDb | undefined;
    if (exact) return decodeThread(exact);

    if (idOrPrefix.length < 4) return null;

    // Match against the conversation-local id (the bit after the last comma of
    // a compound URN). Scan candidate rows whose id text contains the prefix,
    // then narrow in JS.
    const like = `%${escapeLike(idOrPrefix)}%`;
    const candidates = (stmts(db).threadFindByPrefix.all(like) as ThreadRowDb[]).filter((r) => {
      const local = conversationLocalId(r.id);
      // Accept either start-of-id or the "variable" tail after a "2-" mailbox prefix.
      const stripped = local.replace(/^\d+-/, "");
      return local.startsWith(idOrPrefix) || stripped.startsWith(idOrPrefix);
    });

    if (candidates.length !== 1) return null;
    return decodeThread(candidates[0]!);
  },

  markRead(db: Database.Database, id: string): void {
    stmts(db).threadMarkRead.run(id);
  },
};

// ─── messages ────────────────────────────────────────────────────────────────

export const messages = {
  upsert(db: Database.Database, row: MessageRow): void {
    stmts(db).msgUpsert.run({
      id: row.id,
      threadId: row.threadId,
      senderUrn: row.senderUrn,
      senderName: row.senderName,
      body: row.body,
      ts: row.ts,
      deliveryState: row.deliveryState,
      originToken: row.originToken,
      rawJson: row.rawJson,
    });
  },

  insertPending(db: Database.Database, row: MessageRow): void {
    stmts(db).msgInsertPending.run({
      id: row.id,
      threadId: row.threadId,
      senderUrn: row.senderUrn,
      senderName: row.senderName,
      body: row.body,
      ts: row.ts,
      deliveryState: row.deliveryState,
      originToken: row.originToken,
      rawJson: row.rawJson,
    });
  },

  listByThread(
    db: Database.Database,
    threadId: string,
    opts: { limit?: number; before?: number } = {}
  ): MessageRow[] {
    const s = stmts(db);
    if (opts.before !== undefined && opts.limit !== undefined) {
      return s.msgListByThreadBeforeLimit.all(threadId, opts.before, opts.limit) as MessageRow[];
    }
    if (opts.before !== undefined) {
      return s.msgListByThreadBefore.all(threadId, opts.before) as MessageRow[];
    }
    if (opts.limit !== undefined) {
      return s.msgListByThreadLimit.all(threadId, opts.limit) as MessageRow[];
    }
    return s.msgListByThread.all(threadId) as MessageRow[];
  },

  markDelivered(
    db: Database.Database,
    originToken: string,
    newId: string,
    ts: number
  ): void {
    const s = stmts(db);
    const tx = db.transaction((token: string, nid: string, newTs: number) => {
      const pending = s.msgFindPendingByToken.get(token) as MessageRow | undefined;
      if (!pending) return;
      s.msgDeleteById.run(pending.id);
      s.msgInsertPending.run({
        id: nid,
        threadId: pending.threadId,
        senderUrn: pending.senderUrn,
        senderName: pending.senderName,
        body: pending.body,
        ts: newTs,
        deliveryState: "confirmed" as DeliveryState,
        originToken: pending.originToken,
        rawJson: pending.rawJson,
      });
    });
    tx(originToken, newId, ts);
  },

  search(
    db: Database.Database,
    query: string,
    opts: { limit?: number; threadId?: string } = {}
  ): Array<MessageRow & { snippet: string }> {
    const s = stmts(db);
    if (opts.threadId !== undefined && opts.limit !== undefined) {
      return s.msgSearchThreadLimit.all(query, opts.threadId, opts.limit) as Array<
        MessageRow & { snippet: string }
      >;
    }
    if (opts.threadId !== undefined) {
      return s.msgSearchThread.all(query, opts.threadId) as Array<MessageRow & { snippet: string }>;
    }
    if (opts.limit !== undefined) {
      return s.msgSearchLimit.all(query, opts.limit) as Array<MessageRow & { snippet: string }>;
    }
    return s.msgSearch.all(query) as Array<MessageRow & { snippet: string }>;
  },
};

// ─── participants ────────────────────────────────────────────────────────────

export const participants = {
  upsert(db: Database.Database, row: ParticipantRow): void {
    stmts(db).partUpsert.run({
      urn: row.urn,
      name: row.name,
      headline: row.headline,
      publicIdentifier: row.publicIdentifier,
      pictureUrl: row.pictureUrl,
      updatedAt: row.updatedAt,
    });
  },

  get(db: Database.Database, urn: string): ParticipantRow | null {
    const row = stmts(db).partGet.get(urn) as ParticipantRow | undefined;
    return row ?? null;
  },

  list(
    db: Database.Database,
    opts: { search?: string; limit?: number } = {}
  ): ParticipantRow[] {
    const s = stmts(db);
    if (opts.search !== undefined && opts.limit !== undefined) {
      return s.partListSearchLimit.all(`%${escapeLike(opts.search)}%`, opts.limit) as ParticipantRow[];
    }
    if (opts.search !== undefined) {
      return s.partListSearch.all(`%${escapeLike(opts.search)}%`) as ParticipantRow[];
    }
    if (opts.limit !== undefined) {
      return s.partListLimit.all(opts.limit) as ParticipantRow[];
    }
    return s.partList.all() as ParticipantRow[];
  },
};

// ─── watermark ───────────────────────────────────────────────────────────────

export const watermark = {
  get(db: Database.Database, key: string): string | null {
    const row = stmts(db).wmGet.get(key) as { value: string } | undefined;
    return row ? row.value : null;
  },

  set(db: Database.Database, key: string, value: string): void {
    stmts(db).wmSet.run(key, value);
  },
};
