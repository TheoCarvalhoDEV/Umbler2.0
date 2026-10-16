// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryRouter } from 'react-router';
import type { BotDto, BotGraph, BotVersionDto, BotVersionSummaryDto } from '@talk/shared';
import { BotEditor } from './BotEditor';

// React Flow measures nodes through ResizeObserver/offsetWidth and reads the zoom through DOMMatrixReadOnly; jsdom has neither.
class ResizeObserverStub {
  constructor(private readonly cb: ResizeObserverCallback) {}
  observe(target: Element) {
    const { offsetWidth: width, offsetHeight: height } = target as HTMLElement; // XYPanZoom reads contentRect
    this.cb([{ target, contentRect: { width, height } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve() {}
  disconnect() {}
}
class DOMMatrixReadOnlyStub {
  m22: number;
  constructor(transform?: string) {
    const scale = transform?.match(/scale\(([\d.]+)\)/)?.[1];
    this.m22 = scale ? Number(scale) : 1;
  }
}
Object.defineProperties(HTMLElement.prototype, {
  offsetHeight: { configurable: true, get(this: HTMLElement) { return parseFloat(this.style.height) || 100; } },
  offsetWidth: { configurable: true, get(this: HTMLElement) { return parseFloat(this.style.width) || 280; } },
});
(SVGElement.prototype as unknown as { getBBox(): DOMRect }).getBBox = () => ({ x: 0, y: 0, width: 0, height: 0 }) as DOMRect;

const bot: BotDto = {
  id: 'b1', name: 'Fluxo teste', description: '', status: 'paused', startChannelIds: [], manualStart: false, manualTitle: '',
  manualUnlisted: false, publishedVersionId: null, publishedVersionNumber: null, latestVersionNumber: 2, runCount: 0,
  activeRunCount: 0, createdAt: '2026-10-15T12:00:00.000Z', updatedAt: '2026-10-15T12:00:00.000Z',
};
const graph: BotGraph = {
  nodes: [
    { id: 'n1', type: 'start_channel', position: { x: 0, y: 0 }, config: {}, name: 'inicio' },
    {
      id: 'n2', type: 'ask_choice', position: { x: 350, y: 0 }, name: 'menu',
      config: { text: 'Escolha', options: [{ key: '1', label: 'Atendimento' }, { key: '2', label: 'Financeiro' }], invalidRetries: 1, timeoutHours: null },
    },
    { id: 'n3', type: 'send_message', position: { x: 700, y: 0 }, name: 'mensagem', config: { text: 'Olá', attachment: null, signature: false } },
  ],
  edges: [{ id: 'e1', source: 'n1', sourceHandle: 'next', target: 'n2' }],
};
const oldGraph: BotGraph = {
  nodes: [
    { id: 'old1', type: 'start_manual', position: { x: 0, y: 0 }, config: {}, name: 'inicio' },
    { id: 'old2', type: 'note', position: { x: 350, y: 0 }, config: { text: 'antiga' }, name: 'nota' },
  ],
  edges: [{ id: 'oe1', source: 'old1', sourceHandle: 'next', target: 'old2' }],
};
const summary = (n: number, extra: Partial<BotVersionSummaryDto> = {}): BotVersionSummaryDto => ({
  id: `v${n}`, botId: 'b1', number: n, valid: true, label: null, createdByName: 'Admin Teste',
  createdAt: '2026-10-15T12:00:00.000Z', published: false, ...extra,
});
const version: BotVersionDto = { ...summary(2), graph, problems: [] };

type Reply = { status?: number; body?: unknown };
let routes: Record<string, Reply>;
const calls: Array<{ method: string; path: string; body: unknown }> = [];

beforeEach(() => {
  calls.length = 0;
  routes = {
    'GET /api/sectors': { body: [] },
    'GET /api/users': { body: [] },
    'GET /api/tags': { body: [] },
    'GET /api/custom-fields': { body: [] },
    'GET /api/channels': { body: [] },
    'GET /api/bots': { body: [bot] },
    'GET /api/bots/b1/versions': { body: [summary(2), summary(1, { published: true })] },
    'GET /api/bots/b1/versions/1': { body: { ...summary(1, { published: true }), graph: oldGraph, problems: [] } },
  };
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  vi.stubGlobal('DOMMatrixReadOnly', DOMMatrixReadOnlyStub);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    calls.push({ method, path: url.pathname, body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body });
    const reply = routes[`${method} ${url.pathname}`];
    if (!reply) return new Response(JSON.stringify({ error: 'inesperado' }), { status: 500 });
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderEditor(initial: BotVersionDto = version) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const router = createMemoryRouter(
    [
      { path: '/configuracoes/chatbots/:id', element: <BotEditor bot={bot} initial={initial} /> },
      { path: '/configuracoes/chatbots', element: <p>Lista de chatbots</p> },
    ],
    { initialEntries: ['/configuracoes/chatbots/b1'] },
  );
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const blockCount = () => document.querySelectorAll('.react-flow__node').length;
const block = (id: string) => document.querySelector(`[data-testid="block-${id}"]`);

it('draws one source handle per output, labelled from outputsOf, and no input on start blocks', async () => {
  renderEditor();
  expect(await screen.findByText('1 · Atendimento')).toBeTruthy();
  expect(screen.getByText('2 · Financeiro')).toBeTruthy();
  expect(screen.getByText('Resposta inválida')).toBeTruthy();
  const handles = [...document.querySelectorAll('[data-nodeid="n2"][data-handleid]')].map((h) => h.getAttribute('data-handleid'));
  expect(handles).toEqual(['opt:1', 'opt:2', 'invalid', 'error']);
  expect(document.querySelector('[data-nodeid="n2"].react-flow__handle.target')).not.toBeNull();
  expect(document.querySelector('[data-nodeid="n1"].react-flow__handle.target')).toBeNull();
  expect(screen.getByRole('link', { name: 'Exportar' }).getAttribute('href')).toBe('/api/bots/b1/export');
});

it('inserts a block from the palette and undoes and redoes it', async () => {
  renderEditor();
  await screen.findByText('1 · Atendimento');
  expect(blockCount()).toBe(3);
  expect((screen.getByRole('button', { name: 'Desfazer' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Condição' }));
  await waitFor(() => expect(blockCount()).toBe(4));
  expect(screen.getByText('Alterações não salvas')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Desfazer' }));
  await waitFor(() => expect(blockCount()).toBe(3));
  expect(screen.queryByText('Alterações não salvas')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Refazer' }));
  await waitFor(() => expect(blockCount()).toBe(4));
});

it('deletes a block from its card and refuses a second channel start', async () => {
  renderEditor();
  fireEvent.click(await screen.findByLabelText('Excluir bloco Enviar mensagem'));
  await waitFor(() => expect(blockCount()).toBe(2));
  fireEvent.click(screen.getByRole('button', { name: 'Iniciar por um canal' }));
  expect(screen.getByRole('alert').textContent).toBe('O fluxo já tem o bloco "Iniciar por um canal".');
  expect(blockCount()).toBe(2);
});

it('toggles the palette with Tab', async () => {
  renderEditor();
  await screen.findByText('1 · Atendimento');
  expect(screen.getByRole('complementary', { name: 'Paleta de blocos' })).toBeTruthy();
  fireEvent.keyDown(document.body, { key: 'Tab' });
  expect(screen.queryByRole('complementary', { name: 'Paleta de blocos' })).toBeNull();
  fireEvent.keyDown(document.body, { key: 'Tab' });
  expect(screen.getByRole('complementary', { name: 'Paleta de blocos' })).toBeTruthy();
});

it('publishes and highlights the problems the server reports, keeping the saved draft', async () => {
  routes['POST /api/bots/b1/versions'] = {
    status: 400,
    body: {
      error: 'O fluxo tem problemas',
      problems: [
        { nodeId: 'n3', message: 'Bloco sem entrada' },
        { nodeId: null, message: 'Algo no fluxo inteiro' },
      ],
    },
  };
  renderEditor();
  fireEvent.click(await screen.findByRole('button', { name: 'Condição' })); // an unsaved change
  await waitFor(() => expect(screen.getByText('Alterações não salvas')).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: 'Salvar e publicar' }));
  expect(await screen.findByText('O fluxo tem problemas e não foi publicado. O rascunho foi salvo.')).toBeTruthy();
  const sent = calls.find((c) => c.method === 'POST' && c.path === '/api/bots/b1/versions')?.body as { graph: BotGraph; publish: boolean };
  expect(sent.publish).toBe(true);
  expect(sent.graph.nodes.map((n) => n.type)).toEqual(['start_channel', 'ask_choice', 'send_message', 'condition']);
  expect(screen.getByText('2 problemas')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'mensagem: Bloco sem entrada' })).toBeTruthy();
  expect(screen.getByText('Algo no fluxo inteiro')).toBeTruthy();
  await waitFor(() => expect(block('n3')?.getAttribute('data-invalid')).toBe('true'));
  expect(block('n2')?.getAttribute('data-invalid')).toBeNull();
  expect(screen.queryByText('Alterações não salvas')).toBeNull();
});

it('saves a draft, sending the pending name first', async () => {
  routes['PATCH /api/bots/b1'] = { body: { ...bot, name: 'Novo nome' } };
  routes['POST /api/bots/b1/versions'] = { body: { ...summary(3), graph, problems: [] } };
  renderEditor();
  const name = await screen.findByRole('textbox', { name: 'Nome do chatbot' });
  fireEvent.change(name, { target: { value: 'Novo nome' } });
  fireEvent.blur(name);
  expect(screen.getByText('Alterações não salvas')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Salvar rascunho' }));
  expect(await screen.findByText('Rascunho salvo (versão 3).')).toBeTruthy();
  const writes = calls.filter((c) => c.method !== 'GET');
  expect(writes.map((c) => `${c.method} ${c.path}`)).toEqual(['PATCH /api/bots/b1', 'POST /api/bots/b1/versions']);
  expect(writes[0]!.body).toEqual({ name: 'Novo nome' });
  expect(writes[1]!.body).toEqual({ graph, publish: false });
  expect(screen.queryByText('Alterações não salvas')).toBeNull();
});

it('activates the bot', async () => {
  routes['POST /api/bots/b1/status'] = { body: { ...bot, status: 'active' } };
  renderEditor();
  fireEvent.click(await screen.findByRole('button', { name: 'Ativar' }));
  await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/bots/b1/status')).toBe(true));
  expect(calls.find((c) => c.path === '/api/bots/b1/status')?.body).toEqual({ status: 'active' });
});

it('views an old version read-only and restores it as a draft', async () => {
  renderEditor();
  fireEvent.click(await screen.findByRole('button', { name: 'Versões' }));
  expect(await screen.findByText('Versão 1')).toBeTruthy();
  fireEvent.click(screen.getAllByRole('button', { name: 'Visualizar' })[1]!);
  expect(await screen.findByText('Visualizando a versão 1 (somente leitura).')).toBeTruthy();
  await waitFor(() => expect(block('old2')).not.toBeNull());
  expect(block('n2')).toBeNull();
  expect((screen.getByRole('button', { name: 'Salvar rascunho' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Voltar à edição' }));
  await waitFor(() => expect(block('n2')).not.toBeNull());
  fireEvent.click(screen.getAllByRole('button', { name: 'Restaurar como rascunho' })[1]!);
  expect(await screen.findByText('Versão 1 restaurada. Salve para criar um novo rascunho.')).toBeTruthy();
  await waitFor(() => expect(block('old2')).not.toBeNull());
  expect(screen.getByText('Alterações não salvas')).toBeTruthy();
});

it('asks before leaving with unsaved changes', async () => {
  const confirm = vi.fn(() => false);
  vi.stubGlobal('confirm', confirm);
  renderEditor();
  fireEvent.click(await screen.findByRole('button', { name: 'Condição' }));
  fireEvent.click(screen.getByRole('link', { name: 'Voltar para a lista de chatbots' }));
  await waitFor(() => expect(confirm).toHaveBeenCalledWith('Há alterações não salvas. Sair mesmo assim?'));
  expect(screen.queryByText('Lista de chatbots')).toBeNull();
  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByRole('link', { name: 'Voltar para a lista de chatbots' }));
  expect(await screen.findByText('Lista de chatbots')).toBeTruthy();
});

/** Types `ch` at the caret like a keyboard would: native value setter (past React's tracker), caret after it, then input. */
function typeAt(el: HTMLInputElement | HTMLTextAreaElement, at: number, ch: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  el.focus();
  el.setSelectionRange(at, at);
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, el.value.slice(0, at) + ch + el.value.slice(at));
  el.setSelectionRange(at + 1, at + 1);
  fireEvent.input(el);
}

it('keeps the caret where the user types in a block field', async () => {
  renderEditor();
  await screen.findByText('1 · Atendimento');
  const name = block('n2')!.querySelector('input')!;
  typeAt(name, 2, 'X');
  expect(name.value).toBe('meXnu');
  expect(name.selectionStart).toBe(3);
  const text = block('n3')!.querySelector('textarea')!;
  typeAt(text, 1, 'X');
  expect(text.value).toBe('OXlá');
  expect(text.selectionStart).toBe(2);
  await waitFor(() => expect(screen.getByText('Alterações não salvas')).toBeTruthy());
  expect(name.value).toBe('meXnu');
  expect(text.value).toBe('OXlá');
});
