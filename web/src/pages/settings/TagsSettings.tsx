import { useState } from 'react';
import { PlusIcon, TagIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { tagColorHex, type TagDto } from '@talk/shared';
import { Modal } from '../../components/conversation/ChatDialogs';
import { TagForm, type TagInput } from '../../components/settings/TagForm';
import { EmptyState, ErrorText, ListRow, Loading, PageHeader, RowMenu, btnPrimary, send, useSend } from '../../components/settings/common';
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
    <>
      <PageHeader
        title="Etiquetas"
        description="Marque os contatos com etiquetas coloridas para organizá-los."
        action={
          <button type="button" onClick={() => open('new')} className={btnPrimary}>
            <PlusIcon size={16} weight="bold" aria-hidden />
            Nova etiqueta
          </button>
        }
      />
      {target && (
        <Modal title={target === 'new' ? 'Nova etiqueta' : 'Editar etiqueta'} onCancel={() => setEditing(null)}>
          <TagForm
            key={target === 'new' ? 'new' : target.id}
            initial={target === 'new' ? undefined : target}
            pending={save.isPending}
            error={save.error?.message ?? null}
            onSubmit={submit}
            onCancel={() => setEditing(null)}
          />
        </Modal>
      )}
      {!target && <ErrorText error={save.error} />}
      {sorted.length === 0 ? (
        <EmptyState icon={<TagIcon size={28} />} title="Nenhuma etiqueta ainda" hint="Crie a primeira em “Nova etiqueta”." />
      ) : (
        <ul className="mt-5">
          {sorted.map((t) => (
            <ListRow
              key={t.id}
              // the chip is the tag's own color, with its emoji when it has one
              leading={
                <span aria-hidden className="grid size-full place-items-center text-lg" style={{ backgroundColor: tagColorHex(t.color) }}>
                  {t.emoji}
                </span>
              }
              title={t.name}
              actions={
                <RowMenu
                  label={`Opções da etiqueta ${t.name}`}
                  items={[
                    { label: 'Editar', onSelect: () => open(t) },
                    { label: 'Excluir', onSelect: () => remove(t), danger: true },
                  ]}
                />
              }
            />
          ))}
        </ul>
      )}
    </>
  );
}
