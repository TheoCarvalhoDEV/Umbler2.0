// Chatbot block catalog shared by the editor (web) and the engine (server): block types, config shapes, default
// configs, node names, the palette catalog and outputsOf, the single source for editor handles and engine edges.
// Runtime code with no imports: tsx (server) and Vite (web) load this source directly.

// ---------- block types ----------
export const BLOCK_TYPES = [
  // start (2)
  'start_channel', 'start_manual',
  // condition (17)
  'weekdays', 'hours', 'wait_interval', 'condition', 'multi_condition', 'value', 'distribute',
  'contact_active', 'first_chat', 'contact_field', 'tags', 'chat_sector', 'chat_channel', 'chat_agent',
  'chat_status', 'message_contains', 'parallel_bot',
  // action (12)
  'send_message', 'note', 'ask_choice', 'ask_input', 'set_contact_field', 'edit_tags', 'transfer_sector',
  'transfer_agent', 'privacy', 'notify_agent', 'call_flow', 'block_contact',
  // finish (1)
  'close_chat',
  // utility (1)
  'sticky_note',
] as const; // 33 entries: the spec's tally says 34, its enumeration has 33 (see the plan's Global Constraints)
export type BlockType = (typeof BLOCK_TYPES)[number];
export type BlockCategory = 'start' | 'condition' | 'action' | 'finish' | 'utility';

// ---------- graph ----------
export interface BotGraph { nodes: BotNode[]; edges: BotEdge[] }
export interface BotNode {
  id: string;                               // React Flow id, 1..64 chars
  type: BlockType;
  position: { x: number; y: number };
  config: Record<string, unknown>;          // shape = BlockConfigMap[type]; cast with configOf()
  name?: string;                            // contexto label: /^[A-Za-z0-9_]{1,40}$/, unique case-insensitively; required on every non-sticky node
}
export interface BotEdge { id: string; source: string; sourceHandle: string; target: string }
export interface BlockOutput { id: string; label: string }

// ---------- shared config pieces ----------
export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export const WEEKDAYS: readonly Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export const WEEKDAY_LABELS: Record<Weekday, string> = {
  mon: 'Segunda', tue: 'Terça', wed: 'Quarta', thu: 'Quinta', fri: 'Sexta', sat: 'Sábado', sun: 'Domingo',
};
export const DEFAULT_TIMEZONE = 'America/Cuiaba';
export type TimeUnit = 'seconds' | 'minutes' | 'hours' | 'days';
export type Logic = 'and' | 'or';
export type RuleOperator = 'eq' | 'neq' | 'contains' | 'not_contains' | 'starts' | 'gt' | 'gte' | 'lt' | 'lte' | 'empty' | 'not_empty';
export const RULE_OPERATOR_LABELS: Record<RuleOperator, string> = {
  eq: 'é igual a', neq: 'é diferente de', contains: 'contém', not_contains: 'não contém', starts: 'começa com',
  gt: 'maior que', gte: 'maior ou igual a', lt: 'menor que', lte: 'menor ou igual a', empty: 'está vazio', not_empty: 'não está vazio',
};
/** var: value = node name, optionally "<name>:raw" · field: value = custom field id or a NATIVE_CONTACT_FIELDS id · literal: text (variables rendered) */
export interface Operand { kind: 'var' | 'field' | 'literal'; value: string }
export interface Rule { left: Operand; operator: RuleOperator; right?: Operand } // right ignored for empty / not_empty
export type NativeFieldId = 'native:name' | 'native:email' | 'native:landline' | 'native:city' | 'native:state';
export const NATIVE_CONTACT_FIELDS: ReadonlyArray<{ id: NativeFieldId; label: string }> = [
  { id: 'native:name', label: 'Nome' }, { id: 'native:email', label: 'E-mail' }, { id: 'native:landline', label: 'Telefone fixo' },
  { id: 'native:city', label: 'Cidade' }, { id: 'native:state', label: 'Estado' },
]; // city/state live in contacts.address.city / .state
export type InputValidator = 'any' | 'email' | 'phone' | 'cpf' | 'cnpj' | 'media' | 'regex';
export type MediaType = 'pdf' | 'audio' | 'image' | 'video';
export type StickyColor = 'yellow' | 'blue' | 'green' | 'pink' | 'gray';
/** File in the bot media library: path is relative to config.mediaDir and always starts with "bots/". */
export interface BotAttachment { path: string; name: string; mime: string; size: number }

// ---------- per-block config ----------
export type EmptyConfig = Record<string, never>;
export interface WeekdaysConfig { timezone: string }
export interface HoursInterval { from: string; to: string; days?: Weekday[] } // 'HH:MM', from < to, `to` exclusive; days absent = every day
export interface HoursConfig { timezone: string; intervals: HoursInterval[] }
export interface WaitIntervalConfig {
  mode: 'fixed' | 'variable';
  amount: number;                 // fixed: > 0
  unit: TimeUnit;
  variable?: string;              // variable: text with variables (e.g. "{{contexto.prazo}}") rendered then Number(); must be > 0
  resumeOnReply: boolean;         // true adds output 'replied'
}
export interface ConditionConfig { logic: Logic; rules: Rule[] }                      // rules.length >= 1
export interface MultiConditionCase { label: string; logic: Logic; rules: Rule[] }
export interface MultiConditionConfig { cases: MultiConditionCase[] }                  // 1..20
export type ValueConfig = Rule;
export interface DistributeBranch { label: string; weight: number }                    // integer > 0
export interface DistributeConfig { branches: DistributeBranch[] }                     // 2..10
export interface ContactFieldConfig { fieldId: string; operator: RuleOperator; value: string }
export interface TagsConfig { mode: 'any' | 'all' | 'none'; tagIds: string[] }
export interface ChatSectorConfig { sectorIds: string[] }
export interface ChatChannelConfig { channelIds: string[] }
export interface ChatAgentConfig { mode: 'none' | 'any' | 'specific'; userIds: string[] }
export interface MessageContainsConfig { keywords: string[]; match: 'any' | 'all' }    // always ignores case and accents
export interface SendMessageConfig { text: string; attachment?: BotAttachment | null; signature: false } // text or attachment required
export interface NoteConfig { text: string }
export interface ChoiceOption { key: string; label: string }                           // key 1..10 chars, unique case-insensitively
export interface AskChoiceConfig {
  text: string; options: ChoiceOption[];          // 1..20 options
  invalidText?: string; invalidRetries: number;   // 0..3, default 1
  timeoutHours?: number | null;                   // null/absent = wait forever; 0 < h <= 720; set adds output 'timeout'
}
export interface AskInputConfig {
  text: string; validator: InputValidator;
  mediaTypes?: MediaType[];                       // validator 'media': empty/absent = any media
  regex?: string;                                 // validator 'regex': compiles with 'u', length <= 200
  useLastMessage: boolean;                        // try the last inbound message first; ask only if it does not validate
  invalidText?: string; invalidRetries: number;   // 0..3, default 1
  timeoutHours?: number | null;
  saveToField?: string | null;                    // custom field id or NativeFieldId
}
export interface SetContactFieldConfig { fieldId: string; value: string }               // custom field id or NativeFieldId
export interface EditTagsConfig { add: string[]; remove: string[] }                    // contact tags
export interface TransferSectorConfig { sectorId: string; onlyIfAgentAllowed: boolean }
export interface TransferAgentConfig { rule: 'specific' | 'least_busy'; userIds: string[]; sectorIds: string[] }
export interface PrivacyConfig { mode: 'private' | 'public' }
export interface NotifyAgentConfig { title: string; text: string; target: 'owner' | 'users'; userIds: string[] }
export interface CallFlowConfig { botId: string; continueAfter: boolean }
export interface CloseChatConfig { sendClosingMessage: boolean; closingText?: string } // closingText empty = settings closing message
export interface StickyNoteConfig { text: string; color: StickyColor }

export interface BlockConfigMap {
  start_channel: EmptyConfig; start_manual: EmptyConfig;
  weekdays: WeekdaysConfig; hours: HoursConfig; wait_interval: WaitIntervalConfig; condition: ConditionConfig;
  multi_condition: MultiConditionConfig; value: ValueConfig; distribute: DistributeConfig; contact_active: EmptyConfig;
  first_chat: EmptyConfig; contact_field: ContactFieldConfig; tags: TagsConfig; chat_sector: ChatSectorConfig;
  chat_channel: ChatChannelConfig; chat_agent: ChatAgentConfig; chat_status: EmptyConfig;
  message_contains: MessageContainsConfig; parallel_bot: EmptyConfig;
  send_message: SendMessageConfig; note: NoteConfig; ask_choice: AskChoiceConfig; ask_input: AskInputConfig;
  set_contact_field: SetContactFieldConfig; edit_tags: EditTagsConfig; transfer_sector: TransferSectorConfig;
  transfer_agent: TransferAgentConfig; privacy: PrivacyConfig; notify_agent: NotifyAgentConfig; call_flow: CallFlowConfig;
  block_contact: EmptyConfig; close_chat: CloseChatConfig; sticky_note: StickyNoteConfig;
}

export function configOf<T extends BlockType>(node: BotNode & { type: T }): BlockConfigMap[T] {
  return node.config as unknown as BlockConfigMap[T];
}

const blankRule = (): Rule => ({ left: { kind: 'var', value: '' }, operator: 'eq', right: { kind: 'literal', value: '' } });
const empty = (): EmptyConfig => ({});

// Factories, so every call returns a fresh object the editor can change without touching other nodes.
const DEFAULTS: { [K in BlockType]: () => BlockConfigMap[K] } = {
  start_channel: empty,
  start_manual: empty,
  weekdays: () => ({ timezone: DEFAULT_TIMEZONE }),
  hours: () => ({ timezone: DEFAULT_TIMEZONE, intervals: [{ from: '08:00', to: '18:00', days: ['mon', 'tue', 'wed', 'thu', 'fri'] }] }),
  wait_interval: () => ({ mode: 'fixed', amount: 5, unit: 'minutes', resumeOnReply: false }),
  condition: () => ({ logic: 'and', rules: [blankRule()] }),
  multi_condition: () => ({ cases: [{ label: 'Caso 1', logic: 'and', rules: [blankRule()] }] }),
  value: blankRule,
  distribute: () => ({ branches: [{ label: 'A', weight: 1 }, { label: 'B', weight: 1 }] }),
  contact_active: empty,
  first_chat: empty,
  contact_field: () => ({ fieldId: '', operator: 'eq', value: '' }),
  tags: () => ({ mode: 'any', tagIds: [] }),
  chat_sector: () => ({ sectorIds: [] }),
  chat_channel: () => ({ channelIds: [] }),
  chat_agent: () => ({ mode: 'any', userIds: [] }),
  chat_status: empty,
  message_contains: () => ({ keywords: [], match: 'any' }),
  parallel_bot: empty,
  send_message: () => ({ text: '', attachment: null, signature: false }),
  note: () => ({ text: '' }),
  ask_choice: () => ({ text: '', options: [{ key: '1', label: '' }], invalidRetries: 1, timeoutHours: null }),
  ask_input: () => ({ text: '', validator: 'any', useLastMessage: false, invalidRetries: 1, timeoutHours: null, saveToField: null }),
  set_contact_field: () => ({ fieldId: '', value: '' }),
  edit_tags: () => ({ add: [], remove: [] }),
  transfer_sector: () => ({ sectorId: '', onlyIfAgentAllowed: false }),
  transfer_agent: () => ({ rule: 'specific', userIds: [], sectorIds: [] }),
  privacy: () => ({ mode: 'private' }),
  notify_agent: () => ({ title: '', text: '', target: 'owner', userIds: [] }),
  call_flow: () => ({ botId: '', continueAfter: false }),
  block_contact: empty,
  close_chat: () => ({ sendClosingMessage: true }),
  sticky_note: () => ({ text: '', color: 'yellow' }),
};

export function defaultConfig<T extends BlockType>(type: T): BlockConfigMap[T] {
  return DEFAULTS[type]();
}

/** `type` if free, else `${type}_2`, `${type}_3`… (compared case-insensitively against `taken`). */
export function nodeNameFor(type: BlockType, taken: Iterable<string>): string {
  const used = new Set(Array.from(taken, (n) => n.toLowerCase()));
  if (!used.has(type)) return type;
  for (let i = 2; ; i++) if (!used.has(`${type}_${i}`)) return `${type}_${i}`;
}

// ---------- catalog ----------
export interface BlockCatalogEntry { type: BlockType; category: BlockCategory; label: string; description: string; icon: string } // icon = Phosphor component name
export const BLOCK_CATEGORY_LABELS: Record<BlockCategory, string> = {
  start: 'Início', condition: 'Condições', action: 'Ações', finish: 'Finalização', utility: 'Utilitários',
};

// A Record keyed by BlockType, so a missing or extra type fails the typecheck.
const CATALOG: Record<BlockType, Omit<BlockCatalogEntry, 'type'>> = {
  start_channel: { category: 'start', label: 'Iniciar por um canal', description: 'Inicia quando um contato abre uma conversa nos canais escolhidos', icon: 'WhatsappLogo' },
  start_manual: { category: 'start', label: 'Iniciar manualmente', description: 'Um atendente inicia este fluxo pela conversa', icon: 'HandTap' },
  weekdays: { category: 'condition', label: 'Dia da semana', description: 'Segue um caminho para cada dia da semana', icon: 'CalendarBlank' },
  hours: { category: 'condition', label: 'Horário', description: 'Separa dentro e fora do horário de atendimento', icon: 'Clock' },
  wait_interval: { category: 'condition', label: 'Aguardar intervalo', description: 'Espera um tempo antes de continuar', icon: 'Hourglass' },
  condition: { category: 'condition', label: 'Condição', description: 'Verifica regras e segue por Sim ou Não', icon: 'GitBranch' },
  multi_condition: { category: 'condition', label: 'Várias condições', description: 'Segue o primeiro caso cujas regras forem verdadeiras', icon: 'TreeStructure' },
  value: { category: 'condition', label: 'Comparar valor', description: 'Compara uma variável ou campo com um valor', icon: 'Equals' },
  distribute: { category: 'condition', label: 'Distribuir', description: 'Divide os contatos entre caminhos por peso', icon: 'Shuffle' },
  contact_active: { category: 'condition', label: 'Contato ativo', description: 'O contato enviou mensagem nas últimas 24 horas?', icon: 'Pulse' },
  first_chat: { category: 'condition', label: 'Primeira conversa', description: 'É a primeira conversa do contato neste canal?', icon: 'Sparkle' },
  contact_field: { category: 'condition', label: 'Campo do contato', description: 'Verifica o valor de um campo do contato', icon: 'IdentificationCard' },
  tags: { category: 'condition', label: 'Etiquetas do contato', description: 'Verifica as etiquetas do contato', icon: 'Tag' },
  chat_sector: { category: 'condition', label: 'Setor da conversa', description: 'A conversa está em um destes setores?', icon: 'UsersThree' },
  chat_channel: { category: 'condition', label: 'Canal da conversa', description: 'A conversa é de um destes canais?', icon: 'Broadcast' },
  chat_agent: { category: 'condition', label: 'Atendente da conversa', description: 'Verifica quem é o atendente da conversa', icon: 'UserCircle' },
  chat_status: { category: 'condition', label: 'Conversa esperando', description: 'A conversa está em "Esperando"?', icon: 'HourglassMedium' },
  message_contains: { category: 'condition', label: 'Mensagem contém', description: 'A última mensagem do contato contém estas palavras?', icon: 'MagnifyingGlass' },
  parallel_bot: { category: 'condition', label: 'Outro chatbot rodando', description: 'Existe outro chatbot em execução nesta conversa?', icon: 'Robot' },
  send_message: { category: 'action', label: 'Enviar mensagem', description: 'Envia um texto e, se quiser, um arquivo', icon: 'ChatText' },
  note: { category: 'action', label: 'Nota interna', description: 'Registra uma nota visível só para a equipe', icon: 'NotePencil' },
  ask_choice: { category: 'action', label: 'Pedir para escolher', description: 'Envia opções numeradas e segue pela escolhida', icon: 'ListNumbers' },
  ask_input: { category: 'action', label: 'Pedir informação', description: 'Pede um dado e valida a resposta', icon: 'Textbox' },
  set_contact_field: { category: 'action', label: 'Preencher campo', description: 'Grava um valor em um campo do contato', icon: 'PencilSimple' },
  edit_tags: { category: 'action', label: 'Editar etiquetas', description: 'Adiciona ou remove etiquetas do contato', icon: 'TagSimple' },
  transfer_sector: { category: 'action', label: 'Transferir para setor', description: 'Move a conversa para outro setor', icon: 'ArrowsLeftRight' },
  transfer_agent: { category: 'action', label: 'Transferir para atendente', description: 'Define o atendente da conversa', icon: 'UserSwitch' },
  privacy: { category: 'action', label: 'Privacidade', description: 'Torna a conversa privada ou pública', icon: 'LockSimple' },
  notify_agent: { category: 'action', label: 'Notificar atendente', description: 'Envia uma notificação para a equipe', icon: 'BellRinging' },
  call_flow: { category: 'action', label: 'Acionar outro fluxo', description: 'Inicia outro chatbot nesta conversa', icon: 'FlowArrow' },
  block_contact: { category: 'action', label: 'Bloquear contato', description: 'Bloqueia o contato e finaliza as conversas dele', icon: 'Prohibit' },
  close_chat: { category: 'finish', label: 'Finalizar conversa', description: 'Finaliza a conversa e encerra o chatbot', icon: 'CheckCircle' },
  sticky_note: { category: 'utility', label: 'Anotação', description: 'Um lembrete no editor; não executa', icon: 'Note' },
};

export const BLOCK_CATALOG: readonly BlockCatalogEntry[] = BLOCK_TYPES.map((type) => ({ type, ...CATALOG[type] }));

export function catalogEntry(type: BlockType): BlockCatalogEntry {
  return { type, ...CATALOG[type] };
}

// ---------- outputs (single source for editor handles and engine edges) ----------
const out = (id: string, label: string): BlockOutput => ({ id, label });
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const field = (item: unknown, key: string): unknown =>
  item !== null && typeof item === 'object' ? (item as Record<string, unknown>)[key] : undefined;
const text = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

/** Outputs in display order. Never throws on a malformed config: a missing array counts as []. */
export function outputsOf(type: BlockType, config: Record<string, unknown>): BlockOutput[] {
  const c: Record<string, unknown> = config !== null && typeof config === 'object' ? config : {};
  const timeout = typeof c.timeoutHours === 'number' && c.timeoutHours > 0 ? [out('timeout', 'Sem resposta')] : [];
  switch (type) {
    case 'start_channel':
    case 'start_manual':
    case 'note':
      return [out('next', 'Próximo')];
    case 'weekdays':
      return WEEKDAYS.map((d) => out(`day:${d}`, WEEKDAY_LABELS[d]));
    case 'hours':
      return [out('in', 'Dentro do horário'), out('out', 'Fora do horário')];
    case 'wait_interval':
      return c.resumeOnReply === true
        ? [out('next', 'Depois do tempo'), out('replied', 'Se responder antes')]
        : [out('next', 'Depois do tempo')];
    case 'condition':
    case 'value':
    case 'contact_active':
    case 'first_chat':
    case 'contact_field':
    case 'tags':
    case 'chat_sector':
    case 'chat_channel':
    case 'chat_agent':
    case 'chat_status':
    case 'message_contains':
    case 'parallel_bot':
      return [out('yes', 'Sim'), out('no', 'Não')];
    case 'multi_condition':
      return [
        ...list(c.cases).map((k, i) => out(`case:${i}`, text(field(k, 'label')) || `Caso ${i + 1}`)),
        out('else', 'Senão'),
      ];
    case 'distribute': {
      const branches = list(c.branches);
      const weights = branches.map((b) => {
        const w = field(b, 'weight');
        return typeof w === 'number' && w > 0 ? w : 0;
      });
      const total = weights.reduce((a, b) => a + b, 0);
      return branches.map((b, i) => {
        const pct = total > 0 ? Math.round(((weights[i] ?? 0) / total) * 100) : 0;
        return out(`branch:${i}`, `${text(field(b, 'label')) || `Caminho ${i + 1}`} (${pct}%)`);
      });
    }
    case 'send_message':
    case 'set_contact_field':
    case 'edit_tags':
    case 'transfer_sector':
    case 'transfer_agent':
    case 'privacy':
    case 'notify_agent':
    case 'call_flow':
      return [out('next', 'Próximo'), out('error', 'Se não for possível')];
    case 'ask_choice':
      return [
        ...list(c.options).map((o) => {
          const key = text(field(o, 'key'));
          return out(`opt:${key}`, `${key} · ${text(field(o, 'label'))}`);
        }),
        out('invalid', 'Resposta inválida'),
        ...timeout,
        out('error', 'Se não for possível'),
      ];
    case 'ask_input':
      return [out('next', 'Resposta válida'), out('invalid', 'Resposta inválida'), ...timeout, out('error', 'Se não for possível')];
    case 'block_contact':
      return [out('error', 'Se não for possível')];
    case 'close_chat':
    case 'sticky_note':
      return [];
  }
}

// ---------- runs ----------
export type BotRunState = 'running' | 'waiting_reply' | 'waiting_timer' | 'waiting_flow' | 'finished' | 'stopped' | 'failed';
// 'waiting_flow' (not in spec §3; added on purpose) = parent of a call_flow with continueAfter, waiting for the child run.
export const NON_TERMINAL_RUN_STATES: readonly BotRunState[] = ['running', 'waiting_reply', 'waiting_timer', 'waiting_flow'];
export interface VarValue { raw: string; value: string; label?: string }
export type BotRunVars = Record<string, VarValue>;                  // key = node.name
export interface BotRunStep { node: string; at: string; outcome: string } // outcome = handle id, 'wait:reply'|'wait:timer'|'wait:flow', 'finished', 'failed', 'error'
export type BotStopReason = 'manual' | 'agent_message' | 'transfer' | 'chat_closed' | 'contact_blocked';
export type BotRunningBehavior = 'ask' | 'stop' | 'keep';
export type BotAction = 'stop' | 'keep';
export const MAX_STEPS_PER_CALL = 50;
export const MAX_FLOW_LEVELS = 5;       // depth 0..4; call_flow fails when run.depth + 1 >= MAX_FLOW_LEVELS
export const STEP_LOG_LIMIT = 50;
export const EDITOR_HISTORY_LIMIT = 50;

// ---------- DTOs ----------
export interface GraphProblem { nodeId: string | null; message: string }   // null = whole graph (e.g. no start block)
export interface BotDto {
  id: string; name: string; description: string; status: 'active' | 'paused';
  startChannelIds: string[]; manualStart: boolean; manualTitle: string; manualUnlisted: boolean;
  publishedVersionId: string | null; publishedVersionNumber: number | null; latestVersionNumber: number;
  runCount: number; activeRunCount: number; createdAt: string; updatedAt: string;
}
export interface BotPatch { name?: string; description?: string; startChannelIds?: string[]; manualStart?: boolean; manualTitle?: string; manualUnlisted?: boolean }
export interface BotVersionSummaryDto {
  id: string; botId: string; number: number; valid: boolean; label: string | null;
  createdByName: string | null; createdAt: string; published: boolean;
}
export interface BotVersionDto extends BotVersionSummaryDto { graph: BotGraph; problems: GraphProblem[] } // problems recomputed on read
export interface SaveVersionInput { graph: BotGraph; label?: string; publish: boolean }
export interface BotRunDto {
  id: string; botId: string; botName: string; chatId: string; state: BotRunState; currentNodeId: string;
  depth: number; startedByName: string | null; error: string | null; createdAt: string; updatedAt: string; finishedAt: string | null;
}
export interface ManualBotDto { id: string; title: string }               // title = manualTitle || name
export interface BotExport { name: string; graph: BotGraph }               // export file and import body
export type BotMediaDto = BotAttachment;
export interface OfficeTemplateDestination { sectorId: string; userId?: string | null }
export interface OfficeTemplateInput {
  name?: string;                     // default 'Fluxo do escritório' (made unique)
  companyName: string;               // replaces {{empresa}} in the welcome text at creation
  channelId: string;
  destinations: { atendimento: OfficeTemplateDestination; financeiro: OfficeTemplateDestination; processos: OfficeTemplateDestination };
}
export interface BotEventData { botId: string; botName: string; runId: string; reason?: string; text?: string; by?: string | null;
  fromSectorId?: string; toSectorId?: string; fromOwnerId?: string | null; toOwnerId?: string | null }
export interface BotRunningErrorBody { error: string; code: 'BOT_RUNNING'; runs: Array<{ id: string; botName: string }> }
export interface NotificationDto { id: string; chatId: string; title: string; text: string; botName: string; createdAt: string }
