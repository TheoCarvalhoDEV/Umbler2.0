import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowBendUpLeft, Lightning, Microphone, Paperclip, PaperPlaneRight, Smiley, Trash, X } from '@phosphor-icons/react';
import type { MessageDto, QuickAnswerDto } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { applyWsEvent } from '../../lib/ws';
import { errorMessage, previewText } from './model';
import { QuickAnswerPicker, filterQuickAnswers } from './QuickAnswerPicker';
import { useAudioRecorder } from './useAudioRecorder';

export const SIGNATURE_KEY = 'talk.composer.signature';

// ponytail: fixed grid of common emojis; add a searchable picker only if the team misses one.
const EMOJIS = [
  '😀', '😂', '😊', '🙂', '😉', '😍', '😢', '😅', '🤔', '😐', '🙏', '👍', '👎', '👏', '🙌', '💪',
  '🤝', '👋', '✅', '❌', '⚠️', '❗', '📌', '📎', '📄', '📅', '⏰', '📞', '💰', '⚖️', '❤️', '🎉',
];

function readSignaturePref(): boolean {
  try {
    return localStorage.getItem(SIGNATURE_KEY) !== '0';
  } catch {
    return true;
  }
}

function writeSignaturePref(on: boolean): void {
  try {
    localStorage.setItem(SIGNATURE_KEY, on ? '1' : '0');
  } catch {
    // storage blocked (private window): the choice lasts until the page reloads
  }
}

async function fetchQuickAnswerFile(qa: QuickAnswerDto): Promise<File> {
  const res = await fetch(api.quickAnswers.attachmentUrl(qa.id), { credentials: 'include' });
  if (!res.ok) throw new Error('Não foi possível baixar o anexo da resposta rápida');
  const disposition = res.headers.get('content-disposition') ?? '';
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  const plain = /filename="([^"]+)"/i.exec(disposition)?.[1];
  const blob = await res.blob();
  return new File([blob], encoded ? decodeURIComponent(encoded) : (plain ?? qa.name), { type: blob.type });
}

const duration = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

function ToolButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="rounded p-1.5 text-muted hover:bg-panel hover:text-fg"
    >
      {children}
    </button>
  );
}

export interface ComposerProps {
  chatId: string;
  replyTo: MessageDto | null;
  onClearReply: () => void;
}

export function Composer({ chatId, replyTo, onClearReply }: ComposerProps) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<'message' | 'note'>('message');
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [signature, setSignature] = useState(readSignaturePref);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [pickerDismissed, setPickerDismissed] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recorder = useAudioRecorder();
  const isNote = mode === 'note';

  // "/" followed by an optional filter (no spaces) opens the quick answer picker
  const slash = /^\/(\S*)$/.exec(text);
  const pickerQuery = slash && !pickerDismissed ? slash[1] : null;
  const answers = useQuery({ queryKey: qk.quickAnswers, queryFn: api.quickAnswers.list, enabled: pickerQuery !== null });
  const matches = pickerQuery === null ? [] : filterQuickAnswers(answers.data ?? [], pickerQuery);

  useEffect(() => {
    setHighlight(0);
  }, [pickerQuery]);

  function changeText(value: string) {
    setText(value);
    setPickerDismissed(false);
  }

  function switchMode(next: 'message' | 'note') {
    setMode(next);
    if (next === 'note') setFile(null); // notes are text only
    textareaRef.current?.focus();
  }

  function toggleSignature(on: boolean) {
    setSignature(on);
    writeSignaturePref(on);
  }

  function insertAtCursor(snippet: string) {
    const el = textareaRef.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    changeText(text.slice(0, start) + snippet + text.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + snippet.length, start + snippet.length);
    });
  }

  async function submit(call: () => Promise<MessageDto>): Promise<boolean> {
    setSending(true);
    setError(null);
    try {
      // same cache path as the WS echo, so the POST response and the event never duplicate
      applyWsEvent(qc, { type: 'message.created', message: await call() });
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setSending(false);
    }
  }

  async function send() {
    const value = text.trim();
    if (sending || (!value && !file)) return;
    const replyToId = isNote ? undefined : replyTo?.id;
    const ok = await submit(() =>
      isNote
        ? api.chats.addNote(chatId, value)
        : file
          ? api.chats.sendFile(chatId, { file, text: value || undefined, signature, replyToId })
          : api.chats.sendText(chatId, { text: value, signature, replyToId }),
    );
    if (!ok) return;
    setText('');
    setFile(null);
    if (!isNote) onClearReply();
  }

  async function toggleRecording() {
    if (!recorder.recording) {
      try {
        await recorder.start();
      } catch {
        setError('Não foi possível acessar o microfone');
      }
      return;
    }
    const audio = await recorder.stop();
    if (!audio) return;
    const ok = await submit(() =>
      api.chats.sendFile(chatId, { file: audio, signature: false, asVoice: true, replyToId: replyTo?.id }),
    );
    if (ok) onClearReply();
  }

  async function pickAnswer(qa: QuickAnswerDto) {
    setError(null);
    try {
      const { text: rendered } = await api.quickAnswers.render(qa.id, chatId);
      changeText(rendered); // §5.7: goes to the box for editing, never sent automatically
      if (qa.hasAttachment && !isNote) setFile(await fetchQuickAnswerFile(qa));
      textareaRef.current?.focus();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (pickerQuery !== null) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setPickerDismissed(true);
        return;
      }
      if (matches.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setHighlight((h) => (h + 1) % matches.length);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setHighlight((h) => (h - 1 + matches.length) % matches.length);
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          void pickAnswer(matches[Math.min(highlight, matches.length - 1)]);
          return;
        }
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    const dropped = e.dataTransfer.files[0];
    if (dropped && !isNote) setFile(dropped);
  }

  const canSend = text.trim() !== '' || file !== null;

  return (
    <div
      className="border-t border-border bg-surface px-3 py-2"
      onDragOver={(e) => {
        if (!isNote) e.preventDefault(); // allows the drop
      }}
      onDrop={onDrop}
    >
      <div className="mb-2 flex gap-1 text-sm">
        {(['message', 'note'] as const).map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={mode === m}
            onClick={() => switchMode(m)}
            className={`rounded px-3 py-1 ${
              mode === m ? (m === 'note' ? 'bg-yellow-200 text-zinc-900' : 'bg-primary text-white') : 'text-muted hover:bg-panel'
            }`}
          >
            {m === 'message' ? 'Mensagem' : 'Notas'}
          </button>
        ))}
      </div>

      {replyTo && !isNote && (
        <div className="mb-2 flex items-center gap-2 rounded border-l-4 border-primary bg-panel px-2 py-1 text-sm text-fg">
          <ArrowBendUpLeft size={16} className="shrink-0 text-muted" />
          <span className="min-w-0 flex-1 truncate">Respondendo: {previewText(replyTo.body, replyTo.kind)}</span>
          <button type="button" aria-label="Cancelar resposta" onClick={onClearReply} className="text-muted hover:text-fg">
            <X size={16} />
          </button>
        </div>
      )}

      {file && (
        <div className="mb-2 flex items-center gap-2 rounded bg-panel px-2 py-1 text-sm text-fg">
          <Paperclip size={16} className="shrink-0 text-muted" />
          <span className="min-w-0 flex-1 truncate">{file.name}</span>
          <button type="button" aria-label="Remover arquivo" onClick={() => setFile(null)} className="text-muted hover:text-fg">
            <X size={16} />
          </button>
        </div>
      )}

      {error && (
        <p role="alert" className="mb-1 text-sm text-danger">
          {error}
        </p>
      )}

      {recorder.recording ? (
        <div className="flex items-center gap-3 py-2 text-fg">
          <span className="size-2 animate-pulse rounded-full bg-danger" />
          <span className="flex-1 text-sm tabular-nums">Gravando {duration(recorder.seconds)}</span>
          <ToolButton label="Descartar áudio" onClick={recorder.discard}>
            <Trash size={20} />
          </ToolButton>
          <button
            type="button"
            disabled={sending}
            onClick={() => void toggleRecording()}
            className="flex items-center gap-1 rounded bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50"
          >
            Enviar áudio <PaperPlaneRight size={16} />
          </button>
        </div>
      ) : (
        <>
          <div className="relative">
            {pickerQuery !== null && <QuickAnswerPicker answers={matches} highlight={highlight} onPick={(a) => void pickAnswer(a)} />}
            <textarea
              ref={textareaRef}
              aria-label={isNote ? 'Nota interna' : 'Mensagem'}
              value={text}
              onChange={(e) => changeText(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={
                isNote
                  ? 'Digite sua nota interna, visível só para a equipe…'
                  : 'Digite sua mensagem ou arraste um arquivo… ("/" para respostas rápidas)'
              }
              className={`field-sizing-content block max-h-48 min-h-10 w-full resize-none rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 ${
                isNote
                  ? 'border-yellow-300 bg-yellow-100 text-zinc-900 placeholder:text-zinc-500 focus:ring-yellow-300'
                  : 'border-border bg-panel text-fg placeholder:text-muted focus:ring-primary'
              }`}
            />
          </div>

          <div className="mt-1 flex items-center gap-1">
            {!isNote && (
              <>
                <ToolButton label="Arquivo" onClick={() => fileInputRef.current?.click()}>
                  <Paperclip size={20} />
                </ToolButton>
                <input
                  ref={fileInputRef}
                  type="file"
                  hidden
                  onChange={(e) => {
                    setFile(e.target.files?.[0] ?? null);
                    e.target.value = ''; // picking the same file again still fires onChange
                  }}
                />
              </>
            )}
            <ToolButton
              label="Respostas rápidas"
              onClick={() => {
                changeText('/');
                textareaRef.current?.focus();
              }}
            >
              <Lightning size={20} />
            </ToolButton>
            <div className="relative">
              <ToolButton label="Emoji" onClick={() => setEmojiOpen((o) => !o)}>
                <Smiley size={20} />
              </ToolButton>
              {emojiOpen && (
                <div className="absolute bottom-full left-0 z-10 mb-1 grid w-72 grid-cols-8 gap-1 rounded-md border border-border bg-panel p-2 shadow-lg">
                  {EMOJIS.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      aria-label={emoji}
                      className="rounded text-lg hover:bg-surface"
                      onClick={() => {
                        insertAtCursor(emoji);
                        setEmojiOpen(false);
                      }}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {!isNote && (
              <label className="ml-2 flex items-center gap-1 text-xs text-muted">
                <input type="checkbox" checked={signature} onChange={(e) => toggleSignature(e.target.checked)} />
                Assinatura
              </label>
            )}
            <div className="ml-auto">
              {!isNote && !canSend ? (
                <ToolButton label="Gravar áudio" onClick={() => void toggleRecording()}>
                  <Microphone size={20} />
                </ToolButton>
              ) : (
                <button
                  type="button"
                  onClick={() => void send()}
                  disabled={sending || !canSend}
                  className="flex items-center gap-1 rounded bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50"
                >
                  {isNote ? 'Salvar nota' : 'Enviar'} <PaperPlaneRight size={16} />
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
