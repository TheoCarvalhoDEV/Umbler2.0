import { useState, type KeyboardEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Checks, Clock, FileText, ImageBroken, Robot, ShareFat, WarningCircle } from '@phosphor-icons/react';
import type { Me, MessageDto } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { confirmDialog } from '../../lib/confirm';
import { Avatar } from '../Avatar';
import { applyWsEvent } from '../../lib/ws';
import { EditHistoryDialog, ForwardDialog } from './MessageDialogs';
import { MessageMenu, menuItems, type MenuAction } from './MessageMenu';
import { deletedTag, editedTag, errorMessage, previewText, timeOfDay } from './model';

const chip = 'rounded-full border border-border bg-surface px-1.5 text-sm shadow-sm';

const MEDIA_KINDS = new Set(['image', 'audio', 'video', 'document', 'sticker']);

function formatSize(bytes: number | null): string {
  if (bytes == null) return '';
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function StatusTick({ status }: { status: MessageDto['status'] }) {
  switch (status) {
    case 'pending':
      return <Clock size={14} aria-label="Enviando" />;
    case 'sent':
      return <Check size={14} aria-label="Enviada" />;
    case 'delivered':
      return <Checks size={14} aria-label="Entregue" />;
    case 'read':
      return <Checks size={14} weight="bold" className="text-read" aria-label="Lida" />;
    case 'failed':
      return <WarningCircle size={14} weight="fill" className="text-danger" aria-label="Falhou" />;
  }
}

function MediaView({ m }: { m: MessageDto }) {
  if (m.mediaUnavailable) {
    return (
      <p className="flex items-center gap-1 text-sm italic text-muted">
        <ImageBroken size={16} /> mídia indisponível
      </p>
    );
  }
  // inbound media is downloaded after the message is stored (§5.1 step 6); message.updated fills it in
  if (!m.media) return MEDIA_KINDS.has(m.kind) ? <p className="text-sm italic text-muted">Carregando mídia…</p> : null;
  const { url, name, size } = m.media;
  switch (m.kind) {
    case 'image':
    case 'sticker':
      return (
        <a href={url} target="_blank" rel="noopener noreferrer">
          <img
            src={url}
            alt={name ?? 'Imagem'}
            loading="lazy"
            className={m.kind === 'sticker' ? 'size-32 object-contain' : 'max-h-72 max-w-full rounded'}
          />
        </a>
      );
    case 'audio':
      return <audio controls preload="none" src={url} className="max-w-full" />;
    case 'video':
      return <video controls preload="metadata" src={url} className="max-h-72 max-w-full rounded" />;
    default:
      return (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 rounded bg-black/20 px-2 py-1.5 text-sm hover:bg-black/30"
        >
          <FileText size={24} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">{name ?? 'Documento'}</span>
          <span className="text-xs opacity-70">{formatSize(size)}</span>
        </a>
      );
  }
}

export interface MessageBubbleProps {
  m: MessageDto;
  onReply: (m: MessageDto) => void;
  /** Spec §2: no action in a closed chat (only Copiar). */
  chatOpen?: boolean;
}

export function MessageBubble({ m, onReply, chatOpen = false }: MessageBubbleProps) {
  const qc = useQueryClient();
  const [resending, setResending] = useState(false);
  const [resendError, setResendError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [forwarding, setForwarding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const isNote = m.kind === 'note';
  const right = isNote || m.direction === 'out';
  const showStatus = m.direction === 'out' && !isNote;
  // a chatbot run sends as the system (authorId null) and the server fills botName
  const botName = !isNote && m.direction === 'out' ? (m.botName ?? null) : null;
  const label = isNote
    ? `Nota interna · ${m.authorName ?? 'Atendente'}`
    : botName
      ? `Chatbot ${botName}`
      : m.direction === 'out'
        ? (m.authorName ?? 'Celular ou sistema') // authorId null = sent from the phone or by the triage
        : null;
  const tone = isNote ? 'bg-yellow-200 text-zinc-900' : m.direction === 'out' ? 'bg-primary/25 text-fg' : 'bg-bubble-in text-fg';
  // me is loaded before any chat renders (RequireAuth); read it without subscribing
  const meId = qc.getQueryData<Me | null>(qk.me)?.id ?? null;
  const items = menuItems(m, meId, chatOpen, Date.now());

  async function resend() {
    setResending(true);
    setResendError(null);
    try {
      applyWsEvent(qc, { type: 'message.updated', message: await api.messages.resend(m.id) });
    } catch (e) {
      setResendError(errorMessage(e));
    } finally {
      setResending(false);
    }
  }

  /** Runs one action; its answer goes through the same cache path as the WS echo. */
  async function act(call: () => Promise<MessageDto>): Promise<boolean> {
    setBusy(true);
    setActionError(null);
    try {
      applyWsEvent(qc, { type: 'message.updated', message: await call() });
      return true;
    } catch (e) {
      setActionError(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(m.body ?? '');
    } catch {
      setActionError('Não foi possível copiar');
    }
  }

  async function remove() {
    const ok = await confirmDialog({
      title: 'Apagar para todos?',
      body: 'O contato deixa de ver esta mensagem.',
      confirmLabel: 'Apagar para todos',
    });
    if (ok) await act(() => api.messages.remove(m.id));
  }

  function onAction(action: Exclude<MenuAction, 'react'>) {
    if (action === 'reply') onReply(m);
    else if (action === 'forward') setForwarding(true);
    else if (action === 'copy') void copy();
    else if (action === 'edit') {
      setDraft(m.body ?? '');
      setActionError(null);
      setEditing(true);
    } else void remove();
  }

  async function saveEdit() {
    const text = draft.trim();
    if (!text || busy) return;
    if (await act(() => api.messages.edit(m.id, text))) setEditing(false);
  }

  function onEditKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      setEditing(false);
      setActionError(null);
    } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void saveEdit();
    }
  }

  const menu = (
    <MessageMenu
      items={items}
      officeReaction={m.officeReaction ?? null}
      alignRight={right}
      open={menuOpen}
      onOpenChange={setMenuOpen}
      onAction={onAction}
      onReact={(emoji) => void act(() => api.messages.react(m.id, emoji))}
    />
  );

  return (
    <div className={`group flex px-4 py-1 ${right ? 'justify-end' : 'justify-start'}`}>
      {right && menu}
      <div
        onContextMenu={(e) => {
          // a long press on touch screens fires contextmenu: open the same menu (spec §9 "toque longo")
          if (items.length === 0 || editing) return;
          e.preventDefault();
          setMenuOpen(true);
        }}
        className={`relative max-w-[75%] rounded-lg px-3 py-2 shadow-sm ${tone} ${m.reaction || m.officeReaction ? 'mb-3' : ''}`}
      >
        {label && (
          <p className="mb-1 flex items-center gap-1 text-xs font-semibold opacity-75">
            {botName && <Robot size={14} weight="fill" aria-hidden data-bot-icon className="shrink-0" />}
            {label}
          </p>
        )}
        {m.forwarded && (
          <p data-tag="forwarded" className="mb-1 flex items-center gap-1 text-xs italic opacity-70">
            <ShareFat size={12} aria-hidden /> Encaminhada
          </p>
        )}
        {m.replyTo && (
          <div className="mb-1 line-clamp-3 rounded border-l-4 border-primary bg-black/15 px-2 py-1 text-xs opacity-80">
            {previewText(m.replyTo.body, m.replyTo.kind)}
          </div>
        )}
        <MediaView m={m} />
        {editing ? (
          <div>
            <textarea
              aria-label="Editar mensagem"
              autoFocus
              value={draft}
              disabled={busy}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onEditKey}
              className="field-sizing-content block max-h-48 min-h-10 w-72 max-w-full resize-none rounded border border-field bg-panel px-2 py-1 text-sm text-fg outline-none focus:ring-2 focus:ring-primary"
            />
            <p className="mt-1 text-xs opacity-70">Enter salva · Esc cancela</p>
          </div>
        ) : m.kind === 'unsupported' ? (
          <p className="text-sm italic opacity-70">Mensagem não suportada</p>
        ) : (
          m.body && <p className="whitespace-pre-wrap break-words text-sm">{m.body}</p>
        )}
        <div className="mt-1 flex flex-wrap items-center justify-end gap-x-2 gap-y-0.5 text-xs opacity-70">
          {m.deleted && (
            <span data-tag="deleted" className="font-medium text-danger">
              {deletedTag(m.deleted)}
            </span>
          )}
          {m.edited && (
            <button
              type="button"
              data-tag="edited"
              title="Ver versões anteriores"
              onClick={() => setHistoryOpen(true)}
              className="hover:underline"
            >
              {editedTag(m.edited)}
            </button>
          )}
          <time dateTime={m.sentAt}>{timeOfDay(m.sentAt)}</time>
          {showStatus && <StatusTick status={m.status} />}
        </div>
        {showStatus && m.status === 'failed' && (
          <div className="mt-1 flex items-center gap-2 text-xs text-danger">
            <span className="flex-1">{resendError ?? m.error ?? 'Falha no envio'}</span>
            <button type="button" onClick={() => void resend()} disabled={resending} className="font-semibold underline">
              Reenviar
            </button>
          </div>
        )}
        {actionError && (
          <p role="alert" className="mt-1 text-xs text-danger">
            {actionError}
          </p>
        )}
        {(m.reaction || m.officeReaction) && (
          <span className={`absolute -bottom-3 ${right ? 'left-2' : 'right-2'} flex gap-0.5`}>
            {m.reaction && (
              <span aria-label={`Reação do contato ${m.reaction}`} className={chip}>
                {m.reaction}
              </span>
            )}
            {m.officeReaction && (
              <span aria-label={`Reação do escritório ${m.officeReaction}`} className={chip}>
                {m.officeReaction}
              </span>
            )}
          </span>
        )}
      </div>
      {m.authorId && (
        // sent by an agent (notes included); phone/triage sends have no author
        <span data-author-avatar className="ml-2 self-end">
          <Avatar name={m.authorName} src={m.authorAvatarUrl} className="size-7 text-xs bg-primary text-white" />
        </span>
      )}
      {!right && menu}
      {historyOpen && <EditHistoryDialog messageId={m.id} onClose={() => setHistoryOpen(false)} />}
      {forwarding && <ForwardDialog message={m} onClose={() => setForwarding(false)} />}
    </div>
  );
}
