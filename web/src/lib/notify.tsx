import { useEffect, useRef, useState } from 'react';
import { useMatch, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { BrowserNotificationMode, UserPreferences } from '@talk/shared';
import { preferencesOf } from './auth';
import { onWsEvent } from './ws';

function beep(): void {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.value = 0.1;
    osc.connect(gain).connect(ctx.destination);
    osc.onended = () => void ctx.close();
    osc.start();
    osc.stop(ctx.currentTime + 0.15);
  } catch {
    // navegador bloqueou o áudio (sem interação prévia); a notificação ainda aparece
  }
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
export function showBrowserNotification(title: string, body: string, tag: string, open: () => void): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const n = new Notification(title, { body, tag });
  n.onclick = () => {
    window.focus();
    open();
    n.close();
  };
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
        const { chatId, body } = e.message;
        const alerts = messageAlerts(preferencesOf(qc), { hidden: document.hidden, chatOnScreen: openRef.current === chatId });
        if (alerts.sound) beep();
        if (alerts.browser) {
          showBrowserNotification('Nova mensagem', body ? body.slice(0, 120) : 'Mídia recebida', chatId, () => navigate(`/chats/${chatId}`));
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
  if (permission === 'granted') return <p className="px-3 py-2 text-sm text-muted">Notificações ativadas</p>;
  if (permission === 'denied') return <p className="px-3 py-2 text-sm text-muted">Notificações bloqueadas no navegador</p>;
  return (
    <button
      type="button"
      onClick={async () => setPermission(await Notification.requestPermission())}
      className="block w-full px-3 py-2 text-left text-sm hover:bg-sidebar-hover"
    >
      Ativar notificações
    </button>
  );
}
