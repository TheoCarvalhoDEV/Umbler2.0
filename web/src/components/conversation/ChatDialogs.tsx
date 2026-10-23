import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowsLeftRight, Check } from '@phosphor-icons/react';
import type { BotAction, BotRunningErrorBody, ChatDetail, SectorDto, UserDto } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { button, checkbox, dialog, dialogTitle, fieldLabel, fieldSelect } from '../ui';

// Native <dialog>: showModal() gives focus trapping, Esc and the backdrop for free.
export function Modal({ title, onCancel, children }: { title: string; onCancel: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault(); // Esc: let React unmount it
        e.stopPropagation(); // a dialog opened over another (Compromissos → Novo compromisso) closes alone
        onCancel();
      }}
      className={dialog}
    >
      <h3 className={`${dialogTitle} mb-4`}>{title}</h3>
      {children}
    </dialog>
  );
}

export function Actions(props: {
  busy: boolean;
  error: string | null;
  confirmLabel: string;
  /** Optional 16px icon before the confirm label (the boards draw Transferir and Finalizar with one). */
  confirmIcon?: ReactNode;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <>
      {props.error && (
        <p role="alert" className="mt-4 text-[13px] font-semibold text-danger">
          {props.error}
        </p>
      )}
      <div className="mt-6 flex flex-wrap justify-end gap-2">
        <button type="button" onClick={props.onCancel} className={button('secondary')}>
          Cancelar
        </button>
        <button type="button" disabled={props.busy} onClick={props.onConfirm} className={button('primary')}>
          {props.confirmIcon}
          {props.confirmLabel}
        </button>
      </div>
    </>
  );
}

export function TransferDialog(props: {
  /** Only the starting sector is read; the bulk bar passes the default sector. */
  chat: Pick<ChatDetail, 'sectorId'>;
  /** Spec 2026-10-20 §4: "Transferir N conversas". */
  title?: string;
  sectors: SectorDto[];
  users: UserDto[];
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (to: { sectorId: string; ownerId: string | null }) => void;
}) {
  const [sectorId, setSectorId] = useState(props.chat.sectorId);
  const [ownerId, setOwnerId] = useState('');
  const agents = props.users.filter((u) => u.active && u.sectorIds.includes(sectorId));
  return (
    <Modal title={props.title ?? 'Transferir conversa'} onCancel={props.onCancel}>
      <label className="block">
        <span className={fieldLabel}>Setor</span>
        <select
          value={sectorId}
          onChange={(e) => {
            setSectorId(e.target.value);
            setOwnerId(''); // the agent list depends on the sector
          }}
          className={fieldSelect}
        >
          {props.sectors.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <label className="mt-4 block">
        <span className={fieldLabel}>Atendente</span>
        <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)} className={fieldSelect}>
          <option value="">Sem atendente (fila do setor)</option>
          {agents.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
      </label>
      <Actions
        busy={props.busy}
        error={props.error}
        confirmLabel="Transferir"
        confirmIcon={<ArrowsLeftRight size={16} aria-hidden />}
        onCancel={props.onCancel}
        onConfirm={() => props.onConfirm({ sectorId, ownerId: ownerId || null })}
      />
    </Modal>
  );
}

export function CloseDialog(props: {
  title?: string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (sendClosingMessage: boolean) => void;
}) {
  const settings = useQuery({ queryKey: qk.settings, queryFn: api.settings.get });
  const closing = settings.data?.closingMessage.trim() ?? '';
  const [choice, setChoice] = useState<boolean | null>(null); // null = untouched → default on when configured
  const send = closing !== '' && (choice ?? true);
  return (
    <Modal title={props.title ?? 'Finalizar conversa'} onCancel={props.onCancel}>
      <label className="flex items-start gap-2 text-[13px] leading-[18px] font-semibold">
        <input
          type="checkbox"
          checked={send}
          disabled={!closing}
          onChange={(e) => setChoice(e.target.checked)}
          className={checkbox}
        />
        <span>
          Enviar mensagem de encerramento
          {!closing && settings.isSuccess && (
            <span className="mt-0.5 block text-xs font-normal text-muted">Nenhuma mensagem de encerramento configurada.</span>
          )}
        </span>
      </label>
      {closing && <p className="mt-3 whitespace-pre-wrap rounded-block bg-sunken px-3.5 py-3 text-[13px] leading-[18px] text-muted">{closing}</p>}
      <Actions
        busy={props.busy || settings.isPending}
        error={props.error}
        confirmLabel="Finalizar"
        confirmIcon={<Check size={16} aria-hidden />}
        onCancel={props.onCancel}
        onConfirm={() => props.onConfirm(send)}
      />
    </Modal>
  );
}

const BOT_RUNNING_LABELS = {
  send: { stop: 'Parar e enviar', keep: 'Enviar e manter' },
  transfer: { stop: 'Parar e transferir', keep: 'Transferir e manter' },
} as const;

/** 409 BOT_RUNNING (spec §5.5 "ask"). The caller retries with the chosen botAction; null = Cancelar. */
export function BotRunningDialog({
  runs,
  onChoose,
  action = 'send',
}: {
  runs: BotRunningErrorBody['runs'];
  onChoose: (a: BotAction | null) => void;
  action?: 'send' | 'transfer';
}) {
  const labels = BOT_RUNNING_LABELS[action];
  return (
    <Modal title="O chatbot está rodando" onCancel={() => onChoose(null)}>
      <p>
        Em execução nesta conversa: <strong>{runs.map((r) => r.botName).join(', ')}</strong>.
      </p>
      <p className="mt-2 text-[13px] leading-[18px] text-muted">Parar o chatbot evita que ele continue respondendo o contato.</p>
      <div className="mt-6 flex flex-wrap justify-end gap-2">
        <button type="button" onClick={() => onChoose(null)} className={button('ghost')}>
          Cancelar
        </button>
        <button type="button" onClick={() => onChoose('keep')} className={button('secondary')}>
          {labels.keep}
        </button>
        <button type="button" onClick={() => onChoose('stop')} className={button('primary')}>
          {labels.stop}
        </button>
      </div>
    </Modal>
  );
}
