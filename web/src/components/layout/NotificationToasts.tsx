import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { BellRingingIcon } from '@phosphor-icons/react';
import type { NotificationDto } from '@talk/shared';
import { useWsEvent } from '../../lib/ws';

export const TOAST_MS = 8000;

const titleOf = (n: NotificationDto) => n.title.trim() || 'Notificação do chatbot';

/** notify_agent (spec §4): an 8 s toast plus a browser notification when allowed. Mount once in AppLayout. */
export function NotificationToasts() {
  const navigate = useNavigate();
  const [items, setItems] = useState<NotificationDto[]>([]);
  const dismiss = (id: string) => setItems((cur) => cur.filter((n) => n.id !== id));

  useWsEvent((ev) => {
    if (ev.type !== 'notification') return;
    const n = ev.notification;
    setItems((cur) => [...cur, n]);
    // ponytail: one timer per toast, not cleared on unmount (a setState after unmount is a no-op)
    setTimeout(() => dismiss(n.id), TOAST_MS);
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const browser = new Notification(titleOf(n), { body: n.text, tag: n.id });
    browser.onclick = () => {
      window.focus();
      navigate(`/chats/${n.chatId}`);
      browser.close();
    };
  });

  return (
    <div aria-live="polite" className="fixed right-4 bottom-4 z-50 flex w-80 max-w-[calc(100%-2rem)] flex-col gap-2">
      {items.map((n) => (
        <Link
          key={n.id}
          to={`/chats/${n.chatId}`}
          onClick={() => dismiss(n.id)}
          className="block rounded-lg border border-border bg-panel p-3 text-fg shadow-xl hover:bg-sidebar-hover"
        >
          <p className="flex items-center gap-1.5 text-sm font-semibold">
            <BellRingingIcon size={16} weight="fill" aria-hidden className="shrink-0 text-primary" />
            {titleOf(n)}
          </p>
          {n.text && <p className="mt-1 text-sm break-words whitespace-pre-wrap">{n.text}</p>}
          <p className="mt-1 text-xs text-muted">Chatbot {n.botName}</p>
        </Link>
      ))}
    </div>
  );
}
