// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router';
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

function Where() {
  const loc = useLocation();
  return <output data-testid="where">{loc.pathname + loc.search}</output>;
}

function renderHeader(chat: ChatDetail = CHAT, opts: { path?: string; me?: Me } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  qc.setQueryData(qk.me, opts.me ?? ME);
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[opts.path ?? '/chats/c1']}>
        <ConversationHeader chat={chat} contactPanelOpen={false} onToggleContactPanel={() => {}} onOpenChat={() => {}} />
        <Where />
      </MemoryRouter>
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

describe('ConversationHeader for an imported history chat (§8)', () => {
  it('is read-only: no Reabrir, labelled as WhatsApp history; a LID-only contact reads "Contato sem número"', () => {
    stubFetch();
    renderHeader({ ...CHAT, state: 'closed', history: true, contact: { id: 'k2', name: null, phone: null, avatarUrl: null } });
    expect(screen.queryByRole('button', { name: 'Reabrir' })).toBeNull();
    expect(screen.getByText('Histórico do WhatsApp')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Contato sem número' })).toBeTruthy();
  });
});

describe('ConversationHeader opened from the chat list menu (?acao)', () => {
  const where = () => screen.getByTestId('where').textContent;

  it('?acao=transferir opens the transfer dialog and drops the param', async () => {
    stubFetch();
    renderHeader(CHAT, { path: '/chats/c1?acao=transferir' });
    expect(await screen.findByRole('dialog', { name: 'Transferir conversa' })).toBeTruthy();
    await waitFor(() => expect(where()).toBe('/chats/c1'));
  });

  it('?acao=finalizar opens the close dialog', async () => {
    stubFetch();
    renderHeader(CHAT, { path: '/chats/c1?acao=finalizar' });
    expect(await screen.findByRole('dialog', { name: 'Finalizar conversa' })).toBeTruthy();
    await waitFor(() => expect(where()).toBe('/chats/c1'));
  });

  it('opens nothing when the user may not transfer: someone else’s private chat, or a closed chat', async () => {
    stubFetch();
    const agent: Me = { ...ME, id: 'u-agent', role: 'agent', seeAllSectors: false };
    renderHeader({ ...CHAT, private: true, ownerId: 'u-other' }, { path: '/chats/c1?acao=transferir', me: agent });
    await waitFor(() => expect(where()).toBe('/chats/c1'));
    expect(screen.queryByRole('dialog')).toBeNull();
    cleanup();
    renderHeader({ ...CHAT, state: 'closed' }, { path: '/chats/c1?acao=finalizar' });
    await waitFor(() => expect(where()).toBe('/chats/c1'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
