import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CaretLeft, CaretRight, PlusIcon } from '@phosphor-icons/react';
import {
  APPOINTMENT_RANGE_LIMIT, officeDateOf, officeDayRange, isoToOfficeLocal, shiftOfficeDate,
  type AppointmentDto, type AppointmentListQuery, type AppointmentStatus,
} from '@talk/shared';
import { AppointmentItem, APPOINTMENT_STATUS_LABELS } from '../conversation/Appointments';
import { Modal } from '../conversation/ChatDialogs';
import { button, iconButton, iconButtonGhost } from '../ui';
import { api, qk } from '../../lib/api';
import { contactLabel } from '../../lib/format';
import type { AgendaFilters } from './AppointmentsAgenda';
import { mondayOf, monthGrid, monthLabel, officeToday, prefillStartsAt, shiftMonth, weekDays, weekdayDay, weekLabel } from './dates';

const STATUS_DOT: Record<AppointmentStatus, string> = { scheduled: 'bg-fg-2', confirmed: 'bg-primary', attended: 'bg-success', missed: 'bg-danger' };

/** Appointments from the start of `fromDay` to the end of `lastDay` (office days), with the "first 500" notice. */
export function useRangeList(fromDay: string, lastDay: string, filters: AgendaFilters) {
  const query: AppointmentListQuery = {
    from: officeDayRange(fromDay).from.toISOString(), to: officeDayRange(lastDay).to.toISOString(), ...filters,
  };
  const list = useQuery({ queryKey: qk.appointmentList(query), queryFn: () => api.appointments.list(query), refetchInterval: 30_000 });
  const full = list.data?.length === APPOINTMENT_RANGE_LIMIT;
  return { list, notice: full && <p className="text-[13px] text-muted">Mostrando os primeiros {APPOINTMENT_RANGE_LIMIT}</p> };
}

export function AppointmentChip({ item, onOpen, compact }: { item: AppointmentDto; onOpen: () => void; compact?: boolean }) {
  const canceled = !!item.canceledAt;
  const time = isoToOfficeLocal(item.startsAt).slice(11);
  const status = APPOINTMENT_STATUS_LABELS[item.status];
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`${time} ${item.title}${canceled ? '' : ` (${status})`}`}
      className={`flex w-full min-w-0 items-center gap-1.5 overflow-hidden rounded-block bg-panel px-2 py-1 text-left text-[13px] hover:bg-border ${canceled ? 'line-through text-muted' : ''}`}
    >
      <span className={`shrink-0 tabular-nums ${compact ? 'hidden sm:inline' : ''}`}>{time}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-semibold">{item.title}</span>
        {!compact && <span className="block truncate text-muted">{contactLabel(item.contact)}</span>}
      </span>
      {!canceled && (
        <>
          <span aria-hidden className={`size-2 shrink-0 rounded-full ${STATUS_DOT[item.status]}`} />
          <span className="sr-only">{status}</span>
        </>
      )}
    </button>
  );
}

export function AppointmentDetailsDialog({ item, onClose }: { item: AppointmentDto; onClose: () => void }) {
  return (
    <Modal title="Detalhes do compromisso" onCancel={onClose}>
      <ul>
        <AppointmentItem item={item} page />
      </ul>
      <div className="mt-4 flex justify-end">
        <button type="button" className={button('secondary')} onClick={onClose}>
          Fechar
        </button>
      </div>
    </Modal>
  );
}

/** Spec 2026-10-23 controle §6.6: Monday to Sunday in office days; stacked on narrow screens. */
export function WeekView(props: { monday: string; filters: AgendaFilters; onWeek: (monday: string) => void; onCreate: (initialStartsAt: string) => void }) {
  const { monday, onWeek, onCreate } = props;
  const days = weekDays(monday);
  const today = officeToday();
  const { list, notice } = useRangeList(monday, days[6]!, props.filters);
  const [openId, setOpenId] = useState<string | null>(null);
  const open = list.data?.find((a) => a.id === openId); // from the list, so an action in the dialog shows at once
  const byDay = new Map<string, AppointmentDto[]>();
  for (const a of list.data ?? []) {
    const day = officeDateOf(new Date(a.startsAt));
    byDay.set(day, [...(byDay.get(day) ?? []), a]);
  }
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" aria-label="Semana anterior" onClick={() => onWeek(shiftOfficeDate(monday, -7))} className={iconButton}>
          <CaretLeft size={16} aria-hidden />
        </button>
        <button type="button" aria-label="Próxima semana" onClick={() => onWeek(shiftOfficeDate(monday, 7))} className={iconButton}>
          <CaretRight size={16} aria-hidden />
        </button>
        <button type="button" onClick={() => onWeek(mondayOf(today))} className={button('secondary', 'sm')}>
          Hoje
        </button>
        <span className="text-sm font-semibold">{weekLabel(monday)}</span>
      </div>
      {list.isPending && <p className="text-sm text-muted">Carregando…</p>}
      {list.isError && (
        <p role="alert" className="text-[13px] font-semibold text-danger">
          Não foi possível carregar os compromissos.
        </p>
      )}
      {notice}
      <ol aria-label="Dias da semana" className="grid grid-cols-1 gap-2 lg:grid-cols-7">
        {days.map((day) => {
          const prefill = prefillStartsAt(day, new Date());
          return (
            <li
              key={day}
              aria-label={weekdayDay(day)}
              aria-current={day === today ? 'date' : undefined}
              onClick={(e) => e.target === e.currentTarget && prefill && onCreate(prefill)}
              className="group flex min-h-24 min-w-0 flex-col overflow-hidden gap-1 rounded-block border border-border bg-surface p-2"
            >
              <div className={`flex items-center justify-between rounded-block px-1 text-[13px] font-bold ${day === today ? 'bg-primary-soft text-accent-ink' : 'text-muted'}`}>
                <span>{weekdayDay(day)}</span>
                {prefill && (
                  <button
                    type="button"
                    aria-label={`Novo compromisso em ${weekdayDay(day)}`}
                    onClick={() => onCreate(prefill)}
                    className={`${iconButtonGhost} opacity-0 group-hover:opacity-100 focus-visible:opacity-100`}
                  >
                    <PlusIcon size={14} aria-hidden />
                  </button>
                )}
              </div>
              <div className="flex flex-col gap-1">
                {(byDay.get(day) ?? []).map((a) => (
                  <AppointmentChip key={a.id} item={a} onOpen={() => setOpenId(a.id)} />
                ))}
              </div>
            </li>
          );
        })}
      </ol>
      {open && <AppointmentDetailsDialog item={open} onClose={() => setOpenId(null)} />}
    </>
  );
}

const monthShort = new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC', month: 'short' });

/** Spec 2026-10-23 controle §6.7: 6 weeks of office days; a day opens its week. */
export function MonthView({ month, filters, onMonth, onWeek }: { month: string; filters: AgendaFilters; onMonth: (month: string) => void; onWeek: (monday: string) => void }) {
  const grid = monthGrid(month);
  const today = officeToday();
  const { list, notice } = useRangeList(grid[0]!, grid[41]!, filters);
  const [openId, setOpenId] = useState<string | null>(null);
  const open = list.data?.find((a) => a.id === openId);
  const byDay = new Map<string, AppointmentDto[]>();
  for (const a of list.data ?? []) {
    const day = officeDateOf(new Date(a.startsAt));
    byDay.set(day, [...(byDay.get(day) ?? []), a]);
  }
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" aria-label="Mês anterior" onClick={() => onMonth(shiftMonth(month, -1))} className={iconButton}>
          <CaretLeft size={16} aria-hidden />
        </button>
        <button type="button" aria-label="Próximo mês" onClick={() => onMonth(shiftMonth(month, 1))} className={iconButton}>
          <CaretRight size={16} aria-hidden />
        </button>
        <button type="button" onClick={() => onMonth(today.slice(0, 7))} className={button('secondary', 'sm')}>
          Hoje
        </button>
        <span className="text-sm font-semibold">{monthLabel(month)}</span>
      </div>
      {list.isPending && <p className="text-sm text-muted">Carregando…</p>}
      {list.isError && (
        <p role="alert" className="text-[13px] font-semibold text-danger">
          Não foi possível carregar os compromissos.
        </p>
      )}
      {notice}
      <ol aria-label={`Dias de ${monthLabel(month)}`} className="grid grid-cols-7 gap-1">
        {grid.map((day) => {
          const items = byDay.get(day) ?? [];
          const n = Number(day.slice(8, 10));
          return (
            <li
              key={day}
              aria-current={day === today ? 'date' : undefined}
              onClick={(e) => e.target === e.currentTarget && onWeek(mondayOf(day))}
              className={`flex min-h-20 min-w-0 flex-col overflow-hidden gap-1 rounded-block border border-border p-1 ${day.slice(0, 7) === month ? 'bg-surface' : 'bg-panel text-muted'} ${day === today ? '!bg-primary-soft' : ''}`}
            >
              <button
                type="button"
                aria-label={`Ver a semana de ${n} de ${monthShort.format(new Date(`${day}T12:00:00Z`))}`}
                onClick={() => onWeek(mondayOf(day))}
                className="self-start rounded-block px-1 text-[13px] font-bold hover:bg-border"
              >
                {n}
              </button>
              {items.slice(0, 3).map((a) => (
                <AppointmentChip key={a.id} item={a} compact onOpen={() => setOpenId(a.id)} />
              ))}
              {items.length > 3 && <span className="px-1 text-[12px] text-muted">+{items.length - 3}</span>}
            </li>
          );
        })}
      </ol>
      {open && <AppointmentDetailsDialog item={open} onClose={() => setOpenId(null)} />}
    </>
  );
}
