import { describe, expect, it } from 'vitest';
import { formatSignature, signatureLabel } from '../../src/messages/signature.js';
import type { AuthUser } from '../../src/inbox/visibility.js';

const ana: AuthUser = { id: 'u1', name: 'Ana Lima', email: 'ana@x.com', role: 'agent', signature: null, sectorIds: [], seeAllSectors: false, avatarUrl: null };

describe('signature', () => {
  it('uses "{Setor} - {Nome}" when the user has no signature (Umbler format)', () => {
    expect(signatureLabel(ana, 'Financeiro')).toBe('Financeiro - Ana Lima');
  });

  it('uses the user signature when filled, trimmed', () => {
    expect(signatureLabel({ ...ana, signature: '  Dra. Ana  ' }, 'Financeiro')).toBe('Dra. Ana');
  });

  it('falls back to the sector format when the signature is only whitespace', () => {
    expect(signatureLabel({ ...ana, signature: '   ' }, 'Jurídico')).toBe('Jurídico - Ana Lima');
  });

  it('formats as bold label, colon, newline, text', () => {
    expect(formatSignature('Bom dia!\nSegue o boleto.', 'Financeiro - Ana Lima')).toBe(
      '*Financeiro - Ana Lima:*\nBom dia!\nSegue o boleto.',
    );
  });
});
