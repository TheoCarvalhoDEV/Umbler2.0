import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Robot } from '@phosphor-icons/react';
import { api, qk } from '../../lib/api';
import { useWsEvent } from '../../lib/ws';
import { ErrorText, useSend } from '../settings/common';
import { button, menu, menuItem } from '../ui';

export interface BotPanelProps {
  chatId: string;
  onClose: () => void;
}

/** Composer popover (spec §7): "Executar chatbot" lists the manual bots; each running run gets "Parar chatbot". */
export function BotPanel({ chatId, onClose }: BotPanelProps) {
  const qc = useQueryClient();
  const runs = useQuery({ queryKey: qk.chatBotRuns(chatId), queryFn: () => api.botRuns.listForChat(chatId) });
  const manual = useQuery({ queryKey: qk.botManual, queryFn: () => api.bots.manual() });
  const act = useSend(qk.chatBotRuns(chatId));

  // the engine publishes the chat on every start, wait, end and stop, including ones made by someone else
  useWsEvent((ev) => {
    if (ev.type === 'chat.updated' && ev.chat.id === chatId) {
      void qc.invalidateQueries({ queryKey: qk.chatBotRuns(chatId), exact: true });
    }
  });

  const running = runs.data ?? [];
  const runningBotIds = new Set(running.map((r) => r.botId));
  const bots = manual.data ?? [];

  return (
    <div className={`${menu} absolute bottom-full left-0 z-10 mb-2 w-72 text-sm`}>
      {running.length > 0 && (
        <ul aria-label="Chatbots em execução" className="mb-1.5 border-b border-border pb-1.5">
          {running.map((r) => (
            <li key={r.id} className="flex items-center gap-2.5 py-1 pr-1 pl-3">
              <Robot size={16} weight="fill" aria-hidden className="shrink-0 text-primary" />
              <span className="min-w-0 flex-1 truncate">{r.botName}</span>
              <button
                type="button"
                disabled={act.isPending}
                onClick={() => act.mutate(() => api.botRuns.stop(r.id), { onSuccess: onClose })}
                className={button('danger', 'sm')}
              >
                Parar chatbot
              </button>
            </li>
          ))}
        </ul>
      )}
      <h4 className="px-3 pt-1 pb-1.5 text-xs font-bold text-muted">Executar chatbot</h4>
      {manual.isPending ? (
        <p className="px-3 py-2 text-muted">Carregando…</p>
      ) : bots.length === 0 ? (
        <p className="px-3 py-2 text-[13px] leading-[18px] text-muted">
          Nenhum chatbot pode ser iniciado por aqui. No editor, use o bloco “Iniciar manualmente” e marque “Permitir que atendentes
          iniciem pela conversa”.
        </p>
      ) : (
        <ul className="max-h-60 overflow-y-auto">
          {bots.map((b) => {
            const alreadyRunning = runningBotIds.has(b.id);
            return (
              <li key={b.id}>
                <button
                  type="button"
                  disabled={act.isPending || alreadyRunning}
                  title={alreadyRunning ? 'Já em execução nesta conversa' : undefined}
                  onClick={() => act.mutate(() => api.botRuns.start(chatId, b.id), { onSuccess: onClose })}
                  className={menuItem}
                >
                  <span className="min-w-0 truncate">{b.title}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <ErrorText error={act.error ?? manual.error ?? runs.error} className="px-3" />
    </div>
  );
}
