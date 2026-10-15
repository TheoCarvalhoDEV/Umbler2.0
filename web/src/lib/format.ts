const rtf = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'always' });
const STEPS = [
  ['minute', 60],
  ['hour', 24],
  ['day', 30],
  ['month', 12],
] as const;

/** "agora", "há 5 minutos", "há 1 hora", "há 5 meses", "há 2 anos". */
export function relativeTime(iso: string, now: Date = new Date()): string {
  let value = (now.getTime() - new Date(iso).getTime()) / 60_000; // minutes
  if (value < 1) return 'agora';
  for (const [unit, size] of STEPS) {
    if (value < size) return rtf.format(-Math.floor(value), unit);
    value /= size;
  }
  return rtf.format(-Math.floor(value), 'year');
}

/** Canonical 55DDD… → "+55 65 99999-9999" (mobile) / "+55 65 3222-1111" (landline); anything else as-is. */
export function formatPhone(phone: string | null | undefined): string {
  if (!phone) return '';
  const m = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(phone);
  return m ? `+55 ${m[1]} ${m[2]}-${m[3]}` : phone;
}

/** Avatar letters: first + last word initial. */
export function initials(name: string | null | undefined): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0]![0]!;
  const last = words.length > 1 ? words[words.length - 1]![0]! : '';
  return (first + last).toUpperCase();
}
