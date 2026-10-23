// Office days are Cuiabá days: must not depend on the host zone. Set before anything reads the zone.
process.env.TZ = 'Asia/Tokyo';

import { describe, expect, it } from 'vitest';
import { APPOINTMENT_CANCELED, appointmentStatusProblem, officeDateOf, officeDayRange, shiftOfficeDate } from '@talk/shared';

const at = (iso: string) => new Date(iso);
const PAST = 'O horário deste compromisso já passou';
const NOT_YET = 'Só dá para marcar presença a partir do dia do compromisso';

describe('office days (spec 2026-10-23 controle §5)', () => {
  it('officeDateOf reads the Cuiabá date, not the UTC or host one (Review Focus 3)', () => {
    expect(officeDateOf(at('2026-10-15T03:59:00.000Z'))).toBe('2026-10-14'); // 23:59 in Cuiabá, 12:59 on the 15th in Tokyo
    expect(officeDateOf(at('2026-10-15T04:00:00.000Z'))).toBe('2026-10-15');
  });
  it('shiftOfficeDate crosses months and years', () => {
    expect(shiftOfficeDate('2026-10-31', 1)).toBe('2026-11-01');
    expect(shiftOfficeDate('2027-01-01', -1)).toBe('2026-12-31');
    expect(shiftOfficeDate('2027-02-28', 1)).toBe('2027-03-01');
    expect(shiftOfficeDate('2026-10-19', 42)).toBe('2026-11-30');
  });
  it('officeDayRange is [00:00, next 00:00) in Cuiabá', () => {
    expect(officeDayRange('2026-10-14')).toEqual({ from: at('2026-10-14T04:00:00.000Z'), to: at('2026-10-15T04:00:00.000Z') });
    expect(officeDayRange('2026-12-31')).toEqual({ from: at('2026-12-31T04:00:00.000Z'), to: at('2027-01-01T04:00:00.000Z') });
  });
});

describe('appointmentStatusProblem (spec §3.2)', () => {
  const now = at('2026-10-14T13:00:00.000Z'); // 09:00 in Cuiabá
  const appt = (startsAt: string, canceledAt: Date | null = null) => ({ startsAt: at(startsAt), canceledAt });

  it('a cancelled appointment refuses every status', () => {
    for (const s of ['scheduled', 'confirmed', 'attended', 'missed'] as const) {
      expect(appointmentStatusProblem(appt('2026-10-20T13:00:00.000Z', now), s, now)).toBe(APPOINTMENT_CANCELED);
    }
  });
  it('confirmed only while the time is ahead', () => {
    expect(appointmentStatusProblem(appt('2026-10-14T13:01:00.000Z'), 'confirmed', now)).toBeNull();
    expect(appointmentStatusProblem(appt('2026-10-14T13:00:00.000Z'), 'confirmed', now)).toBe(PAST);
    expect(appointmentStatusProblem(appt('2026-10-13T13:00:00.000Z'), 'confirmed', now)).toBe(PAST);
  });
  it('attended / missed from the office day on, also before the time; never on a later day', () => {
    for (const s of ['attended', 'missed'] as const) {
      expect(appointmentStatusProblem(appt('2026-10-15T03:30:00.000Z'), s, now)).toBeNull(); // 23:30 today in Cuiabá
      expect(appointmentStatusProblem(appt('2026-10-13T13:00:00.000Z'), s, now)).toBeNull();
      expect(appointmentStatusProblem(appt('2026-10-15T04:00:00.000Z'), s, now)).toBe(NOT_YET); // 00:00 tomorrow
    }
  });
  it('scheduled is always allowed', () => {
    expect(appointmentStatusProblem(appt('2026-10-13T13:00:00.000Z'), 'scheduled', now)).toBeNull();
    expect(appointmentStatusProblem(appt('2026-10-20T13:00:00.000Z'), 'scheduled', now)).toBeNull();
  });
});
