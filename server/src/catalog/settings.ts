import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  APPOINTMENT_LIMITS, CLOSE_INACTIVE_HOURS, DEFAULT_APPOINTMENT_REMINDERS, DEFAULT_AUTO_RULES, DEFAULT_RETURNING_CONTACT, REMINDER_UNITS,
  RETURN_TO_QUEUE_MINUTES, RETURNING_CONTACT_DAYS, SCHEDULE_TEXT_MAX, remindersProblem, type AppointmentRemindersDto, type AutoRulesDto,
  type BotRunningBehavior, type ReturningContactDto, type SettingsDto,
} from '@talk/shared';
import type { AppCtx } from '../ctx.js';
import type { Db, Tx } from '../db/client.js';
import { sectors, settings } from '../db/schema.js';
import { badRequest, forbidden } from '../lib/http-error.js';
import { getTriageMenu } from '../triage/triage.js';

const BotRunningBehaviorEnum = z.enum(['ask', 'stop', 'keep']);
const ReturningContactBody = z.object({
  enabled: z.boolean(),
  days: z.number().int().min(RETURNING_CONTACT_DAYS.min).max(RETURNING_CONTACT_DAYS.max),
});

const Body = z.object({
  closingMessage: z.string().trim().max(2000),
  triageMenu: z
    .object({
      enabled: z.boolean(),
      welcomeText: z.string().trim().max(2000),
      invalidText: z.string().trim().max(2000),
      options: z
        .array(z.object({ key: z.string().trim().min(1).max(10), label: z.string().trim().min(1).max(60), sectorId: z.uuid() }))
        .max(20),
    })
    .refine((m) => !m.enabled || m.options.length > 0, { error: 'O menu ativo precisa de pelo menos uma opção' })
    .refine((m) => new Set(m.options.map((o) => o.key.toLowerCase())).size === m.options.length, {
      error: 'Há opções com o mesmo número',
    }),
  // Spec §5.5. PUT replaces everything, so an omitted value resets to 'ask'; the web always PUTs the whole SettingsDto back.
  botRunningBehavior: BotRunningBehaviorEnum.default('ask'),
  // like botRunningBehavior: a body without it saves the default
  returningContact: ReturningContactBody.default(DEFAULT_RETURNING_CONTACT),
});

/** settings 'returning_contact' (Ajustes → Conversas "Cliente que volta"); on, 90 days, when the key is missing or invalid. */
export async function getReturningContact(db: Db | Tx): Promise<ReturningContactDto> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, 'returning_contact'));
  const parsed = ReturningContactBody.safeParse(row?.value);
  return parsed.success ? parsed.data : DEFAULT_RETURNING_CONTACT;
}

/** settings 'bot_running_behavior' (a jsonb string); 'ask' when the key is missing or holds anything else. */
export async function getBotRunningBehavior(db: Db | Tx): Promise<BotRunningBehavior> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, 'bot_running_behavior'));
  const parsed = BotRunningBehaviorEnum.safeParse(row?.value);
  return parsed.success ? parsed.data : 'ask';
}

const AutoRulesBody = z.object({
  returnToQueue: z.object({
    enabled: z.boolean(),
    minutes: z.number().int().min(RETURN_TO_QUEUE_MINUTES.min).max(RETURN_TO_QUEUE_MINUTES.max),
  }),
  closeInactive: z.object({
    enabled: z.boolean(),
    hours: z.number().int().min(CLOSE_INACTIVE_HOURS.min).max(CLOSE_INACTIVE_HOURS.max),
    sendClosingMessage: z.boolean(),
  }),
});

/** settings 'auto_rules' (spec 2026-10-20 agendamentos §4); the defaults (both off) when the key is missing or invalid. */
export async function getAutoRules(db: Db | Tx): Promise<AutoRulesDto> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, 'auto_rules'));
  const parsed = AutoRulesBody.safeParse(row?.value);
  return parsed.success ? parsed.data : DEFAULT_AUTO_RULES;
}

/**
 * Spec 2026-10-21 compromissos §3.2: 1 to 5 reminders, 1–30 days or 1–48 hours before, 1–4096 characters each. The create
 * route and the default reminders (§4) read the same list; the placeholder and same-time rules are remindersProblem.
 */
export const reminderList = z
  .array(
    z
      .object({ amount: z.number().int(), unit: z.enum(REMINDER_UNITS), text: z.string().trim().min(1).max(SCHEDULE_TEXT_MAX) })
      .refine((r) => r.amount >= APPOINTMENT_LIMITS[r.unit].min && r.amount <= APPOINTMENT_LIMITS[r.unit].max),
  )
  .min(1)
  .max(APPOINTMENT_LIMITS.remindersMax);

const AppointmentRemindersBody = z.object({ reminders: reminderList });

/** settings 'appointment_reminders' (spec 2026-10-21 compromissos §4); the defaults when the key is missing or invalid. */
export async function getAppointmentReminders(db: Db | Tx): Promise<AppointmentRemindersDto> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, 'appointment_reminders'));
  const parsed = AppointmentRemindersBody.safeParse(row?.value);
  return parsed.success && !remindersProblem(parsed.data.reminders, null) ? parsed.data : DEFAULT_APPOINTMENT_REMINDERS;
}

async function readSettings(db: Db): Promise<SettingsDto> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, 'closing_message'));
  return {
    closingMessage: typeof row?.value === 'string' ? row.value : '',
    triageMenu: await getTriageMenu(db),
    botRunningBehavior: await getBotRunningBehavior(db),
    returningContact: await getReturningContact(db),
  };
}

export function registerSettingsRoutes(app: FastifyInstance, ctx: AppCtx): void {
  app.get('/api/settings', async () => readSettings(ctx.db));

  // Own route (spec §5): PUT /api/settings replaces the whole SettingsDto and must never switch the rules off.
  app.get('/api/settings/auto-rules', async (req) => {
    if (req.user.role !== 'admin') throw forbidden();
    return getAutoRules(ctx.db);
  });

  app.put('/api/settings/auto-rules', async (req) => {
    if (req.user.role !== 'admin') throw forbidden();
    const value = AutoRulesBody.parse(req.body);
    await ctx.db
      .insert(settings)
      .values({ key: 'auto_rules', value })
      .onConflictDoUpdate({ target: settings.key, set: { value } });
    return getAutoRules(ctx.db);
  });

  // Spec 2026-10-21 compromissos §4 (decision 5): every user reads them (the form starts with them); only an admin saves them.
  // Changing them never changes saved appointments: each reminder keeps its own copy of the text.
  app.get('/api/settings/appointment-reminders', async () => getAppointmentReminders(ctx.db));

  app.put('/api/settings/appointment-reminders', async (req) => {
    if (req.user.role !== 'admin') throw forbidden();
    const value = AppointmentRemindersBody.parse(req.body);
    const problem = remindersProblem(value.reminders, null); // no contact here: {nome} is fine
    if (problem) throw badRequest(problem);
    await ctx.db
      .insert(settings)
      .values({ key: 'appointment_reminders', value })
      .onConflictDoUpdate({ target: settings.key, set: { value } });
    return getAppointmentReminders(ctx.db);
  });

  app.put('/api/settings', async (req) => {
    if (req.user.role !== 'admin') throw forbidden();
    const b = Body.parse(req.body);
    const sectorIds = [...new Set(b.triageMenu.options.map((o) => o.sectorId))];
    if (sectorIds.length && (await ctx.db.$count(sectors, inArray(sectors.id, sectorIds))) !== sectorIds.length) {
      throw badRequest('O menu de triagem aponta para um setor que não existe');
    }
    // Stored snake_case exactly as spec §4; triage/getTriageMenu reads it back.
    const triage = {
      enabled: b.triageMenu.enabled,
      welcome_text: b.triageMenu.welcomeText,
      invalid_text: b.triageMenu.invalidText,
      options: b.triageMenu.options.map((o) => ({ key: o.key, label: o.label, sector_id: o.sectorId })),
    };
    await ctx.db.transaction(async (tx) => {
      await tx
        .insert(settings)
        .values({ key: 'closing_message', value: b.closingMessage })
        .onConflictDoUpdate({ target: settings.key, set: { value: b.closingMessage } });
      await tx
        .insert(settings)
        .values({ key: 'triage_menu', value: triage })
        .onConflictDoUpdate({ target: settings.key, set: { value: triage } });
      await tx
        .insert(settings)
        .values({ key: 'bot_running_behavior', value: b.botRunningBehavior })
        .onConflictDoUpdate({ target: settings.key, set: { value: b.botRunningBehavior } });
      await tx
        .insert(settings)
        .values({ key: 'returning_contact', value: b.returningContact })
        .onConflictDoUpdate({ target: settings.key, set: { value: b.returningContact } });
    });
    return readSettings(ctx.db);
  });
}
