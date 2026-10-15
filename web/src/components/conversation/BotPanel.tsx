import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Robot } from '@phosphor-icons/react';
import { api, qk } from '../../lib/api';
import { useWsEvent } from '../../lib/ws';
import { ErrorText, useSend } from '../settings/common';

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
    <div className="absolute bottom-full left-0 z-10 mb-1 w-72 rounded-md border border-border bg-panel p-2 text-sm text-fg shadow-lg">
      {running.length > 0 && (
        <ul aria-label="Chatbots em execução" className="mb-2 border-b border-border pb-2">
          {running.map((r) => (
            <li key={r.id} className="flex items-center gap-2 px-1 py-1">
              <Robot size={16} weight="fill" aria-hidden className="shrink-0 text-primary" />
              <span className="min-w-0 flex-1 truncate">{r.botName}</span>
              <button
                type="button"
                disabled={act.isPending}
                onClick={() => act.mutate(() => api.botRuns.stop(r.id), { onSuccess: onClose })}
                className="rounded px-2 py-1 text-xs font-medium text-danger hover:bg-surface disabled:opacity-50"
              >
                Parar chatbot
              </button>
            </li>
          ))}
        </ul>
      )}
      <h4 className="px-1 pb-1 text-xs font-semibold text-muted uppercase">Executar chatbot</h4>
      {manual.isPending ? (
        <p className="px-1 py-1 text-muted">Carregando…</p>
      ) : bots.length === 0 ? (
        <p className="px-1 py-1 text-muted">Nenhum chatbot disponível para início manual.</p>
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
                  className="w-full truncate rounded px-2 py-1.5 text-left hover:bg-surface disabled:opacity-50"
                >
                  {b.title}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <ErrorText error={act.error ?? manual.error ?? runs.error} />
    </div>
  );
}
