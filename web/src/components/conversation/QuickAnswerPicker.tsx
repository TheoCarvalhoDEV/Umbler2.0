import { Paperclip } from '@phosphor-icons/react';
import type { QuickAnswerDto } from '@talk/shared';

const fold = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

export function filterQuickAnswers(all: QuickAnswerDto[], query: string): QuickAnswerDto[] {
  const q = fold(query);
  return all.filter((a) => fold(a.name).includes(q));
}

export function QuickAnswerPicker({
  answers,
  highlight,
  onPick,
}: {
  answers: QuickAnswerDto[];
  highlight: number;
  onPick: (qa: QuickAnswerDto) => void;
}) {
  return (
    <div
      role="listbox"
      aria-label="Respostas rápidas"
      className="absolute bottom-full left-0 right-0 z-10 mb-1 max-h-64 overflow-y-auto rounded-md border border-border bg-panel shadow-lg"
    >
      {answers.length === 0 && <p className="px-3 py-2 text-sm text-muted">Nenhuma resposta rápida encontrada</p>}
      {answers.map((a, i) => (
        <button
          key={a.id}
          type="button"
          role="option"
          aria-selected={i === highlight}
          onMouseDown={(e) => e.preventDefault()} // keep focus in the textarea
          onClick={() => onPick(a)}
          className={`block w-full px-3 py-2 text-left text-sm ${i === highlight ? 'bg-surface' : 'hover:bg-surface'}`}
        >
          <span className="font-medium text-fg">/{a.name}</span>
          {a.hasAttachment && <Paperclip size={14} className="ml-1 inline text-muted" aria-label="com anexo" />}
          <span className="block truncate text-xs text-muted">{a.body}</span>
        </button>
      ))}
    </div>
  );
}
