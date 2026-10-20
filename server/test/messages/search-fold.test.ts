import { describe, expect, it } from 'vitest';
import { FOLD_FROM, FOLD_TO, foldText } from '@talk/shared';

describe('foldText (spec 2026-10-19 §4)', () => {
  it('lowers the case and drops the Portuguese accents, one character for one', () => {
    expect(foldText('AÇÃO de Cobrança em São Paulo')).toBe('acao de cobranca em sao paulo');
    expect(foldText('Ñandú, ÉPOCA, über, à vista')).toBe('nandu, epoca, uber, a vista');
    const s = 'Atenção: prazo até 15/10';
    expect(foldText(s)).toHaveLength(s.length);
  });

  it('pairs every accented letter with a plain one, so SQL translate() folds the same way', () => {
    expect([...FOLD_FROM]).toHaveLength([...FOLD_TO].length);
    expect(foldText(FOLD_FROM)).toBe(FOLD_TO);
    expect(FOLD_TO).toMatch(/^[a-z]+$/);
  });
});
