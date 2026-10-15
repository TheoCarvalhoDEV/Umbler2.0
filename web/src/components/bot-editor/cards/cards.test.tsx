// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { BLOCK_TYPES, catalogEntry, defaultConfig, type BlockType, type BotDto, type BotNode, type BotPatch } from '@talk/shared';
import type { EditorCatalog } from '../useEditorCatalog';
import { BlockConfigCard } from './index';

const bot: BotDto = {
  id: 'b-self', name: 'Fluxo do escritório', description: '', status: 'paused', startChannelIds: [], manualStart: false,
  manualTitle: '', manualUnlisted: false, publishedVersionId: null, publishedVersionNumber: null, latestVersionNumber: 1,
  runCount: 0, activeRunCount: 0, createdAt: '2026-10-15T12:00:00.000Z', updatedAt: '2026-10-15T12:00:00.000Z',
};

const catalog: EditorCatalog = {
  sectors: [
    { id: 's-fin', name: 'Financeiro', position: 1, isDefault: false },
    { id: 's-jur', name: 'Jurídico', position: 2, isDefault: false },
  ],
  users: [
    { id: 'u-ana', name: 'Ana Financeiro', email: 'ana@teste.local', role: 'agent', signature: null, active: true, sectorIds: ['s-fin'], avatarUrl: null },
    { id: 'u-old', name: 'Inativo', email: 'old@teste.local', role: 'agent', signature: null, active: false, sectorIds: [], avatarUrl: null },
  ],
  tags: [{ id: 't-vip', name: 'VIP', emoji: null, color: 'blue', position: 0 }],
  customFields: [{ id: 'f-cpf', name: 'CPF', kind: 'cpf', position: 0 }],
  channels: [{ id: 'ch-1', name: 'WhatsApp escritório', status: 'connected', phone: null }],
  bots: [bot, { ...bot, id: 'b-other', name: 'Segunda via de boleto', status: 'active', publishedVersionId: 'v-1', publishedVersionNumber: 1 }],
};

let last: Record<string, unknown> = {};
let botPatches: BotPatch[] = [];

function Harness({ type, config }: { type: BlockType; config?: Record<string, unknown> }) {
  const [cfg, setCfg] = useState<Record<string, unknown>>(config ?? (defaultConfig(type) as unknown as Record<string, unknown>));
  const node: BotNode = { id: 'n1', type, position: { x: 0, y: 0 }, config: cfg, name: type };
  return (
    <BlockConfigCard
      node={node}
      catalog={catalog}
      bot={bot}
      problems={[]}
      onChange={(c) => {
        last = c;
        setCfg(c);
      }}
      onBotChange={(p) => botPatches.push(p)}
    />
  );
}

const renderCard = (type: BlockType, config?: Record<string, unknown>) => render(<Harness type={type} config={config} />);
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  last = {};
  botPatches = [];
});

describe('BlockConfigCard', () => {
  it('renders every block type with its default config and description', () => {
    expect(BLOCK_TYPES).toHaveLength(33);
    for (const type of BLOCK_TYPES) {
      const { unmount } = renderCard(type);
      screen.getByText(catalogEntry(type).description);
      unmount();
    }
  });

  it('lists the problems of the block', () => {
    render(
      <BlockConfigCard
        node={{ id: 'n1', type: 'transfer_sector', position: { x: 0, y: 0 }, config: {}, name: 'setor' }}
        catalog={catalog}
        bot={bot}
        problems={['Escolha o setor de destino']}
        onChange={() => {}}
        onBotChange={() => {}}
      />,
    );
    expect(screen.getByRole('alert').textContent).toBe('Escolha o setor de destino');
  });

  it('send_message: inserts a variable at the cursor of the text', () => {
    renderCard('send_message', { text: 'Olá !', attachment: null, signature: false });
    (screen.getByLabelText('Mensagem') as HTMLTextAreaElement).setSelectionRange(4, 4);
    fireEvent.click(button('Inserir variável em Mensagem'));
    fireEvent.click(button('Primeiro nome do contato'));
    expect(last.text).toBe('Olá {{contato.primeiro_nome}}!');

    fireEvent.click(button('Campo: CPF'));
    expect(last.text).toBe('Olá {{contato.primeiro_nome}}{{campo.CPF}}!');
  });

  it('send_message: uploads an attachment to the bot media library and can remove it', async () => {
    const calls: Array<{ method: string; path: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ method: init?.method ?? 'GET', path: new URL(String(input), 'http://localhost').pathname });
        return new Response(JSON.stringify({ path: 'bots/abc.pdf', name: 'tabela.pdf', mime: 'application/pdf', size: 3 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    renderCard('send_message');
    fireEvent.change(screen.getByLabelText('Arquivo'), {
      target: { files: [new File(['abc'], 'tabela.pdf', { type: 'application/pdf' })] },
    });

    await screen.findByText('tabela.pdf');
    expect(calls).toEqual([{ method: 'POST', path: '/api/bots/media' }]);
    expect(last.attachment).toEqual({ path: 'bots/abc.pdf', name: 'tabela.pdf', mime: 'application/pdf', size: 3 });

    fireEvent.click(button('Remover arquivo'));
    expect(last.attachment).toBeNull();
  });

  it('ask_choice: adds numbered options, edits and removes them, and keeps at least one', () => {
    renderCard('ask_choice');
    fireEvent.change(screen.getByLabelText('Opção 1: texto'), { target: { value: 'Atendimento' } });
    fireEvent.click(button('Adicionar opção'));
    fireEvent.click(button('Adicionar opção'));
    fireEvent.change(screen.getByLabelText('Opção 3: texto'), { target: { value: 'Processos' } });
    expect(last.options).toEqual([
      { key: '1', label: 'Atendimento' },
      { key: '2', label: '' },
      { key: '3', label: 'Processos' },
    ]);

    fireEvent.click(button('Remover opção 2'));
    expect(last.options).toEqual([
      { key: '1', label: 'Atendimento' },
      { key: '3', label: 'Processos' },
    ]);

    fireEvent.change(screen.getByLabelText('Opção 2: número'), { target: { value: ' 2 ' } });
    expect(last.options).toEqual([
      { key: '1', label: 'Atendimento' },
      { key: '2', label: 'Processos' },
    ]);

    fireEvent.click(button('Remover opção 2'));
    expect(button('Remover opção 1').disabled).toBe(true);
  });

  it('ask_choice: the timeout toggle sets 24 h, clamps to 720 h and clears to null; retries are 0..3', () => {
    renderCard('ask_choice');
    fireEvent.click(screen.getByLabelText('Limitar tempo de espera'));
    expect(last.timeoutHours).toBe(24);

    fireEvent.change(screen.getByLabelText('Horas sem resposta'), { target: { value: '9999' } });
    expect(last.timeoutHours).toBe(720);

    fireEvent.click(screen.getByLabelText('Limitar tempo de espera'));
    expect(last.timeoutHours).toBeNull();
    expect(screen.queryByLabelText('Horas sem resposta')).toBeNull();

    fireEvent.change(screen.getByLabelText('Tentativas extras'), { target: { value: '3' } });
    expect(last.invalidRetries).toBe(3);
  });

  it('ask_input: switching the validator shows its own fields and drops the others', () => {
    renderCard('ask_input');
    expect(screen.queryByLabelText('Expressão regular')).toBeNull();

    fireEvent.change(screen.getByLabelText('Tipo de resposta'), { target: { value: 'regex' } });
    expect(last.regex).toBe('');
    fireEvent.change(screen.getByLabelText('Expressão regular'), { target: { value: '[0-9' } });
    screen.getByText('Expressão inválida');
    fireEvent.change(screen.getByLabelText('Expressão regular'), { target: { value: '^\\d{5}$' } });
    expect(screen.queryByText('Expressão inválida')).toBeNull();
    expect(last.regex).toBe('^\\d{5}$');

    fireEvent.change(screen.getByLabelText('Tipo de resposta'), { target: { value: 'media' } });
    expect('regex' in last).toBe(false);
    expect(last.mediaTypes).toEqual([]);
    fireEvent.click(screen.getByLabelText('PDF'));
    expect(last.mediaTypes).toEqual(['pdf']);

    fireEvent.change(screen.getByLabelText('Tipo de resposta'), { target: { value: 'cpf' } });
    expect(last.validator).toBe('cpf');
    expect('mediaTypes' in last).toBe(false);
    expect('regex' in last).toBe(false);

    fireEvent.change(screen.getByLabelText('Salvar no campo'), { target: { value: 'f-cpf' } });
    expect(last.saveToField).toBe('f-cpf');
    fireEvent.change(screen.getByLabelText('Salvar no campo'), { target: { value: '' } });
    expect(last.saveToField).toBeNull();
  });

  it('multi_condition: edits rules per case, hides the right side for "está vazio", adds and removes cases', () => {
    renderCard('multi_condition');
    fireEvent.change(screen.getByLabelText('Caso 1 · Regra 1: esquerda: valor'), { target: { value: 'menu' } });
    fireEvent.change(screen.getByLabelText('Caso 1 · Regra 1: direita: valor'), { target: { value: '1' } });

    fireEvent.click(button('Caso 1 · Adicionar regra'));
    fireEvent.change(screen.getByLabelText('Caso 1 · Regra 2: esquerda: tipo'), { target: { value: 'field' } });
    fireEvent.change(screen.getByLabelText('Caso 1 · Regra 2: esquerda: valor'), { target: { value: 'f-cpf' } });
    fireEvent.change(screen.getByLabelText('Caso 1 · Regra 2: operador'), { target: { value: 'empty' } });
    expect(screen.queryByLabelText('Caso 1 · Regra 2: direita: valor')).toBeNull();
    fireEvent.change(screen.getByLabelText('Caso 1 · Combinar regras'), { target: { value: 'or' } });

    fireEvent.click(button('Adicionar caso'));
    fireEvent.change(screen.getByLabelText('Caso 2: nome'), { target: { value: 'Financeiro' } });

    expect(last).toEqual({
      cases: [
        {
          label: 'Caso 1',
          logic: 'or',
          rules: [
            { left: { kind: 'var', value: 'menu' }, operator: 'eq', right: { kind: 'literal', value: '1' } },
            { left: { kind: 'field', value: 'f-cpf' }, operator: 'empty' },
          ],
        },
        {
          label: 'Financeiro',
          logic: 'and',
          rules: [{ left: { kind: 'var', value: '' }, operator: 'eq', right: { kind: 'literal', value: '' } }],
        },
      ],
    });

    fireEvent.change(screen.getByLabelText('Caso 1 · Regra 2: operador'), { target: { value: 'neq' } });
    expect((last.cases as Array<{ rules: unknown[] }>)[0]!.rules[1]).toEqual({
      left: { kind: 'field', value: 'f-cpf' },
      operator: 'neq',
      right: { kind: 'literal', value: '' },
    });

    fireEvent.click(button('Caso 1 · Remover regra 2'));
    expect(button('Caso 1 · Remover regra 1').disabled).toBe(true);

    fireEvent.click(button('Remover caso 1'));
    expect((last.cases as Array<{ label: string }>).map((c) => c.label)).toEqual(['Financeiro']);
    expect(button('Remover caso 1').disabled).toBe(true);
  });

  it('hours: edits times, toggles days and adds or removes intervals', () => {
    renderCard('hours');
    fireEvent.change(screen.getByLabelText('Intervalo 1: fim'), { target: { value: '12:00' } });
    fireEvent.click(button('Adicionar intervalo'));
    fireEvent.change(screen.getByLabelText('Intervalo 2: início'), { target: { value: '14:00' } });
    fireEvent.click(screen.getByLabelText('Intervalo 2: Sexta'));
    expect(last.intervals).toEqual([
      { from: '08:00', to: '12:00', days: ['mon', 'tue', 'wed', 'thu', 'fri'] },
      { from: '14:00', to: '18:00', days: ['mon', 'tue', 'wed', 'thu'] },
    ]);
    expect(last.timezone).toBe('America/Cuiaba');

    // checking the weekend too means every day, so `days` is dropped
    fireEvent.click(screen.getByLabelText('Intervalo 1: Sábado'));
    fireEvent.click(screen.getByLabelText('Intervalo 1: Domingo'));
    expect((last.intervals as unknown[])[0]).toEqual({ from: '08:00', to: '12:00' });

    fireEvent.click(button('Remover intervalo 2'));
    expect(last.intervals).toEqual([{ from: '08:00', to: '12:00' }]);
    expect(button('Remover intervalo 1').disabled).toBe(true);
  });

  it('hours: never leaves an interval without a day', () => {
    renderCard('hours', { timezone: 'America/Cuiaba', intervals: [{ from: '08:00', to: '12:00', days: ['mon'] }] });
    fireEvent.click(screen.getByLabelText('Intervalo 1: Segunda'));
    expect(last).toEqual({});
    expect((screen.getByLabelText('Intervalo 1: Segunda') as HTMLInputElement).checked).toBe(true);
  });

  it('distribute: shows each share and keeps weights as integers ≥ 1, with 2 to 10 branches', () => {
    renderCard('distribute');
    expect(screen.getAllByText('50%')).toHaveLength(2);

    fireEvent.change(screen.getByLabelText('Caminho 2: peso'), { target: { value: '3' } });
    screen.getByText('25%');
    screen.getByText('75%');

    fireEvent.change(screen.getByLabelText('Caminho 1: peso'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('Caminho 2: peso'), { target: { value: '2.7' } });
    expect(last.branches).toEqual([
      { label: 'A', weight: 1 },
      { label: 'B', weight: 2 },
    ]);
    expect(button('Remover caminho 1').disabled).toBe(true);

    for (let i = 0; i < 8; i++) fireEvent.click(button('Adicionar caminho'));
    expect((last.branches as Array<{ label: string }>).map((b) => b.label)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']);
    expect(button('Adicionar caminho').disabled).toBe(true);

    fireEvent.click(button('Remover caminho 1'));
    expect(last.branches as unknown[]).toHaveLength(9);
  });

  it('message_contains: one keyword per line, blank lines ignored, text kept as typed', () => {
    renderCard('message_contains');
    fireEvent.change(screen.getByLabelText('Palavras ou frases'), { target: { value: 'boleto\n\n 2ª via \n' } });
    expect(last).toEqual({ keywords: ['boleto', '2ª via'], match: 'any' });
    expect((screen.getByLabelText('Palavras ou frases') as HTMLTextAreaElement).value).toBe('boleto\n\n 2ª via \n');
  });

  it('transfer_agent: lists active users for "specific" and sectors for "least_busy"', () => {
    renderCard('transfer_agent');
    expect(screen.queryByLabelText('Inativo')).toBeNull();
    fireEvent.click(screen.getByLabelText('Ana Financeiro'));
    fireEvent.change(screen.getByLabelText('Como escolher o atendente'), { target: { value: 'least_busy' } });
    fireEvent.click(screen.getByLabelText('Jurídico'));
    expect(last).toEqual({ rule: 'least_busy', userIds: ['u-ana'], sectorIds: ['s-jur'] });
  });

  it('call_flow: lists the other bots only', () => {
    renderCard('call_flow');
    const select = screen.getByLabelText('Fluxo') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['Escolha o fluxo…', 'Segunda via de boleto']);
    fireEvent.change(select, { target: { value: 'b-other' } });
    fireEvent.click(screen.getByLabelText('Voltar para este fluxo quando o outro terminar'));
    expect(last).toEqual({ botId: 'b-other', continueAfter: true });
  });

  it('start_channel: picks the channels on the bot, not on the block', () => {
    renderCard('start_channel');
    fireEvent.click(screen.getByLabelText('WhatsApp escritório'));
    expect(botPatches.at(-1)).toEqual({ startChannelIds: ['ch-1'] });
    expect((screen.getByLabelText('WhatsApp escritório') as HTMLInputElement).checked).toBe(true);
    expect(last).toEqual({});
  });

  it('start_manual: reports the cumulative bot patch', () => {
    renderCard('start_manual');
    fireEvent.click(screen.getByLabelText('Permitir que atendentes iniciem pela conversa'));
    fireEvent.change(screen.getByLabelText('Título no painel'), { target: { value: 'Segunda via' } });
    expect(botPatches.at(-1)).toEqual({ manualStart: true, manualTitle: 'Segunda via' });
  });
});
