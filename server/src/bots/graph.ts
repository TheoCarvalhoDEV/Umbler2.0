import { eq } from 'drizzle-orm';
import {
  NATIVE_CONTACT_FIELDS,
  RULE_OPERATOR_LABELS,
  WEEKDAYS,
  catalogEntry,
  outputsOf,
  type BlockType,
  type BotGraph,
  type BotNode,
  type GraphProblem,
} from '@talk/shared';
import type { Db, Tx } from '../db/client.js';
import { bots, channels, customFields, sectors, tags, users } from '../db/schema.js';
import { compileUserRegex } from './validators.js';

export interface GraphCatalog {
  selfBotId: string | null;
  sectorIds: Set<string>;
  activeUserIds: Set<string>;
  tagIds: Set<string>;
  customFieldIds: Set<string>;
  channelIds: Set<string>;
  botIds: Set<string>; // all bots, self included (self-call is reported separately)
  /** The bot's start_channel_ids: a start_channel block with none marked can never start. */
  startChannelIds: string[];
}

export async function loadGraphCatalog(
  db: Db | Tx,
  selfBotId: string | null,
  startChannelIds: string[],
): Promise<GraphCatalog> {
  const ids = (rows: Array<{ id: string }>) => new Set(rows.map((r) => r.id));
  // Sequential on purpose: one connection inside a tx (PGlite serializes anyway).
  return {
    selfBotId,
    sectorIds: ids(await db.select({ id: sectors.id }).from(sectors)),
    activeUserIds: ids(await db.select({ id: users.id }).from(users).where(eq(users.active, true))),
    tagIds: ids(await db.select({ id: tags.id }).from(tags)),
    customFieldIds: ids(await db.select({ id: customFields.id }).from(customFields)),
    channelIds: ids(await db.select({ id: channels.id }).from(channels)),
    botIds: ids(await db.select({ id: bots.id }).from(bots)),
    startChannelIds,
  };
}

export function isFieldRef(id: string, catalog: GraphCatalog): boolean {
  return catalog.customFieldIds.has(id) || NATIVE_CONTACT_FIELDS.some((f) => f.id === id);
}

export function startNodeOf(graph: BotGraph, entry: 'channel' | 'manual' | 'call'): BotNode | null {
  const find = (type: BlockType) => graph.nodes.find((n) => n.type === type) ?? null;
  if (entry === 'channel') return find('start_channel');
  if (entry === 'manual') return find('start_manual');
  return find('start_manual') ?? find('start_channel');
}

// ---------- config readers: the graph shape is zod-checked at the route, the config contents are not ----------
type Cfg = Record<string, unknown>;
const isObj = (v: unknown): v is Cfg => typeof v === 'object' && v !== null && !Array.isArray(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const filled = (v: unknown): boolean => str(v).trim() !== '';
const oneOf = (v: unknown, options: readonly string[]): boolean => typeof v === 'string' && options.includes(v);
const intIn = (v: unknown, min: number, max: number): boolean =>
  Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

const BAD = 'Configuração inválida';
const SECTOR_MISSING = 'Setor inexistente';
const USER_MISSING = 'Atendente inexistente ou inativo';
const TAG_MISSING = 'Etiqueta inexistente';
const FIELD_MISSING = 'Campo inexistente';
const CHANNEL_MISSING = 'Canal inexistente';
const BOT_MISSING = 'Chatbot inexistente';

const OPERATORS = Object.keys(RULE_OPERATOR_LABELS);
const LOGICS = ['and', 'or'];
const TIME_UNITS = ['seconds', 'minutes', 'hours', 'days'];
const VALIDATORS = ['any', 'email', 'phone', 'cpf', 'cnpj', 'media', 'regex'];
const MEDIA_TYPES = ['pdf', 'audio', 'image', 'video'];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const VAR_REF = /^[A-Za-z0-9_]{1,40}(:raw)?$/;
const NAME_RE = /^[A-Za-z0-9_]{1,40}$/;
// saveMedia(mediaDir, …, 'bots') writes bots/<uuid>.<ext>; anything else (e.g. '../') is refused.
const BOT_MEDIA_PATH = /^bots\/[0-9a-f-]{36}\.[a-z0-9]{1,8}$/;

function isTimeZone(v: unknown): boolean {
  if (typeof v !== 'string' || v === '') return false;
  try {
    new Intl.DateTimeFormat('pt-BR', { timeZone: v });
    return true;
  } catch {
    return false;
  }
}

function operandProblem(o: unknown, catalog: GraphCatalog): string | null {
  if (!isObj(o) || !oneOf(o.kind, ['var', 'field', 'literal'])) return BAD;
  if (o.kind === 'var') return VAR_REF.test(str(o.value)) ? null : 'Escolha a variável';
  if (o.kind === 'field') return isFieldRef(str(o.value), catalog) ? null : FIELD_MISSING;
  return typeof o.value === 'string' ? null : BAD;
}

function ruleProblems(r: unknown, catalog: GraphCatalog): string[] {
  if (!isObj(r) || !oneOf(r.operator, OPERATORS)) return [BAD];
  const out = [operandProblem(r.left, catalog)];
  if (r.operator !== 'empty' && r.operator !== 'not_empty') out.push(operandProblem(r.right, catalog));
  return out.filter((m): m is string => m !== null);
}

/** Per-type config problems (pt-BR). Exported for tests; validateGraph attaches them to the node. Never throws. */
export function validateNodeConfig(node: BotNode, catalog: GraphCatalog): string[] {
  const p: string[] = [];
  const c: Cfg = isObj(node.config) ? node.config : {};
  const need = (ok: boolean, message: string) => {
    if (!ok) p.push(message);
  };
  /** One id that must be chosen and exist. */
  const ref = (v: unknown, exists: (id: string) => boolean, emptyMsg: string, missingMsg: string) => {
    const id = str(v);
    if (id === '') p.push(emptyMsg);
    else if (!exists(id)) p.push(missingMsg);
  };
  /** A non-empty list of ids that must all exist. */
  const refs = (v: unknown, set: Set<string>, emptyMsg: string, missingMsg: string) => {
    const ids = list(v);
    if (ids.length === 0) p.push(emptyMsg);
    else if (!ids.every((id) => typeof id === 'string' && set.has(id))) p.push(missingMsg);
  };
  const rules = (v: unknown, prefix: string | null) => {
    const items = list(v);
    if (items.length === 0) p.push(prefix ? `${prefix}: Adicione pelo menos uma regra` : 'Adicione pelo menos uma regra');
    items.forEach((r, i) => {
      const label = prefix ? `${prefix}, regra ${i + 1}` : `Regra ${i + 1}`;
      for (const m of ruleProblems(r, catalog)) p.push(`${label}: ${m}`);
    });
  };
  const ask = () => {
    need(filled(c.text), 'Escreva a pergunta');
    need(intIn(c.invalidRetries, 0, 3), 'As tentativas devem ser de 0 a 3');
    const h = c.timeoutHours;
    need(
      h === undefined || h === null || (typeof h === 'number' && h > 0 && h <= 720),
      'O tempo sem resposta deve ser maior que zero e de no máximo 720 horas',
    );
  };

  switch (node.type) {
    case 'weekdays':
      need(isTimeZone(c.timezone), 'Fuso horário inválido');
      break;
    case 'hours': {
      need(isTimeZone(c.timezone), 'Fuso horário inválido');
      const intervals = list(c.intervals);
      need(intervals.length > 0, 'Adicione pelo menos um intervalo');
      intervals.forEach((iv, i) => {
        const n = `Intervalo ${i + 1}`;
        if (!isObj(iv) || !HHMM.test(str(iv.from)) || !HHMM.test(str(iv.to))) {
          p.push(`${n}: Horário inválido (use HH:MM)`);
          return;
        }
        need(str(iv.from) < str(iv.to), `${n}: O início deve ser antes do fim`);
        if (iv.days === undefined || iv.days === null) return; // absent = every day
        if (!Array.isArray(iv.days) || !iv.days.every((d) => oneOf(d, WEEKDAYS))) p.push(`${n}: ${BAD}`);
        else need(iv.days.length > 0, `${n}: Escolha pelo menos um dia`);
      });
      break;
    }
    case 'wait_interval':
      need(oneOf(c.unit, TIME_UNITS), BAD);
      if (c.mode === 'fixed') {
        need(typeof c.amount === 'number' && Number.isFinite(c.amount) && c.amount > 0, 'Informe um tempo maior que zero');
      } else if (c.mode === 'variable') {
        need(filled(c.variable), 'Informe a variável com o tempo');
      } else {
        p.push(BAD);
      }
      break;
    case 'condition':
      need(oneOf(c.logic, LOGICS), BAD);
      rules(c.rules, null);
      break;
    case 'multi_condition': {
      const cases = list(c.cases);
      need(cases.length >= 1 && cases.length <= 20, 'Adicione de 1 a 20 casos');
      cases.forEach((k, i) => {
        const n = `Caso ${i + 1}`;
        if (!isObj(k)) {
          p.push(`${n}: ${BAD}`);
          return;
        }
        need(oneOf(k.logic, LOGICS), `${n}: ${BAD}`);
        rules(k.rules, n);
      });
      break;
    }
    case 'value':
      p.push(...ruleProblems(c, catalog));
      break;
    case 'distribute': {
      const branches = list(c.branches);
      need(branches.length >= 2 && branches.length <= 10, 'Adicione de 2 a 10 caminhos');
      branches.forEach((b, i) =>
        need(
          isObj(b) && Number.isSafeInteger(b.weight) && (b.weight as number) > 0,
          `Caminho ${i + 1}: O peso deve ser um número inteiro maior que zero`,
        ),
      );
      break;
    }
    case 'contact_field':
      ref(c.fieldId, (id) => isFieldRef(id, catalog), 'Escolha o campo', FIELD_MISSING);
      need(oneOf(c.operator, OPERATORS), BAD);
      need(typeof c.value === 'string', BAD);
      break;
    case 'tags':
      need(oneOf(c.mode, ['any', 'all', 'none']), BAD);
      refs(c.tagIds, catalog.tagIds, 'Escolha pelo menos uma etiqueta', TAG_MISSING);
      break;
    case 'chat_sector':
      refs(c.sectorIds, catalog.sectorIds, 'Escolha pelo menos um setor', SECTOR_MISSING);
      break;
    case 'chat_channel':
      refs(c.channelIds, catalog.channelIds, 'Escolha pelo menos um canal', CHANNEL_MISSING);
      break;
    case 'chat_agent':
      need(oneOf(c.mode, ['none', 'any', 'specific']), BAD);
      if (c.mode === 'specific') refs(c.userIds, catalog.activeUserIds, 'Escolha pelo menos um atendente', USER_MISSING);
      break;
    case 'message_contains': {
      const keywords = list(c.keywords);
      need(oneOf(c.match, ['any', 'all']), BAD);
      if (keywords.length === 0) p.push('Adicione pelo menos uma palavra');
      else need(keywords.every(filled), 'Há uma palavra vazia');
      break;
    }
    case 'send_message': {
      const att = c.attachment;
      const hasAtt = att !== undefined && att !== null;
      need(typeof c.text === 'string', BAD);
      if (hasAtt) {
        need(
          isObj(att) && BOT_MEDIA_PATH.test(str(att.path)) && filled(att.name) && filled(att.mime) && typeof att.size === 'number',
          'Anexo inválido',
        );
      }
      need(filled(c.text) || hasAtt, 'Escreva a mensagem ou anexe um arquivo');
      break;
    }
    case 'note':
      need(filled(c.text), 'Escreva a nota');
      break;
    case 'ask_choice': {
      ask();
      const options = list(c.options);
      need(options.length >= 1 && options.length <= 20, 'Adicione de 1 a 20 opções');
      const keys = new Set<string>();
      options.forEach((o, i) => {
        const n = `Opção ${i + 1}`;
        const key = isObj(o) ? str(o.key) : '';
        if (key.length < 1 || key.length > 10 || key !== key.trim()) {
          p.push(`${n}: A chave deve ter de 1 a 10 caracteres, sem espaços nas pontas`);
        } else if (keys.has(key.toLowerCase())) {
          p.push(`${n}: Chave repetida`);
        } else {
          keys.add(key.toLowerCase());
        }
        need(isObj(o) && filled(o.label), `${n}: Escreva o texto da opção`);
      });
      break;
    }
    case 'ask_input':
      ask();
      need(oneOf(c.validator, VALIDATORS), BAD);
      if (c.validator === 'media') {
        const types = c.mediaTypes;
        need(types === undefined || types === null || (Array.isArray(types) && types.every((t) => oneOf(t, MEDIA_TYPES))), BAD);
      }
      if (c.validator === 'regex') {
        need(compileUserRegex(str(c.regex)) !== null, 'Expressão regular inválida (até 200 caracteres)');
      }
      if (c.saveToField !== undefined && c.saveToField !== null && c.saveToField !== '') {
        need(isFieldRef(str(c.saveToField), catalog), FIELD_MISSING);
      }
      break;
    case 'set_contact_field':
      ref(c.fieldId, (id) => isFieldRef(id, catalog), 'Escolha o campo', FIELD_MISSING);
      need(typeof c.value === 'string', BAD);
      break;
    case 'edit_tags': {
      const ids = [...list(c.add), ...list(c.remove)];
      if (ids.length === 0) p.push('Escolha pelo menos uma etiqueta');
      else need(ids.every((id) => typeof id === 'string' && catalog.tagIds.has(id)), TAG_MISSING);
      break;
    }
    case 'transfer_sector':
      ref(c.sectorId, (id) => catalog.sectorIds.has(id), 'Escolha o setor', SECTOR_MISSING);
      break;
    case 'transfer_agent':
      if (c.rule === 'specific') refs(c.userIds, catalog.activeUserIds, 'Escolha pelo menos um atendente', USER_MISSING);
      else if (c.rule === 'least_busy') refs(c.sectorIds, catalog.sectorIds, 'Escolha pelo menos um setor', SECTOR_MISSING);
      else p.push(BAD);
      break;
    case 'privacy':
      need(oneOf(c.mode, ['private', 'public']), BAD);
      break;
    case 'notify_agent':
      need(filled(c.title), 'Escreva o título da notificação');
      need(filled(c.text), 'Escreva o texto da notificação');
      if (c.target === 'users') refs(c.userIds, catalog.activeUserIds, 'Escolha pelo menos um atendente', USER_MISSING);
      else need(c.target === 'owner', BAD);
      break;
    case 'call_flow':
      if (catalog.selfBotId !== null && c.botId === catalog.selfBotId) p.push('Um fluxo não pode acionar a si mesmo');
      else ref(c.botId, (id) => catalog.botIds.has(id), 'Escolha o chatbot', BOT_MISSING);
      break;
    case 'close_chat':
      need(typeof c.sendClosingMessage === 'boolean', BAD);
      need(c.closingText === undefined || c.closingText === null || typeof c.closingText === 'string', BAD);
      break;
    case 'start_channel':
      need(catalog.startChannelIds.length > 0, 'Marque ao menos um canal neste início');
      break;
    case 'start_manual':
    case 'contact_active':
    case 'first_chat':
    case 'chat_status':
    case 'parallel_bot':
    case 'block_contact':
    case 'sticky_note':
      break;
  }
  return p;
}

const isStart = (t: BlockType) => t === 'start_channel' || t === 'start_manual';

/** [] = valid. Problems come in a stable order: starts, names, configs, edges, missing connections. Never throws. */
export function validateGraph(graph: BotGraph, catalog: GraphCatalog): GraphProblem[] {
  const problems: GraphProblem[] = [];
  const add = (nodeId: string | null, message: string) => problems.push({ nodeId, message });

  const byId = new Map<string, BotNode>();
  for (const n of graph.nodes) {
    if (byId.has(n.id)) add(n.id, 'Há dois blocos com o mesmo id');
    else byId.set(n.id, n);
  }

  if (!graph.nodes.some((n) => isStart(n.type))) add(null, 'O fluxo precisa de um bloco de início');
  for (const type of ['start_channel', 'start_manual'] as const) {
    for (const extra of graph.nodes.filter((n) => n.type === type).slice(1)) {
      add(extra.id, `Só pode haver um bloco "${catalogEntry(type).label}"`);
    }
  }

  const names = new Set<string>();
  for (const n of graph.nodes) {
    if (n.type === 'sticky_note') continue;
    const name = n.name ?? '';
    if (!NAME_RE.test(name)) add(n.id, 'Nome inválido: use de 1 a 40 letras sem acento, números ou _');
    else if (names.has(name.toLowerCase())) add(n.id, `Já existe outro bloco com o nome "${name}"`);
    else names.add(name.toLowerCase());
  }

  for (const n of graph.nodes) for (const m of validateNodeConfig(n, catalog)) add(n.id, m);

  const used = new Set<string>(); // `${source}\n${handle}` of accepted edges
  const hasInput = new Set<string>();
  for (const e of graph.edges) {
    const src = byId.get(e.source);
    const dst = byId.get(e.target);
    if (!src || !dst) {
      add(src ? src.id : null, 'Conexão com um bloco que não existe');
      continue;
    }
    if (src.type === 'sticky_note' || dst.type === 'sticky_note') {
      add(src.type === 'sticky_note' ? src.id : dst.id, 'Anotações não se conectam a outros blocos');
      continue;
    }
    if (isStart(dst.type)) {
      add(dst.id, 'O bloco de início não pode ter entrada');
      continue;
    }
    const output = outputsOf(src.type, src.config).find((o) => o.id === e.sourceHandle);
    if (!output) {
      add(src.id, 'Conexão em uma saída que não existe');
      continue;
    }
    const key = `${src.id}\n${e.sourceHandle}`;
    if (used.has(key)) {
      add(src.id, `A saída "${output.label}" tem mais de uma conexão`);
      continue;
    }
    used.add(key);
    hasInput.add(dst.id);
  }

  for (const n of graph.nodes) {
    if (isStart(n.type)) {
      if (!used.has(`${n.id}\nnext`)) add(n.id, 'Conecte a saída do bloco de início');
    } else if (n.type !== 'sticky_note' && !hasInput.has(n.id)) {
      add(n.id, 'Bloco sem entrada');
    }
  }
  return problems;
}
