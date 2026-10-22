// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DEFAULT_APPOINTMENT_REMINDERS, type AppointmentRemindersDto } from '@talk/shared';
import { AppointmentSettings } from './AppointmentSettings';

let saved: AppointmentRemindersDto;
const calls: Array<{ method: string; path: string; body: unknown }> = [];
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls.length = 0;
  saved = DEFAULT_APPOINTMENT_REMINDERS;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    if (path === '/api/settings/appointment-reminders' && method === 'GET') return json(saved);
    if (path === '/api/settings/appointment-reminders' && method === 'PUT') {
      // like the server: the texts come back trimmed, and the next GET answers with what was saved
      saved = { reminders: (body as AppointmentRemindersDto).reminders.map((r) => ({ ...r, text: r.text.trim() })) };
      return json(saved);
    }
    return json({ error: 'inesperado' }, 500);
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('loads the defaults, checks the rules live and saves the reminders (spec 2026-10-21 compromissos §4)', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AppointmentSettings />
    </QueryClientProvider>,
  );

  await screen.findByRole('heading', { level: 1, name: 'Compromissos' });
  expect(screen.getByText('Lembretes que já vêm preenchidos em todo compromisso novo. Cada compromisso pode mudar os seus.')).toBeTruthy();
  const second = screen.getByRole('group', { name: 'Lembrete 2' });
  expect(within(second).getByText('Vai sair assim: Olá, Maria! Seu compromisso (Audiência) é às 14:00 de 10/11/2026 (horário de Cuiabá).')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Salvar' })).toBeNull(); // nothing changed yet

  fireEvent.change(within(second).getByLabelText('Texto do lembrete'), { target: { value: 'Oi, {Nome}!' } });
  expect(screen.getAllByText('Marcador desconhecido: {Nome}. Use {nome}, {titulo}, {data} ou {hora}').length).toBeGreaterThan(0);
  expect((screen.getByRole('button', { name: 'Salvar' }) as HTMLButtonElement).disabled).toBe(true);

  fireEvent.change(within(second).getByLabelText('Texto do lembrete'), { target: { value: '  Hoje às {hora}, {nome}.  ' } });
  fireEvent.change(within(second).getByLabelText('Antecedência'), { target: { value: '3' } });
  fireEvent.click(screen.getByRole('button', { name: 'Adicionar lembrete' }));
  const third = screen.getByRole('group', { name: 'Lembrete 3' });
  fireEvent.change(within(third).getByLabelText('Antecedência'), { target: { value: '7' } });
  fireEvent.change(within(third).getByLabelText('Texto do lembrete'), { target: { value: 'Falta uma semana: {titulo}.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

  await screen.findByText('Lembretes salvos.');
  expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
    reminders: [
      DEFAULT_APPOINTMENT_REMINDERS.reminders[0],
      { amount: 3, unit: 'hours', text: '  Hoje às {hora}, {nome}.  ' },
      { amount: 7, unit: 'days', text: 'Falta uma semana: {titulo}.' },
    ],
  });
});
