import { officeDateOf, shiftOfficeDate } from '@talk/shared';

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
