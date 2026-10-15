import { useEffect, useState, type UIEvent } from 'react';
import { Outlet, useNavigate, useParams } from 'react-router';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, EyeSlash, Funnel, MagnifyingGlass, Plus } from '@phosphor-icons/react';
import type { ChatListFilters, ChatListItem as ChatItem, ChatTab } from '@talk/shared';
import { api, ApiError, qk } from '../lib/api';
import { useMe } from '../lib/auth';
import { ChatListItem } from '../components/inbox/ChatListItem';
import { FilterPanel } from '../components/inbox/FilterPanel';
import { NewChatDialog } from '../components/inbox/NewChatDialog';
import { buildChatQuery, EMPTY_FILTERS, type InboxFilters } from '../components/inbox/chat-query';

const TABS: Array<{ tab: ChatTab; label: string }> = [
  { tab: 'inbox', label: 'Entrada' },
  { tab: 'waiting', label: 'Esperando' },
  { tab: 'closed', label: 'Finalizados' },
];

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

/** Infinite chat list under qk.chatList(f), pageParam = cursor. applyWsEvent (Task 15) keeps it fresh. */
function useChatList(f: ChatListFilters) {
  return useInfiniteQuery({
    queryKey: qk.chatList(f),
    queryFn: ({ pageParam }) => api.chats.list({ ...f, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

function useUnreadChats(tab: ChatTab): number {
  // ponytail: counts unread chats among the loaded pages (first 50) of the unfiltered tab; add a counts endpoint if a tab ever holds more
  const { data } = useChatList(buildChatQuery(tab, '', EMPTY_FILTERS));
  return data?.pages.flatMap((p) => p.items).filter((c) => c.unread > 0).length ?? 0;
}

export function Inbox() {
  const { id: activeId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [tab, setTab] = useState<ChatTab>('inbox');
  const [search, setSearch] = useState('');
  const q = useDebounced(search, 300);
  const [filters, setFilters] = useState<InboxFilters>(EMPTY_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);
  const me = useMe().data;

  const sectors = useQuery({ queryKey: qk.sectors, queryFn: api.sectors.list });
  const users = useQuery({ queryKey: qk.users, queryFn: api.users.list });
  const tags = useQuery({ queryKey: qk.tags, queryFn: api.tags.list });
  const sectorName = new Map((sectors.data ?? []).map((s) => [s.id, s.name]));
  const userName = new Map((users.data ?? []).map((u) => [u.id, u.name]));
  const badges: Record<ChatTab, number> = { inbox: useUnreadChats('inbox'), waiting: useUnreadChats('waiting'), closed: 0 };

  const list = useChatList(buildChatQuery(tab, q, filters));
  const chats = list.data?.pages.flatMap((p) => p.items) ?? [];

  const pin = useMutation({
    mutationFn: (chat: ChatItem) => api.chats.pin(chat.id, !chat.pinned),
    onSuccess: () => {
      setPinError(null);
      // pins are per user: refetch this user's lists (pinned chats sort first)
      return qc.invalidateQueries({ queryKey: qk.chatLists });
    },
    onError: (err) =>
      setPinError(
        err instanceof ApiError && err.status === 409
          ? 'Você já fixou 3 conversas. Desafixe uma para fixar outra.'
          : err instanceof Error
            ? err.message
            : 'Ocorreu um erro',
      ),
  });

  // Admin-only "Ver todos os setores": the server re-reads it on every request, so refetch what it filters.
  const view = useMutation({
    mutationFn: api.auth.setView,
    onSuccess: (next) => {
      qc.setQueryData(qk.me, next);
      return Promise.all([qc.invalidateQueries({ queryKey: qk.chats }), qc.invalidateQueries({ queryKey: qk.contacts })]);
    },
  });

  function onScroll(e: UIEvent<HTMLUListElement>) {
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 200 && list.hasNextPage && !list.isFetchingNextPage) {
      void list.fetchNextPage();
    }
  }

  const activeFilters = [filters.sectorId, filters.ownerId, filters.tagId].filter(Boolean).length + (filters.period === 'any' ? 0 : 1);

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-96 shrink-0 flex-col border-r border-border">
        <div className="flex items-center gap-2 px-3 pt-3">
          <h1 className="mr-auto text-lg font-semibold">Conversas</h1>
          {me?.role === 'admin' && (
            <button
              type="button"
              aria-label="Ver todos os setores"
              aria-pressed={me.seeAllSectors}
              title={me.seeAllSectors ? 'Vendo todos os setores' : 'Vendo só os seus setores'}
              disabled={view.isPending}
              onClick={() => view.mutate(!me.seeAllSectors)}
              className={`rounded p-1.5 hover:bg-sidebar-hover ${me.seeAllSectors ? 'text-primary' : 'text-muted'}`}
            >
              {me.seeAllSectors ? <Eye size={20} /> : <EyeSlash size={20} />}
            </button>
          )}
          <button
            type="button"
            aria-label="Nova conversa"
            title="Nova conversa"
            onClick={() => setShowNew(true)}
            className="rounded p-1.5 hover:bg-sidebar-hover"
          >
            <Plus size={20} />
          </button>
        </div>

        <div role="tablist" className="mt-2 flex border-b border-border">
          {TABS.map(({ tab: t, label }) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`flex flex-1 items-center justify-center gap-1 py-2 text-sm ${
                tab === t ? 'border-b-2 border-primary font-medium text-fg' : 'text-muted hover:text-fg'
              }`}
            >
              {label}
              {badges[t] > 0 && (
                <span
                  aria-label={`Conversas não lidas: ${badges[t]}`}
                  className="rounded-full bg-primary px-1.5 text-xs font-semibold text-white"
                >
                  {badges[t]}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 p-3">
          <label className="flex flex-1 items-center gap-2 rounded bg-panel px-2">
            <MagnifyingGlass aria-hidden="true" className="text-muted" />
            <input
              type="search"
              aria-label="Buscar conversas"
              placeholder="Buscar por nome ou telefone"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full bg-transparent py-1.5 text-sm outline-none"
            />
          </label>
          <button
            type="button"
            aria-label="Filtrar conversas"
            aria-expanded={showFilters}
            onClick={() => setShowFilters((v) => !v)}
            className={`relative rounded p-1.5 hover:bg-sidebar-hover ${activeFilters ? 'text-primary' : 'text-muted'}`}
          >
            <Funnel size={20} weight={activeFilters ? 'fill' : 'regular'} />
          </button>
        </div>

        {showFilters && (
          <FilterPanel
            value={filters}
            onChange={setFilters}
            sectors={sectors.data ?? []}
            users={users.data ?? []}
            tags={tags.data ?? []}
          />
        )}
        {pinError && (
          <p role="alert" className="mx-3 mb-2 rounded bg-danger/15 px-3 py-2 text-sm text-danger">
            {pinError}
          </p>
        )}

        <ul className="min-h-0 flex-1 overflow-y-auto" onScroll={onScroll}>
          {chats.map((c) => (
            <ChatListItem
              key={c.id}
              chat={c}
              active={c.id === activeId}
              sectorName={sectorName.get(c.sectorId) ?? null}
              ownerName={c.ownerId ? (userName.get(c.ownerId) ?? null) : null}
              onOpen={() => navigate(`/chats/${c.id}`)}
              onTogglePin={() => pin.mutate(c)}
            />
          ))}
          {list.isPending && <li className="p-4 text-sm text-muted">Carregando…</li>}
          {list.isError && <li className="p-4 text-sm text-danger">Não foi possível carregar as conversas.</li>}
          {list.isSuccess && chats.length === 0 && <li className="p-4 text-sm text-muted">Nenhuma conversa</li>}
          {list.isFetchingNextPage && <li className="p-4 text-sm text-muted">Carregando…</li>}
        </ul>
      </aside>

      <section className="min-w-0 flex-1">
        <Outlet />
      </section>

      {showNew && <NewChatDialog sectors={sectors.data ?? []} onClose={() => setShowNew(false)} />}
    </div>
  );
}
