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

// ponytail: canSee already limits a private chat to owner + admin, so "only owner/admin transfer or close a
// private chat" (§5.3) holds through getChatForUser's 404; no separate check.

/** `owner_id IS NOT DISTINCT FROM ownerId` */
function sameOwner(ownerId: string | null): SQL {
  return ownerId === null ? isNull(chats.ownerId) : eq(chats.ownerId, ownerId);
}

/** UPDATE … WHERE id AND expected (0 rows → 409) + event in one transaction; publishes after commit. */
async function updateChat(
  ctx: AppCtx,
  chatId: string,
  expected: SQL | undefined,
  set: Partial<typeof chats.$inferInsert>,
  event: { kind: ChatEventKind; data: Record<string, unknown>; authorId: string | null },
): Promise<ChatRow> {
  const row = await ctx.db.transaction(async (tx) => {
    const [updated] = await tx
      .update(chats)
      .set(set)
      .where(and(eq(chats.id, chatId), expected))
      .returning();
    if (!updated) throw conflict(STALE);
    await addEvent(tx, chatId, event.kind, event.data, event.authorId);
    return updated;
  });
  await ctx.hub.publishChat(chatId);
  return row;
}

async function sectorExists(db: Db | Tx, id: string): Promise<boolean> {
  if (!UUID_RE.test(id)) return false;
  const [row] = await db.select({ id: sectors.id }).from(sectors).where(eq(sectors.id, id));
  return !!row;
}

async function activeUserExists(db: Db | Tx, id: string): Promise<boolean> {
  if (!UUID_RE.test(id)) return false;
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, id), eq(users.active, true)));
  return !!row;
}

async function getClosingMessage(db: Db | Tx): Promise<string> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, 'closing_message'));
  return typeof row?.value === 'string' ? row.value.trim() : '';
}

export async function assumeChat(ctx: AppCtx, user: AuthUser, chatId: string): Promise<ChatRow> {
  const chat = await getChatForUser(ctx, user, chatId);
  if (chat.state !== 'open') throw conflict('Conversa finalizada.');
  if (chat.ownerId === user.id) return chat;
  return updateChat(
    ctx,
    chatId,
    and(eq(chats.state, 'open'), sameOwner(chat.ownerId)),
    { ownerId: user.id },
    { kind: 'assigned', data: { ownerId: user.id, previousOwnerId: chat.ownerId }, authorId: user.id },
  );
}

export async function transferChat(
  ctx: AppCtx,
  user: AuthUser,
  chatId: string,
  to: { sectorId?: string; ownerId?: string | null },
): Promise<ChatRow> {
  if (to.sectorId === undefined && to.ownerId === undefined) throw badRequest('Informe o setor ou o atendente.');
  const chat = await getChatForUser(ctx, user, chatId);
  if (chat.state !== 'open') throw conflict('Conversa finalizada.');
  if (to.sectorId !== undefined && !(await sectorExists(ctx.db, to.sectorId))) throw badRequest('Setor inválido.');
  if (to.ownerId && !(await activeUserExists(ctx.db, to.ownerId))) throw badRequest('Atendente inválido.');

  const sectorId = to.sectorId ?? chat.sectorId;
  const ownerId = to.ownerId === undefined ? chat.ownerId : to.ownerId;
  return updateChat(
    ctx,
    chatId,
    and(eq(chats.state, 'open'), eq(chats.sectorId, chat.sectorId), sameOwner(chat.ownerId)),
    ownerId === null ? { sectorId, ownerId, private: false } : { sectorId, ownerId },
    {
      kind: 'transferred',
      data: { fromSectorId: chat.sectorId, toSectorId: sectorId, fromOwnerId: chat.ownerId, toOwnerId: ownerId },
      authorId: user.id,
    },
  );
}

export async function setChatPrivacy(ctx: AppCtx, user: AuthUser, chatId: string, isPrivate: boolean): Promise<ChatRow> {
  const chat = await getChatForUser(ctx, user, chatId);
  if (user.role !== 'admin' && chat.ownerId !== user.id) {
    throw forbidden('Só o dono da conversa ou um administrador pode alterar a privacidade.');
  }
  if (chat.private === isPrivate) return chat;
  if (isPrivate && chat.ownerId === null) throw badRequest('Assuma a conversa antes de torná-la privada.');
  return updateChat(
    ctx,
    chatId,
    and(eq(chats.private, chat.private), sameOwner(chat.ownerId)),
    { private: isPrivate },
    { kind: 'privacy_changed', data: { private: isPrivate }, authorId: user.id },
  );
}

/**
 * opts.sendClosing is wired by the route (Task 13) to sendAgentMessage(ctx, user, chatId, { text, signature: false }).
 * It runs before the UPDATE so the message goes out while the chat is still open.
 */
export async function closeChat(
  ctx: AppCtx,
  user: AuthUser,
  chatId: string,
  opts: { sendClosingMessage: boolean; sendClosing?: (text: string) => Promise<void> },
): Promise<ChatRow> {
  const chat = await getChatForUser(ctx, user, chatId);
  if (chat.state !== 'open') throw conflict('A conversa já está finalizada.');
  let closingMessageSent = false;
  if (opts.sendClosingMessage) {
    const text = await getClosingMessage(ctx.db);
    if (text) {
      if (!opts.sendClosing) throw new Error('closeChat: sendClosing was not provided');
      await opts.sendClosing(text);
      closingMessageSent = true;
    }
  }
  // Only state is checked: sending the closing message may legitimately have set the owner (§5.2 step 2).
  return updateChat(
    ctx,
    chatId,
    eq(chats.state, 'open'),
    { state: 'closed', closedAt: new Date(), waiting: false, triagePending: false },
    { kind: 'closed', data: { closingMessageSent }, authorId: user.id },
  );
}

export async function reopenChat(ctx: AppCtx, user: AuthUser, chatId: string): Promise<ChatRow> {
  const chat = await getChatForUser(ctx, user, chatId);
  if (chat.state !== 'closed') throw conflict('A conversa já está aberta.');
  const [other] = await ctx.db
    .select()
    .from(chats)
    .where(and(eq(chats.contactId, chat.contactId), eq(chats.channelId, chat.channelId), eq(chats.state, 'open')));
  if (other) {
    if (!canSee(user, other)) throw conflict(BUSY_ELSEWHERE);
    return other;
  }
  // ponytail: a chat opened between this check and the UPDATE trips the partial unique index (500);
  // at 3–10 agents a retry from the UI is enough. Catch 23505 here if it ever shows up in logs.
  return updateChat(
    ctx,
    chatId,
    eq(chats.state, 'closed'),
    { state: 'open', closedAt: null },
    { kind: 'reopened', data: {}, authorId: user.id },
  );
}
