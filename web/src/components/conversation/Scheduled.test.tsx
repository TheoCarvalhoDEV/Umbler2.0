// @vitest-environment jsdom
// Review Focus 5: the dialog must not read the host zone. Set before anything reads the zone.
process.env.TZ = 'Asia/Tokyo';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type { ScheduledMessageDto } from '@talk/shared';
import { confirmDialog } from '../../lib/confirm';
import { ScheduleDialog, ScheduledStrip } from './Scheduled';

vi.mock('../../lib/confirm', () => ({ confirmDialog: vi.fn(async () => true) }));

// jsdom has no modal <dialog> API; the browser opens ChatDialogs' Modal with showModal()
HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
  this.setAttribute('open', '');
};

type Call = { method: string; path: string; body: unknown };
const calls: Call[] = [];

function stubFetch(routes: Record<string, unknown>) {
  calls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init?.method ?? 'GET';
      calls.push({ method, path: url.pathname, body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body });
      const key = `${method} ${url.pathname}`;
      if (!(key in routes)) return new Response(JSON.stringify({ error: 'inesperado' }), { status: 500 });
      return new Response(JSON.stringify(routes[key]), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
}

function item(over: Partial<ScheduledMessageDto> = {}): ScheduledMessageDto {
  return {
    id: 's1', chatId: 'c1', contact: { id: 'k1', name: 'Maria Cliente', phone: '5565999999999' }, authorId: 'u1', authorName: 'Ana Lima',
    body: 'Lembrete: audiência amanhã às 9h', signature: false, attachment: null, sendAt: '2026-10-21T12:00:00.000Z', status: 'pending',
    error: null, messageId: null, sentChatId: null, createdAt: '2026-10-20T12:00:00.000Z', finishedAt: null, canEdit: true, ...over,
  };
}

function renderStrip() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ScheduledStrip chatId="c1" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-20T12:00:00.000Z')); // 08:00 in Cuiabá, 21:00 in Tokyo (the host here)
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.mocked(confirmDialog).mockClear();
});

describe('ScheduleDialog (spec 2026-10-20 agendamentos §3.1)', () => {
  it('reads the time as Cuiabá time, refuses less than 2 minutes ahead and hands back an ISO instant (Review Focus 5)', async () => {
    // the host clock reads 21:00, so a dialog that used the host zone would show 21:02 and send 12:30Z
    expect(new Date().getHours()).toBe(21);
    const onConfirm = vi.fn(async () => {});
    render(<ScheduleDialog title="Agendar mensagem" confirmLabel="Agendar" initialText="Lembrete" onCancel={() => {}} onConfirm={onConfirm} />);
    const when = screen.getByLabelText('Data e hora (horário de Cuiabá)') as HTMLInputElement;
    expect(when.min).toBe('2026-10-20T08:02');

    fireEvent.click(screen.getByRole('button', { name: 'Agendar' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Escolha a data e a hora');
    fireEvent.change(when, { target: { value: '2026-10-20T08:01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Agendar' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Escolha um horário pelo menos 2 minutos à frente'));
    fireEvent.change(screen.getByLabelText('Texto da mensagem'), { target: { value: '   ' } });
    fireEvent.change(when, { target: { value: '2026-10-20T09:30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Agendar' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Digite a mensagem'));

    fireEvent.change(screen.getByLabelText('Texto da mensagem'), { target: { value: ' Lembrete ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Agendar' }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith('Lembrete', '2026-10-20T13:30:00.000Z'));
  });

  it('an edit that keeps the time sends only the text, even when that time is now under 2 minutes away', async () => {
    const onConfirm = vi.fn(async () => {});
    render(
      <ScheduleDialog
        title="Editar agendamento" confirmLabel="Salvar" initialText="Lembrete" initialSendAt="2026-10-20T12:01:00.000Z"
        fileName="peticao.pdf" onCancel={() => {}} onConfirm={onConfirm}
      />,
    );
    expect(screen.getByText('Anexo: peticao.pdf')).toBeTruthy();
    expect((screen.getByLabelText('Data e hora (horário de Cuiabá)') as HTMLInputElement).value).toBe('2026-10-20T08:01');
    fireEvent.change(screen.getByLabelText('Texto da mensagem'), { target: { value: 'Lembrete corrigido' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith('Lembrete corrigido', undefined));
  });
});

describe('ScheduledStrip (spec §3.2)', () => {
  it('shows the count and, opened, Editar/Cancelar only where the user may change it', async () => {
    stubFetch({
      'GET /api/chats/c1/scheduled-messages': [
        item(),
        item({ id: 's2', authorName: 'Bruno', canEdit: false, attachment: { name: 'a.pdf', mime: 'application/pdf', size: 3 } }),
      ],
    });
    renderStrip();
    fireEvent.click(await screen.findByRole('button', { name: '2 mensagens agendadas' }));
    expect(screen.getAllByText('21/10/2026 08:00')).toHaveLength(2);
    expect(screen.getByText('por Bruno', { exact: false })).toBeTruthy();
    expect(screen.getByText('Anexo')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Editar' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Cancelar' })).toHaveLength(1);
  });

  it('shows nothing without pending messages', async () => {
    stubFetch({ 'GET /api/chats/c1/scheduled-messages': [] });
    renderStrip();
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('marks an appointment reminder "Lembrete · <título>" in place of Editar/Cancelar (spec 2026-10-21 compromissos §3.7)', async () => {
    stubFetch({ 'GET /api/chats/c1/scheduled-messages': [item({ canEdit: false, appointment: { id: 'a1', title: 'Audiência' } })] });
    renderStrip();
    fireEvent.click(await screen.findByRole('button', { name: '1 mensagem agendada' }));
    expect(screen.getByRole('link', { name: 'Lembrete · Audiência' }).getAttribute('href')).toBe('/agendamentos?aba=compromissos');
    expect(screen.queryByRole('button', { name: 'Editar' })).toBeNull();
  });

  it('cancels after confirming', async () => {
    stubFetch({
      'GET /api/chats/c1/scheduled-messages': [item()],
      'POST /api/scheduled-messages/s1/cancel': item({ status: 'canceled', canEdit: false }),
    });
    renderStrip();
    fireEvent.click(await screen.findByRole('button', { name: '1 mensagem agendada' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/scheduled-messages/s1/cancel')).toBe(true));
    expect(confirmDialog).toHaveBeenCalledWith({
      title: 'Cancelar a mensagem agendada?', confirmLabel: 'Cancelar agendamento', cancelLabel: 'Manter agendamento',
    });
  });

  it('edits through the dialog with PATCH', async () => {
    stubFetch({
      'GET /api/chats/c1/scheduled-messages': [item()],
      'PATCH /api/scheduled-messages/s1': item({ body: 'Novo texto' }),
    });
    renderStrip();
    fireEvent.click(await screen.findByRole('button', { name: '1 mensagem agendada' }));
    fireEvent.click(screen.getByRole('button', { name: 'Editar' }));
    fireEvent.change(screen.getByLabelText('Texto da mensagem'), { target: { value: 'Novo texto' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ text: 'Novo texto' }));
  });
});
