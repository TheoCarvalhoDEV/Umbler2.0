// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { BotRunDto, ChatListItem, ManualBotDto } from '@talk/shared';
import { connectWs } from '../../lib/ws';
import { BotPanel } from './BotPanel';

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

class FakeWs {
  static instances: FakeWs[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) {
    FakeWs.instances.push(this);
  }
  close() {}
}

const run = (over: Partial<BotRunDto> = {}): BotRunDto => ({
  id: 'r1', botId: 'b1', botName: 'Fluxo do escritório', chatId: 'c1', state: 'waiting_reply', currentNodeId: 'menu',
  depth: 0, startedByName: null, error: null, createdAt: '2026-10-15T12:00:00.000Z', updatedAt: '2026-10-15T12:00:00.000Z',
  finishedAt: null, ...over,
});

const chatItem = (id: string): ChatListItem => ({
  id, contact: { id: 'k1', name: 'Maria', phone: '5565999990000', avatarUrl: null }, channelId: 'ch1', sectorId: 's1',
  ownerId: null, state: 'open', waiting: false, private: false, unread: 0, lastMessageAt: null, lastMessagePreview: null,
  pinned: false, tagIds: [],
});

const MANUAL: ManualBotDto[] = [
  { id: 'b1', title: 'Fluxo do escritório' },
  { id: 'b2', title: 'Pesquisa de satisfação' },
];

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <BotPanel chatId="c1" onClose={onClose} />
    </QueryClientProvider>,
  );
  return { qc, onClose };
}

const byPath = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  FakeWs.instances = [];
});

describe('BotPanel', () => {
  it('lists the manual chatbots under "Executar chatbot" and starts the chosen one', async () => {
    stubFetch({
      'GET /api/bots/manual': MANUAL,
      'GET /api/chats/c1/bot-runs': [],
      'POST /api/chats/c1/bot-runs': run({ botId: 'b2', botName: 'Pesquisa de satisfação' }),
    });
    const { onClose } = renderPanel();
    expect(screen.getByText('Executar chatbot')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Pesquisa de satisfação' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(byPath('POST', '/api/chats/c1/bot-runs').map((c) => c.body)).toEqual([{ botId: 'b2' }]);
    expect(byPath('GET', '/api/chats/c1/bot-runs')).toHaveLength(2); // refetched before closing
    expect(screen.queryByRole('button', { name: 'Parar chatbot' })).toBeNull();
  });

  it('shows the running chatbot with "Parar chatbot", disables starting it again, and stops it', async () => {
    stubFetch({
      'GET /api/bots/manual': MANUAL,
      'GET /api/chats/c1/bot-runs': [run()],
      'POST /api/bot-runs/r1/stop': run({ state: 'stopped' }),
    });
    const { onClose } = renderPanel();
    const stop = await screen.findByRole('button', { name: 'Parar chatbot' });
    const again = (await screen.findByRole('button', { name: 'Fluxo do escritório' })) as HTMLButtonElement;
    expect(again.disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Pesquisa de satisfação' }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(stop);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(byPath('POST', '/api/bot-runs/r1/stop')).toHaveLength(1);
  });

  it('says so when no chatbot can be started manually', async () => {
    stubFetch({ 'GET /api/bots/manual': [], 'GET /api/chats/c1/bot-runs': [] });
    renderPanel();
    expect(
      await screen.findByText(
        'Nenhum chatbot pode ser iniciado por aqui. No editor, use o bloco “Iniciar manualmente” e marque “Permitir que atendentes iniciem pela conversa”.',
      ),
    ).toBeTruthy();
  });

  it('shows the server error and stays open when the start fails', async () => {
    stubFetch({ 'GET /api/bots/manual': MANUAL, 'GET /api/chats/c1/bot-runs': [] }); // POST answers 500 'inesperado'
    const { onClose } = renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Pesquisa de satisfação' }));
    expect((await screen.findByRole('alert')).textContent).toBe('inesperado');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('reloads the running list when this chat (and only this chat) is updated over the WebSocket', async () => {
    stubFetch({ 'GET /api/bots/manual': MANUAL, 'GET /api/chats/c1/bot-runs': [] });
    vi.stubGlobal('WebSocket', FakeWs);
    const { qc } = renderPanel();
    const stopWs = connectWs(qc, 'ws://test/ws');
    await waitFor(() => expect(byPath('GET', '/api/chats/c1/bot-runs')).toHaveLength(1));

    await act(async () => {
      FakeWs.instances[0]!.onmessage!({ data: JSON.stringify({ type: 'chat.updated', chat: chatItem('c2') }) });
    });
    expect(byPath('GET', '/api/chats/c1/bot-runs')).toHaveLength(1);

    await act(async () => {
      FakeWs.instances[0]!.onmessage!({ data: JSON.stringify({ type: 'chat.updated', chat: chatItem('c1') }) });
    });
    await waitFor(() => expect(byPath('GET', '/api/chats/c1/bot-runs')).toHaveLength(2));
    stopWs();
  });
});
