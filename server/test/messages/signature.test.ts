import { describe, expect, it } from 'vitest';
import { formatSignature, signatureLabel, stripSignature } from '../../src/messages/signature.js';
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

describe('stripSignature', () => {
  it.each([
    ['*Financeiro - Ana Lima:*\n1', '1'],
    ['*Dra. Ana:*\nmeu cpf é\n529.982.247-25', 'meu cpf é\n529.982.247-25'],
    ['1', '1'],
    ['*negrito* no meio:\n1', '*negrito* no meio:\n1'], // not our format: a star inside the label
    ['*Financeiro - Ana Lima:* na mesma linha', '*Financeiro - Ana Lima:* na mesma linha'],
    ['*Financeiro - Ana Lima:*\n', ''],
  ])('%j reads as %j', (text, expected) => {
    expect(stripSignature(text)).toBe(expected);
  });

  it('undoes formatSignature and leaves a second signed line alone', () => {
    const signed = formatSignature('Oi\n*Financeiro - Ana Lima:*\n2', 'Financeiro - Ana Lima');
    expect(stripSignature(signed)).toBe('Oi\n*Financeiro - Ana Lima:*\n2');
  });
});
