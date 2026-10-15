import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { ChannelDto } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { formatPhone } from '../../lib/format';
import { ErrorText, Loading, Section, btn, btnPrimary, send, useSend } from '../../components/settings/common';

const QR_POLL_MS = 5_000;

const STATUS: Record<ChannelDto['status'], { label: string; className: string }> = {
  connected: { label: 'Conectado', className: 'bg-success/20 text-success' },
  connecting: { label: 'Conectando', className: 'bg-primary/20 text-link' },
  disconnected: { label: 'Desconectado', className: 'bg-danger/20 text-danger' },
};

const asImageSrc = (qr: string) => (qr.startsWith('data:') ? qr : `data:image/png;base64,${qr}`);

function withQr(current: Record<string, string>, channelId: string, qr: string | null) {
  const next = { ...current };
  if (qr) next[channelId] = qr;
  else delete next[channelId];
  return next;
}

export function ChannelsSettings() {
  // Task 15's applyWsEvent writes every channel.status into qk.channels, so this list (and the pill) is live
  const channels = useQuery({ queryKey: qk.channels, queryFn: api.channels.list });
  const create = useSend(qk.channels);
  const [name, setName] = useState('');
  const [qr, setQr] = useState<Record<string, string>>({});
  const connect = useMutation({
    mutationFn: (channelId: string) => api.channels.connect(channelId),
    // the first QR comes back here; null QR = Evolution already has a session (status arrives via channel.status)
    onSuccess: ({ qrBase64 }, channelId) => setQr((cur) => withQr(cur, channelId, qrBase64)),
  });

  // channels showing a QR that are not connected yet (a stable string, so the interval is not reset on every render)
  const waiting = Object.keys(qr)
    .filter((id) => channels.data?.find((c) => c.id === id)?.status !== 'connected')
    .join(',');

  // §5.6: later QRs arrive as qrcode.updated webhooks; the server keeps the latest (Task 14,
  // GET /api/channels/:id/qr). Poll it while the channel is not connected.
  // ponytail: 5 s polling; push qrcode.updated over WS if this ever feels slow.
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => {
      for (const id of waiting.split(',')) {
        send<{ qrBase64: string | null }>(`/api/channels/${id}/qr`, 'GET')
          .then(({ qrBase64 }) => {
            if (qrBase64) setQr((cur) => withQr(cur, id, qrBase64));
          })
          .catch(() => {}); // a failed poll keeps the last QR on screen; the next tick retries
      }
    }, QR_POLL_MS);
    return () => clearInterval(t);
  }, [waiting]);

  if (!channels.data) return <Loading error={channels.error} />;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    create.mutate(() => send('/api/channels', 'POST', { name: name.trim() }), { onSuccess: () => setName('') });
  }

  return (
    <Section title="Canais">
      <form onSubmit={submit} className="mb-6 flex gap-2">
        <input
          aria-label="Nome do novo canal"
          placeholder="Nome do canal (ex.: WhatsApp do escritório)"
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          className="flex-1 rounded border border-border px-2 py-1.5 text-sm"
        />
        <button type="submit" disabled={!name.trim() || create.isPending} className={btnPrimary}>
          Novo canal
        </button>
      </form>
      <ErrorText error={create.error} />
      <ErrorText error={connect.error} />

      {channels.data.length === 0 && <p className="text-sm text-muted">Nenhum canal cadastrado.</p>}
      <ul className="space-y-3">
        {channels.data.map((c) => {
          const code = qr[c.id];
          return (
            <li key={c.id} className="rounded border border-border p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="font-medium">{c.name}</p>
                  <p className="text-sm text-muted">{c.phone ? formatPhone(c.phone) : 'Nenhum número conectado'}</p>
                </div>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS[c.status].className}`}>
                  {STATUS[c.status].label}
                </span>
              </div>
              {c.status !== 'connected' && (
                <button
                  type="button"
                  disabled={connect.isPending}
                  onClick={() => connect.mutate(c.id)}
                  className={`${btn} mt-3`}
                >
                  Gerar novo QR / Reconectar
                </button>
              )}
              {code && c.status !== 'connected' && (
                <div className="mt-4 flex flex-wrap gap-4">
                  <img src={asImageSrc(code)} alt={`QR Code do canal ${c.name}`} className="h-64 w-64 rounded border border-border bg-panel p-2" />
                  <ol className="max-w-xs list-decimal space-y-1 pl-5 text-sm">
                    <li>Abra o WhatsApp no celular do escritório.</li>
                    <li>Toque em Mais opções › Aparelhos conectados › Conectar um aparelho.</li>
                    <li>Aponte a câmera para este código.</li>
                    <li>O código se renova sozinho (esta tela busca o mais recente a cada 5 segundos). Mantenha-a aberta até aparecer “Conectado”.</li>
                  </ol>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
