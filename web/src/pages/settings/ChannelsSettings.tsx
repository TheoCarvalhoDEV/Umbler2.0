import { useEffect, useId, useState } from 'react';
import { PlusIcon, WhatsappLogoIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ChannelDto, HistoryImportDto, HistoryPeriod } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { confirmDialog, promptDialog } from '../../lib/confirm';
import { formatPhone } from '../../lib/format';
import { badge, badgeTone, fieldSelect } from '../../components/ui';
import {
  EmptyState, ErrorText, ListRow, Loading, PageHeader, RowMenu, SettingRow, btnPrimary, btnSecondary, send, useSend,
} from '../../components/settings/common';

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

/** The QR / "Gerando QR code…" card inside the channel: highlighted, it is what to look at while connecting. */
const qrCard = 'my-3 rounded-block bg-primary-soft p-4 text-fg';

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
  const add = useSend(qk.channels);
  const idBase = useId();
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

  async function newChannel() {
    add.reset();
    const name = await promptDialog({
      title: 'Novo canal',
      body: 'Ex.: WhatsApp do escritório.',
      label: 'Nome do canal',
      confirmLabel: 'Criar canal',
      maxLength: 60,
    });
    if (name) add.mutate(() => send('/api/channels', 'POST', { name }));
  }

  return (
    <>
      <PageHeader
        title="Canais"
        description="Os números de WhatsApp do escritório. Cada canal se conecta lendo um QR code com o celular."
        action={
          <button type="button" onClick={() => void newChannel()} disabled={add.isPending} className={btnPrimary}>
            <PlusIcon size={16} weight="bold" aria-hidden />
            Novo canal
          </button>
        }
      />
      <ErrorText error={add.error} />
      <ErrorText error={connect.error} />
      <ErrorText error={importHistory.error} />
      <ErrorText error={remove.error} />

      {channels.data.length === 0 ? (
        <EmptyState
          icon={<WhatsappLogoIcon size={28} />}
          title="Nenhum canal cadastrado."
          hint="Crie o primeiro em “Novo canal” e conecte-o pelo QR code."
        />
      ) : (
        <ul className="mt-5">
          {channels.data.map((c) => {
            const code = qr[c.id];
            const running = c.historyImport?.state === 'running';
            const periodId = `${idBase}-${c.id}`;
            return (
              <ListRow
                key={c.id}
                leading={<WhatsappLogoIcon size={20} aria-hidden />}
                title={c.name}
                badges={<span className={`${badge} ${STATUS[c.status].className}`}>{STATUS[c.status].label}</span>}
                subtitle={<span className="tabular-nums">{c.phone ? formatPhone(c.phone) : 'Nenhum número conectado'}</span>}
                actions={
                  <RowMenu
                    label={`Opções do canal ${c.name}`}
                    items={[{ label: 'Excluir canal', onSelect: () => void confirmRemove(c), danger: true, disabled: remove.isPending }]}
                  />
                }
              >
                <SettingRow
                  label="Período do histórico"
                  htmlFor={periodId}
                  description="O WhatsApp envia cerca de 3,5 meses de histórico; com “12 meses” ou “Tudo” vem só o que o celular mandar."
                  control={
                    <div className="w-40">
                      <select
                        id={periodId}
                        value={periodOf(c)}
                        onChange={(e) => setPeriods((cur) => ({ ...cur, [c.id]: e.target.value as HistoryPeriod }))}
                        className={fieldSelect}
                      >
                        {PERIODS.map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </div>
                  }
                />
                {c.status !== 'connected' && (
                  <SettingRow
                    label="Conexão"
                    description="Gere um QR code e leia com o WhatsApp do celular. O histórico vem conforme o período acima."
                    control={
                      <button
                        type="button"
                        disabled={connect.isPending}
                        onClick={() => connect.mutate({ id: c.id, period: periodOf(c) })}
                        className={btnSecondary}
                      >
                        Gerar novo QR / Reconectar
                      </button>
                    }
                  />
                )}
                {c.status === 'connecting' && !code && <p className={`${qrCard} text-sm`}>Gerando QR code…</p>}
                {code && c.status !== 'connected' && (
                  <div className={`${qrCard} flex flex-wrap items-start gap-5`}>
                    <img src={asImageSrc(code)} alt={`QR Code do canal ${c.name}`} className="size-64 shrink-0 rounded-block bg-surface p-2" />
                    <ol className="max-w-xs list-decimal space-y-2 pl-5 text-sm marker:font-bold marker:text-accent-ink">
                      <li>Abra o WhatsApp no celular do escritório.</li>
                      <li>Toque em Mais opções › Aparelhos conectados › Conectar um aparelho.</li>
                      <li>Aponte a câmera para este código.</li>
                      <li>O código se renova sozinho (esta tela busca o mais recente a cada 5 segundos). Mantenha-a aberta até aparecer “Conectado”.</li>
                    </ol>
                  </div>
                )}
                <SettingRow
                  label="Histórico de conversas"
                  description={
                    c.historyImport ? (
                      <span role="status" className="font-semibold text-fg">
                        {importText(c.historyImport)}
                      </span>
                    ) : (
                      'Traz as conversas antigas do celular para o sistema.'
                    )
                  }
                  control={
                    <button
                      type="button"
                      disabled={importHistory.isPending || running}
                      onClick={() => importHistory.mutate({ id: c.id, period: periodOf(c) })}
                      className={btnSecondary}
                    >
                      Importar histórico
                    </button>
                  }
                />
              </ListRow>
            );
          })}
        </ul>
      )}
    </>
  );
}
