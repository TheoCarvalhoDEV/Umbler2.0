import { useState, type FormEvent } from 'react';
import { ArrowDownIcon, ArrowUpIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import type { SectorDto } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { ErrorText, Loading, Section, btn, btnPrimary, send, useSend } from '../../components/settings/common';

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

  function rename(s: SectorDto) {
    // ponytail: native prompt for a one-field rename
    const next = window.prompt('Novo nome do setor', s.name)?.trim();
    if (next && next !== s.name) save.mutate(() => send(`/api/sectors/${s.id}`, 'PATCH', { name: next }));
  }

  function remove(s: SectorDto) {
    if (window.confirm(`Excluir o setor "${s.name}"?`)) save.mutate(() => send(`/api/sectors/${s.id}`, 'DELETE'));
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
          className="flex-1 rounded border border-border px-2 py-1.5 text-sm"
        />
        <button type="submit" disabled={!name.trim() || save.isPending} className={btnPrimary}>
          Adicionar setor
        </button>
      </form>
      <ErrorText error={save.error} />
      <p className="mb-2 text-xs text-muted">
        O setor padrão recebe as conversas novas. A ordem é a usada nas listas e filtros.
      </p>
      <ul className="divide-y divide-border rounded border border-border">
        {sorted.map((s, i) => (
          <li key={s.id} className="flex items-center gap-2 px-3 py-2 text-sm">
            <span className="flex-1">
              {s.name}
              {s.isDefault && <span className="ml-2 rounded-full bg-primary/20 px-2 py-0.5 text-xs text-primary">Padrão</span>}
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
            {!s.isDefault && (
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
