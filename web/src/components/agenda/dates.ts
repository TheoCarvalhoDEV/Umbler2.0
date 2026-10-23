import { isoToOfficeLocal, officeDateOf, shiftOfficeDate } from '@talk/shared';

/** Today's date in the office (Cuiabá), never the host zone. */
export const officeToday = (now: Date = new Date()): string => officeDateOf(now);

const weekday = new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC', weekday: 'short' });
const month = new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC', month: 'short' });

/** Spec 2026-10-23 controle §6.4: "Hoje" / "Amanhã" / "Ontem", else "sex., 23 de out." (+ " de 2025" when the year differs from today's). */
export function dayHeading(day: string, today: string): string {
  if (day === today) return 'Hoje';
  if (day === shiftOfficeDate(today, 1)) return 'Amanhã';
  if (day === shiftOfficeDate(today, -1)) return 'Ontem';
  const at = new Date(`${day}T12:00:00Z`); // a calendar date, no host zone
  const year = day.slice(0, 4);
  return `${weekday.format(at)}, ${Number(day.slice(8, 10))} de ${month.format(at)}${year === today.slice(0, 4) ? '' : ` de ${year}`}`;
}

const dayOf = (day: string) => new Date(`${day}T12:00:00Z`);

/** The Monday of the week holding this date ('YYYY-MM-DD'); a Sunday belongs to the week before. */
export const mondayOf = (day: string): string => shiftOfficeDate(day, -((dayOf(day).getUTCDay() + 6) % 7));

export const weekDays = (monday: string): string[] => Array.from({ length: 7 }, (_, i) => shiftOfficeDate(monday, i));

/** "seg. 19" */
export const weekdayDay = (day: string): string => `${weekday.format(dayOf(day))} ${Number(day.slice(8, 10))}`;

/** "19 – 25 de out. de 2026", "26 de out. – 1 de nov. de 2026", "28 de dez. de 2026 – 3 de jan. de 2027". */
export function weekLabel(monday: string): string {
  const sunday = shiftOfficeDate(monday, 6);
  const d = (day: string) => Number(day.slice(8, 10));
  const m = (day: string) => month.format(dayOf(day));
  if (monday.slice(0, 7) === sunday.slice(0, 7)) return `${d(monday)} – ${d(sunday)} de ${m(monday)} de ${monday.slice(0, 4)}`;
  if (monday.slice(0, 4) === sunday.slice(0, 4)) return `${d(monday)} de ${m(monday)} – ${d(sunday)} de ${m(sunday)} de ${monday.slice(0, 4)}`;
  return `${d(monday)} de ${m(monday)} de ${monday.slice(0, 4)} – ${d(sunday)} de ${m(sunday)} de ${sunday.slice(0, 4)}`;
}

/** Office-local start for "Novo compromisso" on this day: 09:00 while ahead; today, the next whole hour; else null. */
export function prefillStartsAt(day: string, now: Date): string | null {
  const nine = `${day}T09:00`;
  const nowLocal = isoToOfficeLocal(now.toISOString());
  if (nine > nowLocal) return nine;
  if (day !== nowLocal.slice(0, 10)) return null;
  const hour = Number(nowLocal.slice(11, 13)) + 1;
  return hour > 23 ? null : `${day}T${String(hour).padStart(2, '0')}:00`;
}
