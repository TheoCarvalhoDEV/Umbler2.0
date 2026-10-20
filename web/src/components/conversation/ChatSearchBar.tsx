import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CaretDown, CaretUp, MagnifyingGlass, X } from '@phosphor-icons/react';
import { SEARCH_MAX_CHARS, SEARCH_MIN_CHARS } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { resultsLabel, shortDateTime } from './model';

export const SEARCH_DEBOUNCE_MS = 300;

export interface ChatSearchBarProps {
  chatId: string;
  /** Jump to this message in the timeline (spec 2026-10-19 §4). */
  onFocusMessage: (messageId: string) => void;
  onClose: () => void;
}

/**
 * "Buscar na conversa" (spec 2026-10-19 §4): searches 300 ms after the last key and goes to the newest hit;
 * ↑ or Enter goes older, ↓ or Shift+Enter newer (wrapping around); Esc closes.
 */
export function ChatSearchBar({ chatId, onFocusMessage, onClose }: ChatSearchBarProps) {
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [index, setIndex] = useState(0);
  // the latest callback without re-running the jump effect when the parent re-renders
  const focusRef = useRef(onFocusMessage);
  focusRef.current = onFocusMessage;

  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(text.trim());
      setIndex(0); // a new term starts at the newest hit
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const enabled = q.length >= SEARCH_MIN_CHARS;
  const search = useQuery({ queryKey: qk.chatSearch(chatId, q), queryFn: () => api.chats.search(chatId, q), enabled });
  const hits = enabled ? (search.data ?? []) : [];
  const current = hits[index];
  const currentId = current?.messageId;

  useEffect(() => {
    if (currentId) focusRef.current(currentId);
  }, [currentId]);

  function step(delta: number) {
    if (hits.length > 0) setIndex((i) => (i + delta + hits.length) % hits.length);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing) return; // an IME-confirming Enter must not jump
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowUp' || (e.key === 'Enter' && !e.shiftKey)) {
      e.preventDefault();
      step(1); // newest first: the next index is older
    } else if (e.key === 'ArrowDown' || (e.key === 'Enter' && e.shiftKey)) {
      e.preventDefault();
      step(-1);
    }
  }

  const iconButton =
    'flex size-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-sidebar-hover hover:text-fg disabled:opacity-40';

  return (
    <div className="border-b border-border bg-surface px-6 py-2">
      <div role="search" className="flex items-center gap-2">
        <MagnifyingGlass size={16} aria-hidden className="shrink-0 text-muted" />
        <input
          autoFocus
          aria-label="Buscar mensagens"
          placeholder="Buscar nesta conversa…"
          maxLength={SEARCH_MAX_CHARS}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          className="min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-muted"
        />
        {enabled && (
          <span aria-live="polite" className="shrink-0 text-xs text-muted">
            {search.isPending ? 'Buscando…' : search.isError ? 'Não foi possível buscar' : resultsLabel(hits.length)}
          </span>
        )}
        {current && (
          <span className="shrink-0 text-xs font-medium text-fg">
            {index + 1}/{hits.length}
          </span>
        )}
        <button type="button" aria-label="Resultado anterior" title="Resultado anterior (↑)" disabled={hits.length < 2} onClick={() => step(1)} className={iconButton}>
          <CaretUp size={16} />
        </button>
        <button type="button" aria-label="Próximo resultado" title="Próximo resultado (↓)" disabled={hits.length < 2} onClick={() => step(-1)} className={iconButton}>
          <CaretDown size={16} />
        </button>
        <button type="button" aria-label="Fechar busca" title="Fechar busca (Esc)" onClick={onClose} className={iconButton}>
          <X size={16} />
        </button>
      </div>
      {current && (
        <p className="mt-1 truncate pl-6 text-xs text-muted">
          {shortDateTime(current.sentAt)} · {current.snippet}
        </p>
      )}
    </div>
  );
}
