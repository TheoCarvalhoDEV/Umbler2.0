import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
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

/** Sound + browser notification for incoming WhatsApp messages while this tab is hidden. Mount once in the layout. */
export function useMessageNotifications(): void {
  const navigate = useNavigate();
  useEffect(
    () =>
      onWsEvent((e) => {
        if (e.type !== 'message.created' || e.message.direction !== 'in' || !document.hidden) return;
        beep();
        if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
        const { chatId, body } = e.message;
        const n = new Notification('Nova mensagem', { body: body ? body.slice(0, 120) : 'Mídia recebida', tag: chatId });
        n.onclick = () => {
          window.focus();
          navigate(`/chats/${chatId}`);
          n.close();
        };
      }),
    [navigate],
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
