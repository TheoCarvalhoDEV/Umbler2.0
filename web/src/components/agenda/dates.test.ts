process.env.TZ = 'Asia/Tokyo';
import { describe, expect, it } from 'vitest';
import { dayHeading, mondayOf, officeToday, prefillStartsAt, weekDays, weekdayDay, weekLabel } from './dates';

describe('agenda dates (spec 2026-10-23 controle §6.4)', () => {
  it('officeToday is the Cuiabá date', () => {
    expect(officeToday(new Date('2026-10-21T03:30:00.000Z'))).toBe('2026-10-20');
  });
  it('dayHeading: Hoje, Amanhã, Ontem, then the short date, with the year only when it differs', () => {
    expect(dayHeading('2026-10-20', '2026-10-20')).toBe('Hoje');
    expect(dayHeading('2026-10-21', '2026-10-20')).toBe('Amanhã');
    expect(dayHeading('2026-10-19', '2026-10-20')).toBe('Ontem');
    expect(dayHeading('2026-10-23', '2026-10-20')).toBe('sex., 23 de out.');
    expect(dayHeading('2025-10-24', '2026-10-20')).toBe('sex., 24 de out. de 2025');
    expect(dayHeading('2027-01-04', '2026-12-30')).toBe('seg., 4 de jan. de 2027');
  });
});

describe('week helpers (spec §6.6)', () => {
  it('mondayOf, weekDays and weekdayDay', () => {
    expect(mondayOf('2026-10-20')).toBe('2026-10-19');
    expect(mondayOf('2026-10-19')).toBe('2026-10-19');
    expect(mondayOf('2026-10-25')).toBe('2026-10-19'); // Sunday belongs to the week before
    expect(mondayOf('2027-01-01')).toBe('2026-12-28');
    expect(weekDays('2026-10-19')).toEqual(['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25']);
    expect(weekdayDay('2026-10-19')).toBe('seg. 19');
  });
  it('weekLabel inside a month, across months and across years', () => {
    expect(weekLabel('2026-10-19')).toBe('19 – 25 de out. de 2026');
    expect(weekLabel('2026-10-26')).toBe('26 de out. – 1 de nov. de 2026');
    expect(weekLabel('2026-12-28')).toBe('28 de dez. de 2026 – 3 de jan. de 2027');
  });
  it('prefillStartsAt: 09:00 while ahead, else the next whole hour today, never a past day or past midnight', () => {
    const at = (iso: string) => new Date(iso);
    expect(prefillStartsAt('2026-10-21', at('2026-10-20T12:00:00.000Z'))).toBe('2026-10-21T09:00');
    expect(prefillStartsAt('2026-10-20', at('2026-10-20T12:00:00.000Z'))).toBe('2026-10-20T09:00'); // 08:00 now
    expect(prefillStartsAt('2026-10-20', at('2026-10-20T13:00:00.000Z'))).toBe('2026-10-20T10:00'); // exactly 09:00
    expect(prefillStartsAt('2026-10-20', at('2026-10-20T14:20:00.000Z'))).toBe('2026-10-20T11:00');
    expect(prefillStartsAt('2026-10-20', at('2026-10-21T03:30:00.000Z'))).toBeNull(); // 23:30 in Cuiabá
    expect(prefillStartsAt('2026-10-19', at('2026-10-20T12:00:00.000Z'))).toBeNull();
  });
});
