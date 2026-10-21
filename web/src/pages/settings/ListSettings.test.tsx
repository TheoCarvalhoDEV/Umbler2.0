// @vitest-environment jsdom
// The four list pages in the "Mensageiro" look: Setores, Etiquetas, Campos personalizados, Respostas rápidas.
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CustomFieldDto, Me, QuickAnswerDto, SectorDto, TagDto } from '@talk/shared';
import { qk } from '../../lib/api';
import { confirmDialog, promptDialog } from '../../lib/confirm';
import { CustomFieldsSettings } from './CustomFieldsSettings';
import { QuickAnswersSettings } from './QuickAnswersSettings';
import { SectorsSettings } from './SectorsSettings';
import { TagsSettings } from './TagsSettings';

vi.mock('../../lib/confirm', () => ({ confirmDialog: vi.fn(), promptDialog: vi.fn() }));

// jsdom has no modal <dialog> API; the browser opens ChatDialogs' Modal with showModal()
HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
  this.setAttribute('open', '');
};

const ME = (role: Me['role']): Me => ({ id: 'u1', name: 'Ana', email: 'ana@teste.local', role, signature: null, sectorIds: [], seeAllSectors: false, avatarUrl: null });

type Call = { method: string; path: string; body: unknown };
const calls: Call[] = [];
let served: Record<string, unknown> = {}; // what GET /api/<key> answers, so the refetch after a save keeps the rows
const mutations = () => calls.filter((c) => c.method !== 'GET');

function renderPage(page: ReactElement, data: Array<[readonly string[], unknown]>, role: Me['role'] = 'admin') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  qc.setQueryData(qk.me, ME(role));
  served = {};
  for (const [key, value] of data) {
    qc.setQueryData(key, value);
    served[`/api/${key[0]}`] = value;
  }
  return render(<QueryClientProvider client={qc}>{page}</QueryClientProvider>);
}

beforeEach(() => {
  calls.length = 0;
  vi.mocked(confirmDialog).mockReset();
  vi.mocked(promptDialog).mockReset();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      const path = new URL(String(input), 'http://localhost').pathname;
      calls.push({ method: init?.method ?? 'GET', path, body });
      return new Response(JSON.stringify(served[path] ?? []), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const menu = (name: string) => fireEvent.click(screen.getByRole('button', { name }));

describe('Setores', () => {
  const sectors: SectorDto[] = [
    { id: 's1', name: 'Atendimento', position: 0, isDefault: true, openChats: 3 },
    { id: 's2', name: 'Financeiro', position: 1, isDefault: false, openChats: 1 },
  ];
  const render_ = () => renderPage(<SectorsSettings />, [[qk.sectors, sectors]]);

  it('lists the sectors with number, Padrão badge and open chats; the first cannot go up nor the default be deleted', () => {
    render_();
    screen.getByRole('heading', { name: 'Setores' });
    screen.getByText('3 conversas abertas');
    screen.getByText('1 conversa aberta');
    expect(screen.getAllByText('Padrão')).toHaveLength(1);
    expect((screen.getByRole('button', { name: 'Subir Atendimento' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Descer Financeiro' }) as HTMLButtonElement).disabled).toBe(true);

    menu('Opções do setor Atendimento');
    expect(screen.queryByRole('button', { name: 'Definir como padrão' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Excluir' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('moves a sector by renumbering the rows that changed', async () => {
    render_();
    fireEvent.click(screen.getByRole('button', { name: 'Subir Financeiro' }));
    await waitFor(() => expect(mutations()).toHaveLength(2));
    expect(mutations()).toEqual([
      { method: 'PATCH', path: '/api/sectors/s2', body: { position: 0 } },
      { method: 'PATCH', path: '/api/sectors/s1', body: { position: 1 } },
    ]);
  });

  it('creates, makes default, renames and deletes through the menu and the dialogs', async () => {
    render_();
    vi.mocked(promptDialog).mockResolvedValueOnce('Jurídico');
    fireEvent.click(screen.getByRole('button', { name: 'Novo setor' }));
    await waitFor(() => expect(mutations()).toEqual([{ method: 'POST', path: '/api/sectors', body: { name: 'Jurídico' } }]));

    menu('Opções do setor Financeiro');
    fireEvent.click(screen.getByRole('button', { name: 'Definir como padrão' }));
    await waitFor(() => expect(mutations().at(-1)).toEqual({ method: 'PATCH', path: '/api/sectors/s2', body: { isDefault: true } }));

    vi.mocked(promptDialog).mockResolvedValueOnce('Cobrança');
    menu('Opções do setor Financeiro');
    fireEvent.click(screen.getByRole('button', { name: 'Renomear' }));
    await waitFor(() => expect(mutations().at(-1)).toEqual({ method: 'PATCH', path: '/api/sectors/s2', body: { name: 'Cobrança' } }));

    vi.mocked(confirmDialog).mockResolvedValueOnce(true);
    menu('Opções do setor Financeiro');
    fireEvent.click(screen.getByRole('button', { name: 'Excluir' }));
    await waitFor(() => expect(mutations().at(-1)).toEqual({ method: 'DELETE', path: '/api/sectors/s2', body: undefined }));
    expect(vi.mocked(confirmDialog).mock.calls[0]![0].title).toBe('Excluir o setor "Financeiro"?');
  });
});

describe('Etiquetas', () => {
  const tags: TagDto[] = [{ id: 't1', name: 'Cliente VIP', emoji: '⭐', color: '#16a34a', position: 0 }];

  it('shows an empty state when there are no tags', () => {
    renderPage(<TagsSettings />, [[qk.tags, []]]);
    screen.getByText('Nenhuma etiqueta ainda');
  });

  it('creates a tag in a dialog', async () => {
    renderPage(<TagsSettings />, [[qk.tags, tags]]);
    screen.getByText('Cliente VIP');
    fireEvent.click(screen.getByRole('button', { name: 'Nova etiqueta' }));
    const dialog = screen.getByRole('dialog', { name: 'Nova etiqueta' });
    expect(dialog).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Urgente' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(mutations()[0]).toEqual({ method: 'POST', path: '/api/tags', body: { name: 'Urgente', emoji: null, color: expect.any(String) } }));
    await waitFor(() => expect(screen.queryByLabelText('Nome')).toBeNull());
  });

  it('edits and deletes from the menu', async () => {
    renderPage(<TagsSettings />, [[qk.tags, tags]]);
    menu('Opções da etiqueta Cliente VIP');
    fireEvent.click(screen.getByRole('button', { name: 'Editar' }));
    expect((screen.getByLabelText('Nome') as HTMLInputElement).value).toBe('Cliente VIP');
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'VIP' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(mutations()[0]).toEqual({ method: 'PATCH', path: '/api/tags/t1', body: { name: 'VIP', emoji: '⭐', color: '#16a34a' } }));

    vi.mocked(confirmDialog).mockResolvedValueOnce(true);
    menu('Opções da etiqueta Cliente VIP');
    fireEvent.click(screen.getByRole('button', { name: 'Excluir' }));
    await waitFor(() => expect(mutations().at(-1)).toEqual({ method: 'DELETE', path: '/api/tags/t1', body: undefined }));
  });
});

describe('Campos personalizados', () => {
  const fields: CustomFieldDto[] = [
    { id: 'f1', name: 'Documento', kind: 'cpf', position: 0 },
    { id: 'f2', name: 'Prazo', kind: 'date', position: 1 },
  ];

  it('lists the fields with their type and an empty state when there are none', () => {
    const { unmount } = renderPage(<CustomFieldsSettings />, [[qk.customFields, fields]]);
    screen.getByText('Documento');
    screen.getByText('CPF');
    screen.getByText('Data');
    unmount();
    renderPage(<CustomFieldsSettings />, [[qk.customFields, []]]);
    screen.getByText('Nenhum campo personalizado');
  });

  it('creates a field with name and type, and only enables the button with a name', async () => {
    renderPage(<CustomFieldsSettings />, [[qk.customFields, fields]]);
    fireEvent.click(screen.getByRole('button', { name: 'Novo campo' }));
    const create = screen.getByRole('button', { name: 'Criar campo' }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Nome do campo'), { target: { value: ' Nº do processo ' } });
    fireEvent.change(screen.getByLabelText('Tipo'), { target: { value: 'number' } });
    expect(create.disabled).toBe(false);
    fireEvent.click(create);
    await waitFor(() => expect(mutations()).toEqual([{ method: 'POST', path: '/api/custom-fields', body: { name: 'Nº do processo', kind: 'number' } }]));
    await waitFor(() => expect(screen.queryByLabelText('Nome do campo')).toBeNull());
  });

  it('renames and deletes from the menu', async () => {
    renderPage(<CustomFieldsSettings />, [[qk.customFields, fields]]);
    vi.mocked(promptDialog).mockResolvedValueOnce('Documento do titular');
    menu('Opções do campo Documento');
    fireEvent.click(screen.getByRole('button', { name: 'Renomear' }));
    await waitFor(() => expect(mutations()).toEqual([{ method: 'PATCH', path: '/api/custom-fields/f1', body: { name: 'Documento do titular' } }]));

    vi.mocked(confirmDialog).mockResolvedValueOnce(true);
    menu('Opções do campo Prazo');
    fireEvent.click(screen.getByRole('button', { name: 'Excluir' }));
    await waitFor(() => expect(mutations().at(-1)).toEqual({ method: 'DELETE', path: '/api/custom-fields/f2', body: undefined }));
  });
});

describe('Respostas rápidas', () => {
  const qa = (over: Partial<QuickAnswerDto>): QuickAnswerDto => ({ id: 'q1', name: 'Boas-vindas', body: 'Olá!\nComo posso ajudar?', hasAttachment: false, visibility: 'all', ownerId: null, ...over });
  const answers = [qa({}), qa({ id: 'q2', name: 'Pix', body: 'Chave: 123', visibility: 'owner', ownerId: 'u1', hasAttachment: true }), qa({ id: 'q3', name: 'Segredo', body: 'Texto reservado', visibility: 'owner', ownerId: 'u9' })];
  const data: Array<[readonly string[], unknown]> = [[qk.quickAnswers, answers], [qk.customFields, []]];

  it('shows /name, visibility, attachment and the message; an agent only gets the menu on their own answers', () => {
    renderPage(<QuickAnswersSettings />, data, 'agent');
    screen.getByText('/Boas-vindas');
    screen.getByText('Olá! Como posso ajudar?');
    screen.getByText('Para todos');
    screen.getByText('Apenas para mim');
    screen.getByText('Particular de outro atendente');
    screen.getByLabelText('Com anexo');
    expect(screen.getAllByRole('button', { name: /^Opções da resposta rápida/ }).map((b) => b.getAttribute('aria-label'))).toEqual([
      'Opções da resposta rápida /Pix',
    ]);
  });

  it('an admin edits any answer in a dialog and deletes it from the menu', async () => {
    renderPage(<QuickAnswersSettings />, data);
    menu('Opções da resposta rápida /Segredo');
    fireEvent.click(screen.getByRole('button', { name: 'Editar' }));
    screen.getByRole('dialog', { name: 'Editar resposta rápida' });
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Sigilo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(mutations()[0]).toEqual({ method: 'PATCH', path: '/api/quick-answers/q3', body: { name: 'Sigilo', body: 'Texto reservado', visibility: 'owner' } }));

    vi.mocked(confirmDialog).mockResolvedValueOnce(true);
    menu('Opções da resposta rápida /Boas-vindas');
    fireEvent.click(screen.getByRole('button', { name: 'Excluir' }));
    await waitFor(() => expect(mutations().at(-1)).toEqual({ method: 'DELETE', path: '/api/quick-answers/q1', body: undefined }));
  });

  it('shows an empty state with no answers', () => {
    renderPage(<QuickAnswersSettings />, [[qk.quickAnswers, []], [qk.customFields, []]]);
    screen.getByText('Nenhuma resposta rápida');
  });
});
