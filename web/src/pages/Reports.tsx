import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { REPORT_MAX_DAYS, shiftOfficeDate, type ReportDto } from '@talk/shared';
import { dayHeading, mondayOf, monthLabel, officeToday } from '../components/agenda/dates';
import { card, field, fieldLabel, pageTitle, sectionTitle, tab, tabList } from '../components/ui';
import { api, qk } from '../lib/api';
import { useCurrentUser } from '../lib/auth';

type Preset = 'today' | '7' | '30' | 'custom';
const PRESETS: Array<[Preset, string]> = [
  ['today', 'Hoje'],
  ['7', 'Últimos 7 dias'],
  ['30', 'Últimos 30 dias'],
  ['custom', 'Escolher datas'],
];
const WEEKDAYS = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];
const WEEKDAYS_LONG = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado', 'Domingo'];
const th = 'h-10 border-b border-border px-2.5 text-xs font-semibold text-muted';
const td = 'h-11 border-b border-border px-2.5 tabular-nums';

const num = (n: number) => n.toLocaleString('pt-BR');
const brDate = (day: string) => day.split('-').reverse().join('/');
const daysBetween = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;

/** "45 s", "12 min", "1 h 20 min", "2 d 3 h"; "—" when there is nothing to measure. */
export function formatDuration(sec: number | null): string {
  if (sec === null) return '—';
  if (sec < 60) return `${Math.round(sec)} s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
  return h % 24 ? `${Math.floor(h / 24)} d ${h % 24} h` : `${Math.floor(h / 24)} d`;
}

/** Relatórios (admins): the numbers of the period on top, then chats per day, peak hours, sectors and attendants. */
export function ReportsPage() {
  const me = useCurrentUser();
  const today = officeToday();
  const [preset, setPreset] = useState<Preset>('7');
  const [custom, setCustom] = useState({ from: shiftOfficeDate(today, -29), to: today });
  const range = preset === 'custom' ? custom : { from: preset === 'today' ? today : shiftOfficeDate(today, 1 - Number(preset)), to: today };
  const problem =
    preset !== 'custom'
      ? null
      : !custom.from || !custom.to
        ? 'Escolha as duas datas'
        : custom.from > custom.to
          ? 'A data inicial vem depois da final'
          : daysBetween(custom.from, custom.to) > REPORT_MAX_DAYS
            ? `Escolha até ${REPORT_MAX_DAYS} dias`
            : null;
  const report = useQuery({
    queryKey: qk.report(range.from, range.to),
    queryFn: () => api.report(range.from, range.to),
    enabled: me.role === 'admin' && !problem,
    placeholderData: keepPreviousData, // a new period keeps the old numbers, faded, until it arrives
  });

  if (me.role !== 'admin') {
    return <div className={`${card} grid h-full place-items-center p-6 text-muted`}>Só administradores veem os relatórios.</div>;
  }
  const r = report.data;
  return (
    <div className={`${card} flex h-full flex-col gap-[18px] overflow-y-auto px-[18px] py-[22px]`}>
      <h1 className={pageTitle}>Relatórios</h1>
      <div className="flex flex-wrap items-end gap-3">
        <div role="tablist" aria-label="Período" className={tabList}>
          {PRESETS.map(([p, label]) => (
            <button key={p} type="button" role="tab" aria-selected={preset === p} onClick={() => setPreset(p)} className={tab(preset === p)}>
              {label}
            </button>
          ))}
        </div>
        {preset === 'custom' && (
          <div className="flex flex-wrap gap-3">
            {(['from', 'to'] as const).map((k) => (
              <label key={k} className="w-44">
                <span className={fieldLabel}>{k === 'from' ? 'De' : 'Até'}</span>
                <input type="date" max={today} value={custom[k]} onChange={(e) => setCustom({ ...custom, [k]: e.target.value })} className={field} />
              </label>
            ))}
          </div>
        )}
      </div>
      {problem ? (
        <p role="alert" className="text-[13px] font-semibold text-danger">{problem}</p>
      ) : (
        <p className="text-[13px] text-muted">
          {range.from === range.to ? brDate(range.from) : `De ${brDate(range.from)} a ${brDate(range.to)}`}. Os tempos são o tempo do meio
          (mediana) e contam só as respostas de pessoas pelo sistema, não as do chatbot, da triagem ou do celular.
        </p>
      )}
      {report.isPending && !problem && <p className="text-sm text-muted">Carregando…</p>}
      {report.isError && (
        <p role="alert" className="text-[13px] font-semibold text-danger">Não foi possível carregar o relatório.</p>
      )}
      {r && (
        <div className={`flex flex-col gap-[18px] transition-opacity ${report.isPlaceholderData ? 'opacity-50' : ''}`}>
          <Totals totals={r.totals} />
          <DayChart days={r.days} />
          <PeakChart peak={r.peak} />
          <SectorTable rows={r.sectors} />
          <AgentTable rows={r.agents} />
        </div>
      )}
    </div>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-block bg-sunken px-4 py-3">
      <p className="text-[13px] font-semibold text-muted">{label}</p>
      <p className="mt-1 text-2xl font-bold">{value}</p>
      <p className="mt-0.5 text-xs text-muted">{hint}</p>
    </div>
  );
}

function Totals({ totals: t }: { totals: ReportDto['totals'] }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Tile label="Conversas novas" value={num(t.newChats)} hint="começaram no período" />
      <Tile label="Finalizadas" value={num(t.closedChats)} hint="no período" />
      <Tile label="Abertas agora" value={num(t.openNow)} hint="neste momento" />
      <Tile label="Esperando resposta" value={num(t.waitingNow)} hint="neste momento" />
      <Tile label="Primeira resposta" value={formatDuration(t.firstResponseSec)} hint="da 1ª mensagem do cliente à resposta" />
      <Tile label="Respondidas em até 15 min" value={t.within15Pct === null ? '—' : `${t.within15Pct}%`} hint="das primeiras respostas" />
      <Tile label="Tempo de resposta" value={formatDuration(t.replySec)} hint="a cada mensagem do cliente" />
      <Tile label="Com chatbot" value={num(t.botChats)} hint="conversas em que um chatbot rodou" />
    </div>
  );
}

interface Bar { label: string; long: string; newChats: number; closedChats: number }

/** Up to 31 days one bar per day; up to 184, per week (from Monday); longer, per month. */
function bucket(days: ReportDto['days']): { unit: string; bars: Bar[] } {
  const unit = days.length <= 31 ? 'dia' : days.length <= 184 ? 'semana' : 'mês';
  const today = officeToday();
  const bars = new Map<string, Bar>();
  for (const d of days) {
    const key = unit === 'dia' ? d.day : unit === 'semana' ? mondayOf(d.day) : d.day.slice(0, 7);
    const bar = bars.get(key) ?? {
      label: unit === 'mês' ? monthLabel(key).slice(0, 3) : brDate(key).slice(0, 5),
      long: unit === 'dia' ? dayHeading(key, today) : unit === 'semana' ? `Semana de ${brDate(key)}` : monthLabel(key),
      newChats: 0,
      closedChats: 0,
    };
    bar.newChats += d.newChats;
    bar.closedChats += d.closedChats;
    bars.set(key, bar);
  }
  return { unit, bars: [...bars.values()] };
}

/** 1, 2, 5, 10, 20, 50… at or above n. */
function niceMax(n: number): number {
  if (n <= 1) return 1;
  const p = 10 ** Math.floor(Math.log10(n));
  return [1, 2, 5, 10].map((m) => m * p).find((v) => v >= n)!;
}

const SERIES = [
  { key: 'newChats', label: 'Novas', fill: 'bg-chart-1' },
  { key: 'closedChats', label: 'Finalizadas', fill: 'bg-chart-2' },
] as const;

function DayChart({ days }: { days: ReportDto['days'] }) {
  const { unit, bars } = bucket(days);
  const max = niceMax(Math.max(0, ...bars.flatMap((b) => [b.newChats, b.closedChats])));
  const [hover, setHover] = useState<number | null>(null);
  const every = Math.ceil(bars.length / 8);
  const height = (v: number) => `${v ? Math.max(1.5, (v / max) * 100) : 0}%`;
  return (
    <section className="rounded-block bg-sunken p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className={sectionTitle}>Conversas por {unit}</h2>
        <div className="flex gap-4 text-xs text-fg-2">
          {SERIES.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              <span aria-hidden className={`size-2.5 rounded-[3px] ${s.fill}`} /> {s.label}
            </span>
          ))}
        </div>
      </div>
      <div className="mt-4 flex gap-2">
        <div aria-hidden className="flex h-40 w-8 flex-col justify-between text-right text-xs leading-none text-muted tabular-nums">
          <span className="-translate-y-1/2">{num(max)}</span>
          <span>{num(max / 2)}</span>
          <span className="translate-y-1/2">0</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="relative h-40 border-b border-border">
            <div aria-hidden className="absolute inset-x-0 top-0 border-t border-border" />
            <div aria-hidden className="absolute inset-x-0 top-1/2 border-t border-border" />
            <div className="absolute inset-0 flex items-end">
              {bars.map((b, i) => (
                <div
                  key={b.long}
                  tabIndex={0}
                  aria-label={`${b.long}: ${b.newChats} novas, ${b.closedChats} finalizadas`}
                  onPointerEnter={() => setHover(i)}
                  onPointerLeave={() => setHover(null)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                  className={`relative flex h-full flex-1 items-end justify-center gap-0.5 rounded-[4px] px-px outline-none focus-visible:ring-2 focus-visible:ring-primary ${hover === i ? 'bg-panel' : ''}`}
                >
                  {SERIES.map((s) => (
                    <span key={s.key} className={`w-full max-w-3 rounded-t-[4px] ${s.fill}`} style={{ height: height(b[s.key]) }} />
                  ))}
                  {hover === i && (
                    <div
                      role="tooltip"
                      className={`pointer-events-none absolute bottom-full z-10 mb-2 rounded-block bg-surface px-3 py-2 text-xs whitespace-nowrap shadow-[var(--app-shadow-pop)] ${
                        i < 2 ? 'left-0' : i > bars.length - 3 ? 'right-0' : 'left-1/2 -translate-x-1/2'
                      }`}
                    >
                      <p className="text-muted">{b.long}</p>
                      {SERIES.map((s) => (
                        <p key={s.key} className="mt-1 flex items-center gap-2">
                          <span aria-hidden className={`h-0.5 w-3 rounded-full ${s.fill}`} />
                          <strong className="tabular-nums">{num(b[s.key])}</strong> <span className="text-fg-2">{s.label.toLowerCase()}</span>
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
          <div aria-hidden className="mt-1.5 flex text-[11px] text-muted tabular-nums">
            {bars.map((b, i) => (
              <span key={b.long} className="flex-1 text-center whitespace-nowrap">
                {i % every === 0 ? b.label : ''}
              </span>
            ))}
          </div>
        </div>
      </div>
      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-[13px] font-semibold text-link">Ver em tabela</summary>
        <table className="mt-2 w-full max-w-md text-left">
          <thead>
            <tr>
              <th scope="col" className={th}>Período</th>
              <th scope="col" className={`${th} text-right`}>Novas</th>
              <th scope="col" className={`${th} text-right`}>Finalizadas</th>
            </tr>
          </thead>
          <tbody>
            {bars.map((b) => (
              <tr key={b.long}>
                <td className={td}>{b.long}</td>
                <td className={`${td} text-right`}>{num(b.newChats)}</td>
                <td className={`${td} text-right`}>{num(b.closedChats)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}

/** Sequential, one hue: 0 is the quiet fill, then 5 steps of chart-1 over the surface. */
const heat = (level: number) =>
  level === 0 ? 'var(--color-panel)' : `color-mix(in oklab, var(--color-chart-1) ${level * 20}%, var(--color-surface))`;

function PeakChart({ peak }: { peak: number[][] }) {
  const max = Math.max(0, ...peak.flat());
  const level = (v: number) => (v === 0 ? 0 : Math.ceil((v / max) * 5));
  return (
    <section className="rounded-block bg-sunken p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className={sectionTitle}>Horários de pico</h2>
        <div aria-hidden className="flex items-center gap-1 text-xs text-muted">
          Menos
          {[1, 2, 3, 4, 5].map((l) => (
            <span key={l} className="size-3 rounded-[3px]" style={{ background: heat(l) }} />
          ))}
          Mais
        </div>
      </div>
      <p className="mt-1 text-[13px] text-muted">Mensagens de clientes por dia da semana e hora.</p>
      <div className="mt-3 overflow-x-auto">
        <div className="grid min-w-[560px] grid-cols-[36px_repeat(24,minmax(0,1fr))] gap-0.5 text-[11px] text-muted">
          <span />
          {Array.from({ length: 24 }, (_, h) => (
            <span key={h} className="text-center tabular-nums">{h % 3 === 0 ? `${h}h` : ''}</span>
          ))}
          {peak.map((row, d) => [
            <span key={`d${d}`} className="self-center">{WEEKDAYS[d]}</span>,
            ...row.map((v, h) => (
              <span
                key={`${d}-${h}`}
                title={`${WEEKDAYS_LONG[d]}, ${h}h: ${num(v)} ${v === 1 ? 'mensagem' : 'mensagens'}`}
                className="h-6 rounded-[4px]"
                style={{ background: heat(level(v)) }}
              />
            )),
          ])}
        </div>
      </div>
      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-[13px] font-semibold text-link">Ver em tabela</summary>
        <div className="overflow-x-auto">
          <table className="mt-2 text-left">
            <thead>
              <tr>
                <th scope="col" className={th}>Dia</th>
                {Array.from({ length: 24 }, (_, h) => (
                  <th key={h} scope="col" className={`${th} text-right`}>{h}h</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {peak.map((row, d) => (
                <tr key={d}>
                  <th scope="row" className={`${td} font-semibold`}>{WEEKDAYS[d]}</th>
                  {row.map((v, h) => (
                    <td key={h} className={`${td} text-right`}>{num(v)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}

function SectorTable({ rows }: { rows: ReportDto['sectors'] }) {
  return (
    <section className="rounded-block bg-sunken p-4">
      <h2 className={sectionTitle}>Por setor</h2>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[480px] text-left text-sm">
          <thead>
            <tr>
              <th scope="col" className={th}>Setor</th>
              <th scope="col" className={`${th} text-right`}>Novas</th>
              <th scope="col" className={`${th} text-right`}>Finalizadas</th>
              <th scope="col" className={`${th} text-right`}>Primeira resposta</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id}>
                <th scope="row" className={`${td} font-semibold`}>{s.name}</th>
                <td className={`${td} text-right`}>{num(s.newChats)}</td>
                <td className={`${td} text-right`}>{num(s.closedChats)}</td>
                <td className={`${td} text-right`}>{formatDuration(s.firstResponseSec)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function AgentTable({ rows }: { rows: ReportDto['agents'] }) {
  return (
    <section className="rounded-block bg-sunken p-4">
      <h2 className={sectionTitle}>Por atendente</h2>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-muted">Ninguém atendeu neste período.</p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[600px] text-left text-sm">
            <thead>
              <tr>
                <th scope="col" className={th}>Atendente</th>
                <th scope="col" className={`${th} text-right`}>Conversas</th>
                <th scope="col" className={`${th} text-right`}>Finalizadas</th>
                <th scope="col" className={`${th} text-right`}>Mensagens enviadas</th>
                <th scope="col" className={`${th} text-right`}>Primeira resposta</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id}>
                  <th scope="row" className={`${td} font-semibold`}>{a.name}</th>
                  <td className={`${td} text-right`}>{num(a.chats)}</td>
                  <td className={`${td} text-right`}>{num(a.closedChats)}</td>
                  <td className={`${td} text-right`}>{num(a.messages)}</td>
                  <td className={`${td} text-right`}>{formatDuration(a.firstResponseSec)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
