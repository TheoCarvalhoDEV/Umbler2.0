// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ChannelDto, HistoryImportDto } from '@talk/shared';
import { confirmDialog, promptDialog } from '../../lib/confirm';
import { ChannelsSettings, importText } from './ChannelsSettings';

vi.mock('../../lib/confirm', () => ({ confirmDialog: vi.fn(async () => true), promptDialog: vi.fn() }));

const channel = (over: Partial<ChannelDto> = {}): ChannelDto => ({
  id: 'ch1', name: 'WhatsApp escritório', status: 'connected', phone: '5565999990000', historyPeriod: '3m',
  disconnectedAt: null, historyImport: null, ...over,
});
const imp = (over: Partial<HistoryImportDto> = {}): HistoryImportDto => ({
  id: 'i1', period: '3m', state: 'running', startedAt: '2026-10-16T12:00:00.000Z', finishedAt: null,
  messagesImported: 0, contactsCreated: 0, oldestMessageAt: null, error: null, ...over,
});

interface Reply { status?: number; body?: unknown }
let routes: Record<string, Reply>;
const calls: Array<{ method: string; path: string; body: unknown }> = [];
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls.length = 0;
  routes = {};
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    const method = init?.method ?? 'GET';
    calls.push({ method, path, body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body });
    const reply = routes[`${method} ${path}`];
    if (!reply) return json({ error: 'inesperado' }, 500);
    return json(reply.body ?? null, reply.status ?? 200);
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ChannelsSettings />
    </QueryClientProvider>,
  );
}

const called = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);
// Excluir canal lives in the channel's ⋮ menu
const clickRemove = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'Opções do canal WhatsApp escritório' }));
  fireEvent.click(screen.getByRole('button', { name: 'Excluir canal' }));
};

describe('importText', () => {
  it('shows the running count, the result with the oldest date, and a failure', () => {
    expect(importText(imp({ messagesImported: 46163 }))).toBe('Importando histórico… 46.163 mensagens');
    expect(importText(imp({ state: 'done', messagesImported: 1234, oldestMessageAt: '2026-07-20T15:00:00.000Z' }))).toBe(
      'Histórico importado: 1.234 mensagens, desde 20/07/2026',
    );
    expect(importText(imp({ state: 'done', messagesImported: 0 }))).toBe('Histórico importado: 0 mensagens');
    expect(importText(imp({ state: 'failed' }))).toBe('A importação do histórico falhou. Clique em “Importar histórico” para tentar de novo.');
  });
});

describe('Settings › Canais', () => {
  it('while connecting, polls the QR although connect gave none, showing "Gerando QR code…" until it comes (§7)', async () => {
    routes['GET /api/channels'] = { body: [channel({ status: 'connecting' })] };
    routes['GET /api/channels/ch1/qr'] = { body: { qrBase64: null } };
    renderPage();
    expect(await screen.findByText('Gerando QR code…')).toBeTruthy();
    await waitFor(() => expect(called('GET', '/api/channels/ch1/qr').length).toBeGreaterThan(0));
    expect(called('POST', '/api/channels/ch1/connect')).toHaveLength(0);
  });

  it('shows the QR as soon as the poll brings it', async () => {
    routes['GET /api/channels'] = { body: [channel({ status: 'connecting' })] };
    routes['GET /api/channels/ch1/qr'] = { body: { qrBase64: 'data:image/png;base64,QRTESTE' } };
    renderPage();
    const img = await screen.findByAltText('QR Code do canal WhatsApp escritório');
    expect(img.getAttribute('src')).toBe('data:image/png;base64,QRTESTE');
    expect(screen.queryByText('Gerando QR code…')).toBeNull();
  });

  it('Reconectar sends the chosen period', async () => {
    routes['GET /api/channels'] = { body: [channel({ status: 'disconnected' })] };
    routes['POST /api/channels/ch1/connect'] = { body: { qrBase64: null } };
    renderPage();
    fireEvent.change(await screen.findByLabelText('Período do histórico'), { target: { value: '12m' } });
    fireEvent.click(screen.getByRole('button', { name: 'Gerar novo QR / Reconectar' }));
    await waitFor(() => expect(called('POST', '/api/channels/ch1/connect')).toHaveLength(1));
    expect(called('POST', '/api/channels/ch1/connect')[0]!.body).toEqual({ historyPeriod: '12m' });
  });

  it('Importar histórico posts the period and shows the import running', async () => {
    routes['GET /api/channels'] = { body: [channel()] };
    routes['POST /api/channels/ch1/history-import'] = { body: channel({ historyPeriod: 'all', historyImport: imp({ period: 'all' }) }) };
    renderPage();
    fireEvent.change(await screen.findByLabelText('Período do histórico'), { target: { value: 'all' } });
    fireEvent.click(screen.getByRole('button', { name: 'Importar histórico' }));
    expect(await screen.findByText('Importando histórico… 0 mensagens')).toBeTruthy();
    expect(called('POST', '/api/channels/ch1/history-import')[0]!.body).toEqual({ period: 'all' });
    expect((screen.getByRole('button', { name: 'Importar histórico' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the result of the last import with the oldest date', async () => {
    routes['GET /api/channels'] = {
      body: [channel({ historyImport: imp({ state: 'done', messagesImported: 1234, oldestMessageAt: '2026-07-20T15:00:00.000Z' }) })],
    };
    renderPage();
    expect(await screen.findByText('Histórico importado: 1.234 mensagens, desde 20/07/2026')).toBeTruthy();
  });

  it('Excluir canal asks first; on yes it deletes and drops the channel from the list', async () => {
    vi.mocked(confirmDialog).mockClear();
    routes['GET /api/channels'] = { body: [channel()] };
    routes['DELETE /api/channels/ch1'] = { body: null };
    vi.mocked(confirmDialog).mockResolvedValueOnce(false);
    renderPage();

    await clickRemove();
    await waitFor(() => expect(confirmDialog).toHaveBeenCalledTimes(1));
    expect(vi.mocked(confirmDialog).mock.calls[0]![0]).toMatchObject({ title: 'Excluir o canal “WhatsApp escritório”?', confirmLabel: 'Excluir canal' });
    expect(called('DELETE', '/api/channels/ch1')).toHaveLength(0);

    await clickRemove();
    await waitFor(() => expect(called('DELETE', '/api/channels/ch1')).toHaveLength(1));
    expect(await screen.findByText('Nenhum canal cadastrado.')).toBeTruthy();
  });

  it('Novo canal asks the name in a dialog and creates the channel', async () => {
    routes['GET /api/channels'] = { body: [] };
    routes['POST /api/channels'] = { body: channel({ status: 'disconnected' }) };
    vi.mocked(promptDialog).mockResolvedValueOnce('WhatsApp escritório');
    renderPage();
    await screen.findByText('Nenhum canal cadastrado.');
    fireEvent.click(screen.getByRole('button', { name: 'Novo canal' }));
    await waitFor(() => expect(called('POST', '/api/channels')).toHaveLength(1));
    expect(vi.mocked(promptDialog).mock.calls[0]![0]).toMatchObject({ title: 'Novo canal', maxLength: 60 });
    expect(called('POST', '/api/channels')[0]!.body).toEqual({ name: 'WhatsApp escritório' });
  });

  it('shows the 409 when an import is already running', async () => {
    routes['GET /api/channels'] = { body: [channel()] };
    routes['POST /api/channels/ch1/history-import'] = { status: 409, body: { error: 'Já existe uma importação em andamento' } };
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Importar histórico' }));
    expect(await screen.findByText('Já existe uma importação em andamento')).toBeTruthy();
  });
});
