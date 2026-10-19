import { describe, expect, it } from 'vitest';
import { BLOCK_TYPES, type BlockType, type BotEdge, type BotGraph, type BotNode, type GraphProblem } from '@talk/shared';
import {
  isFieldRef,
  loadGraphCatalog,
  startNodeOf,
  validateGraph,
  validateNodeConfig,
  type GraphCatalog,
} from '../../src/bots/graph.js';
import { STARTER_GRAPH, createBot, insertBotVersion } from '../../src/bots/repo.js';
import { customFields, tags, users } from '../../src/db/schema.js';
import { makeTestCtx, seedBasics } from '../helpers.js';

const ID = { sector: 'sec-1', user: 'usr-1', tag: 'tag-1', field: 'fld-1', channel: 'chn-1', bot: 'bot-other', self: 'bot-self' };
const catalog: GraphCatalog = {
  selfBotId: ID.self,
  sectorIds: new Set([ID.sector]),
  activeUserIds: new Set([ID.user]),
  tagIds: new Set([ID.tag]),
  customFieldIds: new Set([ID.field]),
  channelIds: new Set([ID.channel]),
  botIds: new Set([ID.bot, ID.self]),
  startChannelIds: [ID.channel],
  calledByOtherFlow: false,
};
const NO_CHANNEL =
  'Marque ao menos um canal neste início ou, se este fluxo só é acionado por outro, troque este bloco por "Iniciar manualmente"';

const rule = { left: { kind: 'var', value: 'menu' }, operator: 'eq', right: { kind: 'literal', value: '1' } };
const ATTACHMENT = { path: 'bots/0b7e3c2a-6f1d-4c55-9a51-2f3c4d5e6f70.pdf', name: 'tabela.pdf', mime: 'application/pdf', size: 1234 };

/** One valid config per block type (Record<BlockType, …> makes the compiler demand every type). */
const VALID: Record<BlockType, Record<string, unknown>> = {
  start_channel: {},
  start_manual: {},
  weekdays: { timezone: 'America/Cuiaba' },
  hours: {
    timezone: 'America/Cuiaba',
    intervals: [{ from: '08:00', to: '12:00', days: ['mon', 'fri'] }, { from: '14:00', to: '18:00' }],
  },
  wait_interval: { mode: 'fixed', amount: 5, unit: 'minutes', resumeOnReply: false },
  condition: { logic: 'and', rules: [rule] },
  multi_condition: { cases: [{ label: 'Caso 1', logic: 'or', rules: [rule] }] },
  value: rule,
  distribute: { branches: [{ label: 'A', weight: 1 }, { label: 'B', weight: 3 }] },
  contact_active: {},
  first_chat: {},
  contact_field: { fieldId: 'native:email', operator: 'not_empty', value: '' },
  tags: { mode: 'any', tagIds: [ID.tag] },
  chat_sector: { sectorIds: [ID.sector] },
  chat_channel: { channelIds: [ID.channel] },
  chat_agent: { mode: 'specific', userIds: [ID.user] },
  chat_status: {},
  message_contains: { keywords: ['boleto'], match: 'any' },
  parallel_bot: {},
  send_message: { text: 'Olá!', attachment: null, signature: false },
  note: { text: 'Cliente novo' },
  ask_choice: {
    text: 'Escolha:',
    options: [{ key: '1', label: 'Atendimento' }, { key: '2', label: 'Financeiro' }],
    invalidRetries: 1,
    timeoutHours: 24,
  },
  ask_input: { text: 'Digite seu CPF:', validator: 'cpf', useLastMessage: false, invalidRetries: 2, timeoutHours: null, saveToField: ID.field },
  set_contact_field: { fieldId: ID.field, value: '{{contexto.cpf}}' },
  edit_tags: { add: [ID.tag], remove: [] },
  transfer_sector: { sectorId: ID.sector, onlyIfAgentAllowed: false },
  transfer_agent: { rule: 'least_busy', userIds: [], sectorIds: [ID.sector] },
  privacy: { mode: 'private' },
  notify_agent: { title: 'Nova conversa', text: 'De {{contato.nome}}', target: 'owner', userIds: [] },
  call_flow: { botId: ID.bot, continueAfter: true },
  block_contact: {},
  close_chat: { sendClosingMessage: true },
  sticky_note: { text: 'Lembrete', color: 'yellow' },
};

function node(type: BlockType, config: Record<string, unknown> = VALID[type]): BotNode {
  return { id: `id_${type}`, type, position: { x: 0, y: 0 }, config, name: `n_${type}` };
}
const configProblems = (type: BlockType, patch: Record<string, unknown>) =>
  validateNodeConfig(node(type, { ...VALID[type], ...patch }), catalog);

describe('validateNodeConfig', () => {
  it.each(BLOCK_TYPES)('accepts a valid %s config', (type) => {
    expect(validateNodeConfig(node(type), catalog)).toEqual([]);
  });

  const variants: Array<[label: string, type: BlockType, patch: Record<string, unknown>]> = [
    ['hours with UTC and no days', 'hours', { timezone: 'UTC', intervals: [{ from: '00:00', to: '23:59' }] }],
    ['hours with days: null (every day)', 'hours', { intervals: [{ from: '08:00', to: '09:00', days: null }] }],
    ['wait_interval variable', 'wait_interval', { mode: 'variable', variable: '{{contexto.prazo}}', unit: 'days' }],
    ['wait_interval fractional amount', 'wait_interval', { amount: 0.5, unit: 'hours', resumeOnReply: true }],
    ['condition on a :raw variable', 'condition', { rules: [{ ...rule, left: { kind: 'var', value: 'cpf:raw' } }] }],
    ['condition empty without right side', 'condition', { rules: [{ left: { kind: 'field', value: ID.field }, operator: 'empty' }] }],
    ['condition native field vs literal', 'condition', { rules: [{ left: { kind: 'field', value: 'native:city' }, operator: 'contains', right: { kind: 'literal', value: '' } }] }],
    ['multi_condition with 20 cases', 'multi_condition', { cases: Array.from({ length: 20 }, () => ({ label: '', logic: 'and', rules: [rule] })) }],
    ['distribute with 10 branches', 'distribute', { branches: Array.from({ length: 10 }, () => ({ label: '', weight: 2 })) }],
    ['contact_field on a custom field', 'contact_field', { fieldId: ID.field, operator: 'eq', value: '123' }],
    ['tags none', 'tags', { mode: 'none' }],
    ['chat_agent none with no users', 'chat_agent', { mode: 'none', userIds: [] }],
    ['chat_agent any', 'chat_agent', { mode: 'any', userIds: [] }],
    ['send_message with only an attachment', 'send_message', { text: '', attachment: ATTACHMENT }],
    ['send_message with text and an attachment', 'send_message', { attachment: ATTACHMENT }],
    ['ask_choice with no timeout and 0 retries', 'ask_choice', { timeoutHours: null, invalidRetries: 0 }],
    ['ask_choice with a fractional timeout', 'ask_choice', { timeoutHours: 0.5 }],
    ['ask_choice with 20 options', 'ask_choice', { options: Array.from({ length: 20 }, (_, i) => ({ key: String(i + 1), label: `Opção ${i + 1}` })) }],
    ['ask_input media without types', 'ask_input', { validator: 'media' }],
    ['ask_input media with types', 'ask_input', { validator: 'media', mediaTypes: ['pdf', 'image'] }],
    ['ask_input regex', 'ask_input', { validator: 'regex', regex: '^\\d{5}-?\\d{3}$' }],
    ['ask_input saving to a native field', 'ask_input', { validator: 'email', saveToField: 'native:email' }],
    ['ask_input not saving (null)', 'ask_input', { saveToField: null }],
    ['ask_input not saving (empty)', 'ask_input', { saveToField: '' }],
    ['ask_input timeout 720 h', 'ask_input', { timeoutHours: 720 }],
    ['edit_tags only removing', 'edit_tags', { add: [], remove: [ID.tag] }],
    ['transfer_agent specific', 'transfer_agent', { rule: 'specific', userIds: [ID.user], sectorIds: [] }],
    ['notify_agent to users', 'notify_agent', { target: 'users', userIds: [ID.user] }],
    ['close_chat with closing text', 'close_chat', { sendClosingMessage: true, closingText: 'Até logo!' }],
    ['close_chat without message', 'close_chat', { sendClosingMessage: false }],
  ];
  it.each(variants)('accepts %s', (_label, type, patch) => {
    expect(configProblems(type, patch)).toEqual([]);
  });

  it('flags a start_channel block on a bot with no channel marked', () => {
    const noChannel = { ...catalog, startChannelIds: [] };
    expect(validateNodeConfig(node('start_channel'), noChannel)).toEqual([NO_CHANNEL]);
    expect(validateNodeConfig(node('start_manual'), noChannel)).toEqual([]);
    const g: BotGraph = {
      nodes: [node('start_channel', {}), node('send_message')],
      edges: [{ id: 'e1', source: node('start_channel').id, sourceHandle: 'next', target: node('send_message').id }],
    };
    expect(validateGraph(g, noChannel)).toEqual([{ nodeId: node('start_channel').id, message: NO_CHANNEL }]);
    expect(validateGraph(g, catalog)).toEqual([]);
  });

  it('accepts a start_channel block with no channel on a bot another flow calls (call entry falls back to it)', () => {
    expect(validateNodeConfig(node('start_channel'), { ...catalog, startChannelIds: [], calledByOtherFlow: true })).toEqual([]);
  });

  it('lets call_flow target any existing bot when there is no self id yet (import)', () => {
    expect(validateNodeConfig(node('call_flow', { botId: ID.self, continueAfter: false }), { ...catalog, selfBotId: null })).toEqual([]);
  });

  const BAD = 'Configuração inválida';
  const bad: Array<[label: string, type: BlockType, patch: Record<string, unknown>, message: string]> = [
    ['weekdays unknown timezone', 'weekdays', { timezone: 'Marte/Olimpo' }, 'Fuso horário inválido'],
    ['weekdays empty timezone', 'weekdays', { timezone: '' }, 'Fuso horário inválido'],
    ['hours unknown timezone', 'hours', { timezone: 'America/Atlantida' }, 'Fuso horário inválido'],
    ['hours without intervals', 'hours', { intervals: [] }, 'Adicione pelo menos um intervalo'],
    ['hours H:MM', 'hours', { intervals: [{ from: '8:00', to: '12:00' }] }, 'Intervalo 1: Horário inválido (use HH:MM)'],
    ['hours 24:00', 'hours', { intervals: [{ from: '08:00', to: '24:00' }] }, 'Intervalo 1: Horário inválido (use HH:MM)'],
    ['hours 12:60', 'hours', { intervals: [{ from: '08:00', to: '12:00' }, { from: '12:60', to: '13:00' }] }, 'Intervalo 2: Horário inválido (use HH:MM)'],
    ['hours from after to', 'hours', { intervals: [{ from: '12:00', to: '08:00' }] }, 'Intervalo 1: O início deve ser antes do fim'],
    ['hours from equal to', 'hours', { intervals: [{ from: '08:00', to: '08:00' }] }, 'Intervalo 1: O início deve ser antes do fim'],
    ['hours with no days', 'hours', { intervals: [{ from: '08:00', to: '12:00', days: [] }] }, 'Intervalo 1: Escolha pelo menos um dia'],
    ['hours with an unknown day', 'hours', { intervals: [{ from: '08:00', to: '12:00', days: ['funday'] }] }, `Intervalo 1: ${BAD}`],
    ['wait_interval zero', 'wait_interval', { amount: 0 }, 'Informe um tempo maior que zero'],
    ['wait_interval negative', 'wait_interval', { amount: -1 }, 'Informe um tempo maior que zero'],
    ['wait_interval amount as text', 'wait_interval', { amount: '5' }, 'Informe um tempo maior que zero'],
    ['wait_interval infinite', 'wait_interval', { amount: Infinity }, 'Informe um tempo maior que zero'],
    ['wait_interval variable empty', 'wait_interval', { mode: 'variable', variable: ' ' }, 'Informe a variável com o tempo'],
    ['wait_interval unknown unit', 'wait_interval', { unit: 'weeks' }, BAD],
    ['wait_interval unknown mode', 'wait_interval', { mode: 'forever' }, BAD],
    ['condition without rules', 'condition', { rules: [] }, 'Adicione pelo menos uma regra'],
    ['condition unknown logic', 'condition', { logic: 'xor' }, BAD],
    ['condition empty variable', 'condition', { rules: [{ ...rule, left: { kind: 'var', value: '' } }] }, 'Regra 1: Escolha a variável'],
    ['condition :label variable', 'condition', { rules: [{ ...rule, left: { kind: 'var', value: 'menu:label' } }] }, 'Regra 1: Escolha a variável'],
    ['condition unknown operator', 'condition', { rules: [{ ...rule, operator: 'like' }] }, `Regra 1: ${BAD}`],
    ['condition eq without right', 'condition', { rules: [{ left: rule.left, operator: 'eq' }] }, `Regra 1: ${BAD}`],
    ['condition unknown operand kind', 'condition', { rules: [rule, { ...rule, right: { kind: 'magic', value: 'x' } }] }, `Regra 2: ${BAD}`],
    ['condition unknown field', 'condition', { rules: [{ ...rule, left: { kind: 'field', value: 'fld-gone' } }] }, 'Regra 1: Campo inexistente'],
    ['condition literal not text', 'condition', { rules: [{ ...rule, right: { kind: 'literal', value: 1 } }] }, `Regra 1: ${BAD}`],
    ['multi_condition without cases', 'multi_condition', { cases: [] }, 'Adicione de 1 a 20 casos'],
    ['multi_condition with 21 cases', 'multi_condition', { cases: Array.from({ length: 21 }, () => ({ label: '', logic: 'and', rules: [rule] })) }, 'Adicione de 1 a 20 casos'],
    ['multi_condition case without rules', 'multi_condition', { cases: [{ label: 'X', logic: 'and', rules: [] }] }, 'Caso 1: Adicione pelo menos uma regra'],
    ['multi_condition case bad logic', 'multi_condition', { cases: [{ label: 'X', logic: 'nand', rules: [rule] }] }, `Caso 1: ${BAD}`],
    ['multi_condition case not an object', 'multi_condition', { cases: ['x'] }, `Caso 1: ${BAD}`],
    ['multi_condition rule problem', 'multi_condition', { cases: [{ label: 'X', logic: 'and', rules: [rule, { ...rule, left: { kind: 'var', value: 'a b' } }] }] }, 'Caso 1, regra 2: Escolha a variável'],
    ['value unknown operator', 'value', { operator: 'between' }, BAD],
    ['value unknown field', 'value', { left: { kind: 'field', value: 'fld-gone' } }, 'Campo inexistente'],
    ['distribute with 1 branch', 'distribute', { branches: [{ label: 'A', weight: 1 }] }, 'Adicione de 2 a 10 caminhos'],
    ['distribute with 11 branches', 'distribute', { branches: Array.from({ length: 11 }, () => ({ label: '', weight: 1 })) }, 'Adicione de 2 a 10 caminhos'],
    ['distribute weight 0', 'distribute', { branches: [{ label: 'A', weight: 1 }, { label: 'B', weight: 0 }] }, 'Caminho 2: O peso deve ser um número inteiro maior que zero'],
    ['distribute weight 1.5', 'distribute', { branches: [{ label: 'A', weight: 1.5 }, { label: 'B', weight: 1 }] }, 'Caminho 1: O peso deve ser um número inteiro maior que zero'],
    ['contact_field not chosen', 'contact_field', { fieldId: '' }, 'Escolha o campo'],
    ['contact_field phone is not a native field', 'contact_field', { fieldId: 'native:phone' }, 'Campo inexistente'],
    ['contact_field unknown operator', 'contact_field', { operator: 'like' }, BAD],
    ['tags without tags', 'tags', { tagIds: [] }, 'Escolha pelo menos uma etiqueta'],
    ['tags unknown tag', 'tags', { tagIds: [ID.tag, 'tag-gone'] }, 'Etiqueta inexistente'],
    ['tags unknown mode', 'tags', { mode: 'some' }, BAD],
    ['chat_sector without sectors', 'chat_sector', { sectorIds: [] }, 'Escolha pelo menos um setor'],
    ['chat_sector unknown sector', 'chat_sector', { sectorIds: ['sec-gone'] }, 'Setor inexistente'],
    ['chat_channel without channels', 'chat_channel', { channelIds: [] }, 'Escolha pelo menos um canal'],
    ['chat_channel unknown channel', 'chat_channel', { channelIds: ['chn-gone'] }, 'Canal inexistente'],
    ['chat_agent specific without users', 'chat_agent', { userIds: [] }, 'Escolha pelo menos um atendente'],
    ['chat_agent specific inactive user', 'chat_agent', { userIds: ['usr-inactive'] }, 'Atendente inexistente ou inativo'],
    ['chat_agent unknown mode', 'chat_agent', { mode: 'all' }, BAD],
    ['message_contains without words', 'message_contains', { keywords: [] }, 'Adicione pelo menos uma palavra'],
    ['message_contains blank word', 'message_contains', { keywords: ['boleto', '  '] }, 'Há uma palavra vazia'],
    ['message_contains unknown match', 'message_contains', { match: 'most' }, BAD],
    ['send_message empty', 'send_message', { text: '' }, 'Escreva a mensagem ou anexe um arquivo'],
    ['send_message blank', 'send_message', { text: '   ' }, 'Escreva a mensagem ou anexe um arquivo'],
    ['send_message attachment outside bots/', 'send_message', { attachment: { ...ATTACHMENT, path: '../../etc/passwd' } }, 'Anexo inválido'],
    ['send_message attachment in a dated folder', 'send_message', { attachment: { ...ATTACHMENT, path: '2026/10/0b7e3c2a-6f1d-4c55-9a51-2f3c4d5e6f70.pdf' } }, 'Anexo inválido'],
    ['send_message attachment without name', 'send_message', { attachment: { ...ATTACHMENT, name: '' } }, 'Anexo inválido'],
    ['send_message text not a string', 'send_message', { text: 5, attachment: ATTACHMENT }, BAD],
    ['note empty', 'note', { text: ' ' }, 'Escreva a nota'],
    ['ask_choice empty question', 'ask_choice', { text: '' }, 'Escreva a pergunta'],
    ['ask_choice without options', 'ask_choice', { options: [] }, 'Adicione de 1 a 20 opções'],
    ['ask_choice with 21 options', 'ask_choice', { options: Array.from({ length: 21 }, (_, i) => ({ key: String(i + 1), label: 'x' })) }, 'Adicione de 1 a 20 opções'],
    ['ask_choice repeated key', 'ask_choice', { options: [{ key: '1', label: 'A' }, { key: '1', label: 'B' }] }, 'Opção 2: Chave repetida'],
    ['ask_choice repeated key, other case', 'ask_choice', { options: [{ key: 'a', label: 'A' }, { key: 'A', label: 'B' }] }, 'Opção 2: Chave repetida'],
    ['ask_choice empty key', 'ask_choice', { options: [{ key: '', label: 'A' }] }, 'Opção 1: A chave deve ter de 1 a 10 caracteres, sem espaços nas pontas'],
    ['ask_choice 11-char key', 'ask_choice', { options: [{ key: 'abcdefghijk', label: 'A' }] }, 'Opção 1: A chave deve ter de 1 a 10 caracteres, sem espaços nas pontas'],
    ['ask_choice key with a leading space', 'ask_choice', { options: [{ key: ' 1', label: 'A' }] }, 'Opção 1: A chave deve ter de 1 a 10 caracteres, sem espaços nas pontas'],
    ['ask_choice empty label', 'ask_choice', { options: [{ key: '1', label: '' }] }, 'Opção 1: Escreva o texto da opção'],
    ['ask_choice 4 retries', 'ask_choice', { invalidRetries: 4 }, 'As tentativas devem ser de 0 a 3'],
    ['ask_choice negative retries', 'ask_choice', { invalidRetries: -1 }, 'As tentativas devem ser de 0 a 3'],
    ['ask_choice fractional retries', 'ask_choice', { invalidRetries: 1.5 }, 'As tentativas devem ser de 0 a 3'],
    ['ask_choice missing retries', 'ask_choice', { invalidRetries: undefined }, 'As tentativas devem ser de 0 a 3'],
    ['ask_choice timeout 0', 'ask_choice', { timeoutHours: 0 }, 'O tempo sem resposta deve ser maior que zero e de no máximo 720 horas'],
    ['ask_choice timeout 721', 'ask_choice', { timeoutHours: 721 }, 'O tempo sem resposta deve ser maior que zero e de no máximo 720 horas'],
    ['ask_input empty question', 'ask_input', { text: '' }, 'Escreva a pergunta'],
    ['ask_input unknown validator', 'ask_input', { validator: 'cep' }, BAD],
    ['ask_input invalid regex', 'ask_input', { validator: 'regex', regex: '(' }, 'Expressão regular inválida (até 200 caracteres)'],
    ['ask_input regex too long', 'ask_input', { validator: 'regex', regex: 'a'.repeat(201) }, 'Expressão regular inválida (até 200 caracteres)'],
    ['ask_input regex missing', 'ask_input', { validator: 'regex' }, 'Expressão regular inválida (até 200 caracteres)'],
    ['ask_input unknown media type', 'ask_input', { validator: 'media', mediaTypes: ['doc'] }, BAD],
    ['ask_input saving to an unknown field', 'ask_input', { saveToField: 'fld-gone' }, 'Campo inexistente'],
    ['ask_input timeout 0', 'ask_input', { timeoutHours: 0 }, 'O tempo sem resposta deve ser maior que zero e de no máximo 720 horas'],
    ['set_contact_field not chosen', 'set_contact_field', { fieldId: '' }, 'Escolha o campo'],
    ['set_contact_field unknown field', 'set_contact_field', { fieldId: 'fld-gone' }, 'Campo inexistente'],
    ['set_contact_field value not text', 'set_contact_field', { value: null }, BAD],
    ['edit_tags nothing to do', 'edit_tags', { add: [], remove: [] }, 'Escolha pelo menos uma etiqueta'],
    ['edit_tags unknown tag', 'edit_tags', { remove: ['tag-gone'] }, 'Etiqueta inexistente'],
    ['transfer_sector not chosen', 'transfer_sector', { sectorId: '' }, 'Escolha o setor'],
    ['transfer_sector unknown sector', 'transfer_sector', { sectorId: 'sec-gone' }, 'Setor inexistente'],
    ['transfer_agent specific without users', 'transfer_agent', { rule: 'specific', userIds: [] }, 'Escolha pelo menos um atendente'],
    ['transfer_agent specific inactive user', 'transfer_agent', { rule: 'specific', userIds: ['usr-inactive'] }, 'Atendente inexistente ou inativo'],
    ['transfer_agent least_busy without sectors', 'transfer_agent', { sectorIds: [] }, 'Escolha pelo menos um setor'],
    ['transfer_agent least_busy unknown sector', 'transfer_agent', { sectorIds: ['sec-gone'] }, 'Setor inexistente'],
    ['transfer_agent unknown rule', 'transfer_agent', { rule: 'random' }, BAD],
    ['privacy unknown mode', 'privacy', { mode: 'secret' }, BAD],
    ['notify_agent empty title', 'notify_agent', { title: '' }, 'Escreva o título da notificação'],
    ['notify_agent empty text', 'notify_agent', { text: ' ' }, 'Escreva o texto da notificação'],
    ['notify_agent users without users', 'notify_agent', { target: 'users', userIds: [] }, 'Escolha pelo menos um atendente'],
    ['notify_agent users inactive', 'notify_agent', { target: 'users', userIds: ['usr-inactive'] }, 'Atendente inexistente ou inativo'],
    ['notify_agent unknown target', 'notify_agent', { target: 'everyone' }, BAD],
    ['call_flow not chosen', 'call_flow', { botId: '' }, 'Escolha o chatbot'],
    ['call_flow unknown bot', 'call_flow', { botId: 'bot-gone' }, 'Chatbot inexistente'],
    ['call_flow calling itself', 'call_flow', { botId: ID.self }, 'Um fluxo não pode acionar a si mesmo'],
    ['close_chat flag not boolean', 'close_chat', { sendClosingMessage: 'sim' }, BAD],
    ['close_chat closing text not text', 'close_chat', { closingText: 42 }, BAD],
  ];
  it.each(bad)('reports %s', (_label, type, patch, message) => {
    expect(configProblems(type, patch)).toEqual([message]);
  });

  it.each(BLOCK_TYPES)('never throws on a malformed %s config', (type) => {
    const garbage: unknown[] = [
      {},
      null,
      'x',
      [],
      { rules: 'x', options: 5, intervals: [null, 3], cases: [1, null], branches: [null], keywords: [null], tagIds: [1], left: 1, attachment: 'x' },
    ];
    for (const config of garbage) {
      expect(() => validateNodeConfig(node(type, config as Record<string, unknown>), catalog)).not.toThrow();
    }
  });
});

describe('isFieldRef', () => {
  it.each([
    [ID.field, true],
    ['native:name', true],
    ['native:email', true],
    ['native:landline', true],
    ['native:city', true],
    ['native:state', true],
    ['native:phone', false],
    ['fld-gone', false],
    ['', false],
  ])('isFieldRef(%j) = %s', (id, expected) => {
    expect(isFieldRef(id, catalog)).toBe(expected);
  });
});

describe('validateGraph', () => {
  const n = (id: string, type: BlockType, extra: Partial<BotNode> = {}): BotNode => ({
    id,
    type,
    position: { x: 0, y: 0 },
    config: VALID[type],
    name: id,
    ...extra,
  });
  const e = (source: string, sourceHandle: string, target: string): BotEdge => ({
    id: `${source}-${sourceHandle}-${target}`,
    source,
    sourceHandle,
    target,
  });
  // inicio → menu (ask_choice; opt:2, invalid, timeout and error left open on purpose) → ola → fim
  const baseGraph = (): BotGraph => ({
    nodes: [
      n('inicio', 'start_channel'),
      n('menu', 'ask_choice'),
      n('ola', 'send_message'),
      n('fim', 'close_chat'),
      n('lembrete', 'sticky_note', { name: undefined }),
    ],
    edges: [e('inicio', 'next', 'menu'), e('menu', 'opt:1', 'ola'), e('ola', 'next', 'fim')],
  });
  const at = (g: BotGraph, id: string) => g.nodes.find((x) => x.id === id) as BotNode;

  it('accepts the base graph (unconnected outputs mean "finish")', () => {
    expect(validateGraph(baseGraph(), catalog)).toEqual([]);
  });

  it('reports an empty graph', () => {
    expect(validateGraph({ nodes: [], edges: [] }, catalog)).toEqual([{ nodeId: null, message: 'O fluxo precisa de um bloco de início' }]);
  });

  const cases: Array<[label: string, mutate: (g: BotGraph) => void, expected: GraphProblem[]]> = [
    ['only a manual start is fine', (g) => { at(g, 'inicio').type = 'start_manual'; }, []],
    ['one start of each type is fine', (g) => { g.nodes.push(n('manual', 'start_manual')); g.edges.push(e('manual', 'next', 'menu')); }, []],
    ['an edge back to an earlier block is fine', (g) => { g.edges.push(e('ola', 'error', 'menu')); }, []],
    ['a self loop is fine', (g) => { g.edges.push(e('ola', 'error', 'ola')); }, []],
    ['a sticky note may carry any name', (g) => { at(g, 'lembrete').name = 'ola'; }, []],
    [
      'no start block',
      (g) => { g.nodes = g.nodes.filter((x) => x.id !== 'inicio'); g.edges = g.edges.filter((x) => x.source !== 'inicio'); },
      [{ nodeId: null, message: 'O fluxo precisa de um bloco de início' }, { nodeId: 'menu', message: 'Bloco sem entrada' }],
    ],
    [
      'two channel starts',
      (g) => { g.nodes.push(n('inicio2', 'start_channel')); g.edges.push(e('inicio2', 'next', 'ola')); },
      [{ nodeId: 'inicio2', message: 'Só pode haver um bloco "Iniciar por um canal"' }],
    ],
    [
      'two manual starts',
      (g) => {
        g.nodes.push(n('m1', 'start_manual'), n('m2', 'start_manual'));
        g.edges.push(e('m1', 'next', 'menu'), e('m2', 'next', 'menu'));
      },
      [{ nodeId: 'm2', message: 'Só pode haver um bloco "Iniciar manualmente"' }],
    ],
    ['missing name', (g) => { at(g, 'ola').name = undefined; }, [{ nodeId: 'ola', message: 'Nome inválido: use de 1 a 40 letras sem acento, números ou _' }]],
    ['name with an accent', (g) => { at(g, 'ola').name = 'olá'; }, [{ nodeId: 'ola', message: 'Nome inválido: use de 1 a 40 letras sem acento, números ou _' }]],
    ['name with a space', (g) => { at(g, 'ola').name = 'boas vindas'; }, [{ nodeId: 'ola', message: 'Nome inválido: use de 1 a 40 letras sem acento, números ou _' }]],
    ['name with 41 chars', (g) => { at(g, 'ola').name = 'a'.repeat(41); }, [{ nodeId: 'ola', message: 'Nome inválido: use de 1 a 40 letras sem acento, números ou _' }]],
    ['duplicate name, other case', (g) => { at(g, 'fim').name = 'OLA'; }, [{ nodeId: 'fim', message: 'Já existe outro bloco com o nome "OLA"' }]],
    [
      'duplicate node id',
      (g) => { g.nodes.push(n('fim', 'close_chat', { name: 'fim2' })); },
      [{ nodeId: 'fim', message: 'Há dois blocos com o mesmo id' }],
    ],
    ['config problems carry the node id', (g) => { at(g, 'ola').config = { ...VALID.send_message, text: '' }; }, [{ nodeId: 'ola', message: 'Escreva a mensagem ou anexe um arquivo' }]],
    ['edge to a missing block', (g) => { g.edges.push(e('ola', 'error', 'sumiu')); }, [{ nodeId: 'ola', message: 'Conexão com um bloco que não existe' }]],
    ['edge from a missing block', (g) => { g.edges.push(e('sumiu', 'next', 'fim')); }, [{ nodeId: null, message: 'Conexão com um bloco que não existe' }]],
    ['edge on an output the type does not have', (g) => { g.edges.push(e('ola', 'yes', 'fim')); }, [{ nodeId: 'ola', message: 'Conexão em uma saída que não existe' }]],
    ['edge on a removed option', (g) => { g.edges.push(e('menu', 'opt:9', 'fim')); }, [{ nodeId: 'menu', message: 'Conexão em uma saída que não existe' }]],
    [
      'edge on timeout when the question has no timeout',
      (g) => { at(g, 'menu').config = { ...VALID.ask_choice, timeoutHours: null }; g.edges.push(e('menu', 'timeout', 'fim')); },
      [{ nodeId: 'menu', message: 'Conexão em uma saída que não existe' }],
    ],
    ['edge from close_chat (no outputs)', (g) => { g.edges.push(e('fim', 'next', 'ola')); }, [{ nodeId: 'fim', message: 'Conexão em uma saída que não existe' }]],
    ['two edges on one output', (g) => { g.edges.push(e('menu', 'opt:1', 'fim')); }, [{ nodeId: 'menu', message: 'A saída "1 · Atendimento" tem mais de uma conexão' }]],
    ['edge into a start block', (g) => { g.edges.push(e('ola', 'error', 'inicio')); }, [{ nodeId: 'inicio', message: 'O bloco de início não pode ter entrada' }]],
    ['edge into a sticky note', (g) => { g.edges.push(e('ola', 'error', 'lembrete')); }, [{ nodeId: 'lembrete', message: 'Anotações não se conectam a outros blocos' }]],
    ['edge out of a sticky note', (g) => { g.edges.push(e('lembrete', 'next', 'fim')); }, [{ nodeId: 'lembrete', message: 'Anotações não se conectam a outros blocos' }]],
    ['block without input', (g) => { g.nodes.push(n('solto', 'note')); }, [{ nodeId: 'solto', message: 'Bloco sem entrada' }]],
    [
      'block whose only input is invalid',
      (g) => { g.nodes.push(n('solto', 'note')); g.edges.push(e('fim', 'next', 'solto')); },
      [{ nodeId: 'fim', message: 'Conexão em uma saída que não existe' }, { nodeId: 'solto', message: 'Bloco sem entrada' }],
    ],
    [
      'start output not connected',
      (g) => { g.edges = g.edges.filter((x) => x.source !== 'inicio'); },
      [{ nodeId: 'inicio', message: 'Conecte a saída do bloco de início' }, { nodeId: 'menu', message: 'Bloco sem entrada' }],
    ],
  ];
  it.each(cases)('%s', (_label, mutate, expected) => {
    const g = baseGraph();
    mutate(g);
    expect(validateGraph(g, catalog)).toEqual(expected);
  });

  it('never throws on malformed configs of every type', () => {
    const g: BotGraph = {
      nodes: [n('inicio', 'start_channel'), ...BLOCK_TYPES.map((t) => n(`x_${t}`, t, { config: {} }))],
      edges: BLOCK_TYPES.map((t) => e('inicio', 'next', `x_${t}`)),
    };
    expect(() => validateGraph(g, catalog)).not.toThrow();
  });
});

describe('startNodeOf', () => {
  const start = (id: string, type: BlockType): BotNode => ({ id, type, position: { x: 0, y: 0 }, config: {}, name: id });
  const both: BotGraph = { nodes: [start('c', 'start_channel'), start('m', 'start_manual')], edges: [] };
  const channelOnly: BotGraph = { nodes: [start('c', 'start_channel')], edges: [] };
  const none: BotGraph = { nodes: [], edges: [] };

  it.each([
    ['both, channel', both, 'channel', 'c'],
    ['both, manual', both, 'manual', 'm'],
    ['both, call prefers manual', both, 'call', 'm'],
    ['channel only, manual', channelOnly, 'manual', null],
    ['channel only, call falls back to channel', channelOnly, 'call', 'c'],
    ['none, call', none, 'call', null],
  ] as Array<[string, BotGraph, 'channel' | 'manual' | 'call', string | null]>)('%s', (_label, graph, entry, expected) => {
    expect(startNodeOf(graph, entry)?.id ?? null).toBe(expected);
  });
});

describe('loadGraphCatalog', () => {
  it('loads every id from the database, active users only', async () => {
    const ctx = await makeTestCtx();
    const s = await seedBasics(ctx);
    const [inactive] = await ctx.db
      .insert(users)
      .values({ name: 'Inativo', email: 'inativo@teste.local', passwordHash: 'x', role: 'agent', active: false })
      .returning();
    const [tag] = await ctx.db.insert(tags).values({ name: 'VIP', color: 'blue' }).returning();
    const [field] = await ctx.db.insert(customFields).values({ name: 'CPF', kind: 'cpf' }).returning();
    const newBot = (name: string) => createBot(ctx.db, { name, graph: STARTER_GRAPH(), valid: false, publish: false, createdBy: null });
    const self = await newBot('Este');
    const other = await newBot('Outro');

    const cat = await loadGraphCatalog(ctx.db, self.id, [s.channelId]);

    expect(cat.selfBotId).toBe(self.id);
    expect(cat.sectorIds).toEqual(new Set([s.defaultSector, s.sectorA, s.sectorB]));
    expect(cat.activeUserIds).toEqual(new Set([s.admin.id, s.agentA.id, s.agentB.id]));
    expect(cat.activeUserIds.has(inactive.id)).toBe(false);
    expect(cat.tagIds).toEqual(new Set([tag.id]));
    expect(cat.customFieldIds).toEqual(new Set([field.id]));
    expect(cat.channelIds).toEqual(new Set([s.channelId]));
    expect(cat.botIds).toEqual(new Set([self.id, other.id]));
    expect(cat.startChannelIds).toEqual([s.channelId]);
    expect(cat.calledByOtherFlow).toBe(false);

    // Another bot's latest version calls this one.
    const call: BotNode = { id: 'f', type: 'call_flow', name: 'f', position: { x: 0, y: 0 }, config: { botId: self.id, continueAfter: false } };
    await insertBotVersion(ctx.db, { botId: other.id, graph: { nodes: [call], edges: [] }, valid: false, createdBy: null });
    expect((await loadGraphCatalog(ctx.db, self.id, [])).calledByOtherFlow).toBe(true);
    expect((await loadGraphCatalog(ctx.db, other.id, [])).calledByOtherFlow).toBe(false);
    expect((await loadGraphCatalog(ctx.db, null, [])).calledByOtherFlow).toBe(false); // a bot not created yet has no caller
  });
});
