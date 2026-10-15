import { useId } from 'react';
import type { SectorDto, TagDto, UserDto } from '@talk/shared';
import { EMPTY_FILTERS, NO_OWNER, type InboxFilters, type Period } from './chat-query';

const PERIODS: Array<[Period, string]> = [
  ['any', 'Qualquer'],
  ['today', 'Hoje'],
  ['7d', '7 dias'],
  ['30d', '30 dias'],
  ['range', 'Intervalo'],
];

interface Props {
  value: InboxFilters;
  onChange(next: InboxFilters): void;
  sectors: SectorDto[];
  users: UserDto[];
  tags: TagDto[];
}

export function FilterPanel({ value, onChange, sectors, users, tags }: Props) {
  const ids = { sector: useId(), owner: useId(), tag: useId(), from: useId(), to: useId() };
  const set = (patch: Partial<InboxFilters>) => onChange({ ...value, ...patch });
  const field = 'mt-1 w-full rounded bg-panel px-2 py-1.5 text-sm outline-none';

  return (
    <div className="space-y-2 border-b border-border p-3 text-sm">
      <div>
        <label htmlFor={ids.sector} className="text-muted">Setor</label>
        <select id={ids.sector} value={value.sectorId} onChange={(e) => set({ sectorId: e.target.value })} className={field}>
          <option value="">Todos</option>
          {sectors.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor={ids.owner} className="text-muted">Atendente</label>
        <select id={ids.owner} value={value.ownerId} onChange={(e) => set({ ownerId: e.target.value })} className={field}>
          <option value="">Todos</option>
          <option value={NO_OWNER}>Sem dono</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>{u.name}</option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor={ids.tag} className="text-muted">Etiqueta</label>
        <select id={ids.tag} value={value.tagId} onChange={(e) => set({ tagId: e.target.value })} className={field}>
          <option value="">Todas</option>
          {tags.map((t) => (
            <option key={t.id} value={t.id}>{`${t.emoji ? `${t.emoji} ` : ''}${t.name}`}</option>
          ))}
        </select>
      </div>
      <fieldset>
        <legend className="text-muted">Período de criação</legend>
        <div className="mt-1 flex flex-wrap gap-1">
          {PERIODS.map(([p, label]) => (
            <button
              key={p}
              type="button"
              aria-pressed={value.period === p}
              onClick={() => set({ period: p })}
              className={`rounded px-2 py-1 ${value.period === p ? 'bg-primary text-white' : 'bg-panel hover:bg-sidebar-hover'}`}
            >
              {label}
            </button>
          ))}
        </div>
        {value.period === 'range' && (
          <div className="mt-2 flex gap-2">
            <div className="flex-1">
              <label htmlFor={ids.from} className="text-muted">De</label>
              <input id={ids.from} type="date" value={value.rangeFrom} onChange={(e) => set({ rangeFrom: e.target.value })} className={field} />
            </div>
            <div className="flex-1">
              <label htmlFor={ids.to} className="text-muted">Até</label>
              <input id={ids.to} type="date" value={value.rangeTo} onChange={(e) => set({ rangeTo: e.target.value })} className={field} />
            </div>
          </div>
        )}
      </fieldset>
      <button type="button" onClick={() => onChange(EMPTY_FILTERS)} className="text-primary underline">
        Limpar filtros
      </button>
    </div>
  );
}
