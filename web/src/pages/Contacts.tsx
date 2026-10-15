import { useDeferredValue, useState } from 'react';
import { useNavigate } from 'react-router';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { MagnifyingGlass, Plus } from '@phosphor-icons/react';
import { api, qk } from '../lib/api';
import { Avatar, ContactPanel } from '../components/contacts/ContactPanel';
import { formatPhone } from '../lib/format';

export function ContactsPage() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [tagId, setTagId] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const search = useDeferredValue(q.trim());
  const tags = useQuery({ queryKey: qk.tags, queryFn: () => api.tags.list() });
  const list = useInfiniteQuery({
    queryKey: qk.contactList({ q: search, tagId }),
    initialPageParam: '',
    // api's qs() drops empty strings, so '' means "no filter" / "first page".
    queryFn: ({ pageParam }) => api.contacts.list({ q: search, tagId, cursor: pageParam, limit: 50 }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const contacts = list.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="flex h-full flex-col p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-xl font-semibold">Contatos</h1>
        <button
          type="button"
          onClick={() => navigate('/contacts/new')}
          className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover"
        >
          <Plus size={16} /> Adicionar contato
        </button>
      </div>

      <div className="mb-4 flex flex-wrap gap-3">
        <label className="relative min-w-60 flex-1">
          <span className="sr-only">Buscar por nome ou telefone</span>
          <MagnifyingGlass size={16} className="absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar por nome ou telefone"
            className="w-full rounded-md border border-border py-2 pr-3 pl-9 text-sm focus:border-primary focus:outline-none"
          />
        </label>
        <label>
          <span className="sr-only">Filtrar por etiqueta</span>
          <select
            value={tagId}
            onChange={(e) => setTagId(e.target.value)}
            className="rounded-md border border-border px-3 py-2 text-sm"
          >
            <option value="">Todas as etiquetas</option>
            {tags.data?.map((t) => (
              <option key={t.id} value={t.id}>
                {t.emoji ? `${t.emoji} ` : ''}
                {t.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex-1 overflow-auto rounded-md border border-border">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="sticky top-0 bg-panel text-xs uppercase text-muted">
            <tr>
              <th className="px-4 py-2 font-medium">Contato</th>
              <th className="px-4 py-2 font-medium">Telefone</th>
              <th className="px-4 py-2 font-medium">E-mail</th>
              <th className="px-4 py-2 font-medium">Criado em</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {contacts.map((c) => (
              <tr key={c.id} onClick={() => setOpenId(c.id)} className="cursor-pointer hover:bg-sidebar-hover">
                <td className="px-4 py-2">
                  <button type="button" className="flex items-center gap-3 text-left" onClick={() => setOpenId(c.id)}>
                    <Avatar name={c.name} />
                    <span className="font-medium">{c.name || 'Sem nome'}</span>
                    {c.blocked && <span className="text-xs text-danger">Bloqueado</span>}
                  </button>
                </td>
                <td className="px-4 py-2 whitespace-nowrap">{formatPhone(c.phone) || '—'}</td>
                <td className="px-4 py-2">{c.email ?? '—'}</td>
                <td className="px-4 py-2 whitespace-nowrap">{new Date(c.createdAt).toLocaleDateString('pt-BR')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.isSuccess && contacts.length === 0 && (
          <p className="p-6 text-center text-sm text-muted">Nenhum contato encontrado.</p>
        )}
        {list.isError && <p className="p-6 text-center text-sm text-danger">{list.error.message}</p>}
        {list.hasNextPage && (
          <div className="p-3 text-center">
            <button
              type="button"
              disabled={list.isFetchingNextPage}
              onClick={() => list.fetchNextPage()}
              className="rounded-md px-4 py-2 text-sm text-primary hover:bg-primary/15 disabled:opacity-50"
            >
              Carregar mais
            </button>
          </div>
        )}
      </div>

      {openId && <ContactPanel contactId={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}
