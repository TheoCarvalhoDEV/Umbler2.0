// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MessageDto } from '@talk/shared';
import { FavoritesList } from './FavoritesList';

const fav = (id: string, over: Partial<MessageDto>): MessageDto => ({
  id, chatId: 'c1', direction: 'in', kind: 'text', body: null, media: null, mediaUnavailable: false, authorId: null,
  authorName: null, authorAvatarUrl: null, replyTo: null, reaction: null, status: 'read', error: null,
  sentAt: '2026-10-18T12:00:00.000Z', ...over,
});

function stub(list: MessageDto[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(list), { status: 200, headers: { 'content-type': 'application/json' } })),
  );
}

function renderList(onJump = vi.fn()) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <FavoritesList chatId="c1" onJump={onJump} />
    </QueryClientProvider>,
  );
  return onJump;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('lists the favorites with who marked them and jumps on click (spec 2026-10-19 §5)', async () => {
  stub([
    fav('m2', { body: 'Proposta enviada', favorite: { at: '2026-10-19T09:00:00.000Z', byName: 'Bia' } }),
    fav('m1', { kind: 'image', favorite: { at: '2026-10-19T08:00:00.000Z', byName: 'Ana' } }),
  ]);
  const onJump = renderList();
  fireEvent.click(await screen.findByRole('button', { name: /Proposta enviada/ }));
  expect(onJump).toHaveBeenCalledWith('m2');
  expect(screen.getByRole('button', { name: /📷 Imagem/ }).textContent).toContain('por Ana');
});

it('says when there is none', async () => {
  stub([]);
  renderList();
  expect(await screen.findByText('Nenhuma mensagem favorita.')).toBeTruthy();
});
