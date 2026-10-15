import { describe, expect, it } from 'vitest';
import { contactLabel, listTime } from './format';

describe('contactLabel', () => {
  it('prefers the trimmed name', () => {
    expect(contactLabel({ name: '  Ana  ', phone: '5565999990000' })).toBe('Ana');
  });
  it('formats canonical mobile and landline phones with the shared formatPhone', () => {
    expect(contactLabel({ name: null, phone: '5565999990000' })).toBe('+55 65 99999-0000');
    expect(contactLabel({ name: '', phone: '556532221111' })).toBe('+55 65 3222-1111');
  });
  it('handles missing data', () => {
    expect(contactLabel({ name: null, phone: '123' })).toBe('123');
    expect(contactLabel({ name: null, phone: null })).toBe('Sem nome');
  });
});

describe('listTime', () => {
  const now = new Date(2026, 9, 14, 15, 30);
  it('shows HH:MM for today', () => {
    expect(listTime(new Date(2026, 9, 14, 9, 5).toISOString(), now)).toBe('09:05');
  });
  it('shows Ontem for yesterday', () => {
    expect(listTime(new Date(2026, 9, 13, 23, 59).toISOString(), now)).toBe('Ontem');
  });
  it('shows dd/mm this year and dd/mm/yy before', () => {
    expect(listTime(new Date(2026, 9, 1, 10, 0).toISOString(), now)).toBe('01/10');
    expect(listTime(new Date(2025, 11, 31, 10, 0).toISOString(), now)).toBe('31/12/25');
  });
});
