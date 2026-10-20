// Review Focus 5: the conversion must not depend on the host zone. Set before anything reads the zone.
process.env.TZ = 'Asia/Tokyo';

import { describe, expect, it } from 'vitest';
import {
  SCHEDULE_MAX_AHEAD_MS, formatOfficeDateTime, isoToOfficeLocal, officeLocalToIso, scheduleTimeProblem,
} from '@talk/shared';

describe('office time, America/Cuiaba (spec 2026-10-20 agendamentos §2)', () => {
  it('reads a datetime-local value as Cuiabá time and back (Review Focus 5)', () => {
    // the host zone is Tokyo here, so reading the value in the host zone would give a different instant
    expect(new Date('2026-10-20T14:30').toISOString()).not.toBe(officeLocalToIso('2026-10-20T14:30'));
    expect(officeLocalToIso('2026-10-20T14:30')).toBe('2026-10-20T18:30:00.000Z');
    expect(officeLocalToIso('2026-12-31T23:59')).toBe('2027-01-01T03:59:00.000Z');
    expect(isoToOfficeLocal('2026-10-20T18:30:45.000Z')).toBe('2026-10-20T14:30');
    expect(isoToOfficeLocal('2027-01-01T03:59:00.000Z')).toBe('2026-12-31T23:59');
    expect(officeLocalToIso('20/10/2026 14:30')).toBeNull();
    expect(officeLocalToIso('')).toBeNull();
    expect(formatOfficeDateTime('2026-10-21T03:05:00.000Z')).toBe('20/10/2026 23:05');
  });

  it('accepts from 2 minutes to 1 year ahead (spec §3.1)', () => {
    const now = new Date('2026-10-20T12:00:00.000Z');
    expect(scheduleTimeProblem(null, now)).toBe('Escolha a data e a hora');
    expect(scheduleTimeProblem(new Date('nope'), now)).toBe('Escolha a data e a hora');
    expect(scheduleTimeProblem(new Date('2026-10-20T12:01:59.000Z'), now)).toBe('Escolha um horário pelo menos 2 minutos à frente');
    expect(scheduleTimeProblem(new Date('2026-10-20T12:02:00.000Z'), now)).toBeNull();
    expect(scheduleTimeProblem(new Date(now.getTime() + SCHEDULE_MAX_AHEAD_MS), now)).toBeNull();
    expect(scheduleTimeProblem(new Date(now.getTime() + SCHEDULE_MAX_AHEAD_MS + 60_000), now)).toBe('Escolha um horário em até 1 ano');
  });
});
