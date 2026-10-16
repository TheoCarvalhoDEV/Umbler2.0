import { useState } from 'react';
import { BLOCK_CATALOG, BLOCK_CATEGORY_LABELS, type BlockCategory, type BlockType } from '@talk/shared';
import { field } from '../settings/common';
import { blockIcon } from './icons';

/** dataTransfer type the canvas reads on drop. */
export const PALETTE_DRAG_TYPE = 'application/x-talk-block';

const CATEGORIES = Object.keys(BLOCK_CATEGORY_LABELS) as BlockCategory[];
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export interface PaletteProps {
  open: boolean;
  onInsert(type: BlockType): void;
}

export function Palette({ open, onInsert }: PaletteProps) {
  const [query, setQuery] = useState('');
  if (!open) return null;
  const needle = fold(query.trim());
  const matches = BLOCK_CATALOG.filter((e) => !needle || fold(`${e.label} ${e.description}`).includes(needle));

  return (
    <aside aria-label="Paleta de blocos" className="flex w-64 shrink-0 flex-col border-r border-border bg-panel">
      <div className="p-3">
        <input
          type="search"
          aria-label="Buscar bloco"
          placeholder="Buscar bloco…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className={`${field} bg-surface`}
        />
        <p className="mt-1 text-xs text-muted">Clique ou arraste para inserir. Tab abre e fecha.</p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {CATEGORIES.map((category) => {
          const list = matches.filter((e) => e.category === category);
          if (list.length === 0) return null;
          return (
            <section key={category} className="mb-3">
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">{BLOCK_CATEGORY_LABELS[category]}</h3>
              <ul className="space-y-1">
                {list.map((entry) => {
                  const Icon = blockIcon(entry.icon);
                  return (
                    <li key={entry.type}>
                      <button
                        type="button"
                        draggable
                        aria-label={entry.label}
                        title={entry.description}
                        onClick={() => onInsert(entry.type)}
                        onDragStart={(e) => {
                          e.dataTransfer.setData(PALETTE_DRAG_TYPE, entry.type);
                          e.dataTransfer.effectAllowed = 'move';
                        }}
                        className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-sidebar-hover"
                      >
                        <Icon size={16} className="mt-0.5 shrink-0" aria-hidden />
                        <span>
                          <span className="block">{entry.label}</span>
                          <span className="block text-xs text-muted">{entry.description}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
        {matches.length === 0 && <p className="text-sm text-muted">Nenhum bloco encontrado.</p>}
      </div>
    </aside>
  );
}
