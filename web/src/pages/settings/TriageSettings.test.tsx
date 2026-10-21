// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SectorDto, SettingsDto } from '@talk/shared';
import { TriageSettings } from './TriageSettings';

const sectors: SectorDto[] = [
  { id: 's-fin', name: 'Financeiro', position: 0, isDefault: true },
  { id: 's-jur', name: 'Jurídico', position: 1, isDefault: false },
];
const initial: SettingsDto = {
  closingMessage: '',
  triageMenu: {
    enabled: true,
    welcomeText: 'Olá! Escolha uma opção:',
    invalidText: 'Não entendi.',
    options: [{ key: '1', label: 'Boletos', sectorId: 's-fin' }],
  },
  botRunningBehavior: 'ask',
};
let settings: SettingsDto;
const calls: Array<{ method: string; path: string; body: unknown }> = [];
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls.length = 0;
  settings = initial;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    if (path === '/api/sectors') return json(sectors);
    if (path === '/api/settings' && method === 'GET') return json(settings);
    if (path === '/api/settings' && method === 'PUT') {
      const m = (body as SettingsDto).triageMenu; // like the server: welcomeText/invalidText are stored trimmed, and the next GET answers with what was saved
      settings = { ...(body as SettingsDto), triageMenu: { ...m, welcomeText: m.welcomeText.trim(), invalidText: m.invalidText.trim() } };
      return json(settings);
    }
    return json({ error: 'inesperado' }, 500);
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderTriage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TriageSettings />
    </QueryClientProvider>,
  );
}

it('starts with the page header, the menu switch and the preview, and no save bar', async () => {
  renderTriage();
  await screen.findByRole('heading', { level: 1, name: 'Triagem' });
  expect(screen.getByRole('switch', { name: 'Enviar menu de triagem quando um contato começa uma conversa' }).getAttribute('aria-checked')).toBe('true');
  expect((screen.getByLabelText('Mensagem de boas-vindas') as HTMLTextAreaElement).value).toBe('Olá! Escolha uma opção:');
  expect((screen.getByLabelText('Mensagem para resposta inválida') as HTMLTextAreaElement).value).toBe('Não entendi.');
  expect(screen.getByText(/Olá! Escolha uma opção:\s+1 - Boletos/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Salvar' })).toBeNull();
});

it('saves the menu with the option texts trimmed, then says it was saved', async () => {
  renderTriage();
  const text = await screen.findByLabelText('Texto da opção 1');

  fireEvent.change(text, { target: { value: '  2ª via de boleto  ' } });
  fireEvent.click(screen.getByRole('switch', { name: 'Enviar menu de triagem quando um contato começa uma conversa' }));
  fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

  await screen.findByText('Alterações salvas.');
  expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
    ...initial,
    triageMenu: { ...initial.triageMenu, enabled: false, options: [{ key: '1', label: '2ª via de boleto', sectorId: 's-fin' }] },
  });
});

it('blocks Salvar and says why while the menu is incomplete; Descartar undoes the edit', async () => {
  renderTriage();
  fireEvent.click(await screen.findByRole('button', { name: 'Adicionar opção' }));

  expect(screen.getByRole('alert').textContent).toBe('Preencha número, texto e setor de cada opção.');
  expect((screen.getByRole('button', { name: 'Salvar' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
  expect(calls.some((c) => c.method === 'PUT')).toBe(false);

  fireEvent.click(screen.getByRole('button', { name: 'Descartar' }));
  expect(screen.getAllByLabelText(/^Texto da opção/)).toHaveLength(1);
  expect(screen.queryByRole('button', { name: 'Salvar' })).toBeNull();
});

it('confirms the save when the texts have trailing whitespace the server trims', async () => {
  renderTriage();
  const welcome = await screen.findByLabelText('Mensagem de boas-vindas');

  fireEvent.change(welcome, { target: { value: 'Olá! Escolha o setor:\n ' } });
  fireEvent.change(screen.getByLabelText('Mensagem para resposta inválida'), { target: { value: 'Tente de novo. ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

  await screen.findByText('Alterações salvas.');
  expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ ...initial, triageMenu: { ...initial.triageMenu, welcomeText: 'Olá! Escolha o setor:', invalidText: 'Tente de novo.' } });
  expect(screen.queryByRole('button', { name: 'Salvar' })).toBeNull();
  expect(screen.queryByText('Alterações não salvas.')).toBeNull();
});
