import { useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import type { CustomFieldDto, QuickAnswerDto } from '@talk/shared';
import { button, field, fieldArea, fieldError, fieldLabel, radio } from '../ui';
import { btnPrimary } from './common';

export interface QuickAnswerInput {
  name: string;
  body: string;
  visibility: 'all' | 'owner';
  file: File | null;
}

// Named variables of spec §5.7, in the order they appear as buttons.
export const FIXED_VARIABLES = [
  ['atendente.nome', 'Nome do atendente'],
  ['atendente.primeiro_nome', 'Primeiro nome do atendente'],
  ['atendente.email', 'E-mail do atendente'],
  ['contato.nome', 'Nome do contato'],
  ['contato.primeiro_nome', 'Primeiro nome do contato'],
  ['contato.telefone', 'Telefone do contato'],
  ['contato.email', 'E-mail do contato'],
] as const;

export function insertAtCursor(text: string, start: number, end: number, snippet: string): { text: string; caret: number } {
  return { text: text.slice(0, start) + snippet + text.slice(end), caret: start + snippet.length };
}

export function QuickAnswerForm({
  initial,
  isAdmin,
  fields,
  onSubmit,
  onCancel,
  pending = false,
  error = null,
}: {
  initial?: QuickAnswerDto;
  isAdmin: boolean;
  fields: CustomFieldDto[];
  onSubmit(value: QuickAnswerInput): void;
  onCancel(): void;
  pending?: boolean;
  error?: string | null;
}) {
  const id = useId();
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const caret = useRef<number | null>(null);
  const [name, setName] = useState(initial?.name ?? '');
  const [body, setBody] = useState(initial?.body ?? '');
  // only admins may publish to everyone (contract: "user (own) / admin (visibility all)")
  const [visibility, setVisibility] = useState<'all' | 'owner'>(isAdmin ? (initial?.visibility ?? 'all') : 'owner');
  const [file, setFile] = useState<File | null>(null);

  // after inserting a variable, put the caret right after it so typing continues there
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (caret.current === null || !el) return;
    el.focus();
    el.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  });

  function insert(variable: string) {
    const el = bodyRef.current;
    if (!el) return;
    const result = insertAtCursor(el.value, el.selectionStart, el.selectionEnd, `{{${variable}}}`);
    caret.current = result.caret;
    setBody(result.text);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || !body.trim()) return;
    onSubmit({ name: name.trim(), body: body.trim(), visibility, file });
  }

  const variables: Array<readonly [string, string]> = [
    ...FIXED_VARIABLES,
    ...fields.map((f) => [`campo.${f.name}`, `Campo: ${f.name}`] as const),
  ];

  return (
    <form onSubmit={submit} className="space-y-5">
      <div>
        <label htmlFor={`${id}-name`} className={fieldLabel}>
          Nome
        </label>
        <input id={`${id}-name`} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} className={field} />
      </div>

      {isAdmin && (
        <fieldset>
          <legend className="mb-2 text-[13px] leading-[18px] font-semibold">Visibilidade</legend>
          <div className="flex flex-wrap gap-x-6 gap-y-2.5 text-sm">
            <label className="flex cursor-pointer items-center gap-2">
              <input type="radio" name={`${id}-vis`} checked={visibility === 'all'} onChange={() => setVisibility('all')} className={radio} />
              Para todos
            </label>
            <label className="flex cursor-pointer items-center gap-2">
              <input type="radio" name={`${id}-vis`} checked={visibility === 'owner'} onChange={() => setVisibility('owner')} className={radio} />
              Apenas para mim
            </label>
          </div>
        </fieldset>
      )}

      <div>
        <label htmlFor={`${id}-body`} className={fieldLabel}>
          Mensagem
        </label>
        <textarea
          id={`${id}-body`}
          ref={bodyRef}
          rows={6}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          className={fieldArea}
        />
        <div className="mt-3">
          <p className="text-[13px] leading-[18px] text-muted">
            Inserir variável (trocada pelos dados do atendente e do contato quando a resposta é escolhida com / na conversa):
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {variables.map(([variable, label]) => (
              <button
                key={variable}
                type="button"
                title={`{{${variable}}}`}
                // keep the textarea focused so its selection is not lost
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => insert(variable)}
                className={button('secondary', 'sm')}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div>
        <label htmlFor={`${id}-file`} className={fieldLabel}>
          Anexo (opcional)
        </label>
        {initial?.hasAttachment && (
          <p className="mb-2 text-[13px] leading-[18px] text-muted">
            Esta resposta já tem um anexo:{' '}
            <a href={`/api/quick-answers/${initial.id}/attachment`} target="_blank" rel="noreferrer" className="text-link underline">
              abrir
            </a>
            . Escolha outro arquivo para substituir.
          </p>
        )}
        <input
          id={`${id}-file`}
          type="file"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="block max-w-full text-sm text-muted file:mr-3 file:h-10 file:cursor-pointer file:rounded-full file:border-0 file:bg-panel file:px-4 file:text-[13px] file:font-bold file:text-fg hover:file:bg-border"
        />
      </div>

      {error && (
        <p role="alert" className={fieldError}>
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className={button('ghost')}>
          Cancelar
        </button>
        <button type="submit" disabled={!name.trim() || !body.trim() || pending} className={btnPrimary}>
          Salvar
        </button>
      </div>
    </form>
  );
}
