import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { SCHEDULED_TABS, type ScheduledTab } from '@talk/shared';
import { AppointmentsAgenda } from '../components/agenda/AppointmentsAgenda';
import { ScheduledItem } from '../components/conversation/Scheduled';
import { card, pageTitle, tab as tabClass, tabList } from '../components/ui';
import { api, qk } from '../lib/api';

const TAB_LABELS: Record<ScheduledTab, string> = { pending: 'Pendentes', sent: 'Enviadas', failed: 'Falharam', canceled: 'Canceladas' };
const isTab = (v: string | null): v is ScheduledTab => (SCHEDULED_TABS as readonly string[]).includes(v ?? '');
const errorText = 'text-[13px] font-semibold text-danger';

/**
 * The Agenda. Spec 2026-10-20 agendamentos §3.2: "Mensagens", the scheduled messages (?status=). Spec 2026-10-21
 * compromissos §3.5 and 2026-10-23 controle §6.1: "Compromissos" (the default; ?periodo=, filters) comes first, "Mensagens" is ?aba=mensagens.
 * Each tab keeps its own parameters, so switching loses neither.
 */
export function ScheduledMessagesPage() {
  const [params, setParams] = useSearchParams();
  const appointmentsView = params.get('aba') !== 'mensagens' && !(params.get('aba') === null && params.get('status')); // an old ?status= link is Mensagens
  const set = (key: string, value: string | null) =>
    setParams((p) => {
      if (value === null) p.delete(key);
      else p.set(key, value);
      return p;
    });
  const status = params.get('status');

  return (
    <div className={`${card} flex h-full flex-col gap-[18px] overflow-y-auto px-[18px] py-[22px]`}>
      <h1 className={pageTitle}>Agendamentos</h1>
      <div role="tablist" aria-label="Agenda" className={tabList}>
        <button type="button" role="tab" aria-selected={appointmentsView} onClick={() => set('aba', 'compromissos')} className={tabClass(appointmentsView)}>
          Compromissos
        </button>
        <button type="button" role="tab" aria-selected={!appointmentsView} onClick={() => set('aba', 'mensagens')} className={tabClass(!appointmentsView)}>
          Mensagens
        </button>
      </div>
      {appointmentsView ? <AppointmentsAgenda /> : <MessagesTab tab={isTab(status) ? status : 'pending'} onTab={(t) => set('status', t)} />}
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
