import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { tagColorHex, type ContactDto } from '@talk/shared';
import { api, qk } from '../../lib/api';

// ponytail: every tag is a toggle chip; add a search popover if the office passes ~40 tags.
export function TagsEditor({ contact }: { contact: ContactDto }) {
  const qc = useQueryClient();
  const tags = useQuery({ queryKey: qk.tags, queryFn: () => api.tags.list() });
  const save = useMutation({
    mutationFn: (tagIds: string[]) => api.contacts.setTags(contact.id, tagIds),
    onSuccess: (dto) => {
      qc.setQueryData(qk.contact(dto.id), dto);
      void qc.invalidateQueries({ queryKey: qk.contactList({}) }); // {} partially matches every list filter
      void qc.invalidateQueries({ queryKey: qk.chats }); // ChatListItem.tagIds come from the contact
    },
  });

  const selected = new Set(contact.tagIds);
  function toggle(id: string) {
    save.mutate(selected.has(id) ? contact.tagIds.filter((t) => t !== id) : [...contact.tagIds, id]);
  }

  if (!tags.data?.length) return <p className="text-sm text-muted">Nenhuma etiqueta cadastrada.</p>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {tags.data.map((t) => {
        const on = selected.has(t.id);
        const color = tagColorHex(t.color); // the shared palette (Task 15), same as Task 19's form
        return (
          <button
            key={t.id}
            type="button"
            aria-pressed={on}
            disabled={save.isPending}
            onClick={() => toggle(t.id)}
            className="rounded-full border border-border px-2.5 py-0.5 text-xs font-medium disabled:opacity-60"
            style={on ? { backgroundColor: color, borderColor: color, color: '#fff' } : { borderColor: color, color }}
          >
            {t.emoji ? `${t.emoji} ` : ''}
            {t.name}
          </button>
        );
      })}
      {save.error && <p role="alert" className="w-full text-xs text-danger">{save.error.message}</p>}
    </div>
  );
}
