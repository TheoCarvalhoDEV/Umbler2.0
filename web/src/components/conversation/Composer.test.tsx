// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DEFAULT_PREFERENCES, type Me, type MessageDto, type QuickAnswerDto } from '@talk/shared';
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
  vi.useRealTimers();
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

  it('Agendar mensagem asks for a text first, then schedules it with the signature choice and clears the box (spec 2026-10-20 agendamentos §3.1)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-20T12:00:00.000Z'));
    stubFetch({ 'POST /api/chats/c1/scheduled-messages': {} });
    const { onClearReply } = renderComposer(message({ id: 'q1' }));

    fireEvent.click(screen.getByRole('button', { name: 'Agendar mensagem' }));
    expect(screen.getByRole('alert').textContent).toBe('Digite a mensagem que será agendada');

    fireEvent.change(box(), { target: { value: 'Lembrete da audiência' } });
    fireEvent.click(screen.getByRole('button', { name: 'Agendar mensagem' }));
    expect((screen.getByLabelText('Texto da mensagem') as HTMLTextAreaElement).value).toBe('Lembrete da audiência');
    fireEvent.change(screen.getByLabelText('Data e hora (horário de Cuiabá)'), { target: { value: '2026-10-21T09:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Agendar' }));

    await waitFor(() => expect(posts('/api/chats/c1/scheduled-messages')).toHaveLength(1));
    expect(posts('/api/chats/c1/scheduled-messages')[0]!.body).toEqual({
      text: 'Lembrete da audiência', sendAt: '2026-10-21T13:00:00.000Z', signature: true,
    });
    await waitFor(() => expect(box().value).toBe('')); // box() throws while the dialog's textarea is a second textbox
    expect(posts('/api/chats/c1/messages')).toEqual([]);
    expect(onClearReply).toHaveBeenCalledTimes(1); // the "Respondendo:" quote goes too
  });

  it('Shift+Enter keeps the newline and sends nothing', () => {
    stubFetch({});
    renderComposer();
    fireEvent.change(box(), { target: { value: 'linha 1' } });
    expect(fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true })).toBe(true); // not prevented → browser inserts \n
    expect(calls).toEqual([]);
  });

  it('with "Enter envia a mensagem" off, Enter breaks the line and Ctrl+Enter sends (spec 2026-10-19 §6)', async () => {
    stubFetch({ 'POST /api/chats/c1/messages': message() });
    const { qc } = renderComposer();
    const me: Me = {
      id: 'u1', name: 'Ana', email: 'ana@teste.local', role: 'agent', signature: null, sectorIds: [], seeAllSectors: false,
      avatarUrl: null, preferences: { ...DEFAULT_PREFERENCES, enterSends: false },
    };
    qc.setQueryData(qk.me, me);
    fireEvent.change(box(), { target: { value: 'linha 1' } });
    expect(fireEvent.keyDown(box(), { key: 'Enter' })).toBe(true); // not prevented → the browser breaks the line
    expect(posts('/api/chats/c1/messages')).toEqual([]);
    expect(fireEvent.keyDown(box(), { key: 'Enter', ctrlKey: true })).toBe(false);
    await waitFor(() => expect(posts('/api/chats/c1/messages').map((c) => c.body)).toEqual([{ text: 'linha 1', signature: true }]));
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
    fireEvent.click(screen.getByRole('button', { name: 'Nota interna' }));
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

  it('the robot button toggles the "Executar chatbot" panel', async () => {
    stubFetch({ 'GET /api/bots/manual': [{ id: 'b1', title: 'Fluxo do escritório' }], 'GET /api/chats/c1/bot-runs': [] });
    renderComposer();
    expect(screen.queryByText('Executar chatbot')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Chatbot' }));
    expect(await screen.findByRole('button', { name: 'Fluxo do escritório' })).toBeTruthy();
    expect(screen.getByText('Executar chatbot')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Chatbot' }));
    expect(screen.queryByText('Executar chatbot')).toBeNull();
  });

  it('a click anywhere else or Escape closes the open panel, and opening another panel closes the first', async () => {
    stubFetch({ 'GET /api/bots/manual': [], 'GET /api/chats/c1/bot-runs': [], 'GET /api/stickers/recent': [] });
    renderComposer();
    fireEvent.click(screen.getByRole('button', { name: 'Chatbot' }));
    expect(await screen.findByText('Executar chatbot')).toBeTruthy();
    fireEvent.pointerDown(screen.getByText('Executar chatbot')); // inside the panel: stays open
    expect(screen.getByText('Executar chatbot')).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByText('Executar chatbot')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Emoji' }));
    expect(screen.getByRole('button', { name: '😀' })).toBeTruthy();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Chatbot' }));
    fireEvent.click(screen.getByRole('button', { name: 'Chatbot' }));
    expect(screen.queryByRole('button', { name: '😀' })).toBeNull();
    expect(await screen.findByText('Executar chatbot')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText('Executar chatbot')).toBeNull();
  });

  it('a click outside the box closes the "/" quick answer picker; a click in the box keeps it', async () => {
    stubFetch({ 'GET /api/quick-answers': ANSWERS });
    renderComposer();
    fireEvent.change(box(), { target: { value: '/' } });
    expect(await screen.findByRole('option', { name: /Boas-vindas/ })).toBeTruthy();
    fireEvent.pointerDown(box());
    expect(screen.getByRole('option', { name: /Boas-vindas/ })).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(box().value).toBe('/');
  });
});

describe('Composer stickers', () => {
  it('sends a recent sticker by id', async () => {
    stubFetch({
      'GET /api/stickers/recent': [{ messageId: 's1', url: '/api/media/s1' }],
      'POST /api/chats/c1/messages': message({ kind: 'sticker', body: null }),
    });
    renderComposer();
    fireEvent.click(screen.getByRole('button', { name: 'Figurinhas' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Enviar figurinha' }));
    await waitFor(() => expect(posts('/api/chats/c1/messages')).toHaveLength(1));
    expect(posts('/api/chats/c1/messages')[0]!.body).toEqual({ stickerFromMessageId: 's1' });
  });

  it('sends a picked image as a sticker and refuses a file over 1 MB', async () => {
    stubFetch({ 'GET /api/stickers/recent': [], 'POST /api/chats/c1/messages': message({ kind: 'sticker', body: null }) });
    renderComposer();
    fireEvent.click(screen.getByRole('button', { name: 'Figurinhas' }));
    expect(await screen.findByText('Nenhuma figurinha ainda.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Enviar imagem como figurinha' })).toBeTruthy();
    const input = screen.getByLabelText('Imagem para figurinha');

    fireEvent.change(input, { target: { files: [new File([new Uint8Array(1024 * 1024 + 1)], 'grande.png', { type: 'image/png' })] } });
    expect(screen.getByRole('alert').textContent).toBe('Envie uma imagem PNG, JPEG ou WebP de até 1 MB');
    expect(posts('/api/chats/c1/messages')).toHaveLength(0);

    fireEvent.change(input, { target: { files: [new File(['png'], 'fig.png', { type: 'image/png' })] } });
    await waitFor(() => expect(posts('/api/chats/c1/messages')).toHaveLength(1));
    const form = posts('/api/chats/c1/messages')[0]!.body as FormData;
    expect(form.get('asSticker')).toBe('true');
    expect((form.get('file') as File).name).toBe('fig.png');
  });

  it('has no sticker button in note mode', () => {
    stubFetch({});
    renderComposer();
    fireEvent.click(screen.getByRole('button', { name: 'Nota interna' }));
    expect(screen.queryByRole('button', { name: 'Figurinhas' })).toBeNull();
  });
});
