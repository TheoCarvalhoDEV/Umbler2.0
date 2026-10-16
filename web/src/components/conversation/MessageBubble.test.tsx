// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MessageDto } from '@talk/shared';
import { MessageBubble } from './MessageBubble';

// jsdom has no modal <dialog> API; the browser opens ChatDialogs' Modal with showModal()
HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
  this.setAttribute('open', '');
};

type Call = { method: string; path: string; body: unknown };
const calls: Call[] = [];

function stubFetch(routes: Record<string, unknown>) {
  calls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init?.method ?? 'GET';
      calls.push({ method, path: url.pathname, body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body });
      const key = `${method} ${url.pathname}`;
      if (!(key in routes)) return new Response(JSON.stringify({ error: 'inesperado' }), { status: 500 });
      return new Response(JSON.stringify(routes[key]), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const base: MessageDto = {
  id: 'm1', chatId: 'c1', direction: 'out', kind: 'text', body: 'Olá', media: null, mediaUnavailable: false,
  authorId: 'u1', authorName: 'Ana Lima', authorAvatarUrl: '/api/users/u1/avatar?v=abc', replyTo: null, reaction: null,
  status: 'sent', error: null, sentAt: '2026-10-15T12:00:00.000Z',
};

function renderBubble(m: MessageDto) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MessageBubble m={m} onReply={() => {}} />
    </QueryClientProvider>,
  ).container;
}

describe('MessageBubble author avatar', () => {
  it('shows the agent picture next to messages sent by an agent', () => {
    expect(renderBubble(base).querySelector('img')?.getAttribute('src')).toBe('/api/users/u1/avatar?v=abc');
  });

  it('falls back to the agent initials without a picture', () => {
    const c = renderBubble({ ...base, authorAvatarUrl: null });
    expect(c.querySelector('img')).toBeNull();
    expect(c.querySelector('[data-author-avatar]')?.textContent).toBe('AL');
  });

  it('shows no author avatar on incoming messages or phone/system sends', () => {
    expect(renderBubble({ ...base, direction: 'in', authorId: null, authorName: null, authorAvatarUrl: null }).querySelector('[data-author-avatar]')).toBeNull();
    expect(renderBubble({ ...base, authorId: null, authorName: null, authorAvatarUrl: null }).querySelector('[data-author-avatar]')).toBeNull();
  });
});

describe('MessageBubble chatbot messages', () => {
  const system = { ...base, authorId: null, authorName: null, authorAvatarUrl: null };

  it('labels a message sent by a chatbot run with the robot icon and "Chatbot <nome>"', () => {
    const c = renderBubble({ ...system, botRunId: 'r1', botName: 'Fluxo do escritório' });
    expect(c.textContent).toContain('Chatbot Fluxo do escritório');
    expect(c.textContent).not.toContain('Celular ou sistema');
    expect(c.querySelector('[data-bot-icon]')).not.toBeNull();
    expect(c.querySelector('[data-author-avatar]')).toBeNull();
  });

  it('keeps the phone/system label and no robot when the message has no bot', () => {
    const c = renderBubble({ ...system, botRunId: null, botName: null });
    expect(c.textContent).toContain('Celular ou sistema');
    expect(c.querySelector('[data-bot-icon]')).toBeNull();
  });

  it('never shows the robot on an incoming message', () => {
    const c = renderBubble({ ...system, direction: 'in', botName: 'Fluxo do escritório' });
    expect(c.querySelector('[data-bot-icon]')).toBeNull();
    expect(c.textContent).not.toContain('Chatbot');
  });
});

describe('MessageBubble tags and reactions', () => {
  it('keeps a deleted message visible with who deleted it', () => {
    const c = renderBubble({ ...base, direction: 'in', authorId: null, deleted: { at: base.sentAt, source: 'contact', byName: null } });
    expect(c.textContent).toContain('Olá');
    expect(c.querySelector('[data-tag="deleted"]')?.textContent).toBe('Apagada pelo contato');
    const mine = renderBubble({ ...base, id: 'm2', deleted: { at: base.sentAt, source: 'office', byName: 'Ana Lima' } });
    expect(mine.querySelector('[data-tag="deleted"]')?.textContent).toBe('Apagada por Ana Lima');
  });

  it('shows Encaminhada and both reactions, the contact one and the office one', () => {
    const c = renderBubble({ ...base, forwarded: true, reaction: '👍', officeReaction: '❤️' });
    expect(c.querySelector('[data-tag="forwarded"]')?.textContent).toContain('Encaminhada');
    expect(screen.getByLabelText('Reação do contato 👍')).toBeTruthy();
    expect(screen.getByLabelText('Reação do escritório ❤️')).toBeTruthy();
    expect(renderBubble({ ...base, id: 'm3' }).querySelector('[data-tag]')).toBeNull();
  });

  it('opens the previous versions from the edited tag', async () => {
    stubFetch({
      'GET /api/messages/m1/edits': [
        { id: 'e1', previousBody: 'Olá!', source: 'office', editedByName: 'Ana Lima', newTextUnavailable: false, editedAt: '2026-10-15T12:01:00.000Z' },
      ],
    });
    renderBubble({ ...base, edited: { at: base.sentAt, source: 'contact', newTextUnavailable: true } });
    fireEvent.click(screen.getByRole('button', { name: 'editada pelo contato (novo texto indisponível)' }));
    expect(await screen.findByText('Olá!')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Versões anteriores' })).toBeTruthy();
    expect(calls).toEqual([{ method: 'GET', path: '/api/messages/m1/edits', body: undefined }]);
  });
});
