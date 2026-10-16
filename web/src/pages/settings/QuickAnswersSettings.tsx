import { useState } from 'react';
import { PaperclipIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import type { QuickAnswerDto } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { useCurrentUser } from '../../lib/auth';
import { QuickAnswerForm, type QuickAnswerInput } from '../../components/settings/QuickAnswerForm';
import { ErrorText, Loading, Section, btn, btnPrimary, send, useSend } from '../../components/settings/common';
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
    <Section
      title="Respostas rápidas"
      action={
        <button type="button" onClick={() => open('new')} className={btnPrimary}>
          Nova resposta rápida
        </button>
      }
    >
      {target && (
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
      )}
      {!target && <ErrorText error={save.error} />}
      {sorted.length === 0 && <p className="text-sm text-muted">Nenhuma resposta rápida.</p>}
      <ul className="divide-y divide-border rounded border border-border">
        {sorted.map((a) => (
          <li key={a.id} className="flex items-start gap-2 px-3 py-2 text-sm">
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 font-medium">
                /{a.name}
                {a.hasAttachment && <PaperclipIcon size={14} aria-label="Com anexo" />}
                <span className="rounded-full bg-surface px-2 py-0.5 text-xs font-normal text-muted">
                  {a.visibility === 'all' ? 'Para todos' : a.ownerId === me.id ? 'Apenas para mim' : 'Particular de outro atendente'}
                </span>
              </p>
              <p className="line-clamp-2 whitespace-pre-line text-muted">{a.body}</p>
            </div>
            {canEdit(a) && (
              <>
                <button type="button" onClick={() => open(a)} className={btn}>
                  Editar
                </button>
                <button type="button" onClick={() => remove(a)} className={btn}>
                  Excluir
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}
