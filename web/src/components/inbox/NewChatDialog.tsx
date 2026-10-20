import { useId, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { ContactDto, SectorDto } from '@talk/shared';
import { api, qk, type StartChatInput } from '../../lib/api';
import { contactLabel } from '../../lib/format';
import { button, dialog, dialogTitle, field, fieldLabel, fieldSelect, menuItem } from '../ui';

interface Props {
  sectors: SectorDto[];
  onClose(): void;
}

/** "+ Nova conversa": pick an existing contact or type a phone (+ optional name), choose sector, POST /api/chats. */
export function NewChatDialog({ sectors, onClose }: Props) {
  const navigate = useNavigate();
  const ids = { text: useId(), name: useId(), sector: useId(), title: useId() };
  const [text, setText] = useState('');
  const [contact, setContact] = useState<ContactDto | null>(null);
  const [name, setName] = useState('');
  const [sectorId, setSectorId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const term = text.trim();

  // ponytail: one request per keystroke (cached per term); debounce if contact search gets slow
  const search = { q: term, limit: 8 };
  const results = useQuery({
    queryKey: qk.contactList(search),
    queryFn: () => api.contacts.list(search),
    enabled: !contact && term.length >= 2,
  });

  const start = useMutation({
    mutationFn: () => {
      const target: StartChatInput = contact
        ? { contactId: contact.id }
        : { phone: term, ...(name.trim() ? { name: name.trim() } : {}) };
      return api.chats.start({ ...target, ...(sectorId ? { sectorId } : {}) });
    },
    onSuccess: (chat) => {
      onClose();
      navigate(`/chats/${chat.id}`);
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Não foi possível concluir. Tente de novo.'),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!contact && term.replace(/\D/g, '').length < 10) {
      setError('Escolha um contato ou digite um telefone com DDD.');
      return;
    }
    start.mutate();
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4" onClick={onClose}>
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby={ids.title}
        onSubmit={submit}
        onKeyDown={onKeyDown}
        onClick={(e) => e.stopPropagation()}
        className={`${dialog} flex flex-col gap-4`}
      >
        <h2 id={ids.title} className={dialogTitle}>Nova conversa</h2>

        {contact ? (
          <div className="flex h-11 items-center gap-2 rounded-block bg-sunken pr-1.5 pl-3.5 text-sm font-semibold tabular-nums">
            <span className="flex-1 truncate">{contactLabel(contact)}</span>
            <button type="button" onClick={() => setContact(null)} className={button('secondary', 'sm')}>Trocar</button>
          </div>
        ) : (
          <>
            <div>
              <label htmlFor={ids.text} className={fieldLabel}>Contato ou telefone</label>
              <input
                id={ids.text}
                autoFocus
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Nome ou (65) 99999-9999"
                className={field}
              />
            </div>
            {results.data && results.data.items.length > 0 && (
              <ul className="-mt-2 max-h-48 overflow-y-auto rounded-block border border-border p-1">
                {results.data.items.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => setContact(c)}
                      className={`${menuItem} tabular-nums`}
                    >
                      {contactLabel(c)}
                      {c.name && c.phone ? ` · ${contactLabel({ name: null, phone: c.phone })}` : ''}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div>
              <label htmlFor={ids.name} className={fieldLabel}>Nome (opcional)</label>
              <input id={ids.name} value={name} onChange={(e) => setName(e.target.value)} className={field} />
            </div>
          </>
        )}

        <div>
          <label htmlFor={ids.sector} className={fieldLabel}>Setor</label>
          <select id={ids.sector} value={sectorId} onChange={(e) => setSectorId(e.target.value)} className={fieldSelect}>
            <option value="">Setor padrão</option>
            {sectors.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </div>

        {error && <p role="alert" className="rounded-block bg-danger-soft px-3.5 py-2.5 text-[13px] font-semibold text-danger">{error}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className={button('secondary')}>Cancelar</button>
          <button
            type="submit"
            disabled={start.isPending}
            className={button('primary')}
          >
            Iniciar conversa
          </button>
        </div>
      </form>
    </div>
  );
}
