// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ChatListItem as ChatItem } from '@talk/shared';
import { ChatListItem } from './ChatListItem';

const CHAT: ChatItem = {
  id: 'c1', contact: { id: 'k1', name: 'Maria', phone: '5565999990000', avatarUrl: null }, channelId: 'ch1',
  sectorId: 's1', ownerId: null, state: 'open', waiting: false, private: false, unread: 0, lastMessageAt: null,
  lastMessagePreview: null, pinned: false, tagIds: [],
};

afterEach(cleanup);

function renderItem(chat: Partial<ChatItem>, admin = false) {
  const handlers = { onTogglePin: vi.fn(), onMarkUnread: vi.fn(), onOpenWith: vi.fn(), onDelete: vi.fn() };
  render(
    <ul>
      <ChatListItem
        chat={{ ...CHAT, ...chat }}
        sectorName={null}
        owner={null}
        active={false}
        onOpen={() => {}}
        onTogglePin={handlers.onTogglePin}
        onMarkUnread={handlers.onMarkUnread}
        onOpenWith={handlers.onOpenWith}
        onDelete={admin ? handlers.onDelete : undefined}
      />
    </ul>,
  );
  return handlers;
}

const items = () => [...document.querySelectorAll('details button')].map((b) => b.textContent);

describe('ChatListItem menu', () => {
  it('a read open chat, for an agent: Fixar, Marcar como não lida, Transferir, Finalizar', () => {
    renderItem({});
    expect(items()).toEqual(['Fixar', 'Marcar como não lida', 'Transferir', 'Finalizar']);
  });

  it('an unread chat has no "Marcar como não lida"; an admin also gets Excluir conversa', () => {
    renderItem({ unread: 2, pinned: true }, true);
    expect(items()).toEqual(['Desafixar', 'Transferir', 'Finalizar', 'Excluir conversa']);
    expect(screen.getByText('Excluir conversa').className).toContain('text-danger');
  });

  it('marks an imported history chat, and only that one', () => {
    renderItem({ state: 'closed', history: true });
    expect(screen.getByText('Histórico do WhatsApp')).toBeTruthy();
    cleanup();
    renderItem({ state: 'closed' });
    expect(screen.queryByText('Histórico do WhatsApp')).toBeNull();
  });

  it('a closed or history chat cannot be transferred or finished', () => {
    renderItem({ state: 'closed' });
    expect(items()).toEqual(['Fixar', 'Marcar como não lida']);
    cleanup();
    renderItem({ state: 'closed', history: true }, true);
    expect(items()).toEqual(['Fixar', 'Marcar como não lida', 'Excluir conversa']);
  });

  it('shows the ticks before the preview when the last message was the office’s', () => {
    renderItem({ lastOutStatus: 'read' });
    expect(screen.getByLabelText('Você · lida')).toBeTruthy();
    cleanup();
    renderItem({ lastOutStatus: null });
    expect(screen.queryByLabelText(/^Você/)).toBeNull();
  });

  it('each item calls its handler', () => {
    const h = renderItem({}, true);
    fireEvent.click(screen.getByText('Marcar como não lida'));
    fireEvent.click(screen.getByText('Transferir'));
    fireEvent.click(screen.getByText('Finalizar'));
    fireEvent.click(screen.getByText('Excluir conversa'));
    expect(h.onMarkUnread).toHaveBeenCalledOnce();
    expect(h.onOpenWith.mock.calls).toEqual([['transferir'], ['finalizar']]);
    expect(h.onDelete).toHaveBeenCalledOnce();
  });
});
