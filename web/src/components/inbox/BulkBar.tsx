import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { BulkResultDto, ChatTab } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { CloseDialog, TransferDialog } from '../conversation/ChatDialogs';
import { bulkSummary } from './bulk';

interface Props {
  /** The selected chats still in the list. */
  chatIds: string[];
  tab: ChatTab;
  /** After each run: the summary line and the chats that could not be done. */
  onResult(summary: string, failedIds: string[]): void;
  onCancel(): void;
}

const conversations = (n: number) => (n === 1 ? '1 conversa' : `${n} conversas`);

/** Spec 2026-10-20 §4: the bar under the list while "Selecionar" is on. */
export function BulkBar({ chatIds, tab, onResult, onCancel }: Props) {
  const sectors = useQuery({ queryKey: qk.sectors, queryFn: api.sectors.list }).data ?? [];
  const users = useQuery({ queryKey: qk.users, queryFn: api.users.list }).data ?? [];
  const [dialog, setDialog] = useState<'transfer' | 'close' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const n = chatIds.length;
  const workable = tab !== 'closed'; // Finalizados: nothing to transfer or finish
  const startSector = sectors.find((s) => s.isDefault) ?? sectors[0];

  async function run(call: () => Promise<BulkResultDto>) {
    setBusy(true);
    setError(null);
    try {
      const result = await call();
      setDialog(null);
      onResult(bulkSummary(result), result.failed.map((f) => f.chatId));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível concluir. Tente de novo.');
    } finally {
      setBusy(false);
    }
  }

  function closeDialog() {
    setDialog(null);
    setError(null);
  }

  const button =
    'h-8 rounded-lg border border-border bg-surface px-2.5 font-medium hover:bg-sidebar-hover disabled:cursor-not-allowed disabled:opacity-50';
  return (
    <div className="border-t border-border bg-panel px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-auto font-semibold">{n === 1 ? '1 selecionada' : `${n} selecionadas`}</span>
        <button type="button" disabled={busy || n === 0 || !workable} onClick={() => setDialog('transfer')} className={button}>
          Transferir
        </button>
        <button type="button" disabled={busy || n === 0 || !workable} onClick={() => setDialog('close')} className={button}>
          Finalizar
        </button>
        <button type="button" disabled={busy || n === 0} onClick={() => void run(() => api.chats.bulkRead(chatIds))} className={button}>
          Marcar como lida
        </button>
        <button type="button" onClick={onCancel} className="h-8 rounded-lg px-2.5 text-muted hover:text-fg">
          Cancelar
        </button>
      </div>
      {error && !dialog && (
        <p role="alert" className="mt-2 text-danger">
          {error}
        </p>
      )}
      {dialog === 'transfer' && startSector && (
        <TransferDialog
          title={`Transferir ${conversations(n)}`}
          chat={{ sectorId: startSector.id }}
          sectors={sectors}
          users={users}
          busy={busy}
          error={error}
          onCancel={closeDialog}
          onConfirm={(to) => void run(() => api.chats.bulkTransfer({ chatIds, ...to }))}
        />
      )}
      {dialog === 'close' && (
        <CloseDialog
          title={`Finalizar ${conversations(n)}`}
          busy={busy}
          error={error}
          onCancel={closeDialog}
          onConfirm={(sendClosingMessage) => void run(() => api.chats.bulkClose({ chatIds, sendClosingMessage }))}
        />
      )}
    </div>
  );
}
