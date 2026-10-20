import { useEffect, useState, type UIEvent } from 'react';
import { Outlet, useNavigate, useParams } from 'react-router';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowsDownUp, CheckSquare, Eye, EyeSlash, Funnel, MagnifyingGlass, Plus } from '@phosphor-icons/react';
import {
  BULK_MAX, CHAT_SORTS, DEFAULT_CHAT_SORT, type ChatListFilters, type ChatListItem as ChatItem, type ChatSort, type ChatTab,
} from '@talk/shared';
import { api, ApiError, qk } from '../lib/api';
import { useMe } from '../lib/auth';
import { confirmDialog } from '../lib/confirm';
import { BulkBar } from '../components/inbox/BulkBar';
import { ChatListItem } from '../components/inbox/ChatListItem';
import { FilterPanel } from '../components/inbox/FilterPanel';
import { NewChatDialog } from '../components/inbox/NewChatDialog';
import {
  buildChatQuery, CHAT_SORT_LABELS, EMPTY_FILTERS, readChatSort, saveChatSort, withSort, type InboxFilters,
} from '../components/inbox/chat-query';

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
  // one banner for all row/header actions: the last error wins, any success clears it
  const [actionError, setActionError] = useState<string | null>(null);
  const me = useMe().data;
  // spec 2026-10-20 §3: per user, kept in this browser
  const [sort, setSort] = useState<ChatSort>(() => readChatSort(me?.id));
  // spec 2026-10-20 §4: selection mode, the selected ids and the last bulk result line
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [notice, setNotice] = useState<string | null>(null);

  const sectors = useQuery({ queryKey: qk.sectors, queryFn: api.sectors.list });
  const users = useQuery({ queryKey: qk.users, queryFn: api.users.list });
  const tags = useQuery({ queryKey: qk.tags, queryFn: api.tags.list });
  const channels = useQuery({ queryKey: qk.channels, queryFn: api.channels.list });
  const channelList = channels.data ?? [];
  // History spec §7: the channel shows on the card only when there is more than one
  const channelName = new Map<string, string>(channelList.length > 1 ? channelList.map((c): [string, string] => [c.id, c.name]) : []);
  const sectorName = new Map((sectors.data ?? []).map((s) => [s.id, s.name]));
  const userById = new Map((users.data ?? []).map((u) => [u.id, u]));
  const tagById = new Map((tags.data ?? []).map((t) => [t.id, t]));
  const badges: Record<ChatTab, number> = { inbox: useUnreadChats('inbox'), waiting: useUnreadChats('waiting'), closed: 0 };

  const list = useChatList(withSort(buildChatQuery(tab, q, filters), sort));
  const chats = list.data?.pages.flatMap((p) => p.items) ?? [];

  // a new list (tab, search, filters, order) starts an empty selection
  useEffect(() => setSelected(new Set()), [tab, q, filters, sort]);
  // Review Focus 7: a chat that left the list (WS, someone else's transfer) drops out of the count and of the request
  const selectedIds = chats.filter((c) => selected.has(c.id)).map((c) => c.id);
  const toggleSelected = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  function stopSelecting() {
    setSelecting(false);
    setSelected(new Set());
  }
  function changeSort(next: ChatSort) {
    setSort(next);
    saveChatSort(me?.id, next);
  }

  const pin = useMutation({
    mutationFn: (chat: ChatItem) => api.chats.pin(chat.id, !chat.pinned),
    onSuccess: () => {
      setActionError(null);
      // pins are per user: refetch this user's lists (pinned chats sort first)
      return qc.invalidateQueries({ queryKey: qk.chatLists });
    },
    onError: (err) =>
      setActionError(
        err instanceof ApiError && err.status === 409
          ? 'Você já fixou 3 conversas. Desafixe uma para fixar outra.'
          : err instanceof Error
            ? err.message
            : 'Não foi possível concluir. Tente de novo.',
      ),
  });

  const failed = (err: unknown) => setActionError(err instanceof Error ? err.message : 'Não foi possível concluir. Tente de novo.');
  const refreshLists = () => {
    setActionError(null);
    return qc.invalidateQueries({ queryKey: qk.chatLists });
  };
  const markUnread = useMutation({ mutationFn: api.chats.markUnread, onSuccess: refreshLists, onError: failed });
  // chat.removed (WS) drops it from every list too; the refetch covers a socket that is reconnecting
  const remove = useMutation({
    mutationFn: api.chats.remove,
    onSuccess: (_data, id) => {
      if (id === activeId) navigate('/chats');
      return refreshLists();
    },
    onError: failed,
  });

  async function confirmRemove(id: string) {
    const ok = await confirmDialog({
      title: 'Excluir conversa?',
      body: 'A conversa, as mensagens e os arquivos dela saem do sistema para todos. O WhatsApp do contato e o celular não mudam. Não dá para desfazer.',
      confirmLabel: 'Excluir',
    });
    if (ok) remove.mutate(id);
  }

  // Admin-only "Ver todos os setores": the server re-reads it on every request, so refetch what it filters.
  const view = useMutation({
    mutationFn: api.auth.setView,
    onError: () => setActionError('Não foi possível alterar a visualização. Tente novamente.'),
    onSuccess: (next) => {
      setActionError(null);
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
      <aside className="flex w-[360px] shrink-0 flex-col border-r border-border bg-surface">
        <div className="flex items-center gap-1 pt-4 pr-3 pl-5">
          <h1 className="mr-auto text-xl font-semibold tracking-tight">Conversas</h1>
          {me?.role === 'admin' && (
            <button
              type="button"
              aria-label="Ver todos os setores"
              aria-pressed={me.seeAllSectors}
              title={me.seeAllSectors ? 'Vendo todos os setores' : 'Vendo só os seus setores'}
              disabled={view.isPending}
              onClick={() => view.mutate(!me.seeAllSectors)}
              className={`flex size-10 items-center justify-center rounded-lg hover:bg-sidebar-hover ${me.seeAllSectors ? 'bg-primary-soft text-link' : 'text-muted'}`}
            >
              {me.seeAllSectors ? <Eye size={20} /> : <EyeSlash size={20} />}
            </button>
          )}
          <button
            type="button"
            aria-pressed={selecting}
            onClick={() => {
              setNotice(null);
              if (selecting) stopSelecting();
              else setSelecting(true);
            }}
            className={`flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium hover:bg-sidebar-hover ${selecting ? 'bg-primary-soft text-link' : 'text-muted'}`}
          >
            <CheckSquare size={16} aria-hidden /> Selecionar
          </button>
          <button
            type="button"
            aria-label="Nova conversa"
            title="Nova conversa"
            onClick={() => setShowNew(true)}
            className="flex h-9 items-center gap-1.5 rounded-lg bg-primary pr-3 pl-2.5 text-sm font-semibold text-white hover:bg-primary-hover"
          >
            <Plus size={16} weight="bold" aria-hidden /> Nova
          </button>
        </div>

        <div role="tablist" className="mx-4 mt-3 flex gap-0.5 rounded-xl bg-panel p-[3px]">
          {TABS.map(({ tab: t, label }) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg text-sm ${
                tab === t ? 'bg-surface font-semibold text-fg shadow-sm' : 'font-medium text-muted hover:text-fg'
              }`}
            >
              {label}
              {badges[t] > 0 && (
                <span
                  aria-label={`Conversas não lidas: ${badges[t]}`}
                  className={`min-w-5 rounded-full px-1.5 text-[11px] font-bold ${t === 'waiting' ? 'bg-brass-soft text-brass' : 'bg-primary text-white'}`}
                >
                  {badges[t]}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 px-4 pt-3 pb-2">
          <label className="flex h-10 flex-1 items-center gap-2 rounded-lg border border-border bg-surface px-3 focus-within:ring-2 focus-within:ring-primary">
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
          <label
            title={`Ordenar: ${CHAT_SORT_LABELS[sort]}`}
            className={`relative flex size-10 shrink-0 items-center justify-center rounded-lg border border-border hover:bg-sidebar-hover focus-within:ring-2 focus-within:ring-primary ${sort === DEFAULT_CHAT_SORT ? 'text-muted' : 'text-link'}`}
          >
            <ArrowsDownUp size={18} aria-hidden />
            {/* the native list, invisible over the icon: keyboard, screen readers and phones get the real <select> */}
            <select
              aria-label="Ordenar conversas"
              value={sort}
              onChange={(e) => changeSort(e.target.value as ChatSort)}
              className="absolute inset-0 cursor-pointer opacity-0"
            >
              {CHAT_SORTS.map((s) => (
                <option key={s} value={s}>
                  {CHAT_SORT_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            aria-label="Filtrar conversas"
            aria-expanded={showFilters}
            onClick={() => setShowFilters((v) => !v)}
            className={`relative flex size-10 items-center justify-center rounded-lg border border-border hover:bg-sidebar-hover ${activeFilters ? 'text-link' : 'text-muted'}`}
          >
            <Funnel size={18} weight={activeFilters ? 'fill' : 'regular'} />
            {activeFilters > 0 && (
              <span aria-hidden className="absolute -top-1.5 -right-1.5 flex size-4 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-white">
                {activeFilters}
              </span>
            )}
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
        {actionError && (
          <p role="alert" className="mx-3 mb-2 rounded bg-danger/15 px-3 py-2 text-sm text-danger">
            {actionError}
          </p>
        )}
        {notice && (
          <p role="status" className="mx-3 mb-2 rounded bg-panel px-3 py-2 text-sm text-fg">
            {notice}
          </p>
        )}

        <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2" onScroll={onScroll}>
          {me?.role === 'admin' && !me.seeAllSectors && me.sectorIds.length === 0 && (
            <li className="px-4 pb-4 text-sm text-muted">
              Você não está em nenhum setor. Ative “Ver todos os setores” para ver as conversas do escritório.
            </li>
          )}
          {chats.map((c) => (
            <ChatListItem
              key={c.id}
              chat={c}
              active={c.id === activeId}
              sectorName={sectorName.get(c.sectorId) ?? null}
              channelName={channelName.get(c.channelId) ?? null}
              owner={c.ownerId ? (userById.get(c.ownerId) ?? null) : null}
              tagById={tagById}
              selection={
                selecting
                  ? {
                      selected: selected.has(c.id),
                      disabled: !selected.has(c.id) && selectedIds.length >= BULK_MAX,
                      onToggle: () => toggleSelected(c.id),
                    }
                  : undefined
              }
              onOpen={() => navigate(`/chats/${c.id}`)}
              onTogglePin={() => pin.mutate(c)}
              onMarkUnread={() => {
                // leave first: the open pane marks a chat read as soon as it sees unread > 0
                if (c.id === activeId) navigate('/chats');
                markUnread.mutate(c.id);
              }}
              onOpenWith={(acao) => navigate(`/chats/${c.id}?acao=${acao}`)}
              onDelete={me?.role === 'admin' ? () => void confirmRemove(c.id) : undefined}
            />
          ))}
          {list.isPending && <li className="p-4 text-sm text-muted">Carregando…</li>}
          {list.isError && <li className="p-4 text-sm text-danger">Não foi possível carregar as conversas.</li>}
          {list.isSuccess && chats.length === 0 && <li className="p-4 text-sm text-muted">Nenhuma conversa</li>}
          {list.isFetchingNextPage && <li className="p-4 text-sm text-muted">Carregando…</li>}
        </ul>

        {selecting && (
          <BulkBar
            chatIds={selectedIds}
            tab={tab}
            onCancel={stopSelecting}
            onResult={(summary, failedIds) => {
              setNotice(summary);
              void qc.invalidateQueries({ queryKey: qk.chatLists });
              // all done: leave the mode; otherwise keep only what failed, to retry or look at
              if (failedIds.length) setSelected(new Set(failedIds));
              else stopSelecting();
            }}
          />
        )}
      </aside>

      <section className="min-w-0 flex-1">
        <Outlet />
      </section>

      {showNew && <NewChatDialog sectors={sectors.data ?? []} onClose={() => setShowNew(false)} />}
    </div>
  );
}
