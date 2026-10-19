import { describe, expect, it } from 'vitest';
import {
  BLOCK_CATALOG,
  BLOCK_CATEGORY_LABELS,
  BLOCK_TYPES,
  EDITOR_HISTORY_LIMIT,
  MAX_FLOW_LEVELS,
  MAX_STEPS_PER_CALL,
  NON_TERMINAL_RUN_STATES,
  STEP_LOG_LIMIT,
  catalogEntry,
  configOf,
  defaultConfig,
  nodeNameFor,
  outputsOf,
  type BlockCategory,
  type BlockType,
  type BotNode,
} from '@talk/shared';

/** "<id>: <label>" per output, in order. */
const outs = (type: BlockType, config: Record<string, unknown>) => outputsOf(type, config).map((o) => `${o.id}: ${o.label}`);

const YES_NO = ['yes: Sim', 'no: Não'];
const NEXT_ERROR = ['next: Próximo', 'error: Se não for possível'];

// Record<BlockType, …> makes `npm run typecheck` fail when a block type has no case here.
const OUTPUT_CASES: Record<BlockType, Array<{ config: Record<string, unknown>; expected: string[] }>> = {
  start_channel: [{ config: {}, expected: ['next: Próximo'] }],
  start_manual: [{ config: {}, expected: ['next: Próximo'] }],
  weekdays: [
    {
      config: { timezone: 'America/Cuiaba' },
      expected: [
        'day:mon: Segunda', 'day:tue: Terça', 'day:wed: Quarta', 'day:thu: Quinta', 'day:fri: Sexta', 'day:sat: Sábado',
        'day:sun: Domingo',
      ],
    },
  ],
  hours: [{ config: { timezone: 'America/Cuiaba', intervals: [] }, expected: ['in: Dentro do horário', 'out: Fora do horário'] }],
  wait_interval: [
    { config: { mode: 'fixed', amount: 5, unit: 'minutes', resumeOnReply: false }, expected: ['next: Depois do tempo'] },
    {
      config: { mode: 'fixed', amount: 5, unit: 'minutes', resumeOnReply: true },
      expected: ['next: Depois do tempo', 'replied: Se responder antes'],
    },
  ],
  condition: [{ config: { logic: 'and', rules: [] }, expected: YES_NO }],
  multi_condition: [
    {
      config: { cases: [{ label: 'Financeiro', logic: 'and', rules: [] }, { label: '', logic: 'or', rules: [] }] },
      expected: ['case:0: Financeiro', 'case:1: Caso 2', 'else: Senão'],
    },
    { config: { cases: [] }, expected: ['else: Senão'] },
  ],
  value: [{ config: { left: { kind: 'var', value: 'menu' }, operator: 'eq', right: { kind: 'literal', value: '1' } }, expected: YES_NO }],
  distribute: [
    {
      config: { branches: [{ label: 'A', weight: 1 }, { label: '', weight: 3 }] },
      expected: ['branch:0: A (25%)', 'branch:1: Caminho 2 (75%)'],
    },
    {
      config: { branches: [{ label: 'X', weight: 1 }, { label: 'Y', weight: 1 }, { label: 'Z', weight: 1 }] },
      expected: ['branch:0: X (33%)', 'branch:1: Y (33%)', 'branch:2: Z (33%)'],
    },
  ],
  contact_active: [{ config: {}, expected: YES_NO }],
  first_chat: [{ config: {}, expected: YES_NO }],
  contact_field: [{ config: { fieldId: 'native:name', operator: 'empty', value: '' }, expected: YES_NO }],
  tags: [{ config: { mode: 'any', tagIds: [] }, expected: YES_NO }],
  chat_sector: [{ config: { sectorIds: [] }, expected: YES_NO }],
  chat_channel: [{ config: { channelIds: [] }, expected: YES_NO }],
  chat_agent: [{ config: { mode: 'none', userIds: [] }, expected: YES_NO }],
  chat_status: [{ config: {}, expected: YES_NO }],
  message_contains: [{ config: { keywords: ['boleto'], match: 'any' }, expected: YES_NO }],
  parallel_bot: [{ config: {}, expected: YES_NO }],
  send_message: [{ config: { text: 'Olá', attachment: null, signature: false }, expected: NEXT_ERROR }],
  note: [{ config: { text: 'nota' }, expected: ['next: Próximo'] }],
  ask_choice: [
    {
      config: { text: 'Escolha', options: [{ key: '1', label: 'Atendimento' }, { key: '2', label: 'Financeiro' }], invalidRetries: 1, timeoutHours: 24 },
      expected: ['opt:1: 1 · Atendimento', 'opt:2: 2 · Financeiro', 'invalid: Resposta inválida', 'timeout: Sem resposta', 'error: Se não for possível'],
    },
    {
      config: { text: 'Escolha', options: [{ key: 'A', label: 'Sim' }], invalidRetries: 1, timeoutHours: null },
      expected: ['opt:A: A · Sim', 'invalid: Resposta inválida', 'error: Se não for possível'],
    },
    {
      config: { text: 'Escolha', options: [{ key: '1', label: 'Um' }], invalidRetries: 1, timeoutHours: 0 },
      expected: ['opt:1: 1 · Um', 'invalid: Resposta inválida', 'error: Se não for possível'],
    },
  ],
  ask_input: [
    {
      config: { text: 'CPF?', validator: 'cpf', useLastMessage: false, invalidRetries: 2, timeoutHours: 2 },
      expected: ['next: Resposta válida', 'invalid: Resposta inválida', 'timeout: Sem resposta', 'error: Se não for possível'],
    },
    {
      config: { text: 'CPF?', validator: 'cpf', useLastMessage: false, invalidRetries: 2 },
      expected: ['next: Resposta válida', 'invalid: Resposta inválida', 'error: Se não for possível'],
    },
  ],
  set_contact_field: [{ config: { fieldId: 'native:email', value: 'x' }, expected: NEXT_ERROR }],
  edit_tags: [{ config: { add: [], remove: [] }, expected: NEXT_ERROR }],
  transfer_sector: [{ config: { sectorId: 's', onlyIfAgentAllowed: false }, expected: NEXT_ERROR }],
  transfer_agent: [{ config: { rule: 'specific', userIds: ['u'], sectorIds: [] }, expected: NEXT_ERROR }],
  privacy: [{ config: { mode: 'public' }, expected: NEXT_ERROR }],
  notify_agent: [{ config: { title: 't', text: 'x', target: 'owner', userIds: [] }, expected: NEXT_ERROR }],
  call_flow: [{ config: { botId: 'b', continueAfter: true }, expected: NEXT_ERROR }],
  block_contact: [{ config: {}, expected: ['error: Se não for possível'] }],
  close_chat: [{ config: { sendClosingMessage: true }, expected: [] }],
  sticky_note: [{ config: { text: 'lembrete', color: 'yellow' }, expected: [] }],
};

// type, category, label, icon (Phosphor component name), in BLOCK_TYPES order
const CATALOG_ROWS: Array<[BlockType, BlockCategory, string, string]> = [
  ['start_channel', 'start', 'Iniciar por um canal', 'WhatsappLogo'],
  ['start_manual', 'start', 'Iniciar manualmente', 'HandTap'],
  ['weekdays', 'condition', 'Dia da semana', 'CalendarBlank'],
  ['hours', 'condition', 'Horário', 'Clock'],
  ['wait_interval', 'condition', 'Aguardar intervalo', 'Hourglass'],
  ['condition', 'condition', 'Condição', 'GitBranch'],
  ['multi_condition', 'condition', 'Várias condições', 'TreeStructure'],
  ['value', 'condition', 'Comparar valor', 'Equals'],
  ['distribute', 'condition', 'Distribuir', 'Shuffle'],
  ['contact_active', 'condition', 'Contato ativo', 'Pulse'],
  ['first_chat', 'condition', 'Primeira conversa', 'Sparkle'],
  ['contact_field', 'condition', 'Campo do contato', 'IdentificationCard'],
  ['tags', 'condition', 'Etiquetas do contato', 'Tag'],
  ['chat_sector', 'condition', 'Setor da conversa', 'UsersThree'],
  ['chat_channel', 'condition', 'Canal da conversa', 'Broadcast'],
  ['chat_agent', 'condition', 'Atendente da conversa', 'UserCircle'],
  ['chat_status', 'condition', 'Conversa esperando', 'HourglassMedium'],
  ['message_contains', 'condition', 'Mensagem contém', 'MagnifyingGlass'],
  ['parallel_bot', 'condition', 'Outro chatbot rodando', 'Robot'],
  ['send_message', 'action', 'Enviar mensagem', 'ChatText'],
  ['note', 'action', 'Nota interna', 'NotePencil'],
  ['ask_choice', 'action', 'Pedir para escolher', 'ListNumbers'],
  ['ask_input', 'action', 'Pedir informação', 'Textbox'],
  ['set_contact_field', 'action', 'Preencher campo', 'PencilSimple'],
  ['edit_tags', 'action', 'Editar etiquetas', 'TagSimple'],
  ['transfer_sector', 'action', 'Transferir para setor', 'ArrowsLeftRight'],
  ['transfer_agent', 'action', 'Transferir para atendente', 'UserSwitch'],
  ['privacy', 'action', 'Privacidade', 'LockSimple'],
  ['notify_agent', 'action', 'Notificar atendente', 'BellRinging'],
  ['call_flow', 'action', 'Acionar outro fluxo', 'FlowArrow'],
  ['block_contact', 'action', 'Bloquear contato', 'Prohibit'],
  ['close_chat', 'finish', 'Finalizar conversa', 'CheckCircle'],
  ['sticky_note', 'utility', 'Anotação', 'Note'],
];

const BLANK_RULE = { left: { kind: 'var', value: '' }, operator: 'eq', right: { kind: 'literal', value: '' } };
const DEFAULTS: Record<BlockType, unknown> = {
  start_channel: {},
  start_manual: {},
  weekdays: { timezone: 'America/Cuiaba' },
  hours: { timezone: 'America/Cuiaba', intervals: [{ from: '08:00', to: '18:00', days: ['mon', 'tue', 'wed', 'thu', 'fri'] }] },
  wait_interval: { mode: 'fixed', amount: 5, unit: 'minutes', resumeOnReply: false },
  condition: { logic: 'and', rules: [BLANK_RULE] },
  multi_condition: { cases: [{ label: 'Caso 1', logic: 'and', rules: [BLANK_RULE] }] },
  value: BLANK_RULE,
  distribute: { branches: [{ label: 'A', weight: 1 }, { label: 'B', weight: 1 }] },
  contact_active: {},
  first_chat: {},
  contact_field: { fieldId: '', operator: 'eq', value: '' },
  tags: { mode: 'any', tagIds: [] },
  chat_sector: { sectorIds: [] },
  chat_channel: { channelIds: [] },
  chat_agent: { mode: 'any', userIds: [] },
  chat_status: {},
  message_contains: { keywords: [], match: 'any' },
  parallel_bot: {},
  send_message: { text: '', attachment: null, signature: false },
  note: { text: '' },
  ask_choice: { text: '', options: [{ key: '1', label: '' }], invalidRetries: 1, timeoutHours: null },
  ask_input: { text: '', validator: 'any', useLastMessage: false, invalidRetries: 1, timeoutHours: null, saveToField: null },
  set_contact_field: { fieldId: '', value: '' },
  edit_tags: { add: [], remove: [] },
  transfer_sector: { sectorId: '', onlyIfAgentAllowed: false },
  transfer_agent: { rule: 'specific', userIds: [], sectorIds: [] },
  privacy: { mode: 'private' },
  notify_agent: { title: '', text: '', target: 'owner', userIds: [] },
  call_flow: { botId: '', continueAfter: false },
  block_contact: {},
  close_chat: { sendClosingMessage: true },
  sticky_note: { text: '', color: 'yellow' },
};

describe('BLOCK_TYPES and BLOCK_CATALOG', () => {
  it('has the 33 enumerated block types, each once', () => {
    expect(BLOCK_TYPES).toHaveLength(33);
    expect(new Set(BLOCK_TYPES).size).toBe(33);
  });

  it('has one catalog entry per block type, in the same order, with the contract labels and icons', () => {
    expect(BLOCK_CATALOG.map((e) => e.type)).toEqual([...BLOCK_TYPES]);
    expect(BLOCK_CATALOG.map((e) => [e.type, e.category, e.label, e.icon])).toEqual(CATALOG_ROWS);
    for (const e of BLOCK_CATALOG) expect(e.description.trim().length).toBeGreaterThan(0);
  });

  it('counts 2 start, 17 condition, 12 action, 1 finish and 1 utility blocks, all with a category label', () => {
    const count = (c: BlockCategory) => BLOCK_CATALOG.filter((e) => e.category === c).length;
    expect([count('start'), count('condition'), count('action'), count('finish'), count('utility')]).toEqual([2, 17, 12, 1, 1]);
    expect(Object.keys(BLOCK_CATEGORY_LABELS).sort()).toEqual(['action', 'condition', 'finish', 'start', 'utility']);
  });

  it.each(BLOCK_TYPES)('catalogEntry(%s) matches its BLOCK_CATALOG entry', (type) => {
    expect(catalogEntry(type)).toEqual(BLOCK_CATALOG[BLOCK_TYPES.indexOf(type)]);
  });
});

describe('outputsOf', () => {
  it('has output cases for every block type', () => {
    expect(Object.keys(OUTPUT_CASES).sort()).toEqual([...BLOCK_TYPES].sort());
  });

  it.each(BLOCK_TYPES)('returns the contract outputs for %s', (type) => {
    for (const { config, expected } of OUTPUT_CASES[type]) expect(outs(type, config)).toEqual(expected);
  });

  it.each(BLOCK_TYPES)('returns unique output ids for the default %s config', (type) => {
    const ids = outputsOf(type, defaultConfig(type) as Record<string, unknown>).map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(BLOCK_TYPES)('never throws on a malformed %s config', (type) => {
    const malformed: Array<Record<string, unknown>> = [
      {},
      { cases: 'x', branches: null, options: [null, 3, { label: 7 }], timeoutHours: '24', resumeOnReply: 'yes' },
      null as unknown as Record<string, unknown>,
    ];
    for (const config of malformed) expect(() => outputsOf(type, config)).not.toThrow();
  });

  it('treats missing arrays as empty and takes keys as given', () => {
    expect(outs('multi_condition', {})).toEqual(['else: Senão']);
    expect(outs('distribute', {})).toEqual([]);
    expect(outs('distribute', { branches: [{ label: 'A', weight: 0 }, { label: 'B' }] })).toEqual(['branch:0: A (0%)', 'branch:1: B (0%)']);
    expect(outs('ask_choice', {})).toEqual(['invalid: Resposta inválida', 'error: Se não for possível']);
    expect(outs('ask_choice', { options: [{ key: 1, label: 'Um' }], timeoutHours: '24' })).toEqual([
      'opt:1: 1 · Um', 'invalid: Resposta inválida', 'error: Se não for possível',
    ]);
    expect(outs('wait_interval', { resumeOnReply: 'yes' })).toEqual(['next: Depois do tempo']);
  });
});

describe('defaultConfig', () => {
  it.each(BLOCK_TYPES)('returns the contract default for %s', (type) => {
    expect(defaultConfig(type)).toEqual(DEFAULTS[type]);
  });

  it('returns a fresh object on every call', () => {
    const a = defaultConfig('hours');
    a.intervals.push({ from: '19:00', to: '20:00' });
    expect(defaultConfig('hours').intervals).toHaveLength(1);
    expect(defaultConfig('start_channel')).not.toBe(defaultConfig('start_channel'));
  });
});

describe('nodeNameFor and configOf', () => {
  it('uses the type when free and numbers it from 2 otherwise, ignoring case', () => {
    expect(nodeNameFor('ask_input', [])).toBe('ask_input');
    expect(nodeNameFor('ask_input', ['ASK_INPUT'])).toBe('ask_input_2');
    expect(nodeNameFor('ask_input', ['ask_input', 'ask_input_2', 'Ask_Input_4'])).toBe('ask_input_3');
    expect(nodeNameFor('note', new Set(['note', 'menu']))).toBe('note_2');
  });

  it.each(BLOCK_TYPES)('gives %s a valid contexto name', (type) => {
    expect(nodeNameFor(type, [type])).toMatch(/^[A-Za-z0-9_]{1,40}$/);
  });

  it('returns the node config typed for its block', () => {
    const node = { id: 'n1', type: 'hours', position: { x: 0, y: 0 }, config: { timezone: 'America/Cuiaba', intervals: [] } } satisfies BotNode;
    expect(configOf(node).timezone).toBe('America/Cuiaba');
    expect(configOf(node)).toBe(node.config);
  });
});

describe('run constants', () => {
  it('matches the engine limits in the contract', () => {
    expect(NON_TERMINAL_RUN_STATES).toEqual(['running', 'waiting_reply', 'waiting_timer', 'waiting_flow']);
    expect([MAX_STEPS_PER_CALL, MAX_FLOW_LEVELS, STEP_LOG_LIMIT, EDITOR_HISTORY_LIMIT]).toEqual([50, 5, 50, 50]);
  });
});
