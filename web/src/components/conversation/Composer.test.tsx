// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MessageDto, QuickAnswerDto } from '@talk/shared';
import { qk, type TimelineData } from '../../lib/api';
import { Composer, SIGNATURE_KEY } from './Composer';

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

function message(over: Partial<MessageDto> = {}): MessageDto {
  return {
    id: 'm-new', chatId: 'c1', direction: 'out', kind: 'text', body: 'x', media: null, mediaUnavailable: false,
    authorId: 'u1', authorName: 'Ana', authorAvatarUrl: null, replyTo: null, reaction: null, status: 'pending', error: null,
    sentAt: '2026-10-14T12:00:00.000Z', ...over,
  };
}

const qa = (id: string, name: string, body: string): QuickAnswerDto => ({
  id, name, body, hasAttachment: false, visibility: 'all', ownerId: null,
});

const ANSWERS = [qa('qa1', 'Boas-vindas', 'Seja bem-vinda, {{contato.primeiro_nome}}!'), qa('qa2', 'Documentos pendentes', 'Faltam papéis.')];

function renderComposer(replyTo: MessageDto | null = null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData<TimelineData>(qk.timeline('c1'), { pages: [[]], pageParams: [undefined] });
  const onClearReply = vi.fn();
  const view = render(
    <QueryClientProvider client={qc}>
      <Composer chatId="c1" replyTo={replyTo} onClearReply={onClearReply} />
    </QueryClientProvider>,
  );
  return { ...view, qc, onClearReply };
}

const box = () => screen.getByRole('textbox') as HTMLTextAreaElement;
const posts = (path: string) => calls.filter((c) => c.method === 'POST' && c.path === path);

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Composer', () => {
  it('Enter sends the text with the signature on by default, clears the box and adds the message to the timeline', async () => {
    stubFetch({ 'POST /api/chats/c1/messages': message() });
    const { qc } = renderComposer();
    fireEvent.change(box(), { target: { value: 'Olá, tudo bem?' } });
    expect(fireEvent.keyDown(box(), { key: 'Enter' })).toBe(false); // default (newline) prevented

    await waitFor(() => expect(box().value).toBe(''));
    expect(posts('/api/chats/c1/messages').map((c) => c.body)).toEqual([{ text: 'Olá, tudo bem?', signature: true }]);
    expect(qc.getQueryData<TimelineData>(qk.timeline('c1'))!.pages[0]!.map((i) => i.id)).toEqual(['m-new']);
  });

  it('Shift+Enter keeps the newline and sends nothing', () => {
    stubFetch({});
    renderComposer();
    fireEvent.change(box(), { target: { value: 'linha 1' } });
    expect(fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true })).toBe(true); // not prevented → browser inserts \n
    expect(calls).toEqual([]);
  });

  it('sends replyToId and clears the reply chip', async () => {
    stubFetch({ 'POST /api/chats/c1/messages': message() });
    const { onClearReply } = renderComposer(message({ id: 'm9', direction: 'in', body: 'Pergunta do cliente', status: 'read' }));
    expect(screen.getByText(/Pergunta do cliente/)).toBeTruthy();
    fireEvent.change(box(), { target: { value: 'Resposta' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(onClearReply).toHaveBeenCalled());
    expect(posts('/api/chats/c1/messages')[0]!.body).toEqual({ text: 'Resposta', signature: true, replyToId: 'm9' });
  });

  it('"/" opens the quick answer picker, filters by name and inserts the rendered text without sending', async () => {
    stubFetch({
      'GET /api/quick-answers': ANSWERS,
      'POST /api/quick-answers/qa2/render': { text: 'Olá Maria, faltam os documentos.' },
    });
    renderComposer();
    fireEvent.change(box(), { target: { value: '/' } });
    expect(await screen.findByRole('option', { name: /Boas-vindas/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /Documentos pendentes/ })).toBeTruthy();

    fireEvent.change(box(), { target: { value: '/DOCU' } }); // case-insensitive
    await waitFor(() => expect(screen.queryByRole('option', { name: /Boas-vindas/ })).toBeNull());
    fireEvent.click(screen.getByRole('option', { name: /Documentos pendentes/ }));

    await waitFor(() => expect(box().value).toBe('Olá Maria, faltam os documentos.'));
    expect(posts('/api/quick-answers/qa2/render').map((c) => c.body)).toEqual([{ chatId: 'c1' }]);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(posts('/api/chats/c1/messages')).toEqual([]); // §5.7: never sent automatically
  });

  it('Enter inside the picker picks the highlighted answer instead of sending', async () => {
    stubFetch({
      'GET /api/quick-answers': ANSWERS,
      'POST /api/quick-answers/qa1/render': { text: 'Seja bem-vinda, Maria!' },
    });
    renderComposer();
    fireEvent.change(box(), { target: { value: '/boas' } });
    await screen.findByRole('option', { name: /Boas-vindas/ });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(box().value).toBe('Seja bem-vinda, Maria!'));
    expect(posts('/api/chats/c1/messages')).toEqual([]);
  });

  it('notes mode posts to /notes and hides the signature toggle', async () => {
    stubFetch({ 'POST /api/chats/c1/notes': message({ kind: 'note' }) });
    renderComposer();
    fireEvent.click(screen.getByRole('button', { name: 'Notas' }));
    expect(box().placeholder).toMatch(/nota interna/i);
    expect(screen.queryByRole('checkbox', { name: 'Assinatura' })).toBeNull();
    fireEvent.change(box(), { target: { value: 'Cliente pediu retorno amanhã' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(posts('/api/chats/c1/notes').map((c) => c.body)).toEqual([{ text: 'Cliente pediu retorno amanhã' }]));
    expect(posts('/api/chats/c1/messages')).toEqual([]);
  });

  it('persists the signature toggle in localStorage and sends with it', async () => {
    stubFetch({ 'POST /api/chats/c1/messages': message() });
    const first = renderComposer();
    const toggle = screen.getByRole('checkbox', { name: 'Assinatura' }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    expect(localStorage.getItem(SIGNATURE_KEY)).toBe('0');
    first.unmount();

    renderComposer();
    expect((screen.getByRole('checkbox', { name: 'Assinatura' }) as HTMLInputElement).checked).toBe(false);
    fireEvent.change(box(), { target: { value: 'Sem assinatura' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(posts('/api/chats/c1/messages').map((c) => c.body)).toEqual([{ text: 'Sem assinatura', signature: false }]));
  });

  it('clears the box as soon as the send starts and keeps what was typed while it was in flight', async () => {
    let resolve!: (r: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((r) => (resolve = r))));
    const { qc } = renderComposer();
    fireEvent.change(box(), { target: { value: 'Bom dia' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(box().value).toBe('');

    fireEvent.change(box(), { target: { value: 'Seu processo' } });
    resolve(new Response(JSON.stringify(message()), { status: 200, headers: { 'content-type': 'application/json' } }));
    await waitFor(() => expect(qc.getQueryData<TimelineData>(qk.timeline('c1'))!.pages[0]).toHaveLength(1));
    expect(box().value).toBe('Seu processo');
  });

  it('puts the text back when the send fails and the box is still empty', async () => {
    let resolve!: (r: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((r) => (resolve = r))));
    renderComposer();
    fireEvent.change(box(), { target: { value: 'Bom dia' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(box().value).toBe('');

    resolve(new Response(JSON.stringify({ error: 'Falhou' }), { status: 500, headers: { 'content-type': 'application/json' } }));
    await waitFor(() => expect(box().value).toBe('Bom dia'));
  });
});

const BOT_RUNNING = {
  error: 'O chatbot está em execução nesta conversa',
  code: 'BOT_RUNNING',
  runs: [{ id: 'r1', botName: 'Fluxo do escritório' }],
};

/** The first request answers 409 BOT_RUNNING; every later one succeeds with message(). */
function stubBotRunning() {
  calls.length = 0;
  let first = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      calls.push({
        method: init?.method ?? 'GET',
        path: url.pathname,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
      });
      const status = first ? 409 : 200;
      first = false;
      return new Response(JSON.stringify(status === 409 ? BOT_RUNNING : message()), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

describe('Composer with a running chatbot', () => {
  it.each([
    ['Parar e enviar', 'stop'],
    ['Enviar e manter', 'keep'],
  ] as const)('asks on 409 BOT_RUNNING and "%s" resends with botAction "%s"', async (label, botAction) => {
    stubBotRunning();
    const { qc } = renderComposer();
    fireEvent.change(box(), { target: { value: 'Bom dia' } });
    fireEvent.keyDown(box(), { key: 'Enter' });

    const dialog = await screen.findByRole('dialog', { name: 'O chatbot está rodando' });
    expect(dialog.textContent).toContain('Fluxo do escritório');
    expect(screen.queryByRole('alert')).toBeNull(); // the 409 is a question, not an error
    fireEvent.click(screen.getByRole('button', { name: label }));

    await waitFor(() => expect(qc.getQueryData<TimelineData>(qk.timeline('c1'))!.pages[0]).toHaveLength(1));
    expect(posts('/api/chats/c1/messages').map((c) => c.body)).toEqual([
      { text: 'Bom dia', signature: true },
      { text: 'Bom dia', signature: true, botAction },
    ]);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('"Cancelar" sends nothing more and puts the text back', async () => {
    stubBotRunning();
    renderComposer();
    fireEvent.change(box(), { target: { value: 'Bom dia' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await screen.findByRole('dialog', { name: 'O chatbot está rodando' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));

    await waitFor(() => expect(box().value).toBe('Bom dia'));
    expect(posts('/api/chats/c1/messages')).toHaveLength(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

});
