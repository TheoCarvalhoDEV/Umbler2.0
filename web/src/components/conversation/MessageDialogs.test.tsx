// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ChatListItem, ContactDto, MessageDto } from '@talk/shared';
import { ForwardDialog } from './MessageDialogs';

HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
  this.setAttribute('open', '');
};

type Call = { method: string; path: string; body: unknown };
const calls: Call[] = [];

/** A route is a JSON body (200) or a function of the call number returning a Response. */
function stubFetch(routes: Record<string, unknown>) {
  calls.length = 0;
  const hits = new Map<string, number>();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init?.method ?? 'GET';
      calls.push({ method, path: url.pathname, body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body });
      const key = `${method} ${url.pathname}`;
      const n = (hits.get(key) ?? 0) + 1;
      hits.set(key, n);
      const route = routes[key];
      if (typeof route === 'function') return (route as (n: number) => Response)(n);
      if (!(key in routes)) return new Response(JSON.stringify({ error: 'inesperado' }), { status: 500 });
      return new Response(JSON.stringify(route), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const message = (over: Partial<MessageDto> = {}): MessageDto => ({
  id: 'm1', chatId: 'c1', direction: 'in', kind: 'text', body: 'Comprovante', media: null, mediaUnavailable: false,
  authorId: null, authorName: null, authorAvatarUrl: null, replyTo: null, reaction: null, status: 'read', error: null,
  sentAt: '2026-10-16T12:00:00.000Z', ...over,
});
const chatItem = (id: string, contactId: string, name: string): ChatListItem => ({
  id, contact: { id: contactId, name, phone: null, avatarUrl: null }, channelId: 'ch1', sectorId: 's1', ownerId: null,
  state: 'open', waiting: false, private: false, unread: 0, lastMessageAt: null, lastMessagePreview: null, pinned: false, tagIds: [],
});
const contact = (id: string, name: string): ContactDto => ({
  id, name, phone: null, lid: null, email: null, landline: null, address: null, blocked: false, tagIds: [], fields: {},
  createdAt: '2026-10-01T12:00:00.000Z', avatarUrl: null,
});

function renderDialog(onClose = vi.fn()) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ForwardDialog message={message()} onClose={onClose} />
    </QueryClientProvider>,
  );
  return onClose;
}

const SEARCH = {
  'GET /api/chats': { items: [chatItem('c2', 'k2', 'Maria Souza')], nextCursor: null },
  'GET /api/contacts': { items: [contact('k2', 'Maria Souza'), contact('k3', 'Mário Lima')], nextCursor: null },
};

describe('ForwardDialog', () => {
  it('searches open chats and contacts, lists each person once and forwards to the pick', async () => {
    stubFetch({ ...SEARCH, 'POST /api/messages/m1/forward': message({ id: 'm9', chatId: 'c3', direction: 'out' }) });
    const onClose = renderDialog();

    fireEvent.change(screen.getByLabelText('Conversa ou contato'), { target: { value: 'Ma' } });
    await screen.findByText('Conversas abertas'); // both searches answered
    expect(await screen.findByRole('button', { name: 'Mário Lima' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Maria Souza' })).toHaveLength(1); // her open chat, not her contact again
    fireEvent.click(screen.getByRole('button', { name: 'Mário Lima' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls.filter((c) => c.method === 'POST')).toEqual([
      { method: 'POST', path: '/api/messages/m1/forward', body: { contactId: 'k3' } },
    ]);
  });

  it('asks what to do with a running chatbot and retries with the choice', async () => {
    stubFetch({
      ...SEARCH,
      'POST /api/messages/m1/forward': (n: number) =>
        n === 1
          ? new Response(
              JSON.stringify({ error: 'O chatbot está em execução nesta conversa', code: 'BOT_RUNNING', runs: [{ id: 'r1', botName: 'Recepção' }] }),
              { status: 409, headers: { 'content-type': 'application/json' } },
            )
          : new Response(JSON.stringify(message({ id: 'm9', chatId: 'c2' })), { status: 200, headers: { 'content-type': 'application/json' } }),
    });
    const onClose = renderDialog();

    fireEvent.change(screen.getByLabelText('Conversa ou contato'), { target: { value: 'Ma' } });
    await screen.findByText('Conversas abertas'); // Maria is listed under her open chat, not as a contact
    await screen.findByRole('button', { name: 'Mário Lima' });
    fireEvent.click(screen.getByRole('button', { name: 'Maria Souza' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Enviar e manter' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.body)).toEqual([{ chatId: 'c2' }, { chatId: 'c2', botAction: 'keep' }]);
  });

  it('shows the server refusal in Portuguese', async () => {
    stubFetch({
      ...SEARCH,
      'POST /api/messages/m1/forward': () =>
        new Response(JSON.stringify({ error: 'Esta mídia não está disponível para encaminhar' }), {
          status: 400, headers: { 'content-type': 'application/json' },
        }),
    });
    renderDialog();
    fireEvent.change(screen.getByLabelText('Conversa ou contato'), { target: { value: 'Ma' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Mário Lima' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Esta mídia não está disponível para encaminhar');
  });
});
