import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { MagnifyingGlass, PlusIcon } from '@phosphor-icons/react';
import {
  APPOINTMENT_PRESETS, APPOINTMENT_STATUSES, APPOINTMENT_TABS, officeDateOf,
  type AppointmentListQuery, type AppointmentPreset, type AppointmentStatus, type AppointmentSummaryDto, type AppointmentTab,
} from '@talk/shared';
import { AppointmentDialog, AppointmentItem, APPOINTMENT_STATUS_LABELS } from '../conversation/Appointments';
import { button, fieldSelect, searchInput, searchPill, tab as tabClass, tabList } from '../ui';
import { api, qk } from '../../lib/api';
import { useCurrentUser } from '../../lib/auth';
import { useDebounced } from '../../lib/hooks';
import { WeekView } from './CalendarViews';
import { dayHeading, mondayOf, officeToday } from './dates';

export type AgendaFilters = Pick<AppointmentListQuery, 'authorId' | 'sectorId' | 'status' | 'q'>;

const APPOINTMENT_TAB_LABELS: Record<AppointmentTab, string> = { upcoming: 'Próximos', past: 'Passados', canceled: 'Cancelados' };
const COUNTERS: Array<{ preset: AppointmentPreset; key: keyof AppointmentSummaryDto; label: string }> = [
  { preset: 'today', key: 'today', label: 'Hoje' },
  { preset: 'tomorrow', key: 'tomorrow', label: 'Amanhã' },
  { preset: 'toConfirm', key: 'toConfirm', label: 'A confirmar' },
  { preset: 'toMark', key: 'toMark', label: 'Presença a marcar' },
];
const isTab = (v: string | null): v is AppointmentTab => (APPOINTMENT_TABS as readonly string[]).includes(v ?? '');
const isStatus = (v: string | null): v is AppointmentStatus => (APPOINTMENT_STATUSES as readonly string[]).includes(v ?? '');
const isPreset = (v: string | null): v is AppointmentPreset => (APPOINTMENT_PRESETS as readonly string[]).includes(v ?? '');
const VIEWS = [['lista', 'Lista'], ['semana', 'Semana'], ['mes', 'Mês']] as const;
const errorText = 'text-[13px] font-semibold text-danger';

/** Spec 2026-10-23 controle §6: the Compromissos tab: counters, toolbar, period tabs and the Lista grouped by day. */
export function AppointmentsAgenda() {
  const [params, setParams] = useSearchParams();
  const isAdmin = useCurrentUser().role === 'admin';
  const [creating, setCreating] = useState<{ initialStartsAt?: string } | null>(null);

  // An old link carried the period in ?situacao=; it is read as ?periodo= and dropped on the next write.
  const situacao = params.get('situacao');
  const periodo = params.get('periodo');
  const tab: AppointmentTab = isTab(periodo) ? periodo : isTab(situacao) ? situacao : 'upcoming';
  const statusParam = isStatus(situacao) ? situacao : undefined;
  const filtro = params.get('filtro');
  const preset = isPreset(filtro) ? filtro : undefined;
  const authorParam = isAdmin ? params.get('atendente') || undefined : undefined; // an attendant is limited to their own server-side
  const sectorParam = params.get('setor') || undefined;
  const busca = params.get('busca') ?? '';
  const visaoParam = params.get('visao');
  const visao: 'lista' | 'semana' | 'mes' = visaoParam === 'semana' || visaoParam === 'mes' ? visaoParam : 'lista';
  const semanaParam = params.get('semana');
  const monday = mondayOf(semanaParam && /^\d{4}-\d{2}-\d{2}$/.test(semanaParam) ? semanaParam : officeToday());

  /** Several keys in one setParams; null deletes. */
  const update = (changes: Record<string, string | null>) =>
    setParams((p) => {
      const old = p.get('situacao');
      if (isTab(old)) {
        if (!p.has('periodo')) p.set('periodo', old);
        p.delete('situacao');
      }
      for (const [k, v] of Object.entries(changes)) {
        if (v === null) p.delete(k);
        else p.set(k, v);
      }
      return p;
    });

  const q = useDebounced(busca.trim(), 300) || undefined;
  const filters: AgendaFilters = { authorId: authorParam, sectorId: sectorParam, status: statusParam, q };
  const listQuery: AppointmentListQuery = { ...(preset ? { preset } : { tab }), ...filters };
  const summaryQuery = { authorId: authorParam, sectorId: sectorParam, q };

  // ponytail: polls every 30 s like the messages tab (spec §10: no real-time notice on the page)
  const list = useQuery({ queryKey: qk.appointmentList(listQuery), queryFn: () => api.appointments.list(listQuery), refetchInterval: 30_000, enabled: visao === 'lista' });
  const summary = useQuery({ queryKey: qk.appointmentSummary(summaryQuery), queryFn: () => api.appointments.summary(summaryQuery), refetchInterval: 30_000 });
  const users = useQuery({ queryKey: qk.users, queryFn: () => api.users.list(), enabled: isAdmin }).data ?? [];
  const sectors = useQuery({ queryKey: qk.sectors, queryFn: () => api.sectors.list() }).data ?? [];

  const today = officeToday();
  const groups: Array<{ day: string; items: NonNullable<typeof list.data> }> = [];
  for (const a of list.data ?? []) {
    const day = officeDateOf(new Date(a.startsAt));
    const last = groups[groups.length - 1];
    if (last?.day === day) last.items.push(a);
    else groups.push({ day, items: [a] });
  }
  const anyFilter = !!(authorParam || sectorParam || statusParam || busca.trim());

  return (
    <>
      {summary.data && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {COUNTERS.map((c) => {
            const n = summary.data[c.key];
            const active = preset === c.preset;
            return (
              <button
                key={c.preset}
                type="button"
                aria-pressed={active}
                onClick={() => update({ filtro: active ? null : c.preset, visao: null })}
                className={`rounded-block border px-4 py-3 text-left ${n === 0 ? 'text-muted' : ''} ${active ? 'border-primary bg-primary-soft' : 'border-border bg-surface'}`}
              >
                <span className="block text-[22px] font-bold tabular-nums">{n}</span>
                <span className="text-[13px] text-muted">{c.label}</span>
              </button>
            );
          })}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {isAdmin && (
          <label className="flex items-center gap-2 text-[13px] font-semibold text-muted">
            Atendente
            <select value={authorParam ?? ''} onChange={(e) => update({ atendente: e.target.value || null })} className={fieldSelect}>
              <option value="">Todos os atendentes</option>
              {users.filter((u) => u.active).map((u) => (
                <option key={u.id} value={u.id}>{u.name}</option>
              ))}
            </select>
          </label>
        )}
        <label className="flex items-center gap-2 text-[13px] font-semibold text-muted">
          Setor
          <select value={sectorParam ?? ''} onChange={(e) => update({ setor: e.target.value || null })} className={fieldSelect}>
            <option value="">Todos os setores</option>
            {sectors.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-[13px] font-semibold text-muted">
          Situação
          <select value={statusParam ?? ''} onChange={(e) => update({ situacao: e.target.value || null })} className={fieldSelect}>
            <option value="">Todas as situações</option>
            {APPOINTMENT_STATUSES.map((s) => (
              <option key={s} value={s}>{APPOINTMENT_STATUS_LABELS[s]}</option>
            ))}
          </select>
        </label>
        <div className={searchPill}>
          <MagnifyingGlass size={16} aria-hidden />
          <input
            type="search"
            value={busca}
            onChange={(e) => update({ busca: e.target.value || null })}
            placeholder="Cliente, telefone ou título"
            aria-label="Buscar compromissos"
            className={searchInput}
          />
        </div>
        {anyFilter && (
          <button type="button" onClick={() => update({ atendente: null, setor: null, situacao: null, busca: null })} className={button('ghost', 'sm')}>
            Limpar filtros
          </button>
        )}
        <button type="button" onClick={() => setCreating({})} className={`${button('primary')} ml-auto`}>
          <PlusIcon size={16} aria-hidden /> Novo compromisso
        </button>
      </div>
      <div role="tablist" aria-label="Visualização" className={tabList}>
        {VIEWS.map(([v, label]) => (
          <button key={v} type="button" role="tab" aria-selected={v === visao} onClick={() => update({ visao: v === 'lista' ? null : v })} className={tabClass(v === visao)}>
            {label}
          </button>
        ))}
      </div>
      {visao === 'semana' && (
        <WeekView monday={monday} filters={filters} onWeek={(m) => update({ semana: m })} onCreate={(initialStartsAt) => setCreating({ initialStartsAt })} />
      )}
      {visao === 'lista' && !preset && (
        <div role="tablist" aria-label="Situação dos compromissos" className={tabList}>
          {APPOINTMENT_TABS.map((t) => (
            <button key={t} type="button" role="tab" aria-selected={t === tab} onClick={() => update({ periodo: t })} className={tabClass(t === tab)}>
              {APPOINTMENT_TAB_LABELS[t]}
            </button>
          ))}
        </div>
      )}
      {visao === 'lista' && list.isPending && <p className="text-sm text-muted">Carregando…</p>}
      {visao === 'lista' && list.isError && (
        <p role="alert" className={errorText}>
          Não foi possível carregar os compromissos.
        </p>
      )}
      {visao === 'lista' && list.data?.length === 0 && <p className="text-sm text-muted">Nenhum compromisso aqui.</p>}
      {visao === 'lista' && groups.map((g) => (
        <section key={g.day} className="max-w-[800px]">
          <h2 className={`sticky top-0 z-10 bg-surface py-1.5 text-[13px] font-bold ${g.day === today ? 'text-primary' : 'text-muted'}`}>
            {dayHeading(g.day, today)}
          </h2>
          <ul className="divide-y divide-border">
            {g.items.map((a) => (
              <AppointmentItem key={a.id} item={a} page />
            ))}
          </ul>
        </section>
      ))}
      {creating && <AppointmentDialog initialStartsAt={creating.initialStartsAt} onClose={() => setCreating(null)} />}
    </>
  );
}
