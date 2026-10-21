import { useDeferredValue, useState } from 'react';
import { useNavigate } from 'react-router';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { CaretDown, DownloadSimple, MagnifyingGlass, Plus } from '@phosphor-icons/react';
import { tagColorHex } from '@talk/shared';
import { api, qk, type ContactListQuery } from '../lib/api';
import { useCurrentUser } from '../lib/auth';
import { Avatar } from '../components/Avatar';
import { ContactPanel } from '../components/contacts/ContactPanel';
import { formatPhone } from '../lib/format';
import { badge, badgeTone, button, card, pageTitle, searchInput, searchPill } from '../components/ui';

/** Filter select drawn as a pill (label + value + caret), like the search beside it. */
const pillSelect =
  'relative flex h-[42px] items-center gap-2 rounded-full bg-panel pl-4 text-muted focus-within:ring-2 focus-within:ring-primary';
const pillSelectControl = 'h-full appearance-none bg-transparent pr-[38px] font-bold text-fg outline-none';
const pillCaret = 'pointer-events-none absolute right-3.5 text-fg-2';
const th = 'h-10 px-2.5 text-xs font-semibold text-muted';
const meta = 'text-[13px] whitespace-nowrap text-muted';

export function ContactsPage() {
  const navigate = useNavigate();
  const me = useCurrentUser();
  const [q, setQ] = useState('');
  const [tagId, setTagId] = useState('');
  const [blocked, setBlocked] = useState<NonNullable<ContactListQuery['blocked']>>('');
  const [openId, setOpenId] = useState<string | null>(null);
  const search = useDeferredValue(q.trim());
  const tags = useQuery({ queryKey: qk.tags, queryFn: () => api.tags.list() });
  const tagById = new Map((tags.data ?? []).map((t) => [t.id, t]));
  const filters = { q: search, tagId, blocked };
  const list = useInfiniteQuery({
    queryKey: qk.contactList(filters),
    initialPageParam: '',
    // api's qs() drops empty strings, so '' means "no filter" / "first page".
    queryFn: ({ pageParam }) => api.contacts.list({ ...filters, cursor: pageParam, limit: 50 }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const contacts = list.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className={`${card} flex h-full flex-col gap-[18px] overflow-y-auto px-[18px] py-[22px]`}>
      <div className="flex flex-wrap items-center gap-2.5">
        <h1 className={`${pageTitle} mr-auto`}>Contatos</h1>
        {me.role === 'admin' && (
          <a href={api.contacts.exportUrl(filters)} download className={button('secondary')}>
            <DownloadSimple size={16} aria-hidden /> Exportar
          </a>
        )}
        <button type="button" onClick={() => navigate('/contacts/new')} className={button('primary')}>
          <Plus size={16} weight="bold" aria-hidden /> Novo contato
        </button>
      </div>

      <div className="flex flex-wrap gap-2.5">
        <label className={`${searchPill} max-w-[460px] min-w-60 flex-1`}>
          <span className="sr-only">Buscar por nome, telefone ou CPF</span>
          <MagnifyingGlass size={16} aria-hidden />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar por nome, telefone ou CPF"
            className={searchInput}
          />
        </label>
        <label className={pillSelect}>
          <span>Etiqueta</span>
          <select value={tagId} onChange={(e) => setTagId(e.target.value)} className={pillSelectControl}>
            <option value="">Todas</option>
            {tags.data?.map((t) => (
              <option key={t.id} value={t.id}>
                {t.emoji ? `${t.emoji} ` : ''}
                {t.name}
              </option>
            ))}
          </select>
          <CaretDown size={16} aria-hidden className={pillCaret} />
        </label>
        <label className={pillSelect}>
          <span>Situação</span>
          <select
            value={blocked}
            onChange={(e) => setBlocked(e.target.value as typeof blocked)}
            className={pillSelectControl}
          >
            <option value="">Todos</option>
            <option value="false">Ativos</option>
            <option value="true">Bloqueados</option>
          </select>
          <CaretDown size={16} aria-hidden className={pillCaret} />
        </label>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] border-separate border-spacing-0 text-left text-sm">
          <thead>
            <tr>
              <th scope="col" className={`${th} pl-3`}>Contato</th>
              <th scope="col" className={th}>Telefone</th>
              <th scope="col" className={th}>Etiquetas</th>
              <th scope="col" className={th}>E-mail</th>
              <th scope="col" className={`${th} pr-3 text-right`}>Criado em</th>
            </tr>
          </thead>
          <tbody>
            {contacts.map((c, i) => {
              const open = c.id === openId;
              // Cells carry the row's fill so the first and last can round it (a <tr> cannot). The divider
              // above a filled row (selected, hovered) and the one below it are hidden so the pill reads clean.
              const afterOpen = i > 0 && contacts[i - 1].id === openId;
              const cell = `border-t px-2.5 py-1 group-first:border-transparent group-hover:border-transparent [tr:hover+tr>&]:border-transparent ${
                open || afterOpen ? 'border-transparent' : 'border-border'
              } ${open ? 'bg-sidebar-active' : 'group-hover:bg-sidebar-hover'}`;
              return (
                <tr key={c.id} onClick={() => setOpenId(c.id)} className="group cursor-pointer">
                  <td className={`${cell} h-[60px] rounded-l-item pl-3`}>
                    <button
                      type="button"
                      aria-current={open || undefined}
                      className="flex items-center gap-3 text-left"
                      onClick={() => setOpenId(c.id)}
                    >
                      <Avatar name={c.name} src={c.avatarUrl} className="size-9 text-[13px]" />
                      <span className="flex flex-col items-start gap-0.5">
                        <span className={c.name ? 'font-bold' : 'font-semibold text-muted'}>{c.name || 'Sem nome'}</span>
                        {c.blocked && <span className={`${badge} ${badgeTone.danger}`}>Bloqueado</span>}
                      </span>
                    </button>
                  </td>
                  <td className={`${cell} ${meta} tabular-nums`}>{formatPhone(c.phone) || '—'}</td>
                  <td className={cell}>
                    <span className="flex flex-wrap gap-1">
                      {c.tagIds.flatMap((id) => tagById.get(id) ?? []).map((t) => (
                        <span
                          key={t.id}
                          className="inline-flex h-6 items-center gap-1.5 rounded-full bg-panel px-2.5 text-xs font-bold whitespace-nowrap text-fg-2"
                        >
                          {/* the tag color is user data, shown as a dot */}
                          <span aria-hidden className="size-[7px] rounded-full" style={{ background: tagColorHex(t.color) }} />
                          {t.emoji ? `${t.emoji} ` : ''}
                          {t.name}
                        </span>
                      ))}
                    </span>
                  </td>
                  <td className={`${cell} ${meta}`}>{c.email ?? '—'}</td>
                  <td className={`${cell} ${meta} rounded-r-item pr-3 text-right tabular-nums`}>
                    {new Date(c.createdAt).toLocaleDateString('pt-BR')}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {list.isPending && <p className="p-6 text-center text-sm text-muted">Carregando…</p>}
        {list.isSuccess && contacts.length === 0 && <p className="p-6 text-center text-sm text-muted">Nenhum contato encontrado.</p>}
        {list.isError && <p className="p-6 text-center text-sm text-danger">{list.error.message}</p>}
      </div>
      {list.hasNextPage && (
        <div className="flex justify-center">
          <button
            type="button"
            disabled={list.isFetchingNextPage}
            onClick={() => list.fetchNextPage()}
            className={button('ghost')}
          >
            Carregar mais
          </button>
        </div>
      )}

      {openId && <ContactPanel contactId={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}
