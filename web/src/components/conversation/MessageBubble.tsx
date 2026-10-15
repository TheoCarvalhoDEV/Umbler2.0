import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowBendUpLeft, Check, Checks, Clock, FileText, ImageBroken, WarningCircle } from '@phosphor-icons/react';
import type { MessageDto } from '@talk/shared';
import { api } from '../../lib/api';
import { applyWsEvent } from '../../lib/ws';
import { errorMessage, previewText, timeOfDay } from './model';

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
      return <Checks size={14} weight="bold" className="text-sky-400" aria-label="Lida" />;
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

export function MessageBubble({ m, onReply }: { m: MessageDto; onReply: (m: MessageDto) => void }) {
  const qc = useQueryClient();
  const [resending, setResending] = useState(false);
  const [resendError, setResendError] = useState<string | null>(null);
  const isNote = m.kind === 'note';
  const right = isNote || m.direction === 'out';
  const showStatus = m.direction === 'out' && !isNote;
  // quoting needs the WhatsApp id, which pending/failed sends do not have yet
  const canReply = !isNote && !(m.direction === 'out' && (m.status === 'pending' || m.status === 'failed'));
  const label = isNote
    ? `Nota interna · ${m.authorName ?? 'Atendente'}`
    : m.direction === 'out'
      ? (m.authorName ?? 'Celular ou sistema') // authorId null = sent from the phone or by the triage bot
      : null;
  const tone = isNote ? 'bg-yellow-200 text-zinc-900' : m.direction === 'out' ? 'bg-primary/25 text-fg' : 'bg-panel text-fg';

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

  const replyButton = canReply && (
    <button
      type="button"
      aria-label="Responder"
      title="Responder"
      onClick={() => onReply(m)}
      className="self-center p-1 text-muted opacity-0 hover:text-fg focus:opacity-100 group-hover:opacity-100"
    >
      <ArrowBendUpLeft size={16} />
    </button>
  );

  return (
    <div className={`group flex px-4 py-1 ${right ? 'justify-end' : 'justify-start'}`}>
      {right && replyButton}
      <div className={`relative max-w-[75%] rounded-lg px-3 py-2 shadow-sm ${tone} ${m.reaction ? 'mb-3' : ''}`}>
        {label && <p className="mb-1 text-xs font-semibold opacity-75">{label}</p>}
        {m.replyTo && (
          <div className="mb-1 line-clamp-3 rounded border-l-4 border-primary bg-black/15 px-2 py-1 text-xs opacity-80">
            {previewText(m.replyTo.body, m.replyTo.kind)}
          </div>
        )}
        <MediaView m={m} />
        {m.kind === 'unsupported' ? (
          <p className="text-sm italic opacity-70">Mensagem não suportada</p>
        ) : (
          m.body && <p className="whitespace-pre-wrap break-words text-sm">{m.body}</p>
        )}
        <div className="mt-1 flex items-center justify-end gap-1 text-[11px] opacity-70">
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
        {m.reaction && (
          <span
            aria-label={`Reação ${m.reaction}`}
            className={`absolute -bottom-3 ${right ? 'left-2' : 'right-2'} rounded-full border border-border bg-surface px-1.5 text-sm shadow-sm`}
          >
            {m.reaction}
          </span>
        )}
      </div>
      {!right && replyButton}
    </div>
  );
}
