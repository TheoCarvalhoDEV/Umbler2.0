import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Info, Robot } from '@phosphor-icons/react';
import type { MessageDto } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { MessageBubble } from './MessageBubble';
import { TIMELINE_PAGE_SIZE, buildTimelineRows, eventText, mergeTimelinePages, timeOfDay } from './model';

const EDGE_PX = 80;

export function Timeline({ chatId, onReply }: { chatId: string; onReply: (m: MessageDto) => void }) {
  const timeline = useInfiniteQuery({
    queryKey: qk.timeline(chatId),
    queryFn: ({ pageParam }) => api.chats.timeline(chatId, { before: pageParam, limit: TIMELINE_PAGE_SIZE }),
    initialPageParam: undefined as string | undefined,
    // next = older: `before` is the id of the oldest item already loaded (Task 13)
    getNextPageParam: (last) => (last.length < TIMELINE_PAGE_SIZE ? undefined : last[0]?.id),
  });
  const sectors = useQuery({ queryKey: qk.sectors, queryFn: api.sectors.list });
  const users = useQuery({ queryKey: qk.users, queryFn: api.users.list });

  const names = useMemo(
    () => new Map([...(sectors.data ?? []), ...(users.data ?? [])].map((x) => [x.id, x.name] as [string, string])),
    [sectors.data, users.data],
  );
  const rows = useMemo(
    () => buildTimelineRows(mergeTimelinePages(timeline.data?.pages ?? []), new Date()),
    [timeline.data],
  );

  const ref = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const loadingOlder = useRef(false);
  const prevHeight = useRef(0);

  // Opening, new messages while at the bottom → scroll to the end.
  // Older page prepended → keep the same message under the user's eyes.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (loadingOlder.current) {
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

  function onScroll() {
    const el = ref.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < EDGE_PX;
    if (el.scrollTop < EDGE_PX && timeline.hasNextPage && !timeline.isFetchingNextPage) {
      loadingOlder.current = true;
      prevHeight.current = el.scrollHeight;
      void timeline.fetchNextPage();
    }
  }

  return (
    <div ref={ref} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto bg-sidebar py-3">
      {timeline.isFetchingNextPage && <p className="py-2 text-center text-xs text-muted">Carregando mensagens anteriores…</p>}
      {timeline.isPending && <p className="py-6 text-center text-sm text-muted">Carregando…</p>}
      {timeline.isError && <p className="py-6 text-center text-sm text-danger">Não foi possível carregar a conversa.</p>}
      {rows.map((row) => {
        if (row.kind === 'date') {
          return (
            <div key={row.key} className="my-3 flex justify-center">
              <span className="rounded-full bg-panel px-3 py-0.5 text-xs text-muted shadow-sm">{row.label}</span>
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
        return <MessageBubble key={row.key} m={item} onReply={onReply} />;
      })}
    </div>
  );
}
