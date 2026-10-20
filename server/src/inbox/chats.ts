import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { and, asc, eq, gt, inArray, isNotNull, isNull, max, type SQL } from 'drizzle-orm';
import { stopRunsForChat } from '../bots/engine.js';
import type { AppCtx } from '../ctx.js';
import type { Db, Tx } from '../db/client.js';
import {
  channels, chatPins, chatTags, chats, contacts, deletedChats, messages, quickAnswers, sectors, settings, tags, users,
} from '../db/schema.js';
import { HttpError, badRequest, conflict, forbidden, notFound } from '../lib/http-error.js';
import { BlockError } from '../bots/block-error.js';
import type { BotActor } from '../bots/registry.js';
import { sendSystemMessage } from '../messages/send.js';
import { normalizePhoneBR } from '../whatsapp/phone.js';
import { addEvent, type ChatEventKind } from './events.js';
import { canSee, visibleChatsWhere, type AuthUser } from './visibility.js';

export type ChatRow = typeof chats.$inferSelect;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** History spec §8: imported history chats are read-only. */
export const HISTORY_READ_ONLY = 'Conversa de histórico do WhatsApp: só leitura.';

const STALE = 'A conversa foi alterada por outra pessoa. Recarregue e tente de novo.';
/** 409 for an open chat the user cannot see. An admin only lacks "ver todos" (with it he sees every chat). */
const busyElsewhere = (user: AuthUser) =>
  conflict(
    user.role === 'admin'
      ? 'Já existe uma conversa aberta com este contato que você não pode ver. Ative “Ver todos os setores” para acessá-la.'
      : 'Este contato já está em atendimento em outro setor.',
  );

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

// ponytail: canSee already limits a private chat to its owner + an admin with "ver todos", so "only owner/admin
// transfer or close a private chat" (§5.3) holds through getChatForUser's 404; no separate check.

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

/** 400 for a missing or nonexistent destination. The bulk transfer checks it once, before any chatbot is stopped. */
export async function validateTransferTarget(db: Db | Tx, to: { sectorId?: string; ownerId?: string | null }): Promise<void> {
  if (to.sectorId === undefined && to.ownerId === undefined) throw badRequest('Informe o setor ou o atendente.');
  if (to.sectorId !== undefined && !(await sectorExists(db, to.sectorId))) throw badRequest('Setor inválido.');
  if (to.ownerId && !(await activeUserExists(db, to.ownerId))) throw badRequest('Atendente inválido.');
}

export async function getClosingMessage(db: Db | Tx): Promise<string> {
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
    { ownerId: user.id, triagePending: false }, // a human took it: the contact's next reply is no triage answer
    { kind: 'assigned', data: { ownerId: user.id, previousOwnerId: chat.ownerId }, authorId: user.id },
  );
}

export async function transferChat(
  ctx: AppCtx,
  user: AuthUser,
  chatId: string,
  to: { sectorId?: string; ownerId?: string | null },
): Promise<ChatRow> {
  const chat = await getChatForUser(ctx, user, chatId);
  if (chat.state !== 'open') throw conflict('Conversa finalizada.');
  await validateTransferTarget(ctx.db, to);

  const sectorId = to.sectorId ?? chat.sectorId;
  const ownerId = to.ownerId === undefined ? chat.ownerId : to.ownerId;
  return updateChat(
    ctx,
    chatId,
    and(eq(chats.state, 'open'), eq(chats.sectorId, chat.sectorId), sameOwner(chat.ownerId)),
    // triage ends too, or the contact's next reply would re-route the chat away from this manual transfer
    ownerId === null ? { sectorId, ownerId, private: false, triagePending: false } : { sectorId, ownerId, triagePending: false },
    {
      kind: 'transferred',
      data: { fromSectorId: chat.sectorId, toSectorId: sectorId, fromOwnerId: chat.ownerId, toOwnerId: ownerId },
      authorId: user.id,
    },
  );
}

export async function setChatPrivacy(ctx: AppCtx, user: AuthUser, chatId: string, isPrivate: boolean): Promise<ChatRow> {
  const chat = await getChatForUser(ctx, user, chatId);
  if (chat.history) throw conflict(HISTORY_READ_ONLY);
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
 * It runs before the UPDATE so the message goes out while the chat is still open, and resolves false when the
 * gateway failed: the chat then stays open so the failed bubble can still be resent.
 */
export async function closeChat(
  ctx: AppCtx,
  user: AuthUser,
  chatId: string,
  opts: { sendClosingMessage: boolean; sendClosing?: (text: string) => Promise<boolean> },
): Promise<ChatRow> {
  const chat = await getChatForUser(ctx, user, chatId);
  if (chat.state !== 'open') throw conflict('A conversa já está finalizada.');
  let closingMessageSent = false;
  if (opts.sendClosingMessage) {
    const text = await getClosingMessage(ctx.db);
    if (text) {
      if (!opts.sendClosing) throw new Error('closeChat: sendClosing was not provided');
      if (!(await opts.sendClosing(text))) throw conflict('Mensagem de encerramento não enviada; a conversa continua aberta.');
      closingMessageSent = true;
    }
  }
  // Only state is checked: sending the closing message may legitimately have set the owner (§5.2 step 2).
  return updateChat(
    ctx,
    chatId,
    eq(chats.state, 'open'),
    { state: 'closed', closedAt: new Date(), waiting: false, waitingSince: null, triagePending: false },
    { kind: 'closed', data: { closingMessageSent }, authorId: user.id },
  );
}

export async function reopenChat(ctx: AppCtx, user: AuthUser, chatId: string): Promise<ChatRow> {
  const chat = await getChatForUser(ctx, user, chatId);
  if (chat.history) throw conflict(HISTORY_READ_ONLY);
  if (chat.state !== 'closed') throw conflict('A conversa já está aberta.');
  const [other] = await ctx.db
    .select()
    .from(chats)
    .where(and(eq(chats.contactId, chat.contactId), eq(chats.channelId, chat.channelId), eq(chats.state, 'open')));
  if (other) {
    if (!canSee(user, other)) throw busyElsewhere(user);
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

const MAX_PINS = 3;

export async function markChatRead(ctx: AppCtx, user: AuthUser, chatId: string): Promise<void> {
  await getChatForUser(ctx, user, chatId);
  const changed = await ctx.db
    .update(chats)
    .set({ unread: 0 })
    .where(and(eq(chats.id, chatId), gt(chats.unread, 0)))
    .returning({ id: chats.id });
  if (changed.length) await ctx.hub.publishChat(chatId);
}

/** "Marcar como não lida": 0 becomes 1; a chat that already has unread messages keeps its count. */
export async function markChatUnread(ctx: AppCtx, user: AuthUser, chatId: string): Promise<void> {
  await getChatForUser(ctx, user, chatId);
  const changed = await ctx.db
    .update(chats)
    .set({ unread: 1 })
    .where(and(eq(chats.id, chatId), eq(chats.unread, 0)))
    .returning({ id: chats.id });
  if (changed.length) await ctx.hub.publishChat(chatId);
}

/**
 * Admin only. Removes the chat with its messages, events, pins and bot runs (FK cascades), writes a deleted_chats
 * tombstone so a later history import skips the contact's rows on the channel up to now, then removes the chat's
 * media files. The contact stays; a live message after this opens a new chat.
 */
export async function deleteChat(ctx: AppCtx, user: AuthUser, chatId: string): Promise<void> {
  if (user.role !== 'admin') throw forbidden('Só administradores podem excluir conversas.');
  const chat = await getChatForUser(ctx, user, chatId);
  // reason: the runs and their bot_stopped events go with the chat, so no reason of its own is ever shown
  await stopRunsForChat(ctx, chatId, { userId: user.id, reason: 'chat_closed' });
  const now = ctx.botRuntime.now();
  // Only `tx` inside (PGlite serializes transactions; ctx.db here would deadlock).
  const orphanPaths = await ctx.db.transaction(async (tx) => {
    const paths = await chatMediaPaths(tx, eq(messages.chatId, chatId));
    // a phone clock ahead of the server can stamp a message after `now`: cover every message of the chat
    const [last] = await tx.select({ at: max(messages.sentAt) }).from(messages).where(eq(messages.chatId, chatId));
    const until = last?.at && last.at > now ? last.at : now;
    await tx.insert(deletedChats).values({
      id: randomUUID(), contactId: chat.contactId, channelId: chat.channelId, until, deletedBy: user.id, deletedAt: now,
    });
    await tx.delete(chats).where(eq(chats.id, chatId));
    return unusedMediaPaths(tx, paths);
  });
  await removeMediaFiles(ctx, orphanPaths, { chatId });
  ctx.hub.publishChatRemoved(chatId);
  console.info('chat deleted', { chatId, userId: user.id });
}

/** Media files of the messages `where` selects. Chatbot library files (bots/) are left out: every chat that ran the bot shares them. */
export async function chatMediaPaths(tx: Tx, where: SQL): Promise<string[]> {
  const rows = await tx.selectDistinct({ path: messages.mediaPath }).from(messages).where(and(where, isNotNull(messages.mediaPath)));
  return rows.flatMap((r) => (r.path && !r.path.startsWith('bots/') ? [r.path] : []));
}

/** Of `paths`, those no message or quick answer uses any more. Call in the tx that deleted the rows, after the delete. */
export async function unusedMediaPaths(tx: Tx, paths: string[]): Promise<string[]> {
  if (paths.length === 0) return [];
  // a forwarded or resent file is shared with the copy's row: keep any path something else still uses
  const stillUsed = new Set<string | null>([
    ...(await tx.select({ p: messages.mediaPath }).from(messages).where(inArray(messages.mediaPath, paths))).map((r) => r.p),
    ...(await tx.select({ p: quickAnswers.attachmentPath }).from(quickAnswers).where(inArray(quickAnswers.attachmentPath, paths)))
      .map((r) => r.p),
  ]);
  return paths.filter((p) => !stillUsed.has(p));
}

/** Removes files under mediaDir after their rows are gone; a failure is logged with `logCtx`, never thrown. */
export async function removeMediaFiles(ctx: AppCtx, paths: string[], logCtx: Record<string, string>): Promise<void> {
  const root = resolve(ctx.config.mediaDir);
  for (const rel of paths) {
    const file = resolve(root, rel);
    if (!file.startsWith(root + sep)) continue;
    await rm(file, { force: true }).catch((err: unknown) =>
      console.error('chat media not removed', { ...logCtx, err: err instanceof Error ? err.name : 'unknown' }),
    );
  }
}

export async function pinChat(ctx: AppCtx, user: AuthUser, chatId: string, pinned: boolean): Promise<void> {
  await getChatForUser(ctx, user, chatId);
  if (!pinned) {
    await ctx.db.delete(chatPins).where(and(eq(chatPins.userId, user.id), eq(chatPins.chatId, chatId)));
  } else {
    // Only pins of chats I still see count, so a chat transferred away never blocks a slot.
    const pins = await ctx.db
      .select({ chatId: chatPins.chatId })
      .from(chatPins)
      .innerJoin(chats, eq(chats.id, chatPins.chatId))
      .where(and(eq(chatPins.userId, user.id), visibleChatsWhere(user)));
    if (pins.some((p) => p.chatId === chatId)) return;
    // ponytail: count-then-insert can race to 4 pins with two tabs clicking at once; harmless.
    if (pins.length >= MAX_PINS) throw conflict('Você já fixou 3 conversas. Desafixe uma para fixar outra.');
    await ctx.db.insert(chatPins).values({ userId: user.id, chatId, createdAt: new Date() }).onConflictDoNothing();
  }
  await ctx.hub.publishChat(chatId);
}

/** Spec 2026-10-20 §5: replaces the conversation's tags (same catalog as the contact's). Anyone who sees the chat, open or not. */
export async function setChatTags(ctx: AppCtx, user: AuthUser, chatId: string, tagIds: string[]): Promise<ChatRow> {
  const chat = await getChatForUser(ctx, user, chatId);
  const unique = [...new Set(tagIds)];
  // Only `tx` inside (PGlite serializes transactions; ctx.db here would deadlock).
  await ctx.db.transaction(async (tx) => {
    if (unique.length && (await tx.$count(tags, inArray(tags.id, unique))) !== unique.length) {
      throw badRequest('Etiqueta inexistente');
    }
    await tx.delete(chatTags).where(eq(chatTags.chatId, chatId));
    if (unique.length) await tx.insert(chatTags).values(unique.map((tagId) => ({ chatId, tagId }))).onConflictDoNothing();
  });
  await ctx.hub.publishChat(chatId);
  return chat;
}

async function resolveContactId(tx: Tx, input: { contactId?: string; phone?: string; name?: string }): Promise<string> {
  if (input.contactId) {
    if (!UUID_RE.test(input.contactId)) throw notFound('Contato não encontrado.');
    const [c] = await tx.select({ id: contacts.id }).from(contacts).where(eq(contacts.id, input.contactId));
    if (!c) throw notFound('Contato não encontrado.');
    return c.id;
  }
  if (!input.phone) throw badRequest('Informe o contato ou o telefone.');
  const phone = normalizePhoneBR(input.phone);
  if (!/^55\d{10,11}$/.test(phone)) throw badRequest('Telefone inválido.');
  const now = new Date();
  await tx
    .insert(contacts)
    .values({ id: randomUUID(), name: input.name?.trim() || null, phone, blocked: false, createdAt: now, updatedAt: now })
    .onConflictDoNothing();
  const [c] = await tx.select({ id: contacts.id }).from(contacts).where(eq(contacts.phone, phone));
  if (!c) throw new Error('startChat: contact insert conflicted but no contact was found');
  return c.id;
}

/** §5.3a. Owner = me, waiting=false, triage_pending=false, no triage; reuses the open (contact, channel) chat. */
export async function startChat(
  ctx: AppCtx,
  user: AuthUser,
  input: { contactId?: string; phone?: string; name?: string; sectorId?: string; channelId?: string },
): Promise<ChatRow> {
  if (input.sectorId !== undefined && !(await sectorExists(ctx.db, input.sectorId))) throw badRequest('Setor inválido.');
  const sectorId = input.sectorId ?? (await getDefaultSectorId(ctx.db));
  // channelId: a forward keeps the source message's number. Otherwise the oldest channel (one WhatsApp number today).
  const [channel] = input.channelId
    ? UUID_RE.test(input.channelId)
      ? await ctx.db.select({ id: channels.id }).from(channels).where(eq(channels.id, input.channelId))
      : []
    : await ctx.db.select({ id: channels.id }).from(channels).orderBy(asc(channels.createdAt)).limit(1);
  if (!channel) throw input.channelId ? badRequest('Canal inválido.') : conflict('Nenhum canal de WhatsApp cadastrado.');

  const { chat, created } = await ctx.db.transaction(async (tx) => {
    const contactId = await resolveContactId(tx, input);
    return findOrOpenChat(tx, {
      contactId,
      channelId: channel.id,
      init: { sectorId, ownerId: user.id, waiting: false, triagePending: false, createdBy: user.id },
    });
  });
  if (!created && !canSee(user, chat)) throw busyElsewhere(user);
  if (created) await ctx.hub.publishChat(chat.id);
  return chat;
}

// ---------- the chatbot acting as the system (spec §5.6) ----------
// No canSee: the bot is not a user. Every event has authorId null and carries botId/botName/runId;
// updateChat publishes chat.updated after commit, so each viewer's sector barrier still applies.
// Failures throw BlockError so the run takes the block's `error` edge with a readable reason.

const actorData = (a: BotActor) => ({ botId: a.botId, botName: a.botName, runId: a.runId });

async function chatForBot(ctx: AppCtx, chatId: string, mustBeOpen: boolean): Promise<ChatRow> {
  const [chat] = await ctx.db.select().from(chats).where(eq(chats.id, chatId));
  if (!chat) throw new BlockError('Conversa não encontrada');
  if (mustBeOpen && chat.state !== 'open') throw new BlockError('A conversa está finalizada');
  return chat;
}

/** updateChat, with the 409 STALE (someone changed the chat mid-step) turned into a BlockError. */
async function updateChatAsBot(
  ctx: AppCtx,
  chatId: string,
  expected: SQL | undefined,
  set: Partial<typeof chats.$inferInsert>,
  event: { kind: ChatEventKind; data: Record<string, unknown> },
): Promise<ChatRow> {
  try {
    return await updateChat(ctx, chatId, expected, set, { ...event, authorId: null });
  } catch (e) {
    if (e instanceof HttpError && e.status === 409) throw new BlockError('A conversa foi alterada durante o chatbot');
    throw e;
  }
}

/** ownerId undefined = keep the owner; null clears it (and privacy, like a manual transfer). Always ends triage. */
export async function transferChatAsBot(
  ctx: AppCtx,
  actor: BotActor,
  chatId: string,
  to: { sectorId?: string; ownerId?: string | null },
): Promise<ChatRow> {
  const chat = await chatForBot(ctx, chatId, true);
  if (to.sectorId !== undefined && !(await sectorExists(ctx.db, to.sectorId))) throw new BlockError('Setor não encontrado');
  if (to.ownerId && !(await activeUserExists(ctx.db, to.ownerId))) throw new BlockError('Atendente não encontrado ou inativo');
  const sectorId = to.sectorId ?? chat.sectorId;
  const ownerId = to.ownerId === undefined ? chat.ownerId : to.ownerId;
  return updateChatAsBot(
    ctx,
    chatId,
    and(eq(chats.state, 'open'), eq(chats.sectorId, chat.sectorId), sameOwner(chat.ownerId)),
    ownerId === null ? { sectorId, ownerId, private: false, triagePending: false } : { sectorId, ownerId, triagePending: false },
    {
      kind: 'bot_transferred',
      data: { ...actorData(actor), fromSectorId: chat.sectorId, toSectorId: sectorId, fromOwnerId: chat.ownerId, toOwnerId: ownerId },
    },
  );
}

export async function setChatPrivacyAsBot(ctx: AppCtx, actor: BotActor, chatId: string, isPrivate: boolean): Promise<ChatRow> {
  const chat = await chatForBot(ctx, chatId, false);
  if (chat.private === isPrivate) return chat;
  if (isPrivate && chat.ownerId === null) throw new BlockError('A conversa não tem atendente');
  return updateChatAsBot(
    ctx,
    chatId,
    and(eq(chats.private, chat.private), sameOwner(chat.ownerId)),
    { private: isPrivate },
    { kind: 'privacy_changed', data: { private: isPrivate, ...actorData(actor) } },
  );
}

/** Sends closingText (when non-null) as the bot BEFORE the UPDATE; a failed send keeps the chat open, like closeChat. */
export async function closeChatAsBot(
  ctx: AppCtx,
  actor: BotActor,
  chatId: string,
  opts: { closingText: string | null },
): Promise<ChatRow> {
  const chat = await chatForBot(ctx, chatId, true);
  let closingMessageSent = false;
  if (opts.closingText) {
    const sent = await sendSystemMessage(ctx, chat, { text: opts.closingText, botRunId: actor.runId });
    if (!sent.ok) throw new BlockError('Mensagem de encerramento não enviada');
    closingMessageSent = true;
  }
  return updateChatAsBot(
    ctx,
    chatId,
    eq(chats.state, 'open'),
    { state: 'closed', closedAt: new Date(), waiting: false, waitingSince: null, triagePending: false },
    { kind: 'closed', data: { closingMessageSent, ...actorData(actor) } },
  );
}
