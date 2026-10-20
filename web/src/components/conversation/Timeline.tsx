import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ArrowDown, Info, Robot } from '@phosphor-icons/react';
import type { MessageDto } from '@talk/shared';
import { api, qk, type TimelineCursor } from '../../lib/api';
import { MessageBubble } from './MessageBubble';
import {
  FOCUS_HIGHLIGHT_MS, TIMELINE_PAGE_SIZE, buildTimelineRows, eventText, mergeTimelinePages, newerCursor, olderCursor, timeOfDay,
  type TimelineFocus,
} from './model';

const EDGE_PX = 80;

export function Timeline({
  chatId,
  onReply,
  chatOpen = false,
  focus = null,
}: {
  chatId: string;
  onReply: (m: MessageDto) => void;
  /** Spec §2: message actions only in an open chat. */
  chatOpen?: boolean;
  /** Spec 2026-10-19 §4: a search hit or a favorite to bring into view. */
  focus?: TimelineFocus | null;
}) {
  const live = useInfiniteQuery({
    queryKey: qk.timeline(chatId),
    queryFn: ({ pageParam }) => api.chats.timeline(chatId, { before: pageParam, limit: TIMELINE_PAGE_SIZE }),
    initialPageParam: undefined as string | undefined,
    // next = older: `before` is the id of the oldest item already loaded (Task 13)
    getNextPageParam: (last) => (last.length < TIMELINE_PAGE_SIZE ? undefined : last[0]?.id),
  });
  // Anchored mode: the page around a message that is not loaded, paged older (top) and newer (bottom) from there.
  // Its own cache, so the live timeline keeps receiving new messages meanwhile.
  const [anchor, setAnchor] = useState<string | null>(null);
  const anchored = useInfiniteQuery({
    queryKey: qk.timelineAt(chatId, anchor ?? ''),
    queryFn: ({ pageParam }) => api.chats.timeline(chatId, { ...pageParam, limit: TIMELINE_PAGE_SIZE }),
    initialPageParam: { around: anchor ?? '' } as TimelineCursor,
    getNextPageParam: (page, _all, param) => olderCursor(page, param, TIMELINE_PAGE_SIZE),
    getPreviousPageParam: (page, _all, param) => newerCursor(page, param, TIMELINE_PAGE_SIZE),
    enabled: anchor !== null,
  });
  // ponytail: a refetch of the anchored view restarts from its newer pages (the loaded window is replaced); upgrade: refetch only the edges if that jump bothers users
  const view = anchor ? anchored : live;
  const sectors = useQuery({ queryKey: qk.sectors, queryFn: api.sectors.list });
  const users = useQuery({ queryKey: qk.users, queryFn: api.users.list });

  const names = useMemo(
    () => new Map([...(sectors.data ?? []), ...(users.data ?? [])].map((x) => [x.id, x.name] as [string, string])),
    [sectors.data, users.data],
  );
  const rows = useMemo(() => buildTimelineRows(mergeTimelinePages(view.data?.pages ?? []), new Date()), [view.data]);

  const ref = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const loadingOlder = useRef(false);
  const prevHeight = useRef(0);
  const pendingScroll = useRef<string | null>(null); // a focused message to center once it is rendered
  const [highlight, setHighlight] = useState<string | null>(null);

  const findBubble = (id: string) => ref.current?.querySelector(`[data-message-id="${id}"]`) ?? null;

  // A new focus: center it if it is on screen already, otherwise load the timeline around it.
  useEffect(() => {
    if (!focus) return;
    const id = focus.messageId;
    setHighlight(id);
    stickToBottom.current = false;
    const target = findBubble(id);
    if (target) target.scrollIntoView?.({ block: 'center' });
    else {
      pendingScroll.current = id;
      setAnchor(id);
    }
    const timer = setTimeout(() => setHighlight((h) => (h === id ? null : h)), FOCUS_HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [focus]);

  // Opening, new messages while at the bottom → scroll to the end.
  // Older page prepended → keep the same message under the user's eyes. A focused message → center it.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const target = pendingScroll.current ? findBubble(pendingScroll.current) : null;
    if (target) {
      target.scrollIntoView?.({ block: 'center' });
      pendingScroll.current = null;
    } else if (loadingOlder.current) {
      el.scrollTop += el.scrollHeight - prevHeight.current;
      loadingOlder.current = false;
    } else if (stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
    prevHeight.current = el.scrollHeight;
  }, [rows]);

  // images/videos that finish loading grow the list; stay pinned to the bottom if we were there
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onLoad = () => {
      if (stickToBottom.current) el.scrollTop = el.scrollHeight;
    };
    el.addEventListener('load', onLoad, true); // load does not bubble; capture sees it
    return () => el.removeEventListener('load', onLoad, true);
  }, []);

  function backToLive() {
    setAnchor(null);
    pendingScroll.current = null;
    stickToBottom.current = true;
  }

  // the anchored message is gone (a deleted note): its refetch fails, so leave it for the live view
  useEffect(() => {
    if (anchor !== null && anchored.isError) backToLive();
  }, [anchor, anchored.isError]);

  function onScroll() {
    const el = ref.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < EDGE_PX;
    stickToBottom.current = anchor === null && nearBottom;
    if (el.scrollTop < EDGE_PX && view.hasNextPage && !view.isFetchingNextPage) {
      loadingOlder.current = true;
      prevHeight.current = el.scrollHeight;
      void view.fetchNextPage();
    }
    if (anchor !== null && nearBottom && !anchored.isFetchingPreviousPage) {
      // the newest loaded item of the anchored view: load newer, or hand back to the live timeline at the present
      if (anchored.hasPreviousPage) void anchored.fetchPreviousPage();
      else if (anchored.isSuccess) backToLive();
    }
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={ref} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto bg-sunken px-2 py-4">
        {view.isFetchingNextPage && <p className="py-2 text-center text-xs text-muted">Carregando mensagens anteriores…</p>}
        {view.isPending && <p className="py-6 text-center text-sm text-muted">Carregando…</p>}
        {view.isError && <p className="py-6 text-center text-sm text-danger">Não foi possível carregar a conversa.</p>}
        {rows.map((row) => {
          if (row.kind === 'date') {
            return (
              <div key={row.key} className="my-3 flex justify-center">
                <span className="rounded-full border border-border bg-surface px-3 py-1 text-xs font-semibold text-muted">{row.label}</span>
              </div>
            );
          }
          const item = row.item;
          if (item.type === 'event') {
            return (
              <p key={row.key} className="my-2 flex items-center justify-center gap-1 px-4 text-center text-xs text-muted">
                {item.kind.startsWith('bot_') ? (
                  <Robot size={14} aria-hidden data-bot-event className="shrink-0" />
                ) : (
                  <Info size={14} className="shrink-0" />
                )}
                {eventText(item, names)} · {timeOfDay(item.createdAt)}
              </p>
            );
          }
          return <MessageBubble key={row.key} m={item} onReply={onReply} chatOpen={chatOpen} highlighted={item.id === highlight} />;
        })}
        {anchor !== null && anchored.isFetchingPreviousPage && (
          <p className="py-2 text-center text-xs text-muted">Carregando mensagens seguintes…</p>
        )}
      </div>
      {anchor !== null && (
        <button
          type="button"
          onClick={backToLive}
          className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-surface px-3.5 py-1.5 text-sm font-medium text-fg shadow-lg hover:bg-sidebar-hover"
        >
          <ArrowDown size={14} aria-hidden /> Ir para as mensagens recentes
        </button>
      )}
    </div>
  );
}
