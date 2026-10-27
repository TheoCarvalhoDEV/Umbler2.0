// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Me, ReportDto } from '@talk/shared';
import { ReportsPage, formatDuration } from './Reports';

const admin: Me = { id: 'adm', name: 'Admin', email: 'adm@exemplo.com.br', role: 'admin', signature: null, sectorIds: [], seeAllSectors: false, avatarUrl: null };

const report = (from: string, to: string): ReportDto => ({
  from, to,
  totals: { newChats: 1234, closedChats: 7, openNow: 3, waitingNow: 2, firstResponseSec: 1874, within15Pct: 33, replySec: 164, botChats: 0 },
  days: [{ day: from, newChats: 4, closedChats: 2 }],
  sectors: [{ id: 's1', name: 'Financeiro', newChats: 4, closedChats: 2, firstResponseSec: 600 }],
  agents: [{ id: 'u1', name: 'Ana Lima', chats: 2, closedChats: 1, messages: 9, firstResponseSec: null }],
  peak: Array.from({ length: 7 }, () => Array<number>(24).fill(0)),
});

const urls = () => vi.mocked(fetch).mock.calls.map(([input]) => new URL(String(input), 'http://localhost').search);

function renderPage(me: Me = admin) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['me'], me);
  render(
    <QueryClientProvider client={qc}>
      <ReportsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-27T15:00:00.000Z')); // 11:00 in Cuiabá
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const q = new URL(String(input), 'http://localhost').searchParams;
      return new Response(JSON.stringify(report(q.get('from')!, q.get('to')!)), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('formats the times', () => {
  expect([formatDuration(null), formatDuration(45), formatDuration(1874), formatDuration(4800), formatDuration(183_600)]).toEqual([
    '—', '45 s', '31 min', '1 h 20 min', '2 d 3 h',
  ]);
});

it('opens on the last 7 days and shows the numbers, sectors and attendants', async () => {
  renderPage();
  expect(await screen.findByText('1.234')).toBeTruthy();
  expect(urls()).toEqual(['?from=2026-10-21&to=2026-10-27']);
  expect(screen.getByText('31 min')).toBeTruthy(); // first reply
  expect(screen.getByText('33%')).toBeTruthy();
  const sectors = screen.getByRole('heading', { name: 'Por setor' }).closest('section')!;
  expect(within(sectors).getByRole('rowheader', { name: 'Financeiro' })).toBeTruthy();
  expect(within(sectors).getByText('10 min')).toBeTruthy();
  const agents = screen.getByRole('heading', { name: 'Por atendente' }).closest('section')!;
  expect(within(agents).getByRole('rowheader', { name: 'Ana Lima' })).toBeTruthy();
});

it('changes the period: today, and chosen dates checked before asking', async () => {
  renderPage();
  await screen.findByText('1.234');
  fireEvent.click(screen.getByRole('tab', { name: 'Hoje' }));
  await vi.waitFor(() => expect(urls()).toContain('?from=2026-10-27&to=2026-10-27'));
  fireEvent.click(screen.getByRole('tab', { name: 'Escolher datas' }));
  fireEvent.change(screen.getByLabelText('De'), { target: { value: '2026-10-28' } });
  expect(screen.getByRole('alert').textContent).toBe('A data inicial vem depois da final');
  fireEvent.change(screen.getByLabelText('De'), { target: { value: '2026-10-01' } });
  await vi.waitFor(() => expect(urls()).toContain('?from=2026-10-01&to=2026-10-27'));
});

it('an attendant does not see reports', () => {
  renderPage({ ...admin, role: 'agent' });
  expect(screen.getByText('Só administradores veem os relatórios.')).toBeTruthy();
  expect(vi.mocked(fetch)).not.toHaveBeenCalled();
});
