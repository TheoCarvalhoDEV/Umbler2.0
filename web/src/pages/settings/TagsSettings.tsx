import { useState } from 'react';
import { PlusIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { tagColorHex, type TagDto } from '@talk/shared';
import { TagForm, tagChip, type TagInput } from '../../components/settings/TagForm';
import { ErrorText, Loading, Section, btnDanger, btnPrimary, btnSecondary, listRow, send, useSend } from '../../components/settings/common';
import { api, qk } from '../../lib/api';
import { confirmDialog } from '../../lib/confirm';

export function TagsSettings() {
  const tags = useQuery({ queryKey: qk.tags, queryFn: api.tags.list });
  const save = useSend(qk.tags);
  const [editing, setEditing] = useState<TagDto | 'new' | null>(null);

  if (!tags.data) return <Loading error={tags.error} />;
  const sorted = [...tags.data].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name, 'pt-BR'));
  const target = editing;

  function open(value: TagDto | 'new') {
    save.reset();
    setEditing(value);
  }

  function submit(v: TagInput) {
    save.mutate(
      () => (target && target !== 'new' ? send(`/api/tags/${target.id}`, 'PATCH', v) : send('/api/tags', 'POST', v)),
      { onSuccess: () => setEditing(null) },
    );
  }

  async function remove(t: TagDto) {
    const body = 'Ela sai de todos os contatos.';
    if (await confirmDialog({ title: `Excluir a etiqueta "${t.name}"?`, body, confirmLabel: 'Excluir etiqueta' })) {
      save.mutate(() => send(`/api/tags/${t.id}`, 'DELETE'));
    }
  }

  return (
    <Section
      title="Etiquetas"
      action={
        <button type="button" onClick={() => open('new')} className={btnPrimary}>
          <PlusIcon size={16} weight="bold" aria-hidden />
          Nova etiqueta
        </button>
      }
    >
      {target && (
        <TagForm
          key={target === 'new' ? 'new' : target.id}
          initial={target === 'new' ? undefined : target}
          pending={save.isPending}
          error={save.error?.message ?? null}
          onSubmit={submit}
          onCancel={() => setEditing(null)}
        />
      )}
      {!target && <ErrorText error={save.error} />}
      {sorted.length === 0 && <p className="text-sm text-muted">Nenhuma etiqueta.</p>}
      <ul>
        {sorted.map((t) => (
          <li key={t.id} className={listRow}>
            <span className="min-w-0 flex-1">
              <span className={tagChip}>
                <span aria-hidden className="size-[7px] shrink-0 rounded-full" style={{ backgroundColor: tagColorHex(t.color) }} />
                {t.emoji ? `${t.emoji} ${t.name}` : t.name}
              </span>
            </span>
            <span className="flex items-center gap-2">
              <button type="button" onClick={() => open(t)} className={btnSecondary}>
                Editar
              </button>
              <button type="button" onClick={() => remove(t)} className={btnDanger}>
                Excluir
              </button>
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}
