import { describe, expect, it } from 'vitest';
import type { AskInputConfig } from '@talk/shared';
import {
  compileUserRegex,
  formatCnpj,
  formatCpf,
  isValidCnpj,
  isValidCpf,
  isValidEmail,
  mediaTypeOf,
  parsePhoneBR,
  validateAnswer,
  type AnswerInput,
  type AnswerResult,
} from '../../src/bots/validators.js';

describe('isValidCpf / formatCpf', () => {
  const cases: Array<[input: string, valid: boolean]> = [
    ['529.982.247-25', true],
    ['52998224725', true],
    [' 529 982 247 25 ', true],
    ['111.444.777-35', true],
    ['000.000.001-91', true], // leading zeros
    ['529.982.247-24', false], // second check digit wrong
    ['529.982.247-15', false], // first check digit wrong
    ['111.111.111-11', false], // repeated digits pass the math but are not real
    ['000.000.000-00', false],
    ['5299822472', false], // 10 digits
    ['529982247250', false], // 12 digits
    ['529.982.247-2a', false],
    ['meu cpf 529.982.247-25', false], // other words are not stripped
    ['', false],
  ];
  it.each(cases)('isValidCpf(%j) = %s', (input, valid) => {
    expect(isValidCpf(input)).toBe(valid);
  });

  it('formats with dots and dash', () => {
    expect(formatCpf('52998224725')).toBe('529.982.247-25');
    expect(formatCpf(' 529 982 247 25 ')).toBe('529.982.247-25');
  });
});

describe('isValidCnpj / formatCnpj', () => {
  const cases: Array<[input: string, valid: boolean]> = [
    ['11.222.333/0001-81', true],
    ['11222333000181', true],
    ['00.000.000/0001-91', true],
    ['12.ABC.345/01DE-35', true], // alphanumeric CNPJ (Receita Federal, July 2026)
    ['12abc34501de35', true], // lowercase is accepted
    ['11.222.333/0001-80', false],
    ['11.222.333/0001-91', false],
    ['12.ABC.345/01DE-36', false],
    ['12.ABC.345/01DE-3A', false], // check digits are always numeric
    ['00.000.000/0000-00', false],
    ['11.111.111/1111-11', false],
    ['1122233300018', false], // 13 chars
    ['11.222.333/0001-81 ok', false],
    ['', false],
  ];
  it.each(cases)('isValidCnpj(%j) = %s', (input, valid) => {
    expect(isValidCnpj(input)).toBe(valid);
  });

  it('formats with dots, slash and dash, uppercase', () => {
    expect(formatCnpj('11222333000181')).toBe('11.222.333/0001-81');
    expect(formatCnpj('12abc34501de35')).toBe('12.ABC.345/01DE-35');
  });
});

describe('isValidEmail', () => {
  const cases: Array<[input: string, valid: boolean]> = [
    ['ana@exemplo.com.br', true],
    [' Ana.Silva+adv@Exemplo.COM ', true],
    ['a_b@sub.dominio.org', true],
    ['ana', false],
    ['ana@', false],
    ['@exemplo.com', false],
    ['ana@exemplo', false],
    ['ana silva@exemplo.com', false],
    ['ana@@exemplo.com', false],
    ['ana@exemplo..com', false],
    ['', false],
  ];
  it.each(cases)('isValidEmail(%j) = %s', (input, valid) => {
    expect(isValidEmail(input)).toBe(valid);
  });
});

describe('parsePhoneBR', () => {
  const cases: Array<[input: string, expected: string | null]> = [
    ['(65) 99999-9999', '5565999999999'],
    ['65999999999', '5565999999999'],
    ['+55 65 99999-9999', '5565999999999'],
    ['5565999999999', '5565999999999'],
    ['556599999999', '5565999999999'], // 12-digit mobile gains the 9
    ['(65) 9999-9999', '5565999999999'], // old 8-digit mobile gains the 9
    ['(65) 3222-1111', '556532221111'], // landline
    ['meu número é 65 99999-9999', '5565999999999'], // words around a single number are fine
    ['+1 202-555-0123', null], // not Brazilian
    ['5565899999999', null], // 13 digits but the local part does not start with 9
    ['556512345678', null], // local number starting with 1
    ['55 00 99999-9999', null], // DDD 00
    ['65 99999-9999 ou 65 98888-7777', null], // two numbers
    ['123', null],
    ['abc', null],
    ['', null],
  ];
  it.each(cases)('parsePhoneBR(%j) = %j', (input, expected) => {
    expect(parsePhoneBR(input)).toBe(expected);
  });
});

describe('compileUserRegex', () => {
  it.each([
    ['^\\d{5}-?\\d{3}$', true],
    ['\\p{Lu}', true], // needs the 'u' flag
    ['a'.repeat(200), true],
    ['a'.repeat(201), false], // too long
    ['', false],
    ['(', false],
    ['[', false],
    ['\\a', false], // invalid identity escape under 'u'
  ])('compileUserRegex(%j) compiles = %s', (pattern, compiles) => {
    expect(compileUserRegex(pattern) !== null).toBe(compiles);
  });

  it('uses the unicode flag', () => {
    const re = compileUserRegex('^\\p{Lu}$');
    expect(re?.flags).toBe('u');
    expect(re?.test('Á')).toBe(true);
  });
});

describe('mediaTypeOf', () => {
  it.each([
    ['application/pdf', 'pdf'],
    ['APPLICATION/PDF; name=x', 'pdf'],
    ['audio/ogg; codecs=opus', 'audio'],
    ['image/webp', 'image'],
    ['image/jpeg', 'image'],
    ['video/mp4', 'video'],
    ['application/msword', null],
    ['text/plain', null],
    ['', null],
    [null, null],
  ] as Array<[string | null, string | null]>)('mediaTypeOf(%j) = %j', (mime, expected) => {
    expect(mediaTypeOf(mime)).toBe(expected);
  });
});

describe('validateAnswer', () => {
  type Cfg = Pick<AskInputConfig, 'validator' | 'mediaTypes' | 'regex'>;
  const text = (body: string | null): AnswerInput => ({ body, kind: 'text', mediaMime: null, mediaName: null });
  const media = (kind: AnswerInput['kind'], mediaMime: string | null, mediaName: string | null = null): AnswerInput => ({
    body: null,
    kind,
    mediaMime,
    mediaName,
  });
  const ok = (raw: string, value: string): AnswerResult => ({ ok: true, raw, value });
  const FAIL: AnswerResult = { ok: false };

  const cases: Array<[label: string, cfg: Cfg, input: AnswerInput, expected: AnswerResult]> = [
    ['any: text is trimmed', { validator: 'any' }, text('  oi  '), ok('oi', 'oi')],
    ['any: audio without a name is accepted (Review Focus 4)', { validator: 'any' }, media('audio', 'audio/ogg'), ok('', 'audio')],
    ['any: a document uses its file name', { validator: 'any' }, media('document', 'application/pdf', 'contrato.pdf'), ok('', 'contrato.pdf')],
    ['any: a sticker is accepted', { validator: 'any' }, media('sticker', 'image/webp'), ok('', 'sticker')],
    ['any: text with a null body does not crash', { validator: 'any' }, text(null), ok('', '')],
    ['email: lowercased value, trimmed raw', { validator: 'email' }, text(' Ana@Exemplo.com '), ok('Ana@Exemplo.com', 'ana@exemplo.com')],
    ['email: invalid', { validator: 'email' }, text('ana'), FAIL],
    ['email: an image without caption', { validator: 'email' }, media('image', 'image/jpeg'), FAIL],
    ['phone: canonical value', { validator: 'phone' }, text('(65) 99999-9999'), ok('(65) 99999-9999', '5565999999999')],
    ['phone: invalid', { validator: 'phone' }, text('123'), FAIL],
    ['phone: audio', { validator: 'phone' }, media('audio', 'audio/ogg'), FAIL],
    ['cpf: formatted value', { validator: 'cpf' }, text('52998224725'), ok('52998224725', '529.982.247-25')],
    ['cpf: wrong check digit', { validator: 'cpf' }, text('529.982.247-24'), FAIL],
    ['cnpj: formatted value', { validator: 'cnpj' }, text('11222333000181'), ok('11222333000181', '11.222.333/0001-81')],
    ['cnpj: alphanumeric, uppercased', { validator: 'cnpj' }, text('12abc34501de35'), ok('12abc34501de35', '12.ABC.345/01DE-35')],
    ['cnpj: a CPF is not a CNPJ', { validator: 'cnpj' }, text('52998224725'), FAIL],
    ['regex: match', { validator: 'regex', regex: '^\\d{5}-?\\d{3}$' }, text(' 78000-000 '), ok('78000-000', '78000-000')],
    ['regex: no match', { validator: 'regex', regex: '^\\d{5}-?\\d{3}$' }, text('abc'), FAIL],
    ['regex: an invalid pattern fails without throwing', { validator: 'regex', regex: '(' }, text('abc'), FAIL],
    ['regex: a missing pattern fails', { validator: 'regex' }, text('abc'), FAIL],
    ['regex: 1000 chars are tested', { validator: 'regex', regex: '^a+$' }, text('a'.repeat(1000)), ok('a'.repeat(1000), 'a'.repeat(1000))],
    ['regex: longer than 1000 chars fails', { validator: 'regex', regex: '^a+$' }, text('a'.repeat(1001)), FAIL],
    ['media: any type, image', { validator: 'media' }, media('image', 'image/jpeg', 'foto.jpg'), ok('', 'foto.jpg')],
    ['media: empty list = any type', { validator: 'media', mediaTypes: [] }, media('video', 'video/mp4'), ok('', 'video')],
    ['media: text is refused', { validator: 'media' }, text('segue o arquivo'), FAIL],
    ['media: unsupported is refused', { validator: 'media' }, media('unsupported', null), FAIL],
    ['media: pdf required, pdf sent', { validator: 'media', mediaTypes: ['pdf'] }, media('document', 'application/pdf', 'peticao.pdf'), ok('', 'peticao.pdf')],
    ['media: pdf required, photo sent', { validator: 'media', mediaTypes: ['pdf'] }, media('image', 'image/jpeg'), FAIL],
    ['media: pdf required, unknown mime', { validator: 'media', mediaTypes: ['pdf'] }, media('document', null, 'x.pdf'), FAIL],
    ['media: image allowed, sticker sent', { validator: 'media', mediaTypes: ['image'] }, media('sticker', 'image/webp'), ok('', 'sticker')],
    ['media: audio allowed, voice note with codec', { validator: 'media', mediaTypes: ['audio', 'pdf'] }, media('audio', 'audio/ogg; codecs=opus'), ok('', 'audio')],
  ];
  it.each(cases)('%s', (_label, cfg, input, expected) => {
    expect(validateAnswer(cfg, input)).toEqual(expected);
  });
});

describe('catastrophic regex', () => {
  it('times out instead of blocking the event loop', () => {
    const t = Date.now();
    const r = validateAnswer({ validator: 'regex', regex: '(a+)+$' }, { body: 'a'.repeat(999) + '!', kind: 'text', mediaMime: null, mediaName: null });
    expect(r).toEqual({ ok: false });
    expect(Date.now() - t).toBeLessThan(1000);
  });
});
