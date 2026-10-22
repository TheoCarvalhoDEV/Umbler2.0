import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ChatDetail, MessageDto } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { useWsEvent } from '../../lib/ws';
import { ChatSearchBar } from './ChatSearchBar';
import { Composer } from './Composer';
import { ConversationHeader } from './ConversationHeader';
import { ScheduledStrip } from './Scheduled';
import { errorMessage, type TimelineFocus } from './model';
import { Timeline } from './Timeline';
import { card, fieldError } from '../ui';

export interface ConversationViewProps {
  chatId: string;
  contactPanelOpen: boolean;
  onToggleContactPanel: () => void;
  onOpenChat: (chatId: string) => void;
  /** Spec 2026-10-19 §4/§5: the message to bring into view (a search hit or a favorite). */
  focus?: TimelineFocus | null;
  /** Asks the page to focus a message (the search bar's hits). */
  onFocusMessage?: (messageId: string) => void;
}

export function ConversationView(props: ConversationViewProps) {
  // key: another chat starts with a fresh reply chip, scroll position and composer draft
  return <ConversationPane key={props.chatId} {...props} />;
}

function ClosedFooter({ chat, onOpenChat }: { chat: ChatDetail; onOpenChat: (chatId: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function startNew() {
    setBusy(true);
    setError(null);
    try {
      // §5.3a: returns the already-open chat for this contact if there is one
      const next = await api.chats.start({ contactId: chat.contact.id, sectorId: chat.sectorId });
      onOpenChat(next.id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    // the bar sits where the composer floats on an open chat, in the same 26px pill
    <div className="bg-sunken px-4 pt-3 pb-4">
      <div className="rounded-[26px] bg-surface px-5 py-4 text-center text-sm text-muted shadow-float">
        {chat.history ? 'Histórico importado do WhatsApp (só leitura)' : 'Conversa finalizada'} —{' '}
        <button
          type="button"
          disabled={busy}
          onClick={() => void startNew()}
          className="font-bold text-link underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
        >
          Nova conversa
        </button>
        {error && (
          <p role="alert" className={fieldError}>
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

function ConversationPane({
  chatId, contactPanelOpen, onToggleContactPanel, onOpenChat, focus = null, onFocusMessage,
}: ConversationViewProps) {
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: qk.chat(chatId), queryFn: () => api.chats.get(chatId) });
  const [replyTo, setReplyTo] = useState<MessageDto | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const chat = detail.data;
  const unread = chat?.unread ?? 0;

  // mark read on open and whenever a new inbound message arrives while the chat is on screen
  useEffect(() => {
    if (unread > 0) api.chats.markRead(chatId).catch(() => undefined); // best effort; the next open retries
  }, [chatId, unread]);

  // Assume, transfer, privacy, close and reopen record a chat event. That is true whether this user
  // or someone else (via chat.updated) did it. Reload the timeline when one of those fields changes.
  const eventFields = chat ? `${chat.state}|${chat.sectorId}|${chat.ownerId}|${chat.private}` : '';
  const lastEventFields = useRef(eventFields);
  useEffect(() => {
    if (lastEventFields.current && eventFields && lastEventFields.current !== eventFields) {
      void qc.invalidateQueries({ queryKey: qk.timeline(chatId) }); // prefix: the anchored views too
    }
    lastEventFields.current = eventFields;
  }, [eventFields, chatId, qc]);

  // the server may drop an echo duplicate row (or a deleted note) without a message event: refetch on chat.updated,
  // the anchored views and the favorites list included
  useWsEvent((ev) => {
    if (ev.type !== 'chat.updated' || ev.chat.id !== chatId) return;
    void qc.invalidateQueries({ queryKey: qk.timeline(chatId) });
    void qc.invalidateQueries({ queryKey: qk.chatFavorites(chatId), exact: true });
    // scheduling, editing, cancelling and each send or failure publish chat.updated (spec 2026-10-20 agendamentos §3.2)
    void qc.invalidateQueries({ queryKey: qk.chatScheduled(chatId), exact: true });
    // making, moving and cancelling an appointment publish chat.updated too (spec 2026-10-21 compromissos §3.1)
    void qc.invalidateQueries({ queryKey: qk.chatAppointments(chatId), exact: true });
  });

  if (detail.isError) {
    return <p className={`${card} grid h-full min-w-0 flex-1 place-items-center text-sm text-muted`}>Esta conversa não está disponível para você.</p>;
  }
  if (!chat) {
    return <p className={`${card} grid h-full min-w-0 flex-1 place-items-center text-sm text-muted`}>Carregando conversa…</p>;
  }

  return (
    <section className={`${card} flex h-full min-w-0 flex-1 flex-col overflow-hidden`}>
      <ConversationHeader
        chat={chat}
        contactPanelOpen={contactPanelOpen}
        onToggleContactPanel={onToggleContactPanel}
        onOpenChat={onOpenChat}
        searchOpen={searchOpen}
        onToggleSearch={() => setSearchOpen((o) => !o)}
      />
      {searchOpen && (
        <ChatSearchBar chatId={chatId} onFocusMessage={(id) => onFocusMessage?.(id)} onClose={() => setSearchOpen(false)} />
      )}
      <Timeline chatId={chatId} onReply={setReplyTo} chatOpen={chat.state === 'open'} focus={focus} />
      <ScheduledStrip chatId={chatId} />
      {chat.state === 'open' ? (
        <Composer chatId={chatId} replyTo={replyTo} onClearReply={() => setReplyTo(null)} />
      ) : (
        <ClosedFooter chat={chat} onOpenChat={onOpenChat} />
      )}
    </section>
  );
}
