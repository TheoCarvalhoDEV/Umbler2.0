import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import type { ChannelDto, ChatDetail, ChatListItem, MessageDto, TimelineItem } from '@talk/shared';
import { qk, type ChatListData, type TimelineData } from './api';
import { applyWsEvent, connectWs, onWsEvent } from './ws';

const chat = (id: string, over: Partial<ChatListItem> = {}): ChatListItem => ({
  id,
  contact: { id: `ct-${id}`, name: `Contato ${id}`, phone: '5565999990000' },
  channelId: 'ch1',
  sectorId: 's1',
  ownerId: null,
  state: 'open',
  waiting: true,
  private: false,
  unread: 1,
  lastMessageAt: '2026-10-14T10:00:00.000Z',
  lastMessagePreview: 'oi',
  pinned: false,
  tagIds: [],
  ...over,
});

const msg = (id: string, sentAt: string, over: Partial<MessageDto> = {}): MessageDto => ({
  id,
  chatId: 'c1',
  direction: 'in',
  kind: 'text',
  body: 'oi',
  media: null,
  mediaUnavailable: false,
  authorId: null,
  authorName: null,
  replyTo: null,
  reaction: null,
  status: 'sent',
  error: null,
  sentAt,
  ...over,
});

const item = (m: MessageDto): TimelineItem => ({ type: 'message', ...m });

function seedList(qc: QueryClient, items: ChatListItem[]) {
  const key = qk.chatList({ tab: 'inbox' });
  qc.setQueryData<ChatListData>(key, { pages: [{ items, nextCursor: null }], pageParams: [undefined] });
  return key;
}

describe('applyWsEvent', () => {
  it('chat.updated replaces the item in place and marks lists stale for the server to re-order', () => {
    const qc = new QueryClient();
    const key = seedList(qc, [chat('a'), chat('b')]);
    applyWsEvent(qc, { type: 'chat.updated', chat: chat('b', { unread: 5 }) });
    expect(qc.getQueryData<ChatListData>(key)!.pages[0]!.items.map((c) => c.unread)).toEqual([1, 5]);
    expect(qc.getQueryState(key)!.isInvalidated).toBe(true);
  });

  it('chat.updated merges into the detail and refetches it only when the state changed', () => {
    const qc = new QueryClient();
    const detail: ChatDetail = { ...chat('a'), triagePending: true, createdAt: '2026-10-14T09:00:00.000Z', closedAt: null };
    qc.setQueryData(qk.chat('a'), detail);
    applyWsEvent(qc, { type: 'chat.updated', chat: chat('a', { ownerId: 'u1' }) });
    const after = qc.getQueryData<ChatDetail>(qk.chat('a'))!;
    expect(after.ownerId).toBe('u1');
    expect(after.triagePending).toBe(true);
    expect(qc.getQueryState(qk.chat('a'))!.isInvalidated).toBe(false);
    applyWsEvent(qc, { type: 'chat.updated', chat: chat('a', { state: 'closed' }) });
    expect(qc.getQueryState(qk.chat('a'))!.isInvalidated).toBe(true);
  });

  it('chat.removed drops the chat from lists, detail and timeline', () => {
    const qc = new QueryClient();
    const key = seedList(qc, [chat('a'), chat('b')]);
    qc.setQueryData(qk.chat('b'), { ...chat('b'), triagePending: false, createdAt: '2026-10-14T09:00:00.000Z', closedAt: null });
    qc.setQueryData<TimelineData>(qk.timeline('b'), { pages: [[]], pageParams: [undefined] });
    applyWsEvent(qc, { type: 'chat.removed', chatId: 'b' });
    expect(qc.getQueryData<ChatListData>(key)!.pages[0]!.items.map((c) => c.id)).toEqual(['a']);
    expect(qc.getQueryData(qk.chat('b'))).toBeUndefined();
    expect(qc.getQueryData(qk.timeline('b'))).toBeUndefined();
  });

  it('chat.removed notifies an open conversation so it stops showing stale data', async () => {
    const qc = new QueryClient();
    qc.setQueryData(qk.chat('b'), { ...chat('b'), triagePending: false, createdAt: '2026-10-14T09:00:00.000Z', closedAt: null });
    const observer = new QueryObserver(qc, {
      queryKey: qk.chat('b'), queryFn: () => Promise.reject(new Error('Não encontrado')), retry: false, staleTime: Infinity,
    });
    const listener = vi.fn();
    const unsubscribe = observer.subscribe(listener);
    applyWsEvent(qc, { type: 'chat.removed', chatId: 'b' });
    expect(listener).toHaveBeenCalled();
    expect(observer.getCurrentResult().data).toBeUndefined();
    await vi.waitFor(() => expect(observer.getCurrentResult().isError).toBe(true));
    unsubscribe();
  });

  it('chat.updated refetches an open detail that has no data (shown as unavailable) so it can recover', async () => {
    const qc = new QueryClient();
    const detail: ChatDetail = { ...chat('b'), triagePending: false, createdAt: '2026-10-14T09:00:00.000Z', closedAt: null };
    let visible = false;
    const observer = new QueryObserver(qc, {
      queryKey: qk.chat('b'),
      queryFn: () => (visible ? Promise.resolve(detail) : Promise.reject(new Error('Não encontrado'))),
      retry: false,
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => {});
    await vi.waitFor(() => expect(observer.getCurrentResult().isError).toBe(true));
    visible = true; // transferred back to me
    applyWsEvent(qc, { type: 'chat.updated', chat: chat('b') });
    await vi.waitFor(() => expect(observer.getCurrentResult().data?.id).toBe('b'));
    unsubscribe();
  });

  it('message.created keeps arrival order for messages with the same sentAt', () => {
    const qc = new QueryClient();
    qc.setQueryData<TimelineData>(qk.timeline('c1'), { pages: [[]], pageParams: [undefined] });
    const t = '2026-10-14T10:00:00.000Z';
    applyWsEvent(qc, { type: 'message.created', message: msg('zz', t) });
    applyWsEvent(qc, { type: 'message.created', message: msg('aa', t) });
    expect(qc.getQueryData<TimelineData>(qk.timeline('c1'))!.pages[0]!.map((i) => i.id)).toEqual(['zz', 'aa']);
  });

  it('chat.removed for an unknown chat is a no-op', () => {
    const qc = new QueryClient();
    const key = seedList(qc, [chat('a')]);
    applyWsEvent(qc, { type: 'chat.removed', chatId: 'zzz' });
    expect(qc.getQueryData<ChatListData>(key)!.pages[0]!.items).toHaveLength(1);
  });

  it('message events upsert the cached timeline in time order without duplicates', () => {
    const qc = new QueryClient();
    const event: TimelineItem = {
      type: 'event', id: 'e1', chatId: 'c1', kind: 'created', data: {}, authorName: null, createdAt: '2026-10-14T09:00:00.000Z',
    };
    const newest = [event, item(msg('m1', '2026-10-14T10:00:00.000Z'))];
    const older = [item(msg('m0', '2026-10-14T08:00:00.000Z'))];
    qc.setQueryData<TimelineData>(qk.timeline('c1'), { pages: [newest, older], pageParams: [undefined, 'm1'] });

    // late-arriving message lands between the event and m1
    applyWsEvent(qc, { type: 'message.created', message: msg('m2', '2026-10-14T09:30:00.000Z') });
    // the same message delivered twice (POST response + WS) is not duplicated
    applyWsEvent(qc, { type: 'message.created', message: msg('m2', '2026-10-14T09:30:00.000Z', { status: 'delivered' }) });
    let data = qc.getQueryData<TimelineData>(qk.timeline('c1'))!;
    expect(data.pages[0]!.map((i) => i.id)).toEqual(['e1', 'm2', 'm1']);
    expect((data.pages[0]![1] as TimelineItem & { status: string }).status).toBe('delivered');

    // update on an older page (reaction)
    applyWsEvent(qc, { type: 'message.updated', message: msg('m0', '2026-10-14T08:00:00.000Z', { reaction: '👍' }) });
    data = qc.getQueryData<TimelineData>(qk.timeline('c1'))!;
    expect((data.pages[1]![0] as TimelineItem & { reaction: string | null }).reaction).toBe('👍');

    // update for a message not loaded is ignored
    applyWsEvent(qc, { type: 'message.updated', message: msg('zzz', '2026-10-01T08:00:00.000Z') });
    expect(qc.getQueryData<TimelineData>(qk.timeline('c1'))!.pages.flat()).toHaveLength(4);
  });

  it('message.created for a timeline that is not cached does nothing', () => {
    const qc = new QueryClient();
    applyWsEvent(qc, { type: 'message.created', message: msg('m1', '2026-10-14T10:00:00.000Z', { chatId: 'other' }) });
    expect(qc.getQueryData(qk.timeline('other'))).toBeUndefined();
  });

  it('channel.status replaces by id and appends new channels', () => {
    const qc = new QueryClient();
    const ch = (id: string, status: ChannelDto['status']): ChannelDto => ({ id, name: `Canal ${id}`, status, phone: null });
    qc.setQueryData<ChannelDto[]>(qk.channels, [ch('1', 'connected')]);
    applyWsEvent(qc, { type: 'channel.status', channel: ch('1', 'disconnected') });
    applyWsEvent(qc, { type: 'channel.status', channel: ch('2', 'connecting') });
    expect(qc.getQueryData<ChannelDto[]>(qk.channels)!.map((c) => `${c.id}:${c.status}`)).toEqual([
      '1:disconnected',
      '2:connecting',
    ]);
  });
});

describe('connectWs', () => {
  class FakeWs {
    static instances: FakeWs[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    closed = false;
    constructor(public url: string) {
      FakeWs.instances.push(this);
    }
    close() {
      this.closed = true;
    }
  }

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    FakeWs.instances = [];
  });

  it('reconnects with 1s→2s→… backoff, resets on open, applies events, stops on cleanup', () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWs);
    const qc = new QueryClient();
    const key = seedList(qc, [chat('a'), chat('b')]);
    const stop = connectWs(qc, 'ws://test/ws');
    expect(FakeWs.instances).toHaveLength(1);
    expect(FakeWs.instances[0]!.url).toBe('ws://test/ws');

    FakeWs.instances[0]!.onclose!();
    vi.advanceTimersByTime(999);
    expect(FakeWs.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWs.instances).toHaveLength(2);

    FakeWs.instances[1]!.onclose!();
    vi.advanceTimersByTime(1999);
    expect(FakeWs.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeWs.instances).toHaveLength(3);

    // open resets the delay and invalidates every chat query (reload, no replay)
    FakeWs.instances[2]!.onopen!();
    expect(qc.getQueryState(key)!.isInvalidated).toBe(true);
    FakeWs.instances[2]!.onmessage!({ data: JSON.stringify({ type: 'chat.removed', chatId: 'b' }) });
    FakeWs.instances[2]!.onmessage!({ data: 'not json' }); // ignored, no throw
    expect(qc.getQueryData<ChatListData>(key)!.pages[0]!.items.map((c) => c.id)).toEqual(['a']);
    FakeWs.instances[2]!.onclose!();
    vi.advanceTimersByTime(1000);
    expect(FakeWs.instances).toHaveLength(4);

    stop();
    expect(FakeWs.instances[3]!.closed).toBe(true);
    FakeWs.instances[3]!.onclose!();
    vi.advanceTimersByTime(60_000);
    expect(FakeWs.instances).toHaveLength(4);
  });

  it('delivers parsed events to onWsEvent listeners until unsubscribed', () => {
    vi.stubGlobal('WebSocket', FakeWs);
    const qc = new QueryClient();
    const seen: unknown[] = [];
    const off = onWsEvent((ev) => seen.push(ev));
    const stop = connectWs(qc, 'ws://test/ws');
    FakeWs.instances[0]!.onmessage!({ data: JSON.stringify({ type: 'chat.removed', chatId: 'b' }) });
    FakeWs.instances[0]!.onmessage!({ data: 'not json' });
    expect(seen).toEqual([{ type: 'chat.removed', chatId: 'b' }]);
    off();
    FakeWs.instances[0]!.onmessage!({ data: JSON.stringify({ type: 'chat.removed', chatId: 'c' }) });
    expect(seen).toHaveLength(1);
    stop();
  });
});
