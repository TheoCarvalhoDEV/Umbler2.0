import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useLogout, useSessionSync } from './auth';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

it('tells the other tabs about a logout even when the request fails', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'x' }), { status: 500, headers: { 'content-type': 'application/json' } })));
  const { result } = renderHook(() => useLogout(), { wrapper: wrapper(newClient()) });
  act(() => result.current.mutate());
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(localStorage.getItem('talk:session')).toMatch(/^none:/);
});

it('keeps listening for session changes when "me" failed to load', async () => {
  const reload = vi.fn();
  vi.stubGlobal('location', { reload });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'x' }), { status: 500, headers: { 'content-type': 'application/json' } })));
  const client = newClient();
  const { result } = renderHook(() => ({ s: useSessionSync(), q: client.getQueryState(['me']) }), { wrapper: wrapper(client) });
  // useSessionSync itself reads `me` via useMe, which fetches and fails
  await waitFor(() => expect(client.getQueryState(['me'])?.status).toBe('error'));
  expect(result.current).toBeTruthy();
  act(() => {
    window.dispatchEvent(new StorageEvent('storage', { key: 'talk:session', newValue: 'u2:1' }));
  });
  expect(reload).toHaveBeenCalledTimes(1);
});
