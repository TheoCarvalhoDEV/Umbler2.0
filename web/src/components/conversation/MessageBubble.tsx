import { useState, type KeyboardEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  CalendarCheck, Check, Checks, Clock, DownloadSimple, FileText, ImageBroken, PencilSimpleLine, Robot, ShareFat, Star, WarningCircle,
} from '@phosphor-icons/react';
import type { Me, MessageDto } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { confirmDialog } from '../../lib/confirm';
import { Avatar } from '../Avatar';
import { button, fieldArea } from '../ui';
import { applyWsEvent } from '../../lib/ws';
import { EditHistoryDialog, ForwardDialog, MediaViewer } from './MessageDialogs';
import { MessageMenu, menuItems, type MenuAction } from './MessageMenu';
import { deletedTag, editedTag, errorMessage, previewText, timeOfDay } from './model';

const chip = 'rounded-full bg-surface px-1.5 text-sm leading-6 shadow-float';

const MEDIA_KINDS = new Set(['image', 'audio', 'video', 'document', 'sticker']);
// download button over a photo or video: shows on hover, like WhatsApp Web
const overlay =
  'absolute right-2 top-2 grid size-8 place-items-center rounded-full bg-surface/85 text-fg shadow-float opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100';
const saveButton = 'grid size-8 place-items-center rounded-full text-fg-2 hover:text-fg';
// media above a caption: 8px between them, as in the board's attachment bubble
const beforeCaption = '[&+p]:mt-2';
/** A block inside a bubble (reply quote, document): lighter than a sent bubble, a quiet fill on a received one. */
const insetOf = (m: MessageDto) => (m.direction === 'out' ? 'bg-surface/50' : 'bg-panel');

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

/** §5.5: one download try; the answer replaces the message in the timeline cache. */
function DownloadButton({ m }: { m: MessageDto }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    setBusy(true);
    setError(null);
    try {
      applyWsEvent(qc, { type: 'message.updated', message: await api.messages.downloadMedia(m.id) });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" onClick={() => void download()} disabled={busy} className="font-semibold not-italic underline disabled:opacity-50">
        Baixar
      </button>
      {error && (
        <span role="alert" className="not-italic text-danger">
          {error}
        </span>
      )}
    </>
  );
}

/** Saves the stored file with its original name (same origin, so the download attribute wins over inline). */
function saveFile(url: string, name: string | null) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name ?? '';
  a.click();
}

function SaveLink({ url, name, className = '' }: { url: string; name: string | null; className?: string }) {
  return (
    <a href={url} download={name ?? ''} aria-label="Baixar arquivo" title="Baixar arquivo" className={`shrink-0 ${className}`}>
      <DownloadSimple size={18} />
    </a>
  );
}

function MediaView({ m }: { m: MessageDto }) {
  const [viewing, setViewing] = useState(false);
  if (m.mediaExpired) {
    return (
      <p className="flex items-center gap-1.5 text-sm italic">
        <ImageBroken size={16} /> Arquivo não está mais disponível no WhatsApp
      </p>
    );
  }
  if (m.mediaUnavailable) {
    return (
      <p className="flex flex-wrap items-center gap-2 text-sm italic">
        <ImageBroken size={16} /> mídia indisponível <DownloadButton m={m} />
      </p>
    );
  }
  // inbound media is downloaded after the message is stored (§5.1 step 6); message.updated fills it in
  if (!m.media) return MEDIA_KINDS.has(m.kind) ? <p className="text-sm italic">Carregando mídia…</p> : null;
  const { url, name, size } = m.media;
  const viewer = viewing && <MediaViewer media={m.media} kind={m.kind} onClose={() => setViewing(false)} />;
  switch (m.kind) {
    case 'image':
    case 'sticker':
      return (
        <div className={`relative ${beforeCaption}`}>
          <button type="button" onClick={() => setViewing(true)} aria-label="Abrir imagem" className="block cursor-zoom-in">
            <img
              src={url}
              alt={name ?? 'Imagem'}
              loading="lazy"
              className={m.kind === 'sticker' ? 'size-32 object-contain' : 'max-h-72 max-w-full rounded-block'}
            />
          </button>
          <SaveLink url={url} name={name} className={overlay} />
          {viewer}
        </div>
      );
    case 'audio':
      return (
        <div className={`flex items-center gap-1 ${beforeCaption}`}>
          <audio controls preload="none" src={url} className="max-w-full" />
          <SaveLink url={url} name={name} className={saveButton} />
        </div>
      );
    case 'video':
      return (
        <div className={`relative ${beforeCaption}`}>
          <video controls preload="metadata" src={url} className="max-h-72 max-w-full rounded-block" />
          <SaveLink url={url} name={name} className={overlay} />
        </div>
      );
    default:
      return (
        <div className={`flex items-center gap-1 rounded-block p-2.5 ${insetOf(m)} ${beforeCaption}`}>
          <button
            type="button"
            onClick={() => setViewing(true)}
            className="flex min-w-0 flex-1 items-center gap-2.5 text-left hover:underline"
          >
            <span className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-primary-soft text-accent-ink">
              <FileText size={18} />
            </span>
            <span className="min-w-0 flex-1 truncate text-[13px] leading-[18px] font-bold">{name ?? 'Documento'}</span>
            <span className="text-xs text-muted tabular-nums">{formatSize(size)}</span>
          </button>
          <SaveLink url={url} name={name} className={saveButton} />
          {viewer}
        </div>
      );
  }
}

export interface MessageBubbleProps {
  m: MessageDto;
  onReply: (m: MessageDto) => void;
  /** Spec §2: no action in a closed chat (only Copiar). */
  chatOpen?: boolean;
  /** Spec 2026-10-19 §4: the search hit or favorite the timeline just jumped to. */
  highlighted?: boolean;
}

export function MessageBubble({ m, onReply, chatOpen = false, highlighted = false }: MessageBubbleProps) {
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
  // the note is a centered card; bubbles have the tail corner (6px) on the speaker's side
  const tone = isNote
    ? 'w-full max-w-[540px] rounded-2xl bg-note px-4 py-3 text-note-fg'
    : m.direction === 'out'
      ? 'max-w-[64%] rounded-card rounded-br-md bg-bubble-out px-3.5 py-2.5 text-fg'
      : 'max-w-[64%] rounded-card rounded-bl-md bg-bubble-in px-3.5 py-2.5 text-fg shadow-bubble';
  // time, ticks and tags: each fill has its own readable meta color
  const meta = isNote ? 'text-note-label' : m.direction === 'out' ? 'text-bubble-meta' : 'text-muted';
  // me is loaded before any chat renders (RequireAuth); read it without subscribing
  const me = qc.getQueryData<Me | null>(qk.me);
  const items = menuItems(m, me?.id ?? null, chatOpen, Date.now(), me?.role === 'admin');

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
  async function act(call: () => Promise<MessageDto | void>): Promise<boolean> {
    setBusy(true);
    setActionError(null);
    try {
      const message = await call();
      if (message) applyWsEvent(qc, { type: 'message.updated', message });
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

  /** Spec 2026-10-19 §3: the row goes away, so reload the timeline (chat.updated does the same on the other screens). */
  async function removeNote() {
    const ok = await confirmDialog({ title: 'Apagar nota?', body: 'A nota sai da conversa para todos.', confirmLabel: 'Apagar nota' });
    if (ok && (await act(() => api.notes.remove(m.id)))) void qc.invalidateQueries({ queryKey: qk.timeline(m.chatId) });
  }

  function onAction(action: Exclude<MenuAction, 'react'>) {
    switch (action) {
      case 'reply':
        return onReply(m);
      case 'forward':
        return setForwarding(true);
      case 'copy':
        return void copy();
      case 'download':
        if (m.media) saveFile(m.media.url, m.media.name);
        return;
      case 'favorite':
        return void act(() => api.messages.favorite(m.id, !m.favorite));
      case 'edit':
        setDraft(m.body ?? '');
        setActionError(null);
        setEditing(true);
        return;
      case 'delete':
        return void remove();
      case 'deleteNote':
        return void removeNote();
    }
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
      // a centered note can fill the row: open its menu rightward, over the note, so it is never clipped
      alignRight={right && !isNote}
      open={menuOpen}
      onOpenChange={setMenuOpen}
      onAction={onAction}
      onReact={(emoji) => void act(() => api.messages.react(m.id, emoji))}
    />
  );

  return (
    <div
      data-message-id={m.id}
      data-highlighted={highlighted || undefined}
      className={`group flex px-4 py-[5px] ${isNote ? 'justify-center' : right ? 'justify-end' : 'justify-start'}`}
    >
      {right && menu}
      <div
        onContextMenu={(e) => {
          // a long press on touch screens fires contextmenu: open the same menu (spec §9 "toque longo")
          if (items.length === 0 || editing) return;
          e.preventDefault();
          setMenuOpen(true);
        }}
        className={`relative ${tone} ${m.reaction || m.officeReaction ? 'mb-3' : ''} ${highlighted ? 'ring-2 ring-brass' : ''}`}
      >
        {label && (
          <p className={`flex items-center gap-1.5 text-xs font-bold ${isNote ? 'mb-1 text-note-label' : 'mb-0.5 text-accent-ink'}`}>
            {isNote && <PencilSimpleLine size={14} aria-hidden className="shrink-0" />}
            {botName && <Robot size={14} weight="fill" aria-hidden data-bot-icon className="shrink-0" />}
            {label}
          </p>
        )}
        {m.forwarded && (
          <p data-tag="forwarded" className={`mb-1 flex items-center gap-1 text-xs italic ${meta}`}>
            <ShareFat size={12} aria-hidden /> Encaminhada
          </p>
        )}
        {m.scheduled && (
          <p data-tag="scheduled" className={`mb-1 flex items-center gap-1 text-xs italic ${meta}`}>
            <CalendarCheck size={12} aria-hidden /> Agendada
          </p>
        )}
        {m.replyTo && (
          <div className={`mb-1.5 line-clamp-3 rounded-[10px] border-l-[3px] border-primary px-2.5 py-1.5 text-[13px] ${insetOf(m)}`}>
            {previewText(m.replyTo.body, m.replyTo.kind)}
          </div>
        )}
        <MediaView m={m} />
        {editing ? (
          <div className="w-72 max-w-full">
            <textarea
              aria-label="Editar mensagem"
              autoFocus
              value={draft}
              disabled={busy}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onEditKey}
              className={`${fieldArea} field-sizing-content max-h-48 min-h-10 resize-none outline-none focus:ring-2 focus:ring-primary`}
            />
            <p className={`mt-1 text-xs ${meta}`}>Enter salva · Esc cancela</p>
          </div>
        ) : m.kind === 'unsupported' ? (
          <p className={`text-sm italic ${meta}`}>Mensagem não suportada</p>
        ) : (
          m.body && <p className="whitespace-pre-wrap break-words text-sm">{m.body}</p>
        )}
        <div className={`mt-1 flex flex-wrap items-center justify-end gap-x-2 gap-y-0.5 text-[11px] leading-[14px] tabular-nums ${meta}`}>
          {m.deleted && (
            <span data-tag="deleted" className="rounded-full bg-danger-soft px-1.5 font-semibold text-danger">
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
          {m.favorite && (
            <span data-tag="favorite" title={`Favoritada por ${m.favorite.byName ?? 'atendente'}`} className="text-brass">
              <Star size={12} weight="fill" aria-label="Favorita" />
            </span>
          )}
          <time dateTime={m.sentAt}>{timeOfDay(m.sentAt)}</time>
          {showStatus && <StatusTick status={m.status} />}
        </div>
        {showStatus && m.status === 'failed' && (
          <div className="mt-2 flex flex-wrap items-center gap-2 rounded-block bg-danger-soft py-1 pr-1 pl-2.5 text-xs font-semibold text-danger">
            <span className="flex-1">{resendError ?? m.error ?? 'Falha no envio'}</span>
            <button type="button" onClick={() => void resend()} disabled={resending} className={button('secondary', 'sm')}>
              Reenviar
            </button>
          </div>
        )}
        {actionError && (
          <p role="alert" className="mt-1.5 rounded-block bg-danger-soft px-2.5 py-1.5 text-xs font-semibold text-danger">
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
          <Avatar name={m.authorName} src={m.authorAvatarUrl} className="size-7 text-xs" />
        </span>
      )}
      {!right && menu}
      {historyOpen && <EditHistoryDialog messageId={m.id} onClose={() => setHistoryOpen(false)} />}
      {forwarding && <ForwardDialog message={m} onClose={() => setForwarding(false)} />}
    </div>
  );
}
