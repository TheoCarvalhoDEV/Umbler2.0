// DTOs and WebSocket event types shared by server and web, plus the tag palette (palette.ts), the only
// runtime code. There is no build step: tsx (server) and Vite (web) load this TypeScript source directly.
// Use `import type` for everything except TAG_COLORS and tagColorHex.
export { TAG_COLORS, tagColorHex } from './palette.js';

export type Role = 'admin' | 'agent';
export interface Me { id: string; name: string; email: string; role: Role; signature: string | null; sectorIds: string[]; seeAllSectors: boolean; avatarUrl: string | null }
export interface SectorDto { id: string; name: string; position: number; isDefault: boolean }
export interface TagDto { id: string; name: string; emoji: string | null; color: string; position: number }
export interface UserDto { id: string; name: string; email: string; role: Role; signature: string | null; active: boolean; sectorIds: string[]; avatarUrl: string | null }
export interface ChannelDto { id: string; name: string; status: 'disconnected' | 'connecting' | 'connected'; phone: string | null }
export interface ContactRef { id: string; name: string | null; phone: string | null; avatarUrl: string | null }
export type ChatTab = 'inbox' | 'waiting' | 'closed';
export interface ChatListFilters { tab: ChatTab; q?: string; sectorId?: string; ownerId?: string; tagId?: string; from?: string; to?: string; cursor?: string; limit?: number }
export interface ChatListItem { id: string; contact: ContactRef; channelId: string; sectorId: string; ownerId: string | null; state: 'open' | 'closed'; waiting: boolean; private: boolean; unread: number; lastMessageAt: string | null; lastMessagePreview: string | null; pinned: boolean; tagIds: string[] }
export interface ChatDetail extends ChatListItem { triagePending: boolean; createdAt: string; closedAt: string | null }
export interface MediaDto { url: string; mime: string; name: string | null; size: number | null }
export interface MessageDto { id: string; chatId: string; direction: 'in' | 'out'; kind: 'text' | 'image' | 'audio' | 'video' | 'document' | 'sticker' | 'note' | 'unsupported'; body: string | null; media: MediaDto | null; mediaUnavailable: boolean; authorId: string | null; authorName: string | null; authorAvatarUrl: string | null; replyTo: { id: string; body: string | null; kind: string } | null; reaction: string | null; status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed'; error: string | null; sentAt: string }
export interface ChatEventDto { id: string; chatId: string; kind: 'created' | 'assigned' | 'transferred' | 'closed' | 'reopened' | 'privacy_changed' | 'triage_routed'; data: Record<string, unknown>; authorName: string | null; createdAt: string }
export type TimelineItem = ({ type: 'message' } & MessageDto) | ({ type: 'event' } & ChatEventDto);
export interface ContactDto { id: string; name: string | null; phone: string | null; lid: string | null; email: string | null; landline: string | null; address: Record<string, string> | null; blocked: boolean; tagIds: string[]; fields: Record<string, string>; createdAt: string; avatarUrl: string | null }
export interface ContactNoteDto { id: string; body: string; pinned: boolean; authorName: string | null; createdAt: string }
export interface CustomFieldDto { id: string; name: string; kind: 'text' | 'number' | 'date' | 'cpf' | 'cnpj'; position: number }
export interface QuickAnswerDto { id: string; name: string; body: string; hasAttachment: boolean; visibility: 'all' | 'owner'; ownerId: string | null }
export interface TriageMenuDto { enabled: boolean; welcomeText: string; invalidText: string; options: Array<{ key: string; label: string; sectorId: string }> }
export interface SettingsDto { closingMessage: string; triageMenu: TriageMenuDto }
export type WsEvent =
  | { type: 'chat.updated'; chat: ChatListItem }
  | { type: 'chat.removed'; chatId: string }
  | { type: 'message.created'; message: MessageDto }
  | { type: 'message.updated'; message: MessageDto }
  | { type: 'channel.status'; channel: ChannelDto };
