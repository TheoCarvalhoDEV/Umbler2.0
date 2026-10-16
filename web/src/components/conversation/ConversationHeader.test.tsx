// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ChatDetail, Me, SectorDto } from '@talk/shared';
import { qk } from '../../lib/api';
import { ConversationHeader } from './ConversationHeader';

// jsdom has no modal <dialog> API; the browser opens ChatDialogs' Modal with showModal()
HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
  this.setAttribute('open', '');
};

const ME: Me = {
  id: 'u-admin', name: 'Admin Teste', email: 'admin@teste.local', role: 'admin', signature: null,
  sectorIds: [], seeAllSectors: true, avatarUrl: null,
};
const CHAT: ChatDetail = {
  id: 'c1', contact: { id: 'k1', name: 'Maria', phone: '5565999990000', avatarUrl: null }, channelId: 'ch1',
  sectorId: 's1', ownerId: null, state: 'open', waiting: true, private: false, unread: 0, lastMessageAt: null,
  lastMessagePreview: null, pinned: false, tagIds: [], triagePending: false, createdAt: '2026-10-15T12:00:00.000Z', closedAt: null,
};
const SECTORS: SectorDto[] = [
  { id: 's1', name: 'Atendimento', position: 0, isDefault: true },
  { id: 's2', name: 'Financeiro', position: 1, isDefault: false },
];
const BOT_RUNNING = {
  error: 'O chatbot está em execução nesta conversa',
  code: 'BOT_RUNNING',
  runs: [{ id: 'r1', botName: 'Fluxo do escritório' }],
};

type Call = { method: string; path: string; body: unknown };
const calls: Call[] = [];

/** The first transfer answers 409 BOT_RUNNING; the next one succeeds. */
function stubFetch() {
  calls.length = 0;
  let transfers = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init?.method ?? 'GET';
      calls.push({ method, path: url.pathname, body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body });
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (method === 'GET' && url.pathname === '/api/sectors') return json(200, SECTORS);
      if (method === 'GET' && url.pathname === '/api/users') return json(200, []);
      if (method === 'POST' && url.pathname === '/api/chats/c1/transfer') {
        return transfers++ === 0 ? json(409, BOT_RUNNING) : json(200, { ...CHAT, sectorId: 's2' });
      }
      return json(500, { error: 'inesperado' });
    }),
  );
}

const transfers = () => calls.filter((c) => c.method === 'POST' && c.path === '/api/chats/c1/transfer');

function renderHeader() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  qc.setQueryData(qk.me, ME);
  render(
    <QueryClientProvider client={qc}>
      <ConversationHeader chat={CHAT} contactPanelOpen={false} onToggleContactPanel={() => {}} onOpenChat={() => {}} />
    </QueryClientProvider>,
  );
  return qc;
}

/** Opens "Transferir conversa", picks Financeiro, confirms, and returns the BOT_RUNNING dialog. */
async function transferToFinanceiro(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: 'Transferir' }));
  const dialog = await screen.findByRole('dialog', { name: 'Transferir conversa' });
  await within(dialog).findByRole('option', { name: 'Financeiro' });
  fireEvent.change(within(dialog).getByLabelText('Setor'), { target: { value: 's2' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Transferir' }));
  return screen.findByRole('dialog', { name: 'O chatbot está rodando' });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ConversationHeader transfer with a running chatbot', () => {
  it('asks on 409 BOT_RUNNING and retries the same transfer with the chosen botAction', async () => {
    stubFetch();
    const qc = renderHeader();
    const ask = await transferToFinanceiro();
    expect(ask.textContent).toContain('Fluxo do escritório');
    expect(screen.queryByRole('dialog', { name: 'Transferir conversa' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull(); // not the "alterada por outra pessoa" conflict

    fireEvent.click(within(ask).getByRole('button', { name: 'Transferir e manter' }));
    await waitFor(() => expect(qc.getQueryData<ChatDetail>(qk.chat('c1'))?.sectorId).toBe('s2'));
    expect(transfers().map((c) => c.body)).toEqual([
      { sectorId: 's2', ownerId: null },
      { sectorId: 's2', ownerId: null, botAction: 'keep' },
    ]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('"Cancelar" leaves the chat where it is and shows no error', async () => {
    stubFetch();
    renderHeader();
    const ask = await transferToFinanceiro();
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(transfers()).toHaveLength(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
