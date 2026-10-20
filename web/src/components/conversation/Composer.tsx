import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowBendUpLeft, Lightning, Microphone, Paperclip, PaperPlaneRight, Robot, Smiley, Sticker, Trash, X } from '@phosphor-icons/react';
import type { BotAction, BotRunningErrorBody, MessageDto, QuickAnswerDto } from '@talk/shared';
import { api, botRunningRuns, qk } from '../../lib/api';
import { preferencesOf } from '../../lib/auth';
import { applyWsEvent } from '../../lib/ws';
import { button, checkbox, iconButtonGhost, menu, tab } from '../ui';
import { BotPanel } from './BotPanel';
import { BotRunningDialog } from './ChatDialogs';
import { errorMessage, isSendKey, previewText } from './model';
import { QuickAnswerPicker, filterQuickAnswers } from './QuickAnswerPicker';
import { StickerPanel } from './StickerPanel';
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

// The one primary action of the composer: send, save the note or start recording.
const roundPrimary =
  'grid size-11 shrink-0 place-items-center rounded-full bg-primary text-on-primary transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50';
// "Nota interna" tab while note mode is on: the note colors instead of the neutral "on" chip
const noteTabOn = 'inline-flex h-8 items-center gap-1.5 rounded-full bg-note-label px-3.5 text-[13px] font-semibold text-note';

function ToolButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className={iconButtonGhost}>
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
  const [botOpen, setBotOpen] = useState(false);
  const [stickerOpen, setStickerOpen] = useState(false);
  const [pickerDismissed, setPickerDismissed] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 409 BOT_RUNNING (spec §5.5 "ask"): submit() waits on this dialog, then resends with the choice
  const [botAsk, setBotAsk] = useState<{ runs: BotRunningErrorBody['runs']; resolve: (a: BotAction | null) => void } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recorder = useAudioRecorder();
  const isNote = mode === 'note';
  // read after an await: a reply chip picked while a send was in flight must survive it
  const replyRef = useRef(replyTo);
  replyRef.current = replyTo;

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

  async function submit(call: (botAction?: BotAction) => Promise<MessageDto>): Promise<boolean> {
    setSending(true);
    setError(null);
    try {
      let message: MessageDto;
      try {
        message = await call();
      } catch (e) {
        const runs = botRunningRuns(e);
        if (!runs) throw e;
        const choice = await new Promise<BotAction | null>((resolve) => setBotAsk({ runs, resolve }));
        if (!choice) return false; // Cancelar: the caller puts the text back
        message = await call(choice);
      }
      // same cache path as the WS echo, so the POST response and the event never duplicate
      applyWsEvent(qc, { type: 'message.created', message });
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
    const sentText = text, sentFile = file, sentReply = replyTo;
    // Clear now: the POST waits for Evolution (seconds), and the attendant keeps typing meanwhile.
    setText('');
    setFile(null);
    const ok = await submit((botAction) =>
      isNote
        ? api.chats.addNote(chatId, value) // notes never affect the bot (spec §5.5)
        : sentFile
          ? api.chats.sendFile(chatId, { file: sentFile, text: value || undefined, signature, replyToId, botAction })
          : api.chats.sendText(chatId, { text: value, signature, replyToId, botAction }),
    );
    if (!ok) {
      // put it back only where the attendant has not started something new
      setText((cur) => (cur === '' ? sentText : cur));
      setFile((cur) => cur ?? sentFile);
      return;
    }
    if (!isNote && replyRef.current === sentReply) onClearReply();
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
    const sentReply = replyTo;
    const ok = await submit((botAction) =>
      api.chats.sendFile(chatId, { file: audio, signature: false, asVoice: true, replyToId: sentReply?.id, botAction }),
    );
    if (ok && replyRef.current === sentReply) onClearReply();
  }

  /** Spec §6: a recent sticker (by message id) or a picked image sent as a sticker; same BOT_RUNNING flow as any send. */
  async function sendSticker(pick: { messageId: string } | { file: File }) {
    const sentReply = replyTo;
    const ok = await submit((botAction) =>
      'messageId' in pick
        ? api.chats.sendSticker(chatId, { stickerFromMessageId: pick.messageId, replyToId: sentReply?.id, botAction })
        : api.chats.sendFile(chatId, { file: pick.file, signature: false, asSticker: true, replyToId: sentReply?.id, botAction }),
    );
    if (ok && replyRef.current === sentReply) onClearReply();
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
    // read at the key press: the composer stays mounted while the preference changes on another page
    if (isSendKey(e, preferencesOf(qc).enterSends)) {
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
    <div className="bg-sunken px-4 pt-3 pb-4">
      <div
        className={`rounded-[26px] p-1.5 shadow-float ${isNote ? 'bg-note text-note-fg' : 'bg-surface text-fg'}`}
        onDragOver={(e) => {
          if (!isNote) e.preventDefault(); // allows the drop
        }}
        onDrop={onDrop}
      >
        <div className="flex flex-wrap gap-1.5 px-1.5 pt-1.5 pb-1">
          {(['message', 'note'] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => switchMode(m)}
              className={mode === m && m === 'note' ? noteTabOn : tab(mode === m)}
            >
              {m === 'message' ? 'Mensagem' : 'Nota interna'}
            </button>
          ))}
        </div>

        {replyTo && !isNote && (
          <div className="mx-1.5 mt-1.5 flex items-center gap-2 rounded-block bg-primary-soft py-1 pr-1 pl-3 text-[13px] text-accent-ink">
            <ArrowBendUpLeft size={16} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">Respondendo: {previewText(replyTo.body, replyTo.kind)}</span>
            <button
              type="button"
              aria-label="Cancelar resposta"
              onClick={onClearReply}
              className="grid size-8 shrink-0 place-items-center rounded-full transition-colors hover:bg-surface"
            >
              <X size={16} />
            </button>
          </div>
        )}

        {file && (
          <div className="mx-1.5 mt-1.5 flex items-center gap-2 rounded-block bg-panel py-1 pr-1 pl-3 text-[13px] text-fg">
            <Paperclip size={16} className="shrink-0 text-fg-2" />
            <span className="min-w-0 flex-1 truncate font-semibold">{file.name}</span>
            <button
              type="button"
              aria-label="Remover arquivo"
              onClick={() => setFile(null)}
              className="grid size-8 shrink-0 place-items-center rounded-full text-fg-2 transition-colors hover:bg-border"
            >
              <X size={16} />
            </button>
          </div>
        )}

        {error && (
          <p role="alert" className="mx-3 mt-1.5 text-[13px] font-semibold text-danger">
            {error}
          </p>
        )}

        {recorder.recording ? (
          <div className="flex items-center gap-2 pt-1 pl-3">
            <span className="size-2.5 shrink-0 animate-pulse rounded-full bg-danger" />
            <span className="flex-1 text-sm font-semibold tabular-nums">Gravando {duration(recorder.seconds)}</span>
            <ToolButton label="Descartar áudio" onClick={recorder.discard}>
              <Trash size={20} />
            </ToolButton>
            <button type="button" disabled={sending} onClick={() => void toggleRecording()} className={button('primary')}>
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
                className={`field-sizing-content block max-h-48 min-h-12 w-full resize-none bg-transparent px-3 py-2.5 text-sm outline-none ${
                  isNote ? 'text-note-fg placeholder:text-note-fg/70' : 'text-fg placeholder:text-muted'
                }`}
              />
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
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
                  <div className={`${menu} absolute bottom-full left-0 z-10 mb-2 grid w-72 grid-cols-8 gap-1`}>
                    {EMOJIS.map((emoji) => (
                      <button
                        key={emoji}
                        type="button"
                        aria-label={emoji}
                        className="grid aspect-square place-items-center rounded-full text-lg transition-colors hover:bg-sidebar-hover"
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
                <div className="relative">
                  <ToolButton label="Figurinhas" onClick={() => setStickerOpen((o) => !o)}>
                    <Sticker size={20} />
                  </ToolButton>
                  {stickerOpen && (
                    <StickerPanel
                      onPick={(messageId) => void sendSticker({ messageId })}
                      onPickFile={(file) => void sendSticker({ file })}
                      onClose={() => setStickerOpen(false)}
                    />
                  )}
                </div>
              )}
              <div className="relative">
                <ToolButton label="Chatbot" onClick={() => setBotOpen((o) => !o)}>
                  <Robot size={20} />
                </ToolButton>
                {botOpen && <BotPanel chatId={chatId} onClose={() => setBotOpen(false)} />}
              </div>
              {!isNote && (
                <label className="ml-1 flex h-10 cursor-pointer items-center gap-2 rounded-full px-3 text-xs font-semibold text-fg-2 transition-colors hover:bg-panel">
                  <input
                    type="checkbox"
                    checked={signature}
                    onChange={(e) => toggleSignature(e.target.checked)}
                    className={checkbox}
                  />
                  Assinatura
                </label>
              )}
              <div className="ml-auto">
                {!isNote && !canSend ? (
                  <button
                    type="button"
                    aria-label="Gravar áudio"
                    title="Gravar áudio"
                    onClick={() => void toggleRecording()}
                    className={roundPrimary}
                  >
                    <Microphone size={20} />
                  </button>
                ) : (
                  // keeps its visible text: "Salvar nota" tells the agent the note does not reach the contact
                  <button
                    type="button"
                    onClick={() => void send()}
                    disabled={sending || !canSend}
                    className={button('primary')}
                  >
                    {isNote ? 'Salvar nota' : 'Enviar'} <PaperPlaneRight size={16} weight="fill" />
                  </button>
                )}
              </div>
            </div>
          </>
        )}

        {botAsk && (
          <BotRunningDialog
            runs={botAsk.runs}
            onChoose={(choice) => {
              botAsk.resolve(choice);
              setBotAsk(null);
            }}
          />
        )}
      </div>
    </div>
  );
}
