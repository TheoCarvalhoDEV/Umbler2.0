// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { DEFAULT_APPOINTMENT_REMINDERS, type AppointmentDto, type ScheduledMessageDto } from '@talk/shared';
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

function renderPage(entry = '/agendamentos') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('opens the tab named in the URL and shows why a message failed, linking to its chat (spec 2026-10-20 agendamentos §3.2)', async () => {
  stubFetch({
    'GET /api/scheduled-messages?status=failed': [
      item({ status: 'failed', error: 'Não enviada: o autor do agendamento está desativado', canEdit: false }),
    ],
  });
  renderPage('/agendamentos?status=failed');
  expect(await screen.findByText('Não enviada: o autor do agendamento está desativado')).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Falharam' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.getByRole('link', { name: 'Maria Cliente' }).getAttribute('href')).toBe('/chats/c1');
  expect(screen.getByText('Falhou')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Editar' })).toBeNull();
});

it('defaults to Pendentes, links a sent message to the chat it went to, and switches tab', async () => {
  stubFetch({
    'GET /api/scheduled-messages?status=pending': [item()],
    'GET /api/scheduled-messages?status=sent': [item({ id: 's2', status: 'sent', sentChatId: 'c9', canEdit: false })],
    'GET /api/scheduled-messages?status=canceled': [],
  });
  renderPage();
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
  stubFetch({ 'GET /api/appointments?tab=past': [], 'GET /api/settings/appointment-reminders': DEFAULT_APPOINTMENT_REMINDERS });
  renderPage('/agendamentos?aba=compromissos&situacao=past');
  expect(await screen.findByText('Nenhum compromisso aqui.')).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Passados' }).getAttribute('aria-selected')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: 'Novo compromisso' }));
  expect(await screen.findByLabelText('Cliente')).toBeTruthy();
});
