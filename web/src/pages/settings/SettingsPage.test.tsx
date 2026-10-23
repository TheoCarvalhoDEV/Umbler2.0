// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { Me } from '@talk/shared';
import { SettingsPage } from './SettingsPage';

const admin: Me = { id: 'u1', name: 'Admin Teste', email: 'admin@teste.local', role: 'admin', signature: null, sectorIds: [], seeAllSectors: false, avatarUrl: null };

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('filters the items by label, ignoring accents and case, and hides empty groups', () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['me'], admin);
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/configuracoes/perfil']}>
        <Routes>
          <Route path="/configuracoes/:section?" element={<SettingsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const nav = screen.getByRole('navigation', { name: 'Configurações' });
  expect(within(nav).getByRole('heading', { name: 'Ajustes' })).toBeTruthy();
  const search = within(nav).getByRole('searchbox', { name: 'Buscar ajuste' });

  fireEvent.change(search, { target: { value: 'PREFERENCIAS' } });
  expect(within(nav).getAllByRole('link').map((a) => a.textContent)).toEqual(['Preferências']);
  expect(within(nav).queryByText('Atendimento')).toBeNull();

  fireEvent.change(search, { target: { value: 'regras auto' } });
  expect(within(nav).getAllByRole('link').map((a) => a.textContent)).toEqual(['Regras automáticas']);

  fireEvent.change(search, { target: { value: 'compromissos' } }); // spec 2026-10-21 compromissos §4
  expect(within(nav).getAllByRole('link').map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
    ['Compromissos', '/configuracoes/compromissos'],
  ]);

  fireEvent.change(search, { target: { value: 'xyz' } });
  expect(within(nav).queryAllByRole('link')).toHaveLength(0);
  expect(within(nav).getByText('Nenhum ajuste encontrado')).toBeTruthy();
});

it('lists "Importar do Umbler" under Equipe e cadastros for admins only (spec 2026-10-21 importar-umbler §6)', () => {
  const nav = (me: Me) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['me'], me);
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/configuracoes/importar-umbler']}>
          <Routes>
            <Route path="/configuracoes/:section?" element={<SettingsPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    return screen.getByRole('navigation', { name: 'Configurações' });
  };
  expect(within(nav(admin)).getByRole('link', { name: 'Importar do Umbler' }).getAttribute('href')).toBe('/configuracoes/importar-umbler');
  cleanup();
  const agentNav = nav({ ...admin, id: 'u2', role: 'agent' });
  expect(within(agentNav).queryByRole('link', { name: 'Importar do Umbler' })).toBeNull();
  expect(within(agentNav).getByRole('link', { name: 'Perfil' }).getAttribute('aria-current')).toBe('page'); // sent back to Perfil
});
