import type { InfiniteData } from '@tanstack/react-query';
import type {
  BotAction,
  BotDto,
  BotExport,
  BotMediaDto,
  BotPatch,
  BotRunDto,
  BotRunningErrorBody,
  BotVersionDto,
  BotVersionSummaryDto,
  ChannelDto,
  ChatDetail,
  ChatListFilters,
  ChatListItem,
  ContactDto,
  ContactNoteDto,
  CustomFieldDto,
  GraphProblem,
  HistoryPeriod,
  ManualBotDto,
  Me,
  MessageDto,
  MessageEditDto,
  MessageSearchHit,
  OfficeTemplateInput,
  QuickAnswerDto,
  RecentStickerDto,
  SaveVersionInput,
  SectorDto,
  SettingsDto,
  TagDto,
  TimelineItem,
  UserDto,
  UserPreferences,
} from '@talk/shared';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public correlationId?: string,
    /** Parsed error body (null when it was not JSON): carries `code`/`runs`, `problems`, `usedBy`. */
    public data?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** The runs from a 409 `{ code: 'BOT_RUNNING', runs }`; null for any other error. */
export function botRunningRuns(e: unknown): BotRunningErrorBody['runs'] | null {
  if (!(e instanceof ApiError) || e.status !== 409) return null;
  const d = e.data as Partial<BotRunningErrorBody> | null | undefined;
  return d?.code === 'BOT_RUNNING' && Array.isArray(d.runs) ? d.runs : null;
}

/** The problems from a 400 `{ error, problems }` (publish of an invalid graph); null for any other error. */
export function graphProblems(e: unknown): GraphProblem[] | null {
  if (!(e instanceof ApiError) || e.status !== 400) return null;
  const p = (e.data as { problems?: unknown } | null | undefined)?.problems;
  return Array.isArray(p) ? (p as GraphProblem[]) : null;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
export type ChatPage = Page<ChatListItem>;
/** Chat lists are infinite queries under qk.chatList(filters); pageParam = cursor. */
export type ChatListData = InfiniteData<ChatPage, string | undefined>;
/** Timeline infinite query: pages[0] = newest page; each page ascending; next pages are older (pageParam = before). */
export type TimelineData = InfiniteData<TimelineItem[], string | undefined>;
/** One page of a timeline anchored on a message (spec 2026-10-19 §4): older than, newer than, or around an item. */
export type TimelineCursor = { before: string } | { after: string } | { around: string };
/** Anchored timeline (qk.timelineAt): pages[0] = newest loaded, each ascending; next pages are older, previous pages newer. */
export type AnchoredTimelineData = InfiniteData<TimelineItem[], TimelineCursor>;

export interface StartChatInput { contactId?: string; phone?: string; name?: string; sectorId?: string }
export interface SendTextInput { text: string; signature: boolean; replyToId?: string; botAction?: BotAction }
export interface SendFileInput {
  file: Blob; fileName?: string; text?: string; signature: boolean; replyToId?: string; asVoice?: boolean; botAction?: BotAction;
  /** Spec §6: send the image as a WhatsApp sticker. */
  asSticker?: boolean;
}
/** Spec §6: a recent sticker, sent again by the id of the message that carries it. */
export interface SendStickerInput { stickerFromMessageId: string; replyToId?: string; botAction?: BotAction }
/** Spec §7: one destination per forward. */
export type ForwardInput = ({ chatId: string } | { contactId: string; channelId?: string }) & { botAction?: BotAction };
export type ContactInput = Partial<Pick<ContactDto, 'name' | 'phone' | 'email' | 'landline' | 'address'>>;
export interface ContactListQuery { q?: string; tagId?: string; blocked?: '' | 'true' | 'false'; cursor?: string; limit?: number }
export type SectorInput = Partial<Pick<SectorDto, 'name' | 'position' | 'isDefault'>>;
export type TagInput = Partial<Pick<TagDto, 'name' | 'emoji' | 'color' | 'position'>>;
export type CustomFieldInput = Partial<Pick<CustomFieldDto, 'name' | 'kind' | 'position'>>;
export type UserInput = Partial<Pick<UserDto, 'name' | 'email' | 'role' | 'signature' | 'active' | 'sectorIds'>> & { password?: string };
export type QuickAnswerInput = Partial<Pick<QuickAnswerDto, 'name' | 'body' | 'visibility'>>;

const RATE_LIMITED = 'Muitas tentativas. Aguarde um minuto e tente de novo.';

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: 'include', headers: {} };
  if (body instanceof FormData) {
    init.body = body; // browser sets the multipart boundary
  } else if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, 'Sem conexão com o servidor');
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    if (res.status === 429) throw new ApiError(429, RATE_LIMITED);
    const obj = (data ?? {}) as { error?: unknown; correlationId?: unknown };
    const msg = typeof obj.error === 'string' ? obj.error : `Erro ${res.status}`;
    const cid = typeof obj.correlationId === 'string' ? obj.correlationId : undefined;
    throw new ApiError(res.status, cid ? `${msg} (${cid})` : msg, cid, data);
  }
  return data as T;
}

function qs(params: object): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params) as Array<[string, unknown]>) {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

const enc = encodeURIComponent;

function crud<T, I>(base: string) {
  return {
    list: () => request<T[]>('GET', base),
    create: (input: I) => request<T>('POST', base, input),
    update: (id: string, input: I) => request<T>('PATCH', `${base}/${enc(id)}`, input),
    remove: (id: string) => request<void>('DELETE', `${base}/${enc(id)}`),
  };
}

/** Generic form used by Tasks 16, 18 and 19: `api<T>('/api/x', { method, body })`. */
function call<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  return request<T>(init.method ?? 'GET', path, init.body);
}

/** Callable (`api<T>(path, init)`) and namespaced (`api.chats.list(...)`, used by Task 17). */
export const api = Object.assign(call, {
  auth: {
    login: (email: string, password: string) => request<Me>('POST', '/api/auth/login', { email, password }),
    logout: () => request<void>('POST', '/api/auth/logout'),
    me: () => request<Me>('GET', '/api/auth/me'),
    setView: (seeAllSectors: boolean) => request<Me>('PUT', '/api/auth/me/view', { seeAllSectors }),
    setAvatar: (file: Blob) => {
      const form = new FormData();
      form.append('file', file);
      return request<Me>('POST', '/api/auth/me/avatar', form);
    },
    removeAvatar: () => request<Me>('DELETE', '/api/auth/me/avatar'),
    /** Spec 2026-10-19 §6: only the fields that changed. */
    setPreferences: (patch: Partial<UserPreferences>) => request<Me>('PUT', '/api/auth/me/preferences', patch),
  },
  chats: {
    list: (f: ChatListFilters) => request<ChatPage>('GET', `/api/chats${qs(f)}`),
    start: (input: StartChatInput) => request<ChatDetail>('POST', '/api/chats', input),
    get: (id: string) => request<ChatDetail>('GET', `/api/chats/${enc(id)}`),
    timeline: (id: string, q: { before?: string; after?: string; around?: string; limit?: number } = {}) =>
      request<TimelineItem[]>('GET', `/api/chats/${enc(id)}/timeline${qs(q)}`),
    /** Spec 2026-10-19 §4: newest first, at most 50. */
    search: (id: string, q: string) => request<MessageSearchHit[]>('GET', `/api/chats/${enc(id)}/search${qs({ q })}`),
    /** Spec 2026-10-19 §5: newest star first. */
    favorites: (id: string) => request<MessageDto[]>('GET', `/api/chats/${enc(id)}/favorites`),
    assume: (id: string) => request<ChatDetail>('POST', `/api/chats/${enc(id)}/assume`),
    reopen: (id: string) => request<ChatDetail>('POST', `/api/chats/${enc(id)}/reopen`),
    markRead: (id: string) => request<void>('POST', `/api/chats/${enc(id)}/read`),
    markUnread: (id: string) => request<void>('POST', `/api/chats/${enc(id)}/unread`),
    remove: (id: string) => request<void>('DELETE', `/api/chats/${enc(id)}`),
    transfer: (id: string, to: { sectorId?: string; ownerId?: string | null; botAction?: BotAction }) =>
      request<ChatDetail>('POST', `/api/chats/${enc(id)}/transfer`, to),
    setPrivacy: (id: string, isPrivate: boolean) =>
      request<ChatDetail>('POST', `/api/chats/${enc(id)}/privacy`, { private: isPrivate }),
    close: (id: string, sendClosingMessage: boolean) =>
      request<ChatDetail>('POST', `/api/chats/${enc(id)}/close`, { sendClosingMessage }),
    pin: (id: string, pinned: boolean) => request<void>(pinned ? 'PUT' : 'DELETE', `/api/chats/${enc(id)}/pin`),
    sendText: (id: string, input: SendTextInput) => request<MessageDto>('POST', `/api/chats/${enc(id)}/messages`, input),
    sendFile: (id: string, input: SendFileInput) => {
      // @fastify/multipart only exposes fields that come BEFORE the file part — keep the file last.
      const form = new FormData();
      if (input.text) form.append('text', input.text);
      form.append('signature', String(input.signature));
      if (input.replyToId) form.append('replyToId', input.replyToId);
      if (input.asVoice) form.append('asVoice', 'true');
      if (input.asSticker) form.append('asSticker', 'true');
      if (input.botAction) form.append('botAction', input.botAction);
      form.append('file', input.file, input.fileName ?? (input.file instanceof File ? input.file.name : 'arquivo'));
      return request<MessageDto>('POST', `/api/chats/${enc(id)}/messages`, form);
    },
    addNote: (id: string, text: string) => request<MessageDto>('POST', `/api/chats/${enc(id)}/notes`, { text }),
    sendSticker: (id: string, input: SendStickerInput) => request<MessageDto>('POST', `/api/chats/${enc(id)}/messages`, input),
  },
  messages: {
    resend: (messageId: string) => request<MessageDto>('POST', `/api/messages/${enc(messageId)}/resend`),
    mediaUrl: (messageId: string) => `/api/media/${enc(messageId)}`,
    /** "Baixar": one download try for a media message without a file (history spec §5.5). */
    downloadMedia: (messageId: string) => request<MessageDto>('POST', `/api/messages/${enc(messageId)}/media`),
    /** '' or the current emoji removes the office's reaction. */
    react: (messageId: string, emoji: string) => request<MessageDto>('POST', `/api/messages/${enc(messageId)}/reaction`, { emoji }),
    /** Delete for everyone. */
    remove: (messageId: string) => request<MessageDto>('DELETE', `/api/messages/${enc(messageId)}`),
    edit: (messageId: string, text: string) => request<MessageDto>('PATCH', `/api/messages/${enc(messageId)}`, { text }),
    edits: (messageId: string) => request<MessageEditDto[]>('GET', `/api/messages/${enc(messageId)}/edits`),
    /** Returns the new message, in the destination chat. */
    forward: (messageId: string, input: ForwardInput) =>
      request<MessageDto>('POST', `/api/messages/${enc(messageId)}/forward`, input),
    /** The team's shared star: true marks, false removes. */
    favorite: (messageId: string, on: boolean) =>
      request<MessageDto>(on ? 'PUT' : 'DELETE', `/api/messages/${enc(messageId)}/favorite`),
  },
  notes: {
    /** Spec 2026-10-19 §3: the note leaves the chat for everyone (editing is api.messages.edit). */
    remove: (messageId: string) => request<void>('DELETE', `/api/notes/${enc(messageId)}`),
  },
  stickers: {
    recent: () => request<RecentStickerDto[]>('GET', '/api/stickers/recent'),
  },
  contacts: {
    list: (q: ContactListQuery = {}) => request<Page<ContactDto>>('GET', `/api/contacts${qs(q)}`),
    /** A plain link target: the browser downloads the CSV with the session cookie (admins only). */
    exportUrl: (q: Omit<ContactListQuery, 'cursor' | 'limit'> = {}) => `/api/contacts/export.csv${qs(q)}`,
    create: (input: ContactInput) => request<ContactDto>('POST', '/api/contacts', input),
    get: (id: string) => request<ContactDto>('GET', `/api/contacts/${enc(id)}`),
    update: (id: string, input: ContactInput) => request<ContactDto>('PATCH', `/api/contacts/${enc(id)}`, input),
    block: (id: string, blocked: boolean) => request<ContactDto>('POST', `/api/contacts/${enc(id)}/block`, { blocked }),
    setTags: (id: string, tagIds: string[]) => request<ContactDto>('PUT', `/api/contacts/${enc(id)}/tags`, { tagIds }),
    setFields: (id: string, fields: Record<string, string>) =>
      request<ContactDto>('PUT', `/api/contacts/${enc(id)}/fields`, fields),
    chats: (id: string) => request<ChatListItem[]>('GET', `/api/contacts/${enc(id)}/chats`),
    notes: (id: string) => request<ContactNoteDto[]>('GET', `/api/contacts/${enc(id)}/notes`),
    addNote: (id: string, body: string) => request<ContactNoteDto>('POST', `/api/contacts/${enc(id)}/notes`, { body }),
    updateNote: (id: string, noteId: string, patch: { body?: string; pinned?: boolean }) =>
      request<ContactNoteDto>('PATCH', `/api/contacts/${enc(id)}/notes/${enc(noteId)}`, patch),
    deleteNote: (id: string, noteId: string) => request<void>('DELETE', `/api/contacts/${enc(id)}/notes/${enc(noteId)}`),
  },
  sectors: crud<SectorDto, SectorInput>('/api/sectors'),
  tags: crud<TagDto, TagInput>('/api/tags'),
  customFields: crud<CustomFieldDto, CustomFieldInput>('/api/custom-fields'),
  users: crud<UserDto, UserInput>('/api/users'),
  quickAnswers: {
    ...crud<QuickAnswerDto, QuickAnswerInput | FormData>('/api/quick-answers'),
    render: (id: string, chatId: string) =>
      request<{ text: string }>('POST', `/api/quick-answers/${enc(id)}/render`, { chatId }),
    attachmentUrl: (id: string) => `/api/quick-answers/${enc(id)}/attachment`,
  },
  settings: {
    get: () => request<SettingsDto>('GET', '/api/settings'),
    put: (s: SettingsDto) => request<SettingsDto>('PUT', '/api/settings', s),
  },
  channels: {
    list: () => request<ChannelDto[]>('GET', '/api/channels'),
    create: (name: string) => request<ChannelDto>('POST', '/api/channels', { name }),
    /** `historyPeriod`: what the automatic import after this QR copies (history spec §5.1). */
    connect: (id: string, historyPeriod?: HistoryPeriod) =>
      request<{ qrBase64: string | null }>('POST', `/api/channels/${enc(id)}/connect`, historyPeriod ? { historyPeriod } : undefined),
    importHistory: (id: string, period: HistoryPeriod) => request<ChannelDto>('POST', `/api/channels/${enc(id)}/history-import`, { period }),
  },
  bots: {
    list: () => request<BotDto[]>('GET', '/api/bots'),
    create: (input: { name: string; description?: string }) => request<BotDto>('POST', '/api/bots', input),
    get: (id: string) => request<BotDto>('GET', `/api/bots/${enc(id)}`),
    update: (id: string, patch: BotPatch) => request<BotDto>('PATCH', `/api/bots/${enc(id)}`, patch),
    remove: (id: string) => request<void>('DELETE', `/api/bots/${enc(id)}`),
    duplicate: (id: string) => request<BotDto>('POST', `/api/bots/${enc(id)}/duplicate`),
    versions: (id: string) => request<BotVersionSummaryDto[]>('GET', `/api/bots/${enc(id)}/versions`),
    version: (id: string, n: number) => request<BotVersionDto>('GET', `/api/bots/${enc(id)}/versions/${n}`),
    saveVersion: (id: string, input: SaveVersionInput) => request<BotVersionDto>('POST', `/api/bots/${enc(id)}/versions`, input),
    setStatus: (id: string, status: 'active' | 'paused') => request<BotDto>('POST', `/api/bots/${enc(id)}/status`, { status }),
    importBot: (data: BotExport) => request<BotDto>('POST', '/api/bots/import', data),
    exportUrl: (id: string) => `/api/bots/${enc(id)}/export`,
    uploadMedia: (file: Blob, name?: string) => {
      const form = new FormData();
      form.append('file', file, name ?? (file instanceof File ? file.name : 'arquivo'));
      return request<BotMediaDto>('POST', '/api/bots/media', form);
    },
    fromTemplate: (input: OfficeTemplateInput) => request<BotDto>('POST', '/api/bots/from-template', input),
    manual: () => request<ManualBotDto[]>('GET', '/api/bots/manual'),
  },
  botRuns: {
    listForChat: (chatId: string) => request<BotRunDto[]>('GET', `/api/chats/${enc(chatId)}/bot-runs`),
    start: (chatId: string, botId: string) => request<BotRunDto>('POST', `/api/chats/${enc(chatId)}/bot-runs`, { botId }),
    stop: (runId: string) => request<BotRunDto>('POST', `/api/bot-runs/${enc(runId)}/stop`),
  },
});

/** React Query keys. Everything chat-related lives under ['chats'] so one invalidation refreshes it all. */
export const qk = {
  me: ['me'] as const,
  chats: ['chats'] as const,
  chatLists: ['chats', 'list'] as const,
  chatList: (f: ChatListFilters) => ['chats', 'list', f] as const,
  chat: (id: string) => ['chats', 'detail', id] as const,
  timeline: (id: string) => ['chats', 'timeline', id] as const,
  /** Every anchored timeline of a chat (prefix); one per message jumped to (spec 2026-10-19 §4). */
  timelineAnchors: (chatId: string) => ['chats', 'timeline', chatId, 'at'] as const,
  timelineAt: (chatId: string, messageId: string) => ['chats', 'timeline', chatId, 'at', messageId] as const,
  chatSearch: (chatId: string, q: string) => ['chats', 'search', chatId, q] as const,
  chatFavorites: (chatId: string) => ['chats', 'favorites', chatId] as const,
  /** Under ['chats'] so the WS reconnect invalidation refreshes it too. */
  messageEdits: (messageId: string) => ['chats', 'edits', messageId] as const,
  recentStickers: ['chats', 'stickers'] as const,
  contacts: ['contacts'] as const,
  contactList: (q: ContactListQuery) => ['contacts', 'list', q] as const,
  contact: (id: string) => ['contacts', 'detail', id] as const,
  contactChats: (id: string) => ['contacts', 'chats', id] as const,
  contactNotes: (id: string) => ['contacts', 'notes', id] as const,
  sectors: ['sectors'] as const,
  tags: ['tags'] as const,
  customFields: ['custom-fields'] as const,
  users: ['users'] as const,
  quickAnswers: ['quick-answers'] as const,
  settings: ['settings'] as const,
  channels: ['channels'] as const,
  bots: ['bots'] as const,
  bot: (id: string) => ['bots', 'detail', id] as const,
  botVersions: (id: string) => ['bots', 'versions', id] as const,
  botVersion: (id: string, n: number) => ['bots', 'versions', id, n] as const,
  botManual: ['bots', 'manual'] as const,
  /** Under ['chats'] so the WS reconnect invalidation refreshes it too. */
  chatBotRuns: (chatId: string) => ['chats', 'bot-runs', chatId] as const,
};
