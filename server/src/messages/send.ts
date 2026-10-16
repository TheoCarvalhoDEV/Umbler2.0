import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import type { BotAction, BotAttachment } from '@talk/shared';
import { applyBotRunningBehavior } from '../bots/hooks.js';
import { refreshAvatarInBackground } from '../contacts/avatar.js';
import type { AppCtx } from '../ctx.js';
import type { Db, Tx } from '../db/client.js';
import { channels, chats, contacts, messages, sectors } from '../db/schema.js';
import { getChatForUser, type ChatRow } from '../inbox/chats.js';
import { addEvent } from '../inbox/events.js';
import type { AuthUser } from '../inbox/visibility.js';
import { badRequest, conflict, notFound } from '../lib/http-error.js';
import type { QuotedRef, SendResult } from '../whatsapp/types.js';
import { messagePreview, toMessageDto } from './dto.js';
import { baseMime, saveMedia } from './media.js';
import { formatSignature, signatureLabel } from './signature.js';

type MessageRow = typeof messages.$inferSelect;
type MessageDto = Awaited<ReturnType<typeof toMessageDto>>;
type OutKind = 'text' | 'image' | 'video' | 'audio' | 'document';

export interface SendInput {
  text?: string;
  file?: { buffer: Buffer; mime: string; name: string };
  asVoice?: boolean;
  signature: boolean;
  replyToId?: string;
  /** Spec §5.5: the agent's answer to BOT_RUNNING; absent = settings.bot_running_behavior decides. */
  botAction?: BotAction;
}

/**
 * Success path of every send (agent send, resend, triage system text — spec §5.1 idempotency).
 * Evolution's messages.upsert echo can beat the gateway response; ingest then stored an author-less copy
 * with our external_id. Drop it so ours keeps the id (otherwise the update hits
 * messages_channel_external_unique), then mark ours sent — one transaction.
 */
export async function markSent(
  db: Db,
  messageId: string,
  channelId: string,
  externalId: string,
): Promise<{ row: MessageRow; echoDropped: boolean }> {
  const attempt = () => db.transaction(async (tx) => {
    const gone = await tx
      .delete(messages)
      .where(
        and(
          eq(messages.channelId, channelId),
          eq(messages.externalId, externalId),
          isNull(messages.authorId),
          ne(messages.id, messageId),
        ),
      )
      .returning({ id: messages.id });
    const [row] = await tx
      .update(messages)
      .set({ externalId, status: 'sent', error: null })
      .where(eq(messages.id, messageId))
      .returning();
    return { row: row!, echoDropped: gone.length > 0 };
  });
  try {
    return await attempt();
  } catch (err) {
    // drizzle wraps the postgres-js error, so the SQLSTATE may sit on `cause`.
    const e = err as { code?: string; cause?: { code?: string } } | null;
    if ((e?.code ?? e?.cause?.code) !== '23505') throw err;
    // ponytail: one retry covers the echo committing mid-markSent (our DELETE missed it, our UPDATE then waited on
    // the unique index); Postgres only raises 23505 after that commit, so the echo is visible on the second pass.
    return attempt();
  }
}

/** Boot sweep: a row still 'pending' was interrupted (restart/kill mid-send); 'failed' lets the agent resend it. */
export async function failInterruptedSends(db: Db): Promise<void> {
  // ponytail: single app process, so every row still pending at boot was interrupted by a restart;
  // needs an age/owner guard if the app ever runs more than one replica. Nothing is published: clients refetch on reconnect.
  await db.update(messages).set({ status: 'failed', error: 'Envio interrompido' }).where(eq(messages.status, 'pending'));
}

/** WhatsApp address: canonical phone digits, or '<lid>@lid' for a contact known only by LID. */
export function waAddress(c: { phone: string | null; lid: string | null } | undefined): string | null {
  return c?.phone ?? (c?.lid ? `${c.lid}@lid` : null);
}

function fileKind(mime: string, asVoice: boolean): Exclude<OutKind, 'text'> {
  const type = baseMime(mime);
  if (asVoice) return 'audio';
  if (type === 'image/jpeg' || type === 'image/png') return 'image';
  if (type === 'video/mp4') return 'video';
  return 'document';
}

/** Spec §5.2 steps 2 and 5: first sender becomes owner; agent activity clears waiting/unread/triage. */
async function touchChat(tx: Tx, user: AuthUser, chat: ChatRow, last?: { at: Date; preview: string }): Promise<void> {
  if (chat.ownerId === null) {
    const won = await tx
      .update(chats)
      .set({ ownerId: user.id })
      .where(and(eq(chats.id, chat.id), isNull(chats.ownerId)))
      .returning({ id: chats.id });
    // Same data shape as Task 7's assumeChat; the conditional UPDATE above only wins when there was no owner.
    if (won.length > 0) await addEvent(tx, chat.id, 'assigned', { ownerId: user.id, previousOwnerId: null }, user.id);
  }
  await tx
    .update(chats)
    .set({
      waiting: false,
      unread: 0,
      triagePending: false,
      ...(last
        ? {
            lastMessageAt: sql`greatest(${chats.lastMessageAt}, ${last.at.toISOString()}::timestamptz)`,
            lastMessagePreview: last.preview,
          }
        : {}),
    })
    .where(eq(chats.id, chat.id));
}

async function quotedRef(db: Db, replyToId: string | null): Promise<QuotedRef | undefined> {
  if (!replyToId) return undefined;
  const [orig] = await db.select().from(messages).where(eq(messages.id, replyToId));
  if (!orig?.externalId) return undefined; // ponytail: replying to a note/failed message sends without quote
  return { externalId: orig.externalId, body: orig.body, fromMe: orig.direction === 'out' };
}

/** Evolution instance and WhatsApp address of a chat's contact; throws 'Contato sem telefone' with neither phone nor LID. */
export async function gatewayTarget(
  db: Db,
  chatId: string,
): Promise<{ instance: string; address: string; channelId: string; contactId: string }> {
  const [target] = await db
    .select({
      phone: contacts.phone,
      lid: contacts.lid,
      contactId: chats.contactId,
      channelId: chats.channelId,
      instance: channels.evolutionInstance,
    })
    .from(chats)
    .innerJoin(contacts, eq(contacts.id, chats.contactId))
    .innerJoin(channels, eq(channels.id, chats.channelId))
    .where(eq(chats.id, chatId));
  const address = waAddress(target);
  if (!target || !address) throw new Error('Contato sem telefone');
  return { instance: target.instance, address, channelId: target.channelId, contactId: target.contactId };
}

async function callGateway(ctx: AppCtx, msg: MessageRow): Promise<SendResult> {
  const { instance, address: to, channelId, contactId } = await gatewayTarget(ctx.db, msg.chatId);
  refreshAvatarInBackground(ctx, channelId, contactId); // every send (agent, resend, bot, triage) comes here
  const quoted = await quotedRef(ctx.db, msg.replyToId);

  if (msg.kind === 'text') return ctx.wa.sendText(instance, to, msg.body ?? '', quoted);

  if (!msg.mediaPath) throw new Error('Arquivo não encontrado');
  const base64 = (await readFile(join(ctx.config.mediaDir, msg.mediaPath))).toString('base64');
  if (msg.kind === 'audio') return ctx.wa.sendAudio(instance, to, base64, quoted);
  return ctx.wa.sendMedia(
    instance,
    to,
    {
      kind: msg.kind as 'image' | 'video' | 'document',
      base64,
      mime: msg.mediaMime ?? 'application/octet-stream',
      fileName: msg.mediaName ?? 'arquivo',
      ...(msg.body ? { caption: msg.body } : {}),
    },
    quoted,
  );
}

/** Spec §5.2 step 4: call Evolution; success → external_id + sent, failure → failed + error. */
async function deliver(ctx: AppCtx, msg: MessageRow): Promise<MessageDto> {
  let result: SendResult | null = null;
  let error: string | null = null;
  try {
    result = await callGateway(ctx, msg);
  } catch (err) {
    error = err instanceof Error && err.message ? err.message.slice(0, 200) : 'Falha ao enviar';
  }
  let updated: MessageRow;
  let echoDropped = false;
  if (result) {
    ({ row: updated, echoDropped } = await markSent(ctx.db, msg.id, msg.channelId, result.externalId));
  } else {
    const [row] = await ctx.db.update(messages).set({ status: 'failed', error }).where(eq(messages.id, msg.id)).returning();
    updated = row!;
  }
  await ctx.hub.publishMessage(msg.chatId, 'message.updated', msg.id);
  // ponytail: triage_pending needs no restore here: touchChat already set it (and waiting) false before the
  // gateway call, the same values the echo wrote. The echo's own message.created bubble stays on open clients
  // until the timeline is refetched; the contract has no message.removed event. Add one if that shows up in use.
  if (echoDropped) await ctx.hub.publishChat(msg.chatId);
  return toMessageDto(ctx.db, updated);
}

export interface SystemSendInput { text?: string; attachment?: BotAttachment | null; botRunId?: string | null }

/**
 * System send (triage, chatbot): an `out` message without author, signature or owner change. It does not touch
 * waiting/unread (`chat.waiting` is restored when a dropped echo cleared it); the caller publishes chat.updated.
 * An attachment is a file under config.mediaDir (bot library: 'bots/…'); `text` becomes its caption.
 * Returns ok = gateway accepted it, messageId = stored row (null when the contact has no address), echoDropped.
 */
export async function sendSystemMessage(
  ctx: AppCtx,
  chat: ChatRow,
  input: SystemSendInput,
): Promise<{ ok: boolean; messageId: string | null; echoDropped: boolean }> {
  const [contact] = await ctx.db
    .select({ phone: contacts.phone, lid: contacts.lid })
    .from(contacts)
    .where(eq(contacts.id, chat.contactId));
  if (!waAddress(contact)) return { ok: false, messageId: null, echoDropped: false };

  const attachment = input.attachment ?? null;
  const text = input.text || null;
  const kind: OutKind = attachment ? fileKind(attachment.mime, false) : 'text';
  const now = new Date();
  const row = await ctx.db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(messages)
      .values({
        id: randomUUID(),
        chatId: chat.id,
        channelId: chat.channelId,
        direction: 'out',
        kind,
        body: text,
        mediaPath: attachment?.path ?? null,
        mediaMime: attachment?.mime ?? null,
        mediaSize: attachment?.size ?? null,
        mediaName: attachment?.name ?? null,
        authorId: null,
        botRunId: input.botRunId ?? null,
        status: 'pending',
        sentAt: now,
        createdAt: now,
      })
      .returning();
    await tx
      .update(chats)
      .set({
        lastMessageAt: sql`greatest(${chats.lastMessageAt}, ${now.toISOString()}::timestamptz)`,
        lastMessagePreview: messagePreview(kind, text),
      })
      .where(eq(chats.id, chat.id));
    return inserted!;
  });
  await ctx.hub.publishMessage(chat.id, 'message.created', row.id);

  let result: SendResult | null = null;
  let error = 'Falha ao enviar';
  try {
    result = await callGateway(ctx, row);
  } catch (err) {
    if (err instanceof Error && err.message) error = err.message.slice(0, 200);
  }
  let echoDropped = false;
  if (result) {
    ({ echoDropped } = await markSent(ctx.db, row.id, chat.channelId, result.externalId));
    // The dropped echo's ingest (fromMe → out) cleared waiting; system messages never touch it.
    if (echoDropped) {
      await ctx.db.update(chats).set({ waiting: chat.waiting }).where(and(eq(chats.id, chat.id), eq(chats.state, 'open')));
    }
  } else {
    await ctx.db.update(messages).set({ status: 'failed', error }).where(eq(messages.id, row.id));
  }
  await ctx.hub.publishMessage(chat.id, 'message.updated', row.id);
  return { ok: result !== null, messageId: row.id, echoDropped };
}

export async function sendAgentMessage(ctx: AppCtx, user: AuthUser, chatId: string, input: SendInput): Promise<MessageDto> {
  const chat = await getChatForUser(ctx, user, chatId); // 404 also covers private chats of someone else
  if (chat.state !== 'open') throw conflict('Conversa finalizada');

  const file = input.file ?? null;
  const asVoice = !!input.asVoice && file !== null;
  if (file && asVoice && !baseMime(file.mime).startsWith('audio/')) throw badRequest('Áudio inválido');
  const text = asVoice ? null : input.text?.trim() || null;
  if (!text && !file) throw badRequest('Mensagem vazia');

  let replyToId: string | null = null;
  if (input.replyToId) {
    const [orig] = await ctx.db
      .select({ id: messages.id, deletedAt: messages.deletedAt })
      .from(messages)
      .where(and(eq(messages.id, input.replyToId), eq(messages.chatId, chatId)));
    if (!orig) throw badRequest('Mensagem citada não encontrada');
    if (orig.deletedAt) throw badRequest('Mensagem apagada não pode ser citada'); // spec §4
    replyToId = orig.id;
  }

  // Spec §5.5, after input validation and before anything is saved or sent: 'ask' → 409 BOT_RUNNING, 'stop' stops the bots.
  await applyBotRunningBehavior(ctx, user, chatId, input.botAction, 'agent_message');

  let body = text;
  if (text && input.signature) {
    const [sector] = await ctx.db.select({ name: sectors.name }).from(sectors).where(eq(sectors.id, chat.sectorId));
    body = formatSignature(text, signatureLabel(user, sector?.name ?? ''));
  }

  const kind: OutKind = file ? fileKind(file.mime, asVoice) : 'text';
  const media = file ? await saveMedia(ctx.config.mediaDir, file.buffer, file.mime, file.name) : null;
  const now = new Date();

  const row = await ctx.db.transaction(async (tx) => {
    await touchChat(tx, user, chat, { at: now, preview: messagePreview(kind, text) });
    const [inserted] = await tx
      .insert(messages)
      .values({
        id: randomUUID(),
        chatId,
        channelId: chat.channelId,
        direction: 'out',
        kind,
        body,
        mediaPath: media?.path ?? null,
        mediaMime: file?.mime ?? null,
        mediaSize: media?.size ?? null,
        mediaName: file?.name ?? null,
        authorId: user.id,
        replyToId,
        status: 'pending',
        sentAt: now,
      })
      .returning();
    return inserted!;
  });

  await ctx.hub.publishMessage(chatId, 'message.created', row.id);
  await ctx.hub.publishChat(chatId);
  return deliver(ctx, row);
}

export async function resendMessage(ctx: AppCtx, user: AuthUser, messageId: string): Promise<MessageDto> {
  const [msg] = await ctx.db.select().from(messages).where(eq(messages.id, messageId));
  if (!msg) throw notFound();
  const chat = await getChatForUser(ctx, user, msg.chatId);
  if (msg.direction !== 'out' || msg.kind === 'note' || msg.status !== 'failed') {
    throw conflict('Só mensagens com falha podem ser reenviadas');
  }
  if (chat.state !== 'open') throw conflict('Conversa finalizada');

  const row = await ctx.db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(messages)
      .set({ status: 'pending', error: null })
      .where(and(eq(messages.id, messageId), eq(messages.status, 'failed')))
      .returning();
    if (!claimed) throw conflict('Só mensagens com falha podem ser reenviadas');
    await touchChat(tx, user, chat);
    return claimed;
  });

  await ctx.hub.publishMessage(row.chatId, 'message.updated', row.id);
  await ctx.hub.publishChat(row.chatId);
  return deliver(ctx, row);
}

export async function addNote(ctx: AppCtx, user: AuthUser, chatId: string, text: string): Promise<MessageDto> {
  const chat = await getChatForUser(ctx, user, chatId);
  const body = text.trim();
  if (!body) throw badRequest('Nota vazia');
  const [row] = await ctx.db
    .insert(messages)
    .values({
      id: randomUUID(),
      chatId,
      channelId: chat.channelId,
      direction: 'out',
      kind: 'note',
      body,
      authorId: user.id,
      status: 'sent', // ponytail: notes never reach WhatsApp; 'sent' is just a non-pending value, UI hides ticks for notes
      sentAt: new Date(),
    })
    .returning();
  await ctx.hub.publishMessage(chatId, 'message.created', row!.id);
  return toMessageDto(ctx.db, row!);
}
