process.env.TZ = 'Asia/Tokyo';
import { describe, expect, it } from 'vitest';
import { dayHeading, officeToday } from './dates';

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
