import { describe, expect, it } from 'vitest';
import { formatPhone, initials, relativeTime } from './format';

describe('relativeTime', () => {
  const now = new Date('2026-10-14T12:00:00.000Z');
  it.each([
    ['2026-10-14T11:59:30.000Z', 'agora'],
    ['2026-10-14T12:05:00.000Z', 'agora'], // future timestamp (clock skew)
    ['2026-10-14T11:55:00.000Z', 'há 5 minutos'],
    ['2026-10-14T11:00:00.000Z', 'há 1 hora'],
    ['2026-10-13T12:00:00.000Z', 'há 1 dia'],
    ['2026-05-14T12:00:00.000Z', 'há 5 meses'],
    ['2024-10-14T12:00:00.000Z', 'há 2 anos'],
  ])('%s → %s', (iso, expected) => {
    expect(relativeTime(iso, now)).toBe(expected);
  });
});

describe('formatPhone', () => {
  it('formats a 13-digit mobile', () => {
    expect(formatPhone('5565999999999')).toBe('+55 65 99999-9999');
  });
  it('formats a 12-digit landline', () => {
    expect(formatPhone('556532221111')).toBe('+55 65 3222-1111');
  });
  it('returns non-Brazilian numbers unchanged and empty for null', () => {
    expect(formatPhone('14155550100')).toBe('14155550100');
    expect(formatPhone(null)).toBe('');
  });
});

describe('initials', () => {
  it('uses first and last name', () => {
    expect(initials('Ana Maria Souza')).toBe('AS');
    expect(initials('joão')).toBe('J');
  });
  it('falls back to ?', () => {
    expect(initials('   ')).toBe('?');
    expect(initials(null)).toBe('?');
  });
});
