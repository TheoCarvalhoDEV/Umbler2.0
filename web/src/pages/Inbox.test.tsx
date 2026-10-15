// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { ChatListItem } from '@talk/shared';
import { Inbox } from './Inbox';

const chatA: ChatListItem = {
  id: 'a',
  contact: { id: 'ct1', name: 'Ana Souza', phone: '5565999991111' },
  channelId: 'ch1',
  sectorId: 's1',
  ownerId: 'u1',
  state: 'open',
  waiting: true,
  private: true,
  unread: 3,
  lastMessageAt: '2026-10-14T12:00:00.000Z',
  lastMessagePreview: 'Bom dia',
  pinned: true,
  tagIds: [],
};
const chatB: ChatListItem = {
  ...chatA,
  id: 'b',
  contact: { id: 'ct2', name: null, phone: '5565999990000' },
  ownerId: null,
  private: false,
  unread: 1,
  lastMessagePreview: 'Oi',
  pinned: false,
};

const calls: Array<{ method: string; url: URL }> = [];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    calls.push({ method, url });
    if (url.pathname === '/api/sectors') return json([{ id: 's1', name: 'Financeiro', position: 1, isDefault: false }]);
    if (url.pathname === '/api/users') {
      return json([{ id: 'u1', name: 'Maria Lima', email: 'maria@exemplo.com.br', role: 'agent', signature: null, active: true, sectorIds: ['s1'] }]);
    }
    if (url.pathname === '/api/tags') return json([]);
    if (url.pathname === '/api/chats/a/pin') return new Response(null, { status: 204 });
    if (url.pathname === '/api/chats') {
      return json({ items: url.searchParams.get('tab') === 'inbox' ? [chatA, chatB] : [], nextCursor: null });
    }
    return json({ error: 'inesperado' }, 500);
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderInbox() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/chats']}>
        <Routes>
          <Route path="/chats" element={<Inbox />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

it('renders chat items with preview, unread, owner, sector, lock and pin', async () => {
  renderInbox();
  expect(await screen.findByText('Ana Souza')).toBeTruthy();
  expect(screen.getByText('+55 65 99999-0000')).toBeTruthy();
  expect(screen.getByText('Bom dia')).toBeTruthy();
  expect(screen.getByLabelText('Não lidas: 3')).toBeTruthy();
  expect(screen.getByLabelText('Conversa privada')).toBeTruthy();
  expect(screen.getByLabelText('Fixada')).toBeTruthy();
  expect((await screen.findByTitle('Maria Lima')).textContent).toBe('ML');
  expect((await screen.findAllByText('Financeiro')).length).toBe(2);
});

it('shows the unread badge on Entrada and switches to Esperando', async () => {
  renderInbox();
  expect(await screen.findByLabelText('Conversas não lidas: 2')).toBeTruthy();
  fireEvent.click(screen.getByRole('tab', { name: /Esperando/ }));
  expect(await screen.findByText('Nenhuma conversa')).toBeTruthy();
  expect(screen.getByRole('tab', { name: /Esperando/ }).getAttribute('aria-selected')).toBe('true');
});

it('sends the debounced search term as q', async () => {
  renderInbox();
  await screen.findByText('Ana Souza');
  fireEvent.change(screen.getByLabelText('Buscar conversas'), { target: { value: 'ana' } });
  await waitFor(() =>
    expect(calls.some((c) => c.url.pathname === '/api/chats' && c.url.searchParams.get('q') === 'ana')).toBe(true),
  );
});

it('unpins a chat from the item menu', async () => {
  renderInbox();
  await screen.findByText('Ana Souza');
  fireEvent.click(screen.getAllByLabelText('Opções da conversa')[0]);
  fireEvent.click(screen.getByText('Desafixar'));
  await waitFor(() =>
    expect(calls.some((c) => c.method === 'DELETE' && c.url.pathname === '/api/chats/a/pin')).toBe(true),
  );
});
