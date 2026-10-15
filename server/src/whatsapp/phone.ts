// Spec §4: canonical BR mobile = 55 + DDD + 9 + 8 digits (13 digits, no '+').
// A 12-digit number whose first local digit is 6-9 is a mobile missing its 9
// (Evolution strips it for DDD >= 31). First local digit 2-5 = landline or
// WhatsApp Business and stays as is.
const MOBILE_WITHOUT_9 = /^55(\d{2})([6-9]\d{7})$/;

export function normalizePhoneBR(raw: string): string {
  let digits = raw.replace(/\D/g, '');
  // A local number (DDD + number) gets the country code, unless the user typed
  // an explicit '+' (international number such as +1 202-555-0123).
  if ((digits.length === 10 || digits.length === 11) && !raw.trim().startsWith('+')) {
    digits = '55' + digits;
  }
  return digits.replace(MOBILE_WITHOUT_9, '55$19$2');
}

// '5565...:12@s.whatsapp.net' -> { user: '5565...', server: 's.whatsapp.net' }
function splitJid(jid: string): { user: string; server: string } | null {
  const at = jid.indexOf('@');
  if (at <= 0) return null;
  const user = jid.slice(0, at).split(':')[0];
  return /^\d+$/.test(user) ? { user, server: jid.slice(at + 1) } : null;
}

export function phoneFromJid(jid: string): string | null {
  const p = splitJid(jid);
  // JIDs always carry the country code: the '+' stops normalizePhoneBR from prefixing 55.
  return p?.server === 's.whatsapp.net' ? normalizePhoneBR('+' + p.user) : null;
}

// Returns the LID digits only (what contacts.lid stores); callers append '@lid' when addressing.
export function lidFromJid(jid: string): string | null {
  const p = splitJid(jid);
  return p?.server === 'lid' ? p.user : null;
}
