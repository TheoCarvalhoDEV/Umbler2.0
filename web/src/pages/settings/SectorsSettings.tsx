import { useState, type FormEvent } from 'react';
import { ArrowDownIcon, ArrowUpIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import type { SectorDto } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { ErrorText, Loading, Section, btn, btnPrimary, send, useSend } from '../../components/settings/common';
import { confirmDialog, promptDialog } from '../../lib/confirm';

const openChatsLabel = (n: number) => (n === 0 ? 'Nenhuma conversa aberta' : n === 1 ? '1 conversa aberta' : `${n} conversas abertas`);

export function SectorsSettings() {
  const list = useQuery({ queryKey: qk.sectors, queryFn: api.sectors.list });
  const save = useSend(qk.sectors);
  const [name, setName] = useState('');

  if (!list.data) return <Loading error={list.error} />;
  const sorted = [...list.data].sort((a, b) => a.position - b.position);

  function create(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    save.mutate(() => send('/api/sectors', 'POST', { name: name.trim() }), { onSuccess: () => setName('') });
  }

  // ponytail: renumbers every row whose position changed (one PATCH each); fine for a handful of sectors
  function move(i: number, dir: -1 | 1) {
    const next = [...sorted];
    [next[i], next[i + dir]] = [next[i + dir]!, next[i]!];
    save.mutate(() =>
      Promise.all(next.map((s, pos) => (s.position === pos ? null : send(`/api/sectors/${s.id}`, 'PATCH', { position: pos })))),
    );
  }

  async function rename(s: SectorDto) {
    const next = await promptDialog({ title: 'Renomear setor', label: 'Nome do setor', initial: s.name, confirmLabel: 'Salvar', maxLength: 60 });
    if (next) save.mutate(() => send(`/api/sectors/${s.id}`, 'PATCH', { name: next }));
  }

  async function remove(s: SectorDto) {
    if (await confirmDialog({ title: `Excluir o setor "${s.name}"?`, confirmLabel: 'Excluir setor' })) save.mutate(() => send(`/api/sectors/${s.id}`, 'DELETE'));
  }

  return (
    <Section title="Setores">
      <form onSubmit={create} className="mb-4 flex gap-2">
        <input
          aria-label="Nome do novo setor"
          placeholder="Nome do setor"
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          className="flex-1 rounded-lg border border-field bg-surface px-3 py-2 text-sm"
        />
        <button type="submit" disabled={!name.trim() || save.isPending} className={btnPrimary}>
          Adicionar setor
        </button>
      </form>
      <ErrorText error={save.error} />
      <p className="mb-2 text-xs text-muted">
        O setor padrão recebe as conversas novas. A ordem é a usada nas listas e filtros.
      </p>
      <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
        {sorted.map((s, i) => (
          <li key={s.id} className="flex flex-wrap items-center gap-2 px-4 py-3 text-sm">
            <span className="w-6 text-center font-mono text-xs text-muted">{i + 1}</span>
            <span className="min-w-40 flex-1">
              <span className="flex items-center gap-2 font-semibold">
                {s.name}
                {s.isDefault && <span className="rounded-md bg-brass-soft px-2 py-0.5 text-[11px] font-semibold text-brass">Padrão</span>}
              </span>
              <span className="text-xs text-muted">{openChatsLabel(s.openChats ?? 0)}</span>
            </span>
            <button type="button" aria-label={`Subir ${s.name}`} disabled={i === 0 || save.isPending} onClick={() => move(i, -1)} className={btn}>
              <ArrowUpIcon size={14} />
            </button>
            <button
              type="button"
              aria-label={`Descer ${s.name}`}
              disabled={i === sorted.length - 1 || save.isPending}
              onClick={() => move(i, 1)}
              className={btn}
            >
              <ArrowDownIcon size={14} />
            </button>
            {s.isDefault ? (
              // keeps the slot so Renomear/Excluir line up with the other rows
              <span aria-hidden="true" className={`${btn} invisible`}>
                Definir como padrão
              </span>
            ) : (
              <button
                type="button"
                onClick={() => save.mutate(() => send(`/api/sectors/${s.id}`, 'PATCH', { isDefault: true }))}
                className={btn}
              >
                Definir como padrão
              </button>
            )}
            <button type="button" onClick={() => rename(s)} className={btn}>
              Renomear
            </button>
            <button type="button" disabled={s.isDefault} title={s.isDefault ? 'O setor padrão não pode ser excluído' : undefined} onClick={() => remove(s)} className={btn}>
              Excluir
            </button>
          </li>
        ))}
      </ul>
    </Section>
  );
}
