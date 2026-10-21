import { useId, useState, type FormEvent } from 'react';
import { ArrowDownIcon, ArrowUpIcon, PlusIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import type { SectorDto } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { badge, badgeTone, field, fieldLabel, iconButton } from '../../components/ui';
import { ErrorText, Loading, Section, block, btnDanger, btnPrimary, btnSecondary, listRow, send, useSend } from '../../components/settings/common';
import { confirmDialog, promptDialog } from '../../lib/confirm';

const openChatsLabel = (n: number) => (n === 0 ? 'Nenhuma conversa aberta' : n === 1 ? '1 conversa aberta' : `${n} conversas abertas`);

export function SectorsSettings() {
  const list = useQuery({ queryKey: qk.sectors, queryFn: api.sectors.list });
  const save = useSend(qk.sectors);
  const [name, setName] = useState('');
  const nameId = useId();

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
      <form onSubmit={create} className={`${block} mb-5`}>
        <label htmlFor={nameId} className={fieldLabel}>
          Nome do novo setor
        </label>
        <div className="flex flex-wrap items-center gap-2.5">
          <input
            id={nameId}
            aria-label="Nome do novo setor"
            placeholder="Nome do setor"
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            className={`${field} min-w-0 flex-[1_1_240px]`}
          />
          <button type="submit" disabled={!name.trim() || save.isPending} className={btnPrimary}>
            <PlusIcon size={16} weight="bold" aria-hidden />
            Adicionar setor
          </button>
        </div>
      </form>
      <ErrorText error={save.error} />
      <p className="mb-2 text-[13px] leading-[18px] text-muted">
        O setor padrão recebe as conversas novas. A ordem é a usada nas listas e filtros.
      </p>
      <ul>
        {sorted.map((s, i) => (
          <li key={s.id} className={listRow}>
            <span className="grid size-7 shrink-0 place-items-center rounded-full bg-panel text-xs font-bold text-fg-2 tabular-nums">{i + 1}</span>
            <span className="flex min-w-0 flex-[1_1_180px] flex-col gap-0.5">
              <span className="flex items-center gap-2 font-bold">
                {s.name}
                {s.isDefault && <span className={`${badge} ${badgeTone.accent}`}>Padrão</span>}
              </span>
              <span className="text-[13px] leading-[18px] text-muted">{openChatsLabel(s.openChats ?? 0)}</span>
            </span>
            <span className="flex flex-wrap items-center gap-2">
              <button type="button" aria-label={`Subir ${s.name}`} disabled={i === 0 || save.isPending} onClick={() => move(i, -1)} className={iconButton}>
                <ArrowUpIcon size={18} />
              </button>
              <button
                type="button"
                aria-label={`Descer ${s.name}`}
                disabled={i === sorted.length - 1 || save.isPending}
                onClick={() => move(i, 1)}
                className={iconButton}
              >
                <ArrowDownIcon size={18} />
              </button>
              {s.isDefault ? (
                // keeps the slot so Renomear/Excluir line up with the other rows
                <span aria-hidden="true" className={`${btnSecondary} invisible`}>
                  Definir como padrão
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => save.mutate(() => send(`/api/sectors/${s.id}`, 'PATCH', { isDefault: true }))}
                  className={btnSecondary}
                >
                  Definir como padrão
                </button>
              )}
              <button type="button" onClick={() => rename(s)} className={btnSecondary}>
                Renomear
              </button>
              <button type="button" disabled={s.isDefault} title={s.isDefault ? 'O setor padrão não pode ser excluído' : undefined} onClick={() => remove(s)} className={btnDanger}>
                Excluir
              </button>
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}
