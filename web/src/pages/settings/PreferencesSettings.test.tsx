// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DEFAULT_PREFERENCES, type Me, type UserPreferences } from '@talk/shared';
import { qk } from '../../lib/api';
import { playSound } from '../../lib/sounds';
import { PreferencesSettings } from './PreferencesSettings';

vi.mock('../../lib/sounds', () => ({ playSound: vi.fn() }));

const ME: Me = {
  id: 'u1', name: 'Ana Lima', email: 'ana@teste.local', role: 'agent', signature: null, sectorIds: [], seeAllSectors: false,
  avatarUrl: null, preferences: { ...DEFAULT_PREFERENCES },
};
const calls: Array<{ method: string; path: string; body: unknown }> = [];
let saved: UserPreferences;

beforeEach(() => {
  calls.length = 0;
  saved = { ...DEFAULT_PREFERENCES };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ method, path, body });
      if (method === 'PUT' && path === '/api/auth/me/preferences') {
        saved = { ...saved, ...body };
        return new Response(JSON.stringify({ ...ME, preferences: saved }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: 'inesperado' }), { status: 500 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('saves each change at once, only the field that changed (spec 2026-10-19 §6)', async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  qc.setQueryData(qk.me, ME);
  render(
    <QueryClientProvider client={qc}>
      <PreferencesSettings />
    </QueryClientProvider>,
  );

  const enter = screen.getByRole('switch', { name: 'Enter envia a mensagem' });
  expect(enter.getAttribute('aria-checked')).toBe('true');
  expect((screen.getByRole('radio', { name: 'Só quando a aba está em segundo plano' }) as HTMLInputElement).checked).toBe(true);

  fireEvent.click(enter);
  await waitFor(() => expect(enter.getAttribute('aria-checked')).toBe('false'));
  fireEvent.click(screen.getByRole('radio', { name: 'Nunca' }));
  fireEvent.click(screen.getByRole('switch', { name: 'Sons' }));

  await waitFor(() =>
    expect(calls.map((c) => c.body)).toEqual([{ enterSends: false }, { browserNotifications: 'never' }, { sounds: false }]),
  );
  expect(calls.every((c) => c.method === 'PUT' && c.path === '/api/auth/me/preferences')).toBe(true);
  await waitFor(() =>
    expect(qc.getQueryData<Me>(qk.me)?.preferences).toEqual({ enterSends: false, sounds: false, sound: 'soft', browserNotifications: 'never' }),
  );
});

function renderPage(preferences: UserPreferences) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  qc.setQueryData(qk.me, { ...ME, preferences });
  render(
    <QueryClientProvider client={qc}>
      <PreferencesSettings />
    </QueryClientProvider>,
  );
}

it('Som da notificação: the select saves the sound and Ouvir plays the one selected', async () => {
  renderPage({ ...DEFAULT_PREFERENCES });
  const select = screen.getByLabelText('Som da notificação') as HTMLSelectElement;
  expect(select.value).toBe('soft');
  expect([...select.options].map((o) => o.text)).toEqual(['Suave', 'Gota', 'Sino']);

  fireEvent.change(select, { target: { value: 'bell' } });
  await waitFor(() => expect(calls.map((c) => c.body)).toEqual([{ sound: 'bell' }]));
  await waitFor(() => expect(select.value).toBe('bell'));
  fireEvent.click(screen.getByRole('button', { name: 'Ouvir' }));
  expect(playSound).toHaveBeenCalledWith('bell');
});

it('Som da notificação is disabled while Sons is off', () => {
  renderPage({ ...DEFAULT_PREFERENCES, sounds: false });
  expect((screen.getByLabelText('Som da notificação') as HTMLSelectElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Ouvir' }) as HTMLButtonElement).disabled).toBe(true);
});
