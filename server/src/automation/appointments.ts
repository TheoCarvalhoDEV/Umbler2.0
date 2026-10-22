// Spec 2026-10-21 compromissos §3: an appointment and its reminders. Each reminder that can still go out is an ordinary
// scheduled message (scheduled_messages.reminder_id), sent by delivery.ts like any other. This module only creates,
// moves in place, deletes (pending only) and cancels those rows, always with status = 'pending' in the WHERE.
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  appointmentTimeProblem, fillReminderText, reminderSendAt, reminderTextProblem, remindersProblem, scheduleTimeProblem,
  type AppointmentDto, type AppointmentTab, type ReminderInput,
} from '@talk/shared';
import type { AppCtx } from '../ctx.js';
import type { Db, Tx } from '../db/client.js';
import { appointmentReminders, appointments, chats, contacts, scheduledMessages, users } from '../db/schema.js';
import { getChatForUser, type ChatRow } from '../inbox/chats.js';
import { addEvent } from '../inbox/events.js';
import { canSee, visibleChatsWhere, type AuthUser } from '../inbox/visibility.js';
import { badRequest, conflict, notFound } from '../lib/http-error.js';
import { canManage } from './scheduled.js';

export const NO_CHAT_WITH_CONTACT = 'Você não tem conversa com este contato; comece uma em Nova conversa';
// ponytail: one page of 100 per tab, no cursor (spec §10); add keyset paging on (starts_at, id) if an office ever keeps more.
const LIST_LIMIT = 100;

/** POST /api/appointments; the route makes sure exactly one of chatId / contactId is set. */
export interface AppointmentInput {
  chatId?: string; contactId?: string; title: string; startsAt: Date; note: string | null; signature: boolean; reminders: ReminderInput[];
}

const canceler = alias(users, 'canceler');

/** The appointments `where` picks (over appointments ⋈ chats), with the contact, the names and each reminder's situation. */
async function appointmentDtos(db: Db, user: AuthUser, where: SQL | undefined, order: SQL[]): Promise<AppointmentDto[]> {
  const rows = await db
    .select({
      a: appointments,
      chat: { sectorId: chats.sectorId, ownerId: chats.ownerId, private: chats.private, history: chats.history },
      contactId: contacts.id, contactName: contacts.name, contactPhone: contacts.phone,
      authorName: users.name, canceledByName: canceler.name,
    })
    .from(appointments)
    .innerJoin(chats, eq(chats.id, appointments.chatId))
    .innerJoin(contacts, eq(contacts.id, chats.contactId))
    .innerJoin(users, eq(users.id, appointments.authorId))
    .leftJoin(canceler, eq(canceler.id, appointments.canceledBy))
    .where(where)
    .orderBy(...order)
    .limit(LIST_LIMIT);
  if (rows.length === 0) return [];
  // a reminder without a scheduled message is "Não criado" ('skipped')
  const reminders = await db
    .select({
      r: appointmentReminders, scheduledId: scheduledMessages.id, sendAt: scheduledMessages.sendAt,
      status: scheduledMessages.status, error: scheduledMessages.error,
    })
    .from(appointmentReminders)
    .leftJoin(scheduledMessages, eq(scheduledMessages.reminderId, appointmentReminders.id))
    .where(inArray(appointmentReminders.appointmentId, rows.map((row) => row.a.id)));
  return rows.map(({ a, chat, ...r }) => ({
    id: a.id,
    chatId: a.chatId,
    contact: { id: r.contactId, name: r.contactName, phone: r.contactPhone },
    authorId: a.authorId,
    authorName: r.authorName,
    title: a.title,
    startsAt: a.startsAt.toISOString(),
    note: a.note,
    canceledAt: a.canceledAt?.toISOString() ?? null,
    canceledByName: r.canceledByName,
    createdAt: a.createdAt.toISOString(),
    reminders: reminders
      .filter((x) => x.r.appointmentId === a.id)
      .map((x) => ({
        id: x.r.id,
        amount: x.r.amount,
        unit: x.r.unit,
        text: x.r.text,
        sendAt: (x.sendAt ?? reminderSendAt(a.startsAt, x.r.amount, x.r.unit)).toISOString(),
        status: x.status ?? ('skipped' as const),
        scheduledId: x.scheduledId,
        error: x.error,
      }))
      .sort((p, q) => p.sendAt.localeCompare(q.sendAt)),
    // decision: also needs the chat, like every write (spec §2)
    canEdit: !a.canceledAt && canManage(user, a) && canSee(user, chat),
  }));
}

async function dtoOf(db: Db, user: AuthUser, id: string): Promise<AppointmentDto> {
  const [dto] = await appointmentDtos(db, user, eq(appointments.id, id), [asc(appointments.id)]);
  if (!dto) throw notFound();
  return dto;
}

async function contactNameOf(db: Db, contactId: string): Promise<string | null> {
  const [c] = await db.select({ name: contacts.name }).from(contacts).where(eq(contacts.id, contactId));
  return c?.name?.trim() || null;
}

/** The text a reminder's scheduled message carries: the placeholders filled now (spec §3.2), never at send time. */
function filled(text: string, a: { title: string; startsAt: Date }, name: string | null): string {
  return fillReminderText(text, { nome: name ?? '', titulo: a.title, startsAt: a.startsAt.toISOString() });
}

/** Spec §3.1 (decision 8): the contact's open chat the user sees, else their newest one the user sees; none → 400. */
async function chatForContact(ctx: AppCtx, user: AuthUser, contactId: string): Promise<ChatRow> {
  const [contact] = await ctx.db.select({ id: contacts.id }).from(contacts).where(eq(contacts.id, contactId));
  if (!contact) throw notFound('Contato não encontrado.');
  const [chat] = await ctx.db
    .select()
    .from(chats)
    .where(and(eq(chats.contactId, contactId), visibleChatsWhere(user)))
    .orderBy(desc(eq(chats.state, 'open')), desc(chats.createdAt), desc(chats.id))
    .limit(1);
  if (!chat) throw badRequest(NO_CHAT_WITH_CONTACT);
  return chat;
}

/** Spec §3.1–3.2: the appointment, its reminders, a scheduled message per reminder that can still go out, and the event. */
export async function createAppointment(ctx: AppCtx, user: AuthUser, input: AppointmentInput): Promise<AppointmentDto> {
  const chat = input.chatId ? await getChatForUser(ctx, user, input.chatId) : await chatForContact(ctx, user, input.contactId!);
  const now = ctx.botRuntime.now();
  const name = await contactNameOf(ctx.db, chat.contactId);
  const problem = appointmentTimeProblem(input.startsAt, now) ?? remindersProblem(input.reminders, input.startsAt, name);
  if (problem) throw badRequest(problem);
  const id = randomUUID();
  // Only `tx` inside (PGlite serializes transactions; ctx.db here would deadlock).
  await ctx.db.transaction(async (tx) => {
    await tx.insert(appointments).values({
      id, chatId: chat.id, authorId: user.id, title: input.title, startsAt: input.startsAt, note: input.note, signature: input.signature,
    });
    const reminders = await tx
      .insert(appointmentReminders)
      .values(input.reminders.map((r) => ({ appointmentId: id, amount: r.amount, unit: r.unit, text: r.text })))
      .returning();
    for (const r of reminders) {
      const sendAt = reminderSendAt(input.startsAt, r.amount, r.unit);
      if (scheduleTimeProblem(sendAt, now)) continue; // "Não criado": saved without a scheduled message
      await tx.insert(scheduledMessages).values({
        chatId: chat.id, authorId: user.id, body: filled(r.text, input, name), signature: input.signature, sendAt, reminderId: r.id,
      });
    }
    await addEvent(tx, chat.id, 'appointment_scheduled', { appointmentId: id, title: input.title, startsAt: input.startsAt.toISOString() }, user.id);
  });
  await ctx.hub.publishChat(chat.id); // open screens refetch the timeline, the strip and the appointments
  return dtoOf(ctx.db, user, id);
}

/** Spec §3.4: the contact's upcoming appointments, in every chat of theirs the user sees, next first. */
export async function listChatAppointments(ctx: AppCtx, user: AuthUser, chatId: string): Promise<AppointmentDto[]> {
  const chat = await getChatForUser(ctx, user, chatId);
  return appointmentDtos(
    ctx.db,
    user,
    and(eq(chats.contactId, chat.contactId), visibleChatsWhere(user), isNull(appointments.canceledAt), gte(appointments.startsAt, ctx.botRuntime.now())),
    [asc(appointments.startsAt), asc(appointments.id)],
  );
}

/** Spec §3.5: the Agenda's "Compromissos": mine (an admin: everyone's); Próximos next first, the other tabs newest first. */
export async function listAppointments(ctx: AppCtx, user: AuthUser, tab: AppointmentTab): Promise<AppointmentDto[]> {
  const now = ctx.botRuntime.now();
  const mine = user.role === 'admin' ? undefined : eq(appointments.authorId, user.id);
  const when =
    tab === 'canceled'
      ? isNotNull(appointments.canceledAt)
      : and(isNull(appointments.canceledAt), tab === 'upcoming' ? gte(appointments.startsAt, now) : lt(appointments.startsAt, now));
  const order =
    tab === 'upcoming' ? [asc(appointments.startsAt), asc(appointments.id)] : [desc(appointments.startsAt), desc(appointments.id)];
  return appointmentDtos(ctx.db, user, and(when, mine), order);
}

export const APPOINTMENT_CANCELED = 'Este compromisso foi cancelado';

type AppointmentRow = typeof appointments.$inferSelect;

/** The author's or an admin's appointment, in a chat they see (spec §2, §3.3): 404 for anyone else, 409 once cancelled. Returns its contact. */
async function manageableContact(ctx: AppCtx, user: AuthUser, id: string): Promise<string> {
  const [row] = await ctx.db
    .select({ a: appointments, chat: chats })
    .from(appointments)
    .innerJoin(chats, eq(chats.id, appointments.chatId))
    .where(eq(appointments.id, id));
  if (!row || !canManage(user, row.a) || !canSee(user, row.chat)) throw notFound();
  if (row.a.canceledAt) throw conflict(APPOINTMENT_CANCELED);
  return row.chat.contactId;
}

/**
 * Spec §3.3, decision 2: each reminder follows the new time and title, in place.
 * - A pending row is moved, or deleted when its new time no longer fits. A time that did not move is kept, even under
 *   2 minutes away.
 * - A "Não criado" reminder gets a row once its time fits.
 * - A row the worker already took (sending, sent, failed) is left alone, before anything else is checked.
 * The worker can claim a row between the read above and the write below. Every update and delete re-checks status = 'pending',
 * so such a row goes out as it was and is never created again. That race cannot be reproduced in PGlite (one connection),
 * so only this WHERE guard covers it.
 */
async function recalcReminders(tx: Tx, a: AppointmentRow, name: string | null, now: Date): Promise<void> {
  const rows = await tx
    .select({ r: appointmentReminders, scheduledId: scheduledMessages.id, status: scheduledMessages.status, sendAt: scheduledMessages.sendAt })
    .from(appointmentReminders)
    .leftJoin(scheduledMessages, eq(scheduledMessages.reminderId, appointmentReminders.id))
    .where(eq(appointmentReminders.appointmentId, a.id));
  for (const { r, scheduledId, status, sendAt: oldSendAt } of rows) {
    if (scheduledId && status !== 'pending') continue; // out or going out: history, and it must not block the edit
    const sendAt = reminderSendAt(a.startsAt, r.amount, r.unit);
    const fits = !scheduleTimeProblem(sendAt, now);
    const stillPending = scheduledId ? and(eq(scheduledMessages.id, scheduledId), eq(scheduledMessages.status, 'pending')) : undefined;
    const write = fits || (!!scheduledId && sendAt.getTime() === oldSendAt!.getTime());
    if (!write) {
      if (stillPending) await tx.delete(scheduledMessages).where(stillPending); // back to "Não criado"; nothing points at a row that never went out
      continue;
    }
    const problem = reminderTextProblem(r.text, name); // only what will be written needs the name (decision 6)
    if (problem) throw badRequest(problem);
    const body = filled(r.text, a, name);
    // decision 9: the appointment's author and signature, also when an admin edits
    if (!stillPending) await tx.insert(scheduledMessages).values({ chatId: a.chatId, authorId: a.authorId, body, signature: a.signature, sendAt, reminderId: r.id });
    else await tx.update(scheduledMessages).set({ sendAt, body }).where(stillPending);
  }
}

/** Spec §3.3: title, time and note. A kept time is not checked again; only a note change recalculates nothing and records nothing. */
export async function updateAppointment(
  ctx: AppCtx,
  user: AuthUser,
  id: string,
  patch: { title?: string; startsAt?: Date; note?: string | null },
): Promise<AppointmentDto> {
  const contactId = await manageableContact(ctx, user, id);
  const now = ctx.botRuntime.now();
  const name = await contactNameOf(ctx.db, contactId);
  // Only `tx` inside (PGlite serializes transactions; ctx.db here would deadlock).
  const chatId = await ctx.db.transaction(async (tx) => {
    // the lock makes two edits (or an edit and a cancel) of the same appointment take turns; everything below reads this row
    const [locked] = await tx.select().from(appointments).where(eq(appointments.id, id)).for('update');
    if (!locked) throw notFound();
    if (locked.canceledAt) throw conflict(APPOINTMENT_CANCELED);
    const title = patch.title ?? locked.title;
    const startsAt = patch.startsAt ?? locked.startsAt;
    const moved = startsAt.getTime() !== locked.startsAt.getTime();
    if (moved) {
      const problem = appointmentTimeProblem(startsAt, now);
      if (problem) throw badRequest(problem);
    }
    await tx
      .update(appointments)
      .set({ title, startsAt, ...(patch.note !== undefined ? { note: patch.note } : {}) })
      .where(eq(appointments.id, id));
    if (moved || title !== locked.title) await recalcReminders(tx, { ...locked, title, startsAt }, name, now);
    if (moved) {
      await addEvent(tx, locked.chatId, 'appointment_scheduled', { appointmentId: id, title, startsAt: startsAt.toISOString(), edited: true }, user.id);
    }
    return locked.chatId;
  });
  await ctx.hub.publishChat(chatId);
  return dtoOf(ctx.db, user, id);
}

/** Spec §3.3: the pending reminders go to "Agenda → Canceladas"; the ones already out stay; one being sent right now goes out. */
export async function cancelAppointment(ctx: AppCtx, user: AuthUser, id: string): Promise<AppointmentDto> {
  await manageableContact(ctx, user, id);
  const now = ctx.botRuntime.now();
  const chatId = await ctx.db.transaction(async (tx) => {
    const [a] = await tx
      .update(appointments)
      .set({ canceledAt: now, canceledBy: user.id })
      .where(and(eq(appointments.id, id), isNull(appointments.canceledAt)))
      .returning();
    if (!a) throw conflict(APPOINTMENT_CANCELED);
    const reminderIds = tx.select({ id: appointmentReminders.id }).from(appointmentReminders).where(eq(appointmentReminders.appointmentId, id));
    await tx
      .update(scheduledMessages)
      .set({ status: 'canceled', finishedAt: now })
      .where(and(inArray(scheduledMessages.reminderId, reminderIds), eq(scheduledMessages.status, 'pending')));
    await addEvent(tx, a.chatId, 'appointment_canceled', { appointmentId: id, title: a.title }, user.id);
    return a.chatId;
  });
  await ctx.hub.publishChat(chatId);
  return dtoOf(ctx.db, user, id);
}
