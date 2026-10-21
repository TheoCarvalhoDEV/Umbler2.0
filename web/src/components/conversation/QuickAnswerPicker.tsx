import { Paperclip } from '@phosphor-icons/react';
import type { QuickAnswerDto } from '@talk/shared';
import { menu, menuItem } from '../ui';

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
      className={`${menu} absolute bottom-full left-0 right-0 z-10 mb-2 max-h-64 overflow-y-auto`}
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
          className={`${menuItem} flex-wrap gap-x-1.5 gap-y-0.5 ${i === highlight ? 'bg-sidebar-active' : ''}`}
        >
          <span className="font-semibold">/{a.name}</span>
          {a.hasAttachment && <Paperclip size={14} className="text-muted" aria-label="com anexo" />}
          <span className="w-full truncate text-xs text-muted">{a.body}</span>
        </button>
      ))}
    </div>
  );
}
