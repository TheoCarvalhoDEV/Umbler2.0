import { useEffect, useRef, useState } from 'react';
import { DownloadSimple, X } from '@phosphor-icons/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { BotAction, BotRunningErrorBody, MediaDto, MessageDto, MessageEditDto } from '@talk/shared';
import { api, botRunningRuns, qk, type ForwardInput } from '../../lib/api';
import { contactLabel } from '../../lib/format';
import { applyWsEvent } from '../../lib/ws';
import { BotRunningDialog, Modal } from './ChatDialogs';
import { errorMessage } from './model';

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

const field = 'mt-1 block w-full rounded border border-field bg-surface px-2 py-1.5 text-sm text-fg';
const option = 'w-full rounded px-2 py-1.5 text-left text-sm hover:bg-surface disabled:opacity-50';

/**
 * Spec §7: one destination per forward, searched like "Nova conversa". Open chats come first; a contact with an open
 * chat is listed only there. A contact without one gets a new chat (server side). 409 BOT_RUNNING asks, then retries.
 */
export function ForwardDialog({ message, onClose }: { message: MessageDto; onClose: () => void }) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [botAsk, setBotAsk] = useState<{ runs: BotRunningErrorBody['runs']; resolve: (a: BotAction | null) => void } | null>(null);
  const term = text.trim();
  const searching = term.length >= 2;

  // ponytail: one request per keystroke (cached per term), like NewChatDialog; debounce if search gets slow
  // Not qk.chatList: that prefix holds infinite-query data ({pages}) and ws.ts mapChatLists would throw on this plain result.
  const chatQuery = { tab: 'inbox' as const, q: term, limit: 5 };
  const chats = useQuery({ queryKey: ['chats', 'forward-search', chatQuery], queryFn: () => api.chats.list(chatQuery), enabled: searching });
  const contactQuery = { q: term, limit: 5 };
  const contacts = useQuery({ queryKey: qk.contactList(contactQuery), queryFn: () => api.contacts.list(contactQuery), enabled: searching });
  const openChats = searching ? (chats.data?.items ?? []) : [];
  const inOpenChat = new Set(openChats.map((c) => c.contact.id));
  const others = searching ? (contacts.data?.items ?? []).filter((c) => !inOpenChat.has(c.id)) : [];

  async function forward(to: ForwardInput) {
    setBusy(true);
    setError(null);
    try {
      let sent: MessageDto;
      try {
        sent = await api.messages.forward(message.id, to);
      } catch (e) {
        const runs = botRunningRuns(e);
        if (!runs) throw e;
        const choice = await new Promise<BotAction | null>((resolve) => setBotAsk({ runs, resolve }));
        if (!choice) return; // Cancelar: stay in the dialog
        sent = await api.messages.forward(message.id, { ...to, botAction: choice });
      }
      applyWsEvent(qc, { type: 'message.created', message: sent }); // lands in the destination's cached timeline, if any
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Encaminhar mensagem" onCancel={onClose}>
      <label className="block text-sm">
        Conversa ou contato
        <input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Nome ou telefone" className={field} />
      </label>
      {openChats.length > 0 && (
        <section className="mt-3">
          <h4 className="px-2 text-xs font-semibold text-muted">Conversas abertas</h4>
          <ul>
            {openChats.map((c) => (
              <li key={c.id}>
                <button type="button" disabled={busy} onClick={() => void forward({ chatId: c.id })} className={option}>
                  {contactLabel(c.contact)}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {others.length > 0 && (
        <section className="mt-3">
          <h4 className="px-2 text-xs font-semibold text-muted">Contatos</h4>
          <ul>
            {others.map((c) => (
              <li key={c.id}>
                <button type="button" disabled={busy} onClick={() => void forward({ contactId: c.id })} className={option}>
                  {contactLabel(c)}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {searching && chats.isSuccess && contacts.isSuccess && openChats.length === 0 && others.length === 0 && (
        <p className="mt-3 text-sm text-muted">Nenhuma conversa ou contato encontrado.</p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      )}
      <div className="mt-5 flex justify-end">
        <button type="button" onClick={onClose} className="rounded px-3 py-2 text-sm hover:bg-surface">
          Cancelar
        </button>
      </div>
      {botAsk && (
        <BotRunningDialog
          runs={botAsk.runs}
          onChoose={(choice) => {
            botAsk.resolve(choice);
            setBotAsk(null);
          }}
        />
      )}
    </Modal>
  );
}

/**
 * Opens a photo or document over the conversation instead of a new tab (videos and audio already play in the bubble). Only PDFs render as documents: the
 * server sends every other document as an attachment, so those get the download button only.
 */
export function MediaViewer({ media, kind, onClose }: { media: MediaDto; kind: MessageDto['kind']; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  const image = kind === 'image' || kind === 'sticker';
  const name = media.name ?? (image ? 'Imagem' : 'Documento');
  const pdf = media.mime.split(';')[0]!.trim().toLowerCase() === 'application/pdf';
  return (
    <dialog
      ref={ref}
      aria-label={name}
      onCancel={(e) => {
        e.preventDefault(); // Esc: let React unmount it
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose(); // a click on the backdrop
      }}
      className="m-auto h-[calc(100%-2rem)] w-[calc(100%-2rem)] max-w-5xl flex-col overflow-hidden rounded-lg bg-panel p-0 text-fg shadow-xl backdrop:bg-black/70 open:flex"
    >
      <header className="flex items-center gap-2 border-b border-border px-4 py-2">
        <p className="min-w-0 flex-1 truncate text-sm font-semibold">{name}</p>
        <a
          href={media.url}
          download={media.name ?? ''}
          className="flex items-center gap-1 rounded px-2 py-1 text-sm hover:bg-surface"
        >
          <DownloadSimple size={16} /> Baixar
        </a>
        <button type="button" onClick={onClose} aria-label="Fechar" title="Fechar" className="rounded p-1 hover:bg-surface">
          <X size={18} />
        </button>
      </header>
      <div className="flex min-h-0 flex-1 items-center justify-center bg-black/80">
        {image ? (
          <img src={media.url} alt={name} className="max-h-full max-w-full object-contain" />
        ) : pdf ? (
          <iframe title={name} src={media.url} className="size-full bg-white" />
        ) : (
          <p className="px-4 text-center text-sm text-white/80">Este tipo de arquivo não tem pré-visualização. Use “Baixar”.</p>
        )}
      </div>
    </dialog>
  );
}
