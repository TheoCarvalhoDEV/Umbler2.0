// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { ChatListItem, Me } from '@talk/shared';
import { Inbox } from './Inbox';

const chatA: ChatListItem = {
  id: 'a',
  contact: { id: 'ct1', name: 'Ana Souza', phone: '5565999991111', avatarUrl: '/api/contacts/ct1/avatar?v=1' },
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
  contact: { id: 'ct2', name: null, phone: '5565999990000', avatarUrl: null },
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
      return json([{ id: 'u1', name: 'Maria Lima', email: 'maria@exemplo.com.br', role: 'agent', signature: null, active: true, sectorIds: ['s1'], avatarUrl: '/api/users/u1/avatar?v=abc' }]);
    }
    if (url.pathname === '/api/tags') return json([]);
    if (url.pathname === '/api/chats/a/pin') return new Response(null, { status: 204 });
    if (url.pathname === '/api/auth/me/view' && method === 'PUT') {
      return json({ ...adminMe, seeAllSectors: JSON.parse(String(init?.body)).seeAllSectors });
    }
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

const adminMe: Me = { id: 'adm', name: 'Admin', email: 'adm@exemplo.com.br', role: 'admin', signature: null, sectorIds: ['s1'], seeAllSectors: false, avatarUrl: null };

function renderInbox(me?: Me) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  if (me) client.setQueryData(['me'], me);
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/chats']}>
        <Routes>
          <Route path="/chats" element={<Inbox />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

it('renders chat items with preview, unread, owner, sector, lock and pin', async () => {
  renderInbox();
  expect(await screen.findByText('Ana Souza')).toBeTruthy();
  expect(screen.getByText('+55 65 99999-0000')).toBeTruthy();
  expect(screen.getByText('Bom dia')).toBeTruthy();
  expect(screen.getByLabelText('Não lidas: 3')).toBeTruthy();
  expect(screen.getByLabelText('Conversa privada')).toBeTruthy();
  expect(screen.getByLabelText('Fixada')).toBeTruthy();
  expect(screen.getByRole('img', { name: 'Responsável: Maria Lima' })).toBeTruthy();
  expect((await screen.findByTitle('Maria Lima')).querySelector('img')?.getAttribute('src')).toBe('/api/users/u1/avatar?v=abc'); // owner picture
  expect(document.querySelector('img[src="/api/contacts/ct1/avatar?v=1"]')).toBeTruthy(); // contact picture
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

it('lets an admin toggle "Ver todos os setores", updating Me and refetching the chats', async () => {
  const client = renderInbox(adminMe);
  await screen.findByText('Ana Souza');
  const toggle = screen.getByRole('button', { name: 'Ver todos os setores' });
  expect(toggle.getAttribute('aria-pressed')).toBe('false');
  const listCalls = () => calls.filter((c) => c.url.pathname === '/api/chats').length;
  const before = listCalls();

  fireEvent.click(toggle);

  await waitFor(() => expect(toggle.getAttribute('aria-pressed')).toBe('true'));
  const put = calls.find((c) => c.method === 'PUT' && c.url.pathname === '/api/auth/me/view');
  expect(put).toBeTruthy();
  expect(client.getQueryData<Me>(['me'])?.seeAllSectors).toBe(true);
  await waitFor(() => expect(listCalls()).toBeGreaterThan(before));
});

it('does not show the toggle to an agent', async () => {
  renderInbox({ ...adminMe, role: 'agent' });
  await screen.findByText('Ana Souza');
  expect(screen.queryByRole('button', { name: 'Ver todos os setores' })).toBeNull();
});

it('shows an error banner when toggling the view fails', async () => {
  renderInbox(adminMe);
  await screen.findByText('Ana Souza');
  const base = fetch as unknown as (i: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  vi.stubGlobal('fetch', vi.fn(async (i: RequestInfo | URL, init?: RequestInit) =>
    String(i) === '/api/auth/me/view' ? json({ error: 'falhou' }, 500) : base(i, init)));
  fireEvent.click(screen.getByRole('button', { name: 'Ver todos os setores' }));
  expect((await screen.findByRole('alert')).textContent).toBe('Não foi possível alterar a visualização. Tente novamente.');
});

it('a new toggle error replaces an older pin error, and a later success clears the banner', async () => {
  renderInbox(adminMe);
  await screen.findByText('Ana Souza');
  const base = fetch as unknown as (i: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  let viewFails = true;
  vi.stubGlobal('fetch', vi.fn(async (i: RequestInfo | URL, init?: RequestInit) => {
    const path = String(i);
    if (path === '/api/chats/a/pin') return json({ error: 'cheio' }, 409);
    if (path === '/api/auth/me/view' && viewFails) return json({ error: 'falhou' }, 500);
    return base(i, init);
  }));
  fireEvent.click(screen.getAllByLabelText('Opções da conversa')[0]);
  fireEvent.click(screen.getByText('Desafixar'));
  expect((await screen.findByRole('alert')).textContent).toContain('Você já fixou 3 conversas');
  fireEvent.click(screen.getByRole('button', { name: 'Ver todos os setores' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Não foi possível alterar a visualização. Tente novamente.'));
  viewFails = false;
  fireEvent.click(screen.getByRole('button', { name: 'Ver todos os setores' }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
});

it('hints a sectorless admin to enable "Ver todos os setores", even with a non-empty list', async () => {
  renderInbox({ ...adminMe, sectorIds: [] });
  await screen.findByText('Ana Souza');
  expect(screen.getByText(/Você não está em nenhum setor/)).toBeTruthy();
});

it('hides the sectorless hint when the admin sees all sectors', async () => {
  renderInbox({ ...adminMe, sectorIds: [], seeAllSectors: true });
  await screen.findByText('Ana Souza');
  expect(screen.queryByText(/Você não está em nenhum setor/)).toBeNull();
});

it('does not show the sectorless hint to an admin with sectors', async () => {
  renderInbox(adminMe);
  fireEvent.click(await screen.findByRole('tab', { name: /Esperando/ }));
  await screen.findByText('Nenhuma conversa');
  expect(screen.queryByText(/Você não está em nenhum setor/)).toBeNull();
});
