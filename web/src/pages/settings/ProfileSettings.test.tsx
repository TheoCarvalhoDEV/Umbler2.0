// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Me } from '@talk/shared';
import { ProfileSettings } from './ProfileSettings';

const me: Me = { id: 'u1', name: 'Ana Lima', email: 'ana@exemplo.com.br', role: 'agent', signature: null, sectorIds: [], seeAllSectors: false, avatarUrl: null };
const withPic: Me = { ...me, avatarUrl: '/api/users/u1/avatar?v=abc' };
const admin: Me = { ...me, role: 'admin' };
const calls: Array<{ method: string; path: string; body: unknown }> = [];
let current: Me;

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls.length = 0;
  current = admin;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    const method = init?.method ?? 'GET';
    calls.push({ method, path, body: init?.body });
    if (path === '/api/sectors') return json([]);
    if (path === '/api/auth/me/avatar' && method === 'POST') return json(withPic);
    if (path === '/api/auth/me/avatar' && method === 'DELETE') return json(me);
    if (path === '/api/users/u1' && method === 'PATCH') {
      current = { ...admin, ...JSON.parse(String(init?.body)) };
      return json(current);
    }
    if (path === '/api/auth/me') return json(current);
    if (path === '/api/users') return json([]);
    return json({ error: 'inesperado' }, 500);
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderProfile(current: Me) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(['me'], current);
  const view = render(
    <QueryClientProvider client={client}>
      <ProfileSettings />
    </QueryClientProvider>,
  );
  return { client, container: view.container };
}

describe('ProfileSettings photo', () => {
  it('uploads the chosen picture as multipart field "file" and shows the new photo', async () => {
    const { client, container } = renderProfile(me);
    expect(container.querySelector('img')).toBeNull();
    const file = new File(['img'], 'eu.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('Trocar foto'), { target: { files: [file] } });

    await waitFor(() => expect(container.querySelector('img')?.getAttribute('src')).toBe(withPic.avatarUrl));
    const post = calls.find((c) => c.method === 'POST' && c.path === '/api/auth/me/avatar')!;
    expect((post.body as FormData).get('file')).toBe(file);
    expect(client.getQueryData<Me>(['me'])?.avatarUrl).toBe(withPic.avatarUrl);
  });

  it('removes the picture', async () => {
    const { client, container } = renderProfile(withPic);
    fireEvent.click(screen.getByRole('button', { name: 'Remover foto' }));
    await waitFor(() => expect(container.querySelector('img')).toBeNull());
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/auth/me/avatar')).toBe(true);
    expect(client.getQueryData<Me>(['me'])?.avatarUrl).toBeNull();
  });
});

describe('ProfileSettings form (admin)', () => {
  it('shows Descartar/Salvar only with changes and saves name and signature', async () => {
    renderProfile(admin);
    expect(screen.queryByRole('button', { name: 'Salvar' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: ' Ana Souza ' } });
    fireEvent.change(screen.getByLabelText('Assinatura'), { target: { value: 'Ana - Financeiro' } });
    expect(screen.getByText('Ana - Financeiro:')).toBeTruthy(); // the sent-bubble preview

    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await screen.findByText('Alterações salvas.');
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.path).toBe('/api/users/u1');
    expect(JSON.parse(String(patch.body))).toEqual({ name: 'Ana Souza', signature: 'Ana - Financeiro' });
  });

  it('Descartar puts the saved values back; Trocar senha opens the password fields', () => {
    renderProfile(admin);
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Outro' } });
    fireEvent.click(screen.getByRole('button', { name: 'Descartar' }));
    expect((screen.getByLabelText('Nome') as HTMLInputElement).value).toBe('Ana Lima');
    expect(screen.queryByRole('button', { name: 'Salvar' })).toBeNull();

    expect(screen.queryByLabelText('Nova senha')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Trocar senha' }));
    fireEvent.change(screen.getByLabelText('Nova senha'), { target: { value: '12345678' } });
    fireEvent.change(screen.getByLabelText('Repita a nova senha'), { target: { value: '1234' } });
    expect(screen.getByText('As senhas não conferem.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Salvar' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
