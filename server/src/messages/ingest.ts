import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { getChannelByInstance, setChannelQr, setChannelStatus } from '../channels/service.js';
import type { AppCtx } from '../ctx.js';
import type { Tx } from '../db/client.js';
import { chats, contacts, messages } from '../db/schema.js';
import { findOrOpenChat, getDefaultSectorId, type ChatRow } from '../inbox/chats.js';
import { handleTriageReply, startTriage } from '../triage/triage.js';
import { normalizePhoneBR } from '../whatsapp/phone.js';
import type { InboundEvent } from '../whatsapp/types.js';
import { messagePreview } from './dto.js';
import { saveMedia } from './media.js';

type MessageEvent = Extract<InboundEvent, { type: 'message' }>;
type StatusEvent = Extract<InboundEvent, { type: 'status' }>;
type MessageStatus = (typeof messages.$inferSelect)['status'];
type Contact = typeof contacts.$inferSelect;

export interface IngestHooks {
  startTriage: typeof startTriage;
  handleTriageReply: typeof handleTriageReply;
}

const defaultHooks: IngestHooks = { startTriage, handleTriageReply };

/** messages.error of a failed media download (the DTO's mediaUnavailable comes from the missing file, Task 8). */
export const MEDIA_UNAVAILABLE = 'mídia indisponível';

/** Statuses a message may be in for the incoming status to apply (pending < sent < delivered < read; failed only from pending/sent). */
const ADVANCES_FROM: Record<StatusEvent['status'], MessageStatus[]> = {
  sent: ['pending'],
  delivered: ['pending', 'sent'],
  read: ['pending', 'sent', 'delivered'],
  failed: ['pending', 'sent'],
};

/** Thrown inside the ingest transaction to roll it back and stop silently. */
class Skip extends Error {}

export async function handleInbound(ctx: AppCtx, events: InboundEvent[], hooks: IngestHooks = defaultHooks): Promise<void> {
  for (const ev of events) {
    if (ev.type === 'connection') {
      await setChannelStatus(ctx, ev.instance, ev.status, ev.phone);
      continue;
    }
    if (ev.type === 'ignored') continue;

    const channel = await getChannelByInstance(ctx.db, ev.instance);
    if (!channel) continue;

    // §5.6: the admin's QR comes from qrcode.updated; GET /api/channels/:id/qr (Task 14) serves the latest one.
    if (ev.type === 'qrcode') setChannelQr(ctx, ev.instance, ev.qrBase64);
    else if (ev.type === 'status') await applyStatus(ctx, channel.id, ev);
    else if (ev.type === 'reaction') await applyReaction(ctx, channel.id, ev.targetExternalId, ev.emoji);
    else await ingestMessage(ctx, channel.id, ev, hooks);
  }
}

async function applyStatus(ctx: AppCtx, channelId: string, ev: StatusEvent): Promise<void> {
  const [row] = await ctx.db
    .update(messages)
    .set({ status: ev.status })
    .where(
      and(
        eq(messages.channelId, channelId),
        eq(messages.externalId, ev.externalId),
        inArray(messages.status, ADVANCES_FROM[ev.status]),
      ),
    )
    .returning({ id: messages.id, chatId: messages.chatId });
  if (row) await ctx.hub.publishMessage(row.chatId, 'message.updated', row.id);
}

/** Reactions never create chats nor touch unread/waiting (§5.1). Unknown target → ignored. */
async function applyReaction(ctx: AppCtx, channelId: string, targetExternalId: string, emoji: string | null): Promise<void> {
  const [row] = await ctx.db
    .update(messages)
    .set({ reaction: emoji || null })
    .where(and(eq(messages.channelId, channelId), eq(messages.externalId, targetExternalId)))
    .returning({ id: messages.id, chatId: messages.chatId });
  if (row) await ctx.hub.publishMessage(row.chatId, 'message.updated', row.id);
}

async function ingestMessage(ctx: AppCtx, channelId: string, ev: MessageEvent, hooks: IngestHooks): Promise<void> {
  const inbound = ev.direction === 'in';
  let stored: { messageId: string; chat: ChatRow; created: boolean };
  try {
    // Inside this transaction only `tx` may be used: PGlite serializes transactions, so touching ctx.db here would deadlock.
    stored = await ctx.db.transaction(async (tx) => {
      const [dup] = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.channelId, channelId), eq(messages.externalId, ev.externalId)))
        .limit(1);
      if (dup) throw new Skip(); // duplicate webhook, or the echo of a message we sent ourselves

      const contact = await resolveContact(tx, ev);
      if (!contact || contact.blocked) throw new Skip();

      const { chat, created } = await findOrOpenChat(tx, {
        contactId: contact.id,
        channelId,
        init: { sectorId: await getDefaultSectorId(tx), ownerId: null, waiting: inbound, triagePending: false, createdBy: null },
      });

      let replyToId: string | null = null;
      if (ev.replyToExternalId) {
        const [quoted] = await tx
          .select({ id: messages.id })
          .from(messages)
          .where(and(eq(messages.channelId, channelId), eq(messages.externalId, ev.replyToExternalId)))
          .limit(1);
        replyToId = quoted?.id ?? null;
      }

      const [inserted] = await tx
        .insert(messages)
        .values({
          id: randomUUID(),
          chatId: chat.id,
          channelId,
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
        })
        .onConflictDoNothing({ target: [messages.channelId, messages.externalId] })
        .returning({ id: messages.id });
      if (!inserted) throw new Skip(); // a concurrent copy of this webhook won the race

      const sentAt = ev.sentAt.toISOString();
      const preview = messagePreview(ev.kind, ev.body);
      const isNewest = sql`(${chats.lastMessageAt} is null or ${chats.lastMessageAt} <= ${sentAt}::timestamptz)`;
      const [updated] = await tx
        .update(chats)
        .set({
          lastMessageAt: sql`greatest(${chats.lastMessageAt}, ${sentAt}::timestamptz)`,
          lastMessagePreview: sql`case when ${isNewest} then ${preview} else ${chats.lastMessagePreview} end`,
          ...(inbound
            ? { unread: sql`${chats.unread} + 1`, waiting: true }
            : { waiting: false, triagePending: false }),
        })
        .where(eq(chats.id, chat.id))
        .returning();

      return { messageId: inserted.id, chat: updated, created };
    });
  } catch (err) {
    if (err instanceof Skip) return;
    throw err;
  }

  await ctx.hub.publishMessage(stored.chat.id, 'message.created', stored.messageId);
  await ctx.hub.publishChat(stored.chat.id);

  if (ev.hasMedia) await fetchMedia(ctx, ev, stored.chat.id, stored.messageId);

  if (inbound) {
    if (stored.created) await hooks.startTriage(ctx, stored.chat);
    else if (stored.chat.triagePending) await hooks.handleTriageReply(ctx, stored.chat, ev.body);
  }
}

async function findContact(tx: Tx, where: SQL): Promise<Contact | undefined> {
  const [row] = await tx.select().from(contacts).where(where).limit(1);
  return row;
}

async function lookup(tx: Tx, phone: string | null, lid: string | null) {
  return {
    byPhone: phone ? await findContact(tx, eq(contacts.phone, phone)) : undefined,
    byLid: lid ? await findContact(tx, eq(contacts.lid, lid)) : undefined,
  };
}

/** Match by normalized phone, then by lid; fill what is missing; create on first contact (race-safe). */
async function resolveContact(tx: Tx, ev: MessageEvent): Promise<Contact | undefined> {
  const phone = ev.phone ? normalizePhoneBR(ev.phone) : null;
  const name = ev.direction === 'in' ? ev.pushName : null; // on fromMe messages pushName is the office's own name
  if (!phone && !ev.lid) return undefined;

  const { byPhone, byLid } = await lookup(tx, phone, ev.lid);
  // ponytail: when phone and lid point at two different contacts we use the phone one and do not merge
  const found = byPhone ?? byLid;

  if (!found) {
    await tx.insert(contacts).values({ id: randomUUID(), phone, lid: ev.lid, name }).onConflictDoNothing();
    const again = await lookup(tx, phone, ev.lid);
    return again.byPhone ?? again.byLid;
  }

  const patch: Partial<typeof contacts.$inferInsert> = {};
  if (!found.phone && phone && !byPhone) patch.phone = phone;
  if (!found.lid && ev.lid && !byLid) patch.lid = ev.lid;
  if (!found.name && name) patch.name = name;
  if (Object.keys(patch).length > 0) {
    await tx.update(contacts).set({ ...patch, updatedAt: new Date() }).where(eq(contacts.id, found.id));
  }
  return found;
}

/** Runs after commit; a failed download never loses the message (§5.1 step 6). */
async function fetchMedia(ctx: AppCtx, ev: MessageEvent, chatId: string, messageId: string): Promise<void> {
  let patch: Partial<typeof messages.$inferInsert>;
  try {
    const media = await ctx.wa.downloadMedia(ev.instance, ev.raw);
    const name = ev.mediaName ?? media.fileName ?? null;
    const saved = await saveMedia(ctx.config.mediaDir, Buffer.from(media.base64, 'base64'), media.mime, name);
    patch = { mediaPath: saved.path, mediaSize: saved.size, mediaMime: media.mime, mediaName: name };
  } catch (err) {
    // Name and message only: never the body or the base64. A systemic failure (EACCES on mediaDir, disk full,
    // wrong Evolution URL/key) would otherwise look like one flaky download. AppCtx has no logger.
    console.error('media download failed', { messageId, err: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
    patch = { error: MEDIA_UNAVAILABLE };
  }
  await ctx.db.update(messages).set(patch).where(eq(messages.id, messageId));
  await ctx.hub.publishMessage(chatId, 'message.updated', messageId);
}
