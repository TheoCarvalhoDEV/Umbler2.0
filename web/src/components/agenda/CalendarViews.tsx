import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CaretLeft, CaretRight, PlusIcon } from '@phosphor-icons/react';
import {
  APPOINTMENT_RANGE_LIMIT, officeDateOf, officeDayRange, isoToOfficeLocal, shiftOfficeDate,
  type AppointmentDto, type AppointmentListQuery, type AppointmentStatus,
} from '@talk/shared';
import { AppointmentItem } from '../conversation/Appointments';
import { Modal } from '../conversation/ChatDialogs';
import { button, iconButton, iconButtonGhost } from '../ui';
import { api, qk } from '../../lib/api';
import { contactLabel } from '../../lib/format';
import type { AgendaFilters } from './AppointmentsAgenda';
import { mondayOf, officeToday, prefillStartsAt, weekDays, weekdayDay, weekLabel } from './dates';

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

export function AppointmentChip({ item, onOpen }: { item: AppointmentDto; onOpen: () => void }) {
  const canceled = !!item.canceledAt;
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`flex w-full items-center gap-1.5 rounded-block bg-panel px-2 py-1 text-left text-[13px] hover:bg-border ${canceled ? 'line-through text-muted' : ''}`}
    >
      <span className="shrink-0 tabular-nums">{isoToOfficeLocal(item.startsAt).slice(11)}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-semibold">{item.title}</span>
        <span className="block truncate text-muted">{contactLabel(item.contact)}</span>
      </span>
      {!canceled && <span aria-hidden className={`size-2 shrink-0 rounded-full ${STATUS_DOT[item.status]}`} />}
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
      <ol aria-label="Dias da semana" className="grid grid-cols-1 gap-2 md:grid-cols-7">
        {days.map((day) => {
          const prefill = prefillStartsAt(day, new Date());
          return (
            <li
              key={day}
              aria-label={weekdayDay(day)}
              aria-current={day === today ? 'date' : undefined}
              onClick={(e) => e.target === e.currentTarget && prefill && onCreate(prefill)}
              className="group flex min-h-24 min-w-0 flex-col gap-1 rounded-block border border-border bg-surface p-2"
            >
              <div className={`flex items-center justify-between rounded-block px-1 text-[13px] font-bold ${day === today ? 'bg-primary-soft text-accent-ink' : 'text-muted'}`}>
                <span>{weekdayDay(day)}</span>
                {prefill && (
                  <button
                    type="button"
                    aria-label={`Novo compromisso em ${weekdayDay(day)}`}
                    onClick={() => onCreate(prefill)}
                    className={`${iconButtonGhost} !size-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100`}
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
