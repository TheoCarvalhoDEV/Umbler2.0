import { eq } from 'drizzle-orm';
import {
  DEFAULT_TIMEZONE,
  type AskChoiceConfig,
  type AskInputConfig,
  type BotDto,
  type BotEdge,
  type BotGraph,
  type BotNode,
  type HoursConfig,
  type MultiConditionConfig,
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
const TEMPLATE_NAME = 'Fluxo do escritório';
const TEMPLATE_DESCRIPTION = 'Modelo: horário, menu, comunicado, CPF e transferência';
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
  const catalog = await loadGraphCatalog(ctx.db, null);
  if (!catalog.channelIds.has(input.channelId)) throw badRequest('Canal inexistente');
  for (const d of Object.values(input.destinations)) {
    if (!catalog.sectorIds.has(d.sectorId)) throw badRequest('Setor inexistente');
    if (d.userId && !catalog.activeUserIds.has(d.userId)) throw badRequest('Atendente inexistente');
  }

  const cpfFieldId = await ensureCpfField(ctx.db);
  catalog.customFieldIds.add(cpfFieldId);
  const graph = buildOfficeGraph(input, cpfFieldId);
  const problems = validateGraph(graph, catalog);
  if (problems.length > 0) throw badRequest(`O modelo gerou um fluxo inválido: ${problems[0].message}`);

  // ponytail: uniqueBotName then insert can race with a concurrent create of the same name (unique index → 500); admin-only, rare.
  const name = await uniqueBotName(ctx.db, input.name?.trim() || TEMPLATE_NAME);
  const row = await createBot(ctx.db, {
    name,
    description: TEMPLATE_DESCRIPTION,
    graph,
    valid: true,
    publish: true,
    createdBy,
    startChannelIds: [input.channelId],
  });
  return toBotDto(ctx.db, row); // status stays 'paused': the admin reviews, then activates
}
