import { useEffect, useRef } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type { ChannelDto, ChatDetail, ChatListItem, TimelineItem, WsEvent } from '@talk/shared';
import { qk, type ChatListData, type TimelineData } from './api';

const listeners = new Set<(ev: WsEvent) => void>();

/** Subscribe to every server event (after the cache is updated). Returns the unsubscribe function. */
export function onWsEvent(fn: (ev: WsEvent) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Hook form of onWsEvent; always calls the latest `fn` without resubscribing. */
export function useWsEvent(fn: (ev: WsEvent) => void): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => onWsEvent((e) => ref.current(e)), []);
}

function mapChatLists(qc: QueryClient, fn: (items: ChatListItem[]) => ChatListItem[]): void {
  qc.setQueriesData<ChatListData>({ queryKey: qk.chatLists }, (d) =>
    d && { ...d, pages: d.pages.map((p) => ({ ...p, items: fn(p.items) })) },
  );
}

const at = (i: TimelineItem) => Date.parse(i.type === 'message' ? i.sentAt : i.createdAt);
// No id tie-break: the sort is stable, so same-second messages keep the server's arrival order.
const byTime = (a: TimelineItem, b: TimelineItem) => at(a) - at(b);

function upsertTimeline(d: TimelineData, next: TimelineItem, insert: boolean): TimelineData {
  let found = false;
  const pages = d.pages.map((p) =>
    p.map((i) => {
      if (i.type === 'message' && i.id === next.id) {
        found = true;
        return next;
      }
      return i;
    }),
  );
  if (found) return { ...d, pages };
  if (!insert) return d;
  pages[0] = [...(pages[0] ?? []), next].sort(byTime); // pages[0] is the newest page
  return { ...d, pages };
}

/** Pure cache reducer for one server event. Exported for tests and for tasks that need to apply a DTO the same way. */
export function applyWsEvent(qc: QueryClient, ev: WsEvent): void {
  switch (ev.type) {
    case 'chat.updated': {
      const chat = ev.chat;
      mapChatLists(qc, (items) => items.map((c) => (c.id === chat.id ? chat : c)));
      // ponytail: tab/filter membership and order stay server-side — lists refetch (active ones only).
      // Client-side insert/sort if refetch load ever matters (3–10 agents today).
      void qc.invalidateQueries({ queryKey: qk.chatLists });
      const prev = qc.getQueryData<ChatDetail>(qk.chat(chat.id));
      if (prev) {
        qc.setQueryData<ChatDetail>(qk.chat(chat.id), { ...prev, ...chat });
        // closedAt / triagePending are not in ChatListItem: refetch when the state flips
        if (prev.state !== chat.state) void qc.invalidateQueries({ queryKey: qk.chat(chat.id), exact: true });
        // no data: a pane showing "não disponível" (e.g. after chat.removed) recovers when the chat comes back
      } else void qc.invalidateQueries({ queryKey: qk.chat(chat.id), exact: true });
      return;
    }
    case 'chat.removed':
      mapChatLists(qc, (items) => items.filter((c) => c.id !== ev.chatId));
      // reset, not remove: removeQueries does not notify observers, so an open pane would keep stale data.
      // Active ones refetch, get 404 and show the unavailable state.
      void qc.resetQueries({ queryKey: qk.chat(ev.chatId), exact: true });
      void qc.resetQueries({ queryKey: qk.timeline(ev.chatId), exact: true });
      return;
    case 'message.created':
    case 'message.updated': {
      const item: TimelineItem = { type: 'message', ...ev.message };
      qc.setQueryData<TimelineData>(qk.timeline(ev.message.chatId), (d) =>
        d && upsertTimeline(d, item, ev.type === 'message.created'),
      );
      return;
    }
    case 'channel.status': {
      const ch = ev.channel;
      qc.setQueryData<ChannelDto[]>(qk.channels, (list) =>
        list && (list.some((c) => c.id === ch.id) ? list.map((c) => (c.id === ch.id ? ch : c)) : [...list, ch]),
      );
      return;
    }
    case 'notification':
      return; // nothing to cache; the toasts (Task 16) subscribe through useWsEvent
    case 'users.changed':
      // a picture changed: the agent list, the chats (owner/author pictures) and my own menu refetch
      void qc.invalidateQueries({ queryKey: qk.users });
      void qc.invalidateQueries({ queryKey: qk.chats });
      void qc.invalidateQueries({ queryKey: qk.me });
      return;
  }
}

function defaultWsUrl(): string {
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;
}

/** Opens /ws, reconnects with 1s→30s backoff, returns a stop function. */
export function connectWs(qc: QueryClient, url: string = defaultWsUrl()): () => void {
  let ws: WebSocket | null = null;
  let delay = 1000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const open = () => {
    ws = new WebSocket(url);
    ws.onopen = () => {
      delay = 1000;
      // no replay on the server: reload everything chat-related and the channel banner
      void qc.invalidateQueries({ queryKey: qk.chats });
      void qc.invalidateQueries({ queryKey: qk.channels });
    };
    ws.onmessage = (e: MessageEvent) => {
      let ev: WsEvent;
      try {
        ev = JSON.parse(String(e.data)) as WsEvent;
      } catch {
        return;
      }
      applyWsEvent(qc, ev);
      listeners.forEach((l) => l(ev));
    };
    ws.onclose = () => {
      if (stopped) return;
      // a deactivated user is disconnected by the server: re-check the session so RequireAuth can redirect
      void qc.invalidateQueries({ queryKey: qk.me });
      timer = setTimeout(open, delay);
      delay = Math.min(delay * 2, 30_000);
    };
  };

  open();
  return () => {
    stopped = true;
    clearTimeout(timer);
    ws?.close();
  };
}
