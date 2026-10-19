import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ChatDetail, MessageDto } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { useWsEvent } from '../../lib/ws';
import { Composer } from './Composer';
import { ConversationHeader } from './ConversationHeader';
import { errorMessage } from './model';
import { Timeline } from './Timeline';

export interface ConversationViewProps {
  chatId: string;
  contactPanelOpen: boolean;
  onToggleContactPanel: () => void;
  onOpenChat: (chatId: string) => void;
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
    <div className="border-t border-border bg-surface px-4 py-3 text-center text-sm text-muted">
      {chat.history ? 'Histórico importado do WhatsApp (só leitura)' : 'Conversa finalizada'} —{' '}
      <button type="button" disabled={busy} onClick={() => void startNew()} className="font-medium text-fg underline disabled:opacity-50">
        Nova conversa
      </button>
      {error && (
        <p role="alert" className="mt-1 text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function ConversationPane({ chatId, contactPanelOpen, onToggleContactPanel, onOpenChat }: ConversationViewProps) {
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: qk.chat(chatId), queryFn: () => api.chats.get(chatId) });
  const [replyTo, setReplyTo] = useState<MessageDto | null>(null);
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
      void qc.invalidateQueries({ queryKey: qk.timeline(chatId), exact: true });
    }
    lastEventFields.current = eventFields;
  }, [eventFields, chatId, qc]);

  // the server may drop an echo duplicate row without a message event: refetch the timeline on chat.updated
  useWsEvent((ev) => {
    if (ev.type === 'chat.updated' && ev.chat.id === chatId) void qc.invalidateQueries({ queryKey: qk.timeline(chatId), exact: true });
  });

  if (detail.isError) {
    return <p className="grid h-full place-items-center text-sm text-muted">Esta conversa não está disponível para você.</p>;
  }
  if (!chat) {
    return <p className="grid h-full place-items-center text-sm text-muted">Carregando conversa…</p>;
  }

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col">
      <ConversationHeader
        chat={chat}
        contactPanelOpen={contactPanelOpen}
        onToggleContactPanel={onToggleContactPanel}
        onOpenChat={onOpenChat}
      />
      <Timeline chatId={chatId} onReply={setReplyTo} chatOpen={chat.state === 'open'} />
      {chat.state === 'open' ? (
        <Composer chatId={chatId} replyTo={replyTo} onClearReply={() => setReplyTo(null)} />
      ) : (
        <ClosedFooter chat={chat} onOpenChat={onOpenChat} />
      )}
    </section>
  );
}
