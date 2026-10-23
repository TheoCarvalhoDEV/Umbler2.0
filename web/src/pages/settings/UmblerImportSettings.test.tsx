// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { emptyUmblerCounts, type UmblerAnalysisDto, type UmblerImportDto, type UmblerImportStatusDto } from '@talk/shared';
import { confirmDialog } from '../../lib/confirm';
import { UmblerImportSettings, durationText } from './UmblerImportSettings';

vi.mock('../../lib/confirm', () => ({ confirmDialog: vi.fn(async () => true) }));

const analysis: UmblerAnalysisDto = {
  organizationId: 'ORG', organization: 'Escritório Teste',
  contacts: { total: 2368, existing: 300, withoutAddress: 8 },
  chats: { open: 135, waiting: 12, closed: 9440, from: '2023-02-01T12:00:00.000Z', to: '2026-10-20T12:00:00.000Z' },
  channels: [
    { id: 'CH_OLD', name: 'Número antigo', type: 'OrganizationBrokerWhatsappChannelReferenceModel', phone: '5565988880000', whatsapp: true, chats: 900, proposal: 'ch1' },
    { id: 'CH_WEB', name: 'Site', type: 'OrganizationWebsiteWidgetChannelReferenceModel', phone: null, whatsapp: false, chats: 4, proposal: 'none' },
  ],
  sectors: [{ id: 'SEC1', name: 'Atendimento', proposal: 's1' }, { id: 'SEC3', name: 'Trabalhista', proposal: 'create' }],
  members: [{ id: 'M_CARLA', name: 'Carla Antiga', email: 'carla@antigo.test', active: false, chats: 321, proposal: 'create' }],
  tags: { new: 3, existing: 1 },
  customFields: { new: 1, existing: 0, unsupported: ['Aceitou termos'] },
  quickAnswers: { new: 5, existing: 2 },
  readTest: 'ok',
  warnings: ['Espaço livre para arquivos: 40 GB.'],
};
const counts = { ...emptyUmblerCounts(), done: 120, total: 135, chatsRead: 0 };
const imp = (over: Partial<UmblerImportDto> = {}): UmblerImportDto => ({
  id: 'i1', state: 'analyzed', phase: null, analysis, progress: counts, report: null, error: null, blocks: [],
  createdAt: '2026-10-21T12:00:00.000Z', startedAt: null, finishedAt: null, ...over,
});

let status: UmblerImportStatusDto;
const calls: Array<{ method: string; path: string; body: unknown }> = [];
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls.length = 0;
  status = { tokenConfigured: true, current: null };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    const method = init?.method ?? 'GET';
    calls.push({ method, path, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    if (method === 'GET' && path === '/api/umbler-import') return json(status);
    if (method === 'GET' && path === '/api/channels') return json([{ id: 'ch1', name: 'WhatsApp escritório', status: 'connected', phone: '5565999990000' }]);
    if (method === 'GET' && path === '/api/sectors') return json([{ id: 's1', name: 'Atendimento', position: 0, isDefault: true }]);
    if (method === 'GET' && path === '/api/users') return json([{ id: 'u1', name: 'Ana', email: 'ana@x', role: 'agent', signature: null, active: true, sectorIds: [], avatarUrl: null }]);
    if (method === 'POST') return json(imp({ state: 'running' }));
    return json({ error: 'inesperado' }, 500);
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
      <UmblerImportSettings />
    </QueryClientProvider>,
  );
}

describe('Importar do Umbler (spec 2026-10-21 importar-umbler §6)', () => {
  it('without the token: says how to set it, never shows any token, and "Analisar" is disabled', async () => {
    status = { tokenConfigured: false, current: null };
    renderPage();
    expect(await screen.findByText(/Token do Umbler não configurado\. Coloque/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Analisar' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('with the token: "Analisar" posts analyze; while analyzing it shows the chats read and no button', async () => {
    renderPage();
    expect(await screen.findByText('Token do Umbler configurado.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Analisar' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/umbler-import/analyze')).toBe(true));

    cleanup();
    status = { tokenConfigured: true, current: imp({ state: 'analyzing', analysis: null, progress: { ...counts, chatsRead: 450 } }) };
    renderPage();
    expect(await screen.findByText('Analisando o Umbler… 450 conversas lidas')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Analisar/ })).toBeNull();
  });

  it('analyzed: counts, the proposed destinations, the channel hints; "Importar" confirms and posts the mapping', async () => {
    status = { tokenConfigured: true, current: imp() };
    renderPage();
    expect(await screen.findByText('Contatos: 2.060 novos, 300 já existem aqui, 8 sem telefone nem LID (não vêm)')).toBeTruthy();
    expect(screen.getByText('Conversas abertas: 135 (das quais 12 esperando)')).toBeTruthy();
    expect(screen.getByText('Período: de 01/02/2023 a 20/10/2026')).toBeTruthy();
    const oldNumber = (await screen.findByLabelText('Número antigo')) as HTMLSelectElement;
    expect(oldNumber.value).toBe('ch1');
    expect(screen.getByText('As conversas do número +55 65 98888-0000 entram no canal WhatsApp escritório; respostas a elas saem do número oficial.')).toBeTruthy();
    expect((screen.getByLabelText('Site') as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getByText('4 conversas deste canal não vêm.')).toBeTruthy();
    expect((screen.getByLabelText('Trabalhista') as HTMLSelectElement).value).toBe('create');
    expect(screen.getByRole('option', { name: 'Criar setor “Trabalhista”' })).toBeTruthy();
    expect((screen.getByLabelText('Carla Antiga') as HTMLSelectElement).value).toBe('create');
    expect(screen.getByText('Espaço livre para arquivos: 40 GB.')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Carla Antiga'), { target: { value: 'none' } });
    fireEvent.change(oldNumber, { target: { value: 'none' } });
    expect(screen.getByText('900 conversas deste canal não vêm.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Importar' }));

    await waitFor(() => expect(calls.find((c) => c.path === '/api/umbler-import/i1/start')).toBeTruthy());
    expect(vi.mocked(confirmDialog)).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Importar 2.360 contatos e 9.575 conversas do Umbler?', confirmLabel: 'Importar' }),
    );
    expect(calls.find((c) => c.path === '/api/umbler-import/i1/start')!.body).toEqual({
      mapping: { channels: { CH_OLD: 'none', CH_WEB: 'none' }, sectors: { SEC1: 's1', SEC3: 'create' }, members: { M_CARLA: 'none' } },
    });
  });

  it('a block (automatic rules on) is shown and keeps "Importar" disabled', async () => {
    status = { tokenConfigured: true, current: imp({ blocks: ['Desligue as Regras automáticas antes de importar: …'] }) };
    renderPage();
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect((await screen.findByRole('button', { name: 'Importar' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('importing: the step, the counters, and that the screen may be closed', async () => {
    status = { tokenConfigured: true, current: imp({ state: 'running', phase: 'open_chats', startedAt: '2026-10-21T12:00:00.000Z' }) };
    renderPage();
    expect(await screen.findByText('Etapa 3 de 5: conversas abertas — 120 de 135')).toBeTruthy();
    expect(screen.getByText('Casadas com o histórico do WhatsApp: 0')).toBeTruthy();
    expect(screen.getByText('Pode fechar esta tela: a importação continua no servidor e retoma sozinha se o sistema reiniciar.')).toBeTruthy();
  });

  it('failed: the reason and "Continuar"; a failed analysis only offers "Analisar de novo"', async () => {
    status = { tokenConfigured: true, current: imp({ state: 'failed', phase: 'closed_chats', error: 'umbler_429', startedAt: '2026-10-21T12:00:00.000Z' }) };
    renderPage();
    expect(await screen.findByText('A importação parou: O Umbler limitou as requisições. Clique em Continuar daqui a alguns minutos. O que já entrou fica.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/umbler-import/i1/resume')).toBe(true));

    cleanup();
    status = { tokenConfigured: true, current: imp({ state: 'failed', error: 'umbler_token', analysis: null }) };
    renderPage();
    expect(await screen.findByText(/^A análise parou: O Umbler recusou o token/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Continuar' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Analisar de novo' })).toBeTruthy();
  });

  it('done: when it ended, how long it took, and the report', async () => {
    const report = { ...emptyUmblerCounts(), durationMs: 2 * 3_600_000 + 15 * 60_000, messages: { ...emptyUmblerCounts().messages, total: 150_000, matched: 4200, maxMatchDiffMs: 3500 } };
    status = {
      tokenConfigured: true,
      current: imp({ state: 'done', phase: 'closed_chats', report, startedAt: '2026-10-21T12:00:00.000Z', finishedAt: '2026-10-21T18:15:00.000Z' }),
    };
    renderPage();
    expect(await screen.findByText('Importação concluída em 21/10/2026 14:15 (duração 2 h 15 min).')).toBeTruthy();
    expect(screen.getByText('Casadas com o histórico do WhatsApp: 4.200 (maior diferença: 3,5 s)')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Analisar de novo' })).toBeTruthy();
    expect(durationText(40 * 60_000)).toBe('40 min');
  });
});
