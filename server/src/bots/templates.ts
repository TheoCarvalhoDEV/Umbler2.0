import { eq } from 'drizzle-orm';
import {
  DEFAULT_TIMEZONE,
  type AskChoiceConfig,
  type AskInputConfig,
  type BotDto,
  type BotEdge,
  type BotGraph,
  type BotNode,
  type BotTemplateKind,
  type ContactFieldConfig,
  type HoursConfig,
  type MessageContainsConfig,
  type MultiConditionConfig,
  type NoteConfig,
  type NotifyAgentConfig,
  type OfficeTemplateDestination,
  type OfficeTemplateInput,
  type SendMessageConfig,
  type TransferAgentConfig,
  type TransferSectorConfig,
  type Weekday,
} from '@talk/shared';
import type { AppCtx } from '../ctx.js';
import type { Db } from '../db/client.js';
import { customFields } from '../db/schema.js';
import { badRequest } from '../lib/http-error.js';
import { loadGraphCatalog, validateGraph } from './graph.js';
import { createBot, toBotDto, uniqueBotName } from './repo.js';

// Spec §8 texts. They stay editable in the editor after creation.
const OUT_OF_HOURS_TEXT =
  'Estamos fora do horário de atendimento. Deixe sua mensagem que retornaremos assim que possível.';
const WELCOME_TEXT =
  'Olá {{contato.primeiro_nome}}! 👋 Sou o assistente virtual da {{empresa}}. Como posso te ajudar hoje?';
const MENU_TEXT = 'Escolha uma das opções abaixo digitando o número correspondente:';
const NOTICE_TEXT =
  '⚠️ COMUNICADO — Informamos que nosso WhatsApp está com uma demanda muito alta no momento. Por isso, pedimos um prazo de até 2 dias úteis para retorno. Enquanto isso, deixe aqui sua dúvida ou necessidade. Agradecemos a compreensão! 🤝';
const CPF_TEXT = 'Para agilizar, digite seu CPF:';
const CPF_INVALID_TEXT = 'CPF inválido, confira e digite de novo.';
const NOTIFY_TITLE = 'Nova conversa';
const NOTIFY_TEXT = 'Nova conversa de {{contato.nome}} — CPF {{contexto.cpf}}';
const CPF_FIELD_NAME = 'CPF';
const WORKDAYS: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri'];

// Menu option i ↔ multi_condition case:i ↔ destination key.
const DESTINATIONS = [
  { key: 'atendimento', option: '1', label: 'Atendimento' },
  { key: 'financeiro', option: '2', label: 'Financeiro' },
  { key: 'processos', option: '3', label: 'Processos' },
] as const;

/** Pure. Node id = node name; positions are a rough left-to-right grid (the editor's auto-layout tidies it). */
export function buildOfficeGraph(input: OfficeTemplateInput, cpfFieldId: string): BotGraph {
  const nodes: BotNode[] = [];
  const edges: BotEdge[] = [];
  const add = (name: string, type: BotNode['type'], config: Record<string, unknown>, col: number, row: number) => {
    nodes.push({ id: name, name, type, config, position: { x: col * 320, y: row * 200 } });
  };
  const link = (source: string, sourceHandle: string, target: string) => {
    edges.push({ id: `${source}-${sourceHandle}`, source, sourceHandle, target });
  };
  const message = (text: string) => ({ text, attachment: null, signature: false }) satisfies SendMessageConfig;

  add('inicio', 'start_channel', {}, 0, 1);
  add(
    'horario',
    'hours',
    {
      timezone: DEFAULT_TIMEZONE,
      intervals: [
        { from: '08:00', to: '12:00', days: WORKDAYS },
        { from: '14:00', to: '18:00', days: WORKDAYS },
      ],
    } satisfies HoursConfig,
    1,
    1,
  );
  add('fora_do_horario', 'send_message', message(OUT_OF_HOURS_TEXT), 2, 0);
  // function replacer: a company name with `$&` or `$1` stays literal
  add('boas_vindas', 'send_message', message(WELCOME_TEXT.replace('{{empresa}}', () => input.companyName)), 2, 2);
  add(
    'menu',
    'ask_choice',
    {
      text: MENU_TEXT,
      options: DESTINATIONS.map((d) => ({ key: d.option, label: d.label })),
      invalidRetries: 1,
      timeoutHours: 24,
    } satisfies AskChoiceConfig,
    3,
    2,
  );
  add('comunicado', 'send_message', message(NOTICE_TEXT), 4, 2);
  add(
    'cpf',
    'ask_input',
    {
      text: CPF_TEXT,
      validator: 'cpf',
      useLastMessage: false,
      invalidText: CPF_INVALID_TEXT,
      invalidRetries: 2,
      timeoutHours: null,
      saveToField: cpfFieldId,
    } satisfies AskInputConfig,
    5,
    2,
  );
  add(
    'destino',
    'multi_condition',
    {
      cases: DESTINATIONS.map((d) => ({
        label: d.label,
        logic: 'and' as const,
        rules: [{ left: { kind: 'var' as const, value: 'menu' }, operator: 'eq' as const, right: { kind: 'literal' as const, value: d.option } }],
      })),
    } satisfies MultiConditionConfig,
    6,
    2,
  );

  link('inicio', 'next', 'horario');
  link('horario', 'out', 'fora_do_horario');
  link('horario', 'in', 'boas_vindas');
  link('boas_vindas', 'next', 'menu');
  for (const d of DESTINATIONS) link('menu', `opt:${d.option}`, 'comunicado');
  link('comunicado', 'next', 'cpf');
  link('cpf', 'next', 'destino');
  link('cpf', 'invalid', 'destino'); // spec §8: "segue mesmo assim"

  DESTINATIONS.forEach((d, i) => {
    const dest: OfficeTemplateDestination = input.destinations[d.key];
    const setor = `setor_${d.key}`;
    add(setor, 'transfer_sector', { sectorId: dest.sectorId, onlyIfAgentAllowed: false } satisfies TransferSectorConfig, 7, i + 1);
    link('destino', `case:${i}`, setor);
    if (!dest.userId) return;
    const agente = `agente_${d.key}`;
    const aviso = `aviso_${d.key}`;
    add(agente, 'transfer_agent', { rule: 'specific', userIds: [dest.userId], sectorIds: [] } satisfies TransferAgentConfig, 8, i + 1);
    add(aviso, 'notify_agent', { title: NOTIFY_TITLE, text: NOTIFY_TEXT, target: 'owner', userIds: [] } satisfies NotifyAgentConfig, 9, i + 1);
    link(setor, 'next', agente);
    link(agente, 'next', aviso);
  });

  return { nodes, edges };
}

// ---------- Triagem inteligente ----------
const TRIAGE_MENU_TEXT =
  'Sobre qual assunto você quer falar? Digite o número da opção ou escreva o assunto (por exemplo: boleto, processo):';
const TRIAGE_RETRY_TEXT =
  'Desculpe, não entendi. Digite só o número da opção ou escreva o assunto (por exemplo: boleto, audiência):';
// message_contains ignores case and accents and matches substrings ("processo" also hits "processos").
const KEYWORDS: Record<(typeof DESTINATIONS)[number]['key'], string[]> = {
  financeiro: ['financeiro', 'boleto', 'pagamento', 'pagar', 'valor', 'cobrança', 'nota fiscal'],
  processos: ['processo', 'andamento', 'audiência', 'prazo', 'petição', 'sentença'],
  atendimento: ['atendimento', 'atendente', 'humano'],
};

/**
 * Pure, same inputs as buildOfficeGraph. CPF comes before the menu so each area path ends in its own transfer:
 * no block records an area picked by keyword, so asking the CPF after the menu would need one CPF branch per area.
 */
export function buildTriageGraph(input: OfficeTemplateInput, cpfFieldId: string): BotGraph {
  const nodes: BotNode[] = [];
  const edges: BotEdge[] = [];
  const add = (name: string, type: BotNode['type'], config: Record<string, unknown>, col: number, row: number) => {
    nodes.push({ id: name, name, type, config, position: { x: col * 320, y: row * 200 } });
  };
  const link = (source: string, sourceHandle: string, target: string) => {
    edges.push({ id: `${source}-${sourceHandle}`, source, sourceHandle, target });
  };
  const message = (text: string) => ({ text, attachment: null, signature: false }) satisfies SendMessageConfig;
  // invalidRetries 0: a free-text answer goes straight to the keyword checks; the retry is menu_2.
  const menu = (text: string) =>
    ({
      text,
      options: DESTINATIONS.map((d) => ({ key: d.option, label: d.label })),
      invalidRetries: 0,
      timeoutHours: 24,
    }) satisfies AskChoiceConfig;

  add('inicio', 'start_channel', {}, 0, 1);
  add(
    'horario',
    'hours',
    {
      timezone: DEFAULT_TIMEZONE,
      intervals: [
        { from: '08:00', to: '12:00', days: WORKDAYS },
        { from: '14:00', to: '18:00', days: WORKDAYS },
      ],
    } satisfies HoursConfig,
    1,
    1,
  );
  add('fora_do_horario', 'send_message', message(OUT_OF_HOURS_TEXT), 2, 0);
  add('boas_vindas', 'send_message', message(WELCOME_TEXT.replace('{{empresa}}', () => input.companyName)), 2, 2);
  add('cliente_conhecido', 'contact_field', { fieldId: cpfFieldId, operator: 'not_empty', value: '' } satisfies ContactFieldConfig, 3, 2);
  add(
    'cpf',
    'ask_input',
    {
      text: CPF_TEXT,
      validator: 'cpf',
      useLastMessage: false,
      invalidText: CPF_INVALID_TEXT,
      invalidRetries: 2,
      timeoutHours: null,
      saveToField: cpfFieldId,
    } satisfies AskInputConfig,
    4,
    3,
  );
  add('menu', 'ask_choice', menu(TRIAGE_MENU_TEXT), 5, 2);
  add('menu_2', 'ask_choice', menu(TRIAGE_RETRY_TEXT), 7, 4);

  link('inicio', 'next', 'horario');
  link('horario', 'out', 'fora_do_horario');
  link('horario', 'in', 'boas_vindas');
  link('boas_vindas', 'next', 'cliente_conhecido');
  link('cliente_conhecido', 'yes', 'menu'); // CPF already on file: skip the question
  link('cliente_conhecido', 'no', 'cpf');
  link('cpf', 'next', 'menu');
  link('cpf', 'invalid', 'menu'); // like the office flow: goes on anyway
  for (const m of ['menu', 'menu_2']) {
    for (const d of DESTINATIONS) link(m, `opt:${d.option}`, `confirma_${d.key}`);
    link(m, 'timeout', 'resumo_atendimento'); // nobody answered: hand over silently
  }

  /** Free text: one "Mensagem contém" per area, in order; the last "Não" goes to `fallback`. */
  const keywordChain = (from: string, suffix: string, keys: Array<keyof typeof KEYWORDS>, fallback: string, row: number) => {
    let prev = from;
    let handle = 'invalid';
    keys.forEach((k, i) => {
      const name = `palavras_${k}${suffix}`;
      add(name, 'message_contains', { keywords: KEYWORDS[k], match: 'any' } satisfies MessageContainsConfig, 6 + i * 2, row);
      link(prev, handle, name);
      link(name, 'yes', `confirma_${k}`);
      prev = name;
      handle = 'no';
    });
    link(prev, handle, fallback);
  };
  keywordChain('menu', '', ['financeiro', 'processos', 'atendimento'], 'menu_2', 3); // no match: the one retry
  keywordChain('menu_2', '_2', ['financeiro', 'processos'], 'confirma_atendimento', 5); // still unclear: Atendimento

  DESTINATIONS.forEach((d, i) => {
    const dest: OfficeTemplateDestination = input.destinations[d.key];
    const [confirma, resumo, setor] = [`confirma_${d.key}`, `resumo_${d.key}`, `setor_${d.key}`];
    add(
      confirma,
      'send_message',
      message(`Certo! Sua conversa foi encaminhada para o setor ${d.label}. Em breve alguém da equipe vai te responder.`),
      12,
      i * 2,
    );
    add(resumo, 'note', { text: `Resumo da triagem: {{contato.nome}} · Destino: ${d.label} · CPF: {{campo.CPF}}` } satisfies NoteConfig, 13, i * 2);
    add(setor, 'transfer_sector', { sectorId: dest.sectorId, onlyIfAgentAllowed: false } satisfies TransferSectorConfig, 14, i * 2);
    link(confirma, 'next', resumo);
    link(resumo, 'next', setor);
    if (!dest.userId) return;
    const [agente, aviso] = [`agente_${d.key}`, `aviso_${d.key}`];
    add(agente, 'transfer_agent', { rule: 'specific', userIds: [dest.userId], sectorIds: [] } satisfies TransferAgentConfig, 15, i * 2);
    add(
      aviso,
      'notify_agent',
      {
        title: `Nova conversa: ${d.label}`,
        text: `{{contato.nome}} · ${d.label} · CPF {{campo.CPF}}`,
        target: 'owner',
        userIds: [],
      } satisfies NotifyAgentConfig,
      16,
      i * 2,
    );
    link(setor, 'next', agente);
    link(agente, 'next', aviso);
  });

  return { nodes, edges };
}

const TEMPLATES: Record<BotTemplateKind, { name: string; description: string; build: typeof buildOfficeGraph; publish: boolean }> = {
  office: { name: 'Fluxo do escritório', description: 'Modelo: horário, menu, comunicado, CPF e transferência', build: buildOfficeGraph, publish: true },
  // A draft on purpose: the admin reviews the keywords and texts in the editor, then publishes.
  triagem: {
    name: 'Triagem inteligente',
    description: 'Modelo: horário, CPF só para quem não tem, menu com palavras-chave, uma nova tentativa e transferência',
    build: buildTriageGraph,
    publish: false,
  },
};

/** Reuses a field named exactly 'CPF' whatever its kind; otherwise creates it with kind 'cpf'. */
async function ensureCpfField(db: Db): Promise<string> {
  await db
    .insert(customFields)
    .values({ name: CPF_FIELD_NAME, kind: 'cpf', position: await db.$count(customFields) })
    .onConflictDoNothing({ target: customFields.name });
  const [row] = await db.select({ id: customFields.id }).from(customFields).where(eq(customFields.name, CPF_FIELD_NAME));
  return row.id;
}

export async function createOfficeTemplate(ctx: AppCtx, input: OfficeTemplateInput, createdBy: string): Promise<BotDto> {
  // Check the references before touching anything, so a bad request leaves no CPF field behind.
  const catalog = await loadGraphCatalog(ctx.db, null, [input.channelId]);
  if (!catalog.channelIds.has(input.channelId)) throw badRequest('Canal inexistente');
  for (const d of Object.values(input.destinations)) {
    if (!catalog.sectorIds.has(d.sectorId)) throw badRequest('Setor inexistente');
    if (d.userId && !catalog.activeUserIds.has(d.userId)) throw badRequest('Atendente inexistente');
  }

  const template = TEMPLATES[input.template ?? 'office'];
  const cpfFieldId = await ensureCpfField(ctx.db);
  catalog.customFieldIds.add(cpfFieldId);
  const graph = template.build(input, cpfFieldId);
  const problems = validateGraph(graph, catalog);
  if (problems.length > 0) throw badRequest(`O modelo gerou um fluxo inválido: ${problems[0].message}`);

  // ponytail: uniqueBotName then insert can race with a concurrent create of the same name (unique index → 500); admin-only, rare.
  const name = await uniqueBotName(ctx.db, input.name?.trim() || template.name);
  const row = await createBot(ctx.db, {
    name,
    description: template.description,
    graph,
    valid: true,
    publish: template.publish,
    createdBy,
    startChannelIds: [input.channelId],
  });
  return toBotDto(ctx.db, row); // status stays 'paused': the admin reviews, then activates
}
