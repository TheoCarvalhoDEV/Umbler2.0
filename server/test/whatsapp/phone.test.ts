import { describe, expect, it } from 'vitest';
import { lidFromJid, normalizePhoneBR, phoneFromJid } from '../../src/whatsapp/phone.js';

const normalizeCases: Array<[label: string, raw: string, expected: string]> = [
  // Review Focus 1: Evolution's 12-digit form and Umbler's 13-digit form converge
  ['12-digit mobile DDD 65 gains the 9 (Review Focus 1)', '556599999999', '5565999999999'],
  ['13-digit mobile DDD 65 unchanged (Umbler import form)', '5565999999999', '5565999999999'],
  ['12-digit landline starting with 3 unchanged (Review Focus 1)', '556532221111', '556532221111'],
  // first local digit decides: 2-5 fixed / business, 6-9 mobile
  ['12-digit landline starting with 2 unchanged', '552125556666', '552125556666'],
  ['12-digit landline starting with 4 unchanged', '551145556666', '551145556666'],
  ['12-digit landline starting with 5 unchanged', '554755556666', '554755556666'],
  ['12-digit mobile starting with 6 gains the 9', '556566543210', '5565966543210'],
  ['12-digit mobile starting with 7 gains the 9', '556576543210', '5565976543210'],
  ['12-digit mobile starting with 8 gains the 9', '553188887777', '5531988887777'],
  // DDD 11 (below 31): Evolution keeps the 9, but a 12-digit form is still repaired
  ['13-digit mobile DDD 11 unchanged', '5511988887777', '5511988887777'],
  ['12-digit mobile DDD 11 gains the 9', '551188887777', '5511988887777'],
  ['12-digit landline DDD 11 unchanged', '551132221111', '551132221111'],
  // formatting characters are stripped
  ['+55 with spaces, parentheses and dash', '+55 (65) 99999-9999', '5565999999999'],
  ['+55 old 8-digit mobile format gains the 9', '+55 65 9999-9999', '5565999999999'],
  ['dots and surrounding whitespace', '  55.65.99999.9999  ', '5565999999999'],
  ['+55 landline with formatting unchanged', '+55 (65) 3222-1111', '556532221111'],
  // local numbers (no country code) get 55
  ['11-digit local mobile gets 55', '(65) 99999-9999', '5565999999999'],
  ['10-digit local old mobile gets 55 and the 9', '(65) 9999-9999', '5565999999999'],
  ['10-digit local landline gets 55 only', '(65) 3222-1111', '556532221111'],
  ['11-digit local DDD 11 mobile gets 55', '11 98888-7777', '5511988887777'],
  // explicit international numbers are not treated as Brazilian
  ['+1 US number (11 digits) is not prefixed', '+1 202-555-0123', '12025550123'],
  ['+351 Portuguese number passes through', '+351 912 345 678', '351912345678'],
  // degenerate input
  ['empty string stays empty', '', ''],
  ['only formatting stays empty', ' ( ) - + ', ''],
];

describe('normalizePhoneBR', () => {
  it.each(normalizeCases)('%s', (_label, raw, expected) => {
    expect(normalizePhoneBR(raw)).toBe(expected);
  });

  // An 11-digit foreign number without '+' is indistinguishable from a BR local
  // number, so only the '+'-prefixed input is canonical: '12025550123' would gain 55.
  it.each(normalizeCases.filter(([, raw]) => !raw.trim().startsWith('+1 ')))('is idempotent: %s', (_label, raw) => {
    const once = normalizePhoneBR(raw);
    expect(normalizePhoneBR(once)).toBe(once);
  });
});

describe('phoneFromJid', () => {
  it.each<[string, string | null]>([
    ['556599999999@s.whatsapp.net', '5565999999999'], // Review Focus 1
    ['5565999999999@s.whatsapp.net', '5565999999999'],
    ['556599999999:12@s.whatsapp.net', '5565999999999'], // device suffix
    ['5565999999999:3@s.whatsapp.net', '5565999999999'],
    ['556532221111@s.whatsapp.net', '556532221111'], // landline keeps 12 digits
    ['551188887777@s.whatsapp.net', '5511988887777'],
    ['12025550123@s.whatsapp.net', '12025550123'], // 11-digit foreign JID never gets 55
    ['123456789012345@lid', null],
    ['120363025246125486@g.us', null],
    ['556599999999-1600000000@g.us', null],
    ['status@broadcast', null],
    ['120363000000000000@newsletter', null],
    ['abc@s.whatsapp.net', null],
    ['@s.whatsapp.net', null],
    ['556599999999', null],
    ['', null],
  ])('%s -> %s', (jid, expected) => {
    expect(phoneFromJid(jid)).toBe(expected);
  });
});

describe('lidFromJid', () => {
  it.each<[string, string | null]>([
    ['123456789012345@lid', '123456789012345'],
    ['123456789012345:7@lid', '123456789012345'],
    ['556599999999@s.whatsapp.net', null],
    ['120363025246125486@g.us', null],
    ['abc@lid', null],
    ['@lid', null],
    ['123456789012345', null],
    ['', null],
  ])('%s -> %s', (jid, expected) => {
    expect(lidFromJid(jid)).toBe(expected);
  });
});
