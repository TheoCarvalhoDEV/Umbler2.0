import { describe, expect, it } from 'vitest';
import { bulkSummary } from './bulk';

describe('bulkSummary (spec 2026-10-20 §4)', () => {
  it('says how many were done out of how many', () => {
    expect(bulkSummary({ done: ['a', 'b'], failed: [] })).toBe('2 de 2 concluídas.');
    expect(bulkSummary({ done: ['a'], failed: [] })).toBe('1 de 1 concluída.');
  });

  it('adds how many could not, with each distinct reason once', () => {
    expect(bulkSummary({ done: ['a'], failed: [{ chatId: 'b', error: 'Conversa finalizada' }] })).toBe(
      '1 de 2 concluídas; 1 não pôde: Conversa finalizada',
    );
    expect(
      bulkSummary({
        done: [],
        failed: [
          { chatId: 'a', error: 'Conversa finalizada' },
          { chatId: 'b', error: 'Conversa finalizada' },
          { chatId: 'c', error: 'Conversa não encontrada' },
        ],
      }),
    ).toBe('0 de 3 concluídas; 3 não puderam: Conversa finalizada / Conversa não encontrada');
  });
});
