import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { tagColorHex, type TagDto } from '@talk/shared';
import { TagForm, type TagInput } from '../../components/settings/TagForm';
import { ErrorText, Loading, Section, btn, btnPrimary, send, useSend } from '../../components/settings/common';
import { api, qk } from '../../lib/api';

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

  function remove(t: TagDto) {
    if (window.confirm(`Excluir a etiqueta "${t.name}"? Ela sai de todos os contatos.`)) {
      save.mutate(() => send(`/api/tags/${t.id}`, 'DELETE'));
    }
  }

  return (
    <Section
      title="Etiquetas"
      action={
        <button type="button" onClick={() => open('new')} className={btnPrimary}>
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
      <ul className="divide-y divide-border rounded border border-border">
        {sorted.map((t) => (
          <li key={t.id} className="flex items-center gap-2 px-3 py-2">
            <span className="flex-1">
              <span className="inline-block rounded-full px-3 py-0.5 text-sm font-medium text-white" style={{ backgroundColor: tagColorHex(t.color) }}>
                {t.emoji ? `${t.emoji} ${t.name}` : t.name}
              </span>
            </span>
            <button type="button" onClick={() => open(t)} className={btn}>
              Editar
            </button>
            <button type="button" onClick={() => remove(t)} className={btn}>
              Excluir
            </button>
          </li>
        ))}
      </ul>
    </Section>
  );
}
