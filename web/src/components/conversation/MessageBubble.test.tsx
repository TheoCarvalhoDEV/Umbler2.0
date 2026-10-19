// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Me, MessageDto } from '@talk/shared';
import { qk } from '../../lib/api';
import { confirmDialog } from '../../lib/confirm';
import { MessageBubble } from './MessageBubble';

vi.mock('../../lib/confirm', () => ({ confirmDialog: vi.fn(async () => true) }));

// jsdom has no modal <dialog> API; the browser opens ChatDialogs' Modal with showModal()
HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
  this.setAttribute('open', '');
};

type Call = { method: string; path: string; body: unknown };
const calls: Call[] = [];

function stubFetch(routes: Record<string, unknown>) {
  calls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init?.method ?? 'GET';
      calls.push({ method, path: url.pathname, body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body });
      const key = `${method} ${url.pathname}`;
      if (!(key in routes)) return new Response(JSON.stringify({ error: 'inesperado' }), { status: 500 });
      return new Response(JSON.stringify(routes[key]), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const base: MessageDto = {
  id: 'm1', chatId: 'c1', direction: 'out', kind: 'text', body: 'Olá', media: null, mediaUnavailable: false,
  authorId: 'u1', authorName: 'Ana Lima', authorAvatarUrl: '/api/users/u1/avatar?v=abc', replyTo: null, reaction: null,
  status: 'sent', error: null, sentAt: '2026-10-15T12:00:00.000Z',
};

const ME: Me = {
  id: 'u1', name: 'Ana Lima', email: 'ana@teste.local', role: 'agent', signature: null, sectorIds: [], seeAllSectors: false, avatarUrl: null,
};

function renderBubble(m: MessageDto, opts: { chatOpen?: boolean } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(qk.me, ME);
  return render(
    <QueryClientProvider client={qc}>
      <MessageBubble m={m} onReply={() => {}} chatOpen={opts.chatOpen ?? false} />
    </QueryClientProvider>,
  ).container;
}

describe('MessageBubble author avatar', () => {
  it('shows the agent picture next to messages sent by an agent', () => {
    expect(renderBubble(base).querySelector('img')?.getAttribute('src')).toBe('/api/users/u1/avatar?v=abc');
  });

  it('falls back to the agent initials without a picture', () => {
    const c = renderBubble({ ...base, authorAvatarUrl: null });
    expect(c.querySelector('img')).toBeNull();
    expect(c.querySelector('[data-author-avatar]')?.textContent).toBe('AL');
  });

  it('shows no author avatar on incoming messages or phone/system sends', () => {
    expect(renderBubble({ ...base, direction: 'in', authorId: null, authorName: null, authorAvatarUrl: null }).querySelector('[data-author-avatar]')).toBeNull();
    expect(renderBubble({ ...base, authorId: null, authorName: null, authorAvatarUrl: null }).querySelector('[data-author-avatar]')).toBeNull();
  });
});

describe('MessageBubble chatbot messages', () => {
  const system = { ...base, authorId: null, authorName: null, authorAvatarUrl: null };

  it('labels a message sent by a chatbot run with the robot icon and "Chatbot <nome>"', () => {
    const c = renderBubble({ ...system, botRunId: 'r1', botName: 'Fluxo do escritório' });
    expect(c.textContent).toContain('Chatbot Fluxo do escritório');
    expect(c.textContent).not.toContain('Celular ou sistema');
    expect(c.querySelector('[data-bot-icon]')).not.toBeNull();
    expect(c.querySelector('[data-author-avatar]')).toBeNull();
  });

  it('keeps the phone/system label and no robot when the message has no bot', () => {
    const c = renderBubble({ ...system, botRunId: null, botName: null });
    expect(c.textContent).toContain('Celular ou sistema');
    expect(c.querySelector('[data-bot-icon]')).toBeNull();
  });

  it('never shows the robot on an incoming message', () => {
    const c = renderBubble({ ...system, direction: 'in', botName: 'Fluxo do escritório' });
    expect(c.querySelector('[data-bot-icon]')).toBeNull();
    expect(c.textContent).not.toContain('Chatbot');
  });
});

describe('MessageBubble tags and reactions', () => {
  it('keeps a deleted message visible with who deleted it', () => {
    const c = renderBubble({ ...base, direction: 'in', authorId: null, deleted: { at: base.sentAt, source: 'contact', byName: null } });
    expect(c.textContent).toContain('Olá');
    expect(c.querySelector('[data-tag="deleted"]')?.textContent).toBe('Apagada pelo contato');
    const mine = renderBubble({ ...base, id: 'm2', deleted: { at: base.sentAt, source: 'office', byName: 'Ana Lima' } });
    expect(mine.querySelector('[data-tag="deleted"]')?.textContent).toBe('Apagada por Ana Lima');
  });

  it('shows Encaminhada and both reactions, the contact one and the office one', () => {
    const c = renderBubble({ ...base, forwarded: true, reaction: '👍', officeReaction: '❤️' });
    expect(c.querySelector('[data-tag="forwarded"]')?.textContent).toContain('Encaminhada');
    expect(screen.getByLabelText('Reação do contato 👍')).toBeTruthy();
    expect(screen.getByLabelText('Reação do escritório ❤️')).toBeTruthy();
    expect(renderBubble({ ...base, id: 'm3' }).querySelector('[data-tag]')).toBeNull();
  });

  it('opens the previous versions from the edited tag', async () => {
    stubFetch({
      'GET /api/messages/m1/edits': [
        { id: 'e1', previousBody: 'Olá!', source: 'office', editedByName: 'Ana Lima', newTextUnavailable: false, editedAt: '2026-10-15T12:01:00.000Z' },
      ],
    });
    renderBubble({ ...base, edited: { at: base.sentAt, source: 'contact', newTextUnavailable: true } });
    fireEvent.click(screen.getByRole('button', { name: 'editada pelo contato (novo texto indisponível)' }));
    expect(await screen.findByText('Olá!')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Versões anteriores' })).toBeTruthy();
    expect(calls).toEqual([{ method: 'GET', path: '/api/messages/m1/edits', body: undefined }]);
  });
});

describe('MessageBubble action menu', () => {
  const recent = { ...base, sentAt: new Date(Date.now() - 60_000).toISOString() };
  const ago = (ms: number) => ({ ...base, sentAt: new Date(Date.now() - ms).toISOString() });
  const openMenu = () => fireEvent.click(screen.getByRole('button', { name: 'Ações da mensagem' }));
  const labels = () => screen.getAllByRole('menuitem').map((b) => b.firstChild?.textContent);
  const item = (name: string) => screen.getByRole('menuitem', { name: new RegExp(`^${name}`) }) as HTMLButtonElement;

  it('offers every action on my recent text in an open chat', () => {
    renderBubble(recent, { chatOpen: true });
    openMenu();
    expect(labels()).toEqual(['Reagir', 'Responder', 'Encaminhar', 'Copiar', 'Editar', 'Apagar para todos']);
    expect(screen.getAllByRole('menuitem').every((b) => !(b as HTMLButtonElement).disabled)).toBe(true);
  });

  it('keeps expired actions, disabled, with the hint', () => {
    renderBubble(ago(20 * 60_000), { chatOpen: true });
    openMenu();
    expect(item('Editar').disabled).toBe(true);
    expect(item('Editar').textContent).toBe('EditarSó até 15 min após o envio');
    expect(item('Apagar para todos').disabled).toBe(false);
    cleanup();
    renderBubble(ago(49 * 3_600_000), { chatOpen: true });
    openMenu();
    expect(item('Apagar para todos').disabled).toBe(true);
    expect(screen.getByText('Só até 48 h após o envio')).toBeTruthy();
  });

  it('leaves out what does not apply: inbound, deleted and closed-chat messages', () => {
    renderBubble({ ...recent, direction: 'in', authorId: null, authorName: null, authorAvatarUrl: null }, { chatOpen: true });
    openMenu();
    expect(labels()).toEqual(['Reagir', 'Responder', 'Encaminhar', 'Copiar']);
    cleanup();
    renderBubble({ ...recent, deleted: { at: recent.sentAt, source: 'office', byName: 'Ana Lima' } }, { chatOpen: true });
    openMenu();
    expect(labels()).toEqual(['Copiar']);
    cleanup();
    renderBubble(recent, { chatOpen: false });
    openMenu();
    expect(labels()).toEqual(['Copiar']);
  });

  it('reacts with a quick emoji', async () => {
    stubFetch({ 'POST /api/messages/m1/reaction': { ...recent, officeReaction: '👍' } });
    renderBubble(recent, { chatOpen: true });
    openMenu();
    fireEvent.click(item('Reagir'));
    fireEvent.click(screen.getByRole('button', { name: 'Reagir com 👍' }));
    await waitFor(() => expect(calls).toEqual([{ method: 'POST', path: '/api/messages/m1/reaction', body: { emoji: '👍' } }]));
  });

  it('reacts with another emoji typed or picked in the box, one only', async () => {
    stubFetch({ 'POST /api/messages/m1/reaction': { ...recent, officeReaction: '🎉' } });
    renderBubble(recent, { chatOpen: true });
    openMenu();
    fireEvent.click(item('Reagir'));
    const box = screen.getByLabelText('Outro emoji');
    fireEvent.change(box, { target: { value: 'abc' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(screen.getByRole('alert').textContent).toBe('Escolha um emoji');
    fireEvent.change(box, { target: { value: '🎉🎉' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(calls).toEqual([{ method: 'POST', path: '/api/messages/m1/reaction', body: { emoji: '🎉' } }]));
  });

  it('asks before deleting for everyone, with the spec text', async () => {
    stubFetch({ 'DELETE /api/messages/m1': { ...recent, deleted: { at: recent.sentAt, source: 'office', byName: 'Ana Lima' } } });
    renderBubble(recent, { chatOpen: true });
    openMenu();
    fireEvent.click(item('Apagar para todos'));
    await waitFor(() => expect(calls).toEqual([{ method: 'DELETE', path: '/api/messages/m1', body: undefined }]));
    expect(confirmDialog).toHaveBeenCalledWith({
      title: 'Apagar para todos?', body: 'O contato deixa de ver esta mensagem.', confirmLabel: 'Apagar para todos',
    });
  });

  it('edits in place: Esc cancels, Enter saves', async () => {
    stubFetch({ 'PATCH /api/messages/m1': { ...recent, body: 'Olá, tudo bem?' } });
    renderBubble(recent, { chatOpen: true });
    openMenu();
    fireEvent.click(item('Editar'));
    const box = () => screen.getByLabelText('Editar mensagem') as HTMLTextAreaElement;
    expect(box().value).toBe('Olá');
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(screen.queryByLabelText('Editar mensagem')).toBeNull();

    openMenu();
    fireEvent.click(item('Editar'));
    fireEvent.change(box(), { target: { value: 'Olá, tudo bem?' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(screen.queryByLabelText('Editar mensagem')).toBeNull());
    expect(calls).toEqual([{ method: 'PATCH', path: '/api/messages/m1', body: { text: 'Olá, tudo bem?' } }]);
  });

  it('opens the forward dialog', () => {
    renderBubble(recent, { chatOpen: true });
    openMenu();
    fireEvent.click(item('Encaminhar'));
    expect(screen.getByRole('dialog', { name: 'Encaminhar mensagem' })).toBeTruthy();
  });
});

describe('MessageBubble media that is not on the server', () => {
  const missing: MessageDto = {
    ...base, direction: 'in', kind: 'image', body: null, media: null, mediaUnavailable: true,
    authorId: null, authorName: null, authorAvatarUrl: null,
  };

  it('says the file is gone from WhatsApp and offers no download', () => {
    const c = renderBubble({ ...missing, mediaExpired: true });
    expect(c.textContent).toContain('Arquivo não está mais disponível no WhatsApp');
    expect(screen.queryByRole('button', { name: 'Baixar' })).toBeNull();
  });

  it('"Baixar" asks the server for a file that is not downloaded yet', async () => {
    stubFetch({
      'POST /api/messages/m1/media': {
        ...missing, media: { url: '/api/media/m1', mime: 'image/png', name: null, size: 70 }, mediaUnavailable: false,
      },
    });
    renderBubble({ ...missing, mediaExpired: false });

    fireEvent.click(screen.getByRole('button', { name: 'Baixar' }));

    await waitFor(() => expect(calls).toContainEqual({ method: 'POST', path: '/api/messages/m1/media', body: undefined }));
  });
});
