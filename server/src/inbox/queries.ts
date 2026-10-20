import {
  and, asc, desc, eq, gte, ilike, inArray, isNull, like, lte, ne, notInArray, or, sql, type AnyColumn, type SQL,
} from 'drizzle-orm';
import { z } from 'zod';
import { FOLD_FROM, FOLD_TO, SEARCH_LIMIT, foldText } from '@talk/shared';
import type { ChatDetail, ChatListFilters, ChatListItem, MessageSearchHit, TimelineItem } from '@talk/shared';
import type { AppCtx } from '../ctx.js';
import type { Db, Tx } from '../db/client.js';
import { chatEvents, chatPins, chats, contacts, contactTags, messages, tags, users } from '../db/schema.js';
import { avatarUrl, refreshAvatarInBackground } from '../contacts/avatar.js';
import { badRequest } from '../lib/http-error.js';
import { toMessageDto } from '../messages/dto.js';
import { normalizePhoneBR } from '../whatsapp/phone.js';
import { getChatForUser, type ChatRow } from './chats.js';
import { visibleChatsWhere, type AuthUser } from './visibility.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const clampLimit = (n: number | undefined) => Math.min(Math.max(n ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

// A chat with no message yet (started by an agent) sorts by its creation time.
const sortKey = sql`coalesce(${chats.lastMessageAt}, ${chats.createdAt})`;

// The cursor carries the timestamptz as Postgres text, so microseconds survive the round trip.
const cursorSchema = z.tuple([
  z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}(:\d{2})?$/),
  z.uuid(),
]);
const encodeCursor = (key: string, id: string) => Buffer.from(JSON.stringify([key, id])).toString('base64url');
function decodeCursor(cursor: string): [string, string] {
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
  } catch {
    throw badRequest('Cursor inválido');
  }
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export async function toChatListItem(db: Db | Tx, chat: ChatRow, userId: string): Promise<ChatListItem> {
  const [contact] = await db
    .select({
      id: contacts.id,
      name: contacts.name,
      phone: contacts.phone,
      avatarPath: contacts.avatarPath,
      avatarCheckedAt: contacts.avatarCheckedAt,
    })
    .from(contacts)
    .where(eq(contacts.id, chat.contactId));
  const pin = await db
    .select({ chatId: chatPins.chatId })
    .from(chatPins)
    .where(and(eq(chatPins.chatId, chat.id), eq(chatPins.userId, userId)))
    .limit(1);
  const tagRows = await db
    .select({ id: contactTags.tagId })
    .from(contactTags)
    .innerJoin(tags, eq(tags.id, contactTags.tagId))
    .where(eq(contactTags.contactId, chat.contactId))
    .orderBy(asc(tags.position));
  // the message the preview shows (notes never set it): who sent it and, if the office did, its ticks
  // ponytail: one more small query per list item, like the three above; join them if the list gets slow
  const [last] = await db
    .select({ direction: messages.direction, status: messages.status })
    .from(messages)
    .where(and(eq(messages.chatId, chat.id), ne(messages.kind, 'note')))
    .orderBy(desc(messages.sentAt))
    .limit(1);
  return {
    id: chat.id,
    contact: contact
      ? { id: contact.id, name: contact.name, phone: contact.phone, avatarUrl: avatarUrl(contact) }
      : { id: chat.contactId, name: null, phone: null, avatarUrl: null },
    channelId: chat.channelId,
    sectorId: chat.sectorId,
    ownerId: chat.ownerId,
    state: chat.state,
    waiting: chat.waiting,
    private: chat.private,
    unread: chat.unread,
    lastMessageAt: chat.lastMessageAt ? chat.lastMessageAt.toISOString() : null,
    lastMessagePreview: chat.lastMessagePreview,
    pinned: pin.length > 0,
    tagIds: tagRows.map((r) => r.id),
    history: chat.history,
    lastOutStatus: last?.direction === 'out' ? last.status : null,
  };
}

// No visibility check: callers have already authorized (or just acted on) this chat.
export async function toChatDetail(db: Db | Tx, chat: ChatRow, userId: string): Promise<ChatDetail> {
  return {
    ...(await toChatListItem(db, chat, userId)),
    triagePending: chat.triagePending,
    createdAt: chat.createdAt.toISOString(),
    closedAt: chat.closedAt ? chat.closedAt.toISOString() : null,
  };
}

export async function listChats(
  ctx: AppCtx,
  user: AuthUser,
  f: ChatListFilters,
): Promise<{ items: ChatListItem[]; nextCursor: string | null }> {
  const db = ctx.db;
  const limit = clampLimit(f.limit);
  const conds: Array<SQL | undefined> = [visibleChatsWhere(user)];

  // Imported history chats are closed, so Finalizados lists them with the rest, in the place of their last message.
  conds.push(eq(chats.state, f.tab === 'closed' ? 'closed' : 'open'));
  if (f.tab === 'waiting') conds.push(eq(chats.waiting, true));
  if (f.sectorId) conds.push(eq(chats.sectorId, f.sectorId));
  if (f.ownerId === 'none') conds.push(isNull(chats.ownerId));
  else if (f.ownerId) conds.push(eq(chats.ownerId, f.ownerId));
  if (f.tagId) {
    conds.push(
      inArray(
        chats.contactId,
        db.select({ id: contactTags.contactId }).from(contactTags).where(eq(contactTags.tagId, f.tagId)),
      ),
    );
  }
  if (f.from) conds.push(gte(chats.createdAt, new Date(f.from)));
  if (f.to) conds.push(lte(chats.createdAt, new Date(f.to)));
  const q = f.q?.trim();
  if (q) {
    const digits = q.replace(/\D/g, '');
    conds.push(
      or(
        ilike(contacts.name, `%${escapeLike(q)}%`),
        digits.length >= 4 ? like(contacts.phone, `%${normalizePhoneBR(digits)}%`) : undefined,
      ),
    );
  }

  const myPins = () => db.select({ id: chatPins.chatId }).from(chatPins).where(eq(chatPins.userId, user.id));
  const base = () =>
    db
      .select({ chat: chats, key: sql<string>`${sortKey}::text` })
      .from(chats)
      .innerJoin(contacts, eq(contacts.id, chats.contactId));

  // Pins (max 3 per user) are prepended to the first page only, so the keyset cursor covers unpinned chats alone.
  const pinned = f.cursor
    ? []
    : await base()
        .where(and(...conds, inArray(chats.id, myPins())))
        .orderBy(desc(sortKey), desc(chats.id));

  const after = f.cursor ? decodeCursor(f.cursor) : null;
  const rows = await base()
    .where(
      and(
        ...conds,
        notInArray(chats.id, myPins()),
        after ? sql`(${sortKey}, ${chats.id}) < (${after[0]}::timestamptz, ${after[1]}::uuid)` : undefined,
      ),
    )
    .orderBy(desc(sortKey), desc(chats.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const nextCursor = rows.length > limit && last ? encodeCursor(last.key, last.chat.id) : null;

  // ponytail: 3 small queries per chat (contact, pin, tags); batch them if listing 100 chats gets slow.
  const items: ChatListItem[] = [];
  for (const r of [...pinned, ...page]) items.push(await toChatListItem(db, r.chat, user.id));
  return { items, nextCursor };
}

export async function getChatDetail(ctx: AppCtx, user: AuthUser, chatId: string): Promise<ChatDetail> {
  const chat = await getChatForUser(ctx, user, chatId);
  refreshAvatarInBackground(ctx, chat.channelId, chat.contactId); // opening the conversation
  return toChatDetail(ctx.db, chat, user.id);
}

type TimelineEntry = { t: number; c: number; id: string; build: () => Promise<TimelineItem> };
/** A position in the timeline: (time, createdAt) as Postgres text, so microseconds survive the round trip. */
type TimelineKey = { at: string; created: string; id: string };

const messageEntry = (db: Db | Tx, row: typeof messages.$inferSelect): TimelineEntry => ({
  t: row.sentAt.getTime(),
  c: row.createdAt.getTime(),
  id: row.id,
  build: async () => ({ type: 'message', ...(await toMessageDto(db, row)) }),
});

/** The key of a message or event of this chat; 400 when the id is not in it. */
async function timelineKey(db: Db | Tx, chatId: string, id: string): Promise<TimelineKey> {
  const [m] = await db
    .select({ t: sql<string>`${messages.sentAt}::text`, c: sql<string>`${messages.createdAt}::text` })
    .from(messages)
    .where(and(eq(messages.id, id), eq(messages.chatId, chatId)));
  const [e] = m
    ? []
    : await db
        .select({ t: sql<string>`${chatEvents.createdAt}::text` })
        .from(chatEvents)
        .where(and(eq(chatEvents.id, id), eq(chatEvents.chatId, chatId)));
  const at = m?.t ?? e?.t;
  if (!at) throw badRequest('Cursor inválido');
  return { at, created: m?.c ?? at, id };
}

/**
 * Up to `limit` items strictly older ('before') or newer ('after') than `key` — the newest ones without a key —
 * ascending. Timeline order is (time, createdAt, id): sentAt has 1 s resolution on inbound bursts, createdAt keeps
 * arrival order.
 */
async function timelinePage(
  db: Db | Tx,
  chatId: string,
  dir: 'before' | 'after',
  key: TimelineKey | null,
  limit: number,
): Promise<TimelineEntry[]> {
  if (limit === 0) return [];
  const older = dir === 'before';
  const order = older ? desc : asc;
  const k = key && sql`(${key.at}::timestamptz, ${key.created}::timestamptz, ${key.id}::uuid)`;
  const side = (cols: SQL) => (k ? (older ? sql`${cols} < ${k}` : sql`${cols} > ${k}`) : undefined);

  const msgRows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.chatId, chatId), side(sql`(${messages.sentAt}, ${messages.createdAt}, ${messages.id})`)))
    .orderBy(order(messages.sentAt), order(messages.createdAt), order(messages.id))
    .limit(limit);
  const evRows = await db
    .select({ ev: chatEvents, authorName: users.name })
    .from(chatEvents)
    .leftJoin(users, eq(users.id, chatEvents.authorId))
    .where(and(eq(chatEvents.chatId, chatId), side(sql`(${chatEvents.createdAt}, ${chatEvents.createdAt}, ${chatEvents.id})`)))
    .orderBy(order(chatEvents.createdAt), order(chatEvents.id))
    .limit(limit);

  const entries: TimelineEntry[] = [
    ...msgRows.map((row) => messageEntry(db, row)),
    ...evRows.map(({ ev, authorName }) => ({
      t: ev.createdAt.getTime(),
      c: ev.createdAt.getTime(),
      id: ev.id,
      build: async (): Promise<TimelineItem> => ({
        type: 'event',
        id: ev.id,
        chatId: ev.chatId,
        kind: ev.kind,
        data: (ev.data ?? {}) as Record<string, unknown>,
        authorName: authorName ?? null,
        createdAt: ev.createdAt.toISOString(),
      }),
    })),
  ];
  // Same (time, createdAt, id) order as the SQL, ascending; keep the `limit` nearest to the key.
  // ponytail: compares at ms, Postgres at µs; only rows inserted within the same ms can disagree. Fetch µs keys if that ever shows.
  entries.sort((a, b) => a.t - b.t || a.c - b.c || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return older ? entries.slice(-limit) : entries.slice(0, limit);
}

export async function getTimeline(
  ctx: AppCtx,
  user: AuthUser,
  chatId: string,
  q: { before?: string; after?: string; around?: string; limit?: number },
): Promise<TimelineItem[]> {
  await getChatForUser(ctx, user, chatId);
  const db = ctx.db;
  const limit = clampLimit(q.limit);
  let entries: TimelineEntry[];
  if (q.around) {
    // Spec 2026-10-19 §4 "ir até a mensagem": half a page on each side of one message of this chat; the web pages on
    // with before=<oldest id> and after=<newest id>.
    const [row] = await db.select().from(messages).where(and(eq(messages.id, q.around), eq(messages.chatId, chatId)));
    if (!row) throw badRequest('Cursor inválido');
    const key = await timelineKey(db, chatId, row.id);
    const half = Math.floor(limit / 2);
    entries = [
      ...(await timelinePage(db, chatId, 'before', key, half)),
      messageEntry(db, row),
      ...(await timelinePage(db, chatId, 'after', key, half)),
    ];
  } else if (q.after) {
    entries = await timelinePage(db, chatId, 'after', await timelineKey(db, chatId, q.after), limit);
  } else {
    entries = await timelinePage(db, chatId, 'before', q.before ? await timelineKey(db, chatId, q.before) : null, limit);
  }
  return Promise.all(entries.map((e) => e.build()));
}

const SNIPPET_BEFORE = 40;
const SNIPPET_AFTER = 80;

/** The SQL side of foldText: same table, so "AÇÃO" and "acao" meet. coalesce: a null column never matches. */
const folded = (col: AnyColumn) => sql`translate(lower(coalesce(${col}, '')), ${FOLD_FROM}, ${FOLD_TO})`;

/**
 * Spec 2026-10-19 §4: texts, captions, notes and file names of this chat that contain `q`, ignoring case and accents,
 * newest first, at most SEARCH_LIMIT. `%`, `_` and `\` in `q` are plain text.
 */
export async function searchChat(ctx: AppCtx, user: AuthUser, chatId: string, q: string): Promise<MessageSearchHit[]> {
  await getChatForUser(ctx, user, chatId);
  const needle = foldText(q.trim());
  const pattern = `%${escapeLike(needle)}%`;
  // ponytail: scans one chat's rows (messages_chat_sent_idx narrows to the chat); add a trigram index if a chat reaches 100k.
  const rows = await ctx.db
    .select({
      id: messages.id,
      kind: messages.kind,
      direction: messages.direction,
      body: messages.body,
      mediaName: messages.mediaName,
      sentAt: messages.sentAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.chatId, chatId),
        or(sql`${folded(messages.body)} like ${pattern}`, sql`${folded(messages.mediaName)} like ${pattern}`),
      ),
    )
    .orderBy(desc(messages.sentAt), desc(messages.createdAt), desc(messages.id))
    .limit(SEARCH_LIMIT);
  return rows.map((r) => ({
    messageId: r.id,
    kind: r.kind,
    direction: r.direction,
    sentAt: r.sentAt.toISOString(),
    snippet: snippetOf(r.body && foldText(r.body).includes(needle) ? r.body : (r.mediaName ?? ''), needle),
  }));
}

/** One line: up to SNIPPET_BEFORE characters before the match and SNIPPET_AFTER after it, "…" where it cuts. */
export function snippetOf(text: string, needle: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const at = Math.max(0, foldText(flat).indexOf(needle));
  const start = Math.max(0, at - SNIPPET_BEFORE);
  const end = Math.min(flat.length, at + needle.length + SNIPPET_AFTER);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}
