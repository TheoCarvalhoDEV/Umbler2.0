import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, isNull, type SQL } from 'drizzle-orm';
import type { AppCtx } from '../ctx.js';
import type { Db, Tx } from '../db/client.js';
import { channels, chatPins, chats, contacts, sectors, settings, users } from '../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/http-error.js';
import { normalizePhoneBR } from '../whatsapp/phone.js';
import { addEvent, type ChatEventKind } from './events.js';
import { canSee, visibleChatsWhere, type AuthUser } from './visibility.js';

export type ChatRow = typeof chats.$inferSelect;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STALE = 'A conversa foi alterada por outra pessoa. Recarregue e tente de novo.';
const BUSY_ELSEWHERE = 'Este contato já está em atendimento em outro setor.';

/**
 * Returns the open chat for (contact, channel), creating it if none exists.
 * INSERT … ON CONFLICT DO NOTHING hits the partial unique index (contact_id, channel_id) WHERE state='open';
 * when two webhooks race, the loser re-reads the winner's row.
 * Writes the `created` event. Does NOT publish: call inside the caller's transaction and publish after commit.
 */
export async function findOrOpenChat(
  db: Db | Tx,
  args: {
    contactId: string;
    channelId: string;
    init: { sectorId: string; ownerId: string | null; waiting: boolean; triagePending: boolean; createdBy: string | null };
  },
): Promise<{ chat: ChatRow; created: boolean }> {
  const { contactId, channelId, init } = args;
  const [inserted] = await db
    .insert(chats)
    .values({
      id: randomUUID(),
      contactId,
      channelId,
      sectorId: init.sectorId,
      ownerId: init.ownerId,
      state: 'open',
      waiting: init.waiting,
      private: false,
      triagePending: init.triagePending,
      unread: 0,
      createdAt: new Date(),
    })
    .onConflictDoNothing()
    .returning();
  if (inserted) {
    await addEvent(db, inserted.id, 'created', init.createdBy ? { by: init.createdBy } : {}, init.createdBy);
    return { chat: inserted, created: true };
  }
  const [existing] = await db
    .select()
    .from(chats)
    .where(and(eq(chats.contactId, contactId), eq(chats.channelId, channelId), eq(chats.state, 'open')));
  if (!existing) throw new Error('findOrOpenChat: insert conflicted but no open chat was found');
  return { chat: existing, created: false };
}

export async function getDefaultSectorId(db: Db | Tx): Promise<string> {
  const [row] = await db.select({ id: sectors.id }).from(sectors).where(eq(sectors.isDefault, true)).limit(1);
  if (!row) throw new Error('Nenhum setor padrão configurado');
  return row.id;
}

/** 404 when the id is malformed, the chat does not exist, or the user cannot see it (§6). */
export async function getChatForUser(ctx: AppCtx, user: AuthUser, chatId: string): Promise<ChatRow> {
  if (!UUID_RE.test(chatId)) throw notFound();
  const [chat] = await ctx.db.select().from(chats).where(eq(chats.id, chatId));
  if (!chat || !canSee(user, chat)) throw notFound();
  return chat;
}
