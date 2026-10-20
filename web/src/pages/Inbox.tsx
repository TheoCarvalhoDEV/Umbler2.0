import { useEffect, useState, type UIEvent } from 'react';
import { Outlet, useNavigate, useParams } from 'react-router';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, EyeSlash, Funnel, MagnifyingGlass, Plus } from '@phosphor-icons/react';
import type { ChatListFilters, ChatListItem as ChatItem, ChatTab } from '@talk/shared';
import { api, ApiError, qk } from '../lib/api';
import { useMe } from '../lib/auth';
import { confirmDialog } from '../lib/confirm';
import { ChatListItem } from '../components/inbox/ChatListItem';
import { FilterPanel } from '../components/inbox/FilterPanel';
import { NewChatDialog } from '../components/inbox/NewChatDialog';
import { buildChatQuery, EMPTY_FILTERS, type InboxFilters } from '../components/inbox/chat-query';
import { card, iconButton, iconButtonOn, iconButtonPrimary, pageTitle, searchInput, searchPill, tab as tabClass, tabList } from '../components/ui';

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

  const sectors = useQuery({ queryKey: qk.sectors, queryFn: api.sectors.list });
  const users = useQuery({ queryKey: qk.users, queryFn: api.users.list });
  const tags = useQuery({ queryKey: qk.tags, queryFn: api.tags.list });
  const channels = useQuery({ queryKey: qk.channels, queryFn: api.channels.list });
  const channelList = channels.data ?? [];
  // History spec §7: the channel shows on the card only when there is more than one
  const channelName = new Map<string, string>(channelList.length > 1 ? channelList.map((c): [string, string] => [c.id, c.name]) : []);
  const sectorName = new Map((sectors.data ?? []).map((s) => [s.id, s.name]));
  const userById = new Map((users.data ?? []).map((u) => [u.id, u]));
  const badges: Record<ChatTab, number> = { inbox: useUnreadChats('inbox'), waiting: useUnreadChats('waiting'), closed: 0 };

  const list = useChatList(buildChatQuery(tab, q, filters));
  const chats = list.data?.pages.flatMap((p) => p.items) ?? [];

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
    <div className="flex h-full min-h-0 gap-3">
      <aside className={`${card} flex w-[352px] shrink-0 flex-col overflow-hidden`}>
        <div className="flex min-h-0 flex-col gap-3.5 overflow-y-auto px-[18px] pt-5 pb-3">
          <div className="flex items-center gap-2">
            <h1 className={`${pageTitle} mr-auto`}>Conversas</h1>
            {me?.role === 'admin' && (
              <button
                type="button"
                aria-label="Ver todos os setores"
                aria-pressed={me.seeAllSectors}
                title={me.seeAllSectors ? 'Vendo todos os setores' : 'Vendo só os seus setores'}
                disabled={view.isPending}
                onClick={() => view.mutate(!me.seeAllSectors)}
                className={me.seeAllSectors ? iconButtonOn : iconButton}
              >
                {me.seeAllSectors ? <Eye size={18} /> : <EyeSlash size={18} />}
              </button>
            )}
            <button
              type="button"
              aria-label="Nova conversa"
              title="Nova conversa"
              onClick={() => setShowNew(true)}
              className={iconButtonPrimary}
            >
              <Plus size={18} weight="bold" aria-hidden />
            </button>
          </div>

          <div className="flex items-center gap-2">
            <label className={`${searchPill} flex-1`}>
              <MagnifyingGlass size={16} aria-hidden="true" className="shrink-0" />
              <input
                type="search"
                aria-label="Buscar conversas"
                placeholder="Buscar por nome ou telefone"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className={searchInput}
              />
            </label>
            <button
              type="button"
              aria-label="Filtrar conversas"
              aria-expanded={showFilters}
              onClick={() => setShowFilters((v) => !v)}
              className={`${showFilters ? iconButtonOn : iconButton} relative`}
            >
              <Funnel size={18} weight={activeFilters ? 'fill' : 'regular'} />
              {activeFilters > 0 && (
                <span
                  aria-hidden
                  className="absolute -top-1 -right-1 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-primary px-1 text-[11px] font-bold text-on-primary tabular-nums ring-2 ring-surface"
                >
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

          <div role="tablist" className={tabList}>
            {TABS.map(({ tab: t, label }) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={tabClass(tab === t)}
              >
                {label}
                {badges[t] > 0 && (
                  <span aria-label={`Conversas não lidas: ${badges[t]}`} className="tabular-nums">
                    {badges[t]}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        {actionError && (
          <p role="alert" className="mx-[18px] mb-2 rounded-block bg-danger-soft px-3.5 py-2.5 text-[13px] font-semibold text-danger">
            {actionError}
          </p>
        )}

        <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2.5 pt-1 pb-2.5" onScroll={onScroll}>
          {me?.role === 'admin' && !me.seeAllSectors && me.sectorIds.length === 0 && (
            <li className="mx-1 mb-2 rounded-block bg-sunken px-3.5 py-3 text-[13px] text-muted">
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
          {list.isPending && <li className="px-3 py-10 text-center text-[13px] text-muted">Carregando…</li>}
          {list.isError && (
            <li className="mx-1 rounded-block bg-danger-soft px-3.5 py-2.5 text-[13px] font-semibold text-danger">Não foi possível carregar as conversas.</li>
          )}
          {list.isSuccess && chats.length === 0 && <li className="px-3 py-10 text-center text-[13px] text-muted">Nenhuma conversa</li>}
          {list.isFetchingNextPage && <li className="px-3 py-3 text-center text-[13px] text-muted">Carregando…</li>}
        </ul>
      </aside>

      <section className="min-w-0 flex-1">
        <Outlet />
      </section>

      {showNew && <NewChatDialog sectors={sectors.data ?? []} onClose={() => setShowNew(false)} />}
    </div>
  );
}
