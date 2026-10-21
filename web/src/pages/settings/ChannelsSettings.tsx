import { useEffect, useId, useState, type FormEvent } from 'react';
import { PlusIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ChannelDto, HistoryImportDto, HistoryPeriod } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { confirmDialog } from '../../lib/confirm';
import { formatPhone } from '../../lib/format';
import { badge, badgeTone, field, fieldLabel, fieldSelect } from '../../components/ui';
import { ErrorText, Loading, Section, block, btnDanger, btnPrimary, btnSecondary, send, useSend } from '../../components/settings/common';

const QR_POLL_MS = 5_000;

const STATUS: Record<ChannelDto['status'], { label: string; className: string }> = {
  connected: { label: 'Conectado', className: badgeTone.success },
  connecting: { label: 'Conectando', className: badgeTone.accent },
  disconnected: { label: 'Desconectado', className: badgeTone.warning },
};

/** History spec §3: the three periods (the phone sends about 3.5 months whatever is picked). */
const PERIODS: Array<[HistoryPeriod, string]> = [
  ['3m', '3 meses'],
  ['12m', '12 meses'],
  ['all', 'Tudo'],
];

const asImageSrc = (qr: string) => (qr.startsWith('data:') ? qr : `data:image/png;base64,${qr}`);

function withQr(current: Record<string, string>, channelId: string, qr: string | null) {
  const next = { ...current };
  if (qr) next[channelId] = qr;
  else delete next[channelId];
  return next;
}

const count = (n: number) => n.toLocaleString('pt-BR');
const day = (iso: string) => new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });

/** History spec §5.6: the import line under the channel; channel.status keeps it live. */
export function importText(imp: HistoryImportDto): string {
  if (imp.state === 'running') return `Importando histórico… ${count(imp.messagesImported)} mensagens`;
  if (imp.state === 'failed') return 'A importação do histórico falhou. Clique em “Importar histórico” para tentar de novo.';
  return `Histórico importado: ${count(imp.messagesImported)} mensagens${imp.oldestMessageAt ? `, desde ${day(imp.oldestMessageAt)}` : ''}`;
}

export function ChannelsSettings() {
  const qc = useQueryClient();
  // applyWsEvent writes every channel.status into qk.channels, so this list (pill and import line) is live
  const channels = useQuery({ queryKey: qk.channels, queryFn: api.channels.list });
  const create = useSend(qk.channels);
  const [name, setName] = useState('');
  const nameId = useId();
  const [qr, setQr] = useState<Record<string, string>>({});
  const [periods, setPeriods] = useState<Record<string, HistoryPeriod>>({});
  const periodOf = (c: ChannelDto): HistoryPeriod => periods[c.id] ?? c.historyPeriod ?? '3m';

  const connect = useMutation({
    mutationFn: (v: { id: string; period: HistoryPeriod }) => api.channels.connect(v.id, v.period),
    // the first QR may come back here; null QR = no QR yet or Evolution already has a session. Refetch the list too,
    // so a "connecting" status starts the QR polling below even if the channel.status event is late.
    onSuccess: ({ qrBase64 }, v) => {
      setQr((cur) => withQr(cur, v.id, qrBase64));
      void qc.invalidateQueries({ queryKey: qk.channels });
    },
  });
  const importHistory = useMutation({
    mutationFn: (v: { id: string; period: HistoryPeriod }) => api.channels.importHistory(v.id, v.period),
    onSuccess: (ch) => qc.setQueryData<ChannelDto[]>(qk.channels, (list) => list?.map((c) => (c.id === ch.id ? ch : c))),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.channels.remove(id),
    onSuccess: (_r, id) => {
      setQr((cur) => withQr(cur, id, null));
      qc.setQueryData<ChannelDto[]>(qk.channels, (list) => list?.filter((c) => c.id !== id));
      void qc.invalidateQueries({ queryKey: qk.chats }); // its chats are gone
    },
  });

  async function confirmRemove(c: ChannelDto) {
    const ok = await confirmDialog({
      title: `Excluir o canal “${c.name}”?`,
      body:
        'O WhatsApp deste canal será desconectado e as conversas, mensagens e arquivos dele serão apagados do sistema. ' +
        'Os contatos continuam. Isso não pode ser desfeito.',
      confirmLabel: 'Excluir canal',
    });
    if (ok) remove.mutate(c.id);
  }

  // History spec §7: poll while a channel is connecting, even when connect answered without a QR (it can come later),
  // and while a shown QR is not connected yet (later QRs arrive as qrcode.updated). A stable string, so the
  // interval is not reset on every render.
  const polling = (channels.data ?? [])
    .filter((c) => c.status === 'connecting' || (qr[c.id] !== undefined && c.status !== 'connected'))
    .map((c) => c.id)
    .join(',');

  // ponytail: 5 s polling; push qrcode.updated over WS if this ever feels slow.
  useEffect(() => {
    if (!polling) return;
    const poll = () => {
      for (const id of polling.split(',')) {
        send<{ qrBase64: string | null }>(`/api/channels/${id}/qr`, 'GET')
          .then(({ qrBase64 }) => {
            if (qrBase64) setQr((cur) => withQr(cur, id, qrBase64));
          })
          .catch(() => {}); // a failed poll keeps the last QR on screen; the next tick retries
      }
    };
    poll();
    const t = setInterval(poll, QR_POLL_MS);
    return () => clearInterval(t);
  }, [polling]);

  if (!channels.data) return <Loading error={channels.error} />;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    create.mutate(() => send('/api/channels', 'POST', { name: name.trim() }), { onSuccess: () => setName('') });
  }

  return (
    <Section title="Canais">
      <form onSubmit={submit} className={`${block} mb-5`}>
        <label htmlFor={nameId} className={fieldLabel}>
          Nome do novo canal
        </label>
        <div className="flex flex-wrap items-center gap-2.5">
          <input
            id={nameId}
            aria-label="Nome do novo canal"
            placeholder="Nome do canal (ex.: WhatsApp do escritório)"
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            className={`${field} min-w-0 flex-[1_1_240px]`}
          />
          <button type="submit" disabled={!name.trim() || create.isPending} className={btnPrimary}>
            <PlusIcon size={16} weight="bold" aria-hidden />
            Novo canal
          </button>
        </div>
      </form>
      <ErrorText error={create.error} />
      <ErrorText error={connect.error} />
      <ErrorText error={importHistory.error} />
      <ErrorText error={remove.error} />

      {channels.data.length === 0 && <p className="text-sm text-muted">Nenhum canal cadastrado.</p>}
      <ul>
        {channels.data.map((c) => {
          const code = qr[c.id];
          const running = c.historyImport?.state === 'running';
          return (
            <li key={c.id} className="border-b border-border px-1 py-5 first:pt-0 last:border-b-0">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-bold">{c.name}</p>
                  <p className="text-[13px] leading-[18px] text-muted tabular-nums">{c.phone ? formatPhone(c.phone) : 'Nenhum número conectado'}</p>
                </div>
                <span className={`${badge} ${STATUS[c.status].className}`}>
                  {STATUS[c.status].label}
                </span>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-2">
                <span className="text-[13px] font-semibold">Período do histórico</span>
                <select
                  aria-label="Período do histórico"
                  value={periodOf(c)}
                  onChange={(e) => setPeriods((cur) => ({ ...cur, [c.id]: e.target.value as HistoryPeriod }))}
                  className={`${fieldSelect} max-w-40`}
                >
                  {PERIODS.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                {c.status !== 'connected' && (
                  <button
                    type="button"
                    disabled={connect.isPending}
                    onClick={() => connect.mutate({ id: c.id, period: periodOf(c) })}
                    className={btnSecondary}
                  >
                    Gerar novo QR / Reconectar
                  </button>
                )}
                <button
                  type="button"
                  disabled={importHistory.isPending || running}
                  onClick={() => importHistory.mutate({ id: c.id, period: periodOf(c) })}
                  className={btnSecondary}
                >
                  Importar histórico
                </button>
                <button
                  type="button"
                  disabled={remove.isPending}
                  onClick={() => void confirmRemove(c)}
                  className={`${btnDanger} ml-auto`}
                >
                  Excluir canal
                </button>
              </div>
              <p className="mt-2 text-[13px] leading-[18px] text-muted">
                O WhatsApp envia cerca de 3,5 meses de histórico; com “12 meses” ou “Tudo” vem só o que o celular mandar.
              </p>
              {c.historyImport && (
                <p role="status" className="mt-2 text-[13px] leading-[18px] font-semibold">
                  {importText(c.historyImport)}
                </p>
              )}

              {c.status === 'connecting' && !code && <p className={`${block} mt-4 text-sm text-muted`}>Gerando QR code…</p>}
              {code && c.status !== 'connected' && (
                <div className={`${block} mt-4 flex flex-wrap items-start gap-5`}>
                  <img src={asImageSrc(code)} alt={`QR Code do canal ${c.name}`} className="size-64 shrink-0 rounded-block bg-surface p-2" />
                  <ol className="max-w-xs list-decimal space-y-2 pl-5 text-sm text-fg-2 marker:font-bold marker:text-muted">
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
