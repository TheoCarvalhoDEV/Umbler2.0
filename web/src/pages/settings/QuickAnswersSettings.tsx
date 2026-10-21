import { useState } from 'react';
import { LightningIcon, PaperclipIcon, PlusIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import type { QuickAnswerDto } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { useCurrentUser } from '../../lib/auth';
import { Modal } from '../../components/conversation/ChatDialogs';
import { QuickAnswerForm, type QuickAnswerInput } from '../../components/settings/QuickAnswerForm';
import { badge, badgeTone } from '../../components/ui';
import { EmptyState, ErrorText, ListRow, Loading, PageHeader, RowMenu, btnPrimary, send, useSend } from '../../components/settings/common';
import { confirmDialog } from '../../lib/confirm';

export function QuickAnswersSettings() {
  const me = useCurrentUser();
  const answers = useQuery({ queryKey: qk.quickAnswers, queryFn: api.quickAnswers.list });
  const fields = useQuery({ queryKey: qk.customFields, queryFn: api.customFields.list });
  const save = useSend(qk.quickAnswers);
  const [editing, setEditing] = useState<QuickAnswerDto | 'new' | null>(null);

  if (!answers.data || !fields.data) return <Loading error={answers.error ?? fields.error} />;
  const isAdmin = me.role === 'admin';
  const canEdit = (a: QuickAnswerDto) => isAdmin || a.ownerId === me.id;
  const sorted = [...answers.data].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  const target = editing;

  function open(value: QuickAnswerDto | 'new') {
    save.reset();
    setEditing(value);
  }

  function submit(v: QuickAnswerInput) {
    let body: unknown = { name: v.name, body: v.body, visibility: v.visibility };
    if (v.file) {
      // text fields before the file so the server's multipart parser has them when it reaches the file
      const form = new FormData();
      form.append('name', v.name);
      form.append('body', v.body);
      form.append('visibility', v.visibility);
      form.append('file', v.file);
      body = form;
    }
    save.mutate(
      () =>
        target && target !== 'new'
          ? send(`/api/quick-answers/${target.id}`, 'PATCH', body)
          : send('/api/quick-answers', 'POST', body),
      { onSuccess: () => setEditing(null) },
    );
  }

  async function remove(a: QuickAnswerDto) {
    if (await confirmDialog({ title: `Excluir a resposta rápida "${a.name}"?`, confirmLabel: 'Excluir' })) save.mutate(() => send(`/api/quick-answers/${a.id}`, 'DELETE'));
  }

  return (
    <>
      <PageHeader
        title="Respostas rápidas"
        description="Textos prontos: digite / na conversa para escolher um."
        action={
          <button type="button" onClick={() => open('new')} className={btnPrimary}>
            <PlusIcon size={16} weight="bold" aria-hidden />
            Nova resposta rápida
          </button>
        }
      />
      {target && (
        <Modal title={target === 'new' ? 'Nova resposta rápida' : 'Editar resposta rápida'} onCancel={() => setEditing(null)}>
          <QuickAnswerForm
            key={target === 'new' ? 'new' : target.id}
            initial={target === 'new' ? undefined : target}
            isAdmin={isAdmin}
            fields={[...fields.data].sort((a, b) => a.position - b.position)}
            pending={save.isPending}
            error={save.error?.message ?? null}
            onSubmit={submit}
            onCancel={() => setEditing(null)}
          />
        </Modal>
      )}
      {!target && <ErrorText error={save.error} />}
      {sorted.length === 0 ? (
        <EmptyState icon={<LightningIcon size={28} />} title="Nenhuma resposta rápida" hint="Crie a primeira em “Nova resposta rápida”." />
      ) : (
        <ul className="mt-5">
          {sorted.map((a) => (
            <ListRow
              key={a.id}
              leading={<LightningIcon size={20} aria-hidden />}
              title={`/${a.name}`}
              badges={
                <>
                  {a.hasAttachment && <PaperclipIcon size={16} aria-label="Com anexo" className="shrink-0 text-fg-2" />}
                  <span className={`${badge} ${a.visibility === 'all' ? badgeTone.accent : badgeTone.neutral}`}>
                    {a.visibility === 'all' ? 'Para todos' : a.ownerId === me.id ? 'Apenas para mim' : 'Particular de outro atendente'}
                  </span>
                </>
              }
              subtitle={a.body}
              actions={
                canEdit(a) && (
                  <RowMenu
                    label={`Opções da resposta rápida /${a.name}`}
                    items={[
                      { label: 'Editar', onSelect: () => open(a) },
                      { label: 'Excluir', onSelect: () => remove(a), danger: true },
                    ]}
                  />
                )
              }
            />
          ))}
        </ul>
      )}
    </>
  );
}
