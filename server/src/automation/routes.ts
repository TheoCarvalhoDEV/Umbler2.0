import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { APPOINTMENT_LIMITS, APPOINTMENT_PRESETS, APPOINTMENT_STATUSES, APPOINTMENT_TABS, SCHEDULE_TEXT_MAX, SCHEDULED_TABS } from '@talk/shared';
import { reminderList } from '../catalog/settings.js';
import { readParts } from '../chats/routes.js';
import type { AppCtx } from '../ctx.js';
import { cancelAppointment, createAppointment, listAppointments, listChatAppointments, setAppointmentStatus, updateAppointment } from './appointments.js';
import { cancelScheduled, createScheduled, listChatScheduled, listScheduled, updateScheduled } from './scheduled.js';

const idParams = z.object({ id: z.uuid() });
const text = z.string().trim().min(1).max(SCHEDULE_TEXT_MAX);
const sendAt = z.iso.datetime({ offset: true });
const createJson = z.object({ text, sendAt, signature: z.boolean().default(true) });
/** Multipart: the same fields, before the one file (same limits as a send). */
const createFields = z.object({ text, sendAt, signature: z.stringbool().default(true) });
const patchBody = z
  .object({ text: text.optional(), sendAt: sendAt.optional() })
  .refine((b) => b.text !== undefined || b.sendAt !== undefined, 'Nada para alterar');
const listQuery = z.object({ status: z.enum(SCHEDULED_TABS).default('pending') });
const appointmentTitle = z.string().trim().min(1).max(APPOINTMENT_LIMITS.titleMax);
const appointmentNote = z.string().trim().max(APPOINTMENT_LIMITS.noteMax);
/** Spec 2026-10-21 compromissos §5.3: exactly one of chatId / contactId. */
const appointmentBody = z
  .object({
    chatId: z.uuid().optional(),
    contactId: z.uuid().optional(),
    title: appointmentTitle,
    startsAt: sendAt, // the same ISO instant with an offset
    note: appointmentNote.optional(),
    signature: z.boolean().default(true), // "Enviar com minha assinatura" (§3.1)
    reminders: reminderList,
  })
  .refine((b) => (b.chatId === undefined) !== (b.contactId === undefined), 'Escolha o cliente');
const appointmentQuery = z.object({
  tab: z.enum(APPOINTMENT_TABS).default('upcoming'),
  from: sendAt.optional(),
  to: sendAt.optional(),
  authorId: z.uuid().optional(),
  sectorId: z.uuid().optional(),
  status: z.enum(APPOINTMENT_STATUSES).optional(),
  preset: z.enum(APPOINTMENT_PRESETS).optional(),
  q: z.string().trim().max(80).optional(),
});
/** Spec §3.3: title, time and note only (decision 3); null or "" clears the note. */
const appointmentPatch = z
  .object({ title: appointmentTitle.optional(), startsAt: sendAt.optional(), note: appointmentNote.nullable().optional() })
  .refine((b) => b.title !== undefined || b.startsAt !== undefined || b.note !== undefined, 'Nada para alterar');

/** Spec 2026-10-20 agendamentos §5. */
export function registerAutomationRoutes(app: FastifyInstance, ctx: AppCtx): void {
  app.post('/api/chats/:id/scheduled-messages', async (req) => {
    const { id } = idParams.parse(req.params);
    if (req.isMultipart()) {
      const { fields, file } = await readParts(req);
      const f = createFields.parse(fields);
      return createScheduled(ctx, req.user, id, { text: f.text, sendAt: new Date(f.sendAt), signature: f.signature, file });
    }
    const b = createJson.parse(req.body);
    return createScheduled(ctx, req.user, id, { text: b.text, sendAt: new Date(b.sendAt), signature: b.signature });
  });

  app.get('/api/chats/:id/scheduled-messages', async (req) => listChatScheduled(ctx, req.user, idParams.parse(req.params).id));

  app.get('/api/scheduled-messages', async (req) => listScheduled(ctx, req.user, listQuery.parse(req.query).status));

  app.patch('/api/scheduled-messages/:id', async (req) => {
    const { id } = idParams.parse(req.params);
    const b = patchBody.parse(req.body);
    return updateScheduled(ctx, req.user, id, { text: b.text, sendAt: b.sendAt ? new Date(b.sendAt) : undefined });
  });

  app.post('/api/scheduled-messages/:id/cancel', async (req) => cancelScheduled(ctx, req.user, idParams.parse(req.params).id));

  // Spec 2026-10-21 compromissos §5.3.
  app.post('/api/appointments', async (req) => {
    const b = appointmentBody.parse(req.body);
    return createAppointment(ctx, req.user, { ...b, startsAt: new Date(b.startsAt), note: b.note || null });
  });

  app.get('/api/chats/:id/appointments', async (req) => listChatAppointments(ctx, req.user, idParams.parse(req.params).id));

  app.get('/api/appointments', async (req) => {
    const q = appointmentQuery.parse(req.query);
    return listAppointments(ctx, req.user, { ...q, from: q.from ? new Date(q.from) : undefined, to: q.to ? new Date(q.to) : undefined, q: q.q || undefined });
  });

  app.patch('/api/appointments/:id', async (req) => {
    const { id } = idParams.parse(req.params);
    const b = appointmentPatch.parse(req.body);
    return updateAppointment(ctx, req.user, id, {
      title: b.title,
      startsAt: b.startsAt ? new Date(b.startsAt) : undefined,
      note: b.note === undefined ? undefined : b.note || null,
    });
  });

  app.post('/api/appointments/:id/cancel', async (req) => cancelAppointment(ctx, req.user, idParams.parse(req.params).id));

  app.post('/api/appointments/:id/status', async (req) =>
    setAppointmentStatus(ctx, req.user, idParams.parse(req.params).id, z.object({ status: z.enum(APPOINTMENT_STATUSES) }).parse(req.body).status));
}
