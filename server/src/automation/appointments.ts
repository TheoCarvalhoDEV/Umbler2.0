// Spec 2026-10-21 compromissos §3: an appointment and its reminders. Each reminder that can still go out is an ordinary
// scheduled message (scheduled_messages.reminder_id), sent by delivery.ts like any other. This module only creates,
// moves in place, deletes (pending only) and cancels those rows, always with status = 'pending' in the WHERE.
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  appointmentTimeProblem, fillReminderText, reminderSendAt, remindersProblem, scheduleTimeProblem, type AppointmentDto,
  type AppointmentTab, type ReminderInput,
} from '@talk/shared';
import type { AppCtx } from '../ctx.js';
import type { Db } from '../db/client.js';
import { appointmentReminders, appointments, chats, contacts, scheduledMessages, users } from '../db/schema.js';
import { getChatForUser, type ChatRow } from '../inbox/chats.js';
import { addEvent } from '../inbox/events.js';
import { canSee, visibleChatsWhere, type AuthUser } from '../inbox/visibility.js';
import { badRequest, notFound } from '../lib/http-error.js';
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
