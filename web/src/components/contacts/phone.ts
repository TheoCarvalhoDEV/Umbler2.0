// ponytail: BR-only input mask. The server's normalizePhoneBR is the source of truth for storage;
// display formatting is web/src/lib/format.ts formatPhone (Task 15), the only phone formatter.

/** Digits without the 55 country code, capped at 11 (DDD + 9 digits). */
export function localDigits(raw: string): string {
  let d = raw.replace(/\D/g, '');
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
  return d.slice(0, 11);
}

/** "(65) 99999-1234" / "(65) 3222-1111", progressively while typing. */
export function maskPhone(raw: string): string {
  const d = localDigits(raw);
  if (d.length === 0) return '';
  if (d.length <= 2) return `(${d}`;
  const ddd = d.slice(0, 2);
  const rest = d.slice(2);
  const split = rest.length > 8 ? 5 : 4;
  if (rest.length <= split) return `(${ddd}) ${rest}`;
  return `(${ddd}) ${rest.slice(0, split)}-${rest.slice(split)}`;
}
