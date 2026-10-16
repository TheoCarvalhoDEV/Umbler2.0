import { TrashIcon } from '@phosphor-icons/react';
import type { SectorDto, TriageMenuDto } from '@talk/shared';

export type TriageOptionInput = TriageMenuDto['options'][number];

const cell = 'w-full rounded border border-field px-2 py-1 text-sm';

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
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted">
              <th className="w-16 pb-1 font-medium">Nº</th>
              <th className="pb-1 font-medium">Texto da opção</th>
              <th className="w-48 pb-1 font-medium">Setor</th>
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
                    className={cell}
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
                    className={cell}
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
                    className="rounded p-1 text-muted hover:bg-danger/15 hover:text-danger"
                  >
                    <TrashIcon size={16} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <button type="button" onClick={add} className="mt-2 rounded border border-border px-3 py-1.5 text-sm hover:bg-sidebar-hover">
        Adicionar opção
      </button>
    </div>
  );
}
