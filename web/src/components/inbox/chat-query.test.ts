import { describe, expect, it } from 'vitest';
import { buildChatQuery, EMPTY_FILTERS, NO_OWNER, type InboxFilters } from './chat-query';

const now = new Date(2026, 9, 14, 15, 30); // 14/10/2026 15:30 local time

describe('buildChatQuery', () => {
  it('sends only tab and limit when nothing is filtered', () => {
    expect(buildChatQuery('inbox', '', EMPTY_FILTERS, now)).toEqual({ tab: 'inbox', limit: 50 });
    expect(buildChatQuery('closed', '   ', EMPTY_FILTERS, now)).toEqual({ tab: 'closed', limit: 50 });
  });

  it('maps search, sector, "sem dono" and tag', () => {
    const f: InboxFilters = { ...EMPTY_FILTERS, sectorId: 's1', ownerId: NO_OWNER, tagId: 't1' };
    expect(buildChatQuery('waiting', '  Ana Souza ', f, now)).toEqual({
      tab: 'waiting',
      limit: 50,
      q: 'Ana Souza',
      sectorId: 's1',
      ownerId: 'none',
      tagId: 't1',
    });
  });

  it('maps Hoje / 7 dias / 30 dias to a start-of-day "from"', () => {
    const at = (period: InboxFilters['period']) => buildChatQuery('inbox', '', { ...EMPTY_FILTERS, period }, now);
    expect(at('today').from).toBe(new Date(2026, 9, 14).toISOString());
    expect(at('7d').from).toBe(new Date(2026, 9, 8).toISOString());
    expect(at('30d').from).toBe(new Date(2026, 8, 15).toISOString());
    expect(at('today').to).toBeUndefined();
  });

  it('maps Intervalo to start of first day and end of last day', () => {
    const f: InboxFilters = { ...EMPTY_FILTERS, period: 'range', rangeFrom: '2026-10-01', rangeTo: '2026-10-10' };
    const out = buildChatQuery('closed', '', f, now);
    expect(out.from).toBe(new Date(2026, 9, 1).toISOString());
    expect(out.to).toBe(new Date(2026, 9, 10, 23, 59, 59, 999).toISOString());
  });

  it('ignores empty range fields and range fields when period is not Intervalo', () => {
    expect(buildChatQuery('inbox', '', { ...EMPTY_FILTERS, period: 'range' }, now)).toEqual({ tab: 'inbox', limit: 50 });
    expect(
      buildChatQuery('inbox', '', { ...EMPTY_FILTERS, rangeFrom: '2026-10-01', rangeTo: '2026-10-10' }, now),
    ).toEqual({ tab: 'inbox', limit: 50 });
  });
});
