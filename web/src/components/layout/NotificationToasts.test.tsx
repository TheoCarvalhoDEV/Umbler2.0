// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { DEFAULT_PREFERENCES, type BrowserNotificationMode, type Me, type NotificationDto } from '@talk/shared';
import { qk } from '../../lib/api';
import { connectWs } from '../../lib/ws';
import { NotificationToasts, TOAST_MS } from './NotificationToasts';

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

class FakeNotification {
  static permission: NotificationPermission = 'default';
  static instances: FakeNotification[] = [];
  onclick: (() => void) | null = null;
  closed = false;
  constructor(public title: string, public options?: NotificationOptions) {
    FakeNotification.instances.push(this);
  }
  close() {
    this.closed = true;
  }
}

const NOTE: NotificationDto = {
  id: 'n1', chatId: 'c1', title: 'Nova conversa', text: 'Nova conversa de Maria — CPF 123.456.789-09',
  botName: 'Fluxo do escritório', createdAt: '2026-10-15T12:00:00.000Z',
};

let stopWs: () => void = () => {};

const ME: Me = {
  id: 'u1', name: 'Ana Lima', email: 'ana@teste.local', role: 'agent', signature: null, sectorIds: [], seeAllSectors: false, avatarUrl: null,
};

/** `mode`: the user's "Notificações do navegador" (spec 2026-10-19 §6); 'always' keeps the older tests' meaning. */
function setup(permission: NotificationPermission, mode: BrowserNotificationMode = 'always') {
  vi.useFakeTimers();
  FakeNotification.permission = permission;
  FakeNotification.instances = [];
  vi.stubGlobal('WebSocket', FakeWs);
  vi.stubGlobal('Notification', FakeNotification);
  vi.spyOn(window, 'focus').mockImplementation(() => {}); // jsdom: window.focus is "not implemented"
  stopWs = connectWs(new QueryClient(), 'ws://test/ws');
  const qc = new QueryClient();
  qc.setQueryData(qk.me, { ...ME, preferences: { ...DEFAULT_PREFERENCES, browserNotifications: mode } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/chats']}>
        <NotificationToasts />
        <Routes>
          <Route path="/chats" element={<p>Lista</p>} />
          <Route path="/chats/:id" element={<p>Conversa aberta</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function emit(ev: unknown) {
  act(() => {
    FakeWs.instances[0]!.onmessage!({ data: JSON.stringify(ev) });
  });
}

afterEach(() => {
  cleanup();
  stopWs();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  FakeWs.instances = [];
});

describe('NotificationToasts', () => {
  it('shows the title, text and bot name for 8 seconds, without a browser notification when not allowed', () => {
    setup('default');
    emit({ type: 'notification', notification: NOTE });
    expect(screen.getByText('Nova conversa')).toBeTruthy();
    expect(screen.getByText(NOTE.text)).toBeTruthy();
    expect(screen.getByText('Chatbot Fluxo do escritório')).toBeTruthy();
    expect(FakeNotification.instances).toHaveLength(0);

    act(() => {
      vi.advanceTimersByTime(TOAST_MS - 1);
    });
    expect(screen.queryByText('Nova conversa')).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByText('Nova conversa')).toBeNull();
  });

  it('ignores other WebSocket events', () => {
    setup('granted');
    emit({ type: 'chat.removed', chatId: 'c9' });
    expect(screen.queryByRole('link')).toBeNull();
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it('clicking the toast opens the chat and closes the toast', () => {
    setup('default');
    emit({ type: 'notification', notification: NOTE });
    fireEvent.click(screen.getByRole('link', { name: /Nova conversa/ }));
    expect(screen.getByText('Conversa aberta')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('also raises a browser notification when allowed; clicking it opens the chat', () => {
    setup('granted');
    emit({ type: 'notification', notification: NOTE });
    expect(FakeNotification.instances).toHaveLength(1);
    const n = FakeNotification.instances[0]!;
    expect(n.title).toBe('Nova conversa');
    expect(n.options?.body).toBe(NOTE.text);

    act(() => {
      n.onclick!();
    });
    expect(screen.getByText('Conversa aberta')).toBeTruthy();
    expect(n.closed).toBe(true);
  });

  it('falls back to a generic title when the block has none', () => {
    setup('granted');
    emit({ type: 'notification', notification: { ...NOTE, id: 'n2', title: '' } });
    expect(screen.getByText('Notificação do chatbot')).toBeTruthy();
    expect(FakeNotification.instances[0]!.title).toBe('Notificação do chatbot');
  });

  it('"Nunca" keeps the toast and skips the browser notification (spec 2026-10-19 §6)', () => {
    setup('granted', 'never');
    emit({ type: 'notification', notification: NOTE });
    expect(screen.getByRole('link')).toBeTruthy();
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it('"Só quando a aba está em segundo plano" skips it while the tab is visible', () => {
    setup('granted', 'background'); // jsdom: document.hidden is false
    emit({ type: 'notification', notification: NOTE });
    expect(FakeNotification.instances).toHaveLength(0);
  });
});
