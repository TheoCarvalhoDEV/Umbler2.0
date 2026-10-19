// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type { ChannelDto, Me } from '@talk/shared';
import { qk } from '../../lib/api';
import { ChannelBanner, downChannels } from './ChannelBanner';

const admin: Me = { id: 'u-admin', name: 'Admin', email: 'admin@teste.local', role: 'admin', signature: null, sectorIds: [], seeAllSectors: false, avatarUrl: null };
const agent: Me = { ...admin, id: 'u-agent', role: 'agent' };
const ch = (over: Partial<ChannelDto>): ChannelDto => ({ id: 'ch1', name: 'Escritório', status: 'disconnected', phone: null, ...over });
const NOW = Date.parse('2026-10-16T12:00:00.000Z');

let channels: ChannelDto[] = [];
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(channels), { status: 200, headers: { 'content-type': 'application/json' } })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderBanner(me: Me, list: ChannelDto[]) {
  channels = list;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(qk.me, me);
  qc.setQueryData(qk.channels, list);
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ChannelBanner />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('downChannels', () => {
  it('lists channels disconnected for more than 1 min, or since an unknown time (§7)', () => {
    const list = [
      ch({ id: 'a', disconnectedAt: '2026-10-16T11:58:59.000Z' }), // 61 s
      ch({ id: 'b', disconnectedAt: '2026-10-16T11:59:30.000Z' }), // 30 s
      ch({ id: 'c', disconnectedAt: null }),
      ch({ id: 'd', status: 'connecting' }),
      ch({ id: 'e', status: 'connected' }),
    ];
    expect(downChannels(list, NOW).map((c) => c.id)).toEqual(['a', 'c']);
  });
});

describe('ChannelBanner', () => {
  it('tells an admin which channel is down and links to Configurações › Canais', () => {
    renderBanner(admin, [ch({ disconnectedAt: null })]);
    expect(screen.getByRole('alert').textContent).toBe('Canal Escritório desconectado: leia o QR code em Configurações › Canais');
    expect(screen.getByRole('link', { name: 'Configurações › Canais' }).getAttribute('href')).toBe('/configuracoes/canais');
  });

  it('shows nothing to an agent, nor while every channel is up', () => {
    renderBanner(agent, [ch({ disconnectedAt: null })]);
    expect(screen.queryByRole('alert')).toBeNull();
    cleanup();
    renderBanner(admin, [ch({ status: 'connected' })]);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
