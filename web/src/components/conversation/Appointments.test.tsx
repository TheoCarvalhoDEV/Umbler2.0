// @vitest-environment jsdom
// Review Focus 2: the form must read the time as Cuiabá time whatever the host zone. Set before anything reads the zone.
process.env.TZ = 'Asia/Tokyo';

import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { DEFAULT_APPOINTMENT_REMINDERS, type AppointmentDto } from '@talk/shared';
import { confirmDialog } from '../../lib/confirm';
import { AppointmentDialog, ChatAppointmentsDialog } from './Appointments';

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
      const path = `${url.pathname}${url.search}`;
      calls.push({ method, path, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
      const key = `${method} ${path}`;
      if (!(key in routes)) return new Response(JSON.stringify({ error: 'inesperado' }), { status: 500 });
      return new Response(JSON.stringify(routes[key]), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
}

const appointment = (over: Partial<AppointmentDto> = {}): AppointmentDto => ({
  id: 'a1', chatId: 'c1', contact: { id: 'k1', name: 'Maria Cliente', phone: '5565999999999' }, authorId: 'u1', authorName: 'Ana Lima',
  title: 'Audiência', startsAt: '2026-10-21T18:00:00.000Z', note: 'Levar RG', canceledAt: null, canceledByName: null,
  createdAt: '2026-10-20T12:00:00.000Z', canEdit: true,
  reminders: [
    { id: 'r1', amount: 2, unit: 'days', text: 'Olá', sendAt: '2026-10-19T18:00:00.000Z', status: 'skipped', scheduledId: null, error: null },
    { id: 'r2', amount: 1, unit: 'hours', text: 'Olá', sendAt: '2026-10-21T17:00:00.000Z', status: 'pending', scheduledId: 's2', error: null },
  ],
  ...over,
});
const CHAT = { id: 'c1', contact: { id: 'k1', name: 'Maria Cliente', phone: '5565999999999', avatarUrl: null } };

function renderUi(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

const when = () => screen.getByLabelText('Data e hora (horário de Cuiabá)') as HTMLInputElement;
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
const alertText = () => screen.getByRole('alert').textContent;

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

describe('AppointmentDialog (spec 2026-10-21 compromissos §3.1–3.3)', () => {
  it('starts with the default reminders, reads the time as Cuiabá time, warns live and previews the text (Review Focus 2)', async () => {
    stubFetch({ 'GET /api/settings/appointment-reminders': DEFAULT_APPOINTMENT_REMINDERS, 'POST /api/appointments': appointment() });
    const onClose = vi.fn();
    renderUi(<AppointmentDialog chatId="c1" contactName="Maria Cliente" onClose={onClose} />);
    const first = await screen.findByRole('group', { name: 'Lembrete 1' });
    const second = screen.getByRole('group', { name: 'Lembrete 2' });
    expect((within(first).getByLabelText('Texto do lembrete') as HTMLTextAreaElement).value).toBe(DEFAULT_APPOINTMENT_REMINDERS.reminders[0]!.text);
    expect((within(first).getByLabelText('Antecedência') as HTMLSelectElement).options).toHaveLength(30); // 1–30 days
    expect((within(second).getByLabelText('Antecedência') as HTMLSelectElement).options).toHaveLength(48); // 1–48 hours
    expect(within(second).getByText('Marcadores: {nome}, {titulo}, {data}, {hora}')).toBeTruthy();
    expect(screen.queryByLabelText('Cliente')).toBeNull();
    // the host clock reads 21:00, so a form that used the host zone would offer 21:00 here
    expect(when().min).toBe('2026-10-20T08:00');

    fireEvent.change(screen.getByLabelText('Título'), { target: { value: 'Audiência' } });
    // 21/10 14:00 in Cuiabá: "2 dias antes" (19/10 14:00) already passed
    fireEvent.change(when(), { target: { value: '2026-10-21T14:00' } });
    expect(within(first).getByText('Não será enviado: o horário de envio já passou')).toBeTruthy();
    expect(within(second).queryByText('Não será enviado: o horário de envio já passou')).toBeNull();
    expect(
      within(second).getByText('Vai sair assim: Olá, Maria Cliente! Seu compromisso (Audiência) é às 14:00 de 21/10/2026 (horário de Cuiabá).'),
    ).toBeTruthy();

    const signature = screen.getByLabelText('Enviar com minha assinatura') as HTMLInputElement;
    expect(signature.checked).toBe(true);
    fireEvent.click(signature);
    save();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      chatId: 'c1', title: 'Audiência', startsAt: '2026-10-21T18:00:00.000Z', signature: false, reminders: DEFAULT_APPOINTMENT_REMINDERS.reminders,
    });
  });

  it('says what is missing: title, time, a past time, {nome} without a name, an unknown placeholder, two reminders at once, none', async () => {
    stubFetch({ 'GET /api/settings/appointment-reminders': DEFAULT_APPOINTMENT_REMINDERS });
    renderUi(<AppointmentDialog chatId="c1" contactName={null} onClose={() => {}} />);
    await screen.findByRole('group', { name: 'Lembrete 1' });
    save();
    expect(alertText()).toBe('Digite o título');
    fireEvent.change(screen.getByLabelText('Título'), { target: { value: 'Audiência' } });
    save();
    expect(alertText()).toBe('Escolha a data e a hora');
    fireEvent.change(when(), { target: { value: '2026-10-20T08:00' } });
    save();
    expect(alertText()).toBe('Este horário já passou; escolha uma data e hora futuras');
    fireEvent.change(when(), { target: { value: '2026-10-25T14:00' } });
    save();
    expect(alertText()).toBe('O contato não tem nome cadastrado; tire {nome} do lembrete'); // the defaults greet {nome}

    const [first, second] = screen.getAllByRole('group');
    fireEvent.change(within(first!).getByLabelText('Texto do lembrete'), { target: { value: 'Oi, {Nome}!' } });
    expect(within(first!).getByText('Marcador desconhecido: {Nome}. Use {nome}, {titulo}, {data} ou {hora}')).toBeTruthy(); // live
    fireEvent.change(within(first!).getByLabelText('Texto do lembrete'), { target: { value: 'Faltam dois dias.' } });
    fireEvent.change(within(second!).getByLabelText('Texto do lembrete'), { target: { value: 'Hoje às {hora}.' } });
    fireEvent.change(within(second!).getByLabelText('Antecedência'), { target: { value: '48' } }); // 48 hours = 2 days
    save();
    expect(alertText()).toBe('Dois lembretes cairiam no mesmo horário');

    fireEvent.click(within(second!).getByRole('button', { name: 'Remover' }));
    fireEvent.click(within(first!).getByRole('button', { name: 'Remover' }));
    save();
    expect(alertText()).toBe('Inclua pelo menos um lembrete');
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar lembrete' }));
    save();
    expect(alertText()).toBe('Digite o texto do lembrete');
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('from the Agenda: "Cliente" searches contacts from 2 letters and sends the contactId', async () => {
    stubFetch({
      'GET /api/settings/appointment-reminders': { reminders: [{ amount: 1, unit: 'hours', text: 'Olá, {nome}!' }] },
      'GET /api/contacts?q=Ma&limit=8': { items: [{ id: 'k1', name: 'Maria Cliente', phone: '5565999999999' }], nextCursor: null },
      'POST /api/appointments': appointment(),
    });
    const onClose = vi.fn();
    renderUi(<AppointmentDialog onClose={onClose} />);
    const client = await screen.findByLabelText('Cliente');
    expect(client.getAttribute('placeholder')).toBe('Nome ou telefone');
    expect(screen.queryByText(/Vai sair assim/)).toBeNull(); // no client yet: nothing to fill {nome} with
    fireEvent.change(client, { target: { value: 'M' } });
    fireEvent.change(screen.getByLabelText('Título'), { target: { value: 'Retorno de documento' } });
    fireEvent.change(when(), { target: { value: '2026-10-25T14:00' } });
    save();
    expect(alertText()).toBe('Escolha o cliente');

    fireEvent.change(client, { target: { value: 'Ma' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Maria Cliente · +55 65 99999-9999' }));
    save();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({
      contactId: 'k1', title: 'Retorno de documento', startsAt: '2026-10-25T18:00:00.000Z', signature: true,
    });
    expect(calls.some((c) => c.path === '/api/contacts?q=M&limit=8')).toBe(false); // one letter: no search
  });

  it('edits title, time and note only, shows the reminders read-only, does not check a kept time again and sends only what changed', async () => {
    stubFetch({ 'PATCH /api/appointments/a1': appointment({ note: null }) });
    const onClose = vi.fn();
    // 19/10 14:00 in Cuiabá: already past now
    renderUi(<AppointmentDialog appointment={appointment({ startsAt: '2026-10-19T18:00:00.000Z' })} onClose={onClose} />);
    expect(screen.getByRole('dialog', { name: 'Editar compromisso' })).toBeTruthy();
    expect(when().value).toBe('2026-10-19T14:00');
    expect(screen.getByText('2 dias antes')).toBeTruthy();
    expect(screen.getByText('Não criado: o horário de envio já tinha passado')).toBeTruthy();
    expect(screen.getByText('1 hora antes')).toBeTruthy();
    expect(screen.getByText('Pendente · 21/10/2026 13:00')).toBeTruthy();
    expect(screen.queryByLabelText('Texto do lembrete')).toBeNull();
    expect(screen.queryByLabelText('Enviar com minha assinatura')).toBeNull();

    fireEvent.change(screen.getByLabelText('Observação interna (não é enviada ao cliente)'), { target: { value: '' } });
    save();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([['PATCH', '/api/appointments/a1', { note: null }]]);
  });
});

describe('AppointmentDialog defaults error', () => {
  it('offers Fechar when the default reminders fail to load', async () => {
    stubFetch({});
    const onClose = vi.fn();
    renderUi(<AppointmentDialog chatId="c1" contactName="Maria Cliente" onClose={onClose} />);
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('ChatAppointmentsDialog (spec §3.4)', () => {
  it('lists the contact’s upcoming appointments, with Editar/Cancelar only where allowed, and cancels after confirming', async () => {
    stubFetch({
      'GET /api/chats/c1/appointments': [appointment(), appointment({ id: 'a2', title: 'Perícia', authorName: 'Bruno', note: null, canEdit: false })],
      'POST /api/appointments/a1/cancel': appointment({ canceledAt: '2026-10-20T12:00:00.000Z', canEdit: false }),
    });
    renderUi(<ChatAppointmentsDialog chat={CHAT} onClose={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: 'Compromissos de Maria Cliente' });
    expect(await within(dialog).findByText('Perícia')).toBeTruthy();
    expect(within(dialog).getByText('por Bruno')).toBeTruthy();
    expect(within(dialog).getByText('Observação interna')).toBeTruthy();
    expect(within(dialog).getByText('Levar RG')).toBeTruthy();
    expect(within(dialog).getAllByRole('button', { name: 'Editar' })).toHaveLength(1);
    expect(within(dialog).getByRole('link', { name: 'Ver todos os compromissos' }).getAttribute('href')).toBe('/agendamentos?aba=compromissos');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/appointments/a1/cancel')).toBe(true));
    expect(confirmDialog).toHaveBeenCalledWith({
      title: 'Cancelar o compromisso?', body: 'Os lembretes que ainda não saíram não serão enviados.',
      confirmLabel: 'Cancelar compromisso', cancelLabel: 'Manter compromisso',
    });
  });

  it('says so when there is none, and "Novo compromisso" opens the form for this chat', async () => {
    stubFetch({ 'GET /api/chats/c1/appointments': [], 'GET /api/settings/appointment-reminders': DEFAULT_APPOINTMENT_REMINDERS });
    renderUi(<ChatAppointmentsDialog chat={CHAT} onClose={() => {}} />);
    expect(await screen.findByText('Nenhum compromisso marcado com este cliente.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Novo compromisso' }));
    expect(await screen.findByRole('dialog', { name: 'Novo compromisso' })).toBeTruthy();
    expect(await screen.findByRole('group', { name: 'Lembrete 1' })).toBeTruthy();
  });

  it('Esc (a cancelable cancel event) on the inner form closes only it; "Compromissos de …" stays open', async () => {
    stubFetch({ 'GET /api/chats/c1/appointments': [], 'GET /api/settings/appointment-reminders': DEFAULT_APPOINTMENT_REMINDERS });
    renderUi(<ChatAppointmentsDialog chat={CHAT} onClose={() => {}} />);
    await screen.findByText('Nenhum compromisso marcado com este cliente.');
    fireEvent.click(screen.getByRole('button', { name: 'Novo compromisso' }));
    const inner = await screen.findByRole('dialog', { name: 'Novo compromisso' });
    expect(fireEvent(inner, new Event('cancel', { bubbles: true, cancelable: true }))).toBe(false); // preventDefault was called
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Novo compromisso' })).toBeNull());
    expect(screen.getByRole('dialog', { name: 'Compromissos de Maria Cliente' })).toBeTruthy();
  });
});
