import { describe, expect, it } from 'vitest';
import { localDigits, maskPhone } from './phone';

describe('localDigits', () => {
  it('strips the 55 country code only from full numbers', () => {
    expect(localDigits('+55 (65) 99999-1234')).toBe('65999991234');
    expect(localDigits('55999991234')).toBe('55999991234'); // DDD 55 (RS), 11 digits: kept
    expect(localDigits('659999912345678')).toBe('65999991234');
  });
});

describe('maskPhone', () => {
  it('masks a mobile number', () => {
    expect(maskPhone('65999991234')).toBe('(65) 99999-1234');
  });
  it('masks a landline', () => {
    expect(maskPhone('6532221111')).toBe('(65) 3222-1111');
  });
  it('masks a canonical 13-digit number', () => {
    expect(maskPhone('5565999991234')).toBe('(65) 99999-1234');
  });
  it('masks partial input while typing', () => {
    expect(maskPhone('')).toBe('');
    expect(maskPhone('6')).toBe('(6');
    expect(maskPhone('659')).toBe('(65) 9');
    expect(maskPhone('659999')).toBe('(65) 9999');
    expect(maskPhone('6599999')).toBe('(65) 9999-9');
    expect(maskPhone('65999991')).toBe('(65) 9999-91');
  });
});
