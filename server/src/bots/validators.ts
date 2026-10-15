import { z } from 'zod';
import type { AskInputConfig, MediaType } from '@talk/shared';
import { baseMime } from '../messages/media.js';
import { normalizePhoneBR } from '../whatsapp/phone.js';
import type { MessageKind } from '../whatsapp/types.js';

export interface AnswerInput { body: string | null; kind: MessageKind; mediaMime: string | null; mediaName: string | null }
export type AnswerResult = { ok: true; raw: string; value: string } | { ok: false };

const FAIL: AnswerResult = { ok: false };
const REGEX_MAX = 200;
// ponytail: no ReDoS guard beyond pattern ≤200 and input ≤1000 chars; move to a worker with timeout if patterns get hostile.
const REGEX_INPUT_MAX = 1000;
const MEDIA_KINDS: ReadonlySet<MessageKind> = new Set(['image', 'audio', 'video', 'document', 'sticker']);
// After normalizePhoneBR: 55 + DDD (two digits 1-9) + mobile 9xxxxxxxx or landline [2-5]xxxxxxx.
const BR_PHONE = /^55[1-9]{2}(?:9\d{8}|[2-5]\d{7})$/;
const Email = z.email();

/** Drops only formatting (spaces, dots, dashes, slashes); any other character keeps the answer invalid. */
const unformat = (s: string) => s.replace(/[\s./-]/g, '');

/** Brazilian mod-11 check digit, shared by CPF and CNPJ. */
function checkDigit(values: number[], weights: readonly number[]): number {
  const r = values.reduce((sum, v, i) => sum + v * weights[i], 0) % 11;
  return r < 2 ? 0 : 11 - r;
}

const CPF_W1 = [10, 9, 8, 7, 6, 5, 4, 3, 2];
const CPF_W2 = [11, ...CPF_W1];
const CNPJ_W1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const CNPJ_W2 = [6, ...CNPJ_W1];

export function isValidCpf(s: string): boolean {
  const d = unformat(s);
  if (!/^\d{11}$/.test(d) || /^(\d)\1{10}$/.test(d)) return false;
  const v = [...d].map(Number);
  return checkDigit(v.slice(0, 9), CPF_W1) === v[9] && checkDigit(v.slice(0, 10), CPF_W2) === v[10];
}

/** Call only after isValidCpf. */
export function formatCpf(s: string): string {
  const d = unformat(s);
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9, 11)}`;
}

/** Numeric and alphanumeric CNPJ (Receita Federal, issued from July 2026): 12 chars [0-9A-Z] + 2 numeric
 *  check digits; each char counts as its char code minus 48, so digits keep their value. */
export function isValidCnpj(s: string): boolean {
  const c = unformat(s).toUpperCase();
  if (!/^[0-9A-Z]{12}\d{2}$/.test(c) || /^(\d)\1{13}$/.test(c)) return false;
  const v = [...c].map((ch) => ch.charCodeAt(0) - 48);
  return checkDigit(v.slice(0, 12), CNPJ_W1) === v[12] && checkDigit(v.slice(0, 13), CNPJ_W2) === v[13];
}

/** Call only after isValidCnpj. */
export function formatCnpj(s: string): string {
  const c = unformat(s).toUpperCase();
  return `${c.slice(0, 2)}.${c.slice(2, 5)}.${c.slice(5, 8)}/${c.slice(8, 12)}-${c.slice(12, 14)}`;
}

export function isValidEmail(s: string): boolean {
  return Email.safeParse(s.trim()).success;
}

export function parsePhoneBR(s: string): string | null {
  const p = normalizePhoneBR(s);
  return BR_PHONE.test(p) ? p : null;
}

/** null when empty, longer than 200 chars or not a valid pattern with the 'u' flag. */
export function compileUserRegex(pattern: string): RegExp | null {
  if (pattern.length === 0 || pattern.length > REGEX_MAX) return null;
  try {
    return new RegExp(pattern, 'u');
  } catch {
    return null;
  }
}

export function mediaTypeOf(mime: string | null): MediaType | null {
  if (!mime) return null;
  const m = baseMime(mime);
  if (m === 'application/pdf') return 'pdf';
  const top = m.split('/')[0];
  return top === 'audio' || top === 'image' || top === 'video' ? top : null;
}

export function validateAnswer(
  cfg: Pick<AskInputConfig, 'validator' | 'mediaTypes' | 'regex'>,
  input: AnswerInput,
): AnswerResult {
  const mediaValue = input.mediaName ?? input.kind;
  if (cfg.validator === 'any') {
    if (input.kind !== 'text') return { ok: true, raw: '', value: mediaValue };
    const t = (input.body ?? '').trim();
    return { ok: true, raw: t, value: t };
  }
  if (cfg.validator === 'media') {
    if (!MEDIA_KINDS.has(input.kind)) return FAIL;
    const types = cfg.mediaTypes ?? [];
    const type = mediaTypeOf(input.mediaMime);
    if (types.length > 0 && (type === null || !types.includes(type))) return FAIL;
    return { ok: true, raw: '', value: mediaValue };
  }
  if (input.body === null) return FAIL;
  const raw = input.body.trim();
  switch (cfg.validator) {
    case 'email':
      return isValidEmail(raw) ? { ok: true, raw, value: raw.toLowerCase() } : FAIL;
    case 'phone': {
      const phone = parsePhoneBR(raw);
      return phone ? { ok: true, raw, value: phone } : FAIL;
    }
    case 'cpf':
      return isValidCpf(raw) ? { ok: true, raw, value: formatCpf(raw) } : FAIL;
    case 'cnpj':
      return isValidCnpj(raw) ? { ok: true, raw, value: formatCnpj(raw) } : FAIL;
    case 'regex': {
      const re = compileUserRegex(cfg.regex ?? '');
      return re && raw.length <= REGEX_INPUT_MAX && re.test(raw) ? { ok: true, raw, value: raw } : FAIL;
    }
  }
  return FAIL;
}
