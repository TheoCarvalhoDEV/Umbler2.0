import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { SCHEDULED_TABS, type ScheduledTab } from '@talk/shared';
import { ScheduledItem } from '../components/conversation/Scheduled';
import { card, pageTitle, tab as tabClass, tabList } from '../components/ui';
import { api, qk } from '../lib/api';

const TAB_LABELS: Record<ScheduledTab, string> = { pending: 'Pendentes', sent: 'Enviadas', failed: 'Falharam', canceled: 'Canceladas' };
const isTab = (v: string | null): v is ScheduledTab => (SCHEDULED_TABS as readonly string[]).includes(v ?? '');

/** Spec 2026-10-20 agendamentos §3.2: an agent's own scheduled messages (an admin's: everyone's), one tab per status. */
export function ScheduledMessagesPage() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('status');
  const tab: ScheduledTab = isTab(raw) ? raw : 'pending';
  // ponytail: polls every 30 s instead of a WS event of its own; the page's own changes refresh it at once
  const list = useQuery({ queryKey: qk.scheduledList(tab), queryFn: () => api.scheduled.list(tab), refetchInterval: 30_000 });

  return (
    <div className={`${card} flex h-full flex-col gap-[18px] overflow-y-auto px-[18px] py-[22px]`}>
      <h1 className={pageTitle}>Agendamentos</h1>
      <div role="tablist" aria-label="Situação" className={tabList}>
        {SCHEDULED_TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={t === tab}
            onClick={() => setParams({ status: t })}
            className={tabClass(t === tab)}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>
      {list.isPending && <p className="text-sm text-muted">Carregando…</p>}
      {list.isError && (
        <p role="alert" className="text-[13px] font-semibold text-danger">
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
    </div>
  );
}
