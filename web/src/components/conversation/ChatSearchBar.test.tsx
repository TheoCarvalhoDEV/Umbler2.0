// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MessageSearchHit } from '@talk/shared';
import { ChatSearchBar, SEARCH_DEBOUNCE_MS } from './ChatSearchBar';

const HITS: MessageSearchHit[] = [
  { messageId: 'm2', kind: 'text', direction: 'in', snippet: 'o contrato novo', sentAt: '2026-10-18T12:02:00.000Z' },
  { messageId: 'm1', kind: 'note', direction: 'out', snippet: 'contrato antigo', sentAt: '2026-10-18T12:01:00.000Z' },
];
const urls: string[] = [];

function stub(hits: MessageSearchHit[]) {
  urls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      urls.push(url.pathname + url.search);
      return new Response(JSON.stringify(hits), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
}

function renderBar() {
  const onFocusMessage = vi.fn();
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ChatSearchBar chatId="c1" onFocusMessage={onFocusMessage} onClose={onClose} />
    </QueryClientProvider>,
  );
  return { onFocusMessage, onClose, box: screen.getByLabelText('Buscar mensagens') };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ChatSearchBar (spec 2026-10-19 §4)', () => {
  it('searches after a pause, jumps to the newest hit and steps with the arrows; Esc closes', async () => {
    stub(HITS);
    const { onFocusMessage, onClose, box } = renderBar();

    fireEvent.change(box, { target: { value: 'contrato' } });

    expect(await screen.findByText('2 resultados')).toBeTruthy();
    expect(urls).toEqual(['/api/chats/c1/search?q=contrato']);
    await waitFor(() => expect(onFocusMessage).toHaveBeenLastCalledWith('m2'));
    expect(screen.getByText('1/2')).toBeTruthy();
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    await waitFor(() => expect(onFocusMessage).toHaveBeenLastCalledWith('m1'));
    expect(screen.getByText(/contrato antigo/)).toBeTruthy();
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    await waitFor(() => expect(onFocusMessage).toHaveBeenLastCalledWith('m2'));
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not search under 2 characters and says when nothing was found', async () => {
    stub([]);
    const { onFocusMessage, box } = renderBar();
    fireEvent.change(box, { target: { value: 'c' } });
    await new Promise((r) => setTimeout(r, SEARCH_DEBOUNCE_MS + 50));
    expect(urls).toEqual([]);
    fireEvent.change(box, { target: { value: 'xyz' } });
    expect(await screen.findByText('Nenhum resultado')).toBeTruthy();
    expect(onFocusMessage).not.toHaveBeenCalled();
  });
});
