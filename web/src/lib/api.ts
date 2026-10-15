import type { InfiniteData } from '@tanstack/react-query';
import type {
  ChannelDto,
  ChatDetail,
  ChatListFilters,
  ChatListItem,
  ContactDto,
  ContactNoteDto,
  CustomFieldDto,
  Me,
  MessageDto,
  QuickAnswerDto,
  SectorDto,
  SettingsDto,
  TagDto,
  TimelineItem,
  UserDto,
} from '@talk/shared';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public correlationId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
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

export interface StartChatInput { contactId?: string; phone?: string; name?: string; sectorId?: string }
export interface SendTextInput { text: string; signature: boolean; replyToId?: string }
export interface SendFileInput { file: Blob; fileName?: string; text?: string; signature: boolean; replyToId?: string; asVoice?: boolean }
export type ContactInput = Partial<Pick<ContactDto, 'name' | 'phone' | 'email' | 'landline' | 'address'>>;
export interface ContactListQuery { q?: string; tagId?: string; cursor?: string; limit?: number }
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
    throw new ApiError(res.status, cid ? `${msg} (${cid})` : msg, cid);
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
  },
  chats: {
    list: (f: ChatListFilters) => request<ChatPage>('GET', `/api/chats${qs(f)}`),
    start: (input: StartChatInput) => request<ChatDetail>('POST', '/api/chats', input),
    get: (id: string) => request<ChatDetail>('GET', `/api/chats/${enc(id)}`),
    timeline: (id: string, q: { before?: string; limit?: number } = {}) =>
      request<TimelineItem[]>('GET', `/api/chats/${enc(id)}/timeline${qs(q)}`),
    assume: (id: string) => request<ChatDetail>('POST', `/api/chats/${enc(id)}/assume`),
    reopen: (id: string) => request<ChatDetail>('POST', `/api/chats/${enc(id)}/reopen`),
    markRead: (id: string) => request<void>('POST', `/api/chats/${enc(id)}/read`),
    transfer: (id: string, to: { sectorId?: string; ownerId?: string | null }) =>
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
      form.append('file', input.file, input.fileName ?? (input.file instanceof File ? input.file.name : 'arquivo'));
      return request<MessageDto>('POST', `/api/chats/${enc(id)}/messages`, form);
    },
    addNote: (id: string, text: string) => request<MessageDto>('POST', `/api/chats/${enc(id)}/notes`, { text }),
  },
  messages: {
    resend: (messageId: string) => request<MessageDto>('POST', `/api/messages/${enc(messageId)}/resend`),
    mediaUrl: (messageId: string) => `/api/media/${enc(messageId)}`,
  },
  contacts: {
    list: (q: ContactListQuery = {}) => request<Page<ContactDto>>('GET', `/api/contacts${qs(q)}`),
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
    connect: (id: string) => request<{ qrBase64: string | null }>('POST', `/api/channels/${enc(id)}/connect`),
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
};
