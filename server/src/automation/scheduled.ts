// Spec 2026-10-20 agendamentos §3.1–3.2: schedule, list, edit and cancel. Sending is delivery.ts.
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, type SQL } from 'drizzle-orm';
import { scheduleTimeProblem, type ScheduledMessageDto, type ScheduledStatus, type ScheduledTab } from '@talk/shared';
import type { AppCtx } from '../ctx.js';
import type { Db } from '../db/client.js';
import { chats, contacts, messages, scheduledMessages, users } from '../db/schema.js';
import { getChatForUser } from '../inbox/chats.js';
import { addEvent } from '../inbox/events.js';
import type { AuthUser } from '../inbox/visibility.js';
import { badRequest, conflict, notFound } from '../lib/http-error.js';
import { saveMedia } from '../messages/media.js';

type ScheduledRow = typeof scheduledMessages.$inferSelect;

export const NOT_PENDING = 'Esta mensagem agendada não está mais pendente';
/** Still to go out: the chat's strip and the "Pendentes" tab show both. */
export const OPEN_STATUSES: ScheduledStatus[] = ['pending', 'sending'];
// ponytail: one page of 100 per tab, no cursor; add keyset paging on (send_at, id) if an office ever keeps more.
const LIST_LIMIT = 100;

export interface ScheduleInput { text: string; sendAt: Date; signature: boolean; file?: { buffer: Buffer; mime: string; name: string } }

/** The author or any admin (spec 2026-10-20 agendamentos §3.2); appointments use the same rule (spec 2026-10-21 compromissos §3.3). */
export const canManage = (user: AuthUser, row: { authorId: string }) => row.authorId === user.id || user.role === 'admin';

/** The rows `where` picks, with the chat's contact, the author's name and the chat the sent message went to. */
async function scheduledDtos(db: Db, user: AuthUser, where: SQL | undefined, order: SQL[]): Promise<ScheduledMessageDto[]> {
  const rows = await db
    .select({
      s: scheduledMessages, contactId: contacts.id, contactName: contacts.name, contactPhone: contacts.phone,
      authorName: users.name, sentChatId: messages.chatId,
    })
    .from(scheduledMessages)
    .innerJoin(chats, eq(chats.id, scheduledMessages.chatId))
    .innerJoin(contacts, eq(contacts.id, chats.contactId))
    .innerJoin(users, eq(users.id, scheduledMessages.authorId))
    .leftJoin(messages, eq(messages.id, scheduledMessages.messageId))
    .where(where)
    .orderBy(...order)
    .limit(LIST_LIMIT);
  return rows.map(({ s, ...r }) => ({
    id: s.id,
    chatId: s.chatId,
    contact: { id: r.contactId, name: r.contactName, phone: r.contactPhone },
    authorId: s.authorId,
    authorName: r.authorName,
    body: s.body,
    signature: s.signature,
    attachment: s.mediaPath
      ? { name: s.mediaName ?? 'arquivo', mime: s.mediaMime ?? 'application/octet-stream', size: s.mediaSize ?? 0 }
      : null,
    sendAt: s.sendAt.toISOString(),
    status: s.status,
    error: s.error,
    messageId: s.messageId,
    sentChatId: r.sentChatId,
    createdAt: s.createdAt.toISOString(),
    finishedAt: s.finishedAt?.toISOString() ?? null,
    canEdit: s.status === 'pending' && canManage(user, s),
  }));
}

async function dtoOf(db: Db, user: AuthUser, id: string): Promise<ScheduledMessageDto> {
  const [dto] = await scheduledDtos(db, user, eq(scheduledMessages.id, id), [asc(scheduledMessages.id)]);
  if (!dto) throw notFound();
  return dto;
}

/** The author's or an admin's pending row; 404 for anyone else (it reveals nothing), 409 once it left 'pending'. */
async function pendingRowFor(ctx: AppCtx, user: AuthUser, id: string): Promise<ScheduledRow> {
  const [row] = await ctx.db.select().from(scheduledMessages).where(eq(scheduledMessages.id, id));
  if (!row || !canManage(user, row)) throw notFound();
  if (row.status !== 'pending') throw conflict(NOT_PENDING);
  return row;
}

export async function createScheduled(ctx: AppCtx, user: AuthUser, chatId: string, input: ScheduleInput): Promise<ScheduledMessageDto> {
  const chat = await getChatForUser(ctx, user, chatId);
  if (chat.state !== 'open') throw conflict('Conversa finalizada');
  const problem = scheduleTimeProblem(input.sendAt, ctx.botRuntime.now());
  if (problem) throw badRequest(problem);
  // spec §3.1: the file is stored now, not at send time
  const saved = input.file ? await saveMedia(ctx.config.mediaDir, input.file.buffer, input.file.mime, input.file.name) : null;
  const id = randomUUID();
  // Only `tx` inside (PGlite serializes transactions; ctx.db here would deadlock).
  await ctx.db.transaction(async (tx) => {
    await tx.insert(scheduledMessages).values({
      id, chatId, authorId: user.id, body: input.text, signature: input.signature, sendAt: input.sendAt,
      mediaPath: saved?.path ?? null, mediaMime: input.file?.mime ?? null, mediaName: input.file?.name ?? null,
      mediaSize: saved?.size ?? null, mediaSha256: saved?.sha256 ?? null,
    });
    await addEvent(tx, chatId, 'message_scheduled', { scheduledId: id, sendAt: input.sendAt.toISOString() }, user.id);
  });
  await ctx.hub.publishChat(chatId); // open screens refetch the timeline and the strip
  return dtoOf(ctx.db, user, id);
}

/** Spec §3.2: the chat's strip — everyone who sees the chat, pending (and being sent), next first. */
export async function listChatScheduled(ctx: AppCtx, user: AuthUser, chatId: string): Promise<ScheduledMessageDto[]> {
  await getChatForUser(ctx, user, chatId);
  return scheduledDtos(
    ctx.db,
    user,
    and(eq(scheduledMessages.chatId, chatId), inArray(scheduledMessages.status, OPEN_STATUSES)),
    [asc(scheduledMessages.sendAt), asc(scheduledMessages.id)],
  );
}

/** Spec §3.2: "Agendamentos" — mine (an admin: everyone's); pending next first, the other tabs newest first. */
export async function listScheduled(ctx: AppCtx, user: AuthUser, tab: ScheduledTab): Promise<ScheduledMessageDto[]> {
  const status = tab === 'pending' ? inArray(scheduledMessages.status, OPEN_STATUSES) : eq(scheduledMessages.status, tab);
  const mine = user.role === 'admin' ? undefined : eq(scheduledMessages.authorId, user.id);
  const order = tab === 'pending'
    ? [asc(scheduledMessages.sendAt), asc(scheduledMessages.id)]
    : [desc(scheduledMessages.sendAt), desc(scheduledMessages.id)];
  return scheduledDtos(ctx.db, user, and(status, mine), order);
}

export async function updateScheduled(
  ctx: AppCtx,
  user: AuthUser,
  id: string,
  patch: { text?: string; sendAt?: Date },
): Promise<ScheduledMessageDto> {
  const row = await pendingRowFor(ctx, user, id);
  if (patch.sendAt) {
    const problem = scheduleTimeProblem(patch.sendAt, ctx.botRuntime.now());
    if (problem) throw badRequest(problem);
  }
  await ctx.db.transaction(async (tx) => {
    const [updated] = await tx
      .update(scheduledMessages)
      .set({ ...(patch.text !== undefined ? { body: patch.text } : {}), ...(patch.sendAt ? { sendAt: patch.sendAt } : {}) })
      .where(and(eq(scheduledMessages.id, id), eq(scheduledMessages.status, 'pending'))) // the worker may have claimed it
      .returning({ id: scheduledMessages.id });
    if (!updated) throw conflict(NOT_PENDING);
    if (patch.sendAt && patch.sendAt.getTime() !== row.sendAt.getTime()) {
      await addEvent(tx, row.chatId, 'message_scheduled', { scheduledId: id, sendAt: patch.sendAt.toISOString(), edited: true }, user.id);
    }
  });
  await ctx.hub.publishChat(row.chatId);
  return dtoOf(ctx.db, user, id);
}

// ponytail: a cancelled row keeps its file until the chat (or channel) is deleted, which removes the files of its scheduled rows; delete it here instead if disk use matters.
export async function cancelScheduled(ctx: AppCtx, user: AuthUser, id: string): Promise<ScheduledMessageDto> {
  const row = await pendingRowFor(ctx, user, id);
  await ctx.db.transaction(async (tx) => {
    const [updated] = await tx
      .update(scheduledMessages)
      .set({ status: 'canceled', finishedAt: ctx.botRuntime.now() })
      .where(and(eq(scheduledMessages.id, id), eq(scheduledMessages.status, 'pending')))
      .returning({ id: scheduledMessages.id });
    if (!updated) throw conflict(NOT_PENDING);
    await addEvent(tx, row.chatId, 'scheduled_canceled', { scheduledId: id }, user.id);
  });
  await ctx.hub.publishChat(row.chatId);
  return dtoOf(ctx.db, user, id);
}
