import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { REPORT_MAX_DAYS, shiftOfficeDate, type ReportDto } from '@talk/shared';
import { Avatar } from '../components/Avatar';
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
const block = 'rounded-block bg-sunken p-5';
const th = 'h-10 border-b border-border px-2.5 text-xs font-semibold text-muted';
const td = 'h-12 border-b border-border px-2.5 tabular-nums';

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

/** Relatórios (admins): how fast clients are answered and what is waiting now, then chats per day, peak hours,
 * sectors and attendants. */
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
    <div className={`${card} flex h-full flex-col gap-5 overflow-y-auto px-[18px] py-[22px] lg:px-6`}>
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div>
          <h1 className={pageTitle}>Relatórios</h1>
          {problem ? (
            <p role="alert" className="mt-1 text-[13px] font-semibold text-danger">{problem}</p>
          ) : (
            <p className="mt-1 text-[13px] text-muted">{range.from === range.to ? brDate(range.from) : `De ${brDate(range.from)} a ${brDate(range.to)}`}</p>
          )}
        </div>
        <div role="tablist" aria-label="Período" className={tabList}>
          {PRESETS.map(([p, label]) => (
            <button key={p} type="button" role="tab" aria-selected={preset === p} onClick={() => setPreset(p)} className={tab(preset === p)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {preset === 'custom' && (
        <div className="-mt-1 flex flex-wrap justify-end gap-3">
          {(['from', 'to'] as const).map((k) => (
            <label key={k} className="w-44">
              <span className={fieldLabel}>{k === 'from' ? 'De' : 'Até'}</span>
              <input type="date" max={today} value={custom[k]} onChange={(e) => setCustom({ ...custom, [k]: e.target.value })} className={field} />
            </label>
          ))}
        </div>
      )}
      {report.isPending && !problem && <p className="text-sm text-muted">Carregando…</p>}
      {report.isError && (
        <p role="alert" className="text-[13px] font-semibold text-danger">Não foi possível carregar o relatório.</p>
      )}
      {r && (
        <div className={`flex flex-col gap-3 transition-opacity ${report.isPlaceholderData ? 'opacity-50' : ''}`}>
          <div className="grid gap-3 lg:grid-cols-3">
            <Speed totals={r.totals} />
            <Now totals={r.totals} />
          </div>
          <DayChart days={r.days} totals={r.totals} />
          <PeakChart peak={r.peak} />
          <SectorTable rows={r.sectors} />
          <AgentTable rows={r.agents} />
        </div>
      )}
    </div>
  );
}

/** The headline: how long clients wait for the first answer, said as a sentence so "mediana" needs no explaining. */
function Speed({ totals: t }: { totals: ReportDto['totals'] }) {
  const first = formatDuration(t.firstResponseSec);
  return (
    <section aria-labelledby="rel-speed" className={`${block} flex flex-col lg:col-span-2`}>
      <h2 id="rel-speed" className={sectionTitle}>Primeira resposta</h2>
      <div className="flex-1 pb-5">
        {t.firstResponseSec === null ? (
          <p className="mt-3 text-sm text-muted">Nenhum cliente recebeu a primeira resposta neste período.</p>
        ) : (
          <>
            <p className="mt-3 text-[44px] leading-none font-bold tracking-[-0.03em] tabular-nums">{first}</p>
            <p className="mt-2.5 max-w-prose text-sm text-fg-2">Metade dos clientes esperou até {first} pela primeira resposta.</p>
            {t.within15Pct !== null && (
              <div className="mt-5 max-w-xl">
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span id="rel-15" className="text-fg-2">Respondidos em até 15 min</span>
                  <strong className="tabular-nums">{t.within15Pct}%</strong>
                </div>
                <div
                  role="meter"
                  aria-labelledby="rel-15"
                  aria-valuenow={t.within15Pct}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  className="mt-2 h-2.5 overflow-hidden rounded-full bg-panel"
                >
                  <div className="h-full rounded-full bg-chart-1" style={{ width: `${t.within15Pct}%` }} />
                </div>
              </div>
            )}
          </>
        )}
      </div>
      <div className="flex flex-wrap items-baseline gap-x-2 border-t border-border pt-3.5 text-sm">
        <span className="text-fg-2">Ao longo da conversa, metade das mensagens dos clientes foi respondida em até</span>
        <strong className="tabular-nums">{formatDuration(t.replySec)}</strong>
      </div>
      <p className="mt-1.5 text-xs text-muted">Contam só as respostas de pessoas pelo sistema, não as do chatbot, da triagem ou do celular.</p>
    </section>
  );
}

/** Live numbers: they do not change with the period, so they sit apart from it. */
function Now({ totals: t }: { totals: ReportDto['totals'] }) {
  return (
    <section aria-labelledby="rel-now" className={`${block} flex flex-col`}>
      <h2 id="rel-now" className={`${sectionTitle} flex items-center gap-2`}>
        <span aria-hidden className="size-2 rounded-full bg-online" />
        Agora
      </h2>
      <dl className="mt-3 flex flex-col gap-4">
        <div>
          <dt className="text-sm text-fg-2">Esperando resposta</dt>
          <dd className="mt-0.5 text-[32px] leading-10 font-bold tracking-[-0.02em] tabular-nums">{num(t.waitingNow)}</dd>
        </div>
        <div>
          <dt className="text-sm text-fg-2">Conversas abertas</dt>
          <dd className="mt-0.5 text-[32px] leading-10 font-bold tracking-[-0.02em] tabular-nums">{num(t.openNow)}</dd>
        </div>
      </dl>
      <p className="mt-auto pt-4 text-xs text-muted">Não muda com o período escolhido.</p>
    </section>
  );
}

interface Bar { label: string; long: string; weekend: boolean; newChats: number; closedChats: number }

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
      weekend: unit === 'dia' && [0, 6].includes(new Date(`${key}T12:00:00Z`).getUTCDay()),
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

/** The period's totals are the legend, so the counts and their colors are read together. */
function DayChart({ days, totals }: { days: ReportDto['days']; totals: ReportDto['totals'] }) {
  const { unit, bars } = bucket(days);
  const max = niceMax(Math.max(0, ...bars.flatMap((b) => [b.newChats, b.closedChats])));
  const [hover, setHover] = useState<number | null>(null);
  const every = Math.ceil(bars.length / 8);
  const height = (v: number) => `${v ? Math.max(1.5, (v / max) * 100) : 0}%`;
  return (
    <section className={block}>
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div>
          <h2 className={sectionTitle}>Conversas por {unit}</h2>
          <p className="mt-1 text-[13px] text-muted">
            {totals.botChats ? `Um chatbot rodou em ${num(totals.botChats)} delas.` : 'Nenhuma passou por chatbot.'}
          </p>
        </div>
        <dl className="flex flex-wrap gap-x-6 gap-y-2">
          {SERIES.map((s) => (
            <div key={s.key} className="flex items-center gap-2">
              <span aria-hidden className={`size-2.5 rounded-[3px] ${s.fill}`} />
              <dt className="text-sm text-fg-2">{s.label}</dt>
              <dd className="text-lg leading-6 font-bold tabular-nums">{num(totals[s.key])}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="mt-5 flex gap-2">
        <div aria-hidden className="flex h-44 w-8 flex-col justify-between text-right text-xs leading-none text-muted tabular-nums">
          <span className="-translate-y-1/2">{num(max)}</span>
          <span>{num(max / 2)}</span>
          <span className="translate-y-1/2">0</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="relative h-44 border-b border-border">
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
                  className={`relative flex h-full flex-1 items-end justify-center gap-0.5 rounded-[4px] px-px outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                    hover === i ? 'bg-border' : b.weekend ? 'bg-panel/70' : ''
                  }`}
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
      <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
        <details className="text-sm">
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
        {unit === 'dia' && bars.some((b) => b.weekend) && (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted">
            <span aria-hidden className="size-2.5 rounded-[3px] bg-panel/70 ring-1 ring-border" /> Sábado e domingo
          </span>
        )}
      </div>
    </section>
  );
}

/** Sequential, one hue: 0 is the quiet fill, then 5 steps of chart-1 over the surface. */
const heat = (level: number) =>
  level === 0 ? 'var(--color-panel)' : `color-mix(in oklab, var(--color-chart-1) ${level * 20}%, var(--color-surface))`;

function PeakChart({ peak }: { peak: number[][] }) {
  const max = Math.max(0, ...peak.flat());
  const level = (v: number) => (v === 0 ? 0 : Math.ceil((v / max) * 5));
  const top = peak.flat().indexOf(max);
  const [topDay, topHour] = [Math.floor(top / 24), top % 24];
  return (
    <section className={block}>
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <div>
          <h2 className={sectionTitle}>Horários de pico</h2>
          <p className="mt-1 text-[13px] text-muted">
            Mensagens de clientes por dia da semana e hora.
            {max > 0 &&
              ` O mais cheio: ${WEEKDAYS_LONG[topDay]!.toLowerCase()}, das ${topHour}h às ${topHour + 1}h, com ${num(max)} ${max === 1 ? 'mensagem' : 'mensagens'}.`}
          </p>
        </div>
        <div aria-hidden className="flex items-center gap-1 text-xs text-muted">
          Menos
          {[1, 2, 3, 4, 5].map((l) => (
            <span key={l} className="size-3 rounded-[3px]" style={{ background: heat(l) }} />
          ))}
          Mais
        </div>
      </div>
      <div className="mt-4 overflow-x-auto">
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
                className="h-7 rounded-[4px]"
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

/** A count with a bar of its share of the column's largest, so a table reads at a glance. */
function CountBar({ value, max }: { value: number; max: number }) {
  return (
    <td className={td}>
      <div className="flex items-center gap-3">
        <span aria-hidden className="h-2 min-w-16 flex-1 overflow-hidden rounded-full bg-panel">
          <span className="block h-full rounded-full bg-chart-1" style={{ width: `${max ? (value / max) * 100 : 0}%` }} />
        </span>
        <span className="w-12 text-right">{num(value)}</span>
      </div>
    </td>
  );
}

function SectorTable({ rows }: { rows: ReportDto['sectors'] }) {
  const sorted = [...rows].sort((a, b) => b.newChats - a.newChats);
  const max = Math.max(0, ...rows.map((s) => s.newChats));
  return (
    <section className={block}>
      <h2 className={sectionTitle}>Por setor</h2>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[560px] text-left text-sm">
          <thead>
            <tr>
              <th scope="col" className={th}>Setor</th>
              <th scope="col" className={`${th} w-[40%] text-right`}>Novas</th>
              <th scope="col" className={`${th} text-right`}>Finalizadas</th>
              <th scope="col" className={`${th} text-right`}>Primeira resposta</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((s) => (
              <tr key={s.id}>
                <th scope="row" className={`${td} font-semibold`}>{s.name}</th>
                <CountBar value={s.newChats} max={max} />
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
  const sorted = [...rows].sort((a, b) => b.chats - a.chats);
  const max = Math.max(0, ...rows.map((a) => a.chats));
  return (
    <section className={block}>
      <h2 className={sectionTitle}>Por atendente</h2>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-muted">Ninguém atendeu neste período.</p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[680px] text-left text-sm">
            <thead>
              <tr>
                <th scope="col" className={th}>Atendente</th>
                <th scope="col" className={`${th} w-[32%] text-right`}>Conversas</th>
                <th scope="col" className={`${th} text-right`}>Finalizadas</th>
                <th scope="col" className={`${th} text-right`}>Mensagens enviadas</th>
                <th scope="col" className={`${th} text-right`}>Primeira resposta</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((a) => (
                <tr key={a.id}>
                  <th scope="row" className={`${td} font-semibold`}>
                    <span className="flex items-center gap-2.5">
                      <Avatar name={a.name} src={null} className="size-7 text-[11px]" />
                      {a.name}
                    </span>
                  </th>
                  <CountBar value={a.chats} max={max} />
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
