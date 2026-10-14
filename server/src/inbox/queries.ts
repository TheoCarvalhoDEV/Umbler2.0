import { and, asc, desc, eq, gte, ilike, inArray, isNull, like, lte, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { ChatDetail, ChatListFilters, ChatListItem, TimelineItem } from '@talk/shared';
import type { AppCtx } from '../ctx.js';
import type { Db, Tx } from '../db/client.js';
import { chatEvents, chatPins, chats, contacts, contactTags, messages, tags, users } from '../db/schema.js';
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
    .select({ id: contacts.id, name: contacts.name, phone: contacts.phone })
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
  return {
    id: chat.id,
    contact: contact ?? { id: chat.contactId, name: null, phone: null },
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
  return toChatDetail(ctx.db, chat, user.id);
}

export async function getTimeline(
  ctx: AppCtx,
  user: AuthUser,
  chatId: string,
  q: { before?: string; limit?: number },
): Promise<TimelineItem[]> {
  await getChatForUser(ctx, user, chatId);
  const db = ctx.db;
  const limit = clampLimit(q.limit);

  let msgBefore: SQL | undefined;
  let evBefore: SQL | undefined;
  if (q.before) {
    const [m] = await db
      .select({ t: sql<string>`${messages.sentAt}::text` })
      .from(messages)
      .where(and(eq(messages.id, q.before), eq(messages.chatId, chatId)));
    const [e] = m
      ? []
      : await db
          .select({ t: sql<string>`${chatEvents.createdAt}::text` })
          .from(chatEvents)
          .where(and(eq(chatEvents.id, q.before), eq(chatEvents.chatId, chatId)));
    const at = m?.t ?? e?.t;
    if (!at) throw badRequest('Cursor inválido');
    msgBefore = sql`(${messages.sentAt}, ${messages.id}) < (${at}::timestamptz, ${q.before}::uuid)`;
    evBefore = sql`(${chatEvents.createdAt}, ${chatEvents.id}) < (${at}::timestamptz, ${q.before}::uuid)`;
  }

  const msgRows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.chatId, chatId), msgBefore))
    .orderBy(desc(messages.sentAt), desc(messages.id))
    .limit(limit);
  const evRows = await db
    .select({ ev: chatEvents, authorName: users.name })
    .from(chatEvents)
    .leftJoin(users, eq(users.id, chatEvents.authorId))
    .where(and(eq(chatEvents.chatId, chatId), evBefore))
    .orderBy(desc(chatEvents.createdAt), desc(chatEvents.id))
    .limit(limit);

  type Entry = { t: number; id: string; build: () => Promise<TimelineItem> };
  const entries: Entry[] = [
    ...msgRows.map((row) => ({
      t: row.sentAt.getTime(),
      id: row.id,
      build: async (): Promise<TimelineItem> => ({ type: 'message', ...(await toMessageDto(db, row)) }),
    })),
    ...evRows.map(({ ev, authorName }) => ({
      t: ev.createdAt.getTime(),
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
  // Same (time, id) order as the SQL cursor: newest first, keep the page, then flip to ascending.
  entries.sort((a, b) => b.t - a.t || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const pageEntries = entries.slice(0, limit).reverse();
  return Promise.all(pageEntries.map((e) => e.build()));
}
