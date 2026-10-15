// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { ContactDto } from '@talk/shared';
import { NewChatDialog } from './NewChatDialog';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

const ana: ContactDto = {
  id: 'ct-ana', name: 'Ana Souza', phone: '5565999991111', lid: null, email: null, landline: null,
  address: null, blocked: false, tagIds: [], fields: {}, createdAt: '2026-10-01T10:00:00.000Z',
};

const calls: Array<{ method: string; path: string; body: unknown }> = [];

function stubApi() {
  calls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    calls.push({ method, path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.pathname === '/api/contacts') {
      return json({ items: url.searchParams.get('q') === 'Ana' ? [ana] : [], nextCursor: null });
    }
    if (url.pathname === '/api/chats' && method === 'POST') return json({ id: 'chat-1' });
    return json({ error: 'inesperado' }, 500);
  }));
}

function renderDialog(onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/chats']}>
        <Routes>
          <Route
            path="/chats"
            element={<NewChatDialog sectors={[{ id: 's1', name: 'Financeiro', position: 1, isDefault: false }]} onClose={onClose} />}
          />
          <Route path="/chats/:id" element={<p>conversa aberta</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return onClose;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('submits a typed phone with name and sector, then opens the new chat', async () => {
  stubApi();
  const onClose = renderDialog();
  fireEvent.change(screen.getByLabelText('Contato ou telefone'), { target: { value: '(65) 99999-9999' } });
  fireEvent.change(screen.getByLabelText('Nome (opcional)'), { target: { value: ' Ana Souza ' } });
  fireEvent.change(screen.getByLabelText('Setor'), { target: { value: 's1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Iniciar conversa' }));

  await screen.findByText('conversa aberta');
  const post = calls.find((c) => c.method === 'POST' && c.path === '/api/chats');
  expect(post?.body).toEqual({ phone: '(65) 99999-9999', name: 'Ana Souza', sectorId: 's1' });
  expect(onClose).toHaveBeenCalled();
});

it('starts a chat with an existing contact picked from the search', async () => {
  stubApi();
  renderDialog();
  fireEvent.change(screen.getByLabelText('Contato ou telefone'), { target: { value: 'Ana' } });
  fireEvent.click(await screen.findByRole('button', { name: /Ana Souza/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Iniciar conversa' }));

  await screen.findByText('conversa aberta');
  const post = calls.find((c) => c.method === 'POST' && c.path === '/api/chats');
  expect(post?.body).toEqual({ contactId: 'ct-ana' });
});

it('rejects a phone without DDD and does not call the API', async () => {
  stubApi();
  renderDialog();
  fireEvent.change(screen.getByLabelText('Contato ou telefone'), { target: { value: '9999-0000' } });
  fireEvent.click(screen.getByRole('button', { name: 'Iniciar conversa' }));

  expect((await screen.findByRole('alert')).textContent).toBe('Escolha um contato ou digite um telefone com DDD.');
  await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(false));
});
