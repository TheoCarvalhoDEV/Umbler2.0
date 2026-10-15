import { useState, type FormEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ContactDto, CustomFieldDto } from '@talk/shared';
import { api, qk, type ContactInput } from '../../lib/api';
import { localDigits, maskPhone } from './phone';

// Keys follow Umbler's AddressModel so the importer can copy them unchanged.
export const ADDRESS_FIELDS = [
  ['addressLine1', 'Endereço'],
  ['addressLine2', 'Complemento'],
  ['city', 'Cidade'],
  ['state', 'Estado'],
  ['zipCode', 'CEP'],
  ['country', 'País'],
] as const;

export const FIELD_INPUT_TYPE: Record<CustomFieldDto['kind'], string> = {
  text: 'text', number: 'number', date: 'date', cpf: 'text', cnpj: 'text',
};

export const inputClass =
  'w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none';

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium text-fg">{label}</span>
      {children}
    </label>
  );
}

interface Props {
  contact?: ContactDto;
  onSaved: (contact: ContactDto) => void;
  onCancel: () => void;
}

export function ContactForm({ contact, onSaved, onCancel }: Props) {
  const [name, setName] = useState(contact?.name ?? '');
  const [phone, setPhone] = useState(maskPhone(contact?.phone ?? ''));
  const [landline, setLandline] = useState(maskPhone(contact?.landline ?? ''));
  const [email, setEmail] = useState(contact?.email ?? '');
  const [address, setAddress] = useState<Record<string, string>>(contact?.address ?? {});
  const [fields, setFields] = useState<Record<string, string>>(contact?.fields ?? {});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const customFields = useQuery({ queryKey: qk.customFields, queryFn: () => api.customFields.list() });

  async function submit(e: FormEvent) {
    e.preventDefault();
    const digits = localDigits(phone);
    if (!digits) return setError('Informe o celular.');
    if (digits.length < 10) return setError('Celular inválido: informe DDD e número.');
    const landlineDigits = localDigits(landline);
    const addr: Record<string, string> = Object.fromEntries(
      Object.entries(address).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v),
    );
    const body: ContactInput = {
      name: name.trim() || null,
      phone: '55' + digits,
      email: email.trim() || null,
      landline: landlineDigits ? '55' + landlineDigits : null,
      address: Object.keys(addr).length ? addr : null,
    };
    setSaving(true);
    setError(null);
    try {
      let saved = contact ? await api.contacts.update(contact.id, body) : await api.contacts.create(body);
      if (Object.keys(fields).length) saved = await api.contacts.setFields(saved.id, fields);
      onSaved(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ocorreu um erro');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-6">
      <fieldset className="space-y-3">
        <legend className="mb-2 text-sm font-semibold text-fg">Informações básicas</legend>
        <Field label="Nome">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Celular *">
          <input
            className={inputClass}
            inputMode="tel"
            aria-required="true"
            placeholder="(65) 99999-9999"
            value={phone}
            onChange={(e) => setPhone(maskPhone(e.target.value))}
          />
        </Field>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="mb-2 text-sm font-semibold text-fg">Dados complementares</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Telefone fixo">
            <input
              className={inputClass}
              inputMode="tel"
              placeholder="(65) 3222-1111"
              value={landline}
              onChange={(e) => setLandline(maskPhone(e.target.value))}
            />
          </Field>
          <Field label="E-mail">
            <input className={inputClass} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          {ADDRESS_FIELDS.map(([key, label]) => (
            <Field key={key} label={label}>
              <input
                className={inputClass}
                value={address[key] ?? ''}
                onChange={(e) => setAddress({ ...address, [key]: e.target.value })}
              />
            </Field>
          ))}
        </div>
      </fieldset>

      {!!customFields.data?.length && (
        <fieldset className="space-y-3">
          <legend className="mb-2 text-sm font-semibold text-fg">Campos personalizados</legend>
          {customFields.data.map((f) => (
            <Field key={f.id} label={f.name}>
              <input
                className={inputClass}
                type={FIELD_INPUT_TYPE[f.kind]}
                value={fields[f.id] ?? ''}
                onChange={(e) => setFields({ ...fields, [f.id]: e.target.value })}
              />
            </Field>
          ))}
        </fieldset>
      )}

      {error && <p role="alert" className="text-sm text-danger">{error}</p>}

      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-md px-4 py-2 text-sm hover:bg-sidebar-hover">
          Cancelar
        </button>
        <button
          type="submit"
          disabled={saving}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50"
        >
          Salvar
        </button>
      </div>
    </form>
  );
}
