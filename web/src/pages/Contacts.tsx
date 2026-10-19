import { useDeferredValue, useState } from 'react';
import { useNavigate } from 'react-router';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { DownloadSimple, MagnifyingGlass, Plus } from '@phosphor-icons/react';
import { api, qk, type ContactListQuery } from '../lib/api';
import { useCurrentUser } from '../lib/auth';
import { Avatar } from '../components/Avatar';
import { ContactPanel } from '../components/contacts/ContactPanel';
import { formatPhone } from '../lib/format';

const control = 'h-10 rounded-lg border border-border bg-surface text-sm';

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
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[1240px] flex-col gap-5 px-4 py-6 sm:px-10 sm:py-8">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="mr-auto text-[26px] font-semibold tracking-tight">Contatos</h1>
          {me.role === 'admin' && (
            <a
              href={api.contacts.exportUrl(filters)}
              download
              className={`${control} flex items-center gap-2 px-4 font-semibold text-fg hover:bg-sidebar-hover`}
            >
              <DownloadSimple size={16} aria-hidden /> Exportar
            </a>
          )}
          <button
            type="button"
            onClick={() => navigate('/contacts/new')}
            className="flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-white hover:bg-primary-hover"
          >
            <Plus size={16} weight="bold" aria-hidden /> Novo contato
          </button>
        </div>

        <div className="flex flex-wrap gap-2.5">
          <label className={`${control} flex max-w-[460px] min-w-60 flex-1 items-center gap-2 px-3 focus-within:ring-2 focus-within:ring-primary`}>
            <span className="sr-only">Buscar por nome, telefone ou CPF</span>
            <MagnifyingGlass size={16} aria-hidden className="text-muted" />
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Buscar por nome, telefone ou CPF"
              className="w-full bg-transparent outline-none placeholder:text-muted"
            />
          </label>
          <label className={`${control} flex items-center gap-2 pl-3`}>
            <span className="text-muted">Etiqueta</span>
            <select value={tagId} onChange={(e) => setTagId(e.target.value)} className="h-full bg-transparent pr-2 font-semibold outline-none">
              <option value="">Todas</option>
              {tags.data?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.emoji ? `${t.emoji} ` : ''}
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label className={`${control} flex items-center gap-2 pl-3`}>
            <span className="text-muted">Situação</span>
            <select
              value={blocked}
              onChange={(e) => setBlocked(e.target.value as typeof blocked)}
              className="h-full bg-transparent pr-2 font-semibold outline-none"
            >
              <option value="">Todos</option>
              <option value="false">Ativos</option>
              <option value="true">Bloqueados</option>
            </select>
          </label>
        </div>

        <div className="overflow-x-auto rounded-xl border border-border bg-surface">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="text-xs text-muted">
              <tr className="border-b border-border">
                <th className="px-5 py-3 font-semibold">Contato</th>
                <th className="px-4 py-3 font-semibold">Telefone</th>
                <th className="px-4 py-3 font-semibold">Etiquetas</th>
                <th className="px-4 py-3 font-semibold">E-mail</th>
                <th className="px-5 py-3 text-right font-semibold">Criado em</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {contacts.map((c) => (
                <tr key={c.id} onClick={() => setOpenId(c.id)} className="cursor-pointer hover:bg-sidebar-hover">
                  <td className="px-5 py-2.5">
                    <button type="button" className="flex items-center gap-3 text-left" onClick={() => setOpenId(c.id)}>
                      <Avatar name={c.name} src={c.avatarUrl} className="size-9 shrink-0 text-xs bg-panel" />
                      <span>
                        <span className="block font-semibold">{c.name || 'Sem nome'}</span>
                        {c.blocked && (
                          <span className="mt-0.5 inline-block rounded-md bg-danger-soft px-1.5 text-[11px] font-semibold text-danger">Bloqueado</span>
                        )}
                      </span>
                    </button>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-[13px] whitespace-nowrap text-muted">{formatPhone(c.phone) || '—'}</td>
                  <td className="px-4 py-2.5">
                    <span className="flex flex-wrap gap-1">
                      {c.tagIds.flatMap((id) => tagById.get(id) ?? []).map((t) => (
                        <span key={t.id} className="flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-[11px] font-medium">
                          <span aria-hidden className="size-[7px] rounded-full" style={{ background: t.color }} />
                          {t.emoji ? `${t.emoji} ` : ''}
                          {t.name}
                        </span>
                      ))}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-muted">{c.email ?? '—'}</td>
                  <td className="px-5 py-2.5 text-right font-mono text-[13px] whitespace-nowrap text-muted">
                    {new Date(c.createdAt).toLocaleDateString('pt-BR')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.isSuccess && contacts.length === 0 && <p className="p-6 text-center text-sm text-muted">Nenhum contato encontrado.</p>}
          {list.isError && <p className="p-6 text-center text-sm text-danger">{list.error.message}</p>}
          {list.hasNextPage && (
            <div className="border-t border-border p-3 text-center">
              <button
                type="button"
                disabled={list.isFetchingNextPage}
                onClick={() => list.fetchNextPage()}
                className="h-9 rounded-lg px-4 text-sm font-semibold text-link hover:bg-primary-soft disabled:opacity-50"
              >
                Carregar mais
              </button>
            </div>
          )}
        </div>
      </div>

      {openId && <ContactPanel contactId={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}
