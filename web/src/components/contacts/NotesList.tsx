import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PushPin, Trash } from '@phosphor-icons/react';
import type { ContactNoteDto } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { confirmDialog } from '../../lib/confirm';
import { button, fieldArea, fieldError, iconButtonGhost } from '../ui';

export function NotesList({ contactId }: { contactId: string }) {
  const qc = useQueryClient();
  const key = qk.contactNotes(contactId);
  const [text, setText] = useState('');
  const notes = useQuery({ queryKey: key, queryFn: () => api.contacts.notes(contactId) });
  const refresh = () => qc.invalidateQueries({ queryKey: key });
  const add = useMutation({
    mutationFn: (body: string) => api.contacts.addNote(contactId, body),
    onSuccess: () => {
      setText('');
      return refresh();
    },
  });
  const pin = useMutation({
    mutationFn: (n: ContactNoteDto) => api.contacts.updateNote(contactId, n.id, { pinned: !n.pinned }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (noteId: string) => api.contacts.deleteNote(contactId, noteId),
    onSuccess: refresh,
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (text.trim()) add.mutate(text.trim());
  }

  const sorted = [...(notes.data ?? [])].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt.localeCompare(a.createdAt),
  );

  return (
    <div className="space-y-3">
      <form onSubmit={submit} className="space-y-2.5">
        <textarea
          aria-label="Nova observação"
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Escreva uma observação"
          className={`${fieldArea} resize-y`}
        />
        <div className="flex justify-end">
          {/* secondary: Nova conversa is the panel's one primary action */}
          <button type="submit" disabled={!text.trim() || add.isPending} className={button('secondary')}>
            Adicionar
          </button>
        </div>
      </form>
      {(add.error || pin.error || remove.error) && (
        <p role="alert" className={fieldError}>{(add.error ?? pin.error ?? remove.error)?.message}</p>
      )}
      <ul className="space-y-2">
        {sorted.map((n) => (
          // Pinned = the sent-bubble pairing (fill, fg, meta), as on the board.
          <li key={n.id} className={`rounded-item pt-3 pr-2 pb-1 pl-3.5 ${n.pinned ? 'bg-bubble-out' : 'bg-sunken'}`}>
            <p className="pr-1.5 whitespace-pre-wrap break-words">{n.body}</p>
            <div className={`mt-0.5 flex items-center text-xs ${n.pinned ? 'text-bubble-meta' : 'text-muted'}`}>
              <span className="min-w-0 flex-1">
                {n.authorName ?? 'Sistema'} · {new Date(n.createdAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
              </span>
              <button
                type="button"
                aria-label={n.pinned ? 'Desafixar observação' : 'Fixar observação'}
                aria-pressed={n.pinned}
                onClick={() => pin.mutate(n)}
                className={iconButtonGhost}
              >
                <PushPin size={16} weight={n.pinned ? 'fill' : 'regular'} />
              </button>
              <button
                type="button"
                aria-label="Excluir observação"
                onClick={async () => {
                  if (await confirmDialog({ title: 'Excluir esta observação?', confirmLabel: 'Excluir' })) remove.mutate(n.id);
                }}
                className={iconButtonGhost}
              >
                <Trash size={16} />
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
