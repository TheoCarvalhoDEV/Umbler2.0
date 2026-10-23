// Scheduled messages and automatic rules (spec 2026-10-20 agendamentos §2–§4). Runtime values with no imports: tsx
// (server) and Vite (web) load this source directly.

/** Every scheduled time is typed and shown in the office's zone, whatever the computer's zone is (spec §2). */
export const OFFICE_TIMEZONE = 'America/Cuiaba';
export const SCHEDULE_MIN_LEAD_MS = 2 * 60_000;
export const SCHEDULE_MAX_AHEAD_MS = 365 * 24 * 60 * 60_000;
export const SCHEDULE_TEXT_MAX = 4096;

export const SCHEDULED_STATUSES = ['pending', 'sending', 'sent', 'failed', 'canceled'] as const;
export type ScheduledStatus = (typeof SCHEDULED_STATUSES)[number];
/** The "Agendamentos" tabs; 'pending' also lists the rows being sent right now. */
export const SCHEDULED_TABS = ['pending', 'sent', 'failed', 'canceled'] as const;
export type ScheduledTab = (typeof SCHEDULED_TABS)[number];

/** The pt-BR reason a time cannot be scheduled, or null. The web and the server run this same check (spec §3.1). */
export function scheduleTimeProblem(sendAt: Date | null, now: Date): string | null {
  if (!sendAt || Number.isNaN(sendAt.getTime())) return 'Escolha a data e a hora';
  if (sendAt.getTime() < now.getTime() + SCHEDULE_MIN_LEAD_MS) return 'Escolha um horário pelo menos 2 minutos à frente';
  if (sendAt.getTime() > now.getTime() + SCHEDULE_MAX_AHEAD_MS) return 'Escolha um horário em até 1 ano';
  return null;
}

const WALL = new Intl.DateTimeFormat('en-US', {
  timeZone: OFFICE_TIMEZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});
const wallParts = (d: Date) => Object.fromEntries(WALL.formatToParts(d).map((p) => [p.type, p.value])) as Record<string, string>;

/** Office wall time minus UTC at `d`, in ms (Cuiabá today: -4 h). Read from Intl, so no DST rule is assumed either way. */
function offsetMs(d: Date): number {
  const p = wallParts(d);
  const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
  return wall - (d.getTime() - (d.getTime() % 60_000));
}

/** A datetime-local value ('YYYY-MM-DDTHH:mm') read as office time → ISO instant; null when malformed. */
export function officeLocalToIso(local: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) return null;
  const asUtc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  // guess with the offset at that instant, then once more with the offset at the guess (only differs on a DST edge)
  const guess = asUtc - offsetMs(new Date(asUtc));
  return new Date(asUtc - offsetMs(new Date(guess))).toISOString();
}

/** ISO instant → a datetime-local value ('YYYY-MM-DDTHH:mm') in office time. */
export function isoToOfficeLocal(iso: string): string {
  const d = new Date(iso);
  return new Date(d.getTime() + offsetMs(d)).toISOString().slice(0, 16);
}

/** "20/10/2026 14:30" in office time. */
export function formatOfficeDateTime(iso: string): string {
  const p = wallParts(new Date(iso));
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}

/** Spec §4: Configurações → "Regras automáticas" (settings key 'auto_rules'). */
export const RETURN_TO_QUEUE_MINUTES = { min: 5, max: 1440 } as const;
export const CLOSE_INACTIVE_HOURS = { min: 1, max: 720 } as const;
export interface AutoRulesDto {
  returnToQueue: { enabled: boolean; minutes: number };
  closeInactive: { enabled: boolean; hours: number; sendClosingMessage: boolean };
}
/** Both off until an admin turns them on. */
export const DEFAULT_AUTO_RULES: AutoRulesDto = {
  returnToQueue: { enabled: false, minutes: 30 },
  closeInactive: { enabled: false, hours: 24, sendClosingMessage: true },
};

// ---------- Compromissos (spec 2026-10-21 compromissos §3–§5) ----------

/** A reminder goes N days (the same Cuiabá wall time) or N hours before the appointment. */
export const REMINDER_UNITS = ['days', 'hours'] as const;
export type ReminderUnit = (typeof REMINDER_UNITS)[number];
export const APPOINTMENT_LIMITS = {
  titleMax: 120, noteMax: 2000, remindersMax: 5, days: { min: 1, max: 30 }, hours: { min: 1, max: 48 },
} as const;
export const REMINDER_PLACEHOLDERS = ['nome', 'titulo', 'data', 'hora'] as const;
/** The Agenda's "Compromissos" tabs: Próximos, Passados, Cancelados. */
export const APPOINTMENT_TABS = ['upcoming', 'past', 'canceled'] as const;
export type AppointmentTab = (typeof APPOINTMENT_TABS)[number];
/** One reminder as typed: the text keeps its placeholders. */
export interface ReminderInput { amount: number; unit: ReminderUnit; text: string }
/** Configurações → Compromissos (settings key 'appointment_reminders'): what every new appointment starts with. */
export interface AppointmentRemindersDto { reminders: ReminderInput[] }
export const DEFAULT_APPOINTMENT_REMINDERS: AppointmentRemindersDto = {
  reminders: [
    {
      amount: 2,
      unit: 'days',
      text: 'Olá, {nome}! Lembramos do seu compromisso ({titulo}) no dia {data}, às {hora} (horário de Cuiabá). Qualquer dúvida, é só responder esta mensagem.',
    },
    { amount: 1, unit: 'hours', text: 'Olá, {nome}! Seu compromisso ({titulo}) é às {hora} de {data} (horário de Cuiabá).' },
  ],
};

/** The pt-BR reason an appointment time is refused, or null: after now, at most 1 year ahead (spec §3.1). Same check on both sides. */
export function appointmentTimeProblem(startsAt: Date | null, now: Date): string | null {
  if (!startsAt || Number.isNaN(startsAt.getTime())) return 'Escolha a data e a hora';
  if (startsAt.getTime() <= now.getTime()) return 'Este horário já passou; escolha uma data e hora futuras';
  if (startsAt.getTime() > now.getTime() + SCHEDULE_MAX_AHEAD_MS) return 'Escolha um horário em até 1 ano';
  return null;
}

/**
 * When a reminder goes out (spec §3.2, decision 7). "N horas antes" is exact. "N dias antes" keeps the Cuiabá wall time:
 * the office date minus N days, read back through officeLocalToIso, so no DST rule is assumed either way.
 */
export function reminderSendAt(startsAt: Date, amount: number, unit: ReminderUnit): Date {
  if (unit === 'hours') return new Date(startsAt.getTime() - amount * 3_600_000);
  const local = isoToOfficeLocal(startsAt.toISOString()); // 'YYYY-MM-DDTHH:mm'
  const day = new Date(`${local.slice(0, 10)}T00:00:00.000Z`);
  day.setUTCDate(day.getUTCDate() - amount);
  const wall = officeLocalToIso(`${day.toISOString().slice(0, 10)}${local.slice(10)}`)!;
  return new Date(new Date(wall).getTime() + (startsAt.getTime() % 60_000)); // the seconds ride along
}

/**
 * The first unknown placeholder ({Nome} included), or {nome} when the contact has no name (decision 6: never "Olá, !").
 * contactName undefined = there is no contact yet (Configurações), so {nome} is fine.
 */
export function reminderTextProblem(text: string, contactName?: string | null): string | null {
  for (const [, key] of text.matchAll(/\{([^{}]*)\}/g)) {
    if (!(REMINDER_PLACEHOLDERS as readonly string[]).includes(key)) {
      return `Marcador desconhecido: {${key}}. Use {nome}, {titulo}, {data} ou {hora}`;
    }
  }
  if (contactName !== undefined && !contactName?.trim() && text.includes('{nome}')) {
    return 'O contato não tem nome cadastrado; tire {nome} do lembrete';
  }
  return null;
}

/** The first rule a list of reminders breaks (spec §3.2), or null. startsAt null (Configurações): "same time" compares lead times. */
export function remindersProblem(reminders: ReminderInput[], startsAt: Date | null, contactName?: string | null): string | null {
  if (reminders.length === 0) return 'Inclua pelo menos um lembrete';
  for (const r of reminders) {
    if (!r.text.trim()) return 'Digite o texto do lembrete';
    const problem = reminderTextProblem(r.text, contactName);
    if (problem) return problem;
  }
  const times = reminders.map((r) =>
    startsAt ? reminderSendAt(startsAt, r.amount, r.unit).getTime() : r.amount * (r.unit === 'days' ? 24 : 1),
  );
  return new Set(times).size < times.length ? 'Dois lembretes cairiam no mesmo horário' : null;
}

/** The placeholders filled in ({data} and {hora} in Cuiabá time). Called on save and on a reschedule, never at send time. */
export function fillReminderText(text: string, v: { nome: string; titulo: string; startsAt: string }): string {
  const [data, hora] = formatOfficeDateTime(v.startsAt).split(' ');
  const values: Record<string, string> = { nome: v.nome, titulo: v.titulo, data, hora };
  return text.replace(/\{(nome|titulo|data|hora)\}/g, (_, key: string) => values[key]);
}
