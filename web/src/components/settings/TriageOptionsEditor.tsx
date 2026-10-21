import { PlusIcon, TrashIcon } from '@phosphor-icons/react';
import type { SectorDto, TriageMenuDto } from '@talk/shared';
import { button, field as cell, fieldSelect, iconButtonGhost } from '../ui';

// Nº | texto | setor | remover. Narrow: the sector gets its own line (col-start-2 row-start-2 on the select).
const rowGrid = 'grid grid-cols-[4.5rem_minmax(0,1fr)_auto] items-center gap-2 sm:grid-cols-[4.5rem_minmax(0,1fr)_13rem_2.5rem]';

export type TriageOptionInput = TriageMenuDto['options'][number];

export function TriageOptionsEditor({
  options,
  sectors,
  onChange,
}: {
  options: TriageOptionInput[];
  sectors: SectorDto[];
  onChange(next: TriageOptionInput[]): void;
}) {
  const update = (i: number, patch: Partial<TriageOptionInput>) =>
    onChange(options.map((o, j) => (j === i ? { ...o, ...patch } : o)));

  function add() {
    const next = Math.max(0, ...options.map((o) => Number.parseInt(o.key, 10) || 0)) + 1;
    // no sector preselected: the admin must choose, so a contact is never routed to a sector by accident
    onChange([...options, { key: String(next), label: '', sectorId: '' }]);
  }

  function pickSector(i: number, sectorId: string) {
    const current = options[i]!;
    const sectorName = sectors.find((s) => s.id === sectorId)?.name ?? '';
    update(i, { sectorId, label: current.label.trim() ? current.label : sectorName });
  }

  return (
    <div>
      {options.length === 0 ? (
        <p className="text-sm text-muted">Nenhuma opção. Clique em “Adicionar opção”.</p>
      ) : (
        <div>
          {/* wide: Nº, texto, setor and remover in one line; narrow: the sector drops under the text */}
          <div aria-hidden className={`${rowGrid} mb-1.5 hidden text-xs leading-4 font-semibold text-muted sm:grid`}>
            <span>Nº</span>
            <span>Texto da opção</span>
            <span>Setor</span>
            <span />
          </div>
          <ul className="space-y-2">
            {options.map((o, i) => (
              <li key={i} className={rowGrid}>
                <input
                  aria-label={`Número da opção ${i + 1}`}
                  value={o.key}
                  maxLength={3}
                  onChange={(e) => update(i, { key: e.target.value.trim() })}
                  className={`${cell} text-center tabular-nums`}
                />
                <input
                  aria-label={`Texto da opção ${i + 1}`}
                  value={o.label}
                  maxLength={60}
                  onChange={(e) => update(i, { label: e.target.value })}
                  className={cell}
                />
                <select
                  aria-label={`Setor da opção ${i + 1}`}
                  value={o.sectorId}
                  onChange={(e) => pickSector(i, e.target.value)}
                  className={`${fieldSelect} col-span-2 col-start-2 row-start-2 sm:col-span-1 sm:col-start-auto sm:row-start-auto`}
                >
                  <option value="" disabled>
                    Escolha o setor…
                  </option>
                  {sectors.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  aria-label={`Remover opção ${i + 1}`}
                  title="Remover"
                  onClick={() => onChange(options.filter((_, j) => j !== i))}
                  className={`${iconButtonGhost} col-start-3 row-start-1 sm:col-start-auto sm:row-start-auto`}
                >
                  <TrashIcon size={18} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <button type="button" onClick={add} className={`${button('secondary')} mt-3`}>
        <PlusIcon size={16} weight="bold" aria-hidden />
        Adicionar opção
      </button>
    </div>
  );
}
