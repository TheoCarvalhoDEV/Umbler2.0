import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import Login from './Login';
import { createQueryClient } from '../lib/auth';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const ME = { id: 'u1', name: 'Ana Souza', email: 'ana@jvo.adv.br', role: 'agent', signature: null, sectorIds: [] };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderLogin() {
  const router = createMemoryRouter(
    [
      { path: '/login', element: <Login /> },
      { path: '/chats', element: <p>Caixa de entrada</p> },
    ],
    { initialEntries: ['/login'] },
  );
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

async function fillAndSubmit() {
  fireEvent.change(await screen.findByLabelText('E-mail'), { target: { value: 'ana@jvo.adv.br' } });
  fireEvent.change(screen.getByLabelText('Senha'), { target: { value: 'segredo-123' } });
  fireEvent.click(screen.getByRole('button', { name: 'Entrar' }));
}

it('logs in and goes to the inbox', async () => {
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    if (input === '/api/auth/me') return json(401, { error: 'Não autenticado' });
    if (input === '/api/auth/login' && init?.method === 'POST') return json(200, ME);
    return json(404, { error: 'Não encontrado' });
  });
  vi.stubGlobal('fetch', fetchMock);
  renderLogin();
  await fillAndSubmit();
  expect(await screen.findByText('Caixa de entrada')).toBeTruthy();
  const loginCall = fetchMock.mock.calls.find(([u]) => u === '/api/auth/login')!;
  expect(JSON.parse(loginCall[1]!.body as string)).toEqual({ email: 'ana@jvo.adv.br', password: 'segredo-123' });
});

it('shows the server error message on wrong credentials', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input) =>
      input === '/api/auth/me' ? json(401, { error: 'Não autenticado' }) : json(401, { error: 'E-mail ou senha inválidos' }),
    ),
  );
  renderLogin();
  await fillAndSubmit();
  expect((await screen.findByRole('alert')).textContent).toBe('E-mail ou senha inválidos');
  expect(screen.queryByText('Caixa de entrada')).toBeNull();
});

it('skips the form when already logged in', async () => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => json(200, ME)));
  renderLogin();
  expect(await screen.findByText('Caixa de entrada')).toBeTruthy();
});
