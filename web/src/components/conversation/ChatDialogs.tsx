import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ChatDetail, SectorDto, UserDto } from '@talk/shared';
import { api, qk } from '../../lib/api';

// Native <dialog>: showModal() gives focus trapping, Esc and the backdrop for free.
function Modal({ title, onCancel, children }: { title: string; onCancel: () => void; children: ReactNode }) {
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
        onCancel();
      }}
      className="m-auto w-[min(28rem,calc(100%-2rem))] rounded-lg bg-panel p-5 text-fg shadow-xl backdrop:bg-black/50"
    >
      <h3 className="mb-4 text-base font-semibold">{title}</h3>
      {children}
    </dialog>
  );
}

function Actions(props: { busy: boolean; error: string | null; confirmLabel: string; onCancel: () => void; onConfirm: () => void }) {
  return (
    <>
      {props.error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {props.error}
        </p>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" onClick={props.onCancel} className="rounded px-3 py-2 text-sm hover:bg-surface">
          Cancelar
        </button>
        <button
          type="button"
          disabled={props.busy}
          onClick={props.onConfirm}
          className="rounded bg-primary px-3 py-2 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50"
        >
          {props.confirmLabel}
        </button>
      </div>
    </>
  );
}

const field = 'mt-1 block w-full rounded border border-border bg-surface px-2 py-1.5 text-sm text-fg';

export function TransferDialog(props: {
  chat: ChatDetail;
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
    <Modal title="Transferir conversa" onCancel={props.onCancel}>
      <label className="mb-3 block text-sm">
        Setor
        <select
          value={sectorId}
          onChange={(e) => {
            setSectorId(e.target.value);
            setOwnerId(''); // the agent list depends on the sector
          }}
          className={field}
        >
          {props.sectors.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-sm">
        Atendente
        <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)} className={field}>
          <option value="">Ninguém (fila do setor)</option>
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
        onCancel={props.onCancel}
        onConfirm={() => props.onConfirm({ sectorId, ownerId: ownerId || null })}
      />
    </Modal>
  );
}

export function CloseDialog(props: {
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
    <Modal title="Finalizar conversa" onCancel={props.onCancel}>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={send}
          disabled={!closing}
          onChange={(e) => setChoice(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          Enviar mensagem de encerramento
          {!closing && settings.isSuccess && (
            <span className="block text-xs text-muted">Nenhuma mensagem de encerramento configurada.</span>
          )}
        </span>
      </label>
      {closing && <p className="mt-2 whitespace-pre-wrap rounded bg-surface p-2 text-xs text-muted">{closing}</p>}
      <Actions
        busy={props.busy || settings.isPending}
        error={props.error}
        confirmLabel="Finalizar"
        onCancel={props.onCancel}
        onConfirm={() => props.onConfirm(send)}
      />
    </Modal>
  );
}
