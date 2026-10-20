import { CHAT_SORTS, DEFAULT_CHAT_SORT, type ChatListFilters, type ChatSort, type ChatTab } from '@talk/shared';

export type Period = 'any' | 'today' | '7d' | '30d' | 'range';

/** UI filter state; '' means "todos". rangeFrom/rangeTo are <input type="date"> values (YYYY-MM-DD). */
export interface InboxFilters {
  sectorId: string;
  ownerId: string;
  /** The contact's tag. */
  tagId: string;
  /** The conversation's own tag (spec 2026-10-20 §5). */
  chatTagId: string;
  period: Period;
  rangeFrom: string;
  rangeTo: string;
}

export const EMPTY_FILTERS: InboxFilters = {
  sectorId: '', ownerId: '', tagId: '', chatTagId: '', period: 'any', rangeFrom: '', rangeTo: '',
};
/** ownerId sentinel for "Sem atendente" (server: owner_id IS NULL). */
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
  if (f.chatTagId) out.chatTagId = f.chatTagId;
  if (f.period === 'today') out.from = startOfDaysAgo(now, 0).toISOString();
  if (f.period === '7d') out.from = startOfDaysAgo(now, 6).toISOString();
  if (f.period === '30d') out.from = startOfDaysAgo(now, 29).toISOString();
  if (f.period === 'range') {
    if (f.rangeFrom) out.from = parseDay(f.rangeFrom, false).toISOString();
    if (f.rangeTo) out.to = parseDay(f.rangeTo, true).toISOString();
  }
  return out;
}

/** Spec 2026-10-20 §3, exact copy. */
export const CHAT_SORT_LABELS: Record<ChatSort, string> = {
  last_desc: 'Última mensagem: mais recentes',
  last_asc: 'Última mensagem: mais antigas',
  created_desc: 'Data de criação: mais recentes',
  created_asc: 'Data de criação: mais antigas',
  waiting: 'Esperando há mais tempo',
};

const sortKey = (userId: string | undefined) => `talk.chatSort.${userId ?? 'anon'}`;

/** The order is per user and per browser. A stale value or blocked storage (private window) gives the default. */
export function readChatSort(userId: string | undefined): ChatSort {
  try {
    const v = localStorage.getItem(sortKey(userId));
    return (CHAT_SORTS as readonly string[]).includes(v ?? '') ? (v as ChatSort) : DEFAULT_CHAT_SORT;
  } catch {
    return DEFAULT_CHAT_SORT;
  }
}

export function saveChatSort(userId: string | undefined, sort: ChatSort): void {
  try {
    if (sort === DEFAULT_CHAT_SORT) localStorage.removeItem(sortKey(userId));
    else localStorage.setItem(sortKey(userId), sort);
  } catch {
    // storage blocked: the order lasts until the page reloads
  }
}

/** The default order stays out of the query, so the list keeps sharing its cache with the unread badges. */
export const withSort = (f: ChatListFilters, sort: ChatSort): ChatListFilters =>
  sort === DEFAULT_CHAT_SORT ? f : { ...f, sort };
