import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { BellRingingIcon, WarningCircleIcon } from '@phosphor-icons/react';
import { useQueryClient } from '@tanstack/react-query';
import type { NotificationDto } from '@talk/shared';
import { preferencesOf } from '../../lib/auth';
import { browserNotificationAllowed, showBrowserNotification } from '../../lib/notify';
import { useWsEvent } from '../../lib/ws';

export const TOAST_MS = 8000;

const titleOf = (n: NotificationDto) => n.title.trim() || 'Notificação do chatbot';
/** Spec 2026-10-20 agendamentos §3.3: a failed scheduled message opens "Agendamentos → Falharam"; a bot's notice, its chat. */
const failed = (n: NotificationDto) => n.kind === 'scheduled_failed';
const targetOf = (n: NotificationDto) => (failed(n) ? '/agendamentos?aba=mensagens&status=failed' : `/chats/${n.chatId}`);
const footerOf = (n: NotificationDto) => (failed(n) ? 'Mensagens agendadas' : `Chatbot ${n.botName}`);

/** notify_agent (spec §4): an 8 s toast plus a browser notification when allowed. Mount once in AppLayout. */
export function NotificationToasts() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [items, setItems] = useState<NotificationDto[]>([]);
  const dismiss = (id: string) => setItems((cur) => cur.filter((n) => n.id !== id));

  useWsEvent((ev) => {
    if (ev.type !== 'notification') return;
    const n = ev.notification;
    setItems((cur) => [...cur, n]);
    // ponytail: one timer per toast, not cleared on unmount (a setState after unmount is a no-op)
    setTimeout(() => dismiss(n.id), TOAST_MS);
    // Spec 2026-10-19 §6: the browser notification follows the user's choice; the toast above always shows.
    if (browserNotificationAllowed(preferencesOf(qc).browserNotifications, document.hidden)) {
      showBrowserNotification(titleOf(n), n.text, n.id, () => navigate(targetOf(n)));
    }
  });

  return (
    <div aria-live="polite" className="fixed right-4 bottom-4 z-50 flex w-80 max-w-[calc(100%-2rem)] flex-col gap-2">
      {items.map((n) => (
        <Link
          key={n.id}
          to={targetOf(n)}
          onClick={() => dismiss(n.id)}
          className="flex gap-3 rounded-item bg-surface p-3.5 text-fg shadow-pop hover:bg-sidebar-hover"
        >
          {/* a failure reads as one: the danger tone and a warning instead of the bell */}
          <span
            aria-hidden
            className={`grid size-8 shrink-0 place-items-center rounded-full ${failed(n) ? 'bg-danger-soft text-danger' : 'bg-primary-soft text-accent-ink'}`}
          >
            {failed(n) ? <WarningCircleIcon size={16} /> : <BellRingingIcon size={16} />}
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <p className="font-bold">{titleOf(n)}</p>
            {n.text && <p className="break-words whitespace-pre-wrap">{n.text}</p>}
            <p className="mt-0.5 text-xs text-muted">{footerOf(n)}</p>
          </div>
        </Link>
      ))}
    </div>
  );
}
