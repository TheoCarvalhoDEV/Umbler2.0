// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryRouter } from 'react-router';
import type { BotDto, BotVersionDto, Me } from '@talk/shared';
import { BotEditorPage } from './BotEditorPage';

// The canvas has its own test; here only the page logic matters.
vi.mock('../../../components/bot-editor/BotEditor', async () => {
  const { createElement } = await import('react');
  return {
    BotEditor: ({ bot, initial }: { bot: BotDto; initial: BotVersionDto }) =>
      createElement('p', null, `Editor de ${bot.name}, versão ${initial.number}`),
  };
});

const bot: BotDto = {
  id: 'b1', name: 'Fluxo teste', description: '', status: 'paused', startChannelIds: [], manualStart: false, manualTitle: '',
  manualUnlisted: false, publishedVersionId: null, publishedVersionNumber: null, latestVersionNumber: 2, runCount: 0,
  activeRunCount: 0, createdAt: '2026-10-15T12:00:00.000Z', updatedAt: '2026-10-15T12:00:00.000Z',
};
const version: BotVersionDto = {
  id: 'v2', botId: 'b1', number: 2, valid: true, label: null, createdByName: 'Admin Teste',
  createdAt: '2026-10-15T12:00:00.000Z', published: false, graph: { nodes: [], edges: [] }, problems: [],
};
const admin: Me = { id: 'adm', name: 'Admin', email: 'adm@exemplo.com.br', role: 'admin', signature: null, sectorIds: [], seeAllSectors: false, avatarUrl: null };
const agent: Me = { ...admin, id: 'ag', role: 'agent' };

let routes: Record<string, { status?: number; body: unknown }>;
const paths: string[] = [];

beforeEach(() => {
  paths.length = 0;
  routes = {
    'GET /api/bots/b1': { body: bot },
    'GET /api/bots/b1/versions/2': { body: version },
  };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    paths.push(url.pathname);
    const reply = routes[`${init?.method ?? 'GET'} ${url.pathname}`];
    if (!reply) return new Response(JSON.stringify({ error: 'inesperado' }), { status: 500 });
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPage(me: Me) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  qc.setQueryData(['me'], me);
  const router = createMemoryRouter(
    [
      { path: '/configuracoes/chatbots/:id', element: <BotEditorPage /> },
      { path: '/configuracoes/perfil', element: <p>Perfil</p> },
    ],
    { initialEntries: ['/configuracoes/chatbots/b1'] },
  );
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

it('loads the bot and its latest version for an admin', async () => {
  renderPage(admin);
  expect(await screen.findByText('Editor de Fluxo teste, versão 2')).toBeTruthy();
});

it('sends an agent to Perfil without loading the bot', async () => {
  renderPage(agent);
  expect(await screen.findByText('Perfil')).toBeTruthy();
  expect(paths).not.toContain('/api/bots/b1');
});

it('shows the error when the bot does not exist', async () => {
  routes['GET /api/bots/b1'] = { status: 404, body: { error: 'Chatbot não encontrado' } };
  renderPage(admin);
  expect(await screen.findByText('Chatbot não encontrado')).toBeTruthy();
});
