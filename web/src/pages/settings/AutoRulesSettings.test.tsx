// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DEFAULT_AUTO_RULES } from '@talk/shared';
import { AutoRulesSettings } from './AutoRulesSettings';

let saved: unknown;
const calls: Array<{ method: string; path: string; body: unknown }> = [];
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls.length = 0;
  saved = DEFAULT_AUTO_RULES;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    if (path === '/api/settings/auto-rules' && method === 'GET') return json(saved);
    if (path === '/api/settings/auto-rules' && method === 'PUT') {
      saved = body; // like the server: the next GET answers with what was saved
      return json(body);
    }
    return json({ error: 'inesperado' }, 500);
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('loads both rules off and saves both with their values (spec 2026-10-20 agendamentos §4)', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AutoRulesSettings />
    </QueryClientProvider>,
  );

  await screen.findByRole('heading', { level: 1, name: 'Regras automáticas' });
  const back = screen.getByRole('switch', { name: 'Devolver à fila conversas paradas' });
  const close = screen.getByRole('switch', { name: 'Finalizar por inatividade' });
  const minutes = screen.getByLabelText('Minutos sem resposta') as HTMLInputElement;
  const hours = screen.getByLabelText('Horas sem mensagens') as HTMLInputElement;
  const closing = screen.getByRole('switch', { name: 'Enviar a mensagem de encerramento' });
  const on = (el: HTMLElement) => el.getAttribute('aria-checked') === 'true';
  expect([on(back), on(close), minutes.value, hours.value, on(closing)]).toEqual([false, false, '30', '24', true]);
  expect(screen.queryByRole('button', { name: 'Salvar' })).toBeNull();
  expect([minutes.min, minutes.max, hours.min, hours.max]).toEqual(['5', '1440', '1', '720']);

  fireEvent.click(back);
  fireEvent.change(minutes, { target: { value: '45' } });
  fireEvent.click(close);
  fireEvent.change(hours, { target: { value: '48' } });
  fireEvent.click(closing);
  fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

  await screen.findByText('Alterações salvas.');
  expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
    returnToQueue: { enabled: true, minutes: 45 },
    closeInactive: { enabled: true, hours: 48, sendClosingMessage: false },
  });
});
