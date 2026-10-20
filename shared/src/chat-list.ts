// Chat list order and bulk actions (spec 2026-10-20 §3, §4). Runtime values with no imports: tsx (server) and
// Vite (web) load this source directly.

/** The list orders. `waiting` = waiting chats first (longest wait on top), then the rest by last message. */
export const CHAT_SORTS = ['last_desc', 'last_asc', 'created_desc', 'created_asc', 'waiting'] as const;
export type ChatSort = (typeof CHAT_SORTS)[number];
/** Today's order: last message, newest first. */
export const DEFAULT_CHAT_SORT: ChatSort = 'last_desc';

/** Chats per bulk request (spec §4). */
export const BULK_MAX = 50;

/** Answer of POST /api/chats/bulk/*: each chat once, in request order; `error` is a short pt-BR reason. */
export interface BulkResultDto { done: string[]; failed: Array<{ chatId: string; error: string }> }
