// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TimelineItem } from '@talk/shared';
import { Timeline } from './Timeline';

const ITEMS: TimelineItem[] = [
  { type: 'event', id: 'e1', chatId: 'c1', kind: 'created', data: {}, authorName: null, createdAt: '2026-10-15T12:00:00.000Z' },
  {
    type: 'event', id: 'e2', chatId: 'c1', kind: 'bot_started',
    data: { botId: 'b1', botName: 'Fluxo do escritório', runId: 'r1' }, authorName: null, createdAt: '2026-10-15T12:00:01.000Z',
  },
];

function stubFetch(routes: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const key = `${init?.method ?? 'GET'} ${url.pathname}`;
      if (!(key in routes)) return new Response(JSON.stringify({ error: 'inesperado' }), { status: 500 });
      return new Response(JSON.stringify(routes[key]), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Timeline chatbot events', () => {
  it('marks bot_* events with the robot icon and other events with the info icon', async () => {
    stubFetch({ 'GET /api/chats/c1/timeline': ITEMS, 'GET /api/sectors': [], 'GET /api/users': [] });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <Timeline chatId="c1" onReply={() => {}} />
      </QueryClientProvider>,
    );
    const bot = await screen.findByText(/Chatbot Fluxo do escritório iniciado/);
    expect(bot.querySelector('[data-bot-event]')).not.toBeNull();
    const created = screen.getByText(/Conversa iniciada pelo contato/);
    expect(created.querySelector('[data-bot-event]')).toBeNull();
  });
});
