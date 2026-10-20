// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import type { BulkResultDto, ChannelDto, ChatListItem, Me } from '@talk/shared';
import { confirmDialog } from '../lib/confirm';
import { Inbox } from './Inbox';

vi.mock('../lib/confirm', () => ({ confirmDialog: vi.fn(async () => true) }));

// jsdom has no modal <dialog> API; the browser opens ChatDialogs' Modal with showModal()
HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
  this.setAttribute('open', '');
};

const chatA: ChatListItem = {
  id: 'a',
  contact: { id: 'ct1', name: 'Ana Souza', phone: '5565999991111', avatarUrl: '/api/contacts/ct1/avatar?v=1' },
  channelId: 'ch1',
  sectorId: 's1',
  ownerId: 'u1',
  state: 'open',
  waiting: true,
  private: true,
  unread: 3,
  lastMessageAt: '2026-10-14T12:00:00.000Z',
  lastMessagePreview: 'Bom dia',
  pinned: true,
  tagIds: [],
};
const chatB: ChatListItem = {
  ...chatA,
  id: 'b',
  contact: { id: 'ct2', name: null, phone: '5565999990000', avatarUrl: null },
  ownerId: null,
  private: false,
  unread: 1,
  lastMessagePreview: 'Oi',
  pinned: false,
};

const calls: Array<{ method: string; url: URL; body?: string }> = [];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

let channelsReply: ChannelDto[] = [];
let bulkReply: BulkResultDto = { done: [], failed: [] };
let bulkGate: Promise<void> | null = null;
let chatBSector = 's1';
let withDefaultSector = false;

beforeEach(() => {
  channelsReply = [];
  bulkReply = { done: ['a', 'b'], failed: [] };
  bulkGate = null;
  chatBSector = 's1';
  withDefaultSector = false;
  localStorage.clear();
  calls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: typeof init?.body === 'string' ? init.body : undefined });
    if (url.pathname === '/api/sectors') {
      const s1 = { id: 's1', name: 'Financeiro', position: 1, isDefault: false };
      const others = [{ id: 's0', name: 'Geral', position: 0, isDefault: true }, { id: 's2', name: 'Suporte', position: 2, isDefault: false }];
      return json(withDefaultSector ? [...others, s1] : [s1]);
    }
    if (url.pathname === '/api/users') {
      return json([{ id: 'u1', name: 'Maria Lima', email: 'maria@exemplo.com.br', role: 'agent', signature: null, active: true, sectorIds: ['s1'], avatarUrl: '/api/users/u1/avatar?v=abc' }]);
    }
    if (url.pathname === '/api/tags') return json([]);
    if (url.pathname === '/api/chats/a/pin') return new Response(null, { status: 204 });
    if (url.pathname === '/api/chats/a/unread' && method === 'POST') return new Response(null, { status: 204 });
    if (url.pathname === '/api/chats/a' && method === 'DELETE') return new Response(null, { status: 204 });
    if (url.pathname === '/api/auth/me/view' && method === 'PUT') {
      return json({ ...adminMe, seeAllSectors: JSON.parse(String(init?.body)).seeAllSectors });
    }
    if (url.pathname === '/api/channels') return json(channelsReply);
    if (url.pathname.startsWith('/api/chats/bulk/') && method === 'POST') {
      await bulkGate;
      return json(bulkReply);
    }
    if (url.pathname === '/api/chats') {
      return json({ items: url.searchParams.get('tab') === 'inbox' ? [chatA, { ...chatB, sectorId: chatBSector }] : [], nextCursor: null });
    }
    return json({ error: 'inesperado' }, 500);
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const adminMe: Me = { id: 'adm', name: 'Admin', email: 'adm@exemplo.com.br', role: 'admin', signature: null, sectorIds: ['s1'], seeAllSectors: false, avatarUrl: null };

function Where() {
  const loc = useLocation();
  return <span data-testid="where">{loc.pathname + loc.search}</span>;
}

function renderInbox(me?: Me, path = '/chats') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  if (me) client.setQueryData(['me'], me);
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/chats" element={<Inbox />}>
            <Route path=":id" element={null} />
          </Route>
        </Routes>
        <Where />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

const where = () => screen.getByTestId('where').textContent;
const menuOfA = () => fireEvent.click(screen.getAllByLabelText('Opções da conversa')[0]);

it('renders chat items with preview, unread, owner, sector, lock and pin', async () => {
  renderInbox();
  expect(await screen.findByText('Ana Souza')).toBeTruthy();
  expect(screen.getByText('+55 65 99999-0000')).toBeTruthy();
  expect(screen.getByText('Bom dia')).toBeTruthy();
  expect(screen.getByLabelText('Não lidas: 3')).toBeTruthy();
  expect(screen.getByLabelText('Conversa privada')).toBeTruthy();
  expect(screen.getByLabelText('Fixada')).toBeTruthy();
  expect(screen.getByRole('img', { name: 'Responsável: Maria Lima' })).toBeTruthy();
  expect((await screen.findByTitle('Maria Lima')).querySelector('img')?.getAttribute('src')).toBe('/api/users/u1/avatar?v=abc'); // owner picture
  expect(document.querySelector('img[src="/api/contacts/ct1/avatar?v=1"]')).toBeTruthy(); // contact picture
  expect((await screen.findAllByText('Financeiro')).length).toBe(2);
});

it('shows the unread badge on Entrada and switches to Esperando', async () => {
  renderInbox();
  expect(await screen.findByLabelText('Conversas não lidas: 2')).toBeTruthy();
  fireEvent.click(screen.getByRole('tab', { name: /Esperando/ }));
  expect(await screen.findByText('Nenhuma conversa')).toBeTruthy();
  expect(screen.getByRole('tab', { name: /Esperando/ }).getAttribute('aria-selected')).toBe('true');
});

it('sends the debounced search term as q', async () => {
  renderInbox();
  await screen.findByText('Ana Souza');
  fireEvent.change(screen.getByLabelText('Buscar conversas'), { target: { value: 'ana' } });
  await waitFor(() =>
    expect(calls.some((c) => c.url.pathname === '/api/chats' && c.url.searchParams.get('q') === 'ana')).toBe(true),
  );
});

it('unpins a chat from the item menu', async () => {
  renderInbox();
  await screen.findByText('Ana Souza');
  fireEvent.click(screen.getAllByLabelText('Opções da conversa')[0]);
  fireEvent.click(screen.getByText('Desafixar'));
  await waitFor(() =>
    expect(calls.some((c) => c.method === 'DELETE' && c.url.pathname === '/api/chats/a/pin')).toBe(true),
  );
});

it('lets an admin toggle "Ver todos os setores", updating Me and refetching the chats', async () => {
  const client = renderInbox(adminMe);
  await screen.findByText('Ana Souza');
  const toggle = screen.getByRole('button', { name: 'Ver todos os setores' });
  expect(toggle.getAttribute('aria-pressed')).toBe('false');
  const listCalls = () => calls.filter((c) => c.url.pathname === '/api/chats').length;
  const before = listCalls();

  fireEvent.click(toggle);

  await waitFor(() => expect(toggle.getAttribute('aria-pressed')).toBe('true'));
  const put = calls.find((c) => c.method === 'PUT' && c.url.pathname === '/api/auth/me/view');
  expect(put).toBeTruthy();
  expect(client.getQueryData<Me>(['me'])?.seeAllSectors).toBe(true);
  await waitFor(() => expect(listCalls()).toBeGreaterThan(before));
});

it('does not show the toggle to an agent', async () => {
  renderInbox({ ...adminMe, role: 'agent' });
  await screen.findByText('Ana Souza');
  expect(screen.queryByRole('button', { name: 'Ver todos os setores' })).toBeNull();
});

it('shows an error banner when toggling the view fails', async () => {
  renderInbox(adminMe);
  await screen.findByText('Ana Souza');
  const base = fetch as unknown as (i: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  vi.stubGlobal('fetch', vi.fn(async (i: RequestInfo | URL, init?: RequestInit) =>
    String(i) === '/api/auth/me/view' ? json({ error: 'falhou' }, 500) : base(i, init)));
  fireEvent.click(screen.getByRole('button', { name: 'Ver todos os setores' }));
  expect((await screen.findByRole('alert')).textContent).toBe('Não foi possível alterar a visualização. Tente novamente.');
});

it('a new toggle error replaces an older pin error, and a later success clears the banner', async () => {
  renderInbox(adminMe);
  await screen.findByText('Ana Souza');
  const base = fetch as unknown as (i: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  let viewFails = true;
  vi.stubGlobal('fetch', vi.fn(async (i: RequestInfo | URL, init?: RequestInit) => {
    const path = String(i);
    if (path === '/api/chats/a/pin') return json({ error: 'cheio' }, 409);
    if (path === '/api/auth/me/view' && viewFails) return json({ error: 'falhou' }, 500);
    return base(i, init);
  }));
  fireEvent.click(screen.getAllByLabelText('Opções da conversa')[0]);
  fireEvent.click(screen.getByText('Desafixar'));
  expect((await screen.findByRole('alert')).textContent).toContain('Você já fixou 3 conversas');
  fireEvent.click(screen.getByRole('button', { name: 'Ver todos os setores' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Não foi possível alterar a visualização. Tente novamente.'));
  viewFails = false;
  fireEvent.click(screen.getByRole('button', { name: 'Ver todos os setores' }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
});

it('hints a sectorless admin to enable "Ver todos os setores", even with a non-empty list', async () => {
  renderInbox({ ...adminMe, sectorIds: [] });
  await screen.findByText('Ana Souza');
  expect(screen.getByText(/Você não está em nenhum setor/)).toBeTruthy();
});

it('hides the sectorless hint when the admin sees all sectors', async () => {
  renderInbox({ ...adminMe, sectorIds: [], seeAllSectors: true });
  await screen.findByText('Ana Souza');
  expect(screen.queryByText(/Você não está em nenhum setor/)).toBeNull();
});

it('does not show the sectorless hint to an admin with sectors', async () => {
  renderInbox(adminMe);
  fireEvent.click(await screen.findByRole('tab', { name: /Esperando/ }));
  await screen.findByText('Nenhuma conversa');
  expect(screen.queryByText(/Você não está em nenhum setor/)).toBeNull();
});

it('shows the channel name on the cards when there is more than one channel (§7)', async () => {
  channelsReply = [
    { id: 'ch1', name: 'Escritório', status: 'connected', phone: null },
    { id: 'ch2', name: 'Financeiro WhatsApp', status: 'connected', phone: null },
  ];
  renderInbox(adminMe);
  expect(await screen.findAllByText('Escritório')).toHaveLength(2); // chats a and b are both on ch1
});

it('shows no channel name with a single channel', async () => {
  channelsReply = [{ id: 'ch1', name: 'Escritório', status: 'connected', phone: null }];
  const client = renderInbox(adminMe);
  await screen.findByText('Ana Souza');
  await waitFor(() => expect(client.getQueryData(['channels'])).toHaveLength(1));
  expect(screen.queryByText('Escritório')).toBeNull();
});

it('marks a read chat as unread from the item menu', async () => {
  const base = fetch as unknown as (i: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  vi.stubGlobal('fetch', vi.fn(async (i: RequestInfo | URL, init?: RequestInit) =>
    String(i).startsWith('/api/chats?') ? json({ items: [{ ...chatA, unread: 0 }], nextCursor: null }) : base(i, init)));
  renderInbox(undefined, '/chats/a');
  await screen.findByText('Ana Souza');
  menuOfA();
  fireEvent.click(screen.getByText('Marcar como não lida'));
  await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.pathname === '/api/chats/a/unread')).toBe(true));
  await waitFor(() => expect(where()).toBe('/chats')); // the open pane would mark it read again
});

it('Transferir and Finalizar open the conversation with ?acao', async () => {
  renderInbox();
  await screen.findByText('Ana Souza');
  menuOfA();
  fireEvent.click(screen.getAllByText('Transferir')[0]);
  expect(where()).toBe('/chats/a?acao=transferir');
  menuOfA();
  fireEvent.click(screen.getAllByText('Finalizar')[0]);
  expect(where()).toBe('/chats/a?acao=finalizar');
});

it('only an admin sees "Excluir conversa"', async () => {
  renderInbox({ ...adminMe, role: 'agent' });
  await screen.findByText('Ana Souza');
  expect(screen.queryByText('Excluir conversa')).toBeNull();
});

it('Excluir conversa asks first and sends DELETE; leaves the open pane', async () => {
  renderInbox(adminMe, '/chats/a');
  await screen.findByText('Ana Souza');
  menuOfA();
  fireEvent.click(screen.getAllByText('Excluir conversa')[0]);
  expect(confirmDialog).toHaveBeenCalledWith({
    title: 'Excluir conversa?',
    body: 'A conversa, as mensagens e os arquivos dela saem do sistema para todos. O WhatsApp do contato e o celular não mudam. Não dá para desfazer.',
    confirmLabel: 'Excluir',
  });
  await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url.pathname === '/api/chats/a')).toBe(true));
  await waitFor(() => expect(where()).toBe('/chats'));
});

it('cancelling Excluir conversa sends nothing', async () => {
  vi.mocked(confirmDialog).mockClear().mockResolvedValueOnce(false);
  renderInbox(adminMe);
  await screen.findByText('Ana Souza');
  menuOfA();
  fireEvent.click(screen.getAllByText('Excluir conversa')[0]);
  await waitFor(() => expect(confirmDialog).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 0));
  expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
});

it('sends the chosen order as sort and remembers it for this user (spec 2026-10-20 §3)', async () => {
  renderInbox(adminMe);
  await screen.findByText('Ana Souza');
  const listCalls = () => calls.filter((c) => c.url.pathname === '/api/chats');
  expect(listCalls().every((c) => !c.url.searchParams.has('sort'))).toBe(true); // the default stays out of the query

  fireEvent.change(screen.getByLabelText('Ordenar conversas'), { target: { value: 'waiting' } });

  await waitFor(() => expect(listCalls().some((c) => c.url.searchParams.get('sort') === 'waiting')).toBe(true));
  expect(localStorage.getItem('talk.chatSort.adm')).toBe('waiting');
  cleanup();
  renderInbox(adminMe);
  expect((screen.getByLabelText('Ordenar conversas') as HTMLSelectElement).value).toBe('waiting');
});

it('selects chats and marks them read in bulk; the summary stays after the bar closes (spec 2026-10-20 §4)', async () => {
  renderInbox(adminMe);
  await screen.findByText('Ana Souza');
  fireEvent.click(screen.getByRole('button', { name: 'Selecionar' }));
  expect(screen.queryAllByLabelText('Opções da conversa')).toHaveLength(0);

  fireEvent.click(screen.getByLabelText('Selecionar Ana Souza'));
  fireEvent.click(screen.getByText('+55 65 99999-0000')); // the row toggles too
  expect(screen.getByText('2 selecionadas')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Marcar como lida' }));

  expect((await screen.findByRole('status')).textContent).toBe('2 de 2 concluídas.');
  const post = calls.find((c) => c.url.pathname === '/api/chats/bulk/read');
  expect(JSON.parse(post!.body!)).toEqual({ chatIds: ['a', 'b'] });
  expect(screen.queryByText('2 selecionadas')).toBeNull(); // all done: the selection mode ends
  expect(where()).toBe('/chats'); // nothing was opened
});

it('keeps the chats that failed selected and says why (spec §4)', async () => {
  bulkReply = { done: ['b'], failed: [{ chatId: 'a', error: 'Conversa finalizada' }] };
  renderInbox(adminMe);
  await screen.findByText('Ana Souza');
  fireEvent.click(screen.getByRole('button', { name: 'Selecionar' }));
  fireEvent.click(screen.getByLabelText('Selecionar Ana Souza'));
  fireEvent.click(screen.getByLabelText('Selecionar +55 65 99999-0000'));
  fireEvent.click(screen.getByRole('button', { name: 'Marcar como lida' }));

  expect((await screen.findByRole('status')).textContent).toBe('1 de 2 concluídas; 1 não pôde: Conversa finalizada');
  expect(screen.getByText('1 selecionada')).toBeTruthy();
  expect((screen.getByLabelText('Selecionar Ana Souza') as HTMLInputElement).checked).toBe(true);
});

it('transfers the selection in one request to the chosen sector (spec §4)', async () => {
  renderInbox(adminMe);
  await screen.findByText('Ana Souza');
  fireEvent.click(screen.getByRole('button', { name: 'Selecionar' }));
  fireEvent.click(screen.getByLabelText('Selecionar Ana Souza'));
  fireEvent.click(screen.getByLabelText('Selecionar +55 65 99999-0000'));
  fireEvent.click(screen.getByRole('button', { name: 'Transferir' }));

  const dialog = await screen.findByLabelText('Transferir 2 conversas');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Transferir' }));

  expect((await screen.findByRole('status')).textContent).toBe('2 de 2 concluídas.');
  const post = calls.find((c) => c.url.pathname === '/api/chats/bulk/transfer');
  expect(JSON.parse(post!.body!)).toEqual({ chatIds: ['a', 'b'], sectorId: 's1', ownerId: null });
});

it('Cancelar is disabled while a bulk request runs, and a late result never pre-ticks the next selection', async () => {
  let release!: () => void;
  bulkGate = new Promise((r) => (release = r));
  bulkReply = { done: ['b'], failed: [{ chatId: 'a', error: 'Conversa finalizada' }] };
  renderInbox(adminMe);
  await screen.findByText('Ana Souza');
  fireEvent.click(screen.getByRole('button', { name: 'Selecionar' }));
  fireEvent.click(screen.getByLabelText('Selecionar Ana Souza'));
  fireEvent.click(screen.getByRole('button', { name: 'Marcar como lida' }));
  await waitFor(() => expect((screen.getByRole('button', { name: 'Cancelar' }) as HTMLButtonElement).disabled).toBe(true));

  fireEvent.click(screen.getByRole('button', { name: 'Selecionar' })); // header exit mid-run
  release();
  await screen.findByRole('status');
  fireEvent.click(screen.getByRole('button', { name: 'Selecionar' }));
  expect(screen.getByText('0 selecionadas')).toBeTruthy();
  expect((screen.getByLabelText('Selecionar Ana Souza') as HTMLInputElement).checked).toBe(false);
});

it("bulk transfer starts on the chats' common sector, else on the default sector", async () => {
  withDefaultSector = true;
  renderInbox(adminMe);
  await screen.findByText('Ana Souza');
  fireEvent.click(screen.getByRole('button', { name: 'Selecionar' }));
  fireEvent.click(screen.getByLabelText('Selecionar Ana Souza'));
  fireEvent.click(screen.getByLabelText('Selecionar +55 65 99999-0000'));
  fireEvent.click(screen.getByRole('button', { name: 'Transferir' }));
  const dialog = await screen.findByLabelText('Transferir 2 conversas');
  expect((within(dialog).getByLabelText('Setor') as HTMLSelectElement).value).toBe('s1');
  cleanup();

  chatBSector = 's2'; // mixed sectors: fall back to the default one
  renderInbox(adminMe);
  await screen.findByText('Ana Souza');
  fireEvent.click(screen.getByRole('button', { name: 'Selecionar' }));
  fireEvent.click(screen.getByLabelText('Selecionar Ana Souza'));
  fireEvent.click(screen.getByLabelText('Selecionar +55 65 99999-0000'));
  fireEvent.click(screen.getByRole('button', { name: 'Transferir' }));
  const mixed = await screen.findByLabelText('Transferir 2 conversas');
  expect((within(mixed).getByLabelText('Setor') as HTMLSelectElement).value).toBe('s0');
});
