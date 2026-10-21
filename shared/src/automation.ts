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
