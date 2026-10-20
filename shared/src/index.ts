// DTOs and WebSocket event types shared by server and web, plus two runtime modules: the tag palette (palette.ts)
// and the chatbot block catalog (bots.ts). There is no build step: tsx (server) and Vite (web) load this
// TypeScript source directly. Use `import type` for everything except the values re-exported below.
import type { BotRunningBehavior, NotificationDto } from './bots.js';
import type { MessageChangeSource } from './message-actions.js';
import type { UserPreferences } from './preferences.js';
export { TAG_COLORS, tagColorHex } from './palette.js';
export {
  BLOCK_TYPES, WEEKDAYS, WEEKDAY_LABELS, DEFAULT_TIMEZONE, RULE_OPERATOR_LABELS, NATIVE_CONTACT_FIELDS, BLOCK_CATALOG,
  BLOCK_CATEGORY_LABELS, NON_TERMINAL_RUN_STATES, MAX_STEPS_PER_CALL, MAX_FLOW_LEVELS, STEP_LOG_LIMIT, EDITOR_HISTORY_LIMIT,
  configOf, defaultConfig, nodeNameFor, catalogEntry, outputsOf,
} from './bots.js';
export type * from './bots.js';
export {
  EDIT_WINDOW_MS, DELETE_WINDOW_MS, QUICK_REACTIONS, RECENT_STICKERS_LIMIT, STICKER_MAX_BYTES, DELETED_REASON, FAVORITES_LIMIT,
  reactBlock, replyBlock, editBlock, deleteBlock, forwardBlock, isSingleEmoji, noteEditBlock, noteDeleteBlock,
} from './message-actions.js';
export type * from './message-actions.js';
export { BROWSER_NOTIFICATION_MODES, DEFAULT_PREFERENCES } from './preferences.js';
export type * from './preferences.js';
export { SEARCH_MIN_CHARS, SEARCH_MAX_CHARS, SEARCH_LIMIT, FOLD_FROM, FOLD_TO, foldText } from './search.js';

export type Role = 'admin' | 'agent';
export interface Me { id: string; name: string; email: string; role: Role; signature: string | null; sectorIds: string[]; seeAllSectors: boolean; avatarUrl: string | null;
  // spec 2026-10-19 §6, optional so existing literals compile; the server always fills it (Task 5)
  preferences?: UserPreferences }
// openChats: only GET /api/sectors fills it (open chats in the sector, every agent's).
export interface SectorDto { id: string; name: string; position: number; isDefault: boolean; openChats?: number }
export interface TagDto { id: string; name: string; emoji: string | null; color: string; position: number }
export interface UserDto { id: string; name: string; email: string; role: Role; signature: string | null; active: boolean; sectorIds: string[]; avatarUrl: string | null }
export type HistoryPeriod = '3m' | '12m' | 'all';
export type HistoryImportState = 'running' | 'done' | 'failed';
/** One copy of the phone's history from Evolution (spec 2026-10-16 §5.6). Dates are ISO. */
export interface HistoryImportDto { id: string; period: HistoryPeriod; state: HistoryImportState; startedAt: string; finishedAt: string | null; messagesImported: number; contactsCreated: number; oldestMessageAt: string | null; error: string | null }
export interface ChannelDto { id: string; name: string; status: 'disconnected' | 'connecting' | 'connected'; phone: string | null;
  // optional so existing literals compile; the server always fills them (history import, Task 7)
  historyPeriod?: HistoryPeriod; disconnectedAt?: string | null; historyImport?: HistoryImportDto | null }
export interface ContactRef { id: string; name: string | null; phone: string | null; avatarUrl: string | null }
export type ChatTab = 'inbox' | 'waiting' | 'closed';
export interface ChatListFilters { tab: ChatTab; q?: string; sectorId?: string; ownerId?: string; tagId?: string; from?: string; to?: string; cursor?: string; limit?: number }
export interface ChatListItem { id: string; contact: ContactRef; channelId: string; sectorId: string; ownerId: string | null; state: 'open' | 'closed'; waiting: boolean; private: boolean; unread: number; lastMessageAt: string | null; lastMessagePreview: string | null; pinned: boolean; tagIds: string[];
  // imported from the phone (closed, read-only, visible to everyone); optional so existing literals compile (Task 10 fills it)
  history?: boolean;
  // status of the last (non-note) message when the office sent it; null when the contact sent it or there is none
  lastOutStatus?: MessageDto['status'] | null }
export interface ChatDetail extends ChatListItem { triagePending: boolean; createdAt: string; closedAt: string | null }
export interface MediaDto { url: string; mime: string; name: string | null; size: number | null }
export interface MessageDto { id: string; chatId: string; direction: 'in' | 'out'; kind: 'text' | 'image' | 'audio' | 'video' | 'document' | 'sticker' | 'note' | 'unsupported'; body: string | null; media: MediaDto | null; mediaUnavailable: boolean; authorId: string | null; authorName: string | null; authorAvatarUrl: string | null; replyTo: { id: string; body: string | null; kind: string } | null; reaction: string | null; status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed'; error: string | null; sentAt: string;
  // optional so existing literals compile; toMessageDto always fills them (Task 2)
  botRunId?: string | null; botName?: string | null;
  // message actions (spec 2026-10-16), optional for the same reason; toMessageDto always fills them (Task 2)
  officeReaction?: string | null;
  deleted?: { at: string; source: MessageChangeSource; byName: string | null } | null;
  edited?: { at: string; source: MessageChangeSource; newTextUnavailable: boolean } | null;
  forwarded?: boolean;
  // history media (spec 2026-10-16 historico §5.5), optional for the same reason; toMessageDto always fills it (history Task 6)
  mediaExpired?: boolean;
  // the team's shared star (spec 2026-10-19 §5), optional for the same reason; toMessageDto always fills it (Task 2)
  favorite?: { at: string; byName: string | null } | null }
export interface ChatEventDto { id: string; chatId: string; kind: ChatEventKind; data: Record<string, unknown>; authorName: string | null; createdAt: string }
export type ChatEventKind =
  | 'created' | 'assigned' | 'transferred' | 'closed' | 'reopened' | 'privacy_changed' | 'triage_routed'
  | 'bot_started' | 'bot_finished' | 'bot_stopped' | 'bot_failed' | 'bot_transferred' | 'bot_note'
  | 'message_deleted' | 'message_edited' // data: { messageId, source: MessageChangeSource }
  | 'history_imported' | 'contact_merged' // data: { count } | {}
  | 'note_deleted'; // data: {} (spec 2026-10-19 §3); the event author is who deleted the note
export type TimelineItem = ({ type: 'message' } & MessageDto) | ({ type: 'event' } & ChatEventDto);
/** GET /api/messages/:id/edits: the text before each edit, newest first. */
export interface MessageEditDto { id: string; previousBody: string | null; source: MessageChangeSource; editedByName: string | null; newTextUnavailable: boolean; editedAt: string }
/** GET /api/stickers/recent (spec §6). */
export interface RecentStickerDto { messageId: string; url: string }
/** GET /api/chats/:id/search (spec 2026-10-19 §4): one hit, newest first. */
export interface MessageSearchHit { messageId: string; kind: MessageDto['kind']; direction: 'in' | 'out'; snippet: string; sentAt: string }
export interface ContactDto { id: string; name: string | null; phone: string | null; lid: string | null; email: string | null; landline: string | null; address: Record<string, string> | null; blocked: boolean; tagIds: string[]; fields: Record<string, string>; createdAt: string; avatarUrl: string | null }
export interface ContactNoteDto { id: string; body: string; pinned: boolean; authorName: string | null; createdAt: string }
export interface CustomFieldDto { id: string; name: string; kind: 'text' | 'number' | 'date' | 'cpf' | 'cnpj'; position: number }
export interface QuickAnswerDto { id: string; name: string; body: string; hasAttachment: boolean; visibility: 'all' | 'owner'; ownerId: string | null }
export interface TriageMenuDto { enabled: boolean; welcomeText: string; invalidText: string; options: Array<{ key: string; label: string; sectorId: string }> }
export interface SettingsDto { closingMessage: string; triageMenu: TriageMenuDto; botRunningBehavior: BotRunningBehavior }
export type WsEvent =
  | { type: 'chat.updated'; chat: ChatListItem }
  | { type: 'chat.removed'; chatId: string }
  | { type: 'message.created'; message: MessageDto }
  | { type: 'message.updated'; message: MessageDto }
  | { type: 'channel.status'; channel: ChannelDto }
  | { type: 'channel.removed'; channelId: string }
  | { type: 'notification'; notification: NotificationDto }
  | { type: 'users.changed' }; // a user's picture changed: refetch users, chats and me
