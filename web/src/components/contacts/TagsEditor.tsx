import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { tagColorHex, type ChatDetail, type ContactDto } from '@talk/shared';
import { api, qk } from '../../lib/api';

// ponytail: every tag is a toggle chip; add a search popover if the office passes ~40 tags.
/** The catalog as toggle chips; `tagIds` are the pressed ones. Used for the contact and for the conversation. */
function TagToggles(props: { tagIds: string[]; pending: boolean; error: Error | null; onChange: (tagIds: string[]) => void }) {
  const tags = useQuery({ queryKey: qk.tags, queryFn: () => api.tags.list() });
  const selected = new Set(props.tagIds);

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
            disabled={props.pending}
            onClick={() => props.onChange(on ? props.tagIds.filter((id) => id !== t.id) : [...props.tagIds, t.id])}
            className="rounded-full border border-border px-2.5 py-0.5 text-xs font-medium disabled:opacity-60"
            style={on ? { backgroundColor: color, borderColor: color, color: '#fff' } : { borderColor: color, color }}
          >
            {t.emoji ? `${t.emoji} ` : ''}
            {t.name}
          </button>
        );
      })}
      {props.error && <p role="alert" className="w-full text-xs text-danger">{props.error.message}</p>}
    </div>
  );
}

export function TagsEditor({ contact }: { contact: ContactDto }) {
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (tagIds: string[]) => api.contacts.setTags(contact.id, tagIds),
    onSuccess: (dto) => {
      qc.setQueryData(qk.contact(dto.id), dto);
      void qc.invalidateQueries({ queryKey: qk.contactList({}) }); // {} partially matches every list filter
      void qc.invalidateQueries({ queryKey: qk.chats }); // ChatListItem.tagIds come from the contact
    },
  });
  return <TagToggles tagIds={contact.tagIds} pending={save.isPending} error={save.error} onChange={(ids) => save.mutate(ids)} />;
}

/** Spec 2026-10-20 §5: the conversation's own tags, same catalog; anyone who sees the chat, open or closed. */
export function ChatTagsEditor({ chat }: { chat: ChatDetail }) {
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (tagIds: string[]) => api.chats.setTags(chat.id, tagIds),
    onSuccess: (dto) => {
      qc.setQueryData(qk.chat(dto.id), dto);
      void qc.invalidateQueries({ queryKey: qk.chatLists }); // the chips and the "Etiqueta da conversa" filter
    },
  });
  return (
    <TagToggles tagIds={chat.chatTagIds ?? []} pending={save.isPending} error={save.error} onChange={(ids) => save.mutate(ids)} />
  );
}
