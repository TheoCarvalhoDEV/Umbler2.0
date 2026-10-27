// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SettingsDto } from '@talk/shared';
import { ChatSettings } from './ChatSettings';

const initial: SettingsDto = {
  closingMessage: 'Obrigado pelo contato!',
  triageMenu: { enabled: false, welcomeText: '', invalidText: '', options: [] },
  botRunningBehavior: 'ask',
  returningContact: { enabled: true, days: 90 },
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
    if (path === '/api/settings' && method === 'GET') return json(settings);
    if (path === '/api/settings' && method === 'PUT') {
      settings = body as SettingsDto; // like the server: the next GET answers with what was saved
      return json(settings);
    }
    return json({ error: 'inesperado' }, 500);
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderChatSettings() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ChatSettings />
    </QueryClientProvider>,
  );
}

it('starts with the page header and no save bar', async () => {
  renderChatSettings();
  await screen.findByRole('heading', { level: 1, name: 'Conversas' });
  expect(screen.queryByRole('button', { name: 'Salvar' })).toBeNull();
});

it('saves the bot running behavior together with the closing message', async () => {
  renderChatSettings();

  const select = (await screen.findByLabelText('Quando o atendente enviar mensagem com chatbot em execução')) as HTMLSelectElement;
  expect(select.value).toBe('ask');
  expect([...select.options].map((o) => o.text)).toEqual(['Perguntar', 'Parar o bot', 'Manter rodando']);

  fireEvent.change(select, { target: { value: 'stop' } });
  fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

  await screen.findByText('Alterações salvas.');
  expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ ...initial, botRunningBehavior: 'stop' });
});

it('Descartar puts the fields back and hides the save bar', async () => {
  renderChatSettings();

  const text = (await screen.findByLabelText('Mensagem de encerramento')) as HTMLTextAreaElement;
  fireEvent.change(text, { target: { value: 'Outra mensagem' } });
  fireEvent.click(screen.getByRole('button', { name: 'Descartar' }));

  expect(text.value).toBe('Obrigado pelo contato!');
  expect(screen.queryByRole('button', { name: 'Salvar' })).toBeNull();
  expect(calls.some((c) => c.method === 'PUT')).toBe(false);
});

it('"Cliente que volta": turns the rule off and changes the days, saved with the other settings', async () => {
  renderChatSettings();

  const rule = await screen.findByRole('switch', { name: 'Cliente que volta vai direto para o último atendimento' });
  expect(rule.getAttribute('aria-checked')).toBe('true');
  const days = screen.getByLabelText('Até quantos dias depois de finalizada') as HTMLInputElement;
  expect(days.value).toBe('90');

  fireEvent.change(days, { target: { value: '30' } });
  fireEvent.click(rule);
  expect(days.disabled).toBe(true); // the days only matter while the rule is on
  fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

  await screen.findByText('Alterações salvas.');
  expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ ...initial, returningContact: { enabled: false, days: 30 } });
});
