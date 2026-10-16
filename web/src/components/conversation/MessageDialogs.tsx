import { useQuery } from '@tanstack/react-query';
import type { MessageEditDto } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { Modal } from './ChatDialogs';

const SOURCE_LABEL: Record<MessageEditDto['source'], string> = { office: 'Atendente', contact: 'Contato', phone: 'Celular' };

const when = (iso: string) =>
  new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Spec §5: the text a message had before each edit, newest first. */
export function EditHistoryDialog({ messageId, onClose }: { messageId: string; onClose: () => void }) {
  const edits = useQuery({ queryKey: qk.messageEdits(messageId), queryFn: () => api.messages.edits(messageId) });
  return (
    <Modal title="Versões anteriores" onCancel={onClose}>
      {edits.isPending && <p className="text-sm text-muted">Carregando…</p>}
      {edits.isError && (
        <p role="alert" className="text-sm text-danger">
          Não foi possível carregar as versões.
        </p>
      )}
      <ol className="max-h-80 space-y-2 overflow-y-auto">
        {edits.data?.map((e) => (
          <li key={e.id} className="rounded bg-surface px-3 py-2 text-sm">
            <p className="mb-1 text-xs text-muted">
              {when(e.editedAt)} · {e.editedByName ?? SOURCE_LABEL[e.source]}
              {e.newTextUnavailable ? ' · novo texto indisponível' : ''}
            </p>
            <p className="whitespace-pre-wrap break-words">{e.previousBody ?? '(sem texto)'}</p>
          </li>
        ))}
      </ol>
      <div className="mt-5 flex justify-end">
        <button type="button" onClick={onClose} className="rounded px-3 py-2 text-sm hover:bg-surface">
          Fechar
        </button>
      </div>
    </Modal>
  );
}
