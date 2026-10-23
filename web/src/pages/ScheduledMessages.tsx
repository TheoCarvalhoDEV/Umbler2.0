import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { PlusIcon } from '@phosphor-icons/react';
import { APPOINTMENT_TABS, SCHEDULED_TABS, type AppointmentTab, type ScheduledTab } from '@talk/shared';
import { AppointmentDialog, AppointmentItem } from '../components/conversation/Appointments';
import { ScheduledItem } from '../components/conversation/Scheduled';
import { button, card, pageTitle, tab as tabClass, tabList } from '../components/ui';
import { api, qk } from '../lib/api';

const TAB_LABELS: Record<ScheduledTab, string> = { pending: 'Pendentes', sent: 'Enviadas', failed: 'Falharam', canceled: 'Canceladas' };
const APPOINTMENT_TAB_LABELS: Record<AppointmentTab, string> = { upcoming: 'Próximos', past: 'Passados', canceled: 'Cancelados' };
const isTab = (v: string | null): v is ScheduledTab => (SCHEDULED_TABS as readonly string[]).includes(v ?? '');
const isAppointmentTab = (v: string | null): v is AppointmentTab => (APPOINTMENT_TABS as readonly string[]).includes(v ?? '');
const errorText = 'text-[13px] font-semibold text-danger';

/**
 * The Agenda. Spec 2026-10-20 agendamentos §3.2: "Mensagens", the scheduled messages (?status=). Spec 2026-10-21
 * compromissos §3.5: "Compromissos" (?aba=compromissos&situacao=). Each tab keeps its own parameter, so switching loses neither.
 */
export function ScheduledMessagesPage() {
  const [params, setParams] = useSearchParams();
  const appointmentsView = params.get('aba') === 'compromissos';
  const set = (key: string, value: string | null) =>
    setParams((p) => {
      if (value === null) p.delete(key);
      else p.set(key, value);
      return p;
    });
  const status = params.get('status');
  const situation = params.get('situacao');

  return (
    <div className={`${card} flex h-full flex-col gap-[18px] overflow-y-auto px-[18px] py-[22px]`}>
      <h1 className={pageTitle}>Agendamentos</h1>
      <div role="tablist" aria-label="Agenda" className={tabList}>
        <button type="button" role="tab" aria-selected={!appointmentsView} onClick={() => set('aba', null)} className={tabClass(!appointmentsView)}>
          Mensagens
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={appointmentsView}
          onClick={() => set('aba', 'compromissos')}
          className={tabClass(appointmentsView)}
        >
          Compromissos
        </button>
      </div>
      {appointmentsView ? (
        <AppointmentsTab tab={isAppointmentTab(situation) ? situation : 'upcoming'} onTab={(t) => set('situacao', t)} />
      ) : (
        <MessagesTab tab={isTab(status) ? status : 'pending'} onTab={(t) => set('status', t)} />
      )}
    </div>
  );
}

/** An agent's own scheduled messages (an admin's: everyone's), one tab per status. */
function MessagesTab({ tab, onTab }: { tab: ScheduledTab; onTab: (t: ScheduledTab) => void }) {
  // ponytail: polls every 30 s instead of a WS event of its own; the page's own changes refresh it at once
  const list = useQuery({ queryKey: qk.scheduledList(tab), queryFn: () => api.scheduled.list(tab), refetchInterval: 30_000 });
  return (
    <>
      <div role="tablist" aria-label="Situação" className={tabList}>
        {SCHEDULED_TABS.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={t === tab} onClick={() => onTab(t)} className={tabClass(t === tab)}>
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>
      {list.isPending && <p className="text-sm text-muted">Carregando…</p>}
      {list.isError && (
        <p role="alert" className={errorText}>
          Não foi possível carregar os agendamentos.
        </p>
      )}
      {list.data?.length === 0 && <p className="text-sm text-muted">Nenhuma mensagem aqui.</p>}
      {!!list.data?.length && (
        <ul className="max-w-[800px] divide-y divide-border">
          {list.data.map((i) => (
            <ScheduledItem key={i.id} item={i} page />
          ))}
        </ul>
      )}
    </>
  );
}

/** Spec 2026-10-21 compromissos §3.5: mine (an admin: everyone's); Próximos, Passados, Cancelados; "Novo compromisso". */
function AppointmentsTab({ tab, onTab }: { tab: AppointmentTab; onTab: (t: AppointmentTab) => void }) {
  const [creating, setCreating] = useState(false);
  // ponytail: polls every 30 s like the messages tab (spec §10: no real-time notice on the page)
  const list = useQuery({ queryKey: qk.appointmentList({ tab }), queryFn: () => api.appointments.list({ tab }), refetchInterval: 30_000 });
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label="Situação dos compromissos" className={tabList}>
          {APPOINTMENT_TABS.map((t) => (
            <button key={t} type="button" role="tab" aria-selected={t === tab} onClick={() => onTab(t)} className={tabClass(t === tab)}>
              {APPOINTMENT_TAB_LABELS[t]}
            </button>
          ))}
        </div>
        <button type="button" onClick={() => setCreating(true)} className={button('primary')}>
          <PlusIcon size={16} aria-hidden /> Novo compromisso
        </button>
      </div>
      {list.isPending && <p className="text-sm text-muted">Carregando…</p>}
      {list.isError && (
        <p role="alert" className={errorText}>
          Não foi possível carregar os compromissos.
        </p>
      )}
      {list.data?.length === 0 && <p className="text-sm text-muted">Nenhum compromisso aqui.</p>}
      {!!list.data?.length && (
        <ul className="max-w-[800px] divide-y divide-border">
          {list.data.map((a) => (
            <AppointmentItem key={a.id} item={a} page />
          ))}
        </ul>
      )}
      {creating && <AppointmentDialog onClose={() => setCreating(false)} />}
    </>
  );
}
