// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useParams } from 'react-router';
import type { BotDto, ChannelDto, Me, SectorDto, UserDto } from '@talk/shared';
import { SettingsPage } from '../SettingsPage';

const admin: Me = { id: 'u-admin', name: 'Admin Teste', email: 'admin@teste.local', role: 'admin', signature: null, sectorIds: [], seeAllSectors: false, avatarUrl: null };
const agent: Me = { ...admin, id: 'u-agent', name: 'Ana Financeiro', role: 'agent' };
const channels: ChannelDto[] = [{ id: 'ch1', name: 'WhatsApp escritório', status: 'connected', phone: null }];
const sectors: SectorDto[] = [
  { id: 's-at', name: 'Atendimento', position: 0, isDefault: true },
  { id: 's-fin', name: 'Financeiro', position: 1, isDefault: false },
  { id: 's-jur', name: 'Jurídico', position: 2, isDefault: false },
];
const user = (over: Partial<UserDto>): UserDto => ({
  id: 'u', name: 'U', email: 'u@teste.local', role: 'agent', signature: null, active: true, sectorIds: [], avatarUrl: null, ...over,
});
const users: UserDto[] = [
  user({ id: 'u-ana', name: 'Ana Financeiro', sectorIds: ['s-fin'] }),
  user({ id: 'u-old', name: 'Carlos Inativo', sectorIds: ['s-fin'], active: false }),
];
const bot = (over: Partial<BotDto>): BotDto => ({
  id: 'b1', name: 'Fluxo do escritório', description: '', status: 'active', startChannelIds: ['ch1'], manualStart: false,
  manualTitle: '', manualUnlisted: false, publishedVersionId: 'v1', publishedVersionNumber: 1, latestVersionNumber: 2,
  runCount: 12, activeRunCount: 3, createdAt: '2026-10-10T12:00:00.000Z', updatedAt: '2026-10-14T15:30:00.000Z', ...over,
});
const office = bot({});
const draft = bot({
  id: 'b2', name: 'Cobrança', status: 'paused', startChannelIds: [], manualStart: true, publishedVersionId: null,
  publishedVersionNumber: null, latestVersionNumber: 1, runCount: 0, activeRunCount: 0,
});

interface Reply { status?: number; body?: unknown }
let routes: Record<string, Reply>;
const calls: Array<{ method: string; path: string; body: unknown }> = [];
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

beforeAll(() => {
  // jsdom has no showModal(); the dialogs only need it to open
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
});

beforeEach(() => {
  calls.length = 0;
  routes = {
    'GET /api/bots': { body: [office, draft] },
    'GET /api/channels': { body: channels },
    'GET /api/sectors': { body: sectors },
    'GET /api/users': { body: users },
  };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    const method = init?.method ?? 'GET';
    calls.push({ method, path, body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body });
    const reply = routes[`${method} ${path}`];
    if (!reply) return json({ error: 'inesperado' }, 500);
    if (reply.status === 204) return new Response(null, { status: 204 });
    return json(reply.body ?? null, reply.status ?? 200);
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function EditorStub() {
  const { id } = useParams();
  return <p>editor {id}</p>;
}

function renderAt(path: string, me: Me = admin) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(['me'], me);
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/configuracoes/chatbots/:id" element={<EditorStub />} />
          <Route path="/configuracoes/:section?" element={<SettingsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const called = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);

describe('Settings › Chatbots', () => {
  it('lists the bots with channels, status and runs, and links each one to its editor', async () => {
    renderAt('/configuracoes/chatbots');
    const officeRow = await screen.findByRole('row', { name: /Fluxo do escritório/ });
    expect(within(officeRow).getByText('WhatsApp escritório')).toBeTruthy();
    expect(within(officeRow).getByText('Ativo')).toBeTruthy();
    expect(within(officeRow).getByText('12 (3 em andamento)')).toBeTruthy();
    expect(within(officeRow).getByRole('link', { name: 'Fluxo do escritório' }).getAttribute('href')).toBe('/configuracoes/chatbots/b1');
    expect(within(officeRow).getByRole('link', { name: 'Editar' }).getAttribute('href')).toBe('/configuracoes/chatbots/b1');

    const draftRow = screen.getByRole('row', { name: /Cobrança/ });
    expect(within(draftRow).getByText('Início manual')).toBeTruthy();
    expect(within(draftRow).getByText('Rascunho')).toBeTruthy();
    expect(within(draftRow).getByText('0')).toBeTruthy();
    expect(within(draftRow).getByRole('link', { name: 'Exportar' }).getAttribute('href')).toBe('/api/bots/b2/export');

    const nav = screen.getByRole('navigation', { name: 'Configurações' });
    expect(within(nav).getByRole('link', { name: 'Chatbots' }).getAttribute('href')).toBe('/configuracoes/chatbots');
  });

  it('shows the Chatbots entry to admins only', async () => {
    renderAt('/configuracoes/chatbots', agent);
    const nav = await screen.findByRole('navigation', { name: 'Configurações' });
    expect(within(nav).queryByRole('link', { name: 'Chatbots' })).toBeNull();
    expect(called('GET', '/api/bots')).toHaveLength(0);
  });

  it('creates a bot from a name and opens the editor', async () => {
    routes['POST /api/bots'] = { body: bot({ id: 'b3', name: 'Boleto', status: 'paused', publishedVersionId: null }) };
    renderAt('/configuracoes/chatbots');
    fireEvent.click(await screen.findByRole('button', { name: 'Novo chatbot' }));
    fireEvent.change(screen.getByLabelText('Nome do chatbot'), { target: { value: ' Boleto ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Criar' }));

    await screen.findByText('editor b3');
    expect(called('POST', '/api/bots')[0]?.body).toEqual({ name: 'Boleto' });
  });

  it('pauses an active bot and only lets a published bot be activated', async () => {
    routes['POST /api/bots/b1/status'] = { body: bot({ status: 'paused' }) };
    renderAt('/configuracoes/chatbots');
    const officeRow = await screen.findByRole('row', { name: /Fluxo do escritório/ });
    const activate = within(screen.getByRole('row', { name: /Cobrança/ })).getByRole('button', { name: 'Ativar' }) as HTMLButtonElement;
    expect(activate.disabled).toBe(true);

    fireEvent.click(within(officeRow).getByRole('button', { name: 'Pausar' }));
    await waitFor(() => expect(called('POST', '/api/bots/b1/status')).toHaveLength(1));
    expect(called('POST', '/api/bots/b1/status')[0]?.body).toEqual({ status: 'paused' });
    await waitFor(() => expect(called('GET', '/api/bots')).toHaveLength(2)); // list refetched
  });

  it('duplicates a bot and refreshes the list', async () => {
    routes['POST /api/bots/b1/duplicate'] = { body: bot({ id: 'b4', name: 'Fluxo do escritório (cópia)' }) };
    renderAt('/configuracoes/chatbots');
    fireEvent.click(within(await screen.findByRole('row', { name: /Fluxo do escritório/ })).getByRole('button', { name: 'Duplicar' }));
    await waitFor(() => expect(called('POST', '/api/bots/b1/duplicate')).toHaveLength(1));
    await waitFor(() => expect(called('GET', '/api/bots')).toHaveLength(2));
  });

  it('asks before deleting and shows which flows still call the bot', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    routes['DELETE /api/bots/b2'] = {
      status: 409,
      body: {
        error: 'Este chatbot é acionado por outros fluxos',
        usedBy: [{ id: 'b1', name: 'Fluxo do escritório' }, { id: 'b7', name: 'Retorno' }],
      },
    };
    renderAt('/configuracoes/chatbots');
    fireEvent.click(within(await screen.findByRole('row', { name: /Cobrança/ })).getByRole('button', { name: 'Excluir' }));

    const alert = await screen.findByRole('alert');
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('"Cobrança"'));
    expect(alert.textContent).toContain('Este chatbot é acionado por outros fluxos');
    expect(alert.textContent).toContain('Usado por: Fluxo do escritório, Retorno');
  });

  it('does not delete when the confirmation is refused', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderAt('/configuracoes/chatbots');
    fireEvent.click(within(await screen.findByRole('row', { name: /Cobrança/ })).getByRole('button', { name: 'Excluir' }));
    expect(called('DELETE', '/api/bots/b2')).toHaveLength(0);
  });

  it('imports an exported file and rejects a file that is not JSON', async () => {
    routes['POST /api/bots/import'] = { body: bot({ id: 'b5', name: 'Cobrança (2)', status: 'paused', publishedVersionId: null }) };
    renderAt('/configuracoes/chatbots');
    const input = await screen.findByLabelText('Importar');
    const graph = { nodes: [{ id: 'n1', type: 'start_manual', position: { x: 0, y: 0 }, config: {}, name: 'inicio' }], edges: [] };
    const exported = new File([JSON.stringify({ name: 'Cobrança', graph })], 'cobranca.json', { type: 'application/json' });
    fireEvent.change(input, { target: { files: [exported] } });
    await waitFor(() => expect(called('POST', '/api/bots/import')[0]?.body).toEqual({ name: 'Cobrança', graph }));

    fireEvent.change(input, { target: { files: [new File(['não é json'], 'x.json', { type: 'application/json' })] } });
    expect((await screen.findByRole('alert')).textContent).toContain('Arquivo inválido: não é um JSON.');
    expect(called('POST', '/api/bots/import')).toHaveLength(1);
  });

  it('creates the office flow from the template and opens it in the editor', async () => {
    routes['POST /api/bots/from-template'] = { body: bot({ id: 'b9', status: 'paused' }) };
    renderAt('/configuracoes/chatbots');
    fireEvent.click(await screen.findByRole('button', { name: 'Criar a partir do modelo' }));

    const dialog = await screen.findByRole('dialog', { name: 'Criar a partir do modelo' });
    const financeiro = await within(dialog).findByRole('group', { name: 'Financeiro' });
    const processos = within(dialog).getByRole('group', { name: 'Processos' });
    expect((within(processos).getByLabelText('Setor') as HTMLSelectElement).value).toBe('s-jur'); // "Jurídico" guessed
    expect(within(financeiro).queryByRole('option', { name: 'Carlos Inativo' })).toBeNull();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Criar' }));
    expect(within(dialog).getByRole('alert').textContent).toBe('Informe o nome do escritório.');
    expect(called('POST', '/api/bots/from-template')).toHaveLength(0);

    fireEvent.change(within(dialog).getByLabelText('Nome do escritório'), { target: { value: ' JVO Advogados ' } });
    fireEvent.change(within(financeiro).getByLabelText('Atendente'), { target: { value: 'u-ana' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Criar' }));

    await screen.findByText('editor b9');
    expect(called('POST', '/api/bots/from-template')[0]?.body).toEqual({
      name: 'Fluxo do escritório',
      companyName: 'JVO Advogados',
      channelId: 'ch1',
      destinations: {
        atendimento: { sectorId: 's-at', userId: null },
        financeiro: { sectorId: 's-fin', userId: 'u-ana' },
        processos: { sectorId: 's-jur', userId: null },
      },
    });
  });
});
