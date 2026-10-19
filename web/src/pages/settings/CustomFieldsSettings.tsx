import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { CustomFieldDto } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { ErrorText, Loading, Section, btn, btnPrimary, send, useSend } from '../../components/settings/common';
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
      <form onSubmit={create} className="mb-4 flex gap-2">
        <input
          aria-label="Nome do novo campo"
          placeholder="Nome do campo (ex.: CPF, Número do processo)"
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          className="flex-1 rounded border border-field px-2 py-1.5 text-sm"
        />
        <select aria-label="Tipo do novo campo" value={kind} onChange={(e) => setKind(e.target.value as CustomFieldDto['kind'])} className="rounded border border-field px-2 py-1.5 text-sm">
          {Object.entries(KINDS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <button type="submit" disabled={!name.trim() || save.isPending} className={btnPrimary}>
          Criar campo
        </button>
      </form>
      <ErrorText error={save.error} />
      {sorted.length === 0 && <p className="text-sm text-muted">Nenhum campo personalizado.</p>}
      <ul className="divide-y divide-border rounded border border-border">
        {sorted.map((f) => (
          <li key={f.id} className="flex items-center gap-2 px-3 py-2 text-sm">
            <span className="flex-1">{f.name}</span>
            <span className="w-20 text-muted">{KINDS[f.kind]}</span>
            <button type="button" onClick={() => rename(f)} className={btn}>
              Renomear
            </button>
            <button type="button" onClick={() => remove(f)} className={btn}>
              Excluir
            </button>
          </li>
        ))}
      </ul>
    </Section>
  );
}
