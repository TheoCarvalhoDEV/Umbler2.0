import type { AuthUser } from '../inbox/visibility.js';

export function signatureLabel(user: AuthUser, sectorName: string): string {
  return user.signature?.trim() || `${sectorName} - ${user.name}`;
}

export function formatSignature(text: string, signatureLabel: string): string {
  return `*${signatureLabel}:*\n${text}`;
}
