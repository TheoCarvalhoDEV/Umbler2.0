// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Me, SectorDto, UserDto } from '@talk/shared';
import { qk } from '../../lib/api';
import { confirmDialog } from '../../lib/confirm';
import { UsersSettings } from './UsersSettings';

vi.mock('../../lib/confirm', () => ({ confirmDialog: vi.fn() }));

// jsdom has no modal <dialog> API; the browser opens ChatDialogs' Modal with showModal()
HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
  this.setAttribute('open', '');
};

const me: Me = { id: 'u-admin', name: 'Admin Teste', email: 'admin@teste.local', role: 'admin', signature: null, sectorIds: [], seeAllSectors: false, avatarUrl: null };
const sectors: SectorDto[] = [{ id: 's-fin', name: 'Financeiro', position: 0, isDefault: true }];
const user = (over: Partial<UserDto>): UserDto => ({
  id: 'u', name: 'U', email: 'u@teste.local', role: 'agent', signature: null, active: true, sectorIds: [], avatarUrl: null, ...over,
});
const users: UserDto[] = [
  user({ id: 'u-admin', name: 'Admin Teste', email: 'admin@teste.local', role: 'admin' }),
  user({ id: 'u-ana', name: 'Ana Financeiro', email: 'ana@teste.local', sectorIds: ['s-fin'] }),
  user({ id: 'u-old', name: 'Carlos Inativo', email: 'carlos@teste.local', active: false }),
];

const calls: Array<{ method: string; path: string; body: unknown }> = [];
const mutations = () => calls.filter((c) => c.method !== 'GET');

beforeEach(() => {
  calls.length = 0;
  vi.mocked(confirmDialog).mockReset();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      const method = init?.method ?? 'GET';
      calls.push({ method, path, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
      const body = method !== 'GET' ? {} : path === '/api/users' ? users : sectors;
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  qc.setQueryData(qk.me, me);
  qc.setQueryData(qk.users, users);
  qc.setQueryData(qk.sectors, sectors);
  render(
    <QueryClientProvider client={qc}>
      <UsersSettings />
    </QueryClientProvider>,
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const row = (name: string) => screen.getByText(name).closest('li')!;
const openMenu = (name: string) => fireEvent.click(screen.getByRole('button', { name: `Opções do atendente ${name}` }));

describe('Settings › Atendentes', () => {
  it('lists each person with e-mail and sectors, role and Inativo badges; nobody can deactivate themselves', () => {
    expect(within(row('Ana Financeiro')).getByText('ana@teste.local · Financeiro')).toBeTruthy();
    expect(within(row('Ana Financeiro')).getByText('Atendente')).toBeTruthy();
    expect(within(row('Admin Teste')).getByText('Administrador')).toBeTruthy();
    expect(within(row('Carlos Inativo')).getByText('Inativo')).toBeTruthy();
    expect(within(row('Ana Financeiro')).queryByText('Inativo')).toBeNull();

    openMenu('Admin Teste');
    expect(within(row('Admin Teste')).getByRole('button', { name: 'Editar' })).toBeTruthy();
    expect(within(row('Admin Teste')).queryByRole('button', { name: 'Desativar' })).toBeNull();
  });

  it('asks before deactivating and reactivates without asking', async () => {
    vi.mocked(confirmDialog).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    openMenu('Ana Financeiro');
    fireEvent.click(screen.getByRole('button', { name: 'Desativar' }));
    await waitFor(() => expect(confirmDialog).toHaveBeenCalledTimes(1));
    expect(mutations()).toHaveLength(0);

    openMenu('Ana Financeiro');
    fireEvent.click(screen.getByRole('button', { name: 'Desativar' }));
    await waitFor(() => expect(mutations()).toEqual([{ method: 'PATCH', path: '/api/users/u-ana', body: { active: false } }]));

    openMenu('Carlos Inativo');
    fireEvent.click(screen.getByRole('button', { name: 'Reativar' }));
    await waitFor(() => expect(mutations()).toHaveLength(2));
    expect(mutations()[1]).toEqual({ method: 'PATCH', path: '/api/users/u-old', body: { active: true } });
    expect(confirmDialog).toHaveBeenCalledTimes(2);
  });

  it('edits a person in a dialog and sends the same body as before', async () => {
    openMenu('Ana Financeiro');
    fireEvent.click(screen.getByRole('button', { name: 'Editar' }));
    const dialog = screen.getByRole('dialog', { name: 'Editar atendente' });
    fireEvent.change(within(dialog).getByLabelText('Nome'), { target: { value: ' Ana Souza ' } });
    fireEvent.change(within(dialog).getByLabelText('E-mail'), { target: { value: 'ANA@teste.local' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    await waitFor(() => expect(mutations()).toHaveLength(1));
    expect(mutations()[0]).toEqual({
      method: 'PATCH',
      path: '/api/users/u-ana',
      body: { name: 'Ana Souza', email: 'ana@teste.local', role: 'agent', signature: null, sectorIds: ['s-fin'] },
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
