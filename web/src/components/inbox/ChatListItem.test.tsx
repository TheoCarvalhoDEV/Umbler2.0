// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ChatListItem as ChatItem, TagDto } from '@talk/shared';
import { ChatListItem, withoutSignature } from './ChatListItem';

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

  it('starts the preview with "Você:" when the office spoke last, and flags a failed send', () => {
    renderItem({ lastOutStatus: 'read' });
    expect(screen.getByText('Você:', { exact: false })).toBeTruthy();
    expect(screen.queryByLabelText('Falhou')).toBeNull();
    cleanup();
    renderItem({ lastOutStatus: 'failed' });
    expect(screen.getByLabelText('Falhou')).toBeTruthy();
    cleanup();
    renderItem({ lastOutStatus: null });
    expect(screen.queryByText('Você:', { exact: false })).toBeNull();
  });

  it('third line: the sector chip, then the owner, or "Sem atendente" on an open chat', () => {
    render(
      <ul>
        <ChatListItem chat={CHAT} sectorName="Atendimento" owner={{ name: 'Juliana Prado', avatarUrl: null }} active={false}
          onOpen={() => {}} onTogglePin={() => {}} onMarkUnread={() => {}} onOpenWith={() => {}} />
      </ul>,
    );
    expect(screen.getByTitle('Setor: Atendimento')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Responsável: Juliana Prado' }).textContent).toBe('JJuliana');
    cleanup();
    render(
      <ul>
        <ChatListItem chat={CHAT} sectorName="Triagem" owner={null} active={false}
          onOpen={() => {}} onTogglePin={() => {}} onMarkUnread={() => {}} onOpenWith={() => {}} />
      </ul>,
    );
    expect(screen.getByText('Sem atendente')).toBeTruthy();
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

const TAGS = new Map<string, TagDto>(
  ['Cliente', 'Prazo', 'E3', 'E4', 'E5', 'E6'].map((name, i): [string, TagDto] => [
    `t${i + 1}`,
    { id: `t${i + 1}`, name, emoji: null, color: '#2563eb', position: i },
  ]),
);

function renderWith(chat: Partial<ChatItem>, selection?: { selected: boolean; disabled: boolean; onToggle: () => void }) {
  const onOpen = vi.fn();
  render(
    <ul>
      <ChatListItem
        chat={{ ...CHAT, ...chat }}
        sectorName={null}
        owner={null}
        active={false}
        onOpen={onOpen}
        onTogglePin={() => {}}
        onMarkUnread={() => {}}
        onOpenWith={() => {}}
        tagById={TAGS}
        selection={selection}
      />
    </ul>,
  );
  return onOpen;
}
const chipTitles = () => [...document.querySelectorAll('[title^="Etiqueta"]')].map((e) => e.getAttribute('title'));

describe('ChatListItem tags and selection (spec 2026-10-20 §4, §5)', () => {
  it('shows conversation tags first, then contact tags, in the tag color, and skips unknown ids', () => {
    renderWith({ tagIds: ['t1', 'gone'], chatTagIds: ['t2'] });
    expect(chipTitles()).toEqual(['Etiqueta da conversa: Prazo', 'Etiqueta do contato: Cliente']);
    expect(screen.getByTitle('Etiqueta da conversa: Prazo').getAttribute('style')).toContain('color-mix');
  });

  it('shows at most 2 tag chips and +N for the rest', () => {
    renderWith({ tagIds: ['t1', 't3', 't4'], chatTagIds: ['t2', 't5', 't6'] });
    expect(chipTitles()).toHaveLength(2);
    expect(screen.getByText('+4')).toBeTruthy();
  });

  it('in selection mode the row toggles the checkbox instead of opening, and the menu is gone', () => {
    const onToggle = vi.fn();
    const onOpen = renderWith({}, { selected: false, disabled: false, onToggle });
    expect(document.querySelector('details')).toBeNull();
    fireEvent.click(screen.getByText('Maria'));
    fireEvent.click(screen.getByLabelText('Selecionar Maria'));
    expect(onToggle).toHaveBeenCalledTimes(2);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('a disabled checkbox (50 already selected) does nothing and says why', () => {
    const onToggle = vi.fn();
    renderWith({}, { selected: false, disabled: true, onToggle });
    const box = screen.getByLabelText('Selecionar Maria') as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(box.closest('label')?.getAttribute('title')).toBe('Até 50 conversas por vez');
    fireEvent.click(screen.getByText('Maria'));
    expect(onToggle).not.toHaveBeenCalled();
  });
});

describe('card preview without the signature', () => {
  it("drops the leading WhatsApp signature of the office's messages only", () => {
    expect(withoutSignature('*Atendente: Nayara.:*\nolá boa tarde')).toBe('olá boa tarde');
    expect(withoutSignature('*Atendimento - Ana:* Segue o documento')).toBe('Segue o documento');
    expect(withoutSignature('sem assinatura')).toBe('sem assinatura');
    expect(withoutSignature('*negrito* no meio')).toBe('*negrito* no meio');
  });

  it('shows "Você:" and the text without the signature; a contact message is left as is', () => {
    renderItem({ lastOutStatus: 'read', lastMessagePreview: '*Atendente: Nayara.:*\nolá boa tarde' });
    expect(screen.getByText('olá boa tarde', { exact: false })).toBeTruthy();
    expect(screen.queryByText('Atendente: Nayara', { exact: false })).toBeNull();
    cleanup();
    renderItem({ lastOutStatus: null, lastMessagePreview: '*Atendente: X.:* oi' });
    expect(screen.getByText('*Atendente: X.:* oi')).toBeTruthy();
  });
});
