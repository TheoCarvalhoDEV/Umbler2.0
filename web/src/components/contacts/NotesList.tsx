import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PushPin, Trash } from '@phosphor-icons/react';
import type { ContactNoteDto } from '@talk/shared';
import { api, qk } from '../../lib/api';

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
      <form onSubmit={submit} className="space-y-2">
        <textarea
          aria-label="Nova observação"
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Escreva uma observação"
          className="w-full resize-y rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none"
        />
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={!text.trim() || add.isPending}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            Adicionar
          </button>
        </div>
      </form>
      {(add.error || pin.error || remove.error) && (
        <p role="alert" className="text-xs text-danger">{(add.error ?? pin.error ?? remove.error)?.message}</p>
      )}
      <ul className="space-y-2">
        {sorted.map((n) => (
          <li key={n.id} className={`rounded-md border p-3 text-sm ${n.pinned ? 'border-primary bg-primary/10' : 'border-border'}`}>
            <p className="whitespace-pre-wrap break-words">{n.body}</p>
            <div className="mt-2 flex items-center gap-2 text-xs text-muted">
              <span className="flex-1">
                {n.authorName ?? 'Sistema'} · {new Date(n.createdAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
              </span>
              <button
                type="button"
                aria-label={n.pinned ? 'Desafixar observação' : 'Fixar observação'}
                aria-pressed={n.pinned}
                onClick={() => pin.mutate(n)}
                className="rounded p-1 hover:bg-sidebar-hover"
              >
                <PushPin size={14} weight={n.pinned ? 'fill' : 'regular'} />
              </button>
              <button
                type="button"
                aria-label="Excluir observação"
                onClick={() => window.confirm('Excluir esta observação?') && remove.mutate(n.id)}
                className="rounded p-1 hover:bg-sidebar-hover"
              >
                <Trash size={14} />
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
