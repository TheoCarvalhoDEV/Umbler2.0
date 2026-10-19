// "Buscar na conversa" (spec 2026-10-19 §4): case- and accent-insensitive matching. The server folds the column with
// translate(lower(col), FOLD_FROM, FOLD_TO) and the query with foldText: one table for both sides.
// Runtime code with no imports: tsx (server) and Vite (web) load this source directly.

export const SEARCH_MIN_CHARS = 2;
export const SEARCH_MAX_CHARS = 100;
export const SEARCH_LIMIT = 50;

const LOWER = 'áàâãäåéèêëíìîïóòôõöúùûüçñý';
const UPPER = 'ÁÀÂÃÄÅÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑÝ';
const PLAIN = 'aaaaaa' + 'eeee' + 'iiii' + 'ooooo' + 'uuuu' + 'cny';
/** Upper case too: under the C locale Postgres lower() leaves accented capitals as they are. */
export const FOLD_FROM = LOWER + UPPER;
export const FOLD_TO = PLAIN + PLAIN;

const FOLD = new Map([...FOLD_FROM].map((c, i) => [c, FOLD_TO[i]!] as const));

/**
 * Lower case without accents ("Ação" → "acao"), one character for one, so an index in the fold is an index in the text.
 * ponytail: the few letters whose toLowerCase grows (e.g. "İ") shift the snippet a little; map them if anyone notices.
 */
export function foldText(s: string): string {
  return [...s.toLowerCase()].map((c) => FOLD.get(c) ?? c).join('');
}
