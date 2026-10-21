import { PlusIcon, TrashIcon } from '@phosphor-icons/react';
import type { SectorDto, TriageMenuDto } from '@talk/shared';
import { button, field as cell, fieldSelect, iconButtonGhost } from '../ui';

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
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="text-xs leading-4 text-muted">
              <th className="w-20 pr-2 pb-1.5 font-semibold">Nº</th>
              <th className="pr-2 pb-1.5 font-semibold">Texto da opção</th>
              <th className="w-52 pr-2 pb-1.5 font-semibold">Setor</th>
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {options.map((o, i) => (
              <tr key={i}>
                <td className="py-1 pr-2">
                  <input
                    aria-label={`Número da opção ${i + 1}`}
                    value={o.key}
                    maxLength={3}
                    onChange={(e) => update(i, { key: e.target.value.trim() })}
                    className={`${cell} text-center tabular-nums`}
                  />
                </td>
                <td className="py-1 pr-2">
                  <input
                    aria-label={`Texto da opção ${i + 1}`}
                    value={o.label}
                    maxLength={60}
                    onChange={(e) => update(i, { label: e.target.value })}
                    className={cell}
                  />
                </td>
                <td className="py-1 pr-2">
                  <select
                    aria-label={`Setor da opção ${i + 1}`}
                    value={o.sectorId}
                    onChange={(e) => pickSector(i, e.target.value)}
                    className={fieldSelect}
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
                </td>
                <td className="py-1">
                  <button
                    type="button"
                    aria-label={`Remover opção ${i + 1}`}
                    title="Remover"
                    onClick={() => onChange(options.filter((_, j) => j !== i))}
                    className={iconButtonGhost}
                  >
                    <TrashIcon size={18} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <button type="button" onClick={add} className={`${button('secondary')} mt-3`}>
        <PlusIcon size={16} weight="bold" aria-hidden />
        Adicionar opção
      </button>
    </div>
  );
}
