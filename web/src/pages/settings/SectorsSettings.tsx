import { ArrowDownIcon, ArrowUpIcon, PlusIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import type { SectorDto } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { badge, badgeTone, iconButtonGhost } from '../../components/ui';
import { ErrorText, ListRow, Loading, PageHeader, RowMenu, btnPrimary, send, useSend } from '../../components/settings/common';
import { confirmDialog, promptDialog } from '../../lib/confirm';

const openChatsLabel = (n: number) => (n === 0 ? 'Nenhuma conversa aberta' : n === 1 ? '1 conversa aberta' : `${n} conversas abertas`);

export function SectorsSettings() {
  const list = useQuery({ queryKey: qk.sectors, queryFn: api.sectors.list });
  const save = useSend(qk.sectors);

  if (!list.data) return <Loading error={list.error} />;
  const sorted = [...list.data].sort((a, b) => a.position - b.position);

  async function create() {
    save.reset();
    const name = await promptDialog({ title: 'Novo setor', label: 'Nome do setor', confirmLabel: 'Criar setor', maxLength: 60 });
    if (name) save.mutate(() => send('/api/sectors', 'POST', { name }));
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

  // no empty state: the server always keeps a default sector, and it cannot be deleted
  return (
    <>
      <PageHeader
        title="Setores"
        description="O setor padrão recebe as conversas novas e não pode ser excluído. A ordem é a usada nas listas e filtros."
        action={
          <button type="button" onClick={create} className={btnPrimary}>
            <PlusIcon size={16} weight="bold" aria-hidden />
            Novo setor
          </button>
        }
      />
      <ErrorText error={save.error} />
      <ul className="mt-5">
        {sorted.map((s, i) => (
          <ListRow
            key={s.id}
            leading={<span className="text-sm font-bold tabular-nums">{i + 1}</span>}
            title={s.name}
            badges={s.isDefault && <span className={`${badge} ${badgeTone.accent}`}>Padrão</span>}
            subtitle={openChatsLabel(s.openChats ?? 0)}
            actions={
              <>
                <button type="button" aria-label={`Subir ${s.name}`} title="Subir" disabled={i === 0 || save.isPending} onClick={() => move(i, -1)} className={iconButtonGhost}>
                  <ArrowUpIcon size={18} aria-hidden />
                </button>
                <button
                  type="button"
                  aria-label={`Descer ${s.name}`}
                  title="Descer"
                  disabled={i === sorted.length - 1 || save.isPending}
                  onClick={() => move(i, 1)}
                  className={iconButtonGhost}
                >
                  <ArrowDownIcon size={18} aria-hidden />
                </button>
                <RowMenu
                  label={`Opções do setor ${s.name}`}
                  items={[
                    { label: 'Renomear', onSelect: () => rename(s) },
                    !s.isDefault && { label: 'Definir como padrão', onSelect: () => save.mutate(() => send(`/api/sectors/${s.id}`, 'PATCH', { isDefault: true })) },
                    { label: 'Excluir', onSelect: () => remove(s), danger: true, disabled: s.isDefault },
                  ]}
                />
              </>
            }
          />
        ))}
      </ul>
    </>
  );
}
