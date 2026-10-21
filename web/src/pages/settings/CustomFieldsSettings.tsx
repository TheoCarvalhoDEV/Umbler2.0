import { useId, useState, type FormEvent } from 'react';
import { BuildingsIcon, CalendarBlankIcon, HashIcon, IdentificationCardIcon, PlusIcon, TextAaIcon, type Icon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import type { CustomFieldDto } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { field, fieldLabel, fieldSelect } from '../../components/ui';
import { Actions, Modal } from '../../components/conversation/ChatDialogs';
import { EmptyState, ErrorText, ListRow, Loading, PageHeader, RowMenu, btnPrimary, send, useSend } from '../../components/settings/common';
import { confirmDialog, promptDialog } from '../../lib/confirm';

const KINDS: Record<CustomFieldDto['kind'], { label: string; icon: Icon }> = {
  text: { label: 'Texto', icon: TextAaIcon },
  number: { label: 'Número', icon: HashIcon },
  date: { label: 'Data', icon: CalendarBlankIcon },
  cpf: { label: 'CPF', icon: IdentificationCardIcon },
  cnpj: { label: 'CNPJ', icon: BuildingsIcon },
};

export function CustomFieldsSettings() {
  const list = useQuery({ queryKey: qk.customFields, queryFn: api.customFields.list });
  const save = useSend(qk.customFields);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<CustomFieldDto['kind']>('text');
  const nameId = useId();
  const kindId = useId();

  if (!list.data) return <Loading error={list.error} />;
  const sorted = [...list.data].sort((a, b) => a.position - b.position);

  function openCreate() {
    save.reset();
    setName('');
    setKind('text');
    setCreating(true);
  }

  function create(e?: FormEvent) {
    e?.preventDefault();
    if (!name.trim() || save.isPending) return;
    save.mutate(() => send('/api/custom-fields', 'POST', { name: name.trim(), kind }), { onSuccess: () => setCreating(false) });
  }

  async function rename(f: CustomFieldDto) {
    const next = await promptDialog({
      title: 'Renomear campo',
      body: `Respostas rápidas que usam {{campo.${f.name}}} precisam ser ajustadas.`,
      label: 'Nome do campo',
      initial: f.name,
      confirmLabel: 'Salvar',
      maxLength: 60,
    });
    if (next) save.mutate(() => send(`/api/custom-fields/${f.id}`, 'PATCH', { name: next }));
  }

  async function remove(f: CustomFieldDto) {
    const body = 'Os valores preenchidos nos contatos serão apagados.';
    if (await confirmDialog({ title: `Excluir o campo "${f.name}"?`, body, confirmLabel: 'Excluir campo' })) {
      save.mutate(() => send(`/api/custom-fields/${f.id}`, 'DELETE'));
    }
  }

  return (
    <>
      <PageHeader
        title="Campos personalizados"
        description="Dados extras do contato, como CPF ou número do processo. Dá para usá-los nas respostas rápidas."
        action={
          <button type="button" onClick={openCreate} className={btnPrimary}>
            <PlusIcon size={16} weight="bold" aria-hidden />
            Novo campo
          </button>
        }
      />
      {creating && (
        <Modal title="Novo campo" onCancel={() => setCreating(false)}>
          <form onSubmit={create} className="space-y-4">
            <div>
              <label htmlFor={nameId} className={fieldLabel}>
                Nome do campo
              </label>
              <input
                id={nameId}
                placeholder="Ex.: CPF, Número do processo"
                value={name}
                maxLength={60}
                onChange={(e) => setName(e.target.value)}
                className={field}
              />
            </div>
            <div>
              <label htmlFor={kindId} className={fieldLabel}>
                Tipo
              </label>
              <select id={kindId} value={kind} onChange={(e) => setKind(e.target.value as CustomFieldDto['kind'])} className={fieldSelect}>
                {Object.entries(KINDS).map(([value, k]) => (
                  <option key={value} value={value}>
                    {k.label}
                  </option>
                ))}
              </select>
            </div>
            <Actions
              busy={!name.trim() || save.isPending}
              error={save.error?.message ?? null}
              confirmLabel="Criar campo"
              onCancel={() => setCreating(false)}
              onConfirm={create}
            />
          </form>
        </Modal>
      )}
      {!creating && <ErrorText error={save.error} />}
      {sorted.length === 0 ? (
        <EmptyState icon={<TextAaIcon size={28} />} title="Nenhum campo personalizado" hint="Crie o primeiro em “Novo campo”." />
      ) : (
        <ul className="mt-5">
          {sorted.map((f) => {
            const KindIcon = KINDS[f.kind].icon;
            return (
              <ListRow
                key={f.id}
                leading={<KindIcon size={20} aria-hidden />}
                title={f.name}
                subtitle={KINDS[f.kind].label}
                actions={
                  <RowMenu
                    label={`Opções do campo ${f.name}`}
                    items={[
                      { label: 'Renomear', onSelect: () => rename(f) },
                      { label: 'Excluir', onSelect: () => remove(f), danger: true },
                    ]}
                  />
                }
              />
            );
          })}
        </ul>
      )}
    </>
  );
}
