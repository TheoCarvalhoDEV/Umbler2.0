// @vitest-environment jsdom
process.env.TZ = 'Asia/Tokyo';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { DEFAULT_APPOINTMENT_REMINDERS, type AppointmentDto, type Me, type ScheduledMessageDto } from '@talk/shared';
import { ScheduledMessagesPage } from './ScheduledMessages';

// jsdom has no modal <dialog> API; the browser opens ChatDialogs' Modal with showModal()
HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
  this.setAttribute('open', '');
};

const appointment = (over: Partial<AppointmentDto> = {}): AppointmentDto => ({
  id: 'a1', chatId: 'c1', contact: { id: 'k1', name: 'Maria Cliente', phone: '5565999999999' }, authorId: 'u1', authorName: 'Ana Lima',
  title: 'Audiência', startsAt: '2026-10-21T18:00:00.000Z', note: null, canceledAt: null, canceledByName: null,
  createdAt: '2026-10-20T12:00:00.000Z', canEdit: true, status: 'scheduled', canMark: true,
  reminders: [{ id: 'r1', amount: 1, unit: 'hours', text: 'Olá', sendAt: '2026-10-21T17:00:00.000Z', status: 'pending', scheduledId: 's1', error: null }],
  ...over,
});

function stubFetch(routes: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const key = `${init?.method ?? 'GET'} ${url.pathname}${url.search}`;
      if (!(key in routes)) return new Response(JSON.stringify({ error: 'inesperado' }), { status: 500 });
      return new Response(JSON.stringify(routes[key]), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
}

const item = (over: Partial<ScheduledMessageDto> = {}): ScheduledMessageDto => ({
  id: 's1', chatId: 'c1', contact: { id: 'k1', name: 'Maria Cliente', phone: '5565999999999' }, authorId: 'u1', authorName: 'Ana Lima',
  body: 'Lembrete: audiência amanhã às 9h', signature: false, attachment: null, sendAt: '2026-10-21T12:00:00.000Z', status: 'pending',
  error: null, messageId: null, sentChatId: null, createdAt: '2026-10-20T12:00:00.000Z', finishedAt: null, canEdit: true, ...over,
});

const agentMe: Me = { id: 'u1', name: 'Ana', email: 'ana@exemplo.com.br', role: 'agent', signature: null, sectorIds: ['s1'], seeAllSectors: false, avatarUrl: null };
const adminMe: Me = { ...agentMe, id: 'adm', name: 'Admin', email: 'adm@exemplo.com.br', role: 'admin' };

function renderPage(entry = '/agendamentos', me: Me = agentMe) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['me'], me);
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/agendamentos" element={<ScheduledMessagesPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const keys = () =>
  vi.mocked(fetch).mock.calls.map(([input, init]) => {
    const u = new URL(String(input), 'http://localhost');
    return `${init?.method ?? 'GET'} ${u.pathname}${u.search}`;
  });
const summary = { today: 2, tomorrow: 0, toConfirm: 1, toMark: 3 };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-20T12:00:00.000Z')); // 08:00 in Cuiabá
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('opens the tab named in the URL and shows why a message failed, linking to its chat (spec 2026-10-20 agendamentos §3.2)', async () => {
  stubFetch({
    'GET /api/scheduled-messages?status=failed': [
      item({ status: 'failed', error: 'Não enviada: o autor do agendamento está desativado', canEdit: false }),
    ],
  });
  renderPage('/agendamentos?aba=mensagens&status=failed');
  expect(await screen.findByText('Não enviada: o autor do agendamento está desativado')).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Falharam' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.getByRole('link', { name: 'Maria Cliente' }).getAttribute('href')).toBe('/chats/c1');
  expect(screen.getByText('Falhou')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Editar' })).toBeNull();
});

it('Mensagens defaults to Pendentes, links a sent message to the chat it went to, and switches tab', async () => {
  stubFetch({
    'GET /api/scheduled-messages?status=pending': [item()],
    'GET /api/scheduled-messages?status=sent': [item({ id: 's2', status: 'sent', sentChatId: 'c9', canEdit: false })],
    'GET /api/scheduled-messages?status=canceled': [],
  });
  renderPage('/agendamentos?aba=mensagens');
  expect(await screen.findByText('Lembrete: audiência amanhã às 9h')).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Pendentes' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.getByRole('button', { name: 'Editar' })).toBeTruthy();

  fireEvent.click(screen.getByRole('tab', { name: 'Enviadas' }));
  expect(await screen.findByText('Enviada')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Maria Cliente' }).getAttribute('href')).toBe('/chats/c9');

  fireEvent.click(screen.getByRole('tab', { name: 'Canceladas' }));
  expect(await screen.findByText('Nenhuma mensagem aqui.')).toBeTruthy();
});

it('?aba=compromissos opens Compromissos on Próximos; each tab keeps its own filter (spec 2026-10-21 compromissos §3.5)', async () => {
  stubFetch({
    'GET /api/appointments/summary': summary,
    'GET /api/appointments?tab=upcoming': [appointment()],
    'GET /api/appointments?tab=canceled': [appointment({ id: 'a2', title: 'Perícia', canceledAt: '2026-10-20T12:00:00.000Z', canEdit: false })],
    'GET /api/scheduled-messages?status=failed': [],
  });
  renderPage('/agendamentos?aba=compromissos&status=failed');
  expect(await screen.findByText('Audiência')).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Compromissos' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.getByRole('tab', { name: 'Próximos' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.getByRole('link', { name: 'Maria Cliente' }).getAttribute('href')).toBe('/chats/c1');
  expect(screen.getByText('Pendente · 21/10/2026 13:00')).toBeTruthy();

  fireEvent.click(screen.getByRole('tab', { name: 'Cancelados' }));
  expect(await screen.findByText('Cancelado')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Editar' })).toBeNull();

  fireEvent.click(screen.getByRole('tab', { name: 'Mensagens' }));
  expect(await screen.findByText('Nenhuma mensagem aqui.')).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Falharam' }).getAttribute('aria-selected')).toBe('true');
  fireEvent.click(screen.getByRole('tab', { name: 'Compromissos' }));
  expect(screen.getByRole('tab', { name: 'Cancelados' }).getAttribute('aria-selected')).toBe('true');
});

it('an empty tab says "Nenhum compromisso aqui.", and "Novo compromisso" opens the form with "Cliente"', async () => {
  stubFetch({ 'GET /api/appointments/summary': summary, 'GET /api/appointments?tab=past': [], 'GET /api/settings/appointment-reminders': DEFAULT_APPOINTMENT_REMINDERS });
  renderPage('/agendamentos?aba=compromissos&situacao=past');
  expect(await screen.findByText('Nenhum compromisso aqui.')).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Passados' }).getAttribute('aria-selected')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: 'Novo compromisso' }));
  expect(await screen.findByLabelText('Cliente')).toBeTruthy();
});

it('opens on Compromissos, listed before Mensagens (spec 2026-10-23 controle §6.1)', async () => {
  stubFetch({ 'GET /api/appointments?tab=upcoming': [appointment()], 'GET /api/appointments/summary': summary });
  renderPage();
  expect(await screen.findByText('Audiência')).toBeTruthy();
  const agenda = screen.getByRole('tablist', { name: 'Agenda' });
  expect(within(agenda).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Compromissos', 'Mensagens']);
  expect(within(agenda).getByRole('tab', { name: 'Compromissos' }).getAttribute('aria-selected')).toBe('true');
});

it('counters: the number per card, 0 muted; a click lists the preset without the period tabs, a second click clears it (§6.2)', async () => {
  stubFetch({
    'GET /api/appointments/summary': summary,
    'GET /api/appointments?tab=upcoming': [appointment()],
    'GET /api/appointments?preset=toMark': [appointment({ id: 'a2', title: 'Perícia', startsAt: '2026-10-19T18:00:00.000Z' })],
  });
  renderPage();
  const card = await screen.findByRole('button', { name: /Presença a marcar/ });
  expect(card.textContent).toContain('3');
  expect(screen.getByRole('button', { name: /Amanhã/ }).className).toContain('text-muted');
  fireEvent.click(card);
  expect(await screen.findByText('Perícia')).toBeTruthy();
  expect(card.getAttribute('aria-pressed')).toBe('true');
  expect(screen.queryByRole('tab', { name: 'Próximos' })).toBeNull();
  fireEvent.click(card);
  expect(await screen.findByText('Audiência')).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Próximos' })).toBeTruthy();
});

it('groups the list by Cuiabá day: Hoje in primary, Amanhã, then the short date (§6.4, Review Focus 3)', async () => {
  stubFetch({
    'GET /api/appointments/summary': summary,
    'GET /api/appointments?tab=upcoming': [
      appointment({ id: 'a1', startsAt: '2026-10-21T02:00:00.000Z' }), // 20/10 22:00 in Cuiabá, the 21st in Tokyo
      appointment({ id: 'a2', startsAt: '2026-10-21T13:00:00.000Z' }),
      appointment({ id: 'a3', startsAt: '2026-10-23T13:00:00.000Z' }),
    ],
  });
  renderPage();
  await screen.findAllByText('Audiência');
  const headings = screen.getAllByRole('heading', { level: 2 });
  expect(headings.map((h) => h.textContent)).toEqual(['Hoje', 'Amanhã', 'sex., 23 de out.']);
  expect(headings[0]!.className).toContain('text-primary');
});

it('filters: into both requests, active users only, Busca after 300 ms and trimmed, Limpar filtros (§6.3, Review Focus 5)', async () => {
  stubFetch({
    'GET /api/appointments/summary': summary,
    'GET /api/appointments?tab=upcoming': [],
    'GET /api/users': [
      { id: 'u2', name: 'Bruno', email: 'b@x.br', role: 'agent', signature: null, active: true, sectorIds: [], avatarUrl: null },
      { id: 'u3', name: 'Inativo', email: 'i@x.br', role: 'agent', signature: null, active: false, sectorIds: [], avatarUrl: null },
    ],
    'GET /api/sectors': [{ id: 's1', name: 'Financeiro', position: 1, isDefault: false }],
  });
  renderPage('/agendamentos', adminMe);
  await screen.findByRole('option', { name: 'Financeiro' });
  await screen.findByRole('option', { name: 'Bruno' });
  expect(screen.queryByRole('option', { name: 'Inativo' })).toBeNull();
  fireEvent.change(screen.getByLabelText('Atendente'), { target: { value: 'u2' } });
  fireEvent.change(screen.getByLabelText('Setor'), { target: { value: 's1' } });
  fireEvent.change(screen.getByLabelText('Situação'), { target: { value: 'confirmed' } });
  fireEvent.change(screen.getByPlaceholderText('Cliente, telefone ou título'), { target: { value: ' maria ' } });
  expect(keys().some((k) => k.includes('q='))).toBe(false); // debounced
  await waitFor(() => expect(keys()).toContain('GET /api/appointments?tab=upcoming&authorId=u2&sectorId=s1&status=confirmed&q=maria'));
  expect(keys()).toContain('GET /api/appointments/summary?authorId=u2&sectorId=s1&q=maria');
  fireEvent.click(screen.getByRole('button', { name: 'Limpar filtros' }));
  expect((screen.getByLabelText('Setor') as HTMLSelectElement).value).toBe('');
  expect(screen.queryByRole('button', { name: 'Limpar filtros' })).toBeNull();
});

it('an attendant has no Atendente filter; an old-style ?situacao=confirmed is the status filter (spec Review focus 5)', async () => {
  stubFetch({
    'GET /api/appointments/summary': summary,
    'GET /api/appointments?tab=upcoming&status=confirmed': [appointment({ status: 'confirmed' })],
  });
  renderPage('/agendamentos?situacao=confirmed');
  expect(await screen.findByText('Audiência')).toBeTruthy();
  expect(screen.queryByLabelText('Atendente')).toBeNull();
  expect((screen.getByLabelText('Situação') as HTMLSelectElement).value).toBe('confirmed');
});

it('?periodo=past opens Passados (the old ?situacao=past twin is the test above)', async () => {
  stubFetch({ 'GET /api/appointments/summary': summary, 'GET /api/appointments?tab=past': [] });
  renderPage('/agendamentos?periodo=past');
  expect(await screen.findByText('Nenhum compromisso aqui.')).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Passados' }).getAttribute('aria-selected')).toBe('true');
});
