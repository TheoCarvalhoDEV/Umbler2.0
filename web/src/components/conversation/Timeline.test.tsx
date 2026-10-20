// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TimelineItem } from '@talk/shared';
import type { TimelineFocus } from './model';
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

describe('Timeline focus (spec 2026-10-19 §4)', () => {
  const m = (id: string, min: number): TimelineItem => ({
    type: 'message', id, chatId: 'c1', direction: 'in', kind: 'text', body: `texto ${id}`, media: null, mediaUnavailable: false,
    authorId: null, authorName: null, authorAvatarUrl: null, replyTo: null, reaction: null, status: 'read', error: null,
    sentAt: new Date(Date.UTC(2026, 9, 18, 12, min)).toISOString(),
  });
  const LIVE = [m('m8', 8), m('m9', 9)];
  const AROUND = [m('m1', 1), m('m2', 2), m('m3', 3)];
  const urls: string[] = [];

  function stub() {
    urls.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'http://localhost');
        urls.push(url.pathname + url.search);
        const body = url.pathname === '/api/chats/c1/timeline' ? (url.searchParams.has('around') ? AROUND : LIVE) : [];
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
  }

  function renderTimeline(): (focus: TimelineFocus | null) => void {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const ui = (focus: TimelineFocus | null) => (
      <QueryClientProvider client={qc}>
        <Timeline chatId="c1" onReply={() => {}} focus={focus} />
      </QueryClientProvider>
    );
    const view = render(ui(null));
    return (focus) => view.rerender(ui(focus));
  }
  const bubble = (id: string) => document.querySelector(`[data-message-id="${id}"]`);

  it('highlights a loaded message without asking the server again', async () => {
    stub();
    const focus = renderTimeline();
    await screen.findByText('texto m9');
    focus({ messageId: 'm8', seq: 1 });
    await waitFor(() => expect(bubble('m8')?.getAttribute('data-highlighted')).toBe('true'));
    expect(urls.filter((u) => u.includes('around'))).toEqual([]);
  });

  it('loads the page around a message that is not loaded, then goes back to the recent ones (Review Focus 1)', async () => {
    stub();
    const focus = renderTimeline();
    await screen.findByText('texto m9');

    focus({ messageId: 'm2', seq: 1 });

    await waitFor(() => expect(bubble('m2')?.getAttribute('data-highlighted')).toBe('true'));
    expect(urls).toContain('/api/chats/c1/timeline?around=m2&limit=50');
    expect(screen.queryByText('texto m9')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Ir para as mensagens recentes' }));
    expect(await screen.findByText('texto m9')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ir para as mensagens recentes' })).toBeNull();
  });
});
