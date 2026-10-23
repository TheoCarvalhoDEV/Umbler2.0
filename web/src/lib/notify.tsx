import { useEffect, useRef, useState } from 'react';
import { useMatch, useNavigate } from 'react-router';
import { useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import { BellSimpleIcon, BellSimpleSlashIcon } from '@phosphor-icons/react';
import type {
  BrowserNotificationMode, ChatDetail, ChatListItem, ContactRef, MessageDto, NotificationSound, UserPreferences,
} from '@talk/shared';
import { previewText } from '../components/conversation/model';
import { menuItem } from '../components/ui';
import { api, qk } from './api';
import { preferencesOf } from './auth';
import { contactLabel } from './format';
import { playSound } from './sounds';
import { onWsEvent } from './ws';

const SOUND_GAP_MS = 1500;
let lastSoundAt = -Infinity;

/** The message sound, at most once per 1.5 s: a burst (say, after reconnecting) plays it once. */
export function messageSound(kind: NotificationSound = 'soft'): void {
  const now = Date.now();
  if (now - lastSoundAt < SOUND_GAP_MS) return;
  lastSoundAt = now;
  playSound(kind);
}

/** "Notificações do navegador" (spec 2026-10-19 §6): Sempre, Só quando a aba está em segundo plano, Nunca. */
export function browserNotificationAllowed(mode: BrowserNotificationMode, hidden: boolean): boolean {
  return mode === 'always' || (mode === 'background' && hidden);
}

/** What a new contact message sets off. Nothing for the chat the user is reading in a visible tab. */
export function messageAlerts(
  prefs: UserPreferences,
  s: { hidden: boolean; chatOnScreen: boolean },
): { sound: boolean; browser: boolean } {
  const reading = s.chatOnScreen && !s.hidden;
  return { sound: prefs.sounds && !reading, browser: !reading && browserNotificationAllowed(prefs.browserNotifications, s.hidden) };
}

/** A browser notification, when the browser allows it, that focuses the tab and runs `open` on click. */
export function showBrowserNotification(title: string, body: string, tag: string, open: () => void, icon?: string): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const n = new Notification(title, icon ? { body, tag, icon } : { body, tag });
  n.onclick = () => {
    window.focus();
    open();
    n.close();
  };
}

/** Who wrote: the chat in the cache (detail, then any loaded list page), else asked to the server; null if unknown. */
export async function chatContact(qc: QueryClient, chatId: string): Promise<ContactRef | null> {
  const detail = qc.getQueryData<ChatDetail>(qk.chat(chatId));
  if (detail) return detail.contact;
  for (const [, data] of qc.getQueriesData<InfiniteData<{ items: ChatListItem[] }>>({ queryKey: qk.chatLists })) {
    const hit = data?.pages?.flatMap((p) => p.items).find((c) => c.id === chatId);
    if (hit) return hit.contact;
  }
  try {
    return (await api.chats.get(chatId)).contact;
  } catch {
    return null; // a chat the user can no longer see: the notification still goes, without the name
  }
}

/** Like WhatsApp: the contact's name (or phone) as the title, the message as the body and the contact's photo. */
export function messageNotification(
  contact: ContactRef | null,
  m: Pick<MessageDto, 'body' | 'kind'>,
  origin: string,
): { title: string; body: string; icon?: string } {
  const body = previewText(m.body, m.kind).slice(0, 120);
  if (!contact) return { title: 'Nova mensagem', body };
  const icon = contact.avatarUrl ? new URL(contact.avatarUrl, origin).href : undefined;
  return { title: contactLabel(contact), body, ...(icon ? { icon } : {}) };
}

/** Sound + browser notification for new contact messages, by the user's preferences. Mount once in the layout. */
export function useMessageNotifications(): void {
  const navigate = useNavigate();
  const qc = useQueryClient();
  // the chat on screen; through a ref so the subscription never restarts on navigation
  const openChatId = useMatch('/chats/:id')?.params.id;
  const openRef = useRef(openChatId);
  openRef.current = openChatId;
  useEffect(
    () =>
      onWsEvent((e) => {
        if (e.type !== 'message.created' || e.message.direction !== 'in') return;
        const { chatId } = e.message;
        const message = e.message;
        const prefs = preferencesOf(qc);
        const alerts = messageAlerts(prefs, { hidden: document.hidden, chatOnScreen: openRef.current === chatId });
        if (alerts.sound) messageSound(prefs.sound);
        if (alerts.browser) {
          void chatContact(qc, chatId).then((contact) => {
            const n = messageNotification(contact, message, window.location.origin);
            showBrowserNotification(n.title, n.body, chatId, () => navigate(`/chats/${chatId}`), n.icon);
          });
        }
      }),
    [navigate, qc],
  );
}

/** Avatar-menu item that asks the browser for notification permission. */
export function NotificationPermissionButton() {
  const supported = typeof Notification !== 'undefined';
  const [permission, setPermission] = useState<NotificationPermission>(supported ? Notification.permission : 'denied');
  if (!supported) return null;
  const status = 'flex items-center gap-2.5 px-3 py-2 text-sm text-muted';
  if (permission === 'granted') {
    return (
      <p className={status}>
        <BellSimpleIcon size={18} aria-hidden /> Notificações ativadas
      </p>
    );
  }
  if (permission === 'denied') {
    return (
      <p className={status}>
        <BellSimpleSlashIcon size={18} aria-hidden /> Notificações bloqueadas no navegador
      </p>
    );
  }
  return (
    <button
      type="button"
      onClick={async () => setPermission(await Notification.requestPermission())}
      className={menuItem}
    >
      <BellSimpleIcon size={18} aria-hidden /> Ativar notificações
    </button>
  );
}
