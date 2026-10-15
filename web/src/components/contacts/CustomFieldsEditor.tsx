import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ContactDto } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { FIELD_INPUT_TYPE, Field, inputClass } from './ContactForm';

/** Inline edit: each input saves on blur when its value changed. Always sends the full map. */
export function CustomFieldsEditor({ contact }: { contact: ContactDto }) {
  const qc = useQueryClient();
  const defs = useQuery({ queryKey: qk.customFields, queryFn: () => api.customFields.list() });
  const save = useMutation({
    mutationFn: (fields: Record<string, string>) => api.contacts.setFields(contact.id, fields),
    onSuccess: (dto) => qc.setQueryData(qk.contact(dto.id), dto),
  });

  if (!defs.data?.length) return <p className="text-sm text-muted">Nenhum campo personalizado.</p>;
  return (
    <div className="space-y-3">
      {defs.data.map((f) => {
        const current = contact.fields[f.id] ?? '';
        return (
          <Field key={f.id} label={f.name}>
            <input
              key={current}
              defaultValue={current}
              type={FIELD_INPUT_TYPE[f.kind]}
              className={inputClass}
              onBlur={(e) => {
                const value = e.target.value.trim();
                if (value !== current) save.mutate({ ...contact.fields, [f.id]: value });
              }}
            />
          </Field>
        );
      })}
      {save.error && <p role="alert" className="text-xs text-danger">{save.error.message}</p>}
    </div>
  );
}
