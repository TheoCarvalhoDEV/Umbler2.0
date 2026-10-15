import type { ChatListFilters, ChatTab } from '@talk/shared';

export type Period = 'any' | 'today' | '7d' | '30d' | 'range';

/** UI filter state; '' means "todos". rangeFrom/rangeTo are <input type="date"> values (YYYY-MM-DD). */
export interface InboxFilters {
  sectorId: string;
  ownerId: string;
  tagId: string;
  period: Period;
  rangeFrom: string;
  rangeTo: string;
}

export const EMPTY_FILTERS: InboxFilters = { sectorId: '', ownerId: '', tagId: '', period: 'any', rangeFrom: '', rangeTo: '' };
/** ownerId sentinel for "Sem dono" (server: owner_id IS NULL). */
export const NO_OWNER = 'none';
export const PAGE_SIZE = 50;

function startOfDaysAgo(now: Date, days: number): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - days);
}

function parseDay(value: string, endOfDay: boolean): Date {
  const [y, m, d] = value.split('-').map(Number);
  return endOfDay ? new Date(y, m - 1, d, 23, 59, 59, 999) : new Date(y, m - 1, d);
}

/**
 * Maps tab + search + filters to the ChatListFilters passed to api.chats.list and qk.chatList.
 * No cursor: the infinite query adds it per page. Only set fields appear, so equal filters give equal query keys.
 */
export function buildChatQuery(tab: ChatTab, q: string, f: InboxFilters, now: Date = new Date()): ChatListFilters {
  const out: ChatListFilters = { tab, limit: PAGE_SIZE };
  const term = q.trim();
  if (term) out.q = term;
  if (f.sectorId) out.sectorId = f.sectorId;
  if (f.ownerId) out.ownerId = f.ownerId;
  if (f.tagId) out.tagId = f.tagId;
  if (f.period === 'today') out.from = startOfDaysAgo(now, 0).toISOString();
  if (f.period === '7d') out.from = startOfDaysAgo(now, 6).toISOString();
  if (f.period === '30d') out.from = startOfDaysAgo(now, 29).toISOString();
  if (f.period === 'range') {
    if (f.rangeFrom) out.from = parseDay(f.rangeFrom, false).toISOString();
    if (f.rangeTo) out.to = parseDay(f.rangeTo, true).toISOString();
  }
  return out;
}
