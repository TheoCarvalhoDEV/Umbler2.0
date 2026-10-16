// Message actions by an agent (spec 2026-10-16 §3–§7). Rules come from @talk/shared (the bubble menu uses the same).
// Delete and edit change our DB *before* calling Evolution and roll back on failure: the webhook echo of the call
// then finds the work done and changes nothing (ingest applyRevoke/applyEdit).
import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import {
  DELETED_REASON, RECENT_STICKERS_LIMIT, deleteBlock, editBlock, isSingleEmoji, reactBlock,
  type ActionBlock, type MessageDto, type MessageEditDto, type RecentStickerDto,
} from '@talk/shared';
import type { AppCtx } from '../ctx.js';
import { chats, messageEdits, messages, users } from '../db/schema.js';
import { getChatForUser, type ChatRow } from '../inbox/chats.js';
import { addEvent } from '../inbox/events.js';
import { visibleChatsWhere, type AuthUser } from '../inbox/visibility.js';
import { HttpError, badRequest, conflict, notFound } from '../lib/http-error.js';
import type { MessageKeyRef } from '../whatsapp/types.js';
import { toMessageDto } from './dto.js';
import { gatewayTarget } from './send.js';

type MessageRow = typeof messages.$inferSelect;

/** Spec §2: 404 unless canSee; never in a closed chat. Notes are refused by every rule. */
async function loadTarget(ctx: AppCtx, user: AuthUser, messageId: string): Promise<{ msg: MessageRow; chat: ChatRow }> {
  const [msg] = await ctx.db.select().from(messages).where(eq(messages.id, messageId));
  if (!msg) throw notFound();
  const chat = await getChatForUser(ctx, user, msg.chatId);
  if (chat.state !== 'open') throw conflict('Conversa finalizada');
  return { msg, chat };
}

const asTarget = (msg: MessageRow) => ({ ...msg, deleted: msg.deletedAt });

function refuse(block: ActionBlock | null): void {
  if (block) throw conflict(block.reason);
}

async function keyOf(ctx: AppCtx, msg: MessageRow): Promise<{ instance: string; key: MessageKeyRef }> {
  if (!msg.externalId) throw new Error('Mensagem sem id do WhatsApp'); // the rules already exclude notes and pending/failed
  const { instance, address } = await gatewayTarget(ctx.db, msg.chatId);
  return { instance, key: { address, externalId: msg.externalId, fromMe: msg.direction === 'out' } };
}

const WA_FAILED = {
  reaction: 'Não foi possível reagir no WhatsApp. Tente de novo.',
  delete: 'Não foi possível apagar no WhatsApp. Tente de novo.',
  edit: 'Não foi possível editar no WhatsApp. Tente de novo.',
} as const;

/** Any failure on the way to Evolution → 502 in pt-BR. The log has the message id and the error name, never text. */
async function viaWhatsApp(action: keyof typeof WA_FAILED, messageId: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    console.error(`message ${action} failed`, { messageId, err: err instanceof Error ? err.name : typeof err });
    throw new HttpError(502, WA_FAILED[action]);
  }
}

/** Spec §3: the office's own reaction (one per message, next to the contact's). '' or the same emoji again removes it. */
export async function reactToMessage(ctx: AppCtx, user: AuthUser, messageId: string, emoji: string): Promise<MessageDto> {
  if (emoji !== '' && !isSingleEmoji(emoji)) throw badRequest('Escolha um emoji');
  const { msg, chat } = await loadTarget(ctx, user, messageId);
  refuse(reactBlock(asTarget(msg)));
  const next = emoji === msg.officeReaction ? '' : emoji;
  await viaWhatsApp('reaction', msg.id, async () => {
    const { instance, key } = await keyOf(ctx, msg);
    await ctx.wa.sendReaction(instance, key, next);
  });
  // The echo (a fromMe reactionMessage) writes the same value into the same slot: harmless.
  const [row] = await ctx.db.update(messages).set({ officeReaction: next || null }).where(eq(messages.id, msg.id)).returning();
  await ctx.hub.publishMessage(chat.id, 'message.updated', msg.id);
  return toMessageDto(ctx.db, row!);
}

/** Spec §4: delete for everyone. The text stays visible to the team with "Apagada por <nome>". */
export async function deleteMessageForEveryone(ctx: AppCtx, user: AuthUser, messageId: string): Promise<MessageDto> {
  const { msg, chat } = await loadTarget(ctx, user, messageId);
  refuse(deleteBlock(asTarget(msg), Date.now()));
  // Claim first. A double click or a second agent gets 409; the MESSAGES_DELETE echo of this very call finds
  // deleted_at set and changes nothing.
  const [claimed] = await ctx.db
    .update(messages)
    .set({ deletedAt: new Date(), deletedBy: user.id, deletedSource: 'office' })
    .where(and(eq(messages.id, msg.id), isNull(messages.deletedAt)))
    .returning();
  if (!claimed) throw conflict(DELETED_REASON);
  try {
    await viaWhatsApp('delete', msg.id, async () => {
      const { instance, key } = await keyOf(ctx, msg);
      await ctx.wa.deleteForEveryone(instance, key);
    });
  } catch (err) {
    await ctx.db.update(messages).set({ deletedAt: null, deletedBy: null, deletedSource: null }).where(eq(messages.id, msg.id));
    throw err;
  }
  await addEvent(ctx.db, chat.id, 'message_deleted', { messageId: msg.id, source: 'office' }, user.id);
  await ctx.hub.publishMessage(chat.id, 'message.updated', msg.id);
  await ctx.hub.publishChat(chat.id); // an open timeline refetches on chat.updated and shows the event
  return toMessageDto(ctx.db, claimed);
}

/**
 * Spec §5: the author edits a text or caption within 15 min. The new text and the history row are saved first (so the
 * MESSAGES_UPDATE echo carries the body we already hold); a failed Evolution call puts both back.
 */
export async function editMessage(ctx: AppCtx, user: AuthUser, messageId: string, text: string): Promise<MessageDto> {
  const { msg, chat } = await loadTarget(ctx, user, messageId);
  refuse(editBlock(asTarget(msg), user.id, Date.now()));
  if (text === msg.body) return toMessageDto(ctx.db, msg); // nothing to change: no WhatsApp call, no history row

  const sameBody = msg.body === null ? isNull(messages.body) : eq(messages.body, msg.body);
  const edit = await ctx.db.transaction(async (tx) => {
    const [saved] = await tx
      .insert(messageEdits)
      .values({ messageId: msg.id, previousBody: msg.body, source: 'office', editedBy: user.id })
      .returning({ id: messageEdits.id, editedAt: messageEdits.editedAt });
    const [changed] = await tx
      .update(messages)
      .set({ body: text, editedAt: saved!.editedAt })
      .where(and(eq(messages.id, msg.id), isNull(messages.deletedAt), sameBody))
      .returning({ id: messages.id });
    // Someone (another tab, a webhook) changed it since we read it: the throw rolls the history row back too.
    if (!changed) throw conflict('A mensagem mudou. Recarregue e tente de novo.');
    return saved!;
  });
  try {
    await viaWhatsApp('edit', msg.id, async () => {
      const { instance, key } = await keyOf(ctx, msg);
      await ctx.wa.editText(instance, { ...key, fromMe: true }, text);
    });
  } catch (err) {
    await ctx.db.transaction(async (tx) => {
      await tx.delete(messageEdits).where(eq(messageEdits.id, edit.id));
      await tx.update(messages).set({ body: msg.body, editedAt: msg.editedAt }).where(eq(messages.id, msg.id));
    });
    throw err;
  }
  // ponytail: chats.last_message_preview keeps the old text when the last message is edited; refresh it if anyone notices.
  await addEvent(ctx.db, chat.id, 'message_edited', { messageId: msg.id, source: 'office' }, user.id);
  await ctx.hub.publishMessage(chat.id, 'message.updated', msg.id);
  await ctx.hub.publishChat(chat.id);
  const [row] = await ctx.db.select().from(messages).where(eq(messages.id, msg.id));
  return toMessageDto(ctx.db, row!);
}

/** GET /api/messages/:id/edits: the text before each edit, newest first. Reading is fine in a closed chat too. */
export async function listMessageEdits(ctx: AppCtx, user: AuthUser, messageId: string): Promise<MessageEditDto[]> {
  const [msg] = await ctx.db.select({ chatId: messages.chatId }).from(messages).where(eq(messages.id, messageId));
  if (!msg) throw notFound();
  await getChatForUser(ctx, user, msg.chatId);
  const rows = await ctx.db
    .select({
      id: messageEdits.id,
      previousBody: messageEdits.previousBody,
      source: messageEdits.source,
      editedByName: users.name,
      newTextUnavailable: messageEdits.newTextUnavailable,
      editedAt: messageEdits.editedAt,
    })
    .from(messageEdits)
    .leftJoin(users, eq(users.id, messageEdits.editedBy))
    .where(eq(messageEdits.messageId, messageId))
    .orderBy(desc(messageEdits.editedAt));
  return rows.map((r) => ({ ...r, editedByName: r.editedByName ?? null, editedAt: r.editedAt.toISOString() }));
}

/**
 * Spec §6: the newest stickers, received or sent, in the chats this user can see, with a saved file, one per file
 * content. Rows from before media_sha256 existed dedupe by file path only.
 */
export async function listRecentStickers(ctx: AppCtx, user: AuthUser): Promise<RecentStickerDto[]> {
  // ponytail: scans the newest 400 sticker rows and dedupes in memory; enough for one office, use DISTINCT ON if it grows.
  const rows = await ctx.db
    .select({ id: messages.id, sha256: messages.mediaSha256, path: messages.mediaPath })
    .from(messages)
    .innerJoin(chats, eq(chats.id, messages.chatId))
    .where(and(eq(messages.kind, 'sticker'), isNotNull(messages.mediaPath), isNull(messages.deletedAt), visibleChatsWhere(user)))
    .orderBy(desc(messages.sentAt), desc(messages.createdAt))
    .limit(400);
  const seen = new Set<string>();
  const out: RecentStickerDto[] = [];
  for (const r of rows) {
    const key = r.sha256 ?? `path:${r.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ messageId: r.id, url: `/api/media/${r.id}` });
    if (out.length === RECENT_STICKERS_LIMIT) break;
  }
  return out;
}
