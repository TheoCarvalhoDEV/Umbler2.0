import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { AppCtx } from '../ctx.js';
import type { Tx } from '../db/client.js';
import { chats, messages } from '../db/schema.js';
import { getDefaultSectorId } from '../inbox/chats.js';
import { addEvent } from '../inbox/events.js';
import { messagePreview } from '../messages/dto.js';
import { replyToIdOf, resolveContact, type Contact, type MessageEvent } from '../messages/ingest.js';
import { mergeLidPairs } from './merge.js';
import { parseEvolutionWebhook } from '../whatsapp/parse.js';

/** §5.5: WhatsApp keeps media downloadable for about 3 weeks (measured: ok at 22 days, gone at 23). */
export const MEDIA_MAX_AGE_MS = 21 * 24 * 60 * 60_000;

/**
 * messageType values that are never a message of their own (§5.2): revokes/edits, album children, edits in the new
 * format and reactions. The parser already drops groups, status@broadcast, newsletters (no address) and the rest.
 * Since message actions the parser turns secretEncryptedMessage into an 'edit' event and reactions (fromMe too) into
 * 'reaction' events; toHistoryEvents keeps only 'message' events, so history never edits, deletes or reacts (spec §2).
 */
const SKIP_TYPES = new Set(['protocolMessage', 'associatedChildMessage', 'secretEncryptedMessage', 'reactionMessage', 'editedMessage']);

/** Names from Evolution's Contact table, keyed 'p:<phone>' (normalized) or 'l:<lid>'. */
export type ContactNames = Map<string, string>;

export interface ChannelRef {
  id: string;
  evolutionInstance: string;
}

export interface PlaceResult {
  inserted: number;
  contactsCreated: number;
  oldest: Date | null;
  /** history chat id → messages added to it (the caller writes one history_imported event per chat). */
  historyCounts: Map<string, number>;
}

type Target = { id: string; history: boolean };

/** A push name made only of digits is Evolution's fallback (the JID's user part), not a name (§5.4). */
export function realName(name: string | null | undefined): string | null {
  const n = name?.trim();
  return n && !/^[\d\s+()-]+$/.test(n) ? n : null;
}

const stampOf = (r: unknown) => Number((r as { messageTimestamp?: unknown } | null)?.messageTimestamp);
const typeOf = (r: unknown) => String((r as { messageType?: unknown } | null)?.messageType);

/** Raw Evolution rows → message events, minus what §5.2 leaves out (and every revoke/edit/reaction event). */
export function toHistoryEvents(instance: string, records: unknown[]): MessageEvent[] {
  // A row without a positive timestamp would get the parser's "now" fallback and land as today's message.
  const kept = records.filter((r) => stampOf(r) > 0 && !SKIP_TYPES.has(typeOf(r)));
  if (kept.length === 0) return [];
  return parseEvolutionWebhook({ event: 'messages.upsert', instance, data: kept }).filter(
    (e): e is MessageEvent => e.type === 'message',
  );
}

function nameFor(names: ContactNames, ev: MessageEvent): string | null {
  return (ev.phone ? names.get(`p:${ev.phone}`) : undefined) ?? (ev.lid ? names.get(`l:${ev.lid}`) : undefined) ?? null;
}

/** §5.3: the contact's open chat on the channel, else its history chat (created closed when missing). */
async function destinationChat(tx: Tx, contactId: string, channelId: string, sectorId: string, firstAt: Date): Promise<Target> {
  const same = and(eq(chats.contactId, contactId), eq(chats.channelId, channelId));
  const [open] = await tx.select({ id: chats.id }).from(chats).where(and(same, eq(chats.state, 'open')));
  if (open) return { id: open.id, history: false };
  const findHistory = async () => (await tx.select({ id: chats.id }).from(chats).where(and(same, eq(chats.history, true))))[0];
  const found = await findHistory();
  if (found) return { id: found.id, history: true };
  await tx
    .insert(chats)
    .values({
      id: randomUUID(), contactId, channelId, sectorId, ownerId: null, state: 'closed', history: true,
      waiting: false, private: false, triagePending: false, unread: 0, createdAt: firstAt, closedAt: firstAt,
    })
    .onConflictDoNothing(); // chats_one_history_per_contact_channel: a concurrent copy created it
  const created = await findHistory();
  if (!created) throw new Error('placeRecords: history chat insert conflicted but none was found');
  return { id: created.id, history: true };
}

/** last_message_at/preview only move forward; unread, waiting and triage never change (§3 opção B). */
async function touchChat(tx: Tx, chat: Target, ev: MessageEvent): Promise<void> {
  const sentAt = ev.sentAt.toISOString();
  const isNewest = sql`(${chats.lastMessageAt} is null or ${chats.lastMessageAt} <= ${sentAt}::timestamptz)`;
  await tx
    .update(chats)
    .set({
      lastMessageAt: sql`greatest(${chats.lastMessageAt}, ${sentAt}::timestamptz)`,
      lastMessagePreview: sql`case when ${isNewest} then ${messagePreview(ev.kind, ev.body)} else ${chats.lastMessagePreview} end`,
      // a history chat spans its first to its last message (§5.3)
      ...(chat.history
        ? {
            createdAt: sql`least(${chats.createdAt}, ${sentAt}::timestamptz)`,
            closedAt: sql`greatest(${chats.closedAt}, ${sentAt}::timestamptz)`,
          }
        : {}),
    })
    .where(eq(chats.id, chat.id));
}

/**
 * Places one batch (one findMessages page, ≤ 500 rows) as history (§5.2–5.3) in one short transaction, then
 * publishes chat.updated once per open chat it touched. `seen` carries the ids of the whole copy: Evolution
 * stores some history messages twice. Never calls triage, bots, avatar refresh or media download.
 */
export async function placeRecords(
  ctx: AppCtx,
  channel: ChannelRef,
  records: unknown[],
  opts: { names: ContactNames; seen: Set<string> },
): Promise<PlaceResult> {
  const result: PlaceResult = { inserted: 0, contactsCreated: 0, oldest: null, historyCounts: new Map() };
  const parsed = toHistoryEvents(channel.evolutionInstance, records);
  // §5.4/§6: a live row carries remoteJid @lid + remoteJidAlt (the phone). Join a LID-only contact into the phone one
  // first, so this batch (and every later one) finds a single contact. Rows the app already stores count too.
  await mergeLidPairs(ctx, parsed.flatMap((ev) => (ev.phone && ev.lid ? [{ lid: ev.lid, phone: ev.phone }] : [])));
  const events = parsed.filter((ev) => {
    if (opts.seen.has(ev.externalId)) return false;
    opts.seen.add(ev.externalId);
    return true;
  });
  if (events.length === 0) return result;
  events.sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime()); // oldest first: a quote finds its earlier message
  const mediaCutoff = ctx.botRuntime.now().getTime() - MEDIA_MAX_AGE_MS;
  const openTouched = new Set<string>();

  // Only `tx` inside (PGlite serializes transactions; ctx.db here would deadlock), and no hub calls.
  await ctx.db.transaction(async (tx) => {
    const have = await tx
      .select({ externalId: messages.externalId })
      .from(messages)
      .where(and(eq(messages.channelId, channel.id), inArray(messages.externalId, events.map((e) => e.externalId))));
    const stored = new Set(have.map((r) => r.externalId));
    const sectorId = await getDefaultSectorId(tx);
    const contactByAddress = new Map<string, Contact | null>();
    const chatByContact = new Map<string, Target>();

    for (const ev of events) {
      if (stored.has(ev.externalId)) continue; // never update a stored message (§5.2)

      const address = `${ev.phone ?? ''}|${ev.lid ?? ''}`;
      let contact = contactByAddress.get(address);
      if (contact === undefined) {
        const resolved = await resolveContact(tx, ev, realName(ev.pushName) ?? nameFor(opts.names, ev));
        if (resolved?.created) result.contactsCreated += 1;
        contact = resolved?.contact ?? null;
        contactByAddress.set(address, contact);
      }
      if (!contact || contact.blocked) continue;

      let chat = chatByContact.get(contact.id);
      if (!chat) {
        chat = await destinationChat(tx, contact.id, channel.id, sectorId, ev.sentAt);
        chatByContact.set(contact.id, chat);
      }

      const replyToId = await replyToIdOf(tx, channel.id, ev.replyToExternalId);

      const [row] = await tx
        .insert(messages)
        .values({
          id: randomUUID(),
          chatId: chat.id,
          channelId: channel.id,
          direction: ev.direction,
          kind: ev.kind,
          body: ev.body,
          mediaMime: ev.mediaMime,
          mediaName: ev.mediaName,
          authorId: null,
          replyToId,
          externalId: ev.externalId,
          status: 'sent',
          sentAt: ev.sentAt,
          createdAt: ev.sentAt, // §5.2: same order as live messages; never "the last reply" a bot reads
          mediaStatus: ev.hasMedia ? (ev.sentAt.getTime() >= mediaCutoff ? 'queued' : 'expired') : null,
        })
        .onConflictDoNothing({ target: [messages.channelId, messages.externalId] })
        .returning({ id: messages.id });
      if (!row) continue; // the live webhook stored it meanwhile

      await touchChat(tx, chat, ev);
      result.inserted += 1;
      if (!result.oldest || ev.sentAt < result.oldest) result.oldest = ev.sentAt;
      if (chat.history) result.historyCounts.set(chat.id, (result.historyCounts.get(chat.id) ?? 0) + 1);
      else openTouched.add(chat.id);
    }
  });

  for (const chatId of openTouched) await ctx.hub.publishChat(chatId);
  return result;
}

/** One history_imported { count } event per history chat that received messages (§5.3). */
export async function writeHistoryEvents(ctx: AppCtx, counts: Map<string, number>): Promise<void> {
  if (counts.size === 0) return;
  await ctx.db.transaction(async (tx) => {
    for (const [chatId, count] of counts) await addEvent(tx, chatId, 'history_imported', { count }, null);
  });
}
