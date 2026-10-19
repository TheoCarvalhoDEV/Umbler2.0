import type { AuthUser } from '../inbox/visibility.js';

export function signatureLabel(user: AuthUser, sectorName: string): string {
  return user.signature?.trim() || `${sectorName} - ${user.name}`;
}

export function formatSignature(text: string, signatureLabel: string): string {
  return `*${signatureLabel}:*\n${text}`;
}

/**
 * Inverse of formatSignature: drops the "*Setor - Nome:*" line this system puts before an agent's text. A reply that
 * carries one was sent from another installation (or another number of the office) with the signature on; what the
 * bots and the triage read as the answer is the text after it. The stored message keeps the full text.
 */
export function stripSignature(text: string): string {
  return text.replace(/^\*[^*\n]{1,200}:\*\n/, '');
}
