import { useId, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { ContactDto, SectorDto } from '@talk/shared';
import { api, qk, type StartChatInput } from '../../lib/api';
import { contactLabel } from '../../lib/format';

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

  const input = 'mt-1 w-full rounded bg-surface px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby={ids.title}
        onSubmit={submit}
        onKeyDown={onKeyDown}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md space-y-3 rounded-lg bg-panel p-4 text-fg shadow-xl"
      >
        <h2 id={ids.title} className="text-lg font-semibold">Nova conversa</h2>

        {contact ? (
          <div className="flex items-center gap-2 rounded bg-surface px-3 py-2 text-sm">
            <span className="flex-1 truncate">{contactLabel(contact)}</span>
            <button type="button" onClick={() => setContact(null)} className="text-link underline">Trocar</button>
          </div>
        ) : (
          <>
            <div>
              <label htmlFor={ids.text} className="text-sm text-muted">Contato ou telefone</label>
              <input
                id={ids.text}
                autoFocus
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Nome ou (65) 99999-9999"
                className={input}
              />
            </div>
            {results.data && results.data.items.length > 0 && (
              <ul className="max-h-48 overflow-y-auto rounded border border-border">
                {results.data.items.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => setContact(c)}
                      className="w-full px-3 py-2 text-left text-sm hover:bg-surface"
                    >
                      {contactLabel(c)}
                      {c.name && c.phone ? ` · ${contactLabel({ name: null, phone: c.phone })}` : ''}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div>
              <label htmlFor={ids.name} className="text-sm text-muted">Nome (opcional)</label>
              <input id={ids.name} value={name} onChange={(e) => setName(e.target.value)} className={input} />
            </div>
          </>
        )}

        <div>
          <label htmlFor={ids.sector} className="text-sm text-muted">Setor</label>
          <select id={ids.sector} value={sectorId} onChange={(e) => setSectorId(e.target.value)} className={input}>
            <option value="">Setor padrão</option>
            {sectors.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </div>

        {error && <p role="alert" className="text-sm text-danger">{error}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="rounded px-3 py-2 text-sm hover:bg-surface">Cancelar</button>
          <button
            type="submit"
            disabled={start.isPending}
            className="rounded bg-primary px-3 py-2 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50"
          >
            Iniciar conversa
          </button>
        </div>
      </form>
    </div>
  );
}
