import { useId, useState, type FormEvent } from 'react';
import { PlusIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import type { CustomFieldDto } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { field, fieldLabel, fieldSelect } from '../../components/ui';
import { ErrorText, Loading, Section, block, btnDanger, btnPrimary, btnSecondary, listRow, send, useSend } from '../../components/settings/common';
import { confirmDialog, promptDialog } from '../../lib/confirm';

const KINDS: Record<CustomFieldDto['kind'], string> = {
  text: 'Texto',
  number: 'Número',
  date: 'Data',
  cpf: 'CPF',
  cnpj: 'CNPJ',
};

export function CustomFieldsSettings() {
  const list = useQuery({ queryKey: qk.customFields, queryFn: api.customFields.list });
  const save = useSend(qk.customFields);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<CustomFieldDto['kind']>('text');
  const nameId = useId();

  if (!list.data) return <Loading error={list.error} />;
  const sorted = [...list.data].sort((a, b) => a.position - b.position);

  function create(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    save.mutate(() => send('/api/custom-fields', 'POST', { name: name.trim(), kind }), { onSuccess: () => setName('') });
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
    <Section title="Campos personalizados">
      <form onSubmit={create} className={`${block} mb-5`}>
        <label htmlFor={nameId} className={fieldLabel}>
          Nome do novo campo
        </label>
        <div className="flex flex-wrap items-center gap-2.5">
          <input
            id={nameId}
            aria-label="Nome do novo campo"
            placeholder="Nome do campo (ex.: CPF, Número do processo)"
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            className={`${field} min-w-0 flex-[1_1_240px]`}
          />
          <select aria-label="Tipo do novo campo" value={kind} onChange={(e) => setKind(e.target.value as CustomFieldDto['kind'])} className={`${fieldSelect} max-w-40`}>
            {Object.entries(KINDS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <button type="submit" disabled={!name.trim() || save.isPending} className={btnPrimary}>
            <PlusIcon size={16} weight="bold" aria-hidden />
            Criar campo
          </button>
        </div>
      </form>
      <ErrorText error={save.error} />
      {sorted.length === 0 && <p className="text-sm text-muted">Nenhum campo personalizado.</p>}
      <ul>
        {sorted.map((f) => (
          <li key={f.id} className={listRow}>
            <span className="min-w-0 flex-1 font-bold">{f.name}</span>
            <span className="w-20 text-[13px] text-muted">{KINDS[f.kind]}</span>
            <span className="flex items-center gap-2">
              <button type="button" onClick={() => rename(f)} className={btnSecondary}>
                Renomear
              </button>
              <button type="button" onClick={() => remove(f)} className={btnDanger}>
                Excluir
              </button>
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}
