# Chatbot with Visual Flow Editor (delivery 2a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin build WhatsApp chatbots in a visual block editor, like Umbler's, and run them in conversations with a database-backed engine. The work is done when the "Fluxo do escritório" template runs end to end.

**Architecture:** One shared catalog (`shared/src/bots.ts`) defines the block types, the config shapes and `outputsOf`, so the editor draws exactly the outputs the engine follows. The server stores bots, immutable versions and runs in Postgres. A step engine runs one block at a time and saves the run after every step. Runs resume when the contact replies (from ingest) or when an in-process 5 s scheduler finds a due timer. The bot acts as the system through exported "as bot" variants of the core chat actions. The web adds a list page, a React Flow editor with dagre auto-layout, and composer integration.

**Tech Stack:** Node 24, TypeScript 5.9.3 strict ESM, Fastify 5.12.7, drizzle-orm 0.45.4 / drizzle-kit 0.31.11, Postgres (PGlite 0.5.10 in tests), zod 4.6.7, vitest 5.0.4, React 19.3.1, react-router 8.4.0, @tanstack/react-query 5.104.2, Tailwind 4.3.3, @phosphor-icons/react 2.1.10, **new:** @xyflow/react 12.12.0, @dagrejs/dagre 3.1.1.

**Spec:** `docs/superpowers/specs/2026-10-15-chatbot-fluxos-2a-design.md` (read it with `docs/superpowers/plans/2026-10-15-chatbot-fluxos-2a-codebase-map.md`, which lists the exact current interfaces).

## Global Constraints

- New web dependencies, pinned exactly: `npm install -w web --save-exact @xyflow/react@12.12.0 @dagrejs/dagre@3.1.1`. Commit `web/package.json` and the root `package-lock.json`. Never use `13.0.0-next.*`.
- No new server dependency. Use the stdlib (`Intl.DateTimeFormat` for time zones, `crypto.randomUUID`, `RegExp`) and what is already installed.
- All other pins stay as in `docs/superpowers/plans/2026-10-14-nucleo-atendimento.md`, always installed with `--save-exact`.
- Reuse the existing patterns in the codebase map:
  - `registerXRoutes(app, ctx)` with zod `.parse`, and `IdParams = z.object({ id: z.uuid() })`.
  - The `HttpError` helpers.
  - The schema helpers `id()` / `createdAt()`, `text().$type<>()` enums, and `jsonb().$type<>()`.
  - Migrations with `npm run db:generate -w server -- --name chatbot_fluxos`.
  - The web pieces: `useSend`, `send`, `btn`, `btnPrimary`, `field`, `Section`, the `Modal` dialog and the `qk` keys.
- ESM, `strict: true`, `.js` import extensions in server code. IDs come from `crypto.randomUUID()`. Timestamps are `timestamptz` in UTC.
- UI copy is Brazilian Portuguese. Code identifiers are English.
- Never log message bodies, contact answers (CPF and the like), rendered bot texts or notification texts. `console.error` gets names, ids and error codes only. Never commit `.env`, `screenshots/` or `data/`.
- Every read or write **by a user** of a chat, message, media, run or contact history goes through `canSee` or `visibleChatsWhere`, and no access means 404. The bot acts as the system (`author_id = null`, `bot_run_id` set).
- Every mutating `/api/*` request needs `Origin === config.appOrigin`. This is already enforced globally by `authPlugin`. Every new mutation route is a non-GET route under `/api/`, and its tests send `loginAs(...).headers`.
- No WhatsApp send inside a DB transaction. Publish to the hub after commit, never inside a tx. Inside `ctx.db.transaction(tx => …)` use only `tx`, because PGlite deadlocks otherwise.
- Every module gets its dependencies through `AppCtx`. There are no module-level mutable singletons; the chat lock map lives in `ctx.botRuntime`.
- Tests run on PGlite (`makeTestCtx` / `makeTestApp`) with the fake gateway (`createFakeGateway`) and the fake clock (`createFakeClock`, injected as `ctx.botRuntime`). They never touch the real network and never use real timers: the scheduler is driven by `tick(now)`.
- Commit after every task with a Conventional Commit message that ends with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Block count:** Início 2 + Condição 17 + Ação 12 + Finalização 1 + Utilitário 1 = **33** (the spec tally was corrected from 34 to 33). This plan implements exactly the 33 enumerated types in `BLOCK_TYPES` and adds none. Tests assert `BLOCK_TYPES.length === 33`. Wherever the brief or spec says "34 types", read "every type in `BLOCK_TYPES`".

## Review Focus

These are inputs and conditions the spec implies but never tests, most likely first. The owning task adds the named test.

1. **A burst of messages when a chat opens.** The contact sends "Bom dia" and then "preciso de ajuda". The second message arrives while the bot is still sending the menu, so it must **not** count as the answer to the menu (no "opção inválida"). A reply counts only if its `messages.created_at` is at or after `bot_runs.waiting_since`. This is also how the spec's "duas respostas simultâneas" case resolves: the second reply predates the next question, so the new state ignores it. **Owner: Task 5**, test `ignores a reply that was stored before the wait began`.
2. **A timer, timeout or reply for a run whose chat was closed or whose contact was blocked some other way**, for example from the contacts page or by another bot. The engine checks `chat.state === 'open'` and `!contact.blocked` before every step. If the check fails, the run becomes `stopped` with reason `chat_closed` or `contact_blocked`, and nothing is sent. **Owner: Task 5**, test `stops instead of sending when the chat was closed while waiting`.
3. **The server dies mid-step**, leaving a run in `running` forever. That run blocks the one-run-per-(chat, bot) index, keeps the composer asking `BOT_RUNNING`, and blocks bot deletion. On boot, every `running` run becomes `failed` with error `'Interrompido por reinício do servidor'` and a `bot_failed` event. **Owner: Task 9**, test `failInterruptedRuns fails runs left running and frees the chat`.
4. **A non-text reply (audio, sticker, image, `body = null`)** to `ask_choice` or `ask_input`. `ask_choice` counts it as an invalid attempt. `ask_input` with `any` accepts it (`raw = ''`, `value = mediaName ?? kind`). `ask_input` with `media` checks the type. Nothing crashes or throws on `null`. **Owner: Task 7**, test `treats a sticker reply to ask_choice as invalid and an audio reply to ask_input(any) as valid`.
5. **Outbound messages never trigger the bot.** This covers a phone echo, a message the agent sends from the office phone, and the webhook echo of the bot's own send. None of them starts a channel bot, resumes a waiting run, or counts as an agent message for `bot_running_behavior`. **Owner: Task 10**, test `outbound and echo messages neither start nor resume bots`.

---

## File Structure

Each line gives the path, the task that creates or first modifies it, and its responsibility.

**Shared**
- `shared/src/bots.ts` (T1, create): block types, config interfaces, `BLOCK_CATALOG`, `outputsOf`, `defaultConfig`, `nodeNameFor`, DTOs, constants.
- `shared/src/index.ts` (T1): re-exports `bots.ts`, adds the `MessageDto` bot fields, `ChatEventDto` bot kinds, `NotificationDto` and WsEvent `notification`. (T10) adds `SettingsDto.botRunningBehavior`.

**Server**
- `server/src/db/schema.ts` (T1): `chatEvents.kind` bot kinds. (T2) adds `bots`, `botVersions`, `botRuns` and `messages.botRunId`.
- `server/drizzle/0002_chatbot_fluxos.sql`, `server/drizzle/meta/0002_snapshot.json`, `server/drizzle/meta/_journal.json` (T2): generated migration.
- `server/src/inbox/events.ts` (T1): `ChatEventKind` bot kinds.
- `server/src/bots/repo.ts` (T2, create): row types, DTO mappers, version insert, bot create, unique names, channel bot lookup.
- `server/src/messages/dto.ts` (T2): `botRunId` / `botName` on `toMessageDto`.
- `server/src/bots/graph.ts` (T3, create): `GraphCatalog`, `loadGraphCatalog`, `validateGraph` (structure and per-type config).
- `server/src/bots/validators.ts` (T3, create): CPF, CNPJ, e-mail, BR phone, regex, media type, `validateAnswer`.
- `server/src/messages/quick-answers.ts` (T4): `buildChatVars`, and the `contexto` group in `renderQuickAnswer`.
- `server/src/catalog/quick-answers.ts` (T4): the render route uses `buildChatVars`.
- `server/src/bots/variables.ts` (T4, create): `contextoVars`, `loadBotTextVars`, `renderBotText`.
- `server/src/bots/runtime.ts` (T5, create): `BotRuntime`, `createBotRuntime`, `createFakeClock`.
- `server/src/ctx.ts` (T5): `AppCtx.botRuntime`.
- `server/src/index.ts` (T5): builds `botRuntime`. (T9) wires the scheduler and `failInterruptedRuns`.
- `server/test/helpers.ts` (T5): `makeTestCtx` gets `botRuntime` and `clock`.
- `server/src/bots/registry.ts` (T5, create): `BlockDefinition`, `BlockResult`, `ResumeEvent`, `BotCtx`, `BlockError` (defined in `server/src/bots/block-error.ts` and re-exported; block files and `inbox/chats.ts` import it from `block-error.js` and import only types from `registry.js`, to avoid a TDZ error in the registry ⇄ blocks import cycle), `InboundReply`, `registry`.
- `server/src/bots/engine.ts` (T5, create): `startRun`, `resumeOnReply`, `resumeOnTimer`, `stopRun`, `stopRunsForChat`, `runningRunsForChat`, `step`, `failInterruptedRuns`.
- `server/src/bots/blocks/conditions.ts` (T6, create): the 17 condition blocks.
- `server/src/messages/send.ts` (T7): exported `sendSystemMessage` (text and attachment, `botRunId`). (T10) adds the `botAction` guard in `sendAgentMessage`.
- `server/src/triage/triage.ts` (T6): exports `normalize`. (T7) uses `sendSystemMessage`.
- `server/src/bots/blocks/actions.ts` (T7, create): the Action I blocks.
- `server/src/bots/blocks/actions-2.ts` (T8, create): the Action II blocks, exported as `actionBlocks2`.
- `server/src/bots/blocks/start.ts` (T8, create): `start_channel`, `start_manual`, `sticky_note`.
- `server/src/bots/blocks/finish.ts` (T8, create): `close_chat`.
- `server/src/inbox/chats.ts` (T8): `transferChatAsBot`, `setChatPrivacyAsBot`, `closeChatAsBot`.
- `server/src/realtime/hub.ts` (T8): `publishNotification` in `createHub` and `createRecordingHub`.
- `server/src/bots/scheduler.ts` (T9, create): `createScheduler`.
- `server/src/bots/hooks.ts` (T10, create): `startChannelBot`, `resumeBotsOnReply`, `applyBotRunningBehavior`.
- `server/src/messages/ingest.ts` (T10): optional bot hooks, start by channel before triage, resume on reply.
- `server/src/chats/routes.ts` (T10): `botAction` on messages (JSON and multipart) and on transfer; the close route stops runs.
- `server/src/catalog/settings.ts` (T10): `bot_running_behavior` key and `getBotRunningBehavior`.
- `server/src/lib/http-error.ts` and `server/src/app.ts` (T10): `HttpError.body`, which the handler spreads. (T11) registers the bot routes.
- `server/src/messages/media.ts` (T11): optional `subdir` on `saveMedia`.
- `server/src/bots/routes.ts` (T11, create): `registerBotRoutes`, all routes in §3.10. (T12) adds `from-template`.
- `server/src/bots/templates.ts` (T12, create): `buildOfficeGraph`, `createOfficeTemplate`.
- Tests (each task owns its own file):
  - `server/test/bots/catalog.test.ts` (T1)
  - `repo.test.ts` (T2)
  - `graph.test.ts`, `validators.test.ts` (T3)
  - `variables.test.ts` (T4)
  - `engine.test.ts` (T5)
  - `conditions.test.ts` (T6)
  - `actions-1.test.ts` (T7)
  - `actions-2.test.ts` (T8)
  - `scheduler.test.ts` (T9)
  - `integration.test.ts` (T10)
  - `routes.test.ts` (T11)
  - `template.test.ts` (T12)
  - Existing tests that change: `server/test/db/schema.test.ts` (T2: 17 → 20), `server/test/catalog/settings.test.ts` (T10), `server/test/messages/quick-answers.test.ts` (T4).

**Web**
- `web/package.json`, `package-lock.json` (T1): the two pins.
- `web/src/components/conversation/model.ts` (T1): `eventText` bot cases.
- `web/src/lib/ws.ts` (T1): no-op `notification` case.
- `web/src/lib/api.ts` (T13): `ApiError.data`, `botRunningRuns`, `api.bots`, `api.botRuns`, `qk` bot keys, `botAction` on the send and transfer inputs.
- `web/src/pages/settings/SettingsPage.tsx` (T13): `chatbots` section.
- `web/src/pages/settings/bots/BotsSettings.tsx` (T13, create): list, actions, import, new.
- `web/src/pages/settings/bots/OfficeTemplateDialog.tsx` (T13, create): the "Criar a partir do modelo" form.
- `web/src/pages/settings/ChatSettings.tsx` (T13): `botRunningBehavior` select.
- `web/src/App.tsx` (T14): `/configuracoes/chatbots/:id` route.
- `web/src/pages/settings/bots/BotEditorPage.tsx` (T14, create): loads the bot and latest version, guards admin, warns on leave.
- `web/src/components/bot-editor/editor-state.ts` (T14, create): pure graph operations and history.
- `web/src/components/bot-editor/layout.ts` (T14, create): `autoLayout` with dagre.
- `web/src/components/bot-editor/BotEditor.tsx` (T14, create): React Flow canvas, toolbar wiring, save and publish.
- `web/src/components/bot-editor/BlockNode.tsx` (T14, create): custom node with header, card and handles from `outputsOf`.
- `web/src/components/bot-editor/Palette.tsx` (T14, create): categories, search, Tab toggle, drag or click insert.
- `web/src/components/bot-editor/Toolbar.tsx` (T14, create): undo/redo, layout, save, publish, status, versions, name, export.
- `web/src/components/bot-editor/VersionsPanel.tsx` (T14, create): list, view, restore as draft.
- `web/src/components/bot-editor/ProblemsList.tsx` (T14, create).
- `web/src/components/bot-editor/icons.ts` (T14, create): Phosphor name → component map.
- `web/src/components/bot-editor/useEditorCatalog.ts` (T14, create).
- `web/src/components/bot-editor/flow.css` (T14, create): dark overrides.
- `web/src/components/bot-editor/cards/index.tsx` (T14, create with a fallback; T15 fills it in): `BlockConfigCard`.
- `web/src/components/bot-editor/cards/fields.tsx`, `cards/conditions.tsx`, `cards/actions.tsx`, `cards/start.tsx` (T15, create).
- `web/src/components/conversation/MessageBubble.tsx` (T16): robot icon and `Chatbot <nome>`.
- `web/src/components/conversation/Composer.tsx` (T16): robot `ToolButton`, `BOT_RUNNING` retry.
- `web/src/components/conversation/BotPanel.tsx` (T16, create): "Executar chatbot" and "Parar chatbot".
- `web/src/components/conversation/ChatDialogs.tsx` (T13): export `Modal` and `Actions`. (T16): add `BotRunningDialog`; the transfer retry on `BOT_RUNNING` lives in `ConversationHeader`.
- `web/src/components/layout/NotificationToasts.tsx` (T16, create) and `AppLayout.tsx` (T16): bot notifications.
- Web tests:
  - `bot-editor/editor-state.test.ts`, `bot-editor/BotEditor.test.tsx`, `bot-editor/Palette.test.tsx` (T14)
  - `bot-editor/cards/cards.test.tsx` (T15)
  - `pages/settings/bots/BotsSettings.test.tsx` (T13)
  - `conversation/BotPanel.test.tsx`, plus additions to `Composer.test.tsx` and `MessageBubble.test.tsx` (T16)

**Docs**
- `README.md`, `docs/IMPLANTACAO.md` (T17): chatbot section and the manual acceptance checklist.

---

## SHARED CONTRACT

Later tasks rely on these names and types exactly. A task that needs something not listed here adds it **inside its own files** and does not rename anything below.

### 3.1 `shared/src/bots.ts` (Task 1, runtime and types; no imports except `import type` from `./index.js` if needed)

```ts
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
] as const;                                  // 33 entries, see the Global Constraints note
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
export function configOf<T extends BlockType>(node: BotNode & { type: T }): BlockConfigMap[T]; // = node.config as unknown as BlockConfigMap[T]
export function defaultConfig<T extends BlockType>(type: T): BlockConfigMap[T];
// defaults: timezone DEFAULT_TIMEZONE; hours intervals [{from:'08:00',to:'18:00',days:['mon','tue','wed','thu','fri']}];
// wait_interval {mode:'fixed',amount:5,unit:'minutes',resumeOnReply:false}; condition {logic:'and',rules:[{left:{kind:'var',value:''},operator:'eq',right:{kind:'literal',value:''}}]};
// multi_condition {cases:[{label:'Caso 1',logic:'and',rules:[<same rule>]}]}; value = <same rule>; distribute {branches:[{label:'A',weight:1},{label:'B',weight:1}]};
// tags {mode:'any',tagIds:[]}; chat_agent {mode:'any',userIds:[]}; message_contains {keywords:[],match:'any'};
// send_message {text:'',attachment:null,signature:false}; ask_choice {text:'',options:[{key:'1',label:''}],invalidRetries:1,timeoutHours:null};
// ask_input {text:'',validator:'any',useLastMessage:false,invalidRetries:1,timeoutHours:null,saveToField:null};
// edit_tags {add:[],remove:[]}; transfer_sector {sectorId:'',onlyIfAgentAllowed:false}; transfer_agent {rule:'specific',userIds:[],sectorIds:[]};
// privacy {mode:'private'}; notify_agent {title:'',text:'',target:'owner',userIds:[]}; call_flow {botId:'',continueAfter:false};
// close_chat {sendClosingMessage:true}; sticky_note {text:'',color:'yellow'}; set_contact_field {fieldId:'',value:''}; note {text:''};
// contact_field {fieldId:'',operator:'eq',value:''}; chat_sector {sectorIds:[]}; chat_channel {channelIds:[]}; Empty → {}.

/** `type` if free, else `${type}_2`, `${type}_3`… (compared case-insensitively against `taken`). */
export function nodeNameFor(type: BlockType, taken: Iterable<string>): string;

// ---------- catalog ----------
export interface BlockCatalogEntry { type: BlockType; category: BlockCategory; label: string; description: string; icon: string } // icon = Phosphor component name
export const BLOCK_CATALOG: readonly BlockCatalogEntry[]; // one entry per BLOCK_TYPES item, same order
export const BLOCK_CATEGORY_LABELS: Record<BlockCategory, string> = {
  start: 'Início', condition: 'Condições', action: 'Ações', finish: 'Finalização', utility: 'Utilitários',
};
export function catalogEntry(type: BlockType): BlockCatalogEntry;
```

`BLOCK_CATALOG` contents. The icon names were checked against `node_modules/@phosphor-icons/react/dist/csr/*.d.ts`.

| type | category | label | description | icon |
|---|---|---|---|---|
| start_channel | start | Iniciar por um canal | Inicia quando um contato abre uma conversa nos canais escolhidos | WhatsappLogo |
| start_manual | start | Iniciar manualmente | Um atendente inicia este fluxo pela conversa | HandTap |
| weekdays | condition | Dia da semana | Segue um caminho para cada dia da semana | CalendarBlank |
| hours | condition | Horário | Separa dentro e fora do horário de atendimento | Clock |
| wait_interval | condition | Aguardar intervalo | Espera um tempo antes de continuar | Hourglass |
| condition | condition | Condição | Verifica regras e segue por Sim ou Não | GitBranch |
| multi_condition | condition | Várias condições | Segue o primeiro caso cujas regras forem verdadeiras | TreeStructure |
| value | condition | Comparar valor | Compara uma variável ou campo com um valor | Equals |
| distribute | condition | Distribuir | Divide os contatos entre caminhos por peso | Shuffle |
| contact_active | condition | Contato ativo | O contato enviou mensagem nas últimas 24 horas? | Pulse |
| first_chat | condition | Primeira conversa | É a primeira conversa do contato neste canal? | Sparkle |
| contact_field | condition | Campo do contato | Verifica o valor de um campo do contato | IdentificationCard |
| tags | condition | Etiquetas do contato | Verifica as etiquetas do contato | Tag |
| chat_sector | condition | Setor da conversa | A conversa está em um destes setores? | UsersThree |
| chat_channel | condition | Canal da conversa | A conversa é de um destes canais? | Broadcast |
| chat_agent | condition | Atendente da conversa | Verifica quem é o atendente da conversa | UserCircle |
| chat_status | condition | Conversa esperando | A conversa está em "Esperando"? | HourglassMedium |
| message_contains | condition | Mensagem contém | A última mensagem do contato contém estas palavras? | MagnifyingGlass |
| parallel_bot | condition | Outro chatbot rodando | Existe outro chatbot em execução nesta conversa? | Robot |
| send_message | action | Enviar mensagem | Envia um texto e, se quiser, um arquivo | ChatText |
| note | action | Nota interna | Registra uma nota visível só para a equipe | NotePencil |
| ask_choice | action | Pedir para escolher | Envia opções numeradas e segue pela escolhida | ListNumbers |
| ask_input | action | Pedir informação | Pede um dado e valida a resposta | Textbox |
| set_contact_field | action | Preencher campo | Grava um valor em um campo do contato | PencilSimple |
| edit_tags | action | Editar etiquetas | Adiciona ou remove etiquetas do contato | TagSimple |
| transfer_sector | action | Transferir para setor | Move a conversa para outro setor | ArrowsLeftRight |
| transfer_agent | action | Transferir para atendente | Define o atendente da conversa | UserSwitch |
| privacy | action | Privacidade | Torna a conversa privada ou pública | LockSimple |
| notify_agent | action | Notificar atendente | Envia uma notificação para a equipe | BellRinging |
| call_flow | action | Acionar outro fluxo | Inicia outro chatbot nesta conversa | FlowArrow |
| block_contact | action | Bloquear contato | Bloqueia o contato e finaliza as conversas dele | Prohibit |
| close_chat | finish | Finalizar conversa | Finaliza a conversa e encerra o chatbot | CheckCircle |
| sticky_note | utility | Anotação | Um lembrete no editor; não executa | Note |

```ts
// ---------- outputs (single source for editor handles and engine edges) ----------
export function outputsOf(type: BlockType, config: Record<string, unknown>): BlockOutput[];
```

`outputsOf` returns the outputs in this order, with these exact ids and labels:

| type | outputs `id: label` |
|---|---|
| start_channel, start_manual | `next: Próximo` |
| weekdays | `day:mon: Segunda` … `day:sun: Domingo`, in `WEEKDAYS` order |
| hours | `in: Dentro do horário`, `out: Fora do horário` |
| wait_interval | `next: Depois do tempo`, plus `replied: Se responder antes` when `resumeOnReply` |
| condition, value, contact_active, first_chat, contact_field, tags, chat_sector, chat_channel, chat_agent, chat_status, message_contains, parallel_bot | `yes: Sim`, `no: Não` |
| multi_condition | `case:<i>: <label \|\| 'Caso '+(i+1)>` for each case, then `else: Senão` |
| distribute | `branch:<i>: <label \|\| 'Caminho '+(i+1)> (<round(weight/total*100)>%)` |
| send_message, set_contact_field, edit_tags, transfer_sector, transfer_agent, privacy, notify_agent, call_flow | `next: Próximo`, `error: Se não for possível` |
| note | `next: Próximo` |
| ask_choice | `opt:<key>: <key> · <label>` for each option, `invalid: Resposta inválida`, then `timeout: Sem resposta` when `timeoutHours > 0`, then `error: Se não for possível` |
| ask_input | `next: Resposta válida`, `invalid: Resposta inválida`, then `timeout: Sem resposta` when `timeoutHours > 0`, then `error: Se não for possível` |
| block_contact | `error: Se não for possível` |
| close_chat, sticky_note | (none) |

`outputsOf` must never throw on a malformed config: a missing array counts as `[]`. Keys and ids are taken as given (`opt:1`).

```ts
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
```

**`shared/src/index.ts` changes (Task 1):**
```ts
export { BLOCK_TYPES, WEEKDAYS, WEEKDAY_LABELS, DEFAULT_TIMEZONE, RULE_OPERATOR_LABELS, NATIVE_CONTACT_FIELDS, BLOCK_CATALOG,
  BLOCK_CATEGORY_LABELS, NON_TERMINAL_RUN_STATES, MAX_STEPS_PER_CALL, MAX_FLOW_LEVELS, STEP_LOG_LIMIT, EDITOR_HISTORY_LIMIT,
  configOf, defaultConfig, nodeNameFor, catalogEntry, outputsOf } from './bots.js';
export type * from './bots.js';
// MessageDto gains (optional so existing literals compile; toMessageDto always fills them from Task 2 on):
//   botRunId?: string | null; botName?: string | null;
// ChatEventDto.kind gains: 'bot_started' | 'bot_finished' | 'bot_stopped' | 'bot_failed' | 'bot_transferred' | 'bot_note'
// WsEvent gains: | { type: 'notification'; notification: NotificationDto }
```
Task 10 adds `SettingsDto.botRunningBehavior: BotRunningBehavior`. Task 1 must not add it.

### 3.2 Chat event kinds (Task 1 changes all four places in one commit)

`ChatEventKind` gains `'bot_started' | 'bot_finished' | 'bot_stopped' | 'bot_failed' | 'bot_transferred' | 'bot_note'` in four places:
- `schema.ts` (`chatEvents.kind` `$type`)
- `inbox/events.ts`
- `shared/src/index.ts`
- the `eventText` switch in `web/src/components/conversation/model.ts`

The column is `text`, so no SQL is needed. Every bot event has `authorId = null`, except `bot_stopped` by a user, where `authorId = by`. `data` is a `BotEventData`.

`eventText` strings (`n` = `String(e.data.botName ?? 'Chatbot')`):

| kind | text |
|---|---|
| bot_started | `Chatbot ${n} iniciado` |
| bot_finished | `Chatbot ${n} finalizado` |
| bot_stopped | `Chatbot ${n} parado` + (authorName ? ` por ${authorName}` : '') |
| bot_failed | `Chatbot ${n} falhou` + (reason ? `: ${reason}` : '') |
| bot_transferred | `Chatbot ${n} transferiu para ${names.get(toSectorId) ?? 'outro setor'}` + (toOwnerId ? ` · ${names.get(toOwnerId) ?? ''}` : '') |
| bot_note | `Nota do chatbot ${n}: ${String(e.data.text ?? '')}` |

The existing `privacy_changed` and `closed` texts append ` · Chatbot ${botName}` when `typeof e.data.botName === 'string'`.

`web/src/lib/ws.ts` `applyWsEvent` gains `case 'notification': return;`. It is a cache no-op; Task 16's toasts subscribe via `useWsEvent`.

### 3.3 DB schema additions (Task 2, `server/src/db/schema.ts`)

```ts
export const bots = pgTable('bots', {
  id: id(),
  name: text('name').notNull().unique(),
  description: text('description').notNull().default(''),
  status: text('status').$type<'active' | 'paused'>().notNull().default('paused'),
  startChannelIds: uuid('start_channel_ids').array().notNull().default(sql`'{}'::uuid[]`),
  manualStart: boolean('manual_start').notNull().default(false),
  manualTitle: text('manual_title').notNull().default(''),
  manualUnlisted: boolean('manual_unlisted').notNull().default(false),
  publishedVersionId: uuid('published_version_id').references((): AnyPgColumn => botVersions.id, { onDelete: 'set null' }),
  runCount: integer('run_count').notNull().default(0),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const botVersions = pgTable(
  'bot_versions',
  {
    id: id(),
    botId: uuid('bot_id').notNull().references(() => bots.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    graph: jsonb('graph').$type<BotGraph>().notNull(),
    valid: boolean('valid').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    label: text('label'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('bot_versions_bot_number_unique').on(t.botId, t.number)],
); // immutable: no code path UPDATEs a bot_versions row

export const botRuns = pgTable(
  'bot_runs',
  {
    id: id(),
    botId: uuid('bot_id').notNull().references(() => bots.id, { onDelete: 'cascade' }),
    versionId: uuid('version_id').notNull().references(() => botVersions.id, { onDelete: 'cascade' }),
    chatId: uuid('chat_id').notNull().references(() => chats.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
    state: text('state').$type<BotRunState>().notNull().default('running'),
    currentNodeId: text('current_node_id').notNull(),
    waitNodeId: text('wait_node_id'),
    wakeAt: timestamp('wake_at', { withTimezone: true }),
    timeoutAt: timestamp('timeout_at', { withTimezone: true }),
    waitingSince: timestamp('waiting_since', { withTimezone: true }), // set to clock_timestamp() when entering waiting_reply (Review Focus 1)
    retries: integer('retries').notNull().default(0),                // invalid attempts on the current ask node; reset on every node change
    vars: jsonb('vars').$type<BotRunVars>().notNull().default({}),
    steps: jsonb('steps').$type<BotRunStep[]>().notNull().default([]),
    depth: integer('depth').notNull().default(0),
    parentRunId: uuid('parent_run_id').references((): AnyPgColumn => botRuns.id, { onDelete: 'set null' }),
    startedBy: uuid('started_by').references(() => users.id, { onDelete: 'set null' }),
    error: text('error'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('bot_runs_state_wake_idx').on(t.state, t.wakeAt),
    index('bot_runs_state_timeout_idx').on(t.state, t.timeoutAt),
    index('bot_runs_chat_idx').on(t.chatId),
    // spec §3 "max 1 non-terminal run per (chat, bot)" — root runs only, so call_flow may re-enter the same bot (depth limit applies)
    uniqueIndex('bot_runs_one_active_per_chat_bot')
      .on(t.chatId, t.botId)
      .where(sql`${t.state} in ('running','waiting_reply','waiting_timer','waiting_flow') and ${t.depth} = 0`),
  ],
);

// messages gains (column added inside the existing messages table definition):
botRunId: uuid('bot_run_id').references((): AnyPgColumn => botRuns.id, { onDelete: 'set null' }),
```
- Import the types `BotGraph`, `BotRunState`, `BotRunVars`, `BotRunStep` with `import type … from '@talk/shared'`. `retries` and `waitingSince` are additions to spec §3 for retries and Review Focus 1.
- The settings key `bot_running_behavior` holds a jsonb string, `'ask' | 'stop' | 'keep'` (default `'ask'` when the key is missing or the value is invalid).
- Migration `0002_chatbot_fluxos`. `server/test/db/schema.test.ts` expects 20 tables.

### 3.4 `server/src/bots/repo.ts` (Task 2)

```ts
export type BotRow = typeof bots.$inferSelect;
export type BotVersionRow = typeof botVersions.$inferSelect;
export type BotRunRow = typeof botRuns.$inferSelect;
export async function toBotDto(db: Db | Tx, row: BotRow): Promise<BotDto>;
export async function toBotDtos(db: Db | Tx, rows: BotRow[]): Promise<BotDto[]>;          // one query per aggregate, not per row
export async function toBotVersionSummaries(db: Db | Tx, bot: BotRow): Promise<BotVersionSummaryDto[]>; // number desc
export async function toBotRunDto(db: Db | Tx, row: BotRunRow): Promise<BotRunDto>;
export async function getBot(db: Db | Tx, id: string): Promise<BotRow>;                     // notFound('Chatbot não encontrado')
export async function getVersionRow(db: Db | Tx, versionId: string): Promise<BotVersionRow | null>;
export async function getVersionByNumber(db: Db | Tx, botId: string, n: number): Promise<BotVersionRow>; // notFound
export async function latestVersion(db: Db | Tx, botId: string): Promise<BotVersionRow>;
/** number = coalesce(max(number),0)+1 for the bot; one retry on unique violation 23505. */
export async function insertBotVersion(db: Db | Tx, input: { botId: string; graph: BotGraph; valid: boolean; createdBy: string | null; label?: string | null }): Promise<BotVersionRow>;
/** One tx: insert bot (name must already be unique) + version 1; publish=true also sets publishedVersionId (requires valid). */
export async function createBot(db: Db, input: { name: string; description?: string; graph: BotGraph; valid: boolean; publish: boolean;
  createdBy: string | null; startChannelIds?: string[]; manualStart?: boolean; manualTitle?: string }): Promise<BotRow>;
/** base if free, else `${base} (2)`, `${base} (3)`… */
export async function uniqueBotName(db: Db | Tx, base: string): Promise<string>;
/** Oldest (created_at) active bot with a published version whose start_channel_ids contains channelId and whose published graph has a start_channel node. */
export async function findChannelBot(db: Db | Tx, channelId: string): Promise<BotRow | null>;
export type NewBotRun = typeof botRuns.$inferInsert;
export async function getPublishedVersion(db: Db | Tx, bot: BotRow): Promise<BotVersionRow | null>;
export async function insertRun(db: Db | Tx, values: NewBotRun): Promise<BotRunRow>; // 23505 → conflict('Este chatbot já está em execução nesta conversa')
export async function getRun(db: Db | Tx, id: string): Promise<BotRunRow | null>;
export async function lockRun(tx: Tx, id: string): Promise<BotRunRow | null>;       // SELECT … FOR UPDATE
export const STARTER_GRAPH: () => BotGraph; // start_channel 'inicio' → send_message 'mensagem' {text:'Olá!'} (used by POST /api/bots)
```
`toMessageDto` (in `messages/dto.ts`) fills `botRunId: row.botRunId ?? null` and `botName`, joining `bot_runs` to `bots` when `botRunId` is set and returning `null` otherwise.

### 3.5 `server/src/bots/graph.ts` and `validators.ts` (Task 3)

```ts
// graph.ts
export interface GraphCatalog {
  selfBotId: string | null;
  sectorIds: Set<string>; activeUserIds: Set<string>; tagIds: Set<string>; customFieldIds: Set<string>;
  channelIds: Set<string>; botIds: Set<string>;   // all bots, self included (self-call is reported separately)
}
export async function loadGraphCatalog(db: Db | Tx, selfBotId: string | null): Promise<GraphCatalog>;
export function validateGraph(graph: BotGraph, catalog: GraphCatalog): GraphProblem[]; // [] = valid; pt-BR messages; never throws
export function isFieldRef(id: string, catalog: GraphCatalog): boolean;              // custom field id or a NativeFieldId
export function startNodeOf(graph: BotGraph, entry: 'channel' | 'manual' | 'call'): BotNode | null; // call → start_manual ?? start_channel
```

**Structural rules.** Each rule below produces one problem.
- The graph needs at least one start node (`nodeId: null`, 'O fluxo precisa de um bloco de início'), and has at most one node of each start type.
- Every non-sticky node needs a `name` matching `/^[A-Za-z0-9_]{1,40}$/`. Names are unique case-insensitively.
- An edge whose source or target does not exist is a problem. So is an edge whose `sourceHandle` is not in `outputsOf(source)`.
- Each `(source, sourceHandle)` pair has at most one edge.
- An edge cannot target a start or `sticky_note` node, and a `sticky_note` node has no edges at all.
- Every non-start, non-sticky node needs at least one incoming edge ('Bloco sem entrada').
- A start node's `next` output must be connected.
- Other unconnected outputs are allowed. At runtime they mean "finish".

**Per-type config rules.** These live in `validateNodeConfig(node, catalog): string[]`, which is exported for tests.
- The type and range constraints in §3.1 comments.
- Every id reference must exist in the catalog: sectors, active users, tags, fields, channels, bots.
- `call_flow.botId !== selfBotId`.
- The `timezone` must be accepted by `new Intl.DateTimeFormat('pt-BR', { timeZone })`.
- `HH:MM` times must be valid, with `from < to`.
- Regexes must compile with `'u'`.
- `send_message` needs text or an attachment.
- `ask_*` text must be non-empty.
- `transfer_agent`: `specific` needs at least 1 user, and `least_busy` needs at least 1 sector.
- `notify_agent`: `users` needs at least 1 user.

```ts
// validators.ts
export interface AnswerInput { body: string | null; kind: MessageKind; mediaMime: string | null; mediaName: string | null }
export type AnswerResult = { ok: true; raw: string; value: string } | { ok: false };
export function validateAnswer(cfg: Pick<AskInputConfig, 'validator' | 'mediaTypes' | 'regex'>, input: AnswerInput): AnswerResult;
export function isValidCpf(s: string): boolean;   export function formatCpf(s: string): string;   // '000.000.000-00'
export function isValidCnpj(s: string): boolean;  export function formatCnpj(s: string): string;  // '00.000.000/0000-00'
export function isValidEmail(s: string): boolean;                                                 // value = trimmed lowercase
export function parsePhoneBR(s: string): string | null;    // normalizePhoneBR → 12–13 digits starting with 55, else null
export function compileUserRegex(pattern: string): RegExp | null; // null if invalid or > 200 chars; flags 'u'
export function mediaTypeOf(mime: string | null): MediaType | null; // application/pdf→pdf, audio/*, image/*, video/*
```
- `validateAnswer` normalizes the value per validator: `cpf` and `cnpj` are formatted, `phone` is canonical, `email` is lowercased.
- `any` accepts every message. For text, `value = raw = body.trim()`. For media, `raw = ''` and `value = mediaName ?? kind`.
- `media` requires `kind` not to be `text`, and the type to be in `mediaTypes` when that list is non-empty.
- The text validators reject `body === null`.
- `regex` tests at most the first 1000 chars. `// ponytail: no ReDoS guard beyond pattern ≤200 and input ≤1000 chars; move to a worker with timeout if patterns get hostile.`

### 3.6 Variables (Task 4)

```ts
// messages/quick-answers.ts
export interface QuickAnswerVars { /* unchanged */ atendente: {...}; contato: {...}; campo: Record<string, string> }
export function renderQuickAnswer(body: string, vars: QuickAnswerVars & { contexto?: Record<string, string> }): string; // contexto group added (keys slugged)
export function firstName(s: string): string;   // moved here from catalog/quick-answers.ts and exported
export async function buildChatVars(db: Db | Tx, chat: Pick<ChatRow, 'contactId'>, atendente: Pick<AuthUser, 'name' | 'email'> | null): Promise<QuickAnswerVars>;
// atendente null → { nome:'', primeiro_nome:'', email:'' }. The quick-answer render route calls buildChatVars(ctx.db, chat, req.user).

// bots/variables.ts
export interface BotTextVars extends QuickAnswerVars { contexto: Record<string, string> }
/** For each var: name → value, `${name}:raw` → raw, `${name}:label` → label ?? '' (renderQuickAnswer slugs `cpf:raw` → `cpf_raw`). */
export function contextoVars(vars: BotRunVars): Record<string, string>;
/** atendente = loadAuthUser(db, chat.ownerId) or null. */
export async function loadBotTextVars(db: Db | Tx, chat: ChatRow, runVars: BotRunVars): Promise<BotTextVars>;
export function renderBotText(text: string, vars: BotTextVars): string;  // = renderQuickAnswer(text, vars)
```
`{{empresa}}` has no dot, so it is literal for the renderer. Only the template replaces it, at creation time.

### 3.7 Runtime, registry and engine (Task 5)

```ts
// bots/runtime.ts
export interface BotRuntime {
  now(): Date;
  random(): number;                                               // [0,1); distribute
  withChatLock<T>(chatId: string, fn: () => Promise<T>): Promise<T>; // in-process FIFO mutex per chat; NOT re-entrant
  registry: BlockRegistry;
}
export function createBotRuntime(opts?: { now?: () => Date; random?: () => number; registry?: BlockRegistry }): BotRuntime;
// registry = { ...defaultRegistry, ...opts.registry }  (tests inject fake blocks)
// ponytail: in-process lock — single server process; use pg_advisory_xact_lock if the app ever runs >1 instance.
export interface FakeClock { now(): Date; set(d: Date): void; advance(ms: number): void }
export function createFakeClock(start?: Date): FakeClock; // default 2026-10-14T13:00:00Z = Wednesday 09:00 America/Cuiaba

// ctx.ts
export interface AppCtx { db: Db; config: Config; wa: WhatsAppGateway; hub: Hub; botRuntime: BotRuntime }
// index.ts: botRuntime: createBotRuntime()
// test/helpers.ts makeTestCtx(): also returns `clock: FakeClock`, with botRuntime = createBotRuntime({ now: clock.now })

// bots/registry.ts
export interface InboundReply { messageId: string; kind: MessageKind; body: string | null; mediaMime: string | null; mediaName: string | null; createdAt: Date }
export interface BotActor { botId: string; botName: string; runId: string }
export type ResumeEvent =
  | { kind: 'reply'; reply: InboundReply }
  | { kind: 'timeout' }                                   // waiting_reply and timeout_at passed
  | { kind: 'timer' }                                     // waiting_timer and wake_at passed
  | { kind: 'flow'; outcome: 'finished' | 'failed' | 'stopped' }; // child of call_flow ended
export type BlockResult =
  | { next: string }                                      // handle id from outputsOf
  | { wait: 'reply'; timeoutAt: Date | null }
  | { wait: 'timer'; wakeAt: Date }
  | { wait: 'flow' }
  | { end: 'finished' }
  | { end: 'failed'; error: string };
export class BlockError extends Error {}                  // pt-BR message shown in bot_failed.reason; safe to show (no contact data)
export interface BotCtx {
  app: AppCtx;
  now: Date;                                              // app.botRuntime.now() at step start
  chat: ChatRow;                                          // fresh at step start; a block that changes the chat assigns the returned row back
  bot: { id: string; name: string };
  actor: BotActor;
  render(text: string): Promise<string>;                  // renderBotText with fresh contato/campo/atendente + run.vars
  lastInbound(): Promise<InboundReply | null>;            // newest direction='in' message of this chat
  startChild(botId: string): Promise<BotRunRow>;          // call_flow: starts a child (entry 'call', depth+1, parentRunId) and runs it to its first wait/end
  stopOtherRuns(chatId: string, reason: BotStopReason): Promise<void>; // stopRunsForChat excluding the current run's chain
}
export interface BlockDefinition {
  type: BlockType;
  run(ctx: BotCtx, run: BotRunRow, node: BotNode): Promise<BlockResult>;
  resume?(ctx: BotCtx, run: BotRunRow, node: BotNode, ev: ResumeEvent): Promise<BlockResult>; // required for blocks that wait
}
export type BlockRegistry = Partial<Record<BlockType, BlockDefinition>>;
export const defaultRegistry: BlockRegistry; // = { ...startBlocks, ...conditionBlocks, ...actionBlocks, ...finishBlocks } (spreads added by T6–T8)
// each blocks/*.ts exports `export const <family>Blocks: BlockRegistry`
```
Blocks may **mutate `run.vars` and `run.retries` in place**, and the engine persists both with the step. Blocks never write `bot_runs` themselves.

```ts
// bots/engine.ts
export interface StartRunInput { botId: string; chatId: string; entry: 'channel' | 'manual' | 'call'; startedBy: string | null;
  parentRunId?: string | null; depth?: number }
export async function startRun(ctx: AppCtx, input: StartRunInput): Promise<BotRunRow>;     // takes the chat lock
export async function resumeOnReply(ctx: AppCtx, chatId: string, reply: InboundReply): Promise<number>; // runs resumed
export async function resumeOnTimer(ctx: AppCtx, runId: string, now: Date): Promise<BotRunRow | null>;   // null = no longer due
export async function stopRun(ctx: AppCtx, runId: string, by: { userId: string | null; reason: BotStopReason }): Promise<BotRunRow>;
export async function stopRunsForChat(ctx: AppCtx, chatId: string, by: { userId: string | null; reason: BotStopReason },
  opts?: { exceptRunIds?: string[] }): Promise<BotRunRow[]>;
export async function runningRunsForChat(db: Db | Tx, chatId: string): Promise<BotRunRow[]>; // non-terminal, created_at asc
export async function step(ctx: AppCtx, runId: string, resume?: ResumeEvent): Promise<BotRunRow>; // the loop; caller holds the chat lock
export async function failInterruptedRuns(db: Db): Promise<number>; // implemented in Task 5; wired at boot and tested in Task 9: running → failed + bot_failed
```

**Engine rules.** Every block implementation relies on these.

1. **`startRun`** runs under `withChatLock(chatId)`.
   - It loads the bot. The bot must be `active` and have a `publishedVersionId`; otherwise it throws `badRequest('Este chatbot não está ativo')`.
   - The entry node is `startNodeOf(publishedGraph, entry)`. If there is none, it throws `badRequest('Este chatbot não tem esse tipo de início')`.
   - For entry ≠ `call`, an existing non-terminal run of the same bot on the chat throws `conflict('Este chatbot já está em execução nesta conversa')`.
   - For entry `call`, if `depth >= MAX_FLOW_LEVELS` it throws `BlockError('Limite de 5 fluxos encadeados')`.
   - One tx then:
     - inserts the run (`state 'running'`, `currentNodeId` = entry node, `versionId` = published),
     - does `bots.run_count += 1`,
     - writes the `bot_started` event.
   - After commit: publishes the chat, then runs `step`.
   - The child start inside `startChild` uses the same code **without** taking the lock again, because the lock is already held.
2. **`step`** does the following:
   - It reloads the run, its version graph and the chat.
   - Precheck: if the chat is not `open`, the run stops with reason `chat_closed`; if the contact is blocked, it stops with `contact_blocked`. Either way it returns without sending.
   - It loops at most `MAX_STEPS_PER_CALL` times. In each iteration:
     - It takes `node = graph.nodes.find(id === currentNodeId)` (missing → `failed 'Bloco não encontrado'`) and `def = registry[node.type]` (missing → `failed 'Bloco não suportado'`).
     - It calls `def.resume` for the first iteration of a resume, and `def.run` otherwise.
     - `{next: h}` follows the edge `(node.id, h)`. With no edge the run is `finished`. With an edge it moves `currentNodeId` to the target and resets `retries` to 0.
     - `{wait:'reply'}` sets `waiting_reply`, `waitNodeId = node.id`, `timeoutAt`, `wakeAt = null` and `waitingSince = clock_timestamp()`.
     - `{wait:'timer'}` sets `waiting_timer` and `wakeAt`.
     - `{wait:'flow'}` sets `waiting_flow`.
     - `{end}` makes the run terminal.
   - A thrown error goes to the node's `error` edge when the type has an `error` output and the edge exists; the step outcome is `'error'`. Otherwise the run is `failed`. A `BlockError` keeps its message. Any other error becomes `'Erro inesperado no bloco "<label>"'`, and `console.error` gets only the name and the code.
   - Running out of the loop gives `failed 'Limite de 50 passos sem espera (possível laço)'`.
   - Each step is saved with `UPDATE bot_runs SET … WHERE id = $1 AND state = 'running'`. The update appends to `steps`, which is capped at `STEP_LOG_LIMIT`, and writes `vars` and `retries`. If 0 rows update, the run was stopped meanwhile, so the loop ends silently.
   - No send happens inside these txs. Blocks send through `sendSystemMessage`, which runs its own tx and then calls the gateway.
3. **Terminal transition** (`finished`, `failed`, `stopped`):
   - Sets `finishedAt` and `error`, and clears `wakeAt`, `timeoutAt` and `waitingSince`.
   - Writes the event `bot_finished`, `bot_failed {reason}` or `bot_stopped {reason, by}`, then publishes the chat.
   - Then, if `parentRunId` points to a run in `waiting_flow`, it calls `step(parent, {kind:'flow', outcome})` under the lock already held.
4. **`resumeOnReply`** runs under `withChatLock(chatId)`. For each `waiting_reply` run of the chat, oldest first:
   - A tx with `SELECT … FOR UPDATE` re-checks `state === 'waiting_reply'` and `reply.createdAt >= waitingSince`. A reply stored earlier is ignored (Review Focus 1).
   - It sets `state = 'running'`, commits, then calls `step(run, {kind:'reply', reply})`.
   - Runs in `waiting_flow` are skipped; their child gets the reply.
5. **`resumeOnTimer`** runs under the lock of the run's chat.
   - A tx with `SELECT … FOR UPDATE` re-checks due-ness: `waiting_timer` with `wakeAt <= now` gives event `timer`, and `waiting_reply` with `timeoutAt <= now` gives event `timeout`.
   - It sets `running`, commits, then calls `step(run, ev)`.
6. **`stopRun`** does not take the lock. It stops the whole chain (the root, found by walking up `parentRunId`, plus all descendants) by setting `state = 'stopped'` on non-terminal runs. Each one gets a `bot_stopped` event. A step in flight then fails its conditional save and exits.
   - **`stopRunsForChat`** does the same for every non-terminal run of the chat, except `exceptRunIds`.
7. **Waiting blocks** use these `resume` events:
   - `ask_*`: `reply` → validate; `timeout` → `{next:'timeout'}`.
   - `wait_interval` with `resumeOnReply` returns `{wait:'reply', timeoutAt: wake}`. Its `timeout` → `{next:'next'}` and its `reply` → `{next:'replied'}`. Without `resumeOnReply` it returns `{wait:'timer'}`, and `timer` → `{next:'next'}`.
   - `call_flow`'s `flow` event: `finished` → `{next:'next'}`; `failed` or `stopped` → throws `BlockError('O fluxo acionado não terminou')`, so it goes to the `error` edge or `failed`.

### 3.8 Block behavior that crosses task boundaries (Tasks 6–8)

- **Rule evaluation** (exported from `blocks/conditions.ts`):
  ```ts
  export async function operandValue(ctx: BotCtx, run: BotRunRow, o: Operand): Promise<string>;
  export async function evalRule(ctx: BotCtx, run: BotRunRow, r: Rule): Promise<boolean>;
  export function zonedParts(d: Date, timeZone: string): { weekday: Weekday; minutes: number };
  ```
  - Operand values:
    - `var` reads `run.vars[name].value`, or `.raw` for `name:raw`. A missing var is `''`.
    - `field` reads the contact's current value: custom fields from `contact_field_values`, native fields from `contacts`.
    - `literal` is `ctx.render(value)`.
  - Comparison is numeric when both sides parse with `Number()` after replacing `,` with `.` and trimming. Otherwise both sides go through `normalize` from `triage/triage.ts`, which Task 6 exports.
  - `contains`, `not_contains` and `starts` always compare text.
  - `empty` means `value.trim() === ''`.
- **Condition blocks:**
  - `contact_active`: a `direction='in'` message from this contact on this channel with `sentAt >= now - 24h`.
  - `first_chat`: the contact has exactly 1 chat on this channel.
  - `chat_status`: `chat.waiting`.
  - `message_contains`: tested on `lastInbound().body`. A message with no text gives `no`.
  - `parallel_bot`: another non-terminal run on this chat whose id is not in this run's ancestor chain.
  - `distribute`: picks a branch by cumulative weight using `ctx.app.botRuntime.random()`.
- **`ask_choice`:**
  - `run` sends `text + '\n\n' + options.map(o => `${o.key}: ${o.label}`).join('\n')` and returns `{wait:'reply', timeoutAt: timeoutHours ? now+h : null}`.
  - A reply matches when its `normalize`d text equals the `normalize`d key or label of an option. On a match it sets `run.vars[name] = {raw: body, value: key, label}` and returns `{next:'opt:'+key}`.
  - When nothing matches (including `body === null`): if `retries < invalidRetries`, it does `retries++`, sends `invalidText || 'Opção inválida.'` and the menu again, and waits again with the same `timeoutAt`. Otherwise it returns `{next:'invalid'}`.
  - A failed send throws a `BlockError`.
- **`ask_input`:**
  - With `useLastMessage`, it first validates `lastInbound()`, and on success skips sending.
  - On a valid answer it sets `run.vars[name] = {raw, value}`. With `saveToField` it saves `value` (custom field → `setContactFields`; native → `updateContact`, where city/state merge into `address`), then returns `{next:'next'}`.
  - An invalid answer is handled like `ask_choice`: it sends `invalidText || 'Resposta inválida. Tente de novo.'`, without re-sending `text`.
- **System send** (Task 7, `messages/send.ts`, replaces the private `sendSystemText` in triage):
  ```ts
  export interface SystemSendInput { text?: string; attachment?: BotAttachment | null; botRunId?: string | null }
  export async function sendSystemMessage(ctx: AppCtx, chat: ChatRow, input: SystemSendInput)
    : Promise<{ ok: boolean; messageId: string | null; echoDropped: boolean }>;
  ```
  - It follows the same rules as today's `sendSystemText`: `authorId` null, pending insert plus a preview update in one tx, publish `message.created`, gateway call outside the tx, `markSent` or `failed`, publish `message.updated`. The caller publishes the chat.
  - An attachment is read from `path.join(config.mediaDir, attachment.path)`. The kind comes from the mime (`image`, `video`, otherwise `document`), and `text` becomes the caption.
  - With no address it returns `{ok:false, messageId:null}`.
- **Chat actions as the bot** (Task 8, `inbox/chats.ts`). These share the private `updateChat` and existence checks. They do no `canSee` check. Each one writes its event with `authorId: null` and `data` that includes `botId`, `botName` and `runId`. They publish after commit and throw `BlockError` for a missing sector or user. These functions never call the engine; the `close_chat` and `block_contact` blocks call `ctx.stopOtherRuns`.
  ```ts
  export async function transferChatAsBot(ctx: AppCtx, actor: BotActor, chatId: string, to: { sectorId?: string; ownerId?: string | null }): Promise<ChatRow>; // event 'bot_transferred' {fromSectorId,toSectorId,fromOwnerId,toOwnerId}; ownerId undefined = keep; null also sets private=false; triagePending=false
  export async function setChatPrivacyAsBot(ctx: AppCtx, actor: BotActor, chatId: string, isPrivate: boolean): Promise<ChatRow>; // event 'privacy_changed' {private, botName,…}; private without owner → BlockError('A conversa não tem atendente')
  export async function closeChatAsBot(ctx: AppCtx, actor: BotActor, chatId: string, opts: { closingText: string | null }): Promise<ChatRow>; // sends closingText via sendSystemMessage({botRunId}) BEFORE the update; event 'closed' {closingMessageSent, botName,…}
  ```
- **Notification** (Task 8, `realtime/hub.ts`, both hubs):
  ```ts
  publishNotification(chatId: string, userIds: string[], notification: NotificationDto): Promise<void>;
  // real hub: sends { type:'notification', notification } only to listed users who canSee the chat
  // recording hub: pushes { type: 'notification', chatId, userId } per listed user
  ```
  The `id` is `randomUUID()` and `createdAt` is `ctx.now.toISOString()`. Notifications are not persisted. `// ponytail: WS-only; offline agents miss it — add a notifications table when 2b's "notificar só se online" lands.`
- **Other actions:**
  - `transfer_sector` with `onlyIfAgentAllowed` keeps the owner only if the owner is in `userSectors` for the destination sector; otherwise it passes `ownerId: null`. Without the flag the owner is kept.
  - `transfer_agent` `specific` takes the first active user in list order. `least_busy` takes the active user in the chosen sectors with the fewest open chats they own, with ties broken by name. No candidate means `BlockError('Nenhum atendente disponível')`.
  - `call_flow` with `continueAfter=false` starts the child, then returns `{end:'finished'}`. With `true`: if the child is already terminal it returns `next` (finished) or throws (failed or stopped); otherwise `{wait:'flow'}`. The target bot must be active and published.
  - `block_contact`: `setContactBlocked(true)`, then `closeChatAsBot` (no closing text) for every open chat of the contact, then `stopOtherRuns` on each of those chats, then `{end:'finished'}`.
  - `close_chat`: `closingText` is `config.closingText ||` the settings closing message (`''` → none) when `sendClosingMessage` is set. It calls `closeChatAsBot`, then `stopOtherRuns(chat.id, 'chat_closed')`, then `{end:'finished'}`.
  - `note` writes the event `bot_note {text: rendered}` and publishes the chat.
  - `sticky_note.run` returns `{end:'failed', error:'Anotação não executa'}`. It can never be reached, because validation forbids edges to it.

### 3.9 Scheduler (Task 9, `server/src/bots/scheduler.ts`)

```ts
export interface Scheduler {
  tick(now?: Date): Promise<number>;  // now defaults to ctx.botRuntime.now(); returns runs resumed
  start(): void;                      // setInterval(() => void tick().catch(logName), intervalMs); idempotent
  stop(): void;                       // clearInterval; idempotent
}
export function createScheduler(ctx: AppCtx, opts?: { intervalMs?: number }): Scheduler; // default 5000
```
- `tick` runs one tx: `SELECT id FROM bot_runs WHERE (state='waiting_timer' AND wake_at <= $now) OR (state='waiting_reply' AND timeout_at <= $now) ORDER BY coalesce(wake_at, timeout_at) LIMIT 50 FOR UPDATE SKIP LOCKED`. After commit it calls `resumeOnTimer(ctx, id, now)` for each id, one after another.
- In `index.ts`, the boot sequence after `failInterruptedSends` is `await failInterruptedRuns(db)`. After `app.listen` it is `const scheduler = createScheduler(ctx); scheduler.start();`, and the signal handler calls `scheduler.stop()` before `app.close()`.

### 3.10 HTTP (Tasks 10–12)

**Errors (Task 10):**
- `class HttpError { constructor(public status: number, message: string, public body?: Record<string, unknown>) }`, and the handler sends `{ error: err.message, ...err.body }`.
- `export function botRunningError(runs: Array<{ id: string; botName: string }>): HttpError` returns 409 with body `{ code: 'BOT_RUNNING', runs }` and message `'O chatbot está em execução nesta conversa'`.

**Interaction (Task 10, `bots/hooks.ts`):**
```ts
export async function startChannelBot(ctx: AppCtx, chat: ChatRow): Promise<boolean>;   // findChannelBot → startRun(entry 'channel', startedBy null); false if none or start threw (console.error name only)
export async function resumeBotsOnReply(ctx: AppCtx, chatId: string, reply: InboundReply): Promise<number>; // = resumeOnReply
export async function applyBotRunningBehavior(ctx: AppCtx, user: AuthUser, chatId: string, botAction: BotAction | undefined,
  reason: 'agent_message' | 'transfer'): Promise<void>;
// runs = runningRunsForChat; none → return. effective = botAction ?? await getBotRunningBehavior(ctx.db).
// 'ask' → throw botRunningError(runs.map(r => ({ id: r.id, botName }))); 'stop' → stopRunsForChat(ctx, chatId, { userId: user.id, reason }); 'keep' → return.
```
- `messages/ingest.ts`:
  - `IngestHooks` gains **optional** `startChannelBot?` and `resumeBotsOnReply?`. `handleInbound` merges `{ ...defaultHooks, ...hooks }`.
  - Inbound only: when the chat was created, `startTriage` runs only if `!(await h.startChannelBot(ctx, chat))`. Otherwise `handleTriageReply` runs when `triagePending`, and then `h.resumeBotsOnReply(ctx, chat.id, reply)` always runs.
  - The reply's `createdAt` is the stored message's `created_at`.
- `sendAgentMessage`: `SendInput` gains `botAction?: BotAction`. It calls `applyBotRunningBehavior(…, 'agent_message')` right after the closed-chat check and before any insert.
  - The close route's `sendClosing` passes `botAction: 'keep'`, so closing never asks.
  - `addNote` and `resendMessage` are unaffected.
- `chats/routes.ts`:
  - `textBody` gains `botAction: z.enum(['stop','keep']).optional()`, and so does the multipart field `botAction`, which must come before the file.
  - `transferBody` gains `botAction`, and the route calls `applyBotRunningBehavior(…, 'transfer')` before `transferChat`.
  - The close route calls `stopRunsForChat(ctx, id, { userId: user.id, reason: 'chat_closed' })` after `closeChat` succeeds.
- `catalog/settings.ts`:
  - `Body` gains `botRunningBehavior: z.enum(['ask','stop','keep']).default('ask')`. It is upserted as key `bot_running_behavior` and read back into `SettingsDto.botRunningBehavior`.
  - `export async function getBotRunningBehavior(db: Db | Tx): Promise<BotRunningBehavior>`.

**Bot routes (Task 11, `bots/routes.ts`, `export function registerBotRoutes(app: FastifyInstance, ctx: AppCtx): void`, registered after `registerChannelRoutes`):**

```ts
const IdParams = z.object({ id: z.uuid() });
const VersionParams = z.object({ id: z.uuid(), n: z.coerce.number().int().positive() });
const NodeSchema = z.object({
  id: z.string().min(1).max(64), type: z.enum(BLOCK_TYPES),
  position: z.object({ x: z.number().finite(), y: z.number().finite() }),
  config: z.record(z.string(), z.unknown()), name: z.string().max(40).optional(),
});
const EdgeSchema = z.object({ id: z.string().min(1).max(64), source: z.string().min(1).max(64), sourceHandle: z.string().min(1).max(64), target: z.string().min(1).max(64) });
export const GraphSchema = z.object({ nodes: z.array(NodeSchema).max(500), edges: z.array(EdgeSchema).max(2000) });
const Name = z.string().trim().min(1).max(80);
const CreateBody = z.object({ name: Name, description: z.string().trim().max(500).optional() });
const PatchBody = z.object({ name: Name, description: z.string().trim().max(500), startChannelIds: z.array(z.uuid()).max(50),
  manualStart: z.boolean(), manualTitle: z.string().trim().max(80), manualUnlisted: z.boolean() }).partial();
const SaveVersionBody = z.object({ graph: GraphSchema, label: z.string().trim().max(80).optional(), publish: z.boolean() });
const StatusBody = z.object({ status: z.enum(['active', 'paused']) });
const ImportBody = z.object({ name: Name, graph: GraphSchema });
const StartRunBody = z.object({ botId: z.uuid() });
const TemplateDest = z.object({ sectorId: z.uuid(), userId: z.uuid().nullable().optional() });
const TemplateBody = z.object({ name: Name.optional(), companyName: z.string().trim().min(1).max(80), channelId: z.uuid(),
  destinations: z.object({ atendimento: TemplateDest, financeiro: TemplateDest, processos: TemplateDest }) });
```

| Method and route | Body | Response | Access and errors |
|---|---|---|---|
| GET `/api/bots` | — | `BotDto[]` (name asc) | admin (`forbidden()` otherwise) |
| POST `/api/bots` | `CreateBody` | `BotDto` (version 1 = `STARTER_GRAPH()`, unpublished, paused) | admin; 409 'Já existe um chatbot com esse nome' |
| GET `/api/bots/:id` | — | `BotDto` | admin; 404 |
| PATCH `/api/bots/:id` | `PatchBody` | `BotDto` | admin; 409 duplicate name; 400 'Canal inexistente' |
| DELETE `/api/bots/:id` | — | 204 | admin; 409 `{error:'Este chatbot tem execuções em andamento'}`; 409 `{error:'Este chatbot é acionado por outros fluxos', usedBy:[{id,name}]}`, checked against the published and latest versions of the other bots |
| POST `/api/bots/:id/duplicate` | — | `BotDto` (name `uniqueBotName(name+' (cópia)')`, version 1 = this bot's latest graph, valid recomputed, unpublished, paused, same channels and manual flags) | admin |
| GET `/api/bots/:id/versions` | — | `BotVersionSummaryDto[]` | admin |
| GET `/api/bots/:id/versions/:n` | — | `BotVersionDto` | admin; 404 |
| POST `/api/bots/:id/versions` | `SaveVersionBody` | `BotVersionDto`. Always inserts a version with `valid = problems.length === 0`. `publish && valid` also sets `publishedVersionId`. | admin; `publish && !valid` → 400 `{error:'O fluxo tem problemas', problems: GraphProblem[]}`, and the draft is **still saved** |
| POST `/api/bots/:id/status` | `StatusBody` | `BotDto` | admin; activating without a published version → 400 'Publique uma versão antes de ativar' |
| POST `/api/bots/import` | `ImportBody` | `BotDto` (name `uniqueBotName`, version 1, valid recomputed, unpublished, paused) | admin; a malformed graph → 400 (zod) |
| GET `/api/bots/:id/export` | — | `BotExport` of the latest version, with `content-disposition: attachment; filename="<slug>.json"` | admin |
| POST `/api/bots/media` | multipart, 1 file | `BotMediaDto` (saved with `saveMedia(mediaDir, buf, mime, name, 'bots')`, which gives `bots/<uuid>.<ext>`) | admin |
| POST `/api/bots/from-template` (Task 12) | `TemplateBody` | `BotDto` | admin; 400 for an unknown channel, sector or user |
| GET `/api/bots/manual` | — | `ManualBotDto[]` (active, published, `manualStart`, `!manualUnlisted`, title asc) | any user |
| POST `/api/chats/:id/bot-runs` | `StartRunBody` | `BotRunDto` | `getChatForUser` (404); a closed chat → 409 'Conversa finalizada'; a bot not active, not published or without `manualStart` → 400 'Este chatbot não pode ser iniciado manualmente'; a duplicate → 409 |
| GET `/api/chats/:id/bot-runs` | — | `BotRunDto[]` (non-terminal) | `getChatForUser` (404) |
| POST `/api/bot-runs/:id/stop` | — | `BotRunDto`, idempotent: an already terminal run returns as is | 404 if the run is missing or `!canSee(run's chat)`; reason `'manual'` |
| POST `/api/chats/:id/messages` | existing + `botAction?: 'stop'\|'keep'` | `MessageDto` | as today; 409 `BotRunningErrorBody` |
| POST `/api/chats/:id/transfer` | existing + `botAction?` | `ChatDetail` | as today; 409 `BotRunningErrorBody` |

- `saveMedia` signature (Task 11): `saveMedia(mediaDir, data, mime, originalName?, subdir?: string)`. When `subdir` is given, it replaces `YYYY/MM`.
- Status codes follow the codebase: creates return 200 with the row, deletes return 204.

**Template (Task 12, `bots/templates.ts`):**
```ts
export function buildOfficeGraph(input: OfficeTemplateInput, cpfFieldId: string): BotGraph; // pure
export async function createOfficeTemplate(ctx: AppCtx, input: OfficeTemplateInput, createdBy: string): Promise<BotDto>;
// ensures custom field 'CPF' (kind 'cpf'; insert onConflictDoNothing on name, then select), createBot({ publish: true, startChannelIds: [channelId] }),
// status stays 'paused' (admin activates after review). Throws badRequest if the built graph is invalid.
```
- Node names fixed by the contract (Task 12 tests `{{contexto.cpf}}`): `inicio`, `horario`, `fora_do_horario`, `boas_vindas`, `menu` (ask_choice, keys `1`, `2`, `3`), `comunicado`, `cpf` (ask_input `cpf`, `invalidRetries: 2`, with both `next` and `invalid` going to `destino`), `destino` (multi_condition on `{kind:'var', value:'menu'}` `eq` `'1'`, `'2'` and `'3'`).
- Per destination there is `setor_<k>`. When a `userId` is mapped, it continues to `agente_<k>` (transfer_agent `specific`) and then `aviso_<k>` (notify_agent `owner`, title `'Nova conversa'`, text `'Nova conversa de {{contato.nome}} — CPF {{contexto.cpf}}'`). `<k>` is `atendimento`, `financeiro` or `processos`.
- The menu `timeout` is 24 h and unconnected (end). Its `invalid` output is unconnected after 1 retry.
- `hours` uses `America/Cuiaba` with two intervals, Mon–Fri 08:00–12:00 and 14:00–18:00.

### 3.11 Web (Tasks 13–16)

**`web/src/lib/api.ts` (Task 13):**
```ts
export class ApiError extends Error { constructor(public status: number, message: string, public correlationId?: string, public data?: unknown) } // request() passes the parsed body
export function botRunningRuns(e: unknown): BotRunningErrorBody['runs'] | null; // ApiError 409 with data.code === 'BOT_RUNNING'
export function graphProblems(e: unknown): GraphProblem[] | null;               // ApiError 400 with data.problems array
// SendTextInput / SendFileInput / transfer `to` gain botAction?: BotAction (multipart: append 'botAction' before the file)
api.bots = {
  list: () => request<BotDto[]>('GET', '/api/bots'),
  create: (input: { name: string; description?: string }) => request<BotDto>('POST', '/api/bots', input),
  get: (id: string) => request<BotDto>('GET', `/api/bots/${enc(id)}`),
  update: (id: string, patch: BotPatch) => request<BotDto>('PATCH', `/api/bots/${enc(id)}`, patch),
  remove: (id: string) => request<void>('DELETE', `/api/bots/${enc(id)}`),
  duplicate: (id: string) => request<BotDto>('POST', `/api/bots/${enc(id)}/duplicate`),
  versions: (id: string) => request<BotVersionSummaryDto[]>('GET', `/api/bots/${enc(id)}/versions`),
  version: (id: string, n: number) => request<BotVersionDto>('GET', `/api/bots/${enc(id)}/versions/${n}`),
  saveVersion: (id: string, input: SaveVersionInput) => request<BotVersionDto>('POST', `/api/bots/${enc(id)}/versions`, input),
  setStatus: (id: string, status: 'active' | 'paused') => request<BotDto>('POST', `/api/bots/${enc(id)}/status`, { status }),
  importBot: (data: BotExport) => request<BotDto>('POST', '/api/bots/import', data),
  exportUrl: (id: string) => `/api/bots/${enc(id)}/export`,
  uploadMedia: (file: Blob, name?: string) => request<BotMediaDto>('POST', '/api/bots/media', /* FormData 'file' */),
  fromTemplate: (input: OfficeTemplateInput) => request<BotDto>('POST', '/api/bots/from-template', input),
  manual: () => request<ManualBotDto[]>('GET', '/api/bots/manual'),
};
api.botRuns = {
  listForChat: (chatId: string) => request<BotRunDto[]>('GET', `/api/chats/${enc(chatId)}/bot-runs`),
  start: (chatId: string, botId: string) => request<BotRunDto>('POST', `/api/chats/${enc(chatId)}/bot-runs`, { botId }),
  stop: (runId: string) => request<BotRunDto>('POST', `/api/bot-runs/${enc(runId)}/stop`),
};
// qk additions:
bots: ['bots'] as const,
bot: (id: string) => ['bots', 'detail', id] as const,
botVersions: (id: string) => ['bots', 'versions', id] as const,
botVersion: (id: string, n: number) => ['bots', 'versions', id, n] as const,
botManual: ['bots', 'manual'] as const,
chatBotRuns: (chatId: string) => ['chats', 'bot-runs', chatId] as const,   // under ['chats'] so WS reconnect refreshes it
```

**Pages and components:**
- Task 13:
  - `BotsSettings()`, registered as `{ path: 'chatbots', label: 'Chatbots', adminOnly: true, page: BotsSettings }`.
  - `OfficeTemplateDialog({ onCancel, onCreated(bot: BotDto) })`.
  - The `ChatSettings` select labeled "Quando o atendente enviar mensagem com chatbot em execução", with options `Perguntar` / `Parar o bot` / `Manter rodando`.
  - Rows link to `/configuracoes/chatbots/:id`.
- Task 14, the route `{ path: '/configuracoes/chatbots/:id', element: <RequireAuth><BotEditorPage /></RequireAuth> }`. It is a top-level sibling of `/` and sits before `/` in `routes`, so it is full screen outside `AppLayout`. A non-admin is redirected to `/configuracoes/perfil`.
- `web/src/components/bot-editor/editor-state.ts` (pure, Task 14):
  ```ts
  export interface BlockNodeData { node: BotNode; problems: string[] }
  export function toFlowNodes(graph: BotGraph, problems: GraphProblem[]): Array<import('@xyflow/react').Node<BlockNodeData>>;
  export function toFlowEdges(graph: BotGraph): Array<import('@xyflow/react').Edge>;
  export function addNode(graph: BotGraph, type: BlockType, position: { x: number; y: number }): { graph: BotGraph; nodeId: string }; // name = nodeNameFor, config = defaultConfig
  export function connect(graph: BotGraph, c: { source: string; sourceHandle: string; target: string }): BotGraph; // replaces the edge on that handle; ignores targets that are start/sticky
  export function removeElements(graph: BotGraph, nodeIds: string[], edgeIds: string[]): BotGraph;
  export function updateNodeConfig(graph: BotGraph, nodeId: string, config: Record<string, unknown>): BotGraph; // then drops edges whose handle left outputsOf
  export function renameNode(graph: BotGraph, nodeId: string, name: string): BotGraph;
  export function moveNodes(graph: BotGraph, positions: Record<string, { x: number; y: number }>): BotGraph;
  export interface History { graph: BotGraph; canUndo: boolean; canRedo: boolean }
  export function useGraphHistory(initial: BotGraph): History & { set(g: BotGraph): void; undo(): void; redo(): void; reset(g: BotGraph): void }; // EDITOR_HISTORY_LIMIT
  // layout.ts
  export function autoLayout(graph: BotGraph): BotGraph; // dagre rankdir 'LR', nodesep 40, ranksep 80, node 280x160; sticky notes keep position
  ```
- Task 14 components:
  - `BotEditor({ bot, initial }: { bot: BotDto; initial: BotVersionDto })`
  - `BlockNode` (React Flow `nodeTypes = { block: BlockNode }`, one target handle on the left except for start/sticky, one source handle per `outputsOf` with `id = output.id`, label on the right, red ring when `problems.length`)
  - `Palette({ open, onInsert(type) })`, toggled with Tab when focus is not in an input
  - `Toolbar`, `VersionsPanel({ botId, onRestore(graph) })`, `ProblemsList({ problems, onFocus(nodeId) })`
  - `blockIcon(name: string): import('@phosphor-icons/react').Icon` in `icons.ts`
  - `useEditorCatalog(): EditorCatalog | null`, where `EditorCatalog = { sectors: SectorDto[]; users: UserDto[]; tags: TagDto[]; customFields: CustomFieldDto[]; channels: ChannelDto[]; bots: BotDto[] }`
- Category colors (Tailwind classes): start `border-success`, condition `border-amber-500`, action `border-primary`, finish `border-danger`, utility `border-border`.
- Cards (Task 15, `cards/index.tsx`):
  ```ts
  export interface BlockCardProps { node: BotNode; catalog: EditorCatalog; bot: BotDto; problems: string[];
    onChange(config: Record<string, unknown>): void; onBotChange(patch: BotPatch): void }
  export function BlockConfigCard(props: BlockCardProps): JSX.Element; // switch on node.type; Task 14 ships a fallback that shows catalogEntry(type).description
  ```
  - `start_channel` and `start_manual` edit the bot fields through `onBotChange`. `BotEditor` keeps the pending `BotPatch` and PATCHes it before `saveVersion` on save.
- Conversation (Task 16):
  - `BotPanel({ chatId, onClose })` uses `qk.botManual`, `qk.chatBotRuns(chatId)` and invalidates `chatBotRuns` on a `chat.updated` WS event for this chat.
  - `BotRunningDialog({ runs, onChoose }: { runs: BotRunningErrorBody['runs']; onChoose(a: BotAction | null): void })` lives in `ChatDialogs.tsx`. Its title is "O chatbot está rodando". Its buttons are "Parar e enviar" (`stop`), "Enviar e manter" (`keep`) and "Cancelar" (`null`).
  - `NotificationToasts()` is mounted in `AppLayout`. It shows WS `notification` events for 8 s, links to `/chats/:chatId`, and also uses `new Notification(title, { body })` when `Notification.permission === 'granted'`.
  - `MessageBubble` shows the label `Chatbot ${m.botName}` with the Phosphor `Robot` icon when `m.botName` is set.

---

## Tasks (execution order)

1. Shared bot catalog types and web deps
2. Database migration and bot repository helpers
3. Graph validation and input validators
4. Variables rendering with contexto
5. Engine core (registry, step loop, waits, limits, start/resume/stop)
6. Condition blocks
7. Action blocks I (send_message, note, ask_choice, ask_input, set_contact_field, edit_tags)
8. Action blocks II and start/finish blocks (transfer_sector, transfer_agent, privacy, notify_agent, call_flow, block_contact, close_chat, start_channel, start_manual, sticky_note)
9. Scheduler and startup wiring
10. Ingest and agent interaction integration (start by channel with priority over triage, resume on reply, bot_running_behavior incl. 409 BOT_RUNNING and botAction, close/transfer stop rules, settings key)
11. Bot REST API
12. Office template, create-from-template and end-to-end test
13. Web bots list and Conversas setting
14. Web editor foundation (canvas, palette, handles from outputsOf, save/publish/validation, undo/redo, auto-layout, versions, import/export)
15. Web block config cards (all block forms)
16. Web conversation integration (bot messages, bot events, composer robot panel, BOT_RUNNING dialog, notifications)
17. Docs and manual acceptance checklist (README/IMPLANTACAO updates, acceptance steps of spec §1)


---

### Task 1: Shared bot catalog types and web deps

**Files:**
- Create: `shared/src/bots.ts`
- Modify: `shared/src/index.ts` (whole file shown below)
- Modify: `server/src/db/schema.ts:1-17` (import) and `server/src/db/schema.ts:211-214` (`chatEvents.kind`)
- Modify: `server/src/inbox/events.ts:1-6`
- Modify: `web/src/components/conversation/model.ts:67-90` (`eventText`)
- Modify: `web/src/lib/ws.ts:82-90` (`applyWsEvent`)
- Modify: `web/package.json`, `package-lock.json` (two exact pins)
- Test: `server/test/bots/catalog.test.ts` (create)
- Test: `web/src/components/conversation/model.test.ts` (add one `describe`)

**Interfaces:**
- Consumes: nothing from earlier tasks. Uses the existing `ChatEventDto`, `MessageDto` and `WsEvent` (`shared/src/index.ts`), `addEvent` (`server/src/inbox/events.ts`) and `eventText` (`web/src/components/conversation/model.ts`).
- Produces (exactly the SHARED CONTRACT §3.1 and §3.2):
  - `shared/src/bots.ts`, re-exported from `@talk/shared`:
    - **Values:** `BLOCK_TYPES` (33 entries), `WEEKDAYS`, `WEEKDAY_LABELS`, `DEFAULT_TIMEZONE`, `RULE_OPERATOR_LABELS`, `NATIVE_CONTACT_FIELDS`, `BLOCK_CATALOG`, `BLOCK_CATEGORY_LABELS`, `NON_TERMINAL_RUN_STATES`, `MAX_STEPS_PER_CALL`, `MAX_FLOW_LEVELS`, `STEP_LOG_LIMIT`, `EDITOR_HISTORY_LIMIT`.
    - **Functions:**
      - `configOf<T extends BlockType>(node: BotNode & { type: T }): BlockConfigMap[T]`
      - `defaultConfig<T extends BlockType>(type: T): BlockConfigMap[T]`, which returns a fresh object on every call
      - `nodeNameFor(type: BlockType, taken: Iterable<string>): string`
      - `catalogEntry(type: BlockType): BlockCatalogEntry`
      - `outputsOf(type: BlockType, config: Record<string, unknown>): BlockOutput[]`, which never throws
    - **Types:** every type and interface in §3.1, all exported through `export type * from './bots.js'`:
      - Graph: `BlockType`, `BlockCategory`, `BotGraph`, `BotNode`, `BotEdge`, `BlockOutput`
      - Config: the shared config pieces, every `*Config` interface, `BlockConfigMap`, `BlockCatalogEntry`
      - Runs: `BotRunState`, `VarValue`, `BotRunVars`, `BotRunStep`, `BotStopReason`, `BotRunningBehavior`, `BotAction`
      - DTOs: `GraphProblem`, `BotDto`, `BotPatch`, `BotVersionSummaryDto`, `BotVersionDto`, `SaveVersionInput`, `BotRunDto`, `ManualBotDto`, `BotExport`, `BotMediaDto`, `OfficeTemplateDestination`, `OfficeTemplateInput`, `BotEventData`, `BotRunningErrorBody`, `NotificationDto`
  - `shared/src/index.ts`:
    - `MessageDto` gains `botRunId?: string | null; botName?: string | null`.
    - New `export type ChatEventKind`: the 7 existing kinds plus `'bot_started' | 'bot_finished' | 'bot_stopped' | 'bot_failed' | 'bot_transferred' | 'bot_note'`. `ChatEventDto.kind` is `ChatEventKind`.
    - `WsEvent` gains `| { type: 'notification'; notification: NotificationDto }`.
    - `SettingsDto` does not change here (Task 10 adds `botRunningBehavior`).
  - `server/src/inbox/events.ts`: `ChatEventKind` is re-exported from `@talk/shared`. The name and import path stay the same for every caller. `server/src/db/schema.ts` uses it for `chatEvents.kind`. This leaves one union on the server side, and the exhaustive switch in `eventText` is the only other copy.
  - `web/src/components/conversation/model.ts`: `eventText` handles the six `bot_*` kinds with the texts from §3.2. `privacy_changed` and `closed` add ` · Chatbot <botName>` when `data.botName` is a string.
  - `web/src/lib/ws.ts`: `applyWsEvent` gains `case 'notification': return;`.
  - `web/package.json`: `"@xyflow/react": "12.12.0"` and `"@dagrejs/dagre": "3.1.1"`, exact versions with no `^`.

No migration: `chat_events.kind` is a `text` column, and only its TypeScript type changes.

- [ ] **Step 1: Install the two web dependencies, pinned exactly**

Run from the repo root:

```bash
npm install -w web --save-exact @xyflow/react@12.12.0 @dagrejs/dagre@3.1.1
npm ls -w web @xyflow/react @dagrejs/dagre
```

Expected:
- `npm ls` lists `@xyflow/react@12.12.0` and `@dagrejs/dagre@3.1.1`.
- The `dependencies` in `web/package.json` now include `"@dagrejs/dagre": "3.1.1"` and `"@xyflow/react": "12.12.0"`, with no `^` or `~`.
- Never accept `13.0.0-next.*` or any other version.

- [ ] **Step 2: Write the failing catalog test**

Create `server/test/bots/catalog.test.ts`:

```ts
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -w server -- test/bots/catalog.test.ts`
Expected: FAIL. The file fails to collect with `TypeError: Cannot read properties of undefined (reading 'every')`. `@talk/shared` does not export `BLOCK_TYPES` yet, so `it.each(undefined)` throws.

- [ ] **Step 4: Create `shared/src/bots.ts`**

Create `shared/src/bots.ts`:

```ts
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
```

Notes:
- `DEFAULTS` and `CATALOG` are typed by `BlockType`, so a missing or extra type fails `npm run typecheck`.
- The `switch` in `outputsOf` has no `default`. A missing case fails with TS2366.
- `outputsOf` reads the config only through `list`, `field` and `text`, so it never throws on bad input: a `null` config, a non-array `cases`, `null` items or numeric keys. A numeric key `1` becomes `opt:1`.
- `distribute` shows `Math.round(weight / total * 100)`, so three equal branches each show 33%. A weight that is not a number > 0 counts as 0. A total of 0 shows 0%.

- [ ] **Step 5: Replace `shared/src/index.ts`**

Replace the whole file with:

```ts
// DTOs and WebSocket event types shared by server and web, plus two runtime modules: the tag palette (palette.ts)
// and the chatbot block catalog (bots.ts). There is no build step: tsx (server) and Vite (web) load this
// TypeScript source directly. Use `import type` for everything except the values re-exported below.
import type { NotificationDto } from './bots.js';
export { TAG_COLORS, tagColorHex } from './palette.js';
export {
  BLOCK_TYPES, WEEKDAYS, WEEKDAY_LABELS, DEFAULT_TIMEZONE, RULE_OPERATOR_LABELS, NATIVE_CONTACT_FIELDS, BLOCK_CATALOG,
  BLOCK_CATEGORY_LABELS, NON_TERMINAL_RUN_STATES, MAX_STEPS_PER_CALL, MAX_FLOW_LEVELS, STEP_LOG_LIMIT, EDITOR_HISTORY_LIMIT,
  configOf, defaultConfig, nodeNameFor, catalogEntry, outputsOf,
} from './bots.js';
export type * from './bots.js';

export type Role = 'admin' | 'agent';
export interface Me { id: string; name: string; email: string; role: Role; signature: string | null; sectorIds: string[]; seeAllSectors: boolean; avatarUrl: string | null }
export interface SectorDto { id: string; name: string; position: number; isDefault: boolean }
export interface TagDto { id: string; name: string; emoji: string | null; color: string; position: number }
export interface UserDto { id: string; name: string; email: string; role: Role; signature: string | null; active: boolean; sectorIds: string[]; avatarUrl: string | null }
export interface ChannelDto { id: string; name: string; status: 'disconnected' | 'connecting' | 'connected'; phone: string | null }
export interface ContactRef { id: string; name: string | null; phone: string | null; avatarUrl: string | null }
export type ChatTab = 'inbox' | 'waiting' | 'closed';
export interface ChatListFilters { tab: ChatTab; q?: string; sectorId?: string; ownerId?: string; tagId?: string; from?: string; to?: string; cursor?: string; limit?: number }
export interface ChatListItem { id: string; contact: ContactRef; channelId: string; sectorId: string; ownerId: string | null; state: 'open' | 'closed'; waiting: boolean; private: boolean; unread: number; lastMessageAt: string | null; lastMessagePreview: string | null; pinned: boolean; tagIds: string[] }
export interface ChatDetail extends ChatListItem { triagePending: boolean; createdAt: string; closedAt: string | null }
export interface MediaDto { url: string; mime: string; name: string | null; size: number | null }
export interface MessageDto { id: string; chatId: string; direction: 'in' | 'out'; kind: 'text' | 'image' | 'audio' | 'video' | 'document' | 'sticker' | 'note' | 'unsupported'; body: string | null; media: MediaDto | null; mediaUnavailable: boolean; authorId: string | null; authorName: string | null; authorAvatarUrl: string | null; replyTo: { id: string; body: string | null; kind: string } | null; reaction: string | null; status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed'; error: string | null; sentAt: string;
  // optional so existing literals compile; toMessageDto always fills them (Task 2)
  botRunId?: string | null; botName?: string | null }
export interface ChatEventDto { id: string; chatId: string; kind: ChatEventKind; data: Record<string, unknown>; authorName: string | null; createdAt: string }
export type ChatEventKind =
  | 'created' | 'assigned' | 'transferred' | 'closed' | 'reopened' | 'privacy_changed' | 'triage_routed'
  | 'bot_started' | 'bot_finished' | 'bot_stopped' | 'bot_failed' | 'bot_transferred' | 'bot_note';
export type TimelineItem = ({ type: 'message' } & MessageDto) | ({ type: 'event' } & ChatEventDto);
export interface ContactDto { id: string; name: string | null; phone: string | null; lid: string | null; email: string | null; landline: string | null; address: Record<string, string> | null; blocked: boolean; tagIds: string[]; fields: Record<string, string>; createdAt: string; avatarUrl: string | null }
export interface ContactNoteDto { id: string; body: string; pinned: boolean; authorName: string | null; createdAt: string }
export interface CustomFieldDto { id: string; name: string; kind: 'text' | 'number' | 'date' | 'cpf' | 'cnpj'; position: number }
export interface QuickAnswerDto { id: string; name: string; body: string; hasAttachment: boolean; visibility: 'all' | 'owner'; ownerId: string | null }
export interface TriageMenuDto { enabled: boolean; welcomeText: string; invalidText: string; options: Array<{ key: string; label: string; sectorId: string }> }
export interface SettingsDto { closingMessage: string; triageMenu: TriageMenuDto }
export type WsEvent =
  | { type: 'chat.updated'; chat: ChatListItem }
  | { type: 'chat.removed'; chatId: string }
  | { type: 'message.created'; message: MessageDto }
  | { type: 'message.updated'; message: MessageDto }
  | { type: 'channel.status'; channel: ChannelDto }
  | { type: 'notification'; notification: NotificationDto };
```

The only changes from the current file:
- the header comment
- `import type { NotificationDto }`
- the `bots.js` value re-exports and `export type *`
- the two `MessageDto` bot fields
- `ChatEventKind`, used by `ChatEventDto.kind`
- the `notification` WsEvent

Every other line stays byte-for-byte the same.

- [ ] **Step 6: Run the catalog test and the shared typecheck to verify they pass**

Run: `npm test -w server -- test/bots/catalog.test.ts`
Expected: PASS (1 file, 207 tests).

Run: `npm run typecheck -w shared`
Expected: exit 0, no output from `tsc`.

- [ ] **Step 7: Write the failing web test for the bot event texts**

In `web/src/components/conversation/model.test.ts`, insert this block right **before** the line `describe('small helpers', () => {`. It uses the file's existing `event()` helper.

```ts
describe('eventText for chatbot events', () => {
  const names = new Map([['s-fin', 'Financeiro'], ['u-ana', 'Ana']]);
  const bot = { botId: 'b1', botName: 'Triagem', runId: 'r1' };

  it('describes each bot kind in Portuguese', () => {
    expect(eventText(event({ kind: 'bot_started', data: bot }), names)).toBe('Chatbot Triagem iniciado');
    expect(eventText(event({ kind: 'bot_finished', data: bot }), names)).toBe('Chatbot Triagem finalizado');
    expect(eventText(event({ kind: 'bot_stopped', data: { ...bot, reason: 'manual' } }), names)).toBe('Chatbot Triagem parado');
    expect(eventText(event({ kind: 'bot_stopped', authorName: 'Bia', data: { ...bot, reason: 'manual', by: 'u-bia' } }), names)).toBe(
      'Chatbot Triagem parado por Bia',
    );
    expect(eventText(event({ kind: 'bot_failed', data: { ...bot, reason: 'Limite de 5 fluxos encadeados' } }), names)).toBe(
      'Chatbot Triagem falhou: Limite de 5 fluxos encadeados',
    );
    expect(eventText(event({ kind: 'bot_failed', data: bot }), names)).toBe('Chatbot Triagem falhou');
    expect(eventText(event({ kind: 'bot_transferred', data: { ...bot, toSectorId: 's-fin', toOwnerId: 'u-ana' } }), names)).toBe(
      'Chatbot Triagem transferiu para Financeiro · Ana',
    );
    expect(eventText(event({ kind: 'bot_transferred', data: { ...bot, toSectorId: 's-x', toOwnerId: null } }), names)).toBe(
      'Chatbot Triagem transferiu para outro setor',
    );
    expect(eventText(event({ kind: 'bot_note', data: { ...bot, text: 'Cliente VIP' } }), names)).toBe('Nota do chatbot Triagem: Cliente VIP');
    expect(eventText(event({ kind: 'bot_started' }), names)).toBe('Chatbot Chatbot iniciado');
  });

  it('marks privacy changes and closes done by a bot', () => {
    expect(eventText(event({ kind: 'privacy_changed', data: { ...bot, private: true } }), names)).toBe(
      'Conversa tornada privada · Chatbot Triagem',
    );
    expect(eventText(event({ kind: 'closed', data: { ...bot, closingMessageSent: true } }), names)).toBe(
      'Conversa finalizada · Chatbot Triagem',
    );
  });
});
```

- [ ] **Step 8: Run the web test to verify it fails**

Run: `npm test -w web -- src/components/conversation/model.test.ts`
Expected: FAIL in `eventText for chatbot events`:
- `expected undefined to be 'Chatbot Triagem iniciado'`, because the switch has no `bot_*` cases yet.
- `expected 'Conversa tornada privada' to be 'Conversa tornada privada · Chatbot Triagem'`.

The other tests in the file still pass.

- [ ] **Step 9: Add the bot kinds to `eventText`, `applyWsEvent`, `events.ts` and `schema.ts`**

**9a.** `web/src/components/conversation/model.ts`: replace the whole `eventText` function, including its doc comment, with:

```ts
/** `names` maps sector and user ids to names (UUIDs never collide across tables). */
export function eventText(e: ChatEventDto, names: Map<string, string>): string {
  const name = (v: unknown) => (typeof v === 'string' ? names.get(v) : undefined);
  const by = e.authorName ? ` por ${e.authorName}` : '';
  const bot = String(e.data.botName ?? 'Chatbot');
  const viaBot = typeof e.data.botName === 'string' ? ` · Chatbot ${e.data.botName}` : ''; // privacy/close done by a bot
  switch (e.kind) {
    case 'created':
      return e.authorName ? `Conversa iniciada por ${e.authorName}` : 'Conversa iniciada pelo contato';
    case 'assigned':
      return `${e.authorName ?? 'Atendente'} assumiu a conversa`;
    case 'transferred': {
      const to = [name(e.data.toSectorId), name(e.data.toOwnerId)].filter(Boolean).join(' / ');
      return `Conversa transferida${by}${to ? ` para ${to}` : ''}`;
    }
    case 'privacy_changed':
      return `Conversa tornada ${e.data.private === true ? 'privada' : 'pública'}${by}${viaBot}`;
    case 'closed':
      return `Conversa finalizada${by}${viaBot}`;
    case 'reopened':
      return `Conversa reaberta${by}`;
    case 'triage_routed':
      return `Triagem: encaminhada para ${name(e.data.sectorId) ?? 'outro setor'}`;
    case 'bot_started':
      return `Chatbot ${bot} iniciado`;
    case 'bot_finished':
      return `Chatbot ${bot} finalizado`;
    case 'bot_stopped':
      return `Chatbot ${bot} parado${by}`;
    case 'bot_failed':
      return `Chatbot ${bot} falhou${typeof e.data.reason === 'string' && e.data.reason ? `: ${e.data.reason}` : ''}`;
    case 'bot_transferred': {
      const owner = e.data.toOwnerId ? ` · ${name(e.data.toOwnerId) ?? ''}` : '';
      return `Chatbot ${bot} transferiu para ${name(e.data.toSectorId) ?? 'outro setor'}${owner}`;
    }
    case 'bot_note':
      return `Nota do chatbot ${bot}: ${String(e.data.text ?? '')}`;
  }
}
```

**9b.** `web/src/lib/ws.ts`, at the end of the `switch` in `applyWsEvent`. Find:

```ts
    case 'channel.status': {
      const ch = ev.channel;
      qc.setQueryData<ChannelDto[]>(qk.channels, (list) =>
        list && (list.some((c) => c.id === ch.id) ? list.map((c) => (c.id === ch.id ? ch : c)) : [...list, ch]),
      );
      return;
    }
  }
}
```

Replace with:

```ts
    case 'channel.status': {
      const ch = ev.channel;
      qc.setQueryData<ChannelDto[]>(qk.channels, (list) =>
        list && (list.some((c) => c.id === ch.id) ? list.map((c) => (c.id === ch.id ? ch : c)) : [...list, ch]),
      );
      return;
    }
    case 'notification':
      return; // nothing to cache; the toasts (Task 16) subscribe through useWsEvent
  }
}
```

**9c.** `server/src/inbox/events.ts`. Find:

```ts
import type { Db, Tx } from '../db/client.js';
import { chatEvents } from '../db/schema.js';

export type ChatEventKind = 'created' | 'assigned' | 'transferred' | 'closed' | 'reopened' | 'privacy_changed' | 'triage_routed';
```

Replace with:

```ts
import type { ChatEventKind } from '@talk/shared';
import type { Db, Tx } from '../db/client.js';
import { chatEvents } from '../db/schema.js';

// One union for server and web (shared/src/index.ts); callers keep importing it from here.
export type { ChatEventKind };
```

**9d.** `server/src/db/schema.ts`. Find:

```ts
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
```

Replace with:

```ts
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import type { ChatEventKind } from '@talk/shared';
```

Then, in `chatEvents`, find:

```ts
    kind: text('kind')
      .$type<'created' | 'assigned' | 'transferred' | 'closed' | 'reopened' | 'privacy_changed' | 'triage_routed'>()
      .notNull(),
```

Replace with:

```ts
    kind: text('kind').$type<ChatEventKind>().notNull(),
```

- [ ] **Step 10: Run the web test, the typecheck and the full suites to verify they pass**

Run: `npm test -w web -- src/components/conversation/model.test.ts`
Expected: PASS, including the 2 tests in `eventText for chatbot events`.

Run: `npm run typecheck`
Expected: exit 0 for `shared`, `server` and `web`. The `server` typecheck includes `test/bots/catalog.test.ts`, so a block type missing from `OUTPUT_CASES` or `DEFAULTS` fails here.

Run: `npm test`
Expected: PASS. Every existing server and web test still passes, along with the 207 new catalog tests and the 2 new web tests.

Run: `git status --short`
Expected: exactly the 10 paths staged in Step 11. Nothing under `server/drizzle/` changes.

- [ ] **Step 11: Commit**

```bash
git add shared/src/bots.ts shared/src/index.ts server/src/db/schema.ts server/src/inbox/events.ts server/test/bots/catalog.test.ts web/src/components/conversation/model.ts web/src/components/conversation/model.test.ts web/src/lib/ws.ts web/package.json package-lock.json
git commit -m "feat(shared): catálogo de blocos do chatbot, eventos de bot e dependências do editor" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


---

### Task 2: Database migration and bot repository helpers

**Files:**
- Modify: `server/src/db/schema.ts` (type import after the `drizzle-orm/pg-core` import at line 16; `messages.botRunId` after `error: text('error'),` at line 196; three new tables appended at the end of the file, after `settings`)
- Create (generated, never hand-edited): `server/drizzle/0002_chatbot_fluxos.sql`, `server/drizzle/meta/0002_snapshot.json`; Modify (generated): `server/drizzle/meta/_journal.json`
- Create: `server/src/bots/repo.ts`
- Modify: `server/src/messages/dto.ts` (`toMessageDto` gains `botRunId` / `botName`)
- Test: `server/test/db/schema.test.ts` (17 → 20 tables, plus the bot constraint tests)
- Test: `server/test/bots/repo.test.ts` (create)
- Test: `server/test/messages/dto.test.ts:37-45` and `server/test/realtime/hub.test.ts:144-148` (the exact `MessageDto` literals gain `botRunId: null, botName: null`)

**Interfaces:**
- Consumes (Task 1, `@talk/shared`): types `BotGraph`, `BotRunState`, `BotRunVars`, `BotRunStep`, `BotDto`, `BotVersionSummaryDto`, `BotRunDto`; runtime `NON_TERMINAL_RUN_STATES: readonly BotRunState[]`. `MessageDto` already has the optional `botRunId?: string | null; botName?: string | null` (Task 1).
- Consumes (existing): `Db`, `Tx` from `server/src/db/client.ts`; `badRequest`, `conflict`, `notFound` from `server/src/lib/http-error.ts`; test helpers `makeTestCtx`, `makeTestDb`, `seedBasics`, `Seeded` (`server/test/helpers.ts`) and `newContact`, `insertChat`, `statusOf` (`server/test/inbox/fixtures.ts`).
- Produces (`server/src/db/schema.ts`): tables `bots`, `botVersions`, `botRuns` and column `messages.botRunId`, exactly as in contract §3.3. Migration `0002_chatbot_fluxos`.
- Produces (`server/src/bots/repo.ts`), contract §3.4 verbatim:
  ```ts
  export type BotRow = typeof bots.$inferSelect;
  export type BotVersionRow = typeof botVersions.$inferSelect;
  export type BotRunRow = typeof botRuns.$inferSelect;
  export async function toBotDto(db: Db | Tx, row: BotRow): Promise<BotDto>;
  export async function toBotDtos(db: Db | Tx, rows: BotRow[]): Promise<BotDto[]>;
  export async function toBotVersionSummaries(db: Db | Tx, bot: BotRow): Promise<BotVersionSummaryDto[]>; // number desc
  export async function toBotRunDto(db: Db | Tx, row: BotRunRow): Promise<BotRunDto>;
  export async function getBot(db: Db | Tx, id: string): Promise<BotRow>;                 // 404 'Chatbot não encontrado'
  export async function getVersionRow(db: Db | Tx, versionId: string): Promise<BotVersionRow | null>;
  export async function getVersionByNumber(db: Db | Tx, botId: string, n: number): Promise<BotVersionRow>; // 404 'Versão não encontrada'
  export async function latestVersion(db: Db | Tx, botId: string): Promise<BotVersionRow>;  // 404 'Versão não encontrada'
  export async function insertBotVersion(db: Db | Tx, input: { botId: string; graph: BotGraph; valid: boolean; createdBy: string | null; label?: string | null }): Promise<BotVersionRow>;
  export async function createBot(db: Db, input: { name: string; description?: string; graph: BotGraph; valid: boolean; publish: boolean;
    createdBy: string | null; startChannelIds?: string[]; manualStart?: boolean; manualTitle?: string }): Promise<BotRow>;
  export async function uniqueBotName(db: Db | Tx, base: string): Promise<string>;
  export async function findChannelBot(db: Db | Tx, channelId: string): Promise<BotRow | null>;
  export const STARTER_GRAPH: () => BotGraph;
  ```
  Additions owned by this task (new names, nothing in the contract renamed). Tasks 5, 9 and 11 should use them instead of writing their own:
  ```ts
  export type NewBotRun = typeof botRuns.$inferInsert;
  /** bot.publishedVersionId → its row, or null when unpublished. */
  export async function getPublishedVersion(db: Db | Tx, bot: Pick<BotRow, 'publishedVersionId'>): Promise<BotVersionRow | null>;
  /** INSERT … RETURNING; a 23505 (bot_runs_one_active_per_chat_bot) becomes 409 'Este chatbot já está em execução nesta conversa'. */
  export async function insertRun(db: Db | Tx, values: NewBotRun): Promise<BotRunRow>;
  export async function getRun(db: Db | Tx, id: string): Promise<BotRunRow | null>;
  /** SELECT … FOR UPDATE inside the caller's tx (engine rules 4 and 5); null when the run does not exist. */
  export async function lockRun(tx: Tx, id: string): Promise<BotRunRow | null>;
  ```
  `createBot` also maps a duplicate name (23505) to 409 `'Já existe um chatbot com esse nome'`, and `publish && !valid` to 400 `'O fluxo tem problemas'` before anything is inserted.
- Produces (`server/src/messages/dto.ts`): `toMessageDto` always fills `botRunId: row.botRunId` and `botName` (via `bot_runs` → `bots`, `null` when there is no run).

---

- [ ] **Step 1: Write the failing schema tests**

In `server/test/db/schema.test.ts`, replace the two import lines

```ts
import { is } from 'drizzle-orm';
```
```ts
import { chats, contacts, messages, sectors } from '../../src/db/schema.js';
```

with

```ts
import { eq, is } from 'drizzle-orm';
```
```ts
import { botRuns, botVersions, bots, chats, contacts, messages, sectors } from '../../src/db/schema.js';
```

change the table count in the first test from

```ts
    expect(tables).toHaveLength(17);
```

to

```ts
    expect(tables).toHaveLength(20);
```

and append this block at the end of the file, after the closing `});` of `describe('database schema', …)`:

```ts
describe('bot tables', () => {
  let db: Db;
  let s: Seeded;

  beforeEach(async () => {
    db = await makeTestDb();
    s = await seedBasics({ db });
  });

  async function seedBot(name: string) {
    const [bot] = await db.insert(bots).values({ name }).returning();
    const [version] = await db
      .insert(botVersions)
      .values({ botId: bot.id, number: 1, graph: { nodes: [], edges: [] }, valid: false })
      .returning();
    return { bot, version };
  }

  async function seedChat() {
    const [contact] = await db.insert(contacts).values({ phone: '5565999999999' }).returning();
    const [chat] = await db
      .insert(chats)
      .values({ contactId: contact.id, channelId: s.channelId, sectorId: s.defaultSector })
      .returning();
    return { chatId: chat.id, contactId: contact.id };
  }

  it('defaults a new bot to paused, unpublished, no channels and no runs', async () => {
    const { bot } = await seedBot('Fluxo');
    expect(bot).toMatchObject({
      description: '', status: 'paused', startChannelIds: [], manualStart: false, manualTitle: '',
      manualUnlisted: false, publishedVersionId: null, runCount: 0,
    });
  });

  it('rejects a duplicate bot name and a duplicate version number per bot', async () => {
    const { bot } = await seedBot('Fluxo');
    expect(await pgCode(db.insert(bots).values({ name: 'Fluxo' }))).toBe(UNIQUE_VIOLATION);

    const v = { botId: bot.id, graph: { nodes: [], edges: [] }, valid: true };
    expect(await pgCode(db.insert(botVersions).values({ ...v, number: 1 }))).toBe(UNIQUE_VIOLATION);
    expect(await pgCode(db.insert(botVersions).values({ ...v, number: 2 }))).toBeNull();

    const other = await seedBot('Outro');
    expect(other.version.number).toBe(1); // numbers are per bot
  });

  it('allows one non-terminal root run per (chat, bot), any number of terminal runs and call_flow children', async () => {
    const { bot, version } = await seedBot('Fluxo');
    const { chatId, contactId } = await seedChat();
    const base = { botId: bot.id, versionId: version.id, chatId, contactId, currentNodeId: 'inicio' };

    const [first] = await db.insert(botRuns).values({ ...base, state: 'waiting_reply' }).returning();
    expect(first).toMatchObject({ depth: 0, retries: 0, vars: {}, steps: [], waitingSince: null, parentRunId: null });

    for (const state of ['running', 'waiting_reply', 'waiting_timer', 'waiting_flow'] as const) {
      expect(await pgCode(db.insert(botRuns).values({ ...base, state }))).toBe(UNIQUE_VIOLATION);
    }
    for (const state of ['finished', 'stopped', 'failed'] as const) {
      expect(await pgCode(db.insert(botRuns).values({ ...base, state }))).toBeNull();
    }
    // a call_flow child of the same bot (depth 1) is not limited by the index
    expect(await pgCode(db.insert(botRuns).values({ ...base, depth: 1, parentRunId: first.id }))).toBeNull();

    const other = await seedBot('Outro');
    expect(await pgCode(db.insert(botRuns).values({ ...base, botId: other.bot.id, versionId: other.version.id }))).toBeNull();

    // once the first run is terminal, the bot may start again on the chat
    await db.update(botRuns).set({ state: 'finished', finishedAt: new Date() }).where(eq(botRuns.id, first.id));
    expect(await pgCode(db.insert(botRuns).values({ ...base, state: 'running' }))).toBeNull();
  });

  it('deleting a published bot removes its versions and runs and keeps its messages without the run', async () => {
    const { bot, version } = await seedBot('Fluxo');
    await db.update(bots).set({ publishedVersionId: version.id }).where(eq(bots.id, bot.id));
    const { chatId, contactId } = await seedChat();
    const [run] = await db
      .insert(botRuns)
      .values({ botId: bot.id, versionId: version.id, chatId, contactId, currentNodeId: 'inicio' })
      .returning();
    const [msg] = await db
      .insert(messages)
      .values({ chatId, channelId: s.channelId, direction: 'out', kind: 'text', body: 'Olá!', status: 'sent', botRunId: run.id, sentAt: new Date() })
      .returning();

    await db.delete(bots).where(eq(bots.id, bot.id));

    expect(await db.select().from(botVersions)).toEqual([]);
    expect(await db.select().from(botRuns)).toEqual([]);
    const [kept] = await db.select().from(messages).where(eq(messages.id, msg.id));
    expect(kept.botRunId).toBeNull();
  });
});
```

- [ ] **Step 2: Run the schema tests to verify they fail**

Run: `npm test -w server -- test/db/schema.test.ts`
Expected: FAIL. `expected [ …17 tables ] to have a length of 20`, and the `bot tables` tests fail because `bots`, `botVersions` and `botRuns` are not exported by `schema.ts` (drizzle throws on `insert(undefined)`).

- [ ] **Step 3: Add the tables and the column to the schema**

In `server/src/db/schema.ts`, directly after the line `} from 'drizzle-orm/pg-core';` (line 16), add:

```ts
import type { BotGraph, BotRunState, BotRunStep, BotRunVars } from '@talk/shared';
```

Inside the `messages` table definition, directly after `    error: text('error'),` (line 196), add:

```ts
    botRunId: uuid('bot_run_id').references((): AnyPgColumn => botRuns.id, { onDelete: 'set null' }), // set = sent by a chatbot
```

Append at the end of the file, after the `settings` table:

```ts
export const bots = pgTable('bots', {
  id: id(),
  name: text('name').notNull().unique(),
  description: text('description').notNull().default(''),
  status: text('status').$type<'active' | 'paused'>().notNull().default('paused'),
  startChannelIds: uuid('start_channel_ids').array().notNull().default(sql`'{}'::uuid[]`), // empty = never starts by channel
  manualStart: boolean('manual_start').notNull().default(false),
  manualTitle: text('manual_title').notNull().default(''),
  manualUnlisted: boolean('manual_unlisted').notNull().default(false),
  publishedVersionId: uuid('published_version_id').references((): AnyPgColumn => botVersions.id, { onDelete: 'set null' }),
  runCount: integer('run_count').notNull().default(0),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const botVersions = pgTable(
  'bot_versions',
  {
    id: id(),
    botId: uuid('bot_id').notNull().references(() => bots.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    graph: jsonb('graph').$type<BotGraph>().notNull(),
    valid: boolean('valid').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    label: text('label'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('bot_versions_bot_number_unique').on(t.botId, t.number)],
); // immutable: no code path UPDATEs a bot_versions row (test/bots/repo.test.ts scans src for it)

export const botRuns = pgTable(
  'bot_runs',
  {
    id: id(),
    botId: uuid('bot_id').notNull().references(() => bots.id, { onDelete: 'cascade' }),
    versionId: uuid('version_id').notNull().references(() => botVersions.id, { onDelete: 'cascade' }),
    chatId: uuid('chat_id').notNull().references(() => chats.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
    state: text('state').$type<BotRunState>().notNull().default('running'),
    currentNodeId: text('current_node_id').notNull(),
    waitNodeId: text('wait_node_id'),
    wakeAt: timestamp('wake_at', { withTimezone: true }),
    timeoutAt: timestamp('timeout_at', { withTimezone: true }),
    waitingSince: timestamp('waiting_since', { withTimezone: true }), // clock_timestamp() when entering waiting_reply (Review Focus 1)
    retries: integer('retries').notNull().default(0), // invalid attempts on the current ask node; reset on every node change
    vars: jsonb('vars').$type<BotRunVars>().notNull().default({}),
    steps: jsonb('steps').$type<BotRunStep[]>().notNull().default([]),
    depth: integer('depth').notNull().default(0),
    parentRunId: uuid('parent_run_id').references((): AnyPgColumn => botRuns.id, { onDelete: 'set null' }),
    startedBy: uuid('started_by').references(() => users.id, { onDelete: 'set null' }), // null = channel or call_flow
    error: text('error'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('bot_runs_state_wake_idx').on(t.state, t.wakeAt),
    index('bot_runs_state_timeout_idx').on(t.state, t.timeoutAt),
    index('bot_runs_chat_idx').on(t.chatId),
    // spec §3 "max 1 non-terminal run per (chat, bot)": root runs only, so call_flow may re-enter the same bot (depth limit applies).
    // Keep the state list in sync with NON_TERMINAL_RUN_STATES (shared/src/bots.ts).
    uniqueIndex('bot_runs_one_active_per_chat_bot')
      .on(t.chatId, t.botId)
      .where(sql`${t.state} in ('running','waiting_reply','waiting_timer','waiting_flow') and ${t.depth} = 0`),
  ],
);
```

- [ ] **Step 4: Generate the migration**

Run: `npm run db:generate -w server -- --name chatbot_fluxos`
Expected: drizzle-kit prints `[✓] Your SQL migration file ➜ drizzle\0002_chatbot_fluxos.sql 🚀` with no prompt (nothing is renamed). It writes `server/drizzle/0002_chatbot_fluxos.sql` and `server/drizzle/meta/0002_snapshot.json`, and appends an entry with `"idx": 2, "tag": "0002_chatbot_fluxos"` to `server/drizzle/meta/_journal.json`.

Then check the key statements:

Run: `grep -n "bot_runs_one_active_per_chat_bot\|bot_versions_bot_number_unique\|ADD COLUMN \"bot_run_id\"\|start_channel_ids\|bots_published_version_id_bot_versions_id_fk" server/drizzle/0002_chatbot_fluxos.sql`
Expected: five matching lines, including

```sql
"start_channel_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
ALTER TABLE "messages" ADD COLUMN "bot_run_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "bot_runs_one_active_per_chat_bot" ON "bot_runs" USING btree ("chat_id","bot_id") WHERE "bot_runs"."state" in ('running','waiting_reply','waiting_timer','waiting_flow') and "bot_runs"."depth" = 0;--> statement-breakpoint
CREATE UNIQUE INDEX "bot_versions_bot_number_unique" ON "bot_versions" USING btree ("bot_id","number");--> statement-breakpoint
```

and an `ALTER TABLE "bots" ADD CONSTRAINT "bots_published_version_id_bot_versions_id_fk" … ON DELETE set null` line. If any is missing, the schema edit in Step 3 is wrong: fix `schema.ts`, delete the three generated changes (`git checkout server/drizzle/meta/_journal.json` and remove the two new files) and generate again. Never hand-edit the SQL or the snapshot.

- [ ] **Step 5: Run the schema tests to verify they pass**

Run: `npm test -w server -- test/db/schema.test.ts`
Expected: PASS (8 tests). `createTestDb` applies `0002_chatbot_fluxos` automatically.

- [ ] **Step 6: Commit the schema**

```bash
git add server/src/db/schema.ts server/drizzle/0002_chatbot_fluxos.sql server/drizzle/meta/0002_snapshot.json server/drizzle/meta/_journal.json server/test/db/schema.test.ts
git commit -m "feat(server): tabelas bots, bot_versions e bot_runs e messages.bot_run_id

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Write the failing repository tests**

Create `server/test/bots/repo.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, inArray } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { BotGraph } from '@talk/shared';
import {
  STARTER_GRAPH,
  createBot,
  findChannelBot,
  getBot,
  getPublishedVersion,
  getRun,
  getVersionByNumber,
  getVersionRow,
  insertBotVersion,
  insertRun,
  latestVersion,
  lockRun,
  toBotDto,
  toBotDtos,
  toBotRunDto,
  toBotVersionSummaries,
  uniqueBotName,
  type BotRow,
  type NewBotRun,
} from '../../src/bots/repo.js';
import type { AppCtx } from '../../src/ctx.js';
import { botRuns, botVersions, bots, messages } from '../../src/db/schema.js';
import { toMessageDto } from '../../src/messages/dto.js';
import { makeTestCtx, seedBasics, type Seeded } from '../helpers.js';
import { insertChat, newContact, statusOf } from '../inbox/fixtures.js';

let ctx: AppCtx;
let s: Seeded;
let chatId: string;
let contactId: string;

beforeEach(async () => {
  ctx = await makeTestCtx();
  s = await seedBasics(ctx);
  contactId = await newContact(ctx);
  chatId = await insertChat(ctx, { channelId: s.channelId, sectorId: s.defaultSector, contactId });
});

const manualGraph = (): BotGraph => ({
  nodes: [{ id: 'm', type: 'start_manual', name: 'manual', position: { x: 0, y: 0 }, config: {} }],
  edges: [],
});

/** Published, valid, paused bot with the starter graph unless overridden. */
function newBot(name: string, over: Partial<Parameters<typeof createBot>[1]> = {}): Promise<BotRow> {
  return createBot(ctx.db, { name, graph: STARTER_GRAPH(), valid: true, publish: true, createdBy: s.admin.id, ...over });
}

function newRun(bot: BotRow, over: Partial<NewBotRun> = {}) {
  return insertRun(ctx.db, { botId: bot.id, versionId: bot.publishedVersionId!, chatId, contactId, currentNodeId: 'inicio', ...over });
}

describe('STARTER_GRAPH', () => {
  it('is a fresh start_channel → send_message "Olá!" graph on every call', () => {
    const g = STARTER_GRAPH();
    expect(g.nodes.map((n) => [n.id, n.type, n.name])).toEqual([
      ['inicio', 'start_channel', 'inicio'],
      ['mensagem', 'send_message', 'mensagem'],
    ]);
    expect(g.nodes[1].config).toEqual({ text: 'Olá!', attachment: null, signature: false });
    expect(g.edges).toEqual([{ id: 'e-inicio-next', source: 'inicio', sourceHandle: 'next', target: 'mensagem' }]);
    expect(STARTER_GRAPH()).not.toBe(g);
  });
});

describe('createBot', () => {
  it('inserts version 1 and publishes it only when asked', async () => {
    const draft = await newBot('Rascunho', { publish: false, valid: false });
    expect(draft).toMatchObject({ name: 'Rascunho', status: 'paused', publishedVersionId: null, startChannelIds: [], manualStart: false, runCount: 0 });
    expect(await latestVersion(ctx.db, draft.id)).toMatchObject({ number: 1, valid: false, createdBy: s.admin.id, label: null });
    expect(await getPublishedVersion(ctx.db, draft)).toBeNull();

    const pub = await newBot('Publicado', { description: 'Menu', startChannelIds: [s.channelId], manualStart: true, manualTitle: 'Atendimento' });
    expect(pub).toMatchObject({ description: 'Menu', startChannelIds: [s.channelId], manualStart: true, manualTitle: 'Atendimento' });
    const published = await getPublishedVersion(ctx.db, pub);
    expect(published).toMatchObject({ id: pub.publishedVersionId, botId: pub.id, number: 1, valid: true });
    expect(published!.graph).toEqual(STARTER_GRAPH());
    expect(await getBot(ctx.db, pub.id)).toEqual(pub);
  });

  it('refuses to publish an invalid graph and rejects a duplicate name, inserting nothing', async () => {
    expect(await statusOf(newBot('Ruim', { valid: false }))).toBe(400);
    expect(await ctx.db.select().from(bots)).toEqual([]);

    await newBot('Fluxo');
    expect(await statusOf(newBot('Fluxo'))).toBe(409);
    expect(await ctx.db.select().from(bots)).toHaveLength(1);
    expect(await ctx.db.select().from(botVersions)).toHaveLength(1);
  });
});

describe('versions', () => {
  it('numbers versions per bot, also inside a transaction', async () => {
    const a = await newBot('A');
    const b = await newBot('B');

    const v2 = await insertBotVersion(ctx.db, { botId: a.id, graph: manualGraph(), valid: true, createdBy: null, label: 'Ajuste' });
    expect(v2).toMatchObject({ botId: a.id, number: 2, label: 'Ajuste', createdBy: null, valid: true });
    expect(v2.graph).toEqual(manualGraph());

    const v3 = await ctx.db.transaction((tx) =>
      insertBotVersion(tx, { botId: a.id, graph: manualGraph(), valid: false, createdBy: s.admin.id }),
    );
    expect(v3.number).toBe(3);
    expect((await insertBotVersion(ctx.db, { botId: b.id, graph: manualGraph(), valid: true, createdBy: null })).number).toBe(2);

    expect((await latestVersion(ctx.db, a.id)).id).toBe(v3.id);
    expect((await getVersionByNumber(ctx.db, a.id, 2)).id).toBe(v2.id);
    expect(await getVersionRow(ctx.db, v2.id)).toEqual(v2);
    expect(await getVersionRow(ctx.db, randomUUID())).toBeNull();
    expect(await statusOf(getVersionByNumber(ctx.db, a.id, 9))).toBe(404);
    expect(await statusOf(latestVersion(ctx.db, randomUUID()))).toBe(404);
    expect(await statusOf(getBot(ctx.db, randomUUID()))).toBe(404);
  });

  it('never updates a bot_versions row anywhere in server/src (versions are immutable)', async () => {
    const srcDir = fileURLToPath(new URL('../../src', import.meta.url));
    const files = (await readdir(srcDir, { recursive: true })).filter((f) => f.endsWith('.ts'));
    const offenders: string[] = [];
    for (const f of files) {
      const text = await readFile(join(srcDir, f), 'utf8');
      if (/\.update\(\s*botVersions\b/.test(text) || /update\s+"?bot_versions\b/i.test(text)) offenders.push(f);
    }
    expect(files.length).toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });
});

describe('uniqueBotName', () => {
  it('returns the base when free, else the first free " (n)" suffix', async () => {
    expect(await uniqueBotName(ctx.db, 'Fluxo')).toBe('Fluxo');
    await newBot('Fluxo');
    expect(await uniqueBotName(ctx.db, 'Fluxo')).toBe('Fluxo (2)');
    await newBot('Fluxo (2)');
    expect(await uniqueBotName(ctx.db, 'Fluxo')).toBe('Fluxo (3)');
  });
});

describe('findChannelBot', () => {
  it('picks the oldest active bot whose published graph starts on that channel', async () => {
    expect(await findChannelBot(ctx.db, s.channelId)).toBeNull();

    await newBot('Pausado', { startChannelIds: [s.channelId] }); // stays paused
    const draft = await newBot('Rascunho', { startChannelIds: [s.channelId], publish: false });
    const manualOnly = await newBot('Manual', { startChannelIds: [s.channelId], graph: manualGraph() });
    const noChannel = await newBot('Sem canal');
    const newer = await newBot('Novo', { startChannelIds: [s.channelId] });
    const older = await newBot('Antigo', { startChannelIds: [randomUUID(), s.channelId] });
    await ctx.db
      .update(bots)
      .set({ status: 'active' })
      .where(inArray(bots.id, [draft.id, manualOnly.id, noChannel.id, newer.id, older.id]));
    await ctx.db.update(bots).set({ createdAt: new Date('2026-01-01T00:00:00Z') }).where(eq(bots.id, older.id));

    expect((await findChannelBot(ctx.db, s.channelId))?.id).toBe(older.id);

    await ctx.db.update(bots).set({ status: 'paused' }).where(eq(bots.id, older.id));
    expect((await findChannelBot(ctx.db, s.channelId))?.id).toBe(newer.id);
    expect(await findChannelBot(ctx.db, randomUUID())).toBeNull();
  });
});

describe('runs', () => {
  it('insertRun stores defaults and turns a second active root run of the same bot on the chat into 409', async () => {
    const bot = await newBot('Fluxo');
    const run = await newRun(bot);
    expect(run).toMatchObject({
      botId: bot.id, versionId: bot.publishedVersionId, chatId, contactId, state: 'running', currentNodeId: 'inicio',
      depth: 0, retries: 0, vars: {}, steps: [], parentRunId: null, waitingSince: null, wakeAt: null, timeoutAt: null, finishedAt: null,
    });

    expect(await statusOf(newRun(bot, { state: 'waiting_reply' }))).toBe(409);
    const child = await newRun(bot, { depth: 1, parentRunId: run.id });
    expect(child.parentRunId).toBe(run.id);
  });

  it('getRun reads a run and lockRun returns it under FOR UPDATE inside a transaction', async () => {
    const bot = await newBot('Fluxo');
    const run = await newRun(bot);
    expect(await getRun(ctx.db, run.id)).toEqual(run);
    expect(await getRun(ctx.db, randomUUID())).toBeNull();

    const locked = await ctx.db.transaction(async (tx) => {
      const row = await lockRun(tx, run.id);
      await tx.update(botRuns).set({ state: 'waiting_reply' }).where(eq(botRuns.id, run.id));
      return row;
    });
    expect(locked?.state).toBe('running');
    expect((await getRun(ctx.db, run.id))?.state).toBe('waiting_reply');
    expect(await ctx.db.transaction((tx) => lockRun(tx, randomUUID()))).toBeNull();
  });
});

describe('DTOs', () => {
  it('toBotDtos aggregates published and latest version numbers and active runs', async () => {
    const a = await newBot('A', { startChannelIds: [s.channelId] });
    await insertBotVersion(ctx.db, { botId: a.id, graph: STARTER_GRAPH(), valid: false, createdBy: null });
    await ctx.db.update(bots).set({ runCount: 3 }).where(eq(bots.id, a.id));
    await newRun(a, { state: 'waiting_reply' });
    await newRun(a, { state: 'finished', finishedAt: new Date() });
    const b = await newBot('B', { publish: false });
    const aRow = await getBot(ctx.db, a.id);

    const [dtoA, dtoB] = await toBotDtos(ctx.db, [aRow, b]);

    expect(dtoA).toEqual({
      id: a.id, name: 'A', description: '', status: 'paused', startChannelIds: [s.channelId],
      manualStart: false, manualTitle: '', manualUnlisted: false,
      publishedVersionId: a.publishedVersionId, publishedVersionNumber: 1, latestVersionNumber: 2,
      runCount: 3, activeRunCount: 1,
      createdAt: aRow.createdAt.toISOString(), updatedAt: aRow.updatedAt.toISOString(),
    });
    expect(dtoB).toMatchObject({ id: b.id, publishedVersionId: null, publishedVersionNumber: null, latestVersionNumber: 1, runCount: 0, activeRunCount: 0 });
    expect(await toBotDto(ctx.db, b)).toEqual(dtoB);
    expect(await toBotDtos(ctx.db, [])).toEqual([]);
  });

  it('toBotVersionSummaries lists newest first with author name and published flag', async () => {
    const bot = await newBot('Fluxo');
    const v2 = await insertBotVersion(ctx.db, { botId: bot.id, graph: STARTER_GRAPH(), valid: false, createdBy: null, label: 'Teste' });

    const list = await toBotVersionSummaries(ctx.db, bot);

    expect(list).toEqual([
      { id: v2.id, botId: bot.id, number: 2, valid: false, label: 'Teste', createdByName: null, createdAt: v2.createdAt.toISOString(), published: false },
      expect.objectContaining({ id: bot.publishedVersionId, number: 1, valid: true, label: null, createdByName: 'Admin Teste', published: true }),
    ]);
  });

  it('toBotRunDto names the bot and the user who started it', async () => {
    const bot = await newBot('Fluxo');
    const run = await newRun(bot, { startedBy: s.agentA.id });

    expect(await toBotRunDto(ctx.db, run)).toEqual({
      id: run.id, botId: bot.id, botName: 'Fluxo', chatId, state: 'running', currentNodeId: 'inicio', depth: 0,
      startedByName: 'Ana Financeiro', error: null,
      createdAt: run.createdAt.toISOString(), updatedAt: run.updatedAt.toISOString(), finishedAt: null,
    });
    const byChannel = await newRun(bot, { depth: 1 });
    expect((await toBotRunDto(ctx.db, byChannel)).startedByName).toBeNull();
  });

  it('toMessageDto carries the bot run and the bot name', async () => {
    const bot = await newBot('Fluxo');
    const run = await newRun(bot);
    const base = { chatId, channelId: s.channelId, direction: 'out' as const, kind: 'text' as const, status: 'sent' as const, sentAt: new Date() };
    const [byBot] = await ctx.db.insert(messages).values({ ...base, body: 'Olá!', botRunId: run.id }).returning();
    const [byPhone] = await ctx.db.insert(messages).values({ ...base, body: 'Oi' }).returning();

    expect(await toMessageDto(ctx.db, byBot)).toMatchObject({ botRunId: run.id, botName: 'Fluxo', authorId: null, authorName: null });
    expect(await toMessageDto(ctx.db, byPhone)).toMatchObject({ botRunId: null, botName: null });
  });
});
```

In `server/test/messages/dto.test.ts`, the exact literal of the first test (line 41) changes from

```ts
      authorId: s.agentA.id, authorName: s.agentA.name, authorAvatarUrl: null,
```

to

```ts
      authorId: s.agentA.id, authorName: s.agentA.name, authorAvatarUrl: null, botRunId: null, botName: null,
```

In `server/test/realtime/hub.test.ts`, the `message` literal (line 146) changes from

```ts
      media: null, mediaUnavailable: false, authorId: s.agentA.id, authorName: s.agentA.name, authorAvatarUrl: null,
```

to

```ts
      media: null, mediaUnavailable: false, authorId: s.agentA.id, authorName: s.agentA.name, authorAvatarUrl: null, botRunId: null, botName: null,
```

- [ ] **Step 8: Run the tests to verify they fail**

Run: `npm test -w server -- test/bots/repo.test.ts test/messages/dto.test.ts test/realtime/hub.test.ts`
Expected: FAIL. `repo.test.ts` fails to load with `Failed to load url ../../src/bots/repo.js` (the file does not exist). The `toMessageDto` test in `dto.test.ts` and the `message.created` test in `hub.test.ts` fail on `toEqual` because `botRunId` and `botName` are missing from the DTO.

- [ ] **Step 9: Write the repository**

Create `server/src/bots/repo.ts`:

```ts
import { and, asc, count, desc, eq, inArray, max, sql } from 'drizzle-orm';
import { NON_TERMINAL_RUN_STATES } from '@talk/shared';
import type { BotDto, BotGraph, BotRunDto, BotVersionSummaryDto } from '@talk/shared';
import type { Db, Tx } from '../db/client.js';
import { botRuns, botVersions, bots, users } from '../db/schema.js';
import { badRequest, conflict, notFound } from '../lib/http-error.js';

export type BotRow = typeof bots.$inferSelect;
export type BotVersionRow = typeof botVersions.$inferSelect;
export type BotRunRow = typeof botRuns.$inferSelect;
export type NewBotRun = typeof botRuns.$inferInsert;

// drizzle wraps the driver error, so the SQLSTATE may sit on `cause` (same check as markSent in messages/send.ts).
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return (e?.code ?? e?.cause?.code) === '23505';
}

/** Version 1 of a bot created from the list page: start by channel → "Olá!". */
export const STARTER_GRAPH = (): BotGraph => ({
  nodes: [
    { id: 'inicio', type: 'start_channel', name: 'inicio', position: { x: 0, y: 0 }, config: {} },
    {
      id: 'mensagem',
      type: 'send_message',
      name: 'mensagem',
      position: { x: 360, y: 0 },
      config: { text: 'Olá!', attachment: null, signature: false },
    },
  ],
  edges: [{ id: 'e-inicio-next', source: 'inicio', sourceHandle: 'next', target: 'mensagem' }],
});

// ---------- bots ----------

export async function getBot(db: Db | Tx, id: string): Promise<BotRow> {
  const [row] = await db.select().from(bots).where(eq(bots.id, id));
  if (!row) throw notFound('Chatbot não encontrado');
  return row;
}

/** base if free, else `${base} (2)`, `${base} (3)`… */
export async function uniqueBotName(db: Db | Tx, base: string): Promise<string> {
  // ponytail: reads every bot name; an office has dozens of bots, not thousands.
  const taken = new Set((await db.select({ name: bots.name }).from(bots)).map((r) => r.name));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const name = `${base} (${n})`;
    if (!taken.has(name)) return name;
  }
}

/** One tx: insert bot (name must already be unique) + version 1; publish=true also sets publishedVersionId (requires valid). */
export async function createBot(
  db: Db,
  input: {
    name: string;
    description?: string;
    graph: BotGraph;
    valid: boolean;
    publish: boolean;
    createdBy: string | null;
    startChannelIds?: string[];
    manualStart?: boolean;
    manualTitle?: string;
  },
): Promise<BotRow> {
  if (input.publish && !input.valid) throw badRequest('O fluxo tem problemas');
  try {
    return await db.transaction(async (tx) => {
      const [bot] = await tx
        .insert(bots)
        .values({
          name: input.name,
          description: input.description ?? '',
          startChannelIds: input.startChannelIds ?? [],
          manualStart: input.manualStart ?? false,
          manualTitle: input.manualTitle ?? '',
        })
        .returning();
      const version = await insertBotVersion(tx, { botId: bot.id, graph: input.graph, valid: input.valid, createdBy: input.createdBy });
      if (!input.publish) return bot;
      const [published] = await tx.update(bots).set({ publishedVersionId: version.id }).where(eq(bots.id, bot.id)).returning();
      return published;
    });
  } catch (err) {
    // the only unique constraint a brand-new bot can hit is bots.name
    if (isUniqueViolation(err)) throw conflict('Já existe um chatbot com esse nome');
    throw err;
  }
}

/** Oldest (created_at) active bot with a published version whose start_channel_ids contains channelId and whose published graph has a start_channel node. */
export async function findChannelBot(db: Db | Tx, channelId: string): Promise<BotRow | null> {
  const rows = await db
    .select({ bot: bots, graph: botVersions.graph })
    .from(bots)
    .innerJoin(botVersions, eq(botVersions.id, bots.publishedVersionId))
    .where(and(eq(bots.status, 'active'), sql`${channelId}::uuid = any(${bots.startChannelIds})`))
    .orderBy(asc(bots.createdAt), asc(bots.id));
  return rows.find((r) => r.graph.nodes.some((n) => n.type === 'start_channel'))?.bot ?? null;
}

// ---------- versions (immutable: insert and select only) ----------

export async function getVersionRow(db: Db | Tx, versionId: string): Promise<BotVersionRow | null> {
  const [row] = await db.select().from(botVersions).where(eq(botVersions.id, versionId));
  return row ?? null;
}

export async function getPublishedVersion(db: Db | Tx, bot: Pick<BotRow, 'publishedVersionId'>): Promise<BotVersionRow | null> {
  return bot.publishedVersionId ? getVersionRow(db, bot.publishedVersionId) : null;
}

export async function getVersionByNumber(db: Db | Tx, botId: string, n: number): Promise<BotVersionRow> {
  const [row] = await db
    .select()
    .from(botVersions)
    .where(and(eq(botVersions.botId, botId), eq(botVersions.number, n)));
  if (!row) throw notFound('Versão não encontrada');
  return row;
}

export async function latestVersion(db: Db | Tx, botId: string): Promise<BotVersionRow> {
  const [row] = await db.select().from(botVersions).where(eq(botVersions.botId, botId)).orderBy(desc(botVersions.number)).limit(1);
  if (!row) throw notFound('Versão não encontrada');
  return row;
}

/** number = coalesce(max(number),0)+1 for the bot; one retry on unique violation 23505. */
export async function insertBotVersion(
  db: Db | Tx,
  input: { botId: string; graph: BotGraph; valid: boolean; createdBy: string | null; label?: string | null },
): Promise<BotVersionRow> {
  // A real tx on Db, a savepoint inside a caller's tx: a 23505 rolls back only this insert, so the retry can run.
  const attempt = () =>
    (db as Db).transaction(async (t) => {
      const [row] = await t
        .insert(botVersions)
        .values({
          botId: input.botId,
          number: sql<number>`(select coalesce(max("number"), 0) + 1 from "bot_versions" where "bot_id" = ${input.botId})`,
          graph: input.graph,
          valid: input.valid,
          createdBy: input.createdBy,
          label: input.label ?? null,
        })
        .returning();
      return row;
    });
  try {
    return await attempt();
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // ponytail: one retry covers two saves of the same bot racing for the same number; a third concurrent save gets the error.
    return attempt();
  }
}

// ---------- runs ----------

export async function insertRun(db: Db | Tx, values: NewBotRun): Promise<BotRunRow> {
  try {
    const [row] = await db.insert(botRuns).values(values).returning();
    return row;
  } catch (err) {
    // the only unique constraint on bot_runs besides the random id is bot_runs_one_active_per_chat_bot
    if (isUniqueViolation(err)) throw conflict('Este chatbot já está em execução nesta conversa');
    throw err;
  }
}

export async function getRun(db: Db | Tx, id: string): Promise<BotRunRow | null> {
  const [row] = await db.select().from(botRuns).where(eq(botRuns.id, id));
  return row ?? null;
}

/** SELECT … FOR UPDATE: call inside the tx that re-checks and changes the run's state. */
export async function lockRun(tx: Tx, id: string): Promise<BotRunRow | null> {
  const [row] = await tx.select().from(botRuns).where(eq(botRuns.id, id)).for('update');
  return row ?? null;
}

// ---------- DTOs ----------

/** One query per aggregate, not per row. */
export async function toBotDtos(db: Db | Tx, rows: BotRow[]): Promise<BotDto[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const publishedIds = rows.flatMap((r) => (r.publishedVersionId ? [r.publishedVersionId] : []));

  const latest = await db
    .select({ botId: botVersions.botId, n: max(botVersions.number) })
    .from(botVersions)
    .where(inArray(botVersions.botId, ids))
    .groupBy(botVersions.botId);
  const published = publishedIds.length
    ? await db.select({ id: botVersions.id, n: botVersions.number }).from(botVersions).where(inArray(botVersions.id, publishedIds))
    : [];
  const active = await db
    .select({ botId: botRuns.botId, n: count() })
    .from(botRuns)
    .where(and(inArray(botRuns.botId, ids), inArray(botRuns.state, [...NON_TERMINAL_RUN_STATES])))
    .groupBy(botRuns.botId);

  const latestBy = new Map(latest.map((r) => [r.botId, r.n ?? 0]));
  const publishedBy = new Map(published.map((r) => [r.id, r.n]));
  const activeBy = new Map(active.map((r) => [r.botId, r.n]));

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    status: r.status,
    startChannelIds: r.startChannelIds,
    manualStart: r.manualStart,
    manualTitle: r.manualTitle,
    manualUnlisted: r.manualUnlisted,
    publishedVersionId: r.publishedVersionId,
    publishedVersionNumber: r.publishedVersionId ? (publishedBy.get(r.publishedVersionId) ?? null) : null,
    latestVersionNumber: latestBy.get(r.id) ?? 0,
    runCount: r.runCount,
    activeRunCount: activeBy.get(r.id) ?? 0,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

export async function toBotDto(db: Db | Tx, row: BotRow): Promise<BotDto> {
  const [dto] = await toBotDtos(db, [row]);
  return dto;
}

/** number desc; the graph is not loaded (see BotVersionDto for that). */
export async function toBotVersionSummaries(db: Db | Tx, bot: BotRow): Promise<BotVersionSummaryDto[]> {
  const rows = await db
    .select({
      id: botVersions.id,
      botId: botVersions.botId,
      number: botVersions.number,
      valid: botVersions.valid,
      label: botVersions.label,
      createdByName: users.name,
      createdAt: botVersions.createdAt,
    })
    .from(botVersions)
    .leftJoin(users, eq(users.id, botVersions.createdBy))
    .where(eq(botVersions.botId, bot.id))
    .orderBy(desc(botVersions.number));
  return rows.map((v) => ({ ...v, createdAt: v.createdAt.toISOString(), published: v.id === bot.publishedVersionId }));
}

export async function toBotRunDto(db: Db | Tx, row: BotRunRow): Promise<BotRunDto> {
  const [bot] = await db.select({ name: bots.name }).from(bots).where(eq(bots.id, row.botId));
  const [starter] = row.startedBy ? await db.select({ name: users.name }).from(users).where(eq(users.id, row.startedBy)) : [];
  return {
    id: row.id,
    botId: row.botId,
    botName: bot?.name ?? '',
    chatId: row.chatId,
    state: row.state,
    currentNodeId: row.currentNodeId,
    depth: row.depth,
    startedByName: starter?.name ?? null,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}
```

- [ ] **Step 10: Add the bot fields to `toMessageDto`**

In `server/src/messages/dto.ts`, change the schema import from

```ts
import { messages, users } from '../db/schema.js';
```

to

```ts
import { botRuns, bots, messages, users } from '../db/schema.js';
```

In `toMessageDto`, directly after the `const [reply] = …;` statement, add:

```ts
  const [bot] = row.botRunId
    ? await db.select({ name: bots.name }).from(botRuns).innerJoin(bots, eq(bots.id, botRuns.botId)).where(eq(botRuns.id, row.botRunId))
    : [];
```

and in the returned object, directly after `    sentAt: row.sentAt.toISOString(),`, add:

```ts
    botRunId: row.botRunId,
    botName: bot?.name ?? null,
```

- [ ] **Step 11: Run the tests to verify they pass**

Run: `npm test -w server -- test/bots/repo.test.ts test/messages/dto.test.ts test/realtime/hub.test.ts test/db/schema.test.ts`
Expected: PASS (all four files).

Then run the whole server suite and the type check, because every `MessageDto` now carries two more keys:

Run: `npm test -w server`
Expected: PASS. If another test compares a full `MessageDto` with `toEqual`, add `botRunId: null, botName: null` to its literal; do not change `toMessageDto`.

Run: `npm run typecheck -w server`
Expected: exit 0, no errors.

- [ ] **Step 12: Commit the repository**

```bash
git add server/src/bots/repo.ts server/src/messages/dto.ts server/test/bots/repo.test.ts server/test/messages/dto.test.ts server/test/realtime/hub.test.ts
git commit -m "feat(server): repositório dos chatbots (versões, execuções e DTOs) e botName nas mensagens

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


---

### Task 3: Graph validation and input validators

Two pure modules the engine (Task 5), the blocks (Tasks 6–8) and the REST API (Task 11) rely on:
- `server/src/bots/validators.ts` checks a contact's answer to `ask_input`: CPF and CNPJ with check digits (CNPJ also in the alphanumeric format the Receita Federal issues from July 2026), e-mail (zod's `z.email()`, already installed), BR phone via the existing `normalizePhoneBR`, user regex compiled safely, and the media type mapping.
- `server/src/bots/graph.ts` validates a whole `BotGraph` (structure plus per-type config) against the ids that exist in the database, and finds the start node for an entry.

Both are table-tested. Only `loadGraphCatalog` touches the database (PGlite via `makeTestCtx`).

**Files:**
- Create: `server/src/bots/validators.ts`
- Create: `server/src/bots/graph.ts`
- Test: `server/test/bots/validators.test.ts`
- Test: `server/test/bots/graph.test.ts`

**Interfaces:**
- Consumes:
  - Task 1 (`@talk/shared`): runtime `BLOCK_TYPES`, `WEEKDAYS`, `NATIVE_CONTACT_FIELDS`, `RULE_OPERATOR_LABELS`, `catalogEntry(type: BlockType): BlockCatalogEntry`, `outputsOf(type: BlockType, config: Record<string, unknown>): BlockOutput[]`; types `BlockType`, `BotGraph`, `BotNode`, `BotEdge`, `GraphProblem`, `AskInputConfig`, `MediaType`.
  - Task 2: the `bots` table in `server/src/db/schema.ts` (every column except `name` has a default).
  - Existing:
    - `normalizePhoneBR(raw: string): string` (`server/src/whatsapp/phone.ts`)
    - `baseMime(mime: string): string` (`server/src/messages/media.ts`)
    - `MessageKind` (`server/src/whatsapp/types.ts`)
    - `Db` / `Tx` (`server/src/db/client.ts`)
    - the tables `sectors`, `users`, `tags`, `customFields` and `channels`
    - the test helpers `makeTestCtx` and `seedBasics`
- Produces (exactly as in contract §3.5, plus `validateNodeConfig`):
  ```ts
  // server/src/bots/validators.ts
  export interface AnswerInput { body: string | null; kind: MessageKind; mediaMime: string | null; mediaName: string | null }
  export type AnswerResult = { ok: true; raw: string; value: string } | { ok: false };
  export function validateAnswer(cfg: Pick<AskInputConfig, 'validator' | 'mediaTypes' | 'regex'>, input: AnswerInput): AnswerResult;
  export function isValidCpf(s: string): boolean;   export function formatCpf(s: string): string;   // '000.000.000-00'
  export function isValidCnpj(s: string): boolean;  export function formatCnpj(s: string): string;  // '00.000.000/0000-00', uppercase
  export function isValidEmail(s: string): boolean;
  export function parsePhoneBR(s: string): string | null;           // canonical 12/13 digits, else null
  export function compileUserRegex(pattern: string): RegExp | null; // null if empty, > 200 chars or invalid; flags 'u'
  export function mediaTypeOf(mime: string | null): MediaType | null;

  // server/src/bots/graph.ts
  export interface GraphCatalog { selfBotId: string | null; sectorIds: Set<string>; activeUserIds: Set<string>; tagIds: Set<string>;
    customFieldIds: Set<string>; channelIds: Set<string>; botIds: Set<string> }
  export async function loadGraphCatalog(db: Db | Tx, selfBotId: string | null): Promise<GraphCatalog>;
  export function validateGraph(graph: BotGraph, catalog: GraphCatalog): GraphProblem[];   // [] = valid; never throws
  export function validateNodeConfig(node: BotNode, catalog: GraphCatalog): string[];       // per-type pt-BR messages
  export function isFieldRef(id: string, catalog: GraphCatalog): boolean;
  export function startNodeOf(graph: BotGraph, entry: 'channel' | 'manual' | 'call'): BotNode | null;
  ```

**Behavior this task pins down (later tasks rely on it):**
- `validateAnswer`:
  - `any` accepts every message. For text, `raw = value = body.trim()`. For anything else, `raw = ''` and `value = mediaName ?? kind`. This covers Review Focus 4: an audio, a sticker or `body = null` never throws.
  - `media` accepts only the kinds `image`, `audio`, `video`, `document` and `sticker`, so `text` and `unsupported` fail. A non-empty `mediaTypes` also requires `mediaTypeOf(mediaMime)` to be in the list.
  - The text validators (`email`, `phone`, `cpf`, `cnpj`, `regex`) fail on `body === null` and work on `raw = body.trim()`. Values are normalized: `cpf` and `cnpj` are formatted, `phone` is canonical and `email` is lowercased.
  - `regex` fails on answers longer than 1000 chars instead of truncating them.
- CPF and CNPJ drop only formatting (spaces, `.`, `-`, `/`). Any other character, such as the words in "meu cpf é …", makes the answer invalid. Numbers made of one repeated digit are rejected.
- `parsePhoneBR` checks the output of `normalizePhoneBR` against `/^55[1-9]{2}(?:9\d{8}|[2-5]\d{7})$/`. That means a real DDD followed by either a mobile (`9` plus 8 digits) or a landline starting with 2–5.
- `validateGraph` reports problems in a fixed order: duplicate ids, starts, names, configs, edges, then missing connections. Each edge reports at most one problem. Only edges that pass every check count as an input or as "start connected".
- A `send_message` attachment path must be `bots/<uuid>.<ext>`, which is exactly what Task 11's `saveMedia(…, 'bots')` writes. This stops an imported graph from pointing the sender at a `../` path.
- A `var` operand is `name` or `name:raw`, the two forms `operandValue` (Task 6) reads.
- The `call_flow` self-call check runs only when `selfBotId` is set. It is `null` for a bot that does not exist yet, as on import.

- [ ] **Step 1: Write the failing validator tests**

Create `server/test/bots/validators.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { AskInputConfig } from '@talk/shared';
import {
  compileUserRegex,
  formatCnpj,
  formatCpf,
  isValidCnpj,
  isValidCpf,
  isValidEmail,
  mediaTypeOf,
  parsePhoneBR,
  validateAnswer,
  type AnswerInput,
  type AnswerResult,
} from '../../src/bots/validators.js';

describe('isValidCpf / formatCpf', () => {
  const cases: Array<[input: string, valid: boolean]> = [
    ['529.982.247-25', true],
    ['52998224725', true],
    [' 529 982 247 25 ', true],
    ['111.444.777-35', true],
    ['000.000.001-91', true], // leading zeros
    ['529.982.247-24', false], // second check digit wrong
    ['529.982.247-15', false], // first check digit wrong
    ['111.111.111-11', false], // repeated digits pass the math but are not real
    ['000.000.000-00', false],
    ['5299822472', false], // 10 digits
    ['529982247250', false], // 12 digits
    ['529.982.247-2a', false],
    ['meu cpf 529.982.247-25', false], // other words are not stripped
    ['', false],
  ];
  it.each(cases)('isValidCpf(%j) = %s', (input, valid) => {
    expect(isValidCpf(input)).toBe(valid);
  });

  it('formats with dots and dash', () => {
    expect(formatCpf('52998224725')).toBe('529.982.247-25');
    expect(formatCpf(' 529 982 247 25 ')).toBe('529.982.247-25');
  });
});

describe('isValidCnpj / formatCnpj', () => {
  const cases: Array<[input: string, valid: boolean]> = [
    ['11.222.333/0001-81', true],
    ['11222333000181', true],
    ['00.000.000/0001-91', true],
    ['12.ABC.345/01DE-35', true], // alphanumeric CNPJ (Receita Federal, July 2026)
    ['12abc34501de35', true], // lowercase is accepted
    ['11.222.333/0001-80', false],
    ['11.222.333/0001-91', false],
    ['12.ABC.345/01DE-36', false],
    ['12.ABC.345/01DE-3A', false], // check digits are always numeric
    ['00.000.000/0000-00', false],
    ['11.111.111/1111-11', false],
    ['1122233300018', false], // 13 chars
    ['11.222.333/0001-81 ok', false],
    ['', false],
  ];
  it.each(cases)('isValidCnpj(%j) = %s', (input, valid) => {
    expect(isValidCnpj(input)).toBe(valid);
  });

  it('formats with dots, slash and dash, uppercase', () => {
    expect(formatCnpj('11222333000181')).toBe('11.222.333/0001-81');
    expect(formatCnpj('12abc34501de35')).toBe('12.ABC.345/01DE-35');
  });
});

describe('isValidEmail', () => {
  const cases: Array<[input: string, valid: boolean]> = [
    ['ana@exemplo.com.br', true],
    [' Ana.Silva+adv@Exemplo.COM ', true],
    ['a_b@sub.dominio.org', true],
    ['ana', false],
    ['ana@', false],
    ['@exemplo.com', false],
    ['ana@exemplo', false],
    ['ana silva@exemplo.com', false],
    ['ana@@exemplo.com', false],
    ['ana@exemplo..com', false],
    ['', false],
  ];
  it.each(cases)('isValidEmail(%j) = %s', (input, valid) => {
    expect(isValidEmail(input)).toBe(valid);
  });
});

describe('parsePhoneBR', () => {
  const cases: Array<[input: string, expected: string | null]> = [
    ['(65) 99999-9999', '5565999999999'],
    ['65999999999', '5565999999999'],
    ['+55 65 99999-9999', '5565999999999'],
    ['5565999999999', '5565999999999'],
    ['556599999999', '5565999999999'], // 12-digit mobile gains the 9
    ['(65) 9999-9999', '5565999999999'], // old 8-digit mobile gains the 9
    ['(65) 3222-1111', '556532221111'], // landline
    ['meu número é 65 99999-9999', '5565999999999'], // words around a single number are fine
    ['+1 202-555-0123', null], // not Brazilian
    ['5565899999999', null], // 13 digits but the local part does not start with 9
    ['556512345678', null], // local number starting with 1
    ['55 00 99999-9999', null], // DDD 00
    ['65 99999-9999 ou 65 98888-7777', null], // two numbers
    ['123', null],
    ['abc', null],
    ['', null],
  ];
  it.each(cases)('parsePhoneBR(%j) = %j', (input, expected) => {
    expect(parsePhoneBR(input)).toBe(expected);
  });
});

describe('compileUserRegex', () => {
  it.each([
    ['^\\d{5}-?\\d{3}$', true],
    ['\\p{Lu}', true], // needs the 'u' flag
    ['a'.repeat(200), true],
    ['a'.repeat(201), false], // too long
    ['', false],
    ['(', false],
    ['[', false],
    ['\\a', false], // invalid identity escape under 'u'
  ])('compileUserRegex(%j) compiles = %s', (pattern, compiles) => {
    expect(compileUserRegex(pattern) !== null).toBe(compiles);
  });

  it('uses the unicode flag', () => {
    const re = compileUserRegex('^\\p{Lu}$');
    expect(re?.flags).toBe('u');
    expect(re?.test('Á')).toBe(true);
  });
});

describe('mediaTypeOf', () => {
  it.each([
    ['application/pdf', 'pdf'],
    ['APPLICATION/PDF; name=x', 'pdf'],
    ['audio/ogg; codecs=opus', 'audio'],
    ['image/webp', 'image'],
    ['image/jpeg', 'image'],
    ['video/mp4', 'video'],
    ['application/msword', null],
    ['text/plain', null],
    ['', null],
    [null, null],
  ] as Array<[string | null, string | null]>)('mediaTypeOf(%j) = %j', (mime, expected) => {
    expect(mediaTypeOf(mime)).toBe(expected);
  });
});

describe('validateAnswer', () => {
  type Cfg = Pick<AskInputConfig, 'validator' | 'mediaTypes' | 'regex'>;
  const text = (body: string | null): AnswerInput => ({ body, kind: 'text', mediaMime: null, mediaName: null });
  const media = (kind: AnswerInput['kind'], mediaMime: string | null, mediaName: string | null = null): AnswerInput => ({
    body: null,
    kind,
    mediaMime,
    mediaName,
  });
  const ok = (raw: string, value: string): AnswerResult => ({ ok: true, raw, value });
  const FAIL: AnswerResult = { ok: false };

  const cases: Array<[label: string, cfg: Cfg, input: AnswerInput, expected: AnswerResult]> = [
    ['any: text is trimmed', { validator: 'any' }, text('  oi  '), ok('oi', 'oi')],
    ['any: audio without a name is accepted (Review Focus 4)', { validator: 'any' }, media('audio', 'audio/ogg'), ok('', 'audio')],
    ['any: a document uses its file name', { validator: 'any' }, media('document', 'application/pdf', 'contrato.pdf'), ok('', 'contrato.pdf')],
    ['any: a sticker is accepted', { validator: 'any' }, media('sticker', 'image/webp'), ok('', 'sticker')],
    ['any: text with a null body does not crash', { validator: 'any' }, text(null), ok('', '')],
    ['email: lowercased value, trimmed raw', { validator: 'email' }, text(' Ana@Exemplo.com '), ok('Ana@Exemplo.com', 'ana@exemplo.com')],
    ['email: invalid', { validator: 'email' }, text('ana'), FAIL],
    ['email: an image without caption', { validator: 'email' }, media('image', 'image/jpeg'), FAIL],
    ['phone: canonical value', { validator: 'phone' }, text('(65) 99999-9999'), ok('(65) 99999-9999', '5565999999999')],
    ['phone: invalid', { validator: 'phone' }, text('123'), FAIL],
    ['phone: audio', { validator: 'phone' }, media('audio', 'audio/ogg'), FAIL],
    ['cpf: formatted value', { validator: 'cpf' }, text('52998224725'), ok('52998224725', '529.982.247-25')],
    ['cpf: wrong check digit', { validator: 'cpf' }, text('529.982.247-24'), FAIL],
    ['cnpj: formatted value', { validator: 'cnpj' }, text('11222333000181'), ok('11222333000181', '11.222.333/0001-81')],
    ['cnpj: alphanumeric, uppercased', { validator: 'cnpj' }, text('12abc34501de35'), ok('12abc34501de35', '12.ABC.345/01DE-35')],
    ['cnpj: a CPF is not a CNPJ', { validator: 'cnpj' }, text('52998224725'), FAIL],
    ['regex: match', { validator: 'regex', regex: '^\\d{5}-?\\d{3}$' }, text(' 78000-000 '), ok('78000-000', '78000-000')],
    ['regex: no match', { validator: 'regex', regex: '^\\d{5}-?\\d{3}$' }, text('abc'), FAIL],
    ['regex: an invalid pattern fails without throwing', { validator: 'regex', regex: '(' }, text('abc'), FAIL],
    ['regex: a missing pattern fails', { validator: 'regex' }, text('abc'), FAIL],
    ['regex: 1000 chars are tested', { validator: 'regex', regex: '^a+$' }, text('a'.repeat(1000)), ok('a'.repeat(1000), 'a'.repeat(1000))],
    ['regex: longer than 1000 chars fails', { validator: 'regex', regex: '^a+$' }, text('a'.repeat(1001)), FAIL],
    ['media: any type, image', { validator: 'media' }, media('image', 'image/jpeg', 'foto.jpg'), ok('', 'foto.jpg')],
    ['media: empty list = any type', { validator: 'media', mediaTypes: [] }, media('video', 'video/mp4'), ok('', 'video')],
    ['media: text is refused', { validator: 'media' }, text('segue o arquivo'), FAIL],
    ['media: unsupported is refused', { validator: 'media' }, media('unsupported', null), FAIL],
    ['media: pdf required, pdf sent', { validator: 'media', mediaTypes: ['pdf'] }, media('document', 'application/pdf', 'peticao.pdf'), ok('', 'peticao.pdf')],
    ['media: pdf required, photo sent', { validator: 'media', mediaTypes: ['pdf'] }, media('image', 'image/jpeg'), FAIL],
    ['media: pdf required, unknown mime', { validator: 'media', mediaTypes: ['pdf'] }, media('document', null, 'x.pdf'), FAIL],
    ['media: image allowed, sticker sent', { validator: 'media', mediaTypes: ['image'] }, media('sticker', 'image/webp'), ok('', 'sticker')],
    ['media: audio allowed, voice note with codec', { validator: 'media', mediaTypes: ['audio', 'pdf'] }, media('audio', 'audio/ogg; codecs=opus'), ok('', 'audio')],
  ];
  it.each(cases)('%s', (_label, cfg, input, expected) => {
    expect(validateAnswer(cfg, input)).toEqual(expected);
  });
});
```

- [ ] **Step 2: Run the validator tests to verify they fail**

Run: `npm test -w server -- test/bots/validators.test.ts`
Expected: FAIL. The suite cannot load `../../src/bots/validators.js` ("Failed to load url … Does the file exist?") because the module does not exist yet.

- [ ] **Step 3: Implement the validators**

Create `server/src/bots/validators.ts`:

```ts
import { z } from 'zod';
import type { AskInputConfig, MediaType } from '@talk/shared';
import { baseMime } from '../messages/media.js';
import { normalizePhoneBR } from '../whatsapp/phone.js';
import type { MessageKind } from '../whatsapp/types.js';

export interface AnswerInput { body: string | null; kind: MessageKind; mediaMime: string | null; mediaName: string | null }
export type AnswerResult = { ok: true; raw: string; value: string } | { ok: false };

const FAIL: AnswerResult = { ok: false };
const REGEX_MAX = 200;
// ponytail: no ReDoS guard beyond pattern ≤200 and input ≤1000 chars; move to a worker with timeout if patterns get hostile.
const REGEX_INPUT_MAX = 1000;
const MEDIA_KINDS: ReadonlySet<MessageKind> = new Set(['image', 'audio', 'video', 'document', 'sticker']);
// After normalizePhoneBR: 55 + DDD (two digits 1-9) + mobile 9xxxxxxxx or landline [2-5]xxxxxxx.
const BR_PHONE = /^55[1-9]{2}(?:9\d{8}|[2-5]\d{7})$/;
const Email = z.email();

/** Drops only formatting (spaces, dots, dashes, slashes); any other character keeps the answer invalid. */
const unformat = (s: string) => s.replace(/[\s./-]/g, '');

/** Brazilian mod-11 check digit, shared by CPF and CNPJ. */
function checkDigit(values: number[], weights: readonly number[]): number {
  const r = values.reduce((sum, v, i) => sum + v * weights[i], 0) % 11;
  return r < 2 ? 0 : 11 - r;
}

const CPF_W1 = [10, 9, 8, 7, 6, 5, 4, 3, 2];
const CPF_W2 = [11, ...CPF_W1];
const CNPJ_W1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const CNPJ_W2 = [6, ...CNPJ_W1];

export function isValidCpf(s: string): boolean {
  const d = unformat(s);
  if (!/^\d{11}$/.test(d) || /^(\d)\1{10}$/.test(d)) return false;
  const v = [...d].map(Number);
  return checkDigit(v.slice(0, 9), CPF_W1) === v[9] && checkDigit(v.slice(0, 10), CPF_W2) === v[10];
}

/** Call only after isValidCpf. */
export function formatCpf(s: string): string {
  const d = unformat(s);
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9, 11)}`;
}

/** Numeric and alphanumeric CNPJ (Receita Federal, issued from July 2026): 12 chars [0-9A-Z] + 2 numeric
 *  check digits; each char counts as its char code minus 48, so digits keep their value. */
export function isValidCnpj(s: string): boolean {
  const c = unformat(s).toUpperCase();
  if (!/^[0-9A-Z]{12}\d{2}$/.test(c) || /^(\d)\1{13}$/.test(c)) return false;
  const v = [...c].map((ch) => ch.charCodeAt(0) - 48);
  return checkDigit(v.slice(0, 12), CNPJ_W1) === v[12] && checkDigit(v.slice(0, 13), CNPJ_W2) === v[13];
}

/** Call only after isValidCnpj. */
export function formatCnpj(s: string): string {
  const c = unformat(s).toUpperCase();
  return `${c.slice(0, 2)}.${c.slice(2, 5)}.${c.slice(5, 8)}/${c.slice(8, 12)}-${c.slice(12, 14)}`;
}

export function isValidEmail(s: string): boolean {
  return Email.safeParse(s.trim()).success;
}

export function parsePhoneBR(s: string): string | null {
  const p = normalizePhoneBR(s);
  return BR_PHONE.test(p) ? p : null;
}

/** null when empty, longer than 200 chars or not a valid pattern with the 'u' flag. */
export function compileUserRegex(pattern: string): RegExp | null {
  if (pattern.length === 0 || pattern.length > REGEX_MAX) return null;
  try {
    return new RegExp(pattern, 'u');
  } catch {
    return null;
  }
}

export function mediaTypeOf(mime: string | null): MediaType | null {
  if (!mime) return null;
  const m = baseMime(mime);
  if (m === 'application/pdf') return 'pdf';
  const top = m.split('/')[0];
  return top === 'audio' || top === 'image' || top === 'video' ? top : null;
}

export function validateAnswer(
  cfg: Pick<AskInputConfig, 'validator' | 'mediaTypes' | 'regex'>,
  input: AnswerInput,
): AnswerResult {
  const mediaValue = input.mediaName ?? input.kind;
  if (cfg.validator === 'any') {
    if (input.kind !== 'text') return { ok: true, raw: '', value: mediaValue };
    const t = (input.body ?? '').trim();
    return { ok: true, raw: t, value: t };
  }
  if (cfg.validator === 'media') {
    if (!MEDIA_KINDS.has(input.kind)) return FAIL;
    const types = cfg.mediaTypes ?? [];
    const type = mediaTypeOf(input.mediaMime);
    if (types.length > 0 && (type === null || !types.includes(type))) return FAIL;
    return { ok: true, raw: '', value: mediaValue };
  }
  if (input.body === null) return FAIL;
  const raw = input.body.trim();
  switch (cfg.validator) {
    case 'email':
      return isValidEmail(raw) ? { ok: true, raw, value: raw.toLowerCase() } : FAIL;
    case 'phone': {
      const phone = parsePhoneBR(raw);
      return phone ? { ok: true, raw, value: phone } : FAIL;
    }
    case 'cpf':
      return isValidCpf(raw) ? { ok: true, raw, value: formatCpf(raw) } : FAIL;
    case 'cnpj':
      return isValidCnpj(raw) ? { ok: true, raw, value: formatCnpj(raw) } : FAIL;
    case 'regex': {
      const re = compileUserRegex(cfg.regex ?? '');
      return re && raw.length <= REGEX_INPUT_MAX && re.test(raw) ? { ok: true, raw, value: raw } : FAIL;
    }
  }
  return FAIL;
}
```

- [ ] **Step 4: Run the validator tests to verify they pass**

Run: `npm test -w server -- test/bots/validators.test.ts`
Expected: PASS, every row of every table.

- [ ] **Step 5: Commit the validators**

```bash
git add server/src/bots/validators.ts server/test/bots/validators.test.ts
git commit -m "feat(bots): validadores de resposta (CPF, CNPJ, e-mail, telefone, regex, mídia)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Write the failing graph tests**

Create `server/test/bots/graph.test.ts`. `VALID` is typed `Record<BlockType, …>`, so the typecheck fails if a block type is missing. Only the final `loadGraphCatalog` test uses the database.

```ts
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
import { bots, customFields, tags, users } from '../../src/db/schema.js';
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
};

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
    const [self] = await ctx.db.insert(bots).values({ name: 'Este' }).returning();
    const [other] = await ctx.db.insert(bots).values({ name: 'Outro' }).returning();

    const cat = await loadGraphCatalog(ctx.db, self.id);

    expect(cat.selfBotId).toBe(self.id);
    expect(cat.sectorIds).toEqual(new Set([s.defaultSector, s.sectorA, s.sectorB]));
    expect(cat.activeUserIds).toEqual(new Set([s.admin.id, s.agentA.id, s.agentB.id]));
    expect(cat.activeUserIds.has(inactive.id)).toBe(false);
    expect(cat.tagIds).toEqual(new Set([tag.id]));
    expect(cat.customFieldIds).toEqual(new Set([field.id]));
    expect(cat.channelIds).toEqual(new Set([s.channelId]));
    expect(cat.botIds).toEqual(new Set([self.id, other.id]));
  });
});
```

- [ ] **Step 7: Run the graph tests to verify they fail**

Run: `npm test -w server -- test/bots/graph.test.ts`
Expected: FAIL. The suite cannot load `../../src/bots/graph.js` ("Failed to load url … Does the file exist?").

- [ ] **Step 8: Implement graph validation**

Create `server/src/bots/graph.ts`:

```ts
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
}

export async function loadGraphCatalog(db: Db | Tx, selfBotId: string | null): Promise<GraphCatalog> {
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
```

- [ ] **Step 9: Run the graph tests, the whole server suite and the typecheck**

Run: `npm test -w server -- test/bots/graph.test.ts`
Expected: PASS, including `loadGraphCatalog` against PGlite.

Run: `npm test -w server`
Expected: PASS. Nothing outside `server/src/bots/` changed.

Run: `npm run typecheck -w server`
Expected: no errors. This is the step that catches a block type missing from `VALID`.

- [ ] **Step 10: Commit graph validation**

```bash
git add server/src/bots/graph.ts server/test/bots/graph.test.ts
git commit -m "feat(bots): validação do grafo do fluxo e das referências do catálogo" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


---

### Task 4: Variables rendering with contexto

Bots render their texts with the quick-answer renderer (spec §5.3: "Renderização pela mesma função das respostas rápidas, estendida com o prefixo `contexto`"). This task adds the `contexto` group to `renderQuickAnswer`, moves the inline var building of the render route into an exported `buildChatVars`, and adds `server/src/bots/variables.ts`, which builds the vars for a bot run (contato, campo, atendente = chat owner, contexto = run vars). Existing quick-answer behavior is unchanged: without `vars.contexto`, `{{contexto.x}}` stays literal, as the existing test `'Literal {{Contexto.x}} e {{1}}'` requires.

**Files:**
- Modify: `server/src/messages/quick-answers.ts` (top of file: `QuickAnswerVars`, `slug`, `NAMED_VAR`, `renderQuickAnswer`; add imports, `firstName`, `buildChatVars`)
- Modify: `server/src/catalog/quick-answers.ts` (imports at lines 3–13, `firstName` at line 58, the render route at lines 146–167)
- Create: `server/src/bots/variables.ts`
- Test: `server/test/messages/quick-answers.test.ts` (add a `describe`), `server/test/bots/variables.test.ts` (create)
- Regression: `server/test/catalog/quick-answers.test.ts` (unchanged, must still pass)

**Interfaces:**
- Consumes:
  - `BotRunVars`, `VarValue` from `@talk/shared` (Task 1): `interface VarValue { raw: string; value: string; label?: string }`, `type BotRunVars = Record<string, VarValue>`.
  - `type ChatRow = typeof chats.$inferSelect` from `server/src/inbox/chats.ts`.
  - `loadAuthUser(db: Db | Tx, userId: string): Promise<AuthUser | null>` from `server/src/inbox/visibility.ts` (null when inactive or missing).
  - `Db`, `Tx` from `server/src/db/client.ts`; `contacts`, `customFields`, `contactFieldValues` from `server/src/db/schema.ts`.
  - Test helpers: `makeTestCtx`, `seedBasics` (`server/test/helpers.ts`), `newContact`, `insertChat` (`server/test/inbox/fixtures.ts`).
- Produces (later tasks use exactly these):
  ```ts
  // server/src/messages/quick-answers.ts
  export interface QuickAnswerVars { atendente: { nome: string; primeiro_nome: string; email: string };
    contato: { nome: string; primeiro_nome: string; telefone: string; email: string }; campo: Record<string, string> } // unchanged
  export function renderQuickAnswer(body: string, vars: QuickAnswerVars & { contexto?: Record<string, string> }): string;
  export function firstName(s: string): string;
  export async function buildChatVars(db: Db | Tx, chat: Pick<ChatRow, 'contactId'>,
    atendente: Pick<AuthUser, 'name' | 'email'> | null): Promise<QuickAnswerVars>;
  // server/src/bots/variables.ts
  export interface BotTextVars extends QuickAnswerVars { contexto: Record<string, string> }
  export function contextoVars(vars: BotRunVars): Record<string, string>;
  export async function loadBotTextVars(db: Db | Tx, chat: ChatRow, runVars: BotRunVars): Promise<BotTextVars>;
  export function renderBotText(text: string, vars: BotTextVars): string;
  ```
  Task 5's `BotCtx.render(text)` is `renderBotText(text, await loadBotTextVars(ctx.app.db, chat, run.vars))`.

Rendering rules for `contexto` (the group and name are compared after `slug()`, like every other group):
- `{{contexto.<name>}}` → `vars[name].value`
- `{{contexto.<name>:raw}}` → `vars[name].raw` (the slug turns `cpf:raw` into `cpf_raw`)
- `{{contexto.<name>:label}}` → `vars[name].label ?? ''`
- An unknown name renders `''`. Without a `contexto` object, the group is unknown and stays literal.
- Collision: a node really named `cpf_raw` and the `:raw` key of a node `cpf` both slug to `cpf_raw`. The plain node name wins, because `contextoVars` writes the plain names last and the later Map entry overwrites the earlier one.

#### Cycle 1: the `contexto` group in `renderQuickAnswer`

- [ ] **Step 1: Write the failing test**

Append to the end of `server/test/messages/quick-answers.test.ts`:

```ts
describe('renderQuickAnswer with contexto (bots)', () => {
  const botVars = {
    ...vars,
    contexto: { cpf: '123.456.789-00', 'cpf:raw': '12345678900', 'cpf:label': '', menu: '2', 'menu:raw': 'Financeiro', 'menu:label': 'Financeiro' },
  };

  it.each([
    ['CPF {{contexto.cpf}}', 'CPF 123.456.789-00'],
    ['CPF digitado {{contexto.cpf:raw}}', 'CPF digitado 12345678900'],
    ['{{ Contexto.CPF }} / {{contexto.CPF:RAW}}', '123.456.789-00 / 12345678900'],
    ['Opção {{contexto.menu}} ({{contexto.menu:label}})', 'Opção 2 (Financeiro)'],
    ['Sem valor: [{{contexto.inexistente}}] [{{contexto.cpf:label}}]', 'Sem valor: [] []'],
    ['{{contato.primeiro_nome}}, CPF {{campo.cpf}} = {{contexto.cpf}}', 'Maria, CPF 123.456.789-00 = 123.456.789-00'],
    ['Bem-vindo à {{empresa}} {{1}}', 'Bem-vindo à {{empresa}} {{1}}'],
  ])('%j renders %j', (body, expected) => {
    expect(renderQuickAnswer(body, botVars)).toBe(expected);
  });

  it('keeps {{contexto.x}} literal when no contexto is given (quick answers)', () => {
    expect(renderQuickAnswer('{{contexto.cpf}}', vars)).toBe('{{contexto.cpf}}');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- test/messages/quick-answers.test.ts`
Expected: FAIL. The new `contexto` cases fail with `expected '{{contexto.cpf}}' to be …`-style mismatches, because the renderer does not know the group yet and leaves it literal. The old cases and the "keeps literal" case pass.

- [ ] **Step 3: Write minimal implementation**

In `server/src/messages/quick-answers.ts`, replace everything from the first line down to the end of `renderQuickAnswer` (the line `}` after `return values ? (values.get(slug(name)) ?? '') : match;\n  });`) with:

```ts
// Spec §5.7: named variables in quick answers, plus conversion of Umbler's positional {{n}}.
// Chatbot spec 2a §5.3: bots render with this same function plus the `contexto` group.
export interface QuickAnswerVars {
  atendente: { nome: string; primeiro_nome: string; email: string };
  contato: { nome: string; primeiro_nome: string; telefone: string; email: string };
  campo: Record<string, string>;
}

// "Número do Processo" -> "numero_do_processo". Names are compared in this form, so
// {{campo.CPF}}, {{campo.cpf}} and {{ Campo.Cpf }} all hit the field named "CPF".
function slug(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

const NAMED_VAR = /\{\{\s*([^{}.]+)\.([^{}]+?)\s*\}\}/g;

// Later entries win on a slug collision (contextoVars relies on this).
const slugged = (r: Record<string, string>) => new Map(Object.entries(r).map(([k, v]) => [slug(k), v]));

export function renderQuickAnswer(body: string, vars: QuickAnswerVars & { contexto?: Record<string, string> }): string {
  const groups = new Map<string, Map<string, string>>([
    ['atendente', new Map(Object.entries(vars.atendente))],
    ['contato', new Map(Object.entries(vars.contato))],
    ['campo', slugged(vars.campo)],
  ]);
  // Only bots pass contexto; for quick answers {{contexto.x}} stays literal as before.
  if (vars.contexto) groups.set('contexto', slugged(vars.contexto));
  return body.replace(NAMED_VAR, (match, group: string, name: string) => {
    const values = groups.get(slug(group));
    // Not one of our groups (e.g. text that merely looks like a variable): leave it.
    return values ? (values.get(slug(name)) ?? '') : match;
  });
}
```

The rest of the file (`ENTITY`, `ATTR`, `umblerToNamed`, `convertUmblerVariables`) stays as it is.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w server -- test/messages/quick-answers.test.ts`
Expected: PASS (all old cases, including `'Literal {{Contexto.x}} e {{1}}'`, and the new `contexto` cases).

- [ ] **Step 5: Commit**

```bash
git add server/src/messages/quick-answers.ts server/test/messages/quick-answers.test.ts
git commit -m "feat(server): contexto group in the variable renderer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

#### Cycle 2: `buildChatVars`, shared by the render route and the bot

- [ ] **Step 1: Write the failing test**

Create `server/test/bots/variables.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { chats, contactFieldValues, contacts, customFields } from '../../src/db/schema.js';
import { buildChatVars } from '../../src/messages/quick-answers.js';
import { makeTestCtx, seedBasics } from '../helpers.js';
import { insertChat, newContact } from '../inbox/fixtures.js';

async function setup(opts: { contactName?: string } = {}) {
  const ctx = await makeTestCtx();
  const seed = await seedBasics(ctx);
  const contactId = await newContact(ctx, { name: opts.contactName ?? 'Maria Souza', phone: '5565999991111' });
  await ctx.db.update(contacts).set({ email: 'maria@exemplo.com.br' }).where(eq(contacts.id, contactId));
  const fieldId = randomUUID();
  await ctx.db.insert(customFields).values({ id: fieldId, name: 'Número do processo', kind: 'text', position: 0 });
  await ctx.db.insert(contactFieldValues).values({ contactId, fieldId, value: '0001234-56.2026.8.11.0041' });
  return { ctx, seed, contactId };
}

async function chatRow(ctx: Awaited<ReturnType<typeof makeTestCtx>>, id: string) {
  const [row] = await ctx.db.select().from(chats).where(eq(chats.id, id));
  return row;
}

describe('buildChatVars', () => {
  it('fills contato and campo from the chat contact and atendente from the given user', async () => {
    const { ctx, contactId } = await setup();
    const vars = await buildChatVars(ctx.db, { contactId }, { name: '  Ana Paula Lima ', email: 'ana@jvo.adv.br' });
    expect(vars).toEqual({
      atendente: { nome: '  Ana Paula Lima ', primeiro_nome: 'Ana', email: 'ana@jvo.adv.br' },
      contato: { nome: 'Maria Souza', primeiro_nome: 'Maria', telefone: '5565999991111', email: 'maria@exemplo.com.br' },
      campo: { 'Número do processo': '0001234-56.2026.8.11.0041' },
    });
  });

  it('leaves atendente empty when there is none, and only reads the chat contact', async () => {
    const { ctx, seed, contactId } = await setup();
    const other = await newContact(ctx, { name: 'Outro Cliente' });
    const chatId = await insertChat(ctx, { channelId: seed.channelId, sectorId: seed.sectorA, contactId });
    const vars = await buildChatVars(ctx.db, await chatRow(ctx, chatId), null);
    expect(vars.atendente).toEqual({ nome: '', primeiro_nome: '', email: '' });
    expect(vars.contato.nome).toBe('Maria Souza');
    expect((await buildChatVars(ctx.db, { contactId: other }, null)).campo).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- test/bots/variables.test.ts`
Expected: FAIL with `buildChatVars is not a function` (it is not exported yet).

- [ ] **Step 3: Write minimal implementation**

In `server/src/messages/quick-answers.ts`, add these imports at the very top of the file, above the `// Spec §5.7` comment:

```ts
import { eq } from 'drizzle-orm';
import type { Db, Tx } from '../db/client.js';
import { contactFieldValues, contacts, customFields } from '../db/schema.js';
import type { ChatRow } from '../inbox/chats.js';
import type { AuthUser } from '../inbox/visibility.js';
```

Then add, directly after the `renderQuickAnswer` function:

```ts
export function firstName(s: string): string {
  return s.trim().split(/\s+/)[0] ?? '';
}

/** Vars of a chat: its contact, the contact's custom fields (keyed by field name) and the given atendente. */
export async function buildChatVars(
  db: Db | Tx,
  chat: Pick<ChatRow, 'contactId'>,
  atendente: Pick<AuthUser, 'name' | 'email'> | null,
): Promise<QuickAnswerVars> {
  const [contact] = await db.select().from(contacts).where(eq(contacts.id, chat.contactId));
  const fieldRows = await db
    .select({ name: customFields.name, value: contactFieldValues.value })
    .from(contactFieldValues)
    .innerJoin(customFields, eq(customFields.id, contactFieldValues.fieldId))
    .where(eq(contactFieldValues.contactId, chat.contactId));
  const contactName = contact?.name ?? '';
  return {
    atendente: atendente
      ? { nome: atendente.name, primeiro_nome: firstName(atendente.name), email: atendente.email }
      : { nome: '', primeiro_nome: '', email: '' },
    contato: {
      nome: contactName,
      primeiro_nome: firstName(contactName),
      telefone: contact?.phone ?? '',
      email: contact?.email ?? '',
    },
    campo: Object.fromEntries(fieldRows.map((f) => [f.name, f.value])),
  };
}
```

In `server/src/catalog/quick-answers.ts`:

1. Replace the two import lines
   ```ts
   import { contactFieldValues, contacts, customFields, quickAnswers } from '../db/schema.js';
   ```
   and
   ```ts
   import { renderQuickAnswer } from '../messages/quick-answers.js';
   ```
   with
   ```ts
   import { quickAnswers } from '../db/schema.js';
   ```
   and
   ```ts
   import { buildChatVars, renderQuickAnswer } from '../messages/quick-answers.js';
   ```
2. Delete the line `const firstName = (s: string) => s.trim().split(/\s+/)[0] ?? '';`.
3. Replace the whole render route
   ```ts
     app.post('/api/quick-answers/:id/render', async (req) => {
       const qa = await load(ctx, req.user, IdParams.parse(req.params).id);
       const chat = await getChatForUser(ctx, req.user, RenderBody.parse(req.body).chatId);
       const [contact] = await ctx.db.select().from(contacts).where(eq(contacts.id, chat.contactId));
       const fieldRows = await ctx.db
         .select({ name: customFields.name, value: contactFieldValues.value })
         .from(contactFieldValues)
         .innerJoin(customFields, eq(customFields.id, contactFieldValues.fieldId))
         .where(eq(contactFieldValues.contactId, chat.contactId));
       const contactName = contact?.name ?? '';
       const text = renderQuickAnswer(qa.body, {
         atendente: { nome: req.user.name, primeiro_nome: firstName(req.user.name), email: req.user.email },
         contato: {
           nome: contactName,
           primeiro_nome: firstName(contactName),
           telefone: contact?.phone ?? '',
           email: contact?.email ?? '',
         },
         campo: Object.fromEntries(fieldRows.map((f) => [f.name, f.value])),
       });
       return { text };
     });
   ```
   with
   ```ts
     app.post('/api/quick-answers/:id/render', async (req) => {
       const qa = await load(ctx, req.user, IdParams.parse(req.params).id);
       const chat = await getChatForUser(ctx, req.user, RenderBody.parse(req.body).chatId);
       return { text: renderQuickAnswer(qa.body, await buildChatVars(ctx.db, chat, req.user)) };
     });
   ```
   Keep the comment line `// Fills the variables for the composer; never sends anything (spec §5.7).` above it. `eq` is still used by `load` and the PATCH/DELETE routes, so its import stays.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w server -- test/bots/variables.test.ts test/messages/quick-answers.test.ts test/catalog/quick-answers.test.ts`
Expected: PASS. `test/catalog/quick-answers.test.ts` › `renders variables from the chat contact, its fields and the current user` still passes unchanged.

Run: `npm run typecheck -w server`
Expected: exit 0 (no unused-import or type errors).

- [ ] **Step 5: Commit**

```bash
git add server/src/messages/quick-answers.ts server/src/catalog/quick-answers.ts server/test/bots/variables.test.ts
git commit -m "refactor(server): share chat variables between quick answers and bots

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

#### Cycle 3: bot run variables (`server/src/bots/variables.ts`)

- [ ] **Step 1: Write the failing test**

In `server/test/bots/variables.test.ts`, replace the line

```ts
import { chats, contactFieldValues, contacts, customFields } from '../../src/db/schema.js';
```

with

```ts
import { contextoVars, loadBotTextVars, renderBotText } from '../../src/bots/variables.js';
import { chats, contactFieldValues, contacts, customFields, users } from '../../src/db/schema.js';
```

Then append to the end of the file:

```ts
describe('contextoVars', () => {
  it('maps each run var to its value, :raw and :label keys', () => {
    expect(
      contextoVars({
        cpf: { raw: '123.456.789-00 ', value: '123.456.789-00' },
        menu: { raw: 'financeiro', value: '2', label: 'Financeiro' },
      }),
    ).toEqual({
      cpf: '123.456.789-00',
      'cpf:raw': '123.456.789-00 ',
      'cpf:label': '',
      menu: '2',
      'menu:raw': 'financeiro',
      'menu:label': 'Financeiro',
    });
  });

  it('lets a node really named cpf_raw win over the :raw key of node cpf', () => {
    const vars = {
      atendente: { nome: '', primeiro_nome: '', email: '' },
      contato: { nome: '', primeiro_nome: '', telefone: '', email: '' },
      campo: {},
      contexto: contextoVars({ cpf: { raw: 'digitado', value: 'formatado' }, cpf_raw: { raw: 'x', value: 'outro bloco' } }),
    };
    expect(renderBotText('{{contexto.cpf}} | {{contexto.cpf_raw}}', vars)).toBe('formatado | outro bloco');
  });
});

describe('loadBotTextVars + renderBotText', () => {
  const text =
    'Olá {{contato.primeiro_nome}}, sou {{atendente.primeiro_nome}}. CPF {{contexto.cpf}} (digitado: {{contexto.cpf:raw}}). ' +
    'Opção {{contexto.menu}} · {{contexto.menu:label}}. Processo {{campo.numero_do_processo}}. {{empresa}} [{{contexto.nada}}]';
  const runVars = {
    cpf: { raw: '12345678900', value: '123.456.789-00' },
    menu: { raw: '2', value: '2', label: 'Financeiro' },
  };

  it('uses the chat owner as atendente and the run vars as contexto', async () => {
    const { ctx, seed, contactId } = await setup();
    const chatId = await insertChat(ctx, { channelId: seed.channelId, sectorId: seed.sectorA, contactId, ownerId: seed.agentA.id });
    const vars = await loadBotTextVars(ctx.db, await chatRow(ctx, chatId), runVars);
    expect(vars.atendente).toEqual({ nome: 'Ana Financeiro', primeiro_nome: 'Ana', email: 'ana@teste.local' });
    expect(renderBotText(text, vars)).toBe(
      'Olá Maria, sou Ana. CPF 123.456.789-00 (digitado: 12345678900). Opção 2 · Financeiro. ' +
        'Processo 0001234-56.2026.8.11.0041. {{empresa}} []',
    );
  });

  it('leaves atendente empty when the chat has no owner or the owner is inactive', async () => {
    const { ctx, seed, contactId } = await setup();
    const noOwner = await insertChat(ctx, { channelId: seed.channelId, sectorId: seed.sectorA, contactId });
    const empty = { nome: '', primeiro_nome: '', email: '' };
    expect((await loadBotTextVars(ctx.db, await chatRow(ctx, noOwner), {})).atendente).toEqual(empty);

    await ctx.db.update(chats).set({ state: 'closed', closedAt: new Date() }).where(eq(chats.id, noOwner));
    const owned = await insertChat(ctx, { channelId: seed.channelId, sectorId: seed.sectorA, contactId, ownerId: seed.agentA.id });
    await ctx.db.update(users).set({ active: false }).where(eq(users.id, seed.agentA.id));
    const vars = await loadBotTextVars(ctx.db, await chatRow(ctx, owned), runVars);
    expect(vars.atendente).toEqual(empty);
    expect(renderBotText('[{{atendente.nome}}] {{contexto.cpf}}', vars)).toBe('[] 123.456.789-00');
  });
});
```

(The first chat is closed before the second is inserted because `chats_one_open_per_contact_channel` allows one open chat per contact and channel.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- test/bots/variables.test.ts`
Expected: FAIL. The whole file errors while importing `../../src/bots/variables.js` (module not found), so no test runs.

- [ ] **Step 3: Write minimal implementation**

Create `server/src/bots/variables.ts`:

```ts
// Chatbot spec 2a §5.3: bot texts use the quick-answer variables plus {{contexto.<name>}} / {{contexto.<name>:raw}}.
import type { BotRunVars } from '@talk/shared';
import type { Db, Tx } from '../db/client.js';
import type { ChatRow } from '../inbox/chats.js';
import { loadAuthUser } from '../inbox/visibility.js';
import { buildChatVars, renderQuickAnswer, type QuickAnswerVars } from '../messages/quick-answers.js';

export interface BotTextVars extends QuickAnswerVars {
  contexto: Record<string, string>;
}

/** For each var: name → value, `${name}:raw` → raw, `${name}:label` → label ?? '' (renderQuickAnswer slugs `cpf:raw` → `cpf_raw`). */
export function contextoVars(vars: BotRunVars): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, v] of Object.entries(vars)) {
    out[`${name}:raw`] = v.raw;
    out[`${name}:label`] = v.label ?? '';
  }
  // ponytail: plain names go last so a node really named "cpf_raw" wins the slug collision with "cpf:raw";
  // {{contexto.cpf:raw}} then shows that node's value. Rename one node if that ever matters.
  for (const [name, v] of Object.entries(vars)) out[name] = v.value;
  return out;
}

/** atendente = the chat owner (loadAuthUser: null when inactive), or empty when there is none. */
export async function loadBotTextVars(db: Db | Tx, chat: ChatRow, runVars: BotRunVars): Promise<BotTextVars> {
  const atendente = chat.ownerId ? await loadAuthUser(db, chat.ownerId) : null;
  return { ...(await buildChatVars(db, chat, atendente)), contexto: contextoVars(runVars) };
}

export function renderBotText(text: string, vars: BotTextVars): string {
  return renderQuickAnswer(text, vars);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w server -- test/bots/variables.test.ts test/messages/quick-answers.test.ts test/catalog/quick-answers.test.ts`
Expected: PASS.

Run: `npm run typecheck -w server`
Expected: exit 0.

Run: `npm test -w server`
Expected: PASS (the whole server suite; nothing else imported the removed `firstName` or the old render code).

- [ ] **Step 5: Commit**

```bash
git add server/src/bots/variables.ts server/test/bots/variables.test.ts
git commit -m "feat(server): bot text variables with contexto from the run

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


---

### Task 5: Engine core

This task builds the step engine and the runtime that every block (Tasks 6–8), the scheduler (Task 9) and the ingest hooks (Task 10) depend on. The tests use **stub blocks** in a test registry, so the engine is tested before any real block exists.

**Files:**
- Create: `server/src/bots/block-error.ts`. It holds `BlockError`, and `registry.ts` re-exports it (see the cycle note below).
- Create: `server/src/bots/registry.ts`: `InboundReply`, `BotActor`, `ResumeEvent`, `BlockResult`, `BotCtx`, `BlockDefinition`, `BlockRegistry` and `defaultRegistry` (empty here; Tasks 6–8 add spreads), plus the `BlockError` re-export.
- Create: `server/src/bots/runtime.ts`: `BotRuntime`, `createBotRuntime`, `FakeClock`, `createFakeClock`.
- Create: `server/src/bots/engine.ts`: `startRun`, `resumeOnReply`, `resumeOnTimer`, `stopRun`, `stopRunsForChat`, `runningRunsForChat`, `step`, `failInterruptedRuns`.
- Modify: `server/src/ctx.ts`, which gains `botRuntime: BotRuntime`.
- Modify: `server/src/index.ts`, which sets `botRuntime: createBotRuntime()` in the ctx literal.
- Modify: `server/test/helpers.ts`. `makeTestCtx()` also returns `clock: FakeClock` and sets `botRuntime = createBotRuntime({ now: clock.now })`.
- Test: `server/test/bots/engine.test.ts`

**Interfaces:**
- Consumes:
  - Task 1 (`@talk/shared`): `MAX_STEPS_PER_CALL`, `MAX_FLOW_LEVELS`, `STEP_LOG_LIMIT`, `NON_TERMINAL_RUN_STATES`, `catalogEntry(type)`, `outputsOf(type, config)`, and the types `BlockType`, `BotGraph`, `BotNode`, `BotRunStep`, `BotStopReason`, `BotEventData`.
  - Task 1: `ChatEventKind` in `server/src/inbox/events.ts`, which includes `'bot_started' | 'bot_finished' | 'bot_stopped' | 'bot_failed'`.
  - Task 2 (`server/src/db/schema.ts`): `bots`, `botRuns` (with the `retries` and `waitingSince` columns) and `messages`.
  - Task 2 (`server/src/bots/repo.ts`):
    - `type BotRunRow`
    - `getBot(db, id): Promise<BotRow>`, which throws 404
    - `getVersionRow(db, versionId): Promise<BotVersionRow | null>`
    - `createBot(db, {...}): Promise<BotRow>`, used by the tests
    - `insertBotVersion(db, {...}): Promise<BotVersionRow>`, used by the tests
  - Task 3 (`server/src/bots/graph.ts`): `startNodeOf(graph, entry: 'channel' | 'manual' | 'call'): BotNode | null`.
  - Task 4 (`server/src/bots/variables.ts`):
    - `loadBotTextVars(db, chat: ChatRow, runVars: BotRunVars): Promise<BotTextVars>`
    - `renderBotText(text, vars): string`
- Produces (exact contract §3.7 names):
  ```ts
  // bots/block-error.ts (re-exported by bots/registry.ts)
  export class BlockError extends Error {}
  // bots/registry.ts
  export interface InboundReply { messageId: string; kind: MessageKind; body: string | null; mediaMime: string | null; mediaName: string | null; createdAt: Date }
  export interface BotActor { botId: string; botName: string; runId: string }
  export type ResumeEvent = { kind: 'reply'; reply: InboundReply } | { kind: 'timeout' } | { kind: 'timer' } | { kind: 'flow'; outcome: 'finished' | 'failed' | 'stopped' };
  export type BlockResult = { next: string } | { wait: 'reply'; timeoutAt: Date | null } | { wait: 'timer'; wakeAt: Date } | { wait: 'flow' } | { end: 'finished' } | { end: 'failed'; error: string };
  export interface BotCtx { app: AppCtx; now: Date; chat: ChatRow; bot: { id: string; name: string }; actor: BotActor;
    render(text: string): Promise<string>; lastInbound(): Promise<InboundReply | null>;
    startChild(botId: string): Promise<BotRunRow>; stopOtherRuns(chatId: string, reason: BotStopReason): Promise<void> }
  export interface BlockDefinition { type: BlockType; run(ctx: BotCtx, run: BotRunRow, node: BotNode): Promise<BlockResult>;
    resume?(ctx: BotCtx, run: BotRunRow, node: BotNode, ev: ResumeEvent): Promise<BlockResult> }
  export type BlockRegistry = Partial<Record<BlockType, BlockDefinition>>;
  export const defaultRegistry: BlockRegistry;
  // bots/runtime.ts
  export interface BotRuntime { now(): Date; random(): number; withChatLock<T>(chatId: string, fn: () => Promise<T>): Promise<T>; registry: BlockRegistry }
  export function createBotRuntime(opts?: { now?: () => Date; random?: () => number; registry?: BlockRegistry }): BotRuntime;
  export interface FakeClock { now(): Date; set(d: Date): void; advance(ms: number): void }
  export function createFakeClock(start?: Date): FakeClock;   // default 2026-10-14T13:00:00Z
  // bots/engine.ts
  export interface StartRunInput { botId: string; chatId: string; entry: 'channel' | 'manual' | 'call'; startedBy: string | null; parentRunId?: string | null; depth?: number }
  export async function startRun(ctx: AppCtx, input: StartRunInput): Promise<BotRunRow>;
  export async function resumeOnReply(ctx: AppCtx, chatId: string, reply: InboundReply): Promise<number>;
  export async function resumeOnTimer(ctx: AppCtx, runId: string, now: Date): Promise<BotRunRow | null>;
  export async function stopRun(ctx: AppCtx, runId: string, by: { userId: string | null; reason: BotStopReason }): Promise<BotRunRow>; // 404 'Execução não encontrada'
  export async function stopRunsForChat(ctx: AppCtx, chatId: string, by: { userId: string | null; reason: BotStopReason }, opts?: { exceptRunIds?: string[] }): Promise<BotRunRow[]>;
  export async function runningRunsForChat(db: Db | Tx, chatId: string): Promise<BotRunRow[]>;
  export async function step(ctx: AppCtx, runId: string, resume?: ResumeEvent): Promise<BotRunRow>;
  export async function failInterruptedRuns(db: Db): Promise<number>;
  // ctx.ts: AppCtx gains botRuntime: BotRuntime · test/helpers.ts: makeTestCtx() also returns clock: FakeClock
  ```
- **Import rule for block modules (Tasks 6–8):** import types with `import type { … } from '../registry.js'`, and import `BlockError` from `'../block-error.js'`. `registry.ts` imports the block families to build `defaultRegistry`. If a block file imported a runtime value from `registry.ts`, and a test imported that block file first, the cycle would evaluate `registry.ts` before the block's `export const …Blocks` exists, and the spread would throw a TDZ `ReferenceError`.
- Task 9 wires `failInterruptedRuns` and owns the Review Focus 3 test. This task implements it and tests only the orphaned-caller case.

- [ ] **Step 1: Write the failing runtime test**

Create `server/test/bots/engine.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createBotRuntime, createFakeClock } from '../../src/bots/runtime.js';
import { makeTestCtx } from '../helpers.js';

describe('bot runtime', () => {
  it('runs callbacks for the same chat one at a time, other chats in parallel, and survives a failure', async () => {
    const rt = createBotRuntime();
    const order: string[] = [];
    let release!: () => void;
    const first = rt.withChatLock('c1', async () => {
      order.push('a:start');
      await new Promise<void>((r) => { release = r; });
      order.push('a:end');
    });
    const failing = rt.withChatLock('c1', async () => { order.push('b'); throw new Error('x'); }).catch((e: Error) => e.message);
    const third = rt.withChatLock('c1', async () => { order.push('c'); return 3; });
    await rt.withChatLock('c2', async () => { order.push('other'); });
    expect(order).toEqual(['a:start', 'other']);
    release();
    await first;
    expect(await failing).toBe('x');
    expect(await third).toBe(3);
    expect(order).toEqual(['a:start', 'other', 'a:end', 'b', 'c']);
  });

  it('starts the fake clock on Wednesday 09:00 in Cuiabá and moves it only when told', () => {
    const clock = createFakeClock();
    expect(clock.now().toISOString()).toBe('2026-10-14T13:00:00.000Z');
    clock.advance(60_000);
    expect(clock.now().toISOString()).toBe('2026-10-14T13:01:00.000Z');
    clock.set(new Date('2026-10-15T00:00:00Z'));
    expect(clock.now().toISOString()).toBe('2026-10-15T00:00:00.000Z');
  });

  it('merges an injected registry over the default one, and makeTestCtx wires the fake clock', async () => {
    const note = { type: 'note' as const, run: async () => ({ next: 'next' }) };
    expect(createBotRuntime({ registry: { note } }).registry.note).toBe(note);
    const ctx = await makeTestCtx();
    ctx.clock.advance(5_000);
    expect(ctx.botRuntime.now()).toEqual(ctx.clock.now());
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w server -- test/bots/engine.test.ts`
Expected: FAIL. The suite cannot import `../../src/bots/runtime.js` (`Failed to load url … Does the file exist?`).

- [ ] **Step 3: Create `BlockError`, the registry types and the runtime**

Create `server/src/bots/block-error.ts`:

```ts
/** A block failure whose pt-BR message is shown in bot_failed.reason. Never put contact data (CPF, answers) in it. */
export class BlockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockError';
  }
}
```

Create `server/src/bots/registry.ts`:

```ts
import type { BlockType, BotNode, BotStopReason } from '@talk/shared';
import type { AppCtx } from '../ctx.js';
import type { ChatRow } from '../inbox/chats.js';
import type { MessageKind } from '../whatsapp/types.js';
import type { BotRunRow } from './repo.js';

// Block modules import BlockError from './block-error.js', never from here: this file imports the block
// families, so a runtime import back into it is an ESM cycle (TDZ ReferenceError on `...xBlocks`).
export { BlockError } from './block-error.js';

export interface InboundReply {
  messageId: string;
  kind: MessageKind;
  body: string | null;
  mediaMime: string | null;
  mediaName: string | null;
  createdAt: Date; // messages.created_at of the stored reply
}

export interface BotActor { botId: string; botName: string; runId: string }

export type ResumeEvent =
  | { kind: 'reply'; reply: InboundReply }
  | { kind: 'timeout' } // waiting_reply and timeout_at passed
  | { kind: 'timer' } // waiting_timer and wake_at passed
  | { kind: 'flow'; outcome: 'finished' | 'failed' | 'stopped' }; // child of call_flow ended

export type BlockResult =
  | { next: string } // handle id from outputsOf
  | { wait: 'reply'; timeoutAt: Date | null }
  | { wait: 'timer'; wakeAt: Date }
  | { wait: 'flow' }
  | { end: 'finished' }
  | { end: 'failed'; error: string };

export interface BotCtx {
  app: AppCtx;
  now: Date; // app.botRuntime.now() at step start
  chat: ChatRow; // fresh at step start; a block that changes the chat assigns the returned row back
  bot: { id: string; name: string };
  actor: BotActor;
  render(text: string): Promise<string>;
  lastInbound(): Promise<InboundReply | null>;
  startChild(botId: string): Promise<BotRunRow>;
  stopOtherRuns(chatId: string, reason: BotStopReason): Promise<void>;
}

/** Blocks may mutate run.vars and run.retries in place; the engine saves both with the step. Blocks never write bot_runs. */
export interface BlockDefinition {
  type: BlockType;
  run(ctx: BotCtx, run: BotRunRow, node: BotNode): Promise<BlockResult>;
  resume?(ctx: BotCtx, run: BotRunRow, node: BotNode, ev: ResumeEvent): Promise<BlockResult>;
}

export type BlockRegistry = Partial<Record<BlockType, BlockDefinition>>;

// Tasks 6–8 add `...conditionBlocks`, `...actionBlocks`, `...startBlocks`, `...finishBlocks` here.
export const defaultRegistry: BlockRegistry = {};
```

Create `server/src/bots/runtime.ts`:

```ts
import { defaultRegistry, type BlockRegistry } from './registry.js';

export interface BotRuntime {
  now(): Date;
  random(): number; // [0,1); distribute
  withChatLock<T>(chatId: string, fn: () => Promise<T>): Promise<T>; // in-process FIFO mutex per chat; NOT re-entrant
  registry: BlockRegistry;
}

export function createBotRuntime(opts: { now?: () => Date; random?: () => number; registry?: BlockRegistry } = {}): BotRuntime {
  // ponytail: in-process lock — single server process; use pg_advisory_xact_lock if the app ever runs >1 instance.
  const tails = new Map<string, Promise<unknown>>();
  return {
    now: opts.now ?? (() => new Date()),
    random: opts.random ?? Math.random,
    registry: { ...defaultRegistry, ...opts.registry },
    async withChatLock<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
      const result = (tails.get(chatId) ?? Promise.resolve()).then(fn);
      const tail = result.catch(() => undefined); // a failed holder must not block the queue
      tails.set(chatId, tail);
      try {
        return await result;
      } finally {
        if (tails.get(chatId) === tail) tails.delete(chatId);
      }
    },
  };
}

export interface FakeClock { now(): Date; set(d: Date): void; advance(ms: number): void }

/** Default 2026-10-14T13:00:00Z = Wednesday 09:00 America/Cuiaba. Closures, not `this`: `clock.now` is passed unbound. */
export function createFakeClock(start: Date = new Date('2026-10-14T13:00:00Z')): FakeClock {
  let t = start.getTime();
  return {
    now: () => new Date(t),
    set: (d) => { t = d.getTime(); },
    advance: (ms) => { t += ms; },
  };
}
```

- [ ] **Step 4: Put the runtime in the ctx, the boot code and the test helpers**

Replace `server/src/ctx.ts` with:

```ts
import type { BotRuntime } from './bots/runtime.js';
import type { Db } from './db/client.js';
import type { Config } from './config.js';
import type { Hub } from './realtime/hub.js';
import type { WhatsAppGateway } from './whatsapp/types.js';

export interface AppCtx {
  db: Db;
  config: Config;
  wa: WhatsAppGateway;
  hub: Hub;
  botRuntime: BotRuntime;
}
```

In `server/src/index.ts`, add the import after `import { failInterruptedSends } from './messages/send.js';`:

```ts
import { createBotRuntime } from './bots/runtime.js';
```

and replace the ctx literal

```ts
const ctx: AppCtx = {
  db,
  wa: createEvolutionGateway(config.evolution),
  hub: createHub(() => db),
  config,
};
```

with

```ts
const ctx: AppCtx = {
  db,
  wa: createEvolutionGateway(config.evolution),
  hub: createHub(() => db),
  config,
  botRuntime: createBotRuntime(),
};
```

In `server/test/helpers.ts`, add the import after `import { createFakeGateway } from '../src/whatsapp/fake.js';`:

```ts
import { createBotRuntime, createFakeClock, type FakeClock } from '../src/bots/runtime.js';
```

and replace the whole `makeTestCtx` function with:

```ts
// Fresh in-memory DB, fake gateway, recording hub, fake clock and test config per call.
export async function makeTestCtx(): Promise<
  AppCtx & { wa: ReturnType<typeof createFakeGateway>; hub: ReturnType<typeof createRecordingHub>; clock: FakeClock }
> {
  const db = await createTestDb();
  const config: Config = {
    port: 0,
    databaseUrl: 'pglite://memory',
    appOrigin: TEST_ORIGIN,
    cookieSecure: false,
    webhookSecret: 'test-webhook-secret-0123456789abcdef',
    webhookBaseUrl: 'http://app:3000',
    mediaDir: await mkdtemp(join(tmpdir(), 'talk-media-')),
    webDistDir: null,
    evolution: { url: 'http://evolution.test', apiKey: 'test-key' },
    sessionDays: 30,
  };
  const clock = createFakeClock();
  return { db, wa: createFakeGateway(), hub: createRecordingHub(), config, clock, botRuntime: createBotRuntime({ now: clock.now }) };
}
```

- [ ] **Step 5: Run the runtime tests, the whole server suite and the typecheck**

Run: `npm test -w server -- test/bots/engine.test.ts`
Expected: PASS (3 tests).

Run: `npm test -w server`
Expected: PASS. Every existing suite still passes. The `{ ...base, hub }` spread in `ws.test.ts` and the `as AppCtx` cast in `app.test.ts` keep compiling.

Run: `npm run typecheck -w server`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add server/src/bots/block-error.ts server/src/bots/registry.ts server/src/bots/runtime.ts server/src/ctx.ts server/src/index.ts server/test/helpers.ts server/test/bots/engine.test.ts
git commit -m "feat(server): bot runtime with chat lock, fake clock and block registry types

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Write the failing engine tests**

Replace `server/test/bots/engine.test.ts` with the full file below. The runtime tests from Step 1 stay unchanged at the top.

```ts
import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STEP_LOG_LIMIT, type BlockType, type BotGraph } from '@talk/shared';
import {
  failInterruptedRuns,
  resumeOnReply,
  resumeOnTimer,
  runningRunsForChat,
  startRun,
  stopRun,
  stopRunsForChat,
} from '../../src/bots/engine.js';
import { BlockError, type BlockRegistry, type InboundReply } from '../../src/bots/registry.js';
import { createBot, insertBotVersion, type BotRunRow } from '../../src/bots/repo.js';
import { createBotRuntime, createFakeClock } from '../../src/bots/runtime.js';
import { botRuns, bots, chats, contacts } from '../../src/db/schema.js';
import { makeTestCtx, seedBasics, type Seeded } from '../helpers.js';
import { eventsOf, insertChat, statusOf } from '../inbox/fixtures.js';

describe('bot runtime', () => {
  it('runs callbacks for the same chat one at a time, other chats in parallel, and survives a failure', async () => {
    const rt = createBotRuntime();
    const order: string[] = [];
    let release!: () => void;
    const first = rt.withChatLock('c1', async () => {
      order.push('a:start');
      await new Promise<void>((r) => { release = r; });
      order.push('a:end');
    });
    const failing = rt.withChatLock('c1', async () => { order.push('b'); throw new Error('x'); }).catch((e: Error) => e.message);
    const third = rt.withChatLock('c1', async () => { order.push('c'); return 3; });
    await rt.withChatLock('c2', async () => { order.push('other'); });
    expect(order).toEqual(['a:start', 'other']);
    release();
    await first;
    expect(await failing).toBe('x');
    expect(await third).toBe(3);
    expect(order).toEqual(['a:start', 'other', 'a:end', 'b', 'c']);
  });

  it('starts the fake clock on Wednesday 09:00 in Cuiabá and moves it only when told', () => {
    const clock = createFakeClock();
    expect(clock.now().toISOString()).toBe('2026-10-14T13:00:00.000Z');
    clock.advance(60_000);
    expect(clock.now().toISOString()).toBe('2026-10-14T13:01:00.000Z');
    clock.set(new Date('2026-10-15T00:00:00Z'));
    expect(clock.now().toISOString()).toBe('2026-10-15T00:00:00.000Z');
  });

  it('merges an injected registry over the default one, and makeTestCtx wires the fake clock', async () => {
    const note = { type: 'note' as const, run: async () => ({ next: 'next' }) };
    expect(createBotRuntime({ registry: { note } }).registry.note).toBe(note);
    const ctx = await makeTestCtx();
    ctx.clock.advance(5_000);
    expect(ctx.botRuntime.now()).toEqual(ctx.clock.now());
  });
});

// ---------- stub blocks: real type names, fake behavior ----------
const HOUR = 3_600_000;
const calls: string[] = [];
const stubs: BlockRegistry = {
  start_channel: { type: 'start_channel', run: async () => ({ next: 'next' }) },
  start_manual: { type: 'start_manual', run: async () => ({ next: 'next' }) },
  note: { type: 'note', run: async (_c, _r, n) => { calls.push(n.id); return { next: 'next' }; } },
  condition: { type: 'condition', run: async () => ({ next: 'yes' }) },
  ask_input: {
    type: 'ask_input',
    run: async (c, _r, n) => {
      calls.push(`ask:${n.id}`);
      const h = Number(n.config.timeoutHours ?? 0);
      return { wait: 'reply', timeoutAt: h > 0 ? new Date(c.now.getTime() + h * HOUR) : null };
    },
    resume: async (_c, run, n, ev) => {
      if (ev.kind === 'timeout') return { next: 'timeout' };
      if (ev.kind !== 'reply') throw new BlockError('Evento inesperado');
      run.vars[n.name ?? n.id] = { raw: ev.reply.body ?? '', value: ev.reply.body ?? '' };
      return { next: 'next' };
    },
  },
  wait_interval: {
    type: 'wait_interval',
    run: async (c) => ({ wait: 'timer', wakeAt: new Date(c.now.getTime() + 60_000) }),
    resume: async () => ({ next: 'next' }),
  },
  transfer_sector: { type: 'transfer_sector', run: async () => { throw new BlockError('Setor inexistente'); } },
  privacy: { type: 'privacy', run: async () => { throw new Error('detalhe interno 123.456.789-00'); } },
  call_flow: {
    type: 'call_flow',
    run: async (c, _r, n) => {
      const child = await c.startChild(String(n.config.botId));
      if (!n.config.continueAfter) return { end: 'finished' };
      if (child.state === 'finished') return { next: 'next' };
      if (child.state === 'failed' || child.state === 'stopped') throw new BlockError('O fluxo acionado não terminou');
      return { wait: 'flow' };
    },
    resume: async (_c, _r, _n, ev) => {
      if (ev.kind === 'flow' && ev.outcome === 'finished') return { next: 'next' };
      throw new BlockError('O fluxo acionado não terminou');
    },
  },
};

type N = [id: string, type: BlockType, config?: Record<string, unknown>];
function graph(nodes: N[], edges: Array<[source: string, handle: string, target: string]>): BotGraph {
  return {
    nodes: nodes.map(([id, type, config = {}]) => ({ id, type, name: id, position: { x: 0, y: 0 }, config })),
    edges: edges.map(([source, sourceHandle, target], i) => ({ id: `e${i}`, source, sourceHandle, target })),
  };
}
const askGraph = () =>
  graph([['inicio', 'start_channel'], ['cpf', 'ask_input'], ['fim', 'note']], [['inicio', 'next', 'cpf'], ['cpf', 'next', 'fim']]);
const timerGraph = () =>
  graph([['inicio', 'start_channel'], ['espera', 'wait_interval'], ['depois', 'note']], [['inicio', 'next', 'espera'], ['espera', 'next', 'depois']]);

describe('bot engine', () => {
  let ctx: Awaited<ReturnType<typeof makeTestCtx>>;
  let s: Seeded;
  let chatId: string;

  beforeEach(async () => {
    calls.length = 0;
    ctx = await makeTestCtx();
    ctx.botRuntime = createBotRuntime({ now: ctx.clock.now, registry: stubs });
    s = await seedBasics(ctx);
    chatId = await insertChat(ctx, { channelId: s.channelId, sectorId: s.defaultSector });
  });

  async function activeBot(name: string, g: BotGraph): Promise<string> {
    const bot = await createBot(ctx.db, { name, graph: g, valid: true, publish: true, createdBy: null });
    await ctx.db.update(bots).set({ status: 'active' }).where(eq(bots.id, bot.id));
    return bot.id;
  }
  async function runRow(id: string): Promise<BotRunRow> {
    const [row] = await ctx.db.select().from(botRuns).where(eq(botRuns.id, id));
    return row;
  }
  const reply = (body: string | null, createdAt: Date): InboundReply => ({
    messageId: randomUUID(), kind: body === null ? 'sticker' : 'text', body, mediaMime: null, mediaName: null, createdAt,
  });
  /** A reply stored right after the run started waiting. */
  const after = (r: BotRunRow) => new Date(r.waitingSince!.getTime() + 1);
  const start = (botId: string) => startRun(ctx, { botId, chatId, entry: 'channel', startedBy: null });

  async function startParentAndChild(): Promise<{ parent: BotRunRow; child: BotRunRow; parentId: string; childId: string }> {
    const childId = await activeBot('Filho', graph(
      [['inicio', 'start_manual'], ['pergunta', 'ask_input'], ['filho_fim', 'note']],
      [['inicio', 'next', 'pergunta'], ['pergunta', 'next', 'filho_fim']],
    ));
    const parentId = await activeBot('Pai', graph(
      [['inicio', 'start_channel'], ['sub', 'call_flow', { botId: childId, continueAfter: true }], ['volta', 'note']],
      [['inicio', 'next', 'sub'], ['sub', 'next', 'volta']],
    ));
    const parent = await start(parentId);
    const child = (await runningRunsForChat(ctx.db, chatId)).find((r) => r.botId === childId)!;
    return { parent, child, parentId, childId };
  }

  it('runs blocks in order, saves each step and finishes on an unconnected output', async () => {
    const botId = await activeBot('Simples', graph(
      [['inicio', 'start_channel'], ['a', 'note'], ['b', 'note']],
      [['inicio', 'next', 'a'], ['a', 'next', 'b']],
    ));
    const [before] = await ctx.db.select().from(bots).where(eq(bots.id, botId));
    const run = await start(botId);
    expect(run.state).toBe('finished');
    expect(run.finishedAt).toEqual(ctx.clock.now());
    expect(run.steps.map((st) => [st.node, st.outcome])).toEqual([['inicio', 'next'], ['a', 'next'], ['b', 'next']]);
    expect(run.steps[0].at).toBe(ctx.clock.now().toISOString());
    expect(calls).toEqual(['a', 'b']);
    const [bot] = await ctx.db.select().from(bots).where(eq(bots.id, botId));
    expect(bot.runCount).toBe(1);
    expect(bot.updatedAt).toEqual(before.updatedAt); // a run is not an edit of the bot
    const events = await eventsOf(ctx, chatId);
    expect(events.map((e) => e.kind)).toEqual(['bot_started', 'bot_finished']);
    expect(events[1]).toMatchObject({ authorId: null, data: { botId, botName: 'Simples', runId: run.id } });
    expect(ctx.hub.events.filter((e) => e.type === 'chat' && e.chatId === chatId)).toHaveLength(2);
  });

  it('waits for a reply, keeps the answer in vars and resumes with it', async () => {
    const waiting = await start(await activeBot('Pergunta', askGraph()));
    expect(waiting).toMatchObject({ state: 'waiting_reply', waitNodeId: 'cpf', currentNodeId: 'cpf', timeoutAt: null, wakeAt: null });
    expect(waiting.waitingSince).toBeInstanceOf(Date);
    expect(await resumeOnReply(ctx, chatId, reply('123', after(waiting)))).toBe(1);
    const done = await runRow(waiting.id);
    expect(done.state).toBe('finished');
    expect(done.vars).toEqual({ cpf: { raw: '123', value: '123' } });
    expect(calls).toEqual(['ask:cpf', 'fim']);
  });

  it('ignores a reply that was stored before the wait began', async () => {
    const waiting = await start(await activeBot('Pergunta', askGraph()));
    const early = new Date(waiting.waitingSince!.getTime() - 1); // "preciso de ajuda" arrived while the menu was being sent
    expect(await resumeOnReply(ctx, chatId, reply('preciso de ajuda', early))).toBe(0);
    expect((await runRow(waiting.id)).state).toBe('waiting_reply');
    expect(calls).toEqual(['ask:cpf']);
  });

  it('serializes two simultaneous replies: the second predates the next question and is ignored', async () => {
    const botId = await activeBot('Duas', graph(
      [['inicio', 'start_channel'], ['a', 'ask_input'], ['b', 'ask_input']],
      [['inicio', 'next', 'a'], ['a', 'next', 'b']],
    ));
    const waiting = await start(botId);
    const at = waiting.waitingSince!;
    const [n1, n2] = await Promise.all([
      resumeOnReply(ctx, chatId, reply('primeira', at)),
      resumeOnReply(ctx, chatId, reply('segunda', at)),
    ]);
    expect(n1 + n2).toBe(1);
    const run = await runRow(waiting.id);
    expect(run).toMatchObject({ state: 'waiting_reply', waitNodeId: 'b' });
    expect(run.vars).toEqual({ a: { raw: 'primeira', value: 'primeira' } });
  });

  it('times out a reply wait from the clock and follows the timeout output', async () => {
    const botId = await activeBot('Prazo', graph(
      [['inicio', 'start_channel'], ['q', 'ask_input', { timeoutHours: 1 }], ['sem_resposta', 'note']],
      [['inicio', 'next', 'q'], ['q', 'timeout', 'sem_resposta']],
    ));
    const waiting = await start(botId);
    expect(waiting.timeoutAt).toEqual(new Date(ctx.clock.now().getTime() + HOUR));
    expect(await resumeOnTimer(ctx, waiting.id, ctx.clock.now())).toBeNull(); // not due yet
    ctx.clock.advance(HOUR);
    const done = await resumeOnTimer(ctx, waiting.id, ctx.clock.now());
    expect(done?.state).toBe('finished');
    expect(calls).toEqual(['ask:q', 'sem_resposta']);
    expect(await resumeOnTimer(ctx, waiting.id, ctx.clock.now())).toBeNull(); // already finished
  });

  it('sleeps on a timer and continues when it is due', async () => {
    const waiting = await start(await activeBot('Espera', timerGraph()));
    expect(waiting).toMatchObject({ state: 'waiting_timer', waitNodeId: 'espera', wakeAt: new Date(ctx.clock.now().getTime() + 60_000) });
    expect(await resumeOnTimer(ctx, waiting.id, ctx.clock.now())).toBeNull();
    ctx.clock.advance(60_000);
    const done = await resumeOnTimer(ctx, waiting.id, ctx.clock.now());
    expect(done).toMatchObject({ state: 'finished', wakeAt: null });
    expect(calls).toEqual(['depois']);
  });

  it('stops instead of sending when the chat was closed while waiting', async () => {
    const waiting = await start(await activeBot('Espera', timerGraph()));
    await ctx.db.update(chats).set({ state: 'closed', closedAt: new Date() }).where(eq(chats.id, chatId));
    ctx.clock.advance(60_000);
    const run = await resumeOnTimer(ctx, waiting.id, ctx.clock.now());
    expect(run).toMatchObject({ state: 'stopped', error: null, wakeAt: null });
    expect(calls).toEqual([]);
    expect(ctx.wa.sent).toEqual([]);
    const stopped = (await eventsOf(ctx, chatId)).find((e) => e.kind === 'bot_stopped');
    expect(stopped).toMatchObject({ authorId: null, data: { reason: 'chat_closed', by: null } });
  });

  it('stops with contact_blocked when the contact was blocked while waiting', async () => {
    const waiting = await start(await activeBot('Pergunta', askGraph()));
    const [chat] = await ctx.db.select().from(chats).where(eq(chats.id, chatId));
    await ctx.db.update(contacts).set({ blocked: true }).where(eq(contacts.id, chat.contactId));
    expect(await resumeOnReply(ctx, chatId, reply('123', after(waiting)))).toBe(1);
    expect((await runRow(waiting.id)).state).toBe('stopped');
    expect(calls).toEqual(['ask:cpf']);
    const stopped = (await eventsOf(ctx, chatId)).find((e) => e.kind === 'bot_stopped');
    expect(stopped?.data).toMatchObject({ reason: 'contact_blocked' });
  });

  it('follows the error output when a block throws and the output is connected', async () => {
    const botId = await activeBot('Plano B', graph(
      [['inicio', 'start_channel'], ['setor', 'transfer_sector'], ['plano_b', 'note']],
      [['inicio', 'next', 'setor'], ['setor', 'error', 'plano_b']],
    ));
    const run = await start(botId);
    expect(run.state).toBe('finished');
    expect(run.steps.map((st) => st.outcome)).toEqual(['next', 'error', 'next']);
    expect(calls).toEqual(['plano_b']);
    expect((await eventsOf(ctx, chatId)).map((e) => e.kind)).toEqual(['bot_started', 'bot_finished']);
  });

  it('fails with the BlockError message when the error output is not connected', async () => {
    const botId = await activeBot('Sem plano', graph(
      [['inicio', 'start_channel'], ['setor', 'transfer_sector']],
      [['inicio', 'next', 'setor']],
    ));
    const run = await start(botId);
    expect(run).toMatchObject({ state: 'failed', error: 'Setor inexistente' });
    expect(run.steps.map((st) => [st.node, st.outcome])).toEqual([['inicio', 'next'], ['setor', 'failed']]);
    const failed = (await eventsOf(ctx, chatId)).find((e) => e.kind === 'bot_failed');
    expect(failed?.data).toMatchObject({ botName: 'Sem plano', reason: 'Setor inexistente' });
  });

  it('hides an unexpected error behind the block label and never logs its message', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const botId = await activeBot('Quebra', graph(
        [['inicio', 'start_channel'], ['priv', 'privacy']],
        [['inicio', 'next', 'priv']],
      ));
      const run = await start(botId);
      expect(run).toMatchObject({ state: 'failed', error: 'Erro inesperado no bloco "Privacidade"' });
      expect(spy).toHaveBeenCalled();
      expect(JSON.stringify(spy.mock.calls)).not.toContain('123.456.789-00');
    } finally {
      spy.mockRestore();
    }
  });

  it('fails a run that takes 50 steps without waiting', async () => {
    const botId = await activeBot('Laço', graph(
      [['inicio', 'start_channel'], ['x', 'condition'], ['y', 'condition']],
      [['inicio', 'next', 'x'], ['x', 'yes', 'y'], ['y', 'yes', 'x']],
    ));
    const run = await start(botId);
    expect(run).toMatchObject({ state: 'failed', error: 'Limite de 50 passos sem espera (possível laço)' });
    expect(run.steps).toHaveLength(STEP_LOG_LIMIT);
  });

  it('fails on a block type without a definition', async () => {
    ctx.botRuntime = createBotRuntime({ now: ctx.clock.now, registry: { ...stubs, tags: undefined } });
    const botId = await activeBot('Sem bloco', graph([['inicio', 'start_channel'], ['et', 'tags']], [['inicio', 'next', 'et']]));
    expect(await start(botId)).toMatchObject({ state: 'failed', error: 'Bloco não suportado' });
  });

  it('refuses a duplicate start, a paused bot and a missing start type', async () => {
    const botId = await activeBot('Pergunta', askGraph());
    await start(botId);
    expect(await statusOf(start(botId))).toBe(409);
    expect(await statusOf(startRun(ctx, { botId, chatId, entry: 'manual', startedBy: s.admin.id }))).toBe(400);
    const paused = await createBot(ctx.db, { name: 'Pausado', graph: askGraph(), valid: true, publish: true, createdBy: null });
    expect(await statusOf(start(paused.id))).toBe(400);
    expect(await runningRunsForChat(ctx.db, chatId)).toHaveLength(1);
    const [bot] = await ctx.db.select().from(bots).where(eq(bots.id, botId));
    expect(bot.runCount).toBe(1);
  });

  it('keeps a run on the version it started with, even after the bot is paused', async () => {
    const botId = await activeBot('Versão', askGraph());
    const waiting = await start(botId);
    const v2 = await insertBotVersion(ctx.db, {
      botId,
      graph: graph([['inicio', 'start_channel'], ['cpf', 'ask_input'], ['outro', 'note']], [['inicio', 'next', 'cpf'], ['cpf', 'next', 'outro']]),
      valid: true,
      createdBy: null,
    });
    await ctx.db.update(bots).set({ publishedVersionId: v2.id, status: 'paused' }).where(eq(bots.id, botId));
    await resumeOnReply(ctx, chatId, reply('x', after(waiting)));
    expect(calls).toEqual(['ask:cpf', 'fim']);
    const otherChat = await insertChat(ctx, { channelId: s.channelId, sectorId: s.defaultSector });
    expect(await statusOf(startRun(ctx, { botId, chatId: otherChat, entry: 'channel', startedBy: null }))).toBe(400);
  });

  it('runs a called flow and resumes the caller when the child finishes', async () => {
    const { parent, child, parentId, childId } = await startParentAndChild();
    expect(parent.state).toBe('waiting_flow');
    expect(child).toMatchObject({ parentRunId: parent.id, depth: 1, state: 'waiting_reply' });
    expect(await resumeOnReply(ctx, chatId, reply('oi', after(child)))).toBe(1); // the waiting_flow parent is skipped
    expect((await runRow(child.id)).state).toBe('finished');
    expect((await runRow(parent.id)).state).toBe('finished');
    expect(calls).toEqual(['ask:pergunta', 'filho_fim', 'volta']);
    const counts = await ctx.db.select({ id: bots.id, runCount: bots.runCount }).from(bots);
    expect(Object.fromEntries(counts.map((b) => [b.id, b.runCount]))).toEqual({ [parentId]: 1, [childId]: 1 });
  });

  it('fails call_flow past 5 chained levels', async () => {
    const botId = await activeBot('Recursivo', graph([['inicio', 'start_channel']], []));
    const v = await insertBotVersion(ctx.db, {
      botId,
      graph: graph([['inicio', 'start_channel'], ['de_novo', 'call_flow', { botId, continueAfter: true }]], [['inicio', 'next', 'de_novo']]),
      valid: true,
      createdBy: null,
    });
    await ctx.db.update(bots).set({ publishedVersionId: v.id }).where(eq(bots.id, botId));
    const root = await start(botId);
    const all = await ctx.db.select().from(botRuns).where(eq(botRuns.chatId, chatId)).orderBy(asc(botRuns.depth));
    expect(all.map((r) => [r.depth, r.state])).toEqual([[0, 'failed'], [1, 'failed'], [2, 'failed'], [3, 'failed'], [4, 'failed']]);
    expect(all[4].error).toBe('Limite de 5 fluxos encadeados');
    expect(root).toMatchObject({ state: 'failed', error: 'O fluxo acionado não terminou' });
  });

  it('stopRun stops the whole chain, is idempotent, and a stopped run ignores later replies', async () => {
    const { parent, child } = await startParentAndChild();
    const stopped = await stopRun(ctx, child.id, { userId: s.admin.id, reason: 'manual' });
    expect(stopped).toMatchObject({ state: 'stopped', waitingSince: null });
    expect((await runRow(parent.id)).state).toBe('stopped');
    const evs = (await eventsOf(ctx, chatId)).filter((e) => e.kind === 'bot_stopped');
    expect(evs).toHaveLength(2);
    for (const e of evs) expect(e).toMatchObject({ authorId: s.admin.id, data: { reason: 'manual', by: s.admin.id } });
    expect(await resumeOnReply(ctx, chatId, reply('oi', after(child)))).toBe(0);
    expect(await runningRunsForChat(ctx.db, chatId)).toEqual([]);
    expect((await stopRun(ctx, child.id, { userId: s.admin.id, reason: 'manual' })).state).toBe('stopped');
    expect((await eventsOf(ctx, chatId)).filter((e) => e.kind === 'bot_stopped')).toHaveLength(2);
    expect(await statusOf(stopRun(ctx, randomUUID(), { userId: null, reason: 'manual' }))).toBe(404);
  });

  it('stopRunsForChat stops every running bot of the chat except the excepted runs', async () => {
    const a = await start(await activeBot('A', askGraph()));
    const b = await start(await activeBot('B', askGraph()));
    const stopped = await stopRunsForChat(ctx, chatId, { userId: null, reason: 'chat_closed' }, { exceptRunIds: [b.id] });
    expect(stopped.map((r) => r.id)).toEqual([a.id]);
    expect((await runningRunsForChat(ctx.db, chatId)).map((r) => r.id)).toEqual([b.id]);
  });

  it('failInterruptedRuns also fails a caller left waiting for an interrupted child', async () => {
    const { parent, child } = await startParentAndChild();
    await ctx.db.update(botRuns).set({ state: 'running' }).where(eq(botRuns.id, child.id)); // the server died mid-step of the child
    expect(await failInterruptedRuns(ctx.db)).toBe(2);
    expect(await runRow(child.id)).toMatchObject({ state: 'failed', error: 'Interrompido por reinício do servidor' });
    expect(await runRow(parent.id)).toMatchObject({ state: 'failed', error: 'Interrompido por reinício do servidor' });
    expect((await eventsOf(ctx, chatId)).filter((e) => e.kind === 'bot_failed')).toHaveLength(2);
    expect(await runningRunsForChat(ctx.db, chatId)).toEqual([]);
  });
});
```

- [ ] **Step 8: Run the tests to verify they fail**

Run: `npm test -w server -- test/bots/engine.test.ts`
Expected: FAIL. The suite cannot import `../../src/bots/engine.js` (`Failed to load url … Does the file exist?`).

- [ ] **Step 9: Write the engine**

Create `server/src/bots/engine.ts`:

```ts
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import {
  MAX_FLOW_LEVELS,
  MAX_STEPS_PER_CALL,
  NON_TERMINAL_RUN_STATES,
  STEP_LOG_LIMIT,
  catalogEntry,
  outputsOf,
  type BotEventData,
  type BotNode,
  type BotRunStep,
  type BotStopReason,
} from '@talk/shared';
import type { AppCtx } from '../ctx.js';
import type { Db, Tx } from '../db/client.js';
import { botRuns, bots, chats, contacts, messages } from '../db/schema.js';
import { addEvent, type ChatEventKind } from '../inbox/events.js';
import { badRequest, conflict, notFound } from '../lib/http-error.js';
import { BlockError } from './block-error.js';
import { startNodeOf } from './graph.js';
import type { BlockResult, BotCtx, InboundReply, ResumeEvent } from './registry.js';
import { getBot, getVersionRow, type BotRunRow } from './repo.js';
import { loadBotTextVars, renderBotText } from './variables.js';

const ACTIVE = [...NON_TERMINAL_RUN_STATES];
type Terminal = 'finished' | 'failed' | 'stopped';
type BotRef = { id: string; name: string };

export interface StartRunInput {
  botId: string;
  chatId: string;
  entry: 'channel' | 'manual' | 'call';
  startedBy: string | null;
  parentRunId?: string | null;
  depth?: number;
}

/** Engine rule 1. Takes the chat lock, then runs the new run to its first wait or end. */
export async function startRun(ctx: AppCtx, input: StartRunInput): Promise<BotRunRow> {
  return ctx.botRuntime.withChatLock(input.chatId, () => startRunLocked(ctx, input));
}

/** startRun without the lock: startChild runs inside a step, which already holds it (the lock is not re-entrant). */
async function startRunLocked(ctx: AppCtx, input: StartRunInput): Promise<BotRunRow> {
  const depth = input.depth ?? 0;
  if (input.entry === 'call' && depth >= MAX_FLOW_LEVELS) throw new BlockError(`Limite de ${MAX_FLOW_LEVELS} fluxos encadeados`);
  const bot = await getBot(ctx.db, input.botId);
  const version = bot.status === 'active' && bot.publishedVersionId ? await getVersionRow(ctx.db, bot.publishedVersionId) : null;
  if (!version) throw badRequest('Este chatbot não está ativo');
  const startNode = startNodeOf(version.graph, input.entry);
  if (!startNode) throw badRequest('Este chatbot não tem esse tipo de início');
  const [chat] = await ctx.db.select().from(chats).where(eq(chats.id, input.chatId));
  if (!chat) throw notFound('Conversa não encontrada');
  if (input.entry !== 'call') {
    // ponytail: check-then-insert is safe under the in-process chat lock; the partial unique index backs it up (500) if not.
    const [busy] = await ctx.db
      .select({ id: botRuns.id })
      .from(botRuns)
      .where(and(eq(botRuns.chatId, chat.id), eq(botRuns.botId, bot.id), eq(botRuns.depth, 0), inArray(botRuns.state, ACTIVE)))
      .limit(1);
    if (busy) throw conflict('Este chatbot já está em execução nesta conversa');
  }
  const run = await ctx.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(botRuns)
      .values({
        botId: bot.id,
        versionId: version.id,
        chatId: chat.id,
        contactId: chat.contactId,
        state: 'running',
        currentNodeId: startNode.id,
        depth,
        parentRunId: input.parentRunId ?? null,
        startedBy: input.startedBy,
      })
      .returning();
    // keep updated_at: a run is not an edit of the bot ("atualizado em" in the list)
    await tx.update(bots).set({ runCount: sql`${bots.runCount} + 1`, updatedAt: sql`${bots.updatedAt}` }).where(eq(bots.id, bot.id));
    await addEvent(tx, chat.id, 'bot_started', eventData(bot, row.id), null);
    return row;
  });
  await ctx.hub.publishChat(chat.id);
  return step(ctx, run.id);
}

/** Engine rule 2: the step loop. The caller holds the chat lock. Returns the run as saved last. */
export async function step(ctx: AppCtx, runId: string, resume?: ResumeEvent): Promise<BotRunRow> {
  let run = await loadRun(ctx.db, runId);
  if (run.state !== 'running') return run;
  const botRow = await getBot(ctx.db, run.botId);
  const bot: BotRef = { id: botRow.id, name: botRow.name };
  const [chat] = await ctx.db.select().from(chats).where(eq(chats.id, run.chatId));
  const [contact] = await ctx.db.select({ blocked: contacts.blocked }).from(contacts).where(eq(contacts.id, run.contactId));
  // Review Focus 2: a chat closed or a contact blocked elsewhere while the run waited gets nothing more from the bot
  if (chat.state !== 'open') return finishRun(ctx, run, bot, 'stopped', { reason: 'chat_closed' });
  if (contact.blocked) return finishRun(ctx, run, bot, 'stopped', { reason: 'contact_blocked' });
  const version = await getVersionRow(ctx.db, run.versionId);
  if (!version) return finishRun(ctx, run, bot, 'failed', { error: 'Versão do chatbot não encontrada' });
  const { nodes, edges } = version.graph;
  const edgeFrom = (nodeId: string, handle: string) => edges.find((e) => e.source === nodeId && e.sourceHandle === handle);

  const bctx: BotCtx = {
    app: ctx,
    now: ctx.botRuntime.now(),
    chat,
    bot,
    actor: { botId: bot.id, botName: bot.name, runId: run.id },
    render: async (text) => renderBotText(text, await loadBotTextVars(ctx.db, bctx.chat, run.vars)),
    lastInbound: () => lastInbound(ctx.db, run.chatId),
    startChild: (botId) =>
      startRunLocked(ctx, { botId, chatId: run.chatId, entry: 'call', startedBy: run.startedBy, parentRunId: run.id, depth: run.depth + 1 }),
    stopOtherRuns: async (otherChatId, reason) => {
      await stopRunsForChat(ctx, otherChatId, { userId: null, reason }, { exceptRunIds: await chainIds(ctx.db, run) });
    },
  };
  const at = bctx.now.toISOString();

  for (let i = 0; i < MAX_STEPS_PER_CALL; i++) {
    const node = nodes.find((n) => n.id === run.currentNodeId);
    if (!node) return finishRun(ctx, run, bot, 'failed', { error: 'Bloco não encontrado' });
    const def = ctx.botRuntime.registry[node.type];
    if (!def) return finishRun(ctx, run, bot, 'failed', { error: 'Bloco não suportado' }, { node: node.id, at, outcome: 'failed' });

    let result: BlockResult;
    let outcome: string | null = null;
    try {
      const ev = i === 0 ? resume : undefined;
      if (ev && !def.resume) throw new BlockError('Bloco não suportado');
      result = ev && def.resume ? await def.resume(bctx, run, node, ev) : await def.run(bctx, run, node);
    } catch (err) {
      const error = blockErrorMessage(err, run, node);
      if (outputsOf(node.type, node.config).some((o) => o.id === 'error') && edgeFrom(node.id, 'error')) {
        result = { next: 'error' };
        outcome = 'error';
      } else {
        result = { end: 'failed', error };
      }
    }

    if ('next' in result) {
      const s: BotRunStep = { node: node.id, at, outcome: outcome ?? result.next };
      const edge = edgeFrom(node.id, result.next);
      if (!edge) return finishRun(ctx, run, bot, 'finished', {}, s); // unconnected output = end of the flow
      run.retries = 0;
      const saved = await saveStep(ctx.db, run, s, { currentNodeId: edge.target, waitNodeId: null, wakeAt: null, timeoutAt: null, waitingSince: null });
      if (!saved) return loadRun(ctx.db, run.id); // stopped meanwhile: end silently
      run = saved;
      continue;
    }
    if ('wait' in result) {
      const set: PgUpdateSetSource<typeof botRuns> =
        result.wait === 'reply'
          ? { state: 'waiting_reply', waitNodeId: node.id, timeoutAt: result.timeoutAt, wakeAt: null, waitingSince: sql`clock_timestamp()` }
          : result.wait === 'timer'
            ? { state: 'waiting_timer', waitNodeId: node.id, wakeAt: result.wakeAt, timeoutAt: null, waitingSince: null }
            : { state: 'waiting_flow', waitNodeId: node.id, wakeAt: null, timeoutAt: null, waitingSince: null };
      return (await saveStep(ctx.db, run, { node: node.id, at, outcome: `wait:${result.wait}` }, set)) ?? loadRun(ctx.db, run.id);
    }
    return finishRun(ctx, run, bot, result.end, result.end === 'failed' ? { error: result.error } : {}, { node: node.id, at, outcome: result.end });
  }
  return finishRun(ctx, run, bot, 'failed', { error: `Limite de ${MAX_STEPS_PER_CALL} passos sem espera (possível laço)` });
}

/** Engine rule 4. Returns how many runs the reply resumed. */
export async function resumeOnReply(ctx: AppCtx, chatId: string, reply: InboundReply): Promise<number> {
  return ctx.botRuntime.withChatLock(chatId, async () => {
    // waiting_flow parents are not listed: their child gets the reply
    const waiting = await ctx.db
      .select({ id: botRuns.id })
      .from(botRuns)
      .where(and(eq(botRuns.chatId, chatId), eq(botRuns.state, 'waiting_reply')))
      .orderBy(asc(botRuns.createdAt));
    let resumed = 0;
    for (const { id } of waiting) {
      const due = await ctx.db.transaction(async (tx) => {
        const [r] = await tx.select().from(botRuns).where(eq(botRuns.id, id)).for('update');
        // Review Focus 1: a reply stored before the question went out is not its answer.
        // ponytail: compared in JS ms; a reply stored in the same millisecond the wait began counts as an answer.
        if (!r || r.state !== 'waiting_reply' || !r.waitingSince || reply.createdAt.getTime() < r.waitingSince.getTime()) return false;
        await tx.update(botRuns).set({ state: 'running' }).where(eq(botRuns.id, id));
        return true;
      });
      if (!due) continue;
      await step(ctx, id, { kind: 'reply', reply });
      resumed += 1;
    }
    return resumed;
  });
}

/** Engine rule 5. null = the run is no longer due (already resumed, stopped, or not yet time). */
export async function resumeOnTimer(ctx: AppCtx, runId: string, now: Date): Promise<BotRunRow | null> {
  const [found] = await ctx.db.select({ chatId: botRuns.chatId }).from(botRuns).where(eq(botRuns.id, runId));
  if (!found) return null;
  return ctx.botRuntime.withChatLock(found.chatId, async () => {
    const ev = await ctx.db.transaction(async (tx): Promise<ResumeEvent | null> => {
      const [r] = await tx.select().from(botRuns).where(eq(botRuns.id, runId)).for('update');
      if (!r) return null;
      const e: ResumeEvent | null =
        r.state === 'waiting_timer' && r.wakeAt && r.wakeAt.getTime() <= now.getTime()
          ? { kind: 'timer' }
          : r.state === 'waiting_reply' && r.timeoutAt && r.timeoutAt.getTime() <= now.getTime()
            ? { kind: 'timeout' }
            : null;
      if (e) await tx.update(botRuns).set({ state: 'running' }).where(eq(botRuns.id, runId));
      return e;
    });
    return ev ? step(ctx, runId, ev) : null;
  });
}

/** Engine rule 6. No lock: a step in flight fails its conditional save and exits. Idempotent. */
export async function stopRun(
  ctx: AppCtx,
  runId: string,
  by: { userId: string | null; reason: BotStopReason },
): Promise<BotRunRow> {
  const run = await loadRun(ctx.db, runId);
  await stopRuns(ctx, await chainIds(ctx.db, run), by);
  return loadRun(ctx.db, runId);
}

export async function stopRunsForChat(
  ctx: AppCtx,
  chatId: string,
  by: { userId: string | null; reason: BotStopReason },
  opts: { exceptRunIds?: string[] } = {},
): Promise<BotRunRow[]> {
  const except = new Set(opts.exceptRunIds ?? []);
  const ids = (await runningRunsForChat(ctx.db, chatId)).map((r) => r.id).filter((id) => !except.has(id));
  return stopRuns(ctx, ids, by);
}

/** Non-terminal runs of the chat, oldest first. */
export async function runningRunsForChat(db: Db | Tx, chatId: string): Promise<BotRunRow[]> {
  return db
    .select()
    .from(botRuns)
    .where(and(eq(botRuns.chatId, chatId), inArray(botRuns.state, ACTIVE)))
    .orderBy(asc(botRuns.createdAt));
}

/** Boot (Task 9 wires it): runs left 'running' by a dead process fail, and so do callers left waiting on them. */
export async function failInterruptedRuns(db: Db): Promise<number> {
  const error = 'Interrompido por reinício do servidor';
  return db.transaction(async (tx) => {
    const set = { state: 'failed' as const, error, finishedAt: new Date(), wakeAt: null, timeoutAt: null, waitingSince: null };
    const failed = await tx.update(botRuns).set(set).where(eq(botRuns.state, 'running')).returning();
    // A call_flow caller whose child is gone would wait forever and block its (chat, bot): fail it, level by level
    // (one UPDATE does not see rows it changes itself).
    for (;;) {
      const orphans = await tx
        .update(botRuns)
        .set(set)
        .where(
          and(
            eq(botRuns.state, 'waiting_flow'),
            sql`not exists (select 1 from bot_runs c where c.parent_run_id = bot_runs.id and c.state in ('running', 'waiting_reply', 'waiting_timer', 'waiting_flow'))`,
          ),
        )
        .returning();
      if (orphans.length === 0) break;
      failed.push(...orphans);
    }
    if (failed.length === 0) return 0;
    const names = await botNames(tx, failed);
    for (const r of failed) {
      await addEvent(tx, r.chatId, 'bot_failed', eventData({ id: r.botId, name: names.get(r.botId) ?? '' }, r.id, { reason: error }), null);
    }
    return failed.length;
  });
}

// ---------- internals ----------

async function loadRun(db: Db | Tx, runId: string): Promise<BotRunRow> {
  const [row] = await db.select().from(botRuns).where(eq(botRuns.id, runId));
  if (!row) throw notFound('Execução não encontrada');
  return row;
}

function eventData(bot: BotRef, runId: string, extra: { reason?: string; by?: string | null } = {}) {
  return { botId: bot.id, botName: bot.name, runId, ...extra } satisfies BotEventData;
}

/**
 * Saves one step: appends to the capped step log, writes vars and retries (blocks mutate them in place) and `set`.
 * WHERE state = 'running' — null means the run was stopped meanwhile. The optional event goes in the same tx.
 * No WhatsApp send happens here: blocks send through sendSystemMessage before returning.
 */
async function saveStep(
  db: Db,
  run: BotRunRow,
  s: BotRunStep | undefined,
  set: PgUpdateSetSource<typeof botRuns>,
  event?: { kind: ChatEventKind; data: Record<string, unknown> },
): Promise<BotRunRow | null> {
  const steps = s ? [...run.steps, s].slice(-STEP_LOG_LIMIT) : run.steps;
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(botRuns)
      .set({ ...set, steps, vars: run.vars, retries: run.retries })
      .where(and(eq(botRuns.id, run.id), eq(botRuns.state, 'running')))
      .returning();
    if (!row) return null;
    if (event) await addEvent(tx, row.chatId, event.kind, event.data, null);
    return row;
  });
}

/** Engine rule 3: terminal transition of a running run, its event, the chat publish, then the waiting caller. */
async function finishRun(
  ctx: AppCtx,
  run: BotRunRow,
  bot: BotRef,
  state: Terminal,
  o: { error?: string; reason?: BotStopReason },
  s?: BotRunStep,
): Promise<BotRunRow> {
  const event =
    state === 'finished'
      ? { kind: 'bot_finished' as const, data: eventData(bot, run.id) }
      : state === 'failed'
        ? { kind: 'bot_failed' as const, data: eventData(bot, run.id, { reason: o.error }) }
        : { kind: 'bot_stopped' as const, data: eventData(bot, run.id, { reason: o.reason, by: null }) };
  const saved = await saveStep(
    ctx.db,
    run,
    s,
    { state, error: o.error ?? null, finishedAt: ctx.botRuntime.now(), wakeAt: null, timeoutAt: null, waitingSince: null },
    event,
  );
  if (!saved) return loadRun(ctx.db, run.id);
  await ctx.hub.publishChat(saved.chatId);
  await resumeParent(ctx, saved, state);
  return saved;
}

/** A call_flow caller in waiting_flow continues, under the chat lock the caller of this step already holds. */
async function resumeParent(ctx: AppCtx, child: BotRunRow, outcome: Terminal): Promise<void> {
  if (!child.parentRunId) return;
  const [parent] = await ctx.db
    .update(botRuns)
    .set({ state: 'running' })
    .where(and(eq(botRuns.id, child.parentRunId), eq(botRuns.state, 'waiting_flow')))
    .returning({ id: botRuns.id });
  if (parent) await step(ctx, parent.id, { kind: 'flow', outcome });
}

/** Stops the given runs that are still non-terminal; one bot_stopped each. Never resumes callers: the whole chain is stopped. */
async function stopRuns(ctx: AppCtx, ids: string[], by: { userId: string | null; reason: BotStopReason }): Promise<BotRunRow[]> {
  if (ids.length === 0) return [];
  const stopped = await ctx.db.transaction(async (tx) => {
    const rows = await tx
      .update(botRuns)
      .set({ state: 'stopped', finishedAt: ctx.botRuntime.now(), wakeAt: null, timeoutAt: null, waitingSince: null })
      .where(and(inArray(botRuns.id, ids), inArray(botRuns.state, ACTIVE)))
      .returning();
    if (rows.length === 0) return rows;
    const names = await botNames(tx, rows);
    for (const r of rows) {
      const data = eventData({ id: r.botId, name: names.get(r.botId) ?? '' }, r.id, { reason: by.reason, by: by.userId });
      await addEvent(tx, r.chatId, 'bot_stopped', data, by.userId);
    }
    return rows;
  });
  for (const chatId of new Set(stopped.map((r) => r.chatId))) await ctx.hub.publishChat(chatId);
  return stopped;
}

/** The run's call_flow chain: its root (walking up parentRunId) plus every descendant. */
async function chainIds(db: Db | Tx, run: BotRunRow): Promise<string[]> {
  // ponytail: loads every run of the chat, terminal ones too; use a recursive CTE if chats collect thousands of runs.
  const all = await db.select({ id: botRuns.id, parentRunId: botRuns.parentRunId }).from(botRuns).where(eq(botRuns.chatId, run.chatId));
  const parentOf = new Map(all.map((r) => [r.id, r.parentRunId]));
  let root = run.id;
  for (let p = parentOf.get(root); p; p = parentOf.get(p)) root = p;
  const ids = [root];
  for (let i = 0; i < ids.length; i++) for (const r of all) if (r.parentRunId === ids[i]) ids.push(r.id);
  return ids;
}

async function botNames(db: Db | Tx, rows: BotRunRow[]): Promise<Map<string, string>> {
  const list = await db
    .select({ id: bots.id, name: bots.name })
    .from(bots)
    .where(inArray(bots.id, [...new Set(rows.map((r) => r.botId))]));
  return new Map(list.map((b) => [b.id, b.name]));
}

async function lastInbound(db: Db, chatId: string): Promise<InboundReply | null> {
  const [m] = await db
    .select({
      messageId: messages.id,
      kind: messages.kind,
      body: messages.body,
      mediaMime: messages.mediaMime,
      mediaName: messages.mediaName,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(and(eq(messages.chatId, chatId), eq(messages.direction, 'in')))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  return m ?? null;
}

/** BlockError messages are safe to show; anything else may carry contact data, so only its name and code are logged. */
function blockErrorMessage(err: unknown, run: BotRunRow, node: BotNode): string {
  if (err instanceof BlockError) return err.message;
  const e = err as { name?: unknown; code?: unknown } | null;
  console.error('erro inesperado em bloco de chatbot', { runId: run.id, nodeId: node.id, type: node.type, name: e?.name, code: e?.code });
  return `Erro inesperado no bloco "${catalogEntry(node.type).label}"`;
}
```

- [ ] **Step 10: Run the engine tests, the whole server suite and the typecheck**

Run: `npm test -w server -- test/bots/engine.test.ts`
Expected: PASS (3 runtime tests and 20 engine tests).

Run: `npm test -w server`
Expected: PASS.

Run: `npm run typecheck -w server`
Expected: exit 0.

- [ ] **Step 11: Commit**

```bash
git add server/src/bots/engine.ts server/test/bots/engine.test.ts
git commit -m "feat(server): chatbot step engine with waits, error outputs and limits

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


---

### Task 6: Condition blocks

All 17 condition blocks live in `server/src/bots/blocks/conditions.ts`, together with the rule evaluator that Tasks 7, 8 and 12 reuse. The work runs in three TDD cycles, and each cycle ends in a commit:
1. Rules: `condition`, `multi_condition`, `value` and `contact_field`.
2. Contact, chat and message data, plus `distribute`.
3. Time: `weekdays`, `hours` and `wait_interval`. This cycle also registers the blocks in `defaultRegistry` and drives `wait_interval` through the real engine.

**Files:**
- Create: `server/src/bots/blocks/conditions.ts`
- Modify: `server/src/triage/triage.ts`. Export the private `normalize`: change `function normalize(s: string): string {` to `export function normalize(s: string): string {`. Nothing else changes.
- Modify: `server/src/bots/registry.ts` (cycle 3). Spread `conditionBlocks` into `defaultRegistry`.
- Test: `server/test/bots/conditions.test.ts`

**Interfaces:**
- Consumes:
  - From `@talk/shared` (Task 1):
    - Types: `BlockConfigMap`, `BlockType`, `BotGraph`, `BotNode`, `BotRunState`, `BotRunVars`, `ChatAgentConfig`, `ChatChannelConfig`, `ChatSectorConfig`, `ConditionConfig`, `ContactFieldConfig`, `DistributeConfig`, `HoursConfig`, `Logic`, `MessageContainsConfig`, `MultiConditionCase`, `MultiConditionConfig`, `NativeFieldId`, `Operand`, `Rule`, `RuleOperator`, `TagsConfig`, `TimeUnit`, `ValueConfig`, `WaitIntervalConfig`, `Weekday`, `WeekdaysConfig`.
    - Values: `BLOCK_CATALOG`, `DEFAULT_TIMEZONE`, `NON_TERMINAL_RUN_STATES`, `outputsOf(type, config): BlockOutput[]`.
  - From Task 2:
    - The tables `bots` and `botRuns` in `server/src/db/schema.ts`.
    - From `server/src/bots/repo.ts`: `type BotRunRow`, `createBot(db, { name, graph, valid, publish, createdBy, manualStart? }): Promise<BotRow>` and `latestVersion(db, botId): Promise<BotVersionRow>`.
  - From Task 4 (`server/src/bots/variables.ts`): `loadBotTextVars(db, chat, runVars): Promise<BotTextVars>` and `renderBotText(text, vars): string`.
  - From Task 5:
    - `server/src/bots/registry.ts`: `type BlockRegistry`, `type BlockResult`, `type BotCtx`, `type ResumeEvent` and `defaultRegistry`.
    - `server/src/bots/runtime.ts`: `createBotRuntime({ now?, random?, registry? }): BotRuntime`.
    - `server/src/bots/engine.ts`: `startRun(ctx, { botId, chatId, entry, startedBy }): Promise<BotRunRow>`, `resumeOnReply(ctx, chatId, reply: InboundReply): Promise<number>` and `resumeOnTimer(ctx, runId, now): Promise<BotRunRow | null>`.
    - `makeTestCtx()` also returns `clock: FakeClock`. Its default time is `2026-10-14T13:00:00Z`, which is Wednesday 09:00 in America/Cuiaba.
- Produces:
  - From `server/src/bots/blocks/conditions.ts`:
    ```ts
    export const conditionBlocks: BlockRegistry; // exactly the 17 condition types
    export function compareValues(left: string, op: RuleOperator, right: string): boolean; // pure; numeric when both sides are numbers, else normalize()d text
    export async function operandValue(ctx: BotCtx, run: BotRunRow, o: Operand): Promise<string>;
    export async function evalRule(ctx: BotCtx, run: BotRunRow, r: Rule): Promise<boolean>;
    export function zonedParts(d: Date, timeZone: string): { weekday: Weekday; minutes: number }; // RangeError on an unknown zone
    ```
  - From `server/src/triage/triage.ts`: `export function normalize(s: string): string`. **Task 7 finds it already exported and does not edit it again.**
  - `defaultRegistry` now contains every condition type.
- Decisions inside this task:
  - `conditions.ts` imports `registry.ts` **type-only**. `registry.ts` imports `conditions.ts` at runtime for `defaultRegistry`, so a value import back would create an import cycle.
  - For the same reason, the two failures that need no error edge return `{ end: 'failed', error }` instead of throwing `BlockError`. `distribute` fails when no branch has a weight. `wait_interval` fails when the time is not a number greater than 0. Neither block has an `error` output, so the engine's behavior is identical.
  - An empty `timezone` falls back to `DEFAULT_TIMEZONE`.
  - `hours` treats a missing `days` as every day. An empty `days` array matches no day.
  - `message_contains` ignores keywords that are empty after `normalize`.

---

#### Cycle 1: rules (`condition`, `multi_condition`, `value`, `contact_field`)

- [ ] **Step 1: Write the failing test**

Create `server/test/bots/conditions.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  BLOCK_CATALOG,
  outputsOf,
  type BlockConfigMap,
  type BlockType,
  type BotGraph,
  type BotNode,
  type BotRunState,
  type BotRunVars,
  type ChatAgentConfig,
  type HoursConfig,
  type MultiConditionCase,
  type Rule,
  type RuleOperator,
  type TagsConfig,
  type TimeUnit,
  type WaitIntervalConfig,
  type Weekday,
} from '@talk/shared';
import { compareValues, conditionBlocks, evalRule, operandValue } from '../../src/bots/blocks/conditions.js';
import { resumeOnReply, resumeOnTimer, startRun } from '../../src/bots/engine.js';
import { defaultRegistry, type BlockResult, type BotCtx, type ResumeEvent } from '../../src/bots/registry.js';
import { createBot, latestVersion, type BotRunRow } from '../../src/bots/repo.js';
import { createBotRuntime } from '../../src/bots/runtime.js';
import { loadBotTextVars, renderBotText } from '../../src/bots/variables.js';
import { botRuns, bots, channels, chats, contactFieldValues, contactTags, contacts, customFields, messages, tags } from '../../src/db/schema.js';
import { seedChat, seedMessage, type SeedChatOpts } from '../chats/seed.js';
import { makeTestCtx, seedBasics, type Seeded } from '../helpers.js';

type TestCtx = Awaited<ReturnType<typeof makeTestCtx>>;

let ctx: TestCtx;
let s: Seeded;
let otherChannel: string;
let cpfFieldId: string;
let tagIds: string[];

beforeAll(async () => {
  ctx = await makeTestCtx();
  s = await seedBasics(ctx);
  const [ch] = await ctx.db
    .insert(channels)
    .values({ name: 'Outro canal', evolutionInstance: 'talk-other', status: 'connected' })
    .returning({ id: channels.id });
  otherChannel = ch.id;
  const [cpf] = await ctx.db.insert(customFields).values({ name: 'CPF', kind: 'cpf' }).returning({ id: customFields.id });
  cpfFieldId = cpf.id;
  const rows = await ctx.db
    .insert(tags)
    .values([
      { name: 'Cliente', color: 'blue' },
      { name: 'VIP', color: 'green' },
      { name: 'Inadimplente', color: 'red' },
    ])
    .returning({ id: tags.id });
  tagIds = rows.map((r) => r.id);
});

// ---------- helpers ----------

const at = (iso: string) => new Date(iso);
const v = (value: string) => ({ kind: 'var' as const, value });
const lit = (value: string) => ({ kind: 'literal' as const, value });
const fld = (value: string) => ({ kind: 'field' as const, value });

function node<T extends BlockType>(type: T, config: BlockConfigMap[T], name: string = type): BotNode {
  return { id: name, type, name, position: { x: 0, y: 0 }, config: config as unknown as Record<string, unknown> };
}

interface RunOpts { vars?: BotRunVars; state?: BotRunState; parentRunId?: string | null; depth?: number }

/** A run of a fresh bot (each bot is unique, so the one-active-run-per-(chat, bot) index never collides). */
async function seedRun(chatId: string, o: RunOpts = {}): Promise<BotRunRow> {
  const bot = await createBot(ctx.db, {
    name: `Bot ${randomUUID()}`, graph: { nodes: [], edges: [] }, valid: false, publish: false, createdBy: null,
  });
  const version = await latestVersion(ctx.db, bot.id);
  const [chat] = await ctx.db.select().from(chats).where(eq(chats.id, chatId));
  const [run] = await ctx.db
    .insert(botRuns)
    .values({
      botId: bot.id, versionId: version.id, chatId, contactId: chat.contactId, currentNodeId: 'n',
      state: o.state ?? 'running', vars: o.vars ?? {}, parentRunId: o.parentRunId ?? null, depth: o.depth ?? 0,
    })
    .returning();
  return run;
}

async function contactWith(values: Partial<typeof contacts.$inferInsert> = {}): Promise<string> {
  const [c] = await ctx.db.insert(contacts).values({ name: 'Maria Silva', ...values }).returning({ id: contacts.id });
  return c.id;
}

interface SceneOpts { chat?: Partial<SeedChatOpts>; contact?: Partial<typeof contacts.$inferInsert>; run?: RunOpts }

/** New contact (unless chat.contactId is given) + open chat on the test channel + a running run on it. */
async function scene(o: SceneOpts = {}) {
  const contactId = o.chat?.contactId ?? (await contactWith(o.contact));
  const { chatId } = await seedChat(ctx, { channelId: s.channelId, sectorId: s.defaultSector, ...o.chat, contactId });
  const run = await seedRun(chatId, o.run);
  return { contactId, chatId, run };
}

interface CtxOpts { now?: Date; random?: () => number }

/** The BotCtx the engine hands a block, built from the DB the same way (fresh chat, renderBotText, newest inbound). */
async function botCtx(run: BotRunRow, o: CtxOpts = {}): Promise<BotCtx> {
  const [chat] = await ctx.db.select().from(chats).where(eq(chats.id, run.chatId));
  const app = o.random ? { ...ctx, botRuntime: createBotRuntime({ random: o.random }) } : ctx;
  return {
    app,
    now: o.now ?? ctx.clock.now(),
    chat,
    bot: { id: run.botId, name: 'Bot de teste' },
    actor: { botId: run.botId, botName: 'Bot de teste', runId: run.id },
    render: async (text) => renderBotText(text, await loadBotTextVars(ctx.db, chat, run.vars)),
    lastInbound: async () => {
      const [m] = await ctx.db
        .select()
        .from(messages)
        .where(and(eq(messages.chatId, run.chatId), eq(messages.direction, 'in')))
        .orderBy(desc(messages.createdAt))
        .limit(1);
      return m
        ? { messageId: m.id, kind: m.kind, body: m.body, mediaMime: m.mediaMime, mediaName: m.mediaName, createdAt: m.createdAt }
        : null;
    },
    startChild: async () => {
      throw new Error('startChild não é usado por blocos de condição');
    },
    stopOtherRuns: async () => {
      throw new Error('stopOtherRuns não é usado por blocos de condição');
    },
  };
}

function definition(type: BlockType) {
  const def = conditionBlocks[type];
  if (!def) throw new Error(`bloco ${type} não registrado em conditionBlocks`);
  return def;
}

/** Runs the block and checks that any handle it returns is one the editor draws (outputsOf). */
async function runBlock(run: BotRunRow, n: BotNode, o: CtxOpts = {}): Promise<BlockResult> {
  const result = await definition(n.type).run(await botCtx(run, o), run, n);
  if ('next' in result) expect(outputsOf(n.type, n.config).map((x) => x.id)).toContain(result.next);
  return result;
}

async function nextOf(run: BotRunRow, n: BotNode, o: CtxOpts = {}): Promise<string> {
  const result = await runBlock(run, n, o);
  if (!('next' in result)) throw new Error(`esperava { next }, veio ${JSON.stringify(result)}`);
  return result.next;
}

const menuIs = (value: string): Rule => ({ left: v('menu'), operator: 'eq', right: lit(value) });

// ---------- cycle 1: rules ----------

describe('compareValues', () => {
  it.each<[string, RuleOperator, string, boolean]>([
    ['10', 'gt', '9', true], // numeric (as text "10" < "9")
    ['9', 'lt', '10', true],
    ['1,5', 'eq', '1.5', true], // decimal comma
    [' 7 ', 'eq', '7', true],
    ['5', 'lte', '5', true],
    ['4', 'lt', '5', true],
    ['5', 'gte', '6', false],
    ['', 'eq', '0', false], // empty is not the number 0
    ['b', 'gt', 'a', true],
    ['abc', 'gt', 'abd', false],
    ['Ação', 'eq', 'acao', true],
    ['a', 'neq', 'A', false],
    ['São Paulo', 'contains', 'PAULO', true],
    ['São Paulo', 'not_contains', 'rio', true],
    ['Boleto atrasado', 'starts', 'boleto', true],
    ['10', 'contains', '1', true], // contains is always text
    ['   ', 'empty', '', true],
    ['x', 'empty', '', false],
    ['x', 'not_empty', '', true],
  ])('%j %s %j is %s', (left, op, right, expected) => {
    expect(compareValues(left, op, right)).toBe(expected);
  });
});

describe('operandValue and evalRule', () => {
  it('reads vars, raw vars, contact fields and rendered literals', async () => {
    const { contactId, run } = await scene({
      contact: { name: 'Maria Silva', email: 'maria@exemplo.com', landline: '6533221100', address: { city: 'Cuiabá', state: 'MT' } },
      run: { vars: { menu: { raw: 'Quero o 1', value: '1', label: 'Atendimento' } } },
    });
    await ctx.db.insert(contactFieldValues).values({ contactId, fieldId: cpfFieldId, value: '529.982.247-25' });
    const b = await botCtx(run);
    expect(await operandValue(b, run, v('menu'))).toBe('1');
    expect(await operandValue(b, run, v('menu:raw'))).toBe('Quero o 1');
    expect(await operandValue(b, run, v('inexistente'))).toBe('');
    expect(await operandValue(b, run, fld(cpfFieldId))).toBe('529.982.247-25');
    expect(await operandValue(b, run, fld(randomUUID()))).toBe('');
    expect(await operandValue(b, run, fld('native:name'))).toBe('Maria Silva');
    expect(await operandValue(b, run, fld('native:email'))).toBe('maria@exemplo.com');
    expect(await operandValue(b, run, fld('native:landline'))).toBe('6533221100');
    expect(await operandValue(b, run, fld('native:city'))).toBe('Cuiabá');
    expect(await operandValue(b, run, fld('native:state'))).toBe('MT');
    expect(await operandValue(b, run, lit('Olá {{contato.primeiro_nome}}, opção {{contexto.menu}}'))).toBe('Olá Maria, opção 1');
  });

  it('gives empty text for native fields the contact does not have', async () => {
    const { run } = await scene({ contact: { name: null } });
    const b = await botCtx(run);
    expect(await operandValue(b, run, fld('native:name'))).toBe('');
    expect(await operandValue(b, run, fld('native:email'))).toBe('');
    expect(await operandValue(b, run, fld('native:city'))).toBe('');
  });

  it('ignores the right side for empty and not_empty', async () => {
    const { run } = await scene({ run: { vars: { nome: { raw: '  ', value: '  ' } } } });
    const b = await botCtx(run);
    expect(await evalRule(b, run, { left: v('nome'), operator: 'empty' })).toBe(true);
    expect(await evalRule(b, run, { left: v('nome'), operator: 'not_empty', right: lit('ignorado') })).toBe(false);
  });
});

describe('condition', () => {
  it('follows yes when every rule holds (and) or any rule holds (or)', async () => {
    const { run } = await scene({ run: { vars: { menu: { raw: '2', value: '2' } } } });
    expect(await nextOf(run, node('condition', { logic: 'and', rules: [menuIs('2')] }))).toBe('yes');
    expect(await nextOf(run, node('condition', { logic: 'and', rules: [menuIs('2'), menuIs('3')] }))).toBe('no');
    expect(await nextOf(run, node('condition', { logic: 'or', rules: [menuIs('3'), menuIs('2')] }))).toBe('yes');
    expect(await nextOf(run, node('condition', { logic: 'or', rules: [menuIs('3'), menuIs('4')] }))).toBe('no');
  });

  it('compares the raw answer with a literal that has variables', async () => {
    const { run } = await scene({ run: { vars: { menu: { raw: 'Aqui é a MARIA', value: '9' } } } });
    const rule: Rule = { left: v('menu:raw'), operator: 'contains', right: lit('{{contato.primeiro_nome}}') };
    expect(await nextOf(run, node('condition', { logic: 'and', rules: [rule] }))).toBe('yes');
    expect(await nextOf(run, node('condition', { logic: 'and', rules: [{ ...rule, left: v('menu') }] }))).toBe('no');
  });
});

describe('multi_condition', () => {
  const cases: MultiConditionCase[] = [
    { label: 'Atendimento', logic: 'and', rules: [menuIs('1')] },
    { label: 'Financeiro', logic: 'and', rules: [menuIs('2')] },
    { label: 'Processos', logic: 'and', rules: [menuIs('3')] },
  ];

  it('follows the matching case', async () => {
    const { run } = await scene({ run: { vars: { menu: { raw: '2', value: '2' } } } });
    expect(await nextOf(run, node('multi_condition', { cases }))).toBe('case:1');
  });

  it('follows else when no case matches', async () => {
    const { run } = await scene({ run: { vars: { menu: { raw: '9', value: '9' } } } });
    expect(await nextOf(run, node('multi_condition', { cases }))).toBe('else');
  });

  it('takes the first true case when several match', async () => {
    const { run } = await scene({ run: { vars: { menu: { raw: '2', value: '2' } } } });
    const overlapping: MultiConditionCase[] = [
      { label: 'Qualquer', logic: 'and', rules: [{ left: v('menu'), operator: 'not_empty' }] },
      { label: 'Dois', logic: 'and', rules: [menuIs('2')] },
    ];
    expect(await nextOf(run, node('multi_condition', { cases: overlapping }))).toBe('case:0');
  });
});

describe('value', () => {
  it('compares a native field with a literal ignoring case and accents', async () => {
    const { run } = await scene({ contact: { address: { city: 'Cuiabá', state: 'MT' } } });
    expect(await nextOf(run, node('value', { left: fld('native:city'), operator: 'eq', right: lit('CUIABA') }))).toBe('yes');
    expect(await nextOf(run, node('value', { left: fld('native:city'), operator: 'neq', right: lit('CUIABA') }))).toBe('no');
  });

  it('compares a var numerically', async () => {
    const { run } = await scene({ run: { vars: { idade: { raw: '42 anos', value: '42' } } } });
    expect(await nextOf(run, node('value', { left: v('idade'), operator: 'gte', right: lit('18') }))).toBe('yes');
    expect(await nextOf(run, node('value', { left: v('idade'), operator: 'lt', right: lit('18') }))).toBe('no');
  });
});

describe('contact_field', () => {
  it('checks a custom field value', async () => {
    const { contactId, run } = await scene();
    await ctx.db.insert(contactFieldValues).values({ contactId, fieldId: cpfFieldId, value: '529.982.247-25' });
    expect(await nextOf(run, node('contact_field', { fieldId: cpfFieldId, operator: 'eq', value: '529.982.247-25' }))).toBe('yes');
    expect(await nextOf(run, node('contact_field', { fieldId: cpfFieldId, operator: 'empty', value: '' }))).toBe('no');
  });

  it('treats a custom field without a value as empty', async () => {
    const { run } = await scene();
    expect(await nextOf(run, node('contact_field', { fieldId: cpfFieldId, operator: 'empty', value: '' }))).toBe('yes');
  });

  it('checks a native field against a value with variables', async () => {
    const { run } = await scene({ contact: { address: { city: 'Cuiabá', state: 'MT' } }, run: { vars: { uf: { raw: 'mt', value: 'mt' } } } });
    expect(await nextOf(run, node('contact_field', { fieldId: 'native:state', operator: 'eq', value: '{{contexto.uf}}' }))).toBe('yes');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w server -- test/bots/conditions.test.ts`
Expected: FAIL. The suite cannot import `../../src/bots/blocks/conditions.js` because the file does not exist yet.

- [ ] **Step 3: Export `normalize` from triage**

In `server/src/triage/triage.ts`, replace

```ts
function normalize(s: string): string {
```

with

```ts
export function normalize(s: string): string {
```

- [ ] **Step 4: Write the rule evaluator and the four rule blocks**

Create `server/src/bots/blocks/conditions.ts`. The import list already covers all three cycles; later cycles only add code below it.

```ts
import { and, count, eq, gte, inArray } from 'drizzle-orm';
import {
  DEFAULT_TIMEZONE,
  NON_TERMINAL_RUN_STATES,
  type BotNode,
  type ChatAgentConfig,
  type ChatChannelConfig,
  type ChatSectorConfig,
  type ConditionConfig,
  type ContactFieldConfig,
  type DistributeConfig,
  type HoursConfig,
  type Logic,
  type MessageContainsConfig,
  type MultiConditionConfig,
  type NativeFieldId,
  type Operand,
  type Rule,
  type RuleOperator,
  type TagsConfig,
  type TimeUnit,
  type ValueConfig,
  type WaitIntervalConfig,
  type Weekday,
  type WeekdaysConfig,
} from '@talk/shared';
import { botRuns, chats, contactFieldValues, contactTags, contacts, messages } from '../../db/schema.js';
import { normalize } from '../../triage/triage.js';
import type { BotRunRow } from '../repo.js';
// Type-only on purpose: registry.ts imports this file at runtime for defaultRegistry, so a value import back would be a cycle.
// That is also why failures here return { end: 'failed' } instead of throwing BlockError (these blocks have no error output).
import type { BlockRegistry, BlockResult, BotCtx } from '../registry.js';

const conf = <T>(node: BotNode): T => node.config as unknown as T;
const yesNo = (ok: boolean): BlockResult => ({ next: ok ? 'yes' : 'no' });

/** Number() after trim and ',' → '.'; empty text is not a number. */
function toNumber(s: string): number {
  const t = s.trim().replace(',', '.');
  return t === '' ? Number.NaN : Number(t);
}

/** Numeric when both sides are numbers, else normalize()d text. contains / not_contains / starts always compare text. */
export function compareValues(left: string, op: RuleOperator, right: string): boolean {
  const order = (): number => {
    const a = toNumber(left);
    const b = toNumber(right);
    if (Number.isFinite(a) && Number.isFinite(b)) return Math.sign(a - b);
    const x = normalize(left);
    const y = normalize(right);
    return x < y ? -1 : x > y ? 1 : 0;
  };
  switch (op) {
    case 'empty': return left.trim() === '';
    case 'not_empty': return left.trim() !== '';
    case 'contains': return normalize(left).includes(normalize(right));
    case 'not_contains': return !normalize(left).includes(normalize(right));
    case 'starts': return normalize(left).startsWith(normalize(right));
    case 'eq': return order() === 0;
    case 'neq': return order() !== 0;
    case 'gt': return order() > 0;
    case 'gte': return order() >= 0;
    case 'lt': return order() < 0;
    case 'lte': return order() <= 0;
  }
}

/** Current value of a contact field: a NativeFieldId reads `contacts` (city/state from address), anything else is a custom field id. */
async function contactFieldValue(ctx: BotCtx, fieldId: string): Promise<string> {
  const contactId = ctx.chat.contactId;
  if (fieldId.startsWith('native:')) {
    const [c] = await ctx.app.db
      .select({ name: contacts.name, email: contacts.email, landline: contacts.landline, address: contacts.address })
      .from(contacts)
      .where(eq(contacts.id, contactId));
    if (!c) return '';
    const native: Record<NativeFieldId, string | null | undefined> = {
      'native:name': c.name,
      'native:email': c.email,
      'native:landline': c.landline,
      'native:city': c.address?.city,
      'native:state': c.address?.state,
    };
    return native[fieldId as NativeFieldId] ?? '';
  }
  const [row] = await ctx.app.db
    .select({ value: contactFieldValues.value })
    .from(contactFieldValues)
    .where(and(eq(contactFieldValues.contactId, contactId), eq(contactFieldValues.fieldId, fieldId)));
  return row?.value ?? '';
}

/** var → run.vars[name].value ('<name>:raw' → .raw; missing → ''), field → contact's current value, literal → rendered text. */
export async function operandValue(ctx: BotCtx, run: BotRunRow, o: Operand): Promise<string> {
  if (o.kind === 'literal') return ctx.render(o.value);
  if (o.kind === 'field') return contactFieldValue(ctx, o.value);
  const [name = '', part] = o.value.split(':');
  const found = run.vars[name];
  return (part === 'raw' ? found?.raw : found?.value) ?? '';
}

export async function evalRule(ctx: BotCtx, run: BotRunRow, r: Rule): Promise<boolean> {
  const left = await operandValue(ctx, run, r.left);
  const needsRight = r.operator !== 'empty' && r.operator !== 'not_empty';
  const right = needsRight && r.right ? await operandValue(ctx, run, r.right) : '';
  return compareValues(left, r.operator, right);
}

/** and: stops at the first false; or: stops at the first true. No rules: and → true, or → false. */
async function evalRules(ctx: BotCtx, run: BotRunRow, logic: Logic, rules: Rule[] = []): Promise<boolean> {
  for (const r of rules) {
    const ok = await evalRule(ctx, run, r);
    if (logic === 'or' ? ok : !ok) return ok;
  }
  return logic !== 'or';
}

export const conditionBlocks: BlockRegistry = {
  condition: {
    type: 'condition',
    run: async (ctx, run, node) => {
      const c = conf<ConditionConfig>(node);
      return yesNo(await evalRules(ctx, run, c.logic, c.rules));
    },
  },
  multi_condition: {
    type: 'multi_condition',
    run: async (ctx, run, node) => {
      const cases = conf<MultiConditionConfig>(node).cases ?? [];
      for (const [i, k] of cases.entries()) {
        if (await evalRules(ctx, run, k.logic, k.rules)) return { next: `case:${i}` };
      }
      return { next: 'else' };
    },
  },
  value: {
    type: 'value',
    run: async (ctx, run, node) => yesNo(await evalRule(ctx, run, conf<ValueConfig>(node))),
  },
  contact_field: {
    type: 'contact_field',
    run: async (ctx, run, node) => {
      const c = conf<ContactFieldConfig>(node);
      const rule: Rule = { left: { kind: 'field', value: c.fieldId }, operator: c.operator, right: { kind: 'literal', value: c.value } };
      return yesNo(await evalRule(ctx, run, rule));
    },
  },
};
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -w server -- test/bots/conditions.test.ts`
Expected: PASS. The tests in `compareValues`, `operandValue and evalRule`, `condition`, `multi_condition`, `value` and `contact_field` all pass.

Run: `npm test -w server -- test/triage`
Expected: PASS, because exporting `normalize` changes no behavior.

- [ ] **Step 6: Commit**

```bash
git add server/src/bots/blocks/conditions.ts server/src/triage/triage.ts server/test/bots/conditions.test.ts
git commit -m "feat(bots): rule evaluation and condition, multi_condition, value, contact_field blocks" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

#### Cycle 2: contact, chat and message data, and `distribute`

- [ ] **Step 7: Write the failing tests**

Append to the end of `server/test/bots/conditions.test.ts`:

```ts
// ---------- cycle 2: contact, chat and message data; distribute ----------

/** Deterministic [0,1) generator (mulberry32) for the distribution test. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('distribute', () => {
  const oneToThree = node('distribute', { branches: [{ label: 'A', weight: 1 }, { label: 'B', weight: 3 }] });

  it.each<[number, string]>([
    [0, 'branch:0'],
    [0.2499, 'branch:0'],
    [0.25, 'branch:1'],
    [0.9999, 'branch:1'],
  ])('random() = %d picks %s with weights 1:3', async (r, expected) => {
    const { run } = await scene();
    expect(await nextOf(run, oneToThree, { random: () => r })).toBe(expected);
  });

  it.each<[number, string]>([
    [0.49, 'branch:0'],
    [0.5, 'branch:1'],
    [0.74, 'branch:1'],
    [0.75, 'branch:2'],
  ])('random() = %d picks %s with weights 2:1:1', async (r, expected) => {
    const { run } = await scene();
    const threeWay = node('distribute', { branches: [{ label: 'A', weight: 2 }, { label: 'B', weight: 1 }, { label: 'C', weight: 1 }] });
    expect(await nextOf(run, threeWay, { random: () => r })).toBe(expected);
  });

  it('splits about 25/75 with a seeded generator', async () => {
    const { run } = await scene();
    const b = await botCtx(run, { random: mulberry32(42) });
    const counts = [0, 0];
    for (let i = 0; i < 4000; i++) {
      const r = await definition('distribute').run(b, run, oneToThree);
      if ('next' in r) counts[Number(r.next.split(':')[1])] += 1;
    }
    expect(counts[0] + counts[1]).toBe(4000);
    expect(counts[0]).toBeGreaterThan(900);
    expect(counts[0]).toBeLessThan(1100);
  });

  it('fails the run instead of guessing when no branch has weight', async () => {
    const { run } = await scene();
    expect(await runBlock(run, node('distribute', { branches: [] }), { random: () => 0.5 })).toEqual({
      end: 'failed',
      error: 'O bloco "Distribuir" não tem caminhos com peso',
    });
  });
});

describe('contact_active', () => {
  const now = at('2026-10-14T13:00:00Z');
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

  it('is yes for an inbound message in the last 24 h on this channel', async () => {
    const { chatId, run } = await scene();
    await seedMessage(ctx, chatId, s.channelId, hoursAgo(23));
    expect(await nextOf(run, node('contact_active', {}), { now })).toBe('yes');
  });

  it('is no for an inbound message older than 24 h or a message we sent', async () => {
    const { chatId, run } = await scene();
    await seedMessage(ctx, chatId, s.channelId, hoursAgo(25));
    await seedMessage(ctx, chatId, s.channelId, hoursAgo(1), { direction: 'out' });
    expect(await nextOf(run, node('contact_active', {}), { now })).toBe('no');
  });

  it('counts earlier chats of the contact on this channel but not other channels', async () => {
    const { contactId, run } = await scene();
    const old = await seedChat(ctx, { channelId: s.channelId, sectorId: s.defaultSector, contactId, state: 'closed' });
    const other = await seedChat(ctx, { channelId: otherChannel, sectorId: s.defaultSector, contactId });
    await seedMessage(ctx, other.chatId, otherChannel, hoursAgo(1));
    expect(await nextOf(run, node('contact_active', {}), { now })).toBe('no');
    await seedMessage(ctx, old.chatId, s.channelId, hoursAgo(2));
    expect(await nextOf(run, node('contact_active', {}), { now })).toBe('yes');
  });
});

describe('first_chat', () => {
  it('is yes for the only chat of the contact on this channel', async () => {
    const { run } = await scene();
    expect(await nextOf(run, node('first_chat', {}))).toBe('yes');
  });

  it('is no when the contact had an earlier chat on this channel', async () => {
    const { contactId, run } = await scene();
    await seedChat(ctx, { channelId: s.channelId, sectorId: s.defaultSector, contactId, state: 'closed' });
    expect(await nextOf(run, node('first_chat', {}))).toBe('no');
  });

  it('ignores chats on other channels', async () => {
    const { contactId, run } = await scene();
    await seedChat(ctx, { channelId: otherChannel, sectorId: s.defaultSector, contactId });
    expect(await nextOf(run, node('first_chat', {}))).toBe('yes');
  });
});

describe('tags', () => {
  // The contact has tags 0 and 1 (Cliente, VIP), never 2 (Inadimplente).
  it.each<[TagsConfig['mode'], number[], 'yes' | 'no']>([
    ['any', [0, 2], 'yes'],
    ['any', [2], 'no'],
    ['all', [0, 1], 'yes'],
    ['all', [0, 2], 'no'],
    ['none', [2], 'yes'],
    ['none', [1], 'no'],
  ])('mode %s with tags %j → %s', async (mode, idx, expected) => {
    const { contactId, run } = await scene();
    await ctx.db.insert(contactTags).values([{ contactId, tagId: tagIds[0] }, { contactId, tagId: tagIds[1] }]);
    expect(await nextOf(run, node('tags', { mode, tagIds: idx.map((i) => tagIds[i]) }))).toBe(expected);
  });
});

describe('chat_sector and chat_channel', () => {
  it('chat_sector is yes only when the chat sector is listed', async () => {
    const { run } = await scene({ chat: { sectorId: s.sectorA } });
    expect(await nextOf(run, node('chat_sector', { sectorIds: [s.sectorB, s.sectorA] }))).toBe('yes');
    expect(await nextOf(run, node('chat_sector', { sectorIds: [s.defaultSector] }))).toBe('no');
  });

  it('chat_channel is yes only when the chat channel is listed', async () => {
    const { run } = await scene();
    expect(await nextOf(run, node('chat_channel', { channelIds: [s.channelId] }))).toBe('yes');
    expect(await nextOf(run, node('chat_channel', { channelIds: [otherChannel] }))).toBe('no');
  });
});

describe('chat_agent', () => {
  const agent = (mode: ChatAgentConfig['mode'], userIds: string[] = []) => node('chat_agent', { mode, userIds });

  it('with an owner: any and the owner listed are yes, none and others are no', async () => {
    const { run } = await scene({ chat: { ownerId: s.agentA.id } });
    expect(await nextOf(run, agent('any'))).toBe('yes');
    expect(await nextOf(run, agent('none'))).toBe('no');
    expect(await nextOf(run, agent('specific', [s.agentB.id]))).toBe('no');
    expect(await nextOf(run, agent('specific', [s.agentB.id, s.agentA.id]))).toBe('yes');
  });

  it('without an owner: none is yes, any and specific are no', async () => {
    const { run } = await scene();
    expect(await nextOf(run, agent('none'))).toBe('yes');
    expect(await nextOf(run, agent('any'))).toBe('no');
    expect(await nextOf(run, agent('specific', [s.agentA.id]))).toBe('no');
  });
});

describe('chat_status', () => {
  it('is yes when the chat is waiting', async () => {
    const { run } = await scene({ chat: { waiting: true } });
    expect(await nextOf(run, node('chat_status', {}))).toBe('yes');
  });

  it('is no when the chat is not waiting', async () => {
    const { run } = await scene({ chat: { waiting: false } });
    expect(await nextOf(run, node('chat_status', {}))).toBe('no');
  });
});

describe('message_contains', () => {
  const contains = (keywords: string[], match: 'any' | 'all') => node('message_contains', { keywords, match });

  it('looks only at the newest inbound message, ignoring case and accents', async () => {
    const { chatId, run } = await scene();
    await seedMessage(ctx, chatId, s.channelId, at('2026-10-14T12:00:00Z'), { body: 'Preciso da segunda via do BOLETO, por favor' });
    await seedMessage(ctx, chatId, s.channelId, at('2026-10-14T12:30:00Z'), { body: 'Segue o pix', direction: 'out' });
    expect(await nextOf(run, contains(['boleto'], 'any'))).toBe('yes');
    expect(await nextOf(run, contains(['Pix', 'boleto'], 'any'))).toBe('yes');
    expect(await nextOf(run, contains(['pix', 'boleto'], 'all'))).toBe('no');
    expect(await nextOf(run, contains(['Segunda Via', 'boleto'], 'all'))).toBe('yes');

    await seedMessage(ctx, chatId, s.channelId, at('2026-10-14T12:45:00Z'), { body: 'Quero falar sobre a ação' });
    expect(await nextOf(run, contains(['boleto'], 'any'))).toBe('no');
    expect(await nextOf(run, contains(['AÇÃO'], 'any'))).toBe('yes');
    expect(await nextOf(run, contains(['acao'], 'any'))).toBe('yes');
  });

  it('is no when the newest inbound message has no text', async () => {
    const { chatId, run } = await scene();
    await seedMessage(ctx, chatId, s.channelId, at('2026-10-14T12:00:00Z'), { body: 'boleto' });
    await seedMessage(ctx, chatId, s.channelId, at('2026-10-14T12:10:00Z'), { kind: 'sticker', body: null });
    expect(await nextOf(run, contains(['boleto'], 'any'))).toBe('no');
  });

  it('is no when the contact never wrote or no keyword has text', async () => {
    const { chatId, run } = await scene();
    expect(await nextOf(run, contains(['boleto'], 'any'))).toBe('no');
    await seedMessage(ctx, chatId, s.channelId, at('2026-10-14T12:00:00Z'), { body: 'boleto' });
    expect(await nextOf(run, contains(['  ', '!'], 'any'))).toBe('no');
  });
});

describe('parallel_bot', () => {
  it('is no when this run is alone on the chat', async () => {
    const { run } = await scene();
    expect(await nextOf(run, node('parallel_bot', {}))).toBe('no');
  });

  it('is yes when another bot is still running, ignoring finished runs', async () => {
    const { chatId, run } = await scene();
    await seedRun(chatId, { state: 'finished' });
    await seedRun(chatId, { state: 'stopped' });
    expect(await nextOf(run, node('parallel_bot', {}))).toBe('no');
    await seedRun(chatId, { state: 'waiting_reply' });
    expect(await nextOf(run, node('parallel_bot', {}))).toBe('yes');
  });

  it('does not count its own call_flow ancestors waiting for it', async () => {
    const { chatId, run: parent } = await scene({ run: { state: 'waiting_flow' } });
    const child = await seedRun(chatId, { state: 'waiting_flow', parentRunId: parent.id, depth: 1 });
    const grandchild = await seedRun(chatId, { parentRunId: child.id, depth: 2 });
    expect(await nextOf(grandchild, node('parallel_bot', {}))).toBe('no');
    await seedRun(chatId, { state: 'waiting_timer' });
    expect(await nextOf(grandchild, node('parallel_bot', {}))).toBe('yes');
  });
});
```

- [ ] **Step 8: Run the tests to verify they fail**

Run: `npm test -w server -- test/bots/conditions.test.ts`
Expected: FAIL. Every new test throws `bloco distribute não registrado em conditionBlocks`, or the same message for `contact_active`, `first_chat`, `tags`, `chat_sector`, `chat_channel`, `chat_agent`, `chat_status`, `message_contains` or `parallel_bot`. The cycle 1 tests still pass.

- [ ] **Step 9: Write the ten data blocks**

In `server/src/bots/blocks/conditions.ts`, insert this line directly above `export const conditionBlocks: BlockRegistry = {`:

```ts
const DAY_MS = 86_400_000;
```

Then insert these entries at the end of the `conditionBlocks` object, after the `contact_field` entry and before its closing `};`, which is the last line of the file:

```ts
  distribute: {
    type: 'distribute',
    run: async (ctx, _run, node) => {
      const weights = (conf<DistributeConfig>(node).branches ?? []).map((b) => Math.max(0, b.weight));
      const total = weights.reduce((sum, w) => sum + w, 0);
      if (!(total > 0)) return { end: 'failed', error: 'O bloco "Distribuir" não tem caminhos com peso' };
      const pick = ctx.app.botRuntime.random() * total;
      let acc = 0;
      for (const [i, w] of weights.entries()) {
        acc += w;
        if (pick < acc) return { next: `branch:${i}` };
      }
      return { next: `branch:${weights.length - 1}` }; // random() < 1, so only float rounding lands here
    },
  },
  contact_active: {
    type: 'contact_active',
    run: async (ctx) => {
      const since = new Date(ctx.now.getTime() - DAY_MS);
      const [hit] = await ctx.app.db
        .select({ id: messages.id })
        .from(messages)
        .innerJoin(chats, eq(chats.id, messages.chatId))
        .where(
          and(
            eq(chats.contactId, ctx.chat.contactId),
            eq(messages.channelId, ctx.chat.channelId),
            eq(messages.direction, 'in'),
            gte(messages.sentAt, since),
          ),
        )
        .limit(1);
      return yesNo(hit !== undefined);
    },
  },
  first_chat: {
    type: 'first_chat',
    run: async (ctx) => {
      const [{ n }] = await ctx.app.db
        .select({ n: count() })
        .from(chats)
        .where(and(eq(chats.contactId, ctx.chat.contactId), eq(chats.channelId, ctx.chat.channelId)));
      return yesNo(n === 1);
    },
  },
  tags: {
    type: 'tags',
    run: async (ctx, _run, node) => {
      const c = conf<TagsConfig>(node);
      const wanted = c.tagIds ?? [];
      const rows = await ctx.app.db
        .select({ tagId: contactTags.tagId })
        .from(contactTags)
        .where(eq(contactTags.contactId, ctx.chat.contactId));
      const has = new Set(rows.map((r) => r.tagId));
      const hits = wanted.filter((id) => has.has(id)).length;
      if (c.mode === 'all') return yesNo(hits === wanted.length);
      if (c.mode === 'none') return yesNo(hits === 0);
      return yesNo(hits > 0);
    },
  },
  chat_sector: {
    type: 'chat_sector',
    run: async (ctx, _run, node) => yesNo((conf<ChatSectorConfig>(node).sectorIds ?? []).includes(ctx.chat.sectorId)),
  },
  chat_channel: {
    type: 'chat_channel',
    run: async (ctx, _run, node) => yesNo((conf<ChatChannelConfig>(node).channelIds ?? []).includes(ctx.chat.channelId)),
  },
  chat_agent: {
    type: 'chat_agent',
    run: async (ctx, _run, node) => {
      const c = conf<ChatAgentConfig>(node);
      const owner = ctx.chat.ownerId;
      if (c.mode === 'none') return yesNo(owner === null);
      if (c.mode === 'any') return yesNo(owner !== null);
      return yesNo(owner !== null && (c.userIds ?? []).includes(owner));
    },
  },
  chat_status: {
    type: 'chat_status',
    run: async (ctx) => yesNo(ctx.chat.waiting),
  },
  message_contains: {
    type: 'message_contains',
    run: async (ctx, _run, node) => {
      const c = conf<MessageContainsConfig>(node);
      const words = (c.keywords ?? []).map((k) => normalize(k)).filter((k) => k !== '');
      const body = (await ctx.lastInbound())?.body;
      if (!body || words.length === 0) return yesNo(false);
      const text = normalize(body);
      return yesNo(c.match === 'all' ? words.every((w) => text.includes(w)) : words.some((w) => text.includes(w)));
    },
  },
  parallel_bot: {
    type: 'parallel_bot',
    run: async (ctx, run) => {
      const active = await ctx.app.db
        .select({ id: botRuns.id, parentRunId: botRuns.parentRunId })
        .from(botRuns)
        .where(and(eq(botRuns.chatId, ctx.chat.id), inArray(botRuns.state, [...NON_TERMINAL_RUN_STATES])));
      // Ancestors that matter are non-terminal (waiting_flow), so walking the active rows is enough.
      const byId = new Map(active.map((r) => [r.id, r.parentRunId]));
      const chain = new Set([run.id]);
      for (let p = run.parentRunId; p && !chain.has(p); p = byId.get(p) ?? null) chain.add(p);
      return yesNo(active.some((r) => !chain.has(r.id)));
    },
  },
```

- [ ] **Step 10: Run the tests to verify they pass**

Run: `npm test -w server -- test/bots/conditions.test.ts`
Expected: PASS for all cycle 1 and cycle 2 tests.

- [ ] **Step 11: Commit**

```bash
git add server/src/bots/blocks/conditions.ts server/test/bots/conditions.test.ts
git commit -m "feat(bots): contact, chat, message and distribute condition blocks" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

#### Cycle 3: `weekdays`, `hours`, `wait_interval`, registry wiring and the engine

- [ ] **Step 12: Write the failing tests**

In `server/test/bots/conditions.test.ts`, replace the line

```ts
import { compareValues, conditionBlocks, evalRule, operandValue } from '../../src/bots/blocks/conditions.js';
```

with

```ts
import { compareValues, conditionBlocks, evalRule, operandValue, zonedParts } from '../../src/bots/blocks/conditions.js';
```

Then append to the end of the file:

```ts
// ---------- cycle 3: time blocks, registry, engine ----------

const MON_FRI: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri'];

describe('conditionBlocks registry', () => {
  it('registers exactly the 17 condition types, also in defaultRegistry', () => {
    const types = BLOCK_CATALOG.filter((e) => e.category === 'condition').map((e) => e.type);
    expect(types).toHaveLength(17);
    expect(Object.keys(conditionBlocks).sort()).toEqual([...types].sort());
    for (const t of types) {
      expect(conditionBlocks[t]?.type).toBe(t);
      expect(defaultRegistry[t]).toBe(conditionBlocks[t]);
    }
  });
});

describe('zonedParts', () => {
  it.each<[string, string, Weekday, number]>([
    ['2026-10-14T13:00:00Z', 'America/Cuiaba', 'wed', 9 * 60],
    ['2026-10-15T03:30:00Z', 'America/Cuiaba', 'wed', 23 * 60 + 30], // still Wednesday in Cuiabá, already Thursday in UTC
    ['2026-10-15T03:30:00Z', 'UTC', 'thu', 3 * 60 + 30],
    ['2026-10-15T04:00:00Z', 'America/Cuiaba', 'thu', 0], // midnight is 0, never 24:00
    ['2026-10-14T16:00:00Z', 'Asia/Tokyo', 'thu', 60],
  ])('%s in %s is %s minute %d', (iso, tz, weekday, minutes) => {
    expect(zonedParts(at(iso), tz)).toEqual({ weekday, minutes });
  });
});

describe('weekdays', () => {
  it.each<[string, string, string]>([
    ['2026-10-14T13:00:00Z', 'America/Cuiaba', 'day:wed'],
    ['2026-10-15T03:30:00Z', 'America/Cuiaba', 'day:wed'],
    ['2026-10-15T03:30:00Z', 'UTC', 'day:thu'],
    ['2026-10-15T04:00:00Z', 'America/Cuiaba', 'day:thu'],
    ['2026-10-14T16:00:00Z', 'Asia/Tokyo', 'day:thu'],
    ['2026-10-17T12:00:00Z', 'America/Cuiaba', 'day:sat'],
    ['2026-10-19T03:59:00Z', 'America/Cuiaba', 'day:sun'],
    ['2026-10-19T04:00:00Z', 'America/Cuiaba', 'day:mon'],
  ])('%s in %s follows %s', async (iso, timezone, expected) => {
    const { run } = await scene();
    expect(await nextOf(run, node('weekdays', { timezone }), { now: at(iso) })).toBe(expected);
  });

  it('falls back to America/Cuiaba when the time zone is empty', async () => {
    const { run } = await scene();
    expect(await nextOf(run, node('weekdays', { timezone: '' }), { now: at('2026-10-15T03:30:00Z') })).toBe('day:wed');
  });
});

describe('hours', () => {
  const OFFICE: HoursConfig = {
    timezone: 'America/Cuiaba',
    intervals: [
      { from: '08:00', to: '12:00', days: MON_FRI },
      { from: '14:00', to: '18:00', days: MON_FRI },
    ],
  };

  it.each<[string, string, 'in' | 'out']>([
    ['2026-10-14T11:59:00Z', 'qua 07:59', 'out'],
    ['2026-10-14T12:00:00Z', 'qua 08:00, início incluído', 'in'],
    ['2026-10-14T15:59:00Z', 'qua 11:59', 'in'],
    ['2026-10-14T16:00:00Z', 'qua 12:00, fim excluído', 'out'],
    ['2026-10-14T17:30:00Z', 'qua 13:30, almoço', 'out'],
    ['2026-10-14T18:00:00Z', 'qua 14:00', 'in'],
    ['2026-10-14T21:59:00Z', 'qua 17:59', 'in'],
    ['2026-10-14T22:00:00Z', 'qua 18:00', 'out'],
    ['2026-10-16T21:00:00Z', 'sex 17:00', 'in'],
    ['2026-10-17T14:00:00Z', 'sáb 10:00', 'out'],
    ['2026-10-19T12:00:00Z', 'seg 08:00', 'in'],
  ])('office hours at %s (%s em Cuiabá) → %s', async (iso, _label, expected) => {
    const { run } = await scene();
    expect(await nextOf(run, node('hours', OFFICE), { now: at(iso) })).toBe(expected);
  });

  it('uses the weekday of the block time zone across midnight UTC', async () => {
    const { run } = await scene();
    const lateFriday = (timezone: string) => node('hours', { timezone, intervals: [{ from: '22:00', to: '23:59', days: ['fri'] }] });
    const now = at('2026-10-17T03:00:00Z'); // Friday 23:00 in Cuiabá, Saturday 03:00 in UTC
    expect(await nextOf(run, lateFriday('America/Cuiaba'), { now })).toBe('in');
    expect(await nextOf(run, lateFriday('UTC'), { now })).toBe('out');
  });

  it('applies an interval without days on every day', async () => {
    const { run } = await scene();
    const night = node('hours', { timezone: 'America/Cuiaba', intervals: [{ from: '00:00', to: '06:00' }] });
    expect(await nextOf(run, night, { now: at('2026-10-18T07:00:00Z') })).toBe('in'); // Sunday 03:00
    expect(await nextOf(run, night, { now: at('2026-10-18T10:00:00Z') })).toBe('out'); // Sunday 06:00
  });
});

describe('wait_interval', () => {
  const now = at('2026-10-14T13:00:00Z');
  const wait = (c: Partial<WaitIntervalConfig>) =>
    node('wait_interval', { mode: 'fixed', amount: 5, unit: 'minutes', resumeOnReply: false, ...c });
  const after = (ms: number) => new Date(now.getTime() + ms);

  it.each<[number, TimeUnit, number]>([
    [30, 'seconds', 30_000],
    [10, 'minutes', 600_000],
    [3, 'hours', 10_800_000],
    [2, 'days', 172_800_000],
  ])('fixed %d %s waits on the timer', async (amount, unit, ms) => {
    const { run } = await scene();
    expect(await runBlock(run, wait({ amount, unit }), { now })).toEqual({ wait: 'timer', wakeAt: after(ms) });
  });

  it('with resumeOnReply waits for a reply until the same moment', async () => {
    const { run } = await scene();
    expect(await runBlock(run, wait({ amount: 10, resumeOnReply: true }), { now })).toEqual({ wait: 'reply', timeoutAt: after(600_000) });
  });

  it.each<[string, number]>([
    ['2', 7_200_000],
    ['1,5', 5_400_000],
    [' 0.25 ', 900_000],
  ])('variable %j hours reads the rendered text', async (prazo, ms) => {
    const { run } = await scene({ run: { vars: { prazo: { raw: prazo, value: prazo } } } });
    const n = wait({ mode: 'variable', variable: '{{contexto.prazo}}', unit: 'hours' });
    expect(await runBlock(run, n, { now })).toEqual({ wait: 'timer', wakeAt: after(ms) });
  });

  it.each<[string]>([['amanhã'], ['0'], ['-3'], ['']])('variable %j fails the run', async (prazo) => {
    const { run } = await scene({ run: { vars: { prazo: { raw: prazo, value: prazo } } } });
    const n = wait({ mode: 'variable', variable: '{{contexto.prazo}}', unit: 'hours' });
    expect(await runBlock(run, n, { now })).toEqual({ end: 'failed', error: 'O tempo de espera precisa ser um número maior que zero' });
  });

  it('fixed 0 fails the run', async () => {
    const { run } = await scene();
    expect(await runBlock(run, wait({ amount: 0 }), { now })).toEqual({ end: 'failed', error: 'O tempo de espera precisa ser um número maior que zero' });
  });

  const reply: ResumeEvent = {
    kind: 'reply',
    reply: { messageId: randomUUID(), kind: 'text', body: 'oi', mediaMime: null, mediaName: null, createdAt: now },
  };
  it.each<[string, ResumeEvent, string]>([
    ['timer', { kind: 'timer' }, 'next'],
    ['timeout', { kind: 'timeout' }, 'next'],
    ['reply', reply, 'replied'],
  ])('resume on %s follows %s', async (_label, ev, handle) => {
    const { run } = await scene();
    const n = wait({ resumeOnReply: true });
    const def = definition('wait_interval');
    if (!def.resume) throw new Error('wait_interval precisa de resume');
    expect(await def.resume(await botCtx(run, { now }), run, n, ev)).toEqual({ next: handle });
    expect(outputsOf('wait_interval', n.config).map((o) => o.id)).toContain(handle);
  });
});

describe('wait_interval inside the engine', () => {
  const tenPast = at('2026-10-14T13:10:00Z'); // fake clock starts at 13:00Z
  const alwaysYes: Rule = { left: lit('a'), operator: 'eq', right: lit('a') };

  async function setup(resumeOnReply: boolean) {
    const ectx = await makeTestCtx();
    const es = await seedBasics(ectx);
    // The real start_manual block arrives in Task 8; a pass-through stands in for it here.
    ectx.botRuntime = createBotRuntime({
      now: () => ectx.clock.now(),
      registry: { start_manual: { type: 'start_manual', run: async () => ({ next: 'next' }) } },
    });
    const graph: BotGraph = {
      nodes: [
        node('start_manual', {}, 'inicio'),
        node('wait_interval', { mode: 'fixed', amount: 10, unit: 'minutes', resumeOnReply }, 'espera'),
        node('condition', { logic: 'and', rules: [alwaysYes] }, 'passou'),
        node('condition', { logic: 'and', rules: [alwaysYes] }, 'respondeu'),
      ],
      edges: [
        { id: 'e1', source: 'inicio', sourceHandle: 'next', target: 'espera' },
        { id: 'e2', source: 'espera', sourceHandle: 'next', target: 'passou' },
        ...(resumeOnReply ? [{ id: 'e3', source: 'espera', sourceHandle: 'replied', target: 'respondeu' }] : []),
      ],
    };
    const bot = await createBot(ectx.db, { name: 'Espera', graph, valid: true, publish: true, createdBy: null, manualStart: true });
    await ectx.db.update(bots).set({ status: 'active' }).where(eq(bots.id, bot.id));
    const { chatId } = await seedChat(ectx, { channelId: es.channelId, sectorId: es.defaultSector, name: 'Maria' });
    const started = await startRun(ectx, { botId: bot.id, chatId, entry: 'manual', startedBy: null });
    const load = async () => (await ectx.db.select().from(botRuns).where(eq(botRuns.id, started.id)))[0];
    return { ectx, es, chatId, runId: started.id, load };
  }

  it('fixed: waits on the timer and continues by next only once it is due', async () => {
    const { ectx, runId, load } = await setup(false);
    const waiting = await load();
    expect(waiting.state).toBe('waiting_timer');
    expect(waiting.wakeAt).toEqual(tenPast);

    expect(await resumeOnTimer(ectx, runId, at('2026-10-14T13:05:00Z'))).toBeNull();
    expect((await load()).state).toBe('waiting_timer');

    await resumeOnTimer(ectx, runId, tenPast);
    const done = await load();
    expect(done.state).toBe('finished');
    expect(done.steps.map((st) => st.node)).toContain('passou');
  });

  it('resumeOnReply: a reply before the time follows replied', async () => {
    const { ectx, es, chatId, load } = await setup(true);
    const waiting = await load();
    expect(waiting.state).toBe('waiting_reply');
    expect(waiting.timeoutAt).toEqual(tenPast);

    // waiting_since is the DB clock_timestamp(); the reply must be stored after it (Review Focus 1).
    const createdAt = new Date(Date.now() + 1000);
    const messageId = await seedMessage(ectx, chatId, es.channelId, createdAt, { body: 'oi' });
    expect(await resumeOnReply(ectx, chatId, { messageId, kind: 'text', body: 'oi', mediaMime: null, mediaName: null, createdAt })).toBe(1);

    const done = await load();
    expect(done.state).toBe('finished');
    expect(done.steps.map((st) => st.node)).toContain('respondeu');
    expect(done.steps.map((st) => st.node)).not.toContain('passou');
  });

  it('resumeOnReply: no reply until the time follows next', async () => {
    const { ectx, runId, load } = await setup(true);
    await resumeOnTimer(ectx, runId, tenPast);
    const done = await load();
    expect(done.state).toBe('finished');
    expect(done.steps.map((st) => st.node)).toContain('passou');
    expect(done.steps.map((st) => st.node)).not.toContain('respondeu');
  });
});
```

- [ ] **Step 13: Run the tests to verify they fail**

Run: `npm test -w server -- test/bots/conditions.test.ts`
Expected: FAIL in four places:
- `zonedParts` with `TypeError: zonedParts is not a function`.
- The `weekdays`, `hours` and `wait_interval` tests with `bloco weekdays não registrado em conditionBlocks`, or the same message for `hours` or `wait_interval`.
- `conditionBlocks registry`, because the key lists differ.
- `wait_interval inside the engine`, where the run fails with `'Bloco não suportado'`, so `state` is `failed` and not `waiting_timer`.

The cycle 1 and cycle 2 tests still pass.

- [ ] **Step 14: Write the time blocks**

In `server/src/bots/blocks/conditions.ts`, insert this directly below `const DAY_MS = 86_400_000;`:

```ts
const UNIT_MS: Record<TimeUnit, number> = { seconds: 1_000, minutes: 60_000, hours: 3_600_000, days: DAY_MS };

/** Weekday and minutes since midnight of `d` in `timeZone`. Throws RangeError on an unknown zone (validateGraph rejects those). */
export function zonedParts(d: Date, timeZone: string): { weekday: Weekday; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    weekday: part('weekday').toLowerCase() as Weekday, // 'Wed' → 'wed'
    minutes: (Number(part('hour')) % 24) * 60 + Number(part('minute')),
  };
}

/** 'HH:MM' → minutes since midnight (NaN when malformed, which matches no interval). */
function hhmm(s: string): number {
  const [h = '', m = ''] = s.split(':');
  return Number(h) * 60 + Number(m);
}
```

Then insert these entries at the end of the `conditionBlocks` object, after the `parallel_bot` entry and before its closing `};`, which is the last line of the file:

```ts
  weekdays: {
    type: 'weekdays',
    run: async (ctx, _run, node) => {
      const { weekday } = zonedParts(ctx.now, conf<WeekdaysConfig>(node).timezone || DEFAULT_TIMEZONE);
      return { next: `day:${weekday}` };
    },
  },
  hours: {
    type: 'hours',
    run: async (ctx, _run, node) => {
      const c = conf<HoursConfig>(node);
      const { weekday, minutes } = zonedParts(ctx.now, c.timezone || DEFAULT_TIMEZONE);
      const inside = (c.intervals ?? []).some(
        (i) => (!i.days || i.days.includes(weekday)) && minutes >= hhmm(i.from) && minutes < hhmm(i.to), // `to` exclusive
      );
      return { next: inside ? 'in' : 'out' };
    },
  },
  wait_interval: {
    type: 'wait_interval',
    run: async (ctx, _run, node) => {
      const c = conf<WaitIntervalConfig>(node);
      const amount = c.mode === 'variable' ? toNumber(await ctx.render(c.variable ?? '')) : c.amount;
      const ms = amount * UNIT_MS[c.unit];
      const wake = new Date(ctx.now.getTime() + ms);
      if (!(ms > 0) || Number.isNaN(wake.getTime())) {
        return { end: 'failed', error: 'O tempo de espera precisa ser um número maior que zero' };
      }
      return c.resumeOnReply ? { wait: 'reply', timeoutAt: wake } : { wait: 'timer', wakeAt: wake };
    },
    // timer (plain wait) and timeout (resumeOnReply, nobody answered) both mean the time ran out.
    resume: async (_ctx, _run, _node, ev) => ({ next: ev.kind === 'reply' ? 'replied' : 'next' }),
  },
```

- [ ] **Step 15: Register the condition blocks**

In `server/src/bots/registry.ts`, add this import next to the other imports:

```ts
import { conditionBlocks } from './blocks/conditions.js';
```

Then change the `defaultRegistry` declaration that Task 5 left as `export const defaultRegistry: BlockRegistry = {};` to:

```ts
export const defaultRegistry: BlockRegistry = {
  ...conditionBlocks,
};
```

If Task 5 already spread other families into it, keep those and add `...conditionBlocks,` among them.

- [ ] **Step 16: Run the tests to verify they pass**

Run: `npm test -w server -- test/bots/conditions.test.ts`
Expected: PASS for every test in the file.

Run: `npm run typecheck -w server`
Expected: exits 0 with no errors.

Run: `npm test -w server`
Expected: PASS, including `test/bots/engine.test.ts` and `test/triage/triage.test.ts`.

- [ ] **Step 17: Commit**

```bash
git add server/src/bots/blocks/conditions.ts server/src/bots/registry.ts server/test/bots/conditions.test.ts
git commit -m "feat(bots): weekdays, hours and wait_interval blocks; register condition blocks" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


---

### Task 7: Action blocks I

Six action blocks: `send_message`, `note`, `ask_choice`, `ask_input`, `set_contact_field` and `edit_tags`. The task also adds the exported system send that they use, which the triage reuses from now on.

**Files:**
- Modify: `server/src/messages/send.ts`: add `SystemSendInput` and `sendSystemMessage` (text or bot-library attachment, `botRunId`).
- Modify: `server/src/triage/triage.ts`: delete the private `sendSystemText`, call `sendSystemMessage`, export `normalize`.
- Create: `server/src/bots/blocks/actions.ts`: `actionBlocks` (the six blocks) and the helpers `send`, `asBlockError`, `saveContactField` and `UUID_RE`. Task 8 puts its blocks in `blocks/actions-2.ts`.
- Modify: `server/src/bots/registry.ts`: spread `actionBlocks` into `defaultRegistry`.
- Test: `server/test/bots/actions-1.test.ts`

**Interfaces:**
- Consumes:
  - Task 1 (`@talk/shared`): the types `BlockType`, `BotGraph`, `BotNode`, `BotEdge`, `BotAttachment`, `InputValidator`, `SendMessageConfig`, `NoteConfig`, `AskChoiceConfig`, `AskInputConfig`, `SetContactFieldConfig` and `EditTagsConfig`, plus the chat event kind `'bot_note'` in `ChatEventKind`.
  - Task 2: `bots`, `botRuns` and `messages.botRunId` in `server/src/db/schema.ts`, and from `server/src/bots/repo.ts`:
    - `createBot(db, { name, graph, valid, publish, createdBy, manualStart? }): Promise<BotRow>`
    - `type BotRunRow`
  - Task 3: `validateAnswer(cfg: Pick<AskInputConfig, 'validator' | 'mediaTypes' | 'regex'>, input: AnswerInput): AnswerResult` from `server/src/bots/validators.ts`.
  - Task 4: `ctx.render` already renders `{{contato.*}}`, `{{campo.*}}`, `{{atendente.*}}` and `{{contexto.*}}`.
  - Task 5, from `server/src/bots/registry.ts`: `BlockDefinition`, `BlockRegistry`, `BlockResult`, `BotCtx`, `InboundReply` and `defaultRegistry` (types only); `BlockError` from `server/src/bots/block-error.ts`.
  - Task 5, from `server/src/bots/engine.ts`:
    - `startRun(ctx, StartRunInput): Promise<BotRunRow>`
    - `resumeOnReply(ctx, chatId, reply): Promise<number>`
    - `resumeOnTimer(ctx, runId, now): Promise<BotRunRow | null>`
  - Task 5, from `server/src/bots/runtime.ts`: `createBotRuntime({ now, registry })`. `makeTestCtx()` also returns `clock: FakeClock` (default `2026-10-14T13:00:00Z`).
- Produces:
  - In `server/src/messages/send.ts`:
    ```ts
    export interface SystemSendInput { text?: string; attachment?: BotAttachment | null; botRunId?: string | null }
    export async function sendSystemMessage(ctx: AppCtx, chat: ChatRow, input: SystemSendInput)
      : Promise<{ ok: boolean; messageId: string | null; echoDropped: boolean }>;
    // messageId null = contact has no WhatsApp address (nothing stored). The caller publishes the chat.
    ```
  - In `server/src/triage/triage.ts`: `export function normalize(s: string): string`. Task 6 may already have exported it; if so, leave it.
  - In `server/src/bots/blocks/actions.ts`:
    - `export const actionBlocks: BlockRegistry` with `send_message`, `note`, `ask_choice`, `ask_input`, `set_contact_field` and `edit_tags`. Task 8 adds its entries to this object literal.
    - These helpers stay private to the file, and Task 8 may use them:
      ```ts
      const UUID_RE: RegExp
      async function asBlockError<T>(fn: () => Promise<T>): Promise<T>  // HttpError → BlockError(message)
      async function send(ctx: BotCtx, run: BotRunRow, input: { text?: string; attachment?: BotAttachment | null }): Promise<void>
        // sendSystemMessage({ botRunId: run.id }) + publishChat; !ok → BlockError('Não foi possível enviar a mensagem')
      async function saveContactField(ctx: BotCtx, fieldId: string, value: string): Promise<void>
        // custom field id or NativeFieldId; BlockError('Campo inexistente')
      ```
  - The texts the blocks send, which Task 12 relies on:
    - `ask_choice` sends `text + '\n\n' + 'key: label'` lines.
    - An invalid answer with retries left sends **two messages**: the invalid text (default `'Opção inválida.'`), then the menu again.
    - `ask_input` sends only the invalid text on retry (default `'Resposta inválida. Tente de novo.'`) and never repeats the question.

**Decisions inside this task:**
- `ask_choice` matching: the spec's "rótulo/nome do setor" means the option **label**. Options carry no sector id, and in the office template the label is the sector's name. A reply matches when `normalize(body)` equals `normalize(key)` or `normalize(label)`.
- A retry waits again with the deadline it already had: `run.timeoutAt`, or `now + timeoutHours` if the engine cleared it.
- Contact-service `HttpError`s (`'Campo inexistente'`, `'Etiqueta inexistente'`, `'Telefone inválido'`, `'Contato não encontrado'`) become `BlockError`s with the same text. They are safe to show and lead to the `error` output.
- The kind of an attachment comes from the existing `fileKind` (`image/jpeg` and `image/png` → image, `video/mp4` → video, anything else → document). This is the same rule agent sends use.
- An attachment path must normalize to `bots/…` with no backslash or NUL. Otherwise the block throws `BlockError('Arquivo do chatbot inválido')`.

---

- [ ] **Step 1: Write the failing test file (shared helpers + `sendSystemMessage`)**

Create `server/test/bots/actions-1.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { BlockType, BotEdge, BotGraph, BotNode, InputValidator } from '@talk/shared';
import { makeTestCtx, seedBasics, type Seeded } from '../helpers.js';
import { eventsOf, insertChat, newContact } from '../inbox/fixtures.js';
import { botRuns, bots, chats, contactFieldValues, contactTags, contacts, customFields, messages, tags } from '../../src/db/schema.js';
import { createBot, type BotRunRow } from '../../src/bots/repo.js';
import { resumeOnReply, resumeOnTimer, startRun } from '../../src/bots/engine.js';
import { createBotRuntime } from '../../src/bots/runtime.js';
import type { InboundReply } from '../../src/bots/registry.js';
import { sendSystemMessage } from '../../src/messages/send.js';

type Ctx = Awaited<ReturnType<typeof makeTestCtx>>;
type Media = { kind?: InboundReply['kind']; mediaMime?: string; mediaName?: string };

const HOUR = 3_600_000;

let ctx: Ctx;
let seed: Seeded;
let contactId: string;
let chatId: string;
let botSeq = 0;

beforeEach(async () => {
  ctx = await makeTestCtx();
  // start_manual is registered by Task 8; this stand-in keeps the file independent of it (same behavior).
  ctx.botRuntime = createBotRuntime({
    now: () => ctx.clock.now(),
    registry: { start_manual: { type: 'start_manual', run: async () => ({ next: 'next' }) } },
  });
  seed = await seedBasics(ctx);
  contactId = await newContact(ctx, { name: 'Maria Silva' });
  chatId = await insertChat(ctx, { channelId: seed.channelId, sectorId: seed.defaultSector, contactId });
});

const node = (id: string, type: BlockType, config: Record<string, unknown> = {}): BotNode => ({
  id, type, name: id, position: { x: 0, y: 0 }, config,
});
const edge = (source: string, sourceHandle: string, target: string): BotEdge => ({
  id: `${source}.${sourceHandle}`, source, sourceHandle, target,
});

async function reloadRun(id: string): Promise<BotRunRow> {
  const [row] = await ctx.db.select().from(botRuns).where(eq(botRuns.id, id));
  return row!;
}

/** start_manual 'inicio' → nodes[0]; publishes and activates a fresh bot, starts it on `chat`, returns the stored run. */
async function runFlow(nodes: BotNode[], edges: BotEdge[] = [], chat = chatId): Promise<BotRunRow> {
  const graph: BotGraph = {
    nodes: [node('inicio', 'start_manual'), ...nodes],
    edges: [edge('inicio', 'next', nodes[0]!.id), ...edges],
  };
  botSeq += 1;
  const bot = await createBot(ctx.db, { name: `Teste ${botSeq}`, graph, valid: true, publish: true, createdBy: null, manualStart: true });
  await ctx.db.update(bots).set({ status: 'active' }).where(eq(bots.id, bot.id));
  const run = await startRun(ctx, { botId: bot.id, chatId: chat, entry: 'manual', startedBy: null });
  return reloadRun(run.id);
}

/** Stores an inbound message the way ingest does and returns it as an InboundReply. */
async function storeInbound(body: string | null, media: Media = {}, chat = chatId): Promise<InboundReply> {
  const id = randomUUID();
  // Comfortably after waiting_since (DB clock_timestamp(), microseconds), even when the test runs within one millisecond.
  const createdAt = new Date(Date.now() + 1000);
  const kind = media.kind ?? 'text';
  const mediaMime = media.mediaMime ?? null;
  const mediaName = media.mediaName ?? null;
  await ctx.db.insert(messages).values({
    id, chatId: chat, channelId: seed.channelId, direction: 'in', kind, body, mediaMime, mediaName,
    authorId: null, externalId: `in-${id}`, status: 'sent', sentAt: createdAt, createdAt,
  });
  return { messageId: id, kind, body, mediaMime, mediaName, createdAt };
}

async function reply(body: string | null, media: Media = {}, chat = chatId): Promise<void> {
  await resumeOnReply(ctx, chat, await storeInbound(body, media, chat));
}

/** Outcome of the last step logged for a node (handle id, 'wait:reply', 'error'…). */
const outcome = (run: BotRunRow, nodeId: string) => run.steps.filter((s) => s.node === nodeId).at(-1)?.outcome;
const texts = () => ctx.wa.sent.filter((s) => s.method === 'sendText').map((s) => (s.payload as { text: string }).text);

async function chatRow() {
  const [row] = await ctx.db.select().from(chats).where(eq(chats.id, chatId));
  return row!;
}

describe('sendSystemMessage', () => {
  it('stores an author-less out message, sends it as text and leaves waiting alone', async () => {
    const res = await sendSystemMessage(ctx, await chatRow(), { text: 'Olá do sistema' });

    expect(res).toEqual({ ok: true, messageId: expect.any(String), echoDropped: false });
    expect(ctx.wa.sent).toHaveLength(1);
    expect(ctx.wa.sent[0]).toMatchObject({ method: 'sendText', instance: seed.instance, payload: { text: 'Olá do sistema' } });
    const [msg] = await ctx.db.select().from(messages).where(eq(messages.id, res.messageId!));
    expect(msg).toMatchObject({ direction: 'out', kind: 'text', body: 'Olá do sistema', authorId: null, botRunId: null, status: 'sent' });
    expect(msg!.externalId).toMatch(/^fake-/);
    expect((await chatRow()).lastMessagePreview).toBe('Olá do sistema');
    expect(ctx.hub.events.filter((e) => e.messageId === msg!.id).map((e) => e.type)).toEqual(['message.created', 'message.updated']);
  });

  it('sends a bot media file with the text as caption', async () => {
    const pdf = Buffer.from('%PDF-1.4 teste');
    await mkdir(join(ctx.config.mediaDir, 'bots'), { recursive: true });
    await writeFile(join(ctx.config.mediaDir, 'bots', 'tabela.pdf'), pdf);

    const res = await sendSystemMessage(ctx, await chatRow(), {
      text: 'Segue a tabela',
      attachment: { path: 'bots/tabela.pdf', name: 'Tabela.pdf', mime: 'application/pdf', size: pdf.length },
    });

    expect(res.ok).toBe(true);
    expect(ctx.wa.sent[0]).toMatchObject({
      method: 'sendMedia',
      payload: { media: { kind: 'document', mime: 'application/pdf', fileName: 'Tabela.pdf', caption: 'Segue a tabela', base64: pdf.toString('base64') } },
    });
    const [msg] = await ctx.db.select().from(messages).where(eq(messages.id, res.messageId!));
    expect(msg).toMatchObject({ kind: 'document', body: 'Segue a tabela', mediaPath: 'bots/tabela.pdf', mediaName: 'Tabela.pdf', mediaMime: 'application/pdf', mediaSize: pdf.length });
  });

  it('stores nothing when the contact has no WhatsApp address', async () => {
    await ctx.db.update(contacts).set({ phone: null, lid: null }).where(eq(contacts.id, contactId));

    const res = await sendSystemMessage(ctx, await chatRow(), { text: 'Oi' });

    expect(res).toEqual({ ok: false, messageId: null, echoDropped: false });
    expect(ctx.wa.sent).toHaveLength(0);
    expect(await ctx.db.select().from(messages).where(eq(messages.chatId, chatId))).toHaveLength(0);
  });

  it('marks the message failed when the gateway throws', async () => {
    ctx.wa.failNext(new Error('Evolution fora do ar'));

    const res = await sendSystemMessage(ctx, await chatRow(), { text: 'Oi' });

    expect(res.ok).toBe(false);
    const [msg] = await ctx.db.select().from(messages).where(eq(messages.id, res.messageId!));
    expect(msg).toMatchObject({ status: 'failed', error: 'Evolution fora do ar' });
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -w server -- test/bots/actions-1.test.ts`
Expected: FAIL. The four `sendSystemMessage` tests fail with `TypeError: sendSystemMessage is not a function`, because it is not exported yet.

- [ ] **Step 3: Add `sendSystemMessage` to `server/src/messages/send.ts`**

Add this type import below the existing imports:

```ts
import type { BotAttachment } from '@talk/shared';
```

Add this block right after the `deliver` function. It moves the triage's `sendSystemText` here, adds attachments, and sends through the existing `callGateway`:

```ts
export interface SystemSendInput { text?: string; attachment?: BotAttachment | null; botRunId?: string | null }

/**
 * System send (triage, chatbot): an `out` message without author, signature or owner change. It does not touch
 * waiting/unread (`chat.waiting` is restored when a dropped echo cleared it); the caller publishes chat.updated.
 * An attachment is a file under config.mediaDir (bot library: 'bots/…'); `text` becomes its caption.
 * Returns ok = gateway accepted it, messageId = stored row (null when the contact has no address), echoDropped.
 */
export async function sendSystemMessage(
  ctx: AppCtx,
  chat: ChatRow,
  input: SystemSendInput,
): Promise<{ ok: boolean; messageId: string | null; echoDropped: boolean }> {
  const [contact] = await ctx.db
    .select({ phone: contacts.phone, lid: contacts.lid })
    .from(contacts)
    .where(eq(contacts.id, chat.contactId));
  if (!waAddress(contact)) return { ok: false, messageId: null, echoDropped: false };

  const attachment = input.attachment ?? null;
  const text = input.text || null;
  const kind: OutKind = attachment ? fileKind(attachment.mime, false) : 'text';
  const now = new Date();
  const row = await ctx.db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(messages)
      .values({
        id: randomUUID(),
        chatId: chat.id,
        channelId: chat.channelId,
        direction: 'out',
        kind,
        body: text,
        mediaPath: attachment?.path ?? null,
        mediaMime: attachment?.mime ?? null,
        mediaSize: attachment?.size ?? null,
        mediaName: attachment?.name ?? null,
        authorId: null,
        botRunId: input.botRunId ?? null,
        status: 'pending',
        sentAt: now,
        createdAt: now,
      })
      .returning();
    await tx
      .update(chats)
      .set({
        lastMessageAt: sql`greatest(${chats.lastMessageAt}, ${now.toISOString()}::timestamptz)`,
        lastMessagePreview: messagePreview(kind, text),
      })
      .where(eq(chats.id, chat.id));
    return inserted!;
  });
  await ctx.hub.publishMessage(chat.id, 'message.created', row.id);

  let result: SendResult | null = null;
  let error = 'Falha ao enviar';
  try {
    result = await callGateway(ctx, row);
  } catch (err) {
    if (err instanceof Error && err.message) error = err.message.slice(0, 200);
  }
  let echoDropped = false;
  if (result) {
    ({ echoDropped } = await markSent(ctx.db, row.id, chat.channelId, result.externalId));
    // The dropped echo's ingest (fromMe → out) cleared waiting; system messages never touch it.
    if (echoDropped) {
      await ctx.db.update(chats).set({ waiting: chat.waiting }).where(and(eq(chats.id, chat.id), eq(chats.state, 'open')));
    }
  } else {
    await ctx.db.update(messages).set({ status: 'failed', error }).where(eq(messages.id, row.id));
  }
  await ctx.hub.publishMessage(chat.id, 'message.updated', row.id);
  return { ok: result !== null, messageId: row.id, echoDropped };
}
```

- [ ] **Step 4: Switch the triage to `sendSystemMessage` and export `normalize`**

In `server/src/triage/triage.ts`:

1. Replace the import block:
```ts
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AppCtx } from '../ctx.js';
import type { Db, Tx } from '../db/client.js';
import { channels, chats, contacts, messages, sectors, settings } from '../db/schema.js';
import type { ChatRow } from '../inbox/chats.js';
import { addEvent } from '../inbox/events.js';
import { messagePreview } from '../messages/dto.js';
import { markSent, waAddress } from '../messages/send.js';
```
with:
```ts
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AppCtx } from '../ctx.js';
import type { Db, Tx } from '../db/client.js';
import { chats, sectors, settings } from '../db/schema.js';
import type { ChatRow } from '../inbox/chats.js';
import { addEvent } from '../inbox/events.js';
import { sendSystemMessage } from '../messages/send.js';
```
2. Replace `function normalize(s: string): string {` with `export function normalize(s: string): string {`. If Task 6 already exported it, skip this.
3. Delete the whole private `sendSystemText` function, from its comment `// System (bot) text: stored as an \`out\` message …` through its closing `}`.
4. In `startTriage`, replace:
```ts
  const sent = await sendSystemText(ctx, chat, text);
```
with:
```ts
  const sent = await sendSystemMessage(ctx, chat, { text });
```
   and replace the comment `// The dropped echo's ingest (fromMe → out) also cleared triage_pending (sendSystemText restored waiting).` with `// The dropped echo's ingest (fromMe → out) also cleared triage_pending (sendSystemMessage restored waiting).`
5. In `handleTriageReply`, replace:
```ts
  if (!option && menu.enabled && menu.invalidText.trim()) await sendSystemText(ctx, chat, menu.invalidText.trim());
```
with:
```ts
  if (!option && menu.enabled && menu.invalidText.trim()) await sendSystemMessage(ctx, chat, { text: menu.invalidText.trim() });
```

- [ ] **Step 5: Run the new tests, the triage tests and the send tests**

Run: `npm test -w server -- test/bots/actions-1.test.ts test/triage/triage.test.ts test/messages/send.test.ts`
Expected: PASS. All four `sendSystemMessage` tests pass, and the existing triage tests (including the echo-beats-response test) and send tests pass unchanged.

- [ ] **Step 6: Commit**

```bash
git add server/src/messages/send.ts server/src/triage/triage.ts server/test/bots/actions-1.test.ts
git commit -m "refactor(server): envio de sistema exportado com anexo e bot_run_id, usado pela triagem

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Write the failing tests for `send_message`, `note`, `set_contact_field` and `edit_tags`**

Append to `server/test/bots/actions-1.test.ts`:

```ts
describe('send_message', () => {
  it('renders variables, tags the message with the run and follows next', async () => {
    const run = await runFlow([node('ola', 'send_message', { text: 'Olá {{contato.primeiro_nome}}!', attachment: null, signature: false })]);

    expect(run.state).toBe('finished');
    expect(outcome(run, 'ola')).toBe('next');
    expect(texts()).toEqual(['Olá Maria!']);
    const [msg] = await ctx.db.select().from(messages).where(eq(messages.chatId, chatId));
    expect(msg).toMatchObject({ direction: 'out', authorId: null, botRunId: run.id, body: 'Olá Maria!', status: 'sent' });
  });

  it('sends a file from the bot library with the rendered caption', async () => {
    await mkdir(join(ctx.config.mediaDir, 'bots'), { recursive: true });
    await writeFile(join(ctx.config.mediaDir, 'bots', 'foto.png'), Buffer.from('png'));

    const run = await runFlow([
      node('foto', 'send_message', {
        text: 'Para {{contato.nome}}',
        attachment: { path: 'bots/foto.png', name: 'foto.png', mime: 'image/png', size: 3 },
        signature: false,
      }),
    ]);

    expect(run.state).toBe('finished');
    expect(ctx.wa.sent).toHaveLength(1);
    expect(ctx.wa.sent[0]).toMatchObject({ method: 'sendMedia', payload: { media: { kind: 'image', caption: 'Para Maria Silva', fileName: 'foto.png' } } });
  });

  it('refuses an attachment outside the bot library without sending', async () => {
    const run = await runFlow([
      node('arquivo', 'send_message', {
        text: '',
        attachment: { path: 'bots/../../segredo.txt', name: 'segredo.txt', mime: 'text/plain', size: 1 },
        signature: false,
      }),
    ]);

    expect(run).toMatchObject({ state: 'failed', error: 'Arquivo do chatbot inválido' });
    expect(ctx.wa.sent).toHaveLength(0);
  });

  it('follows error when WhatsApp refuses the message', async () => {
    ctx.wa.failNext();

    const run = await runFlow(
      [node('ola', 'send_message', { text: 'Oi', attachment: null, signature: false }), node('falhou', 'note', { text: 'Envio falhou' })],
      [edge('ola', 'error', 'falhou')],
    );

    expect(outcome(run, 'ola')).toBe('error');
    expect(run.state).toBe('finished');
    expect((await eventsOf(ctx, chatId)).filter((e) => e.kind === 'bot_note')).toHaveLength(1);
    const [msg] = await ctx.db.select().from(messages).where(eq(messages.chatId, chatId));
    expect(msg!.status).toBe('failed');
  });

  it('fails the run when the send fails and error is not connected', async () => {
    ctx.wa.failNext();

    const run = await runFlow([node('ola', 'send_message', { text: 'Oi', attachment: null, signature: false })]);

    expect(run).toMatchObject({ state: 'failed', error: 'Não foi possível enviar a mensagem' });
  });
});

describe('note', () => {
  it('writes a bot_note event with the rendered text and sends nothing', async () => {
    const run = await runFlow([node('nota', 'note', { text: 'Cliente {{contato.nome}} entrou pelo bot' })]);

    expect(run.state).toBe('finished');
    expect(outcome(run, 'nota')).toBe('next');
    expect(ctx.wa.sent).toHaveLength(0);
    const ev = (await eventsOf(ctx, chatId)).find((e) => e.kind === 'bot_note');
    expect(ev).toMatchObject({
      authorId: null,
      data: { botId: run.botId, botName: expect.stringMatching(/^Teste /), runId: run.id, text: 'Cliente Maria Silva entrou pelo bot' },
    });
  });
});

describe('set_contact_field', () => {
  it('renders the value into a custom field and into the contact name', async () => {
    const [field] = await ctx.db.insert(customFields).values({ name: 'Origem', kind: 'text' }).returning();

    const run = await runFlow(
      [
        node('origem', 'set_contact_field', { fieldId: field!.id, value: 'Bot {{contato.primeiro_nome}}' }),
        node('nome', 'set_contact_field', { fieldId: 'native:name', value: 'Maria Souza' }),
      ],
      [edge('origem', 'next', 'nome')],
    );

    expect(run.state).toBe('finished');
    const [saved] = await ctx.db
      .select()
      .from(contactFieldValues)
      .where(and(eq(contactFieldValues.contactId, contactId), eq(contactFieldValues.fieldId, field!.id)));
    expect(saved?.value).toBe('Bot Maria');
    const [contact] = await ctx.db.select().from(contacts).where(eq(contacts.id, contactId));
    expect(contact!.name).toBe('Maria Souza');
  });

  it('fails with "Campo inexistente" for a missing field, and follows error when connected', async () => {
    const failed = await runFlow([node('campo', 'set_contact_field', { fieldId: randomUUID(), value: 'x' })]);
    expect(failed).toMatchObject({ state: 'failed', error: 'Campo inexistente' });

    const handled = await runFlow(
      [node('campo', 'set_contact_field', { fieldId: 'nao-e-uuid', value: 'x' }), node('erro', 'note', { text: 'sem campo' })],
      [edge('campo', 'error', 'erro')],
    );
    expect(outcome(handled, 'campo')).toBe('error');
    expect(handled.state).toBe('finished');
  });
});

describe('edit_tags', () => {
  async function newTag(name: string): Promise<string> {
    const [t] = await ctx.db.insert(tags).values({ name, color: 'blue' }).returning();
    return t!.id;
  }

  it('adds and removes contact tags and keeps the others', async () => {
    const vip = await newTag('VIP');
    const novo = await newTag('Novo');
    const antigo = await newTag('Antigo');
    await ctx.db.insert(contactTags).values([{ contactId, tagId: vip }, { contactId, tagId: antigo }]);

    const run = await runFlow([node('etiquetas', 'edit_tags', { add: [novo, vip], remove: [antigo] })]);

    expect(run.state).toBe('finished');
    const rows = await ctx.db.select().from(contactTags).where(eq(contactTags.contactId, contactId));
    expect(rows.map((r) => r.tagId).sort()).toEqual([vip, novo].sort());
  });

  it('fails with "Etiqueta inexistente" and leaves the tags alone', async () => {
    const vip = await newTag('VIP');
    await ctx.db.insert(contactTags).values({ contactId, tagId: vip });

    const run = await runFlow([node('etiquetas', 'edit_tags', { add: [randomUUID()], remove: [vip] })]);

    expect(run).toMatchObject({ state: 'failed', error: 'Etiqueta inexistente' });
    const rows = await ctx.db.select().from(contactTags).where(eq(contactTags.contactId, contactId));
    expect(rows.map((r) => r.tagId)).toEqual([vip]);
  });
});
```

- [ ] **Step 8: Run the tests and confirm they fail**

Run: `npm test -w server -- test/bots/actions-1.test.ts`
Expected: FAIL. The new tests fail on their first assertion, because the runs end `failed` with error `'Bloco não suportado'` (the registry has no `send_message`, `note`, `set_contact_field` or `edit_tags` yet). The `sendSystemMessage` tests still pass.

- [ ] **Step 9: Create `server/src/bots/blocks/actions.ts` with the four simple blocks**

```ts
import { posix } from 'node:path';
import { eq } from 'drizzle-orm';
import type { BotAttachment, EditTagsConfig, NoteConfig, SendMessageConfig, SetContactFieldConfig } from '@talk/shared';
import { setContactFields, setContactTags, updateContact, type ContactInput } from '../../contacts/service.js';
import { contactTags, contacts } from '../../db/schema.js';
import { addEvent } from '../../inbox/events.js';
import { HttpError } from '../../lib/http-error.js';
import { sendSystemMessage, type SystemSendInput } from '../../messages/send.js';
import type { BotRunRow } from '../repo.js';
import { BlockError } from '../block-error.js';
import type { BlockDefinition, BlockRegistry, BotCtx } from '../registry.js';

// Action blocks (spec §4 "Ação"). Blocks never write bot_runs: they mutate run.vars / run.retries and return a BlockResult.
// BlockError comes from block-error.ts, not registry.ts: registry.ts imports this module at load time, so a value import back from it would hit a TDZ error.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The contact services throw HttpError with safe pt-BR text ('Campo inexistente', 'Etiqueta inexistente', 'Telefone inválido'). */
async function asBlockError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpError) throw new BlockError(err.message);
    throw err;
  }
}

/** System send tagged with the run; publishes the chat (new preview); throws when WhatsApp did not take it. */
async function send(ctx: BotCtx, run: BotRunRow, input: Omit<SystemSendInput, 'botRunId'>): Promise<void> {
  const res = await sendSystemMessage(ctx.app, ctx.chat, { ...input, botRunId: run.id });
  if (res.messageId) await ctx.app.hub.publishChat(ctx.chat.id);
  if (!res.ok) throw new BlockError('Não foi possível enviar a mensagem');
}

/** Bot media library only: a relative path that stays under bots/ (no traversal, no Windows separators). */
function libraryFile(a: BotAttachment): BotAttachment {
  const path = posix.normalize(a.path);
  if (/[\\\0]/.test(a.path) || !path.startsWith('bots/')) throw new BlockError('Arquivo do chatbot inválido');
  return { ...a, path };
}

/** Writes a custom field (by id) or a NativeFieldId; an empty value clears it. city/state live in contacts.address. */
async function saveContactField(ctx: BotCtx, fieldId: string, value: string): Promise<void> {
  const contactId = ctx.chat.contactId;
  const v = value.trim();
  const native: ContactInput | null =
    fieldId === 'native:name' ? { name: v || null }
    : fieldId === 'native:email' ? { email: v || null }
    : fieldId === 'native:landline' ? { landline: v || null }
    : null;
  if (native) {
    await asBlockError(() => updateContact(ctx.app, contactId, native));
    return;
  }
  if (fieldId === 'native:city' || fieldId === 'native:state') {
    const key = fieldId === 'native:city' ? 'city' : 'state';
    const [row] = await ctx.app.db.select({ address: contacts.address }).from(contacts).where(eq(contacts.id, contactId));
    const address: Record<string, string> = { ...(row?.address ?? {}) };
    if (v) address[key] = v;
    else delete address[key];
    await asBlockError(() => updateContact(ctx.app, contactId, { address }));
    return;
  }
  if (!UUID_RE.test(fieldId)) throw new BlockError('Campo inexistente');
  await asBlockError(() => setContactFields(ctx.app, contactId, { [fieldId]: v }));
}

const sendMessage: BlockDefinition = {
  type: 'send_message',
  async run(ctx, run, node) {
    const cfg = node.config as unknown as SendMessageConfig;
    const text = (await ctx.render(cfg.text ?? '')).trim();
    const attachment = cfg.attachment ? libraryFile(cfg.attachment) : null;
    if (!text && !attachment) throw new BlockError('Mensagem vazia');
    await send(ctx, run, { text: text || undefined, attachment });
    return { next: 'next' };
  },
};

const note: BlockDefinition = {
  type: 'note',
  async run(ctx, _run, node) {
    const cfg = node.config as unknown as NoteConfig;
    const text = await ctx.render(cfg.text ?? '');
    const { botId, botName, runId } = ctx.actor;
    await addEvent(ctx.app.db, ctx.chat.id, 'bot_note', { botId, botName, runId, text }, null);
    await ctx.app.hub.publishChat(ctx.chat.id);
    return { next: 'next' };
  },
};

const setContactField: BlockDefinition = {
  type: 'set_contact_field',
  async run(ctx, _run, node) {
    const cfg = node.config as unknown as SetContactFieldConfig;
    await saveContactField(ctx, cfg.fieldId ?? '', await ctx.render(cfg.value ?? ''));
    return { next: 'next' };
  },
};

const editTags: BlockDefinition = {
  type: 'edit_tags',
  async run(ctx, _run, node) {
    const cfg = node.config as unknown as EditTagsConfig;
    const add = cfg.add ?? [];
    if (add.some((id) => !UUID_RE.test(id))) throw new BlockError('Etiqueta inexistente');
    const remove = new Set(cfg.remove ?? []);
    const current = await ctx.app.db
      .select({ tagId: contactTags.tagId })
      .from(contactTags)
      .where(eq(contactTags.contactId, ctx.chat.contactId));
    const next = [...new Set([...current.map((r) => r.tagId), ...add])].filter((id) => !remove.has(id));
    // setContactTags replaces the whole set, so pass the merged list; it rejects unknown tags with 'Etiqueta inexistente'.
    await asBlockError(() => setContactTags(ctx.app, ctx.chat.contactId, next));
    return { next: 'next' };
  },
};

export const actionBlocks: BlockRegistry = {
  send_message: sendMessage,
  note,
  set_contact_field: setContactField,
  edit_tags: editTags,
};
```

- [ ] **Step 10: Register the action blocks**

In `server/src/bots/registry.ts`, add next to the other block imports:

```ts
import { actionBlocks } from './blocks/actions.js';
```

Then add `...actionBlocks` to the `defaultRegistry` object literal, after the spreads already there. Keep every existing spread. After Task 6 it reads:

```ts
export const defaultRegistry: BlockRegistry = { ...conditionBlocks, ...actionBlocks };
```

- [ ] **Step 11: Run the tests and confirm they pass**

Run: `npm test -w server -- test/bots/actions-1.test.ts`
Expected: PASS. All tests in `sendSystemMessage`, `send_message`, `note`, `set_contact_field` and `edit_tags` pass.

- [ ] **Step 12: Commit**

```bash
git add server/src/bots/blocks/actions.ts server/src/bots/registry.ts server/test/bots/actions-1.test.ts
git commit -m "feat(server): blocos de chatbot enviar mensagem, nota, preencher campo e editar etiquetas

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 13: Write the failing tests for `ask_choice` and `ask_input`**

Append to `server/test/bots/actions-1.test.ts`:

```ts
const MENU = {
  text: 'Escolha uma opção:',
  options: [{ key: '1', label: 'Atendimento' }, { key: '2', label: 'Financeiro' }, { key: '3', label: 'Jurídico' }],
  invalidRetries: 1,
  timeoutHours: 24,
};
const MENU_TEXT = 'Escolha uma opção:\n\n1: Atendimento\n2: Financeiro\n3: Jurídico';

const askInput = (over: Record<string, unknown>) => ({
  text: 'Informe:', validator: 'any', useLastMessage: false, invalidRetries: 1, timeoutHours: null, saveToField: null, ...over,
});

describe('ask_choice', () => {
  it('sends the numbered menu and waits with a timeout', async () => {
    const run = await runFlow([node('menu', 'ask_choice', MENU)]);

    expect(texts()).toEqual([MENU_TEXT]);
    expect(run).toMatchObject({ state: 'waiting_reply', waitNodeId: 'menu' });
    expect(run.timeoutAt?.getTime()).toBe(ctx.clock.now().getTime() + 24 * HOUR);
    const [msg] = await ctx.db.select().from(messages).where(eq(messages.chatId, chatId));
    expect(msg!.botRunId).toBe(run.id);
  });

  it('waits forever when timeoutHours is null', async () => {
    const run = await runFlow([node('menu', 'ask_choice', { ...MENU, timeoutHours: null })]);

    expect(run.state).toBe('waiting_reply');
    expect(run.timeoutAt).toBeNull();
  });

  it.each([
    ['2', '2', 'Financeiro'],
    [' juridico. ', '3', 'Jurídico'],
    ['ATENDIMENTO', '1', 'Atendimento'],
  ])('matches the reply %j to option %s by key or label, ignoring case and accents', async (body, key, label) => {
    const run = await runFlow([node('menu', 'ask_choice', MENU)]);

    await reply(body);

    const after = await reloadRun(run.id);
    expect(outcome(after, 'menu')).toBe(`opt:${key}`);
    expect(after.state).toBe('finished');
    expect(after.vars.menu).toEqual({ raw: body, value: key, label });
  });

  it('follows the edge of the chosen option', async () => {
    const run = await runFlow(
      [node('menu', 'ask_choice', MENU), node('financeiro', 'note', { text: 'Foi para o financeiro' })],
      [edge('menu', 'opt:2', 'financeiro')],
    );

    await reply('2');

    expect(outcome(await reloadRun(run.id), 'financeiro')).toBe('next');
    expect((await eventsOf(ctx, chatId)).some((e) => e.kind === 'bot_note' && e.data.text === 'Foi para o financeiro')).toBe(true);
  });

  it('sends the invalid text and the menu again, then takes invalid when retries run out', async () => {
    const run = await runFlow([node('menu', 'ask_choice', { ...MENU, invalidText: 'Não entendi, {{contato.primeiro_nome}}.' })]);

    await reply('quero falar com alguém');
    let after = await reloadRun(run.id);
    expect(after).toMatchObject({ state: 'waiting_reply', retries: 1 });
    expect(after.timeoutAt?.getTime()).toBe(run.timeoutAt?.getTime());
    expect(texts()).toEqual([MENU_TEXT, 'Não entendi, Maria.', MENU_TEXT]);

    await reply('9');
    after = await reloadRun(run.id);
    expect(outcome(after, 'menu')).toBe('invalid');
    expect(after.state).toBe('finished');
    expect(texts()).toHaveLength(3);
    expect(after.vars.menu).toBeUndefined();
  });

  it('uses "Opção inválida." when no invalid text is set, and goes straight to invalid with 0 retries', async () => {
    const run = await runFlow([node('menu', 'ask_choice', MENU)]);
    await reply('x');
    expect(texts()).toEqual([MENU_TEXT, 'Opção inválida.', MENU_TEXT]);

    const otherChat = await insertChat(ctx, { channelId: seed.channelId, sectorId: seed.defaultSector });
    const strict = await runFlow([node('menu', 'ask_choice', { ...MENU, invalidRetries: 0 })], [], otherChat);
    await reply('x', {}, otherChat);
    expect(outcome(await reloadRun(strict.id), 'menu')).toBe('invalid');
    expect(texts()).toHaveLength(4); // only the second chat's menu was added
    expect((await reloadRun(run.id)).state).toBe('waiting_reply');
  });

  it('takes timeout once the deadline passes', async () => {
    const run = await runFlow([node('menu', 'ask_choice', MENU)]);
    const start = ctx.clock.now().getTime();

    expect(await resumeOnTimer(ctx, run.id, new Date(start + 23 * HOUR))).toBeNull();
    await resumeOnTimer(ctx, run.id, new Date(start + 25 * HOUR));

    const after = await reloadRun(run.id);
    expect(outcome(after, 'menu')).toBe('timeout');
    expect(after.state).toBe('finished');
  });

  it('follows error when the menu cannot be sent', async () => {
    ctx.wa.failNext();

    const run = await runFlow(
      [node('menu', 'ask_choice', MENU), node('falhou', 'note', { text: 'menu falhou' })],
      [edge('menu', 'error', 'falhou')],
    );

    expect(outcome(run, 'menu')).toBe('error');
    expect(run.state).toBe('finished');
  });
});

describe('ask_input', () => {
  it('treats a sticker reply to ask_choice as invalid and an audio reply to ask_input(any) as valid', async () => {
    const choice = await runFlow([node('menu', 'ask_choice', { ...MENU, invalidRetries: 0 })]);
    await reply(null, { kind: 'sticker', mediaMime: 'image/webp' });
    expect(outcome(await reloadRun(choice.id), 'menu')).toBe('invalid');

    const otherChat = await insertChat(ctx, { channelId: seed.channelId, sectorId: seed.defaultSector });
    const input = await runFlow([node('pergunta', 'ask_input', askInput({ text: 'Mande sua dúvida' }))], [], otherChat);
    await reply(null, { kind: 'audio', mediaMime: 'audio/ogg' }, otherChat);
    const after = await reloadRun(input.id);
    expect(outcome(after, 'pergunta')).toBe('next');
    expect(after.vars.pergunta).toEqual({ raw: '', value: 'audio' });
  });

  it('validates a CPF, retries without repeating the question, saves the formatted value and keeps the raw text', async () => {
    const [field] = await ctx.db.insert(customFields).values({ name: 'CPF', kind: 'cpf' }).returning();
    const run = await runFlow([
      node('cpf', 'ask_input', askInput({
        text: 'Digite seu CPF:', validator: 'cpf', invalidText: 'CPF inválido, confira e digite de novo.',
        invalidRetries: 2, timeoutHours: 24, saveToField: field!.id,
      })),
    ]);
    expect(texts()).toEqual(['Digite seu CPF:']);

    await reply('123.456.789-00');
    expect(await reloadRun(run.id)).toMatchObject({ state: 'waiting_reply', retries: 1 });
    expect(texts()).toEqual(['Digite seu CPF:', 'CPF inválido, confira e digite de novo.']);

    await reply('52998224725');
    const after = await reloadRun(run.id);
    expect(outcome(after, 'cpf')).toBe('next');
    expect(after.vars.cpf).toEqual({ raw: '52998224725', value: '529.982.247-25' });
    const [saved] = await ctx.db
      .select()
      .from(contactFieldValues)
      .where(and(eq(contactFieldValues.contactId, contactId), eq(contactFieldValues.fieldId, field!.id)));
    expect(saved?.value).toBe('529.982.247-25');
  });

  it('takes invalid after the retries run out, sending the default invalid text once', async () => {
    const run = await runFlow([node('email', 'ask_input', askInput({ text: 'Qual seu e-mail?', validator: 'email' }))]);

    await reply('não tenho');
    await reply('nenhum');

    const after = await reloadRun(run.id);
    expect(outcome(after, 'email')).toBe('invalid');
    expect(texts()).toEqual(['Qual seu e-mail?', 'Resposta inválida. Tente de novo.']);
    expect(after.vars.email).toBeUndefined();
  });

  const cases: Array<[InputValidator, Record<string, unknown>, string, string, string]> = [
    ['email', {}, 'maria@', ' Maria@Exemplo.COM ', 'maria@exemplo.com'],
    ['phone', {}, '123', '(65) 99999-0001', '5565999990001'],
    ['cnpj', {}, '11.222.333/0001-00', '11222333000181', '11.222.333/0001-81'],
    ['regex', { regex: '^\\d{5}$' }, 'abcde', '78000', '78000'],
  ];
  it.each(cases)('validator %s rejects the bad answer and normalizes the good one', async (validator, extra, bad, good, value) => {
    const run = await runFlow([node('dado', 'ask_input', askInput({ validator, ...extra }))]);

    await reply(bad);
    expect(await reloadRun(run.id)).toMatchObject({ state: 'waiting_reply', retries: 1 });

    await reply(good);
    const after = await reloadRun(run.id);
    expect(outcome(after, 'dado')).toBe('next');
    expect(after.vars.dado?.value).toBe(value);
  });

  it('validator media accepts only the listed types', async () => {
    const run = await runFlow([node('doc', 'ask_input', askInput({ text: 'Envie o contrato em PDF', validator: 'media', mediaTypes: ['pdf'] }))]);

    await reply(null, { kind: 'image', mediaMime: 'image/jpeg' });
    expect(await reloadRun(run.id)).toMatchObject({ state: 'waiting_reply', retries: 1 });

    await reply(null, { kind: 'document', mediaMime: 'application/pdf', mediaName: 'contrato.pdf' });
    expect(outcome(await reloadRun(run.id), 'doc')).toBe('next');
  });

  it('useLastMessage takes a valid last inbound message without asking and saves to a native field', async () => {
    await storeInbound('maria@exemplo.com');

    const run = await runFlow([
      node('email', 'ask_input', askInput({ text: 'Qual seu e-mail?', validator: 'email', useLastMessage: true, saveToField: 'native:email' })),
    ]);

    expect(ctx.wa.sent).toHaveLength(0);
    expect(run.state).toBe('finished');
    expect(outcome(run, 'email')).toBe('next');
    expect(run.vars.email).toEqual({ raw: 'maria@exemplo.com', value: 'maria@exemplo.com' });
    const [contact] = await ctx.db.select().from(contacts).where(eq(contacts.id, contactId));
    expect(contact!.email).toBe('maria@exemplo.com');
  });

  it('useLastMessage asks when the last inbound message does not validate', async () => {
    await storeInbound('Bom dia');

    const run = await runFlow([node('email', 'ask_input', askInput({ text: 'Qual seu e-mail?', validator: 'email', useLastMessage: true }))]);

    expect(texts()).toEqual(['Qual seu e-mail?']);
    expect(run.state).toBe('waiting_reply');
  });

  it('saves native:city inside the address and keeps the other keys', async () => {
    await ctx.db.update(contacts).set({ address: { state: 'MT', zipCode: '78000-000' } }).where(eq(contacts.id, contactId));
    await runFlow([node('cidade', 'ask_input', askInput({ text: 'Sua cidade?', saveToField: 'native:city' }))]);

    await reply('Cuiabá');

    const [contact] = await ctx.db.select().from(contacts).where(eq(contacts.id, contactId));
    expect(contact!.address).toEqual({ state: 'MT', zipCode: '78000-000', city: 'Cuiabá' });
  });

  it('takes timeout when the contact does not answer in time', async () => {
    const run = await runFlow([node('dado', 'ask_input', askInput({ timeoutHours: 2 }))]);
    expect(run.timeoutAt?.getTime()).toBe(ctx.clock.now().getTime() + 2 * HOUR);

    await resumeOnTimer(ctx, run.id, new Date(ctx.clock.now().getTime() + 3 * HOUR));

    const after = await reloadRun(run.id);
    expect(outcome(after, 'dado')).toBe('timeout');
    expect(after.state).toBe('finished');
  });
});
```

- [ ] **Step 14: Run the tests and confirm they fail**

Run: `npm test -w server -- test/bots/actions-1.test.ts`
Expected: FAIL. The `ask_choice` and `ask_input` tests fail on their first assertion: nothing is sent, and the runs end `failed` with `'Bloco não suportado'`. The earlier describes still pass.

- [ ] **Step 15: Add `ask_choice` and `ask_input` to `server/src/bots/blocks/actions.ts`**

1. Replace the `@talk/shared` type import with:
```ts
import type {
  AskChoiceConfig, AskInputConfig, BotAttachment, BotNode, EditTagsConfig, NoteConfig, SendMessageConfig, SetContactFieldConfig,
} from '@talk/shared';
```
2. Below the `import { HttpError } …` line, add:
```ts
import { normalize } from '../../triage/triage.js';
```
3. Replace the registry import with:
```ts
import { BlockError } from '../block-error.js';
import type { BlockDefinition, BlockRegistry, BlockResult, BotCtx } from '../registry.js';
import { validateAnswer } from '../validators.js';
```
4. Insert this block right before `export const actionBlocks`:

```ts
const HOUR_MS = 3_600_000;
const varName = (node: BotNode) => node.name ?? node.id;

function timeoutFrom(ctx: BotCtx, hours: number | null | undefined): Date | null {
  return hours && hours > 0 ? new Date(ctx.now.getTime() + hours * HOUR_MS) : null;
}

function menuText(cfg: AskChoiceConfig): string {
  return `${cfg.text ?? ''}\n\n${(cfg.options ?? []).map((o) => `${o.key}: ${o.label}`).join('\n')}`;
}

/** Invalid answer: with retries left, send the invalid text (and `repeat`, if any) and wait again on the same deadline. */
async function retryOrInvalid(
  ctx: BotCtx,
  run: BotRunRow,
  cfg: { invalidText?: string; invalidRetries?: number; timeoutHours?: number | null },
  fallback: string,
  repeat: string | null,
): Promise<BlockResult> {
  if (run.retries >= (cfg.invalidRetries ?? 1)) return { next: 'invalid' };
  run.retries += 1;
  await send(ctx, run, { text: await ctx.render(cfg.invalidText?.trim() || fallback) });
  if (repeat !== null) await send(ctx, run, { text: repeat });
  return { wait: 'reply', timeoutAt: run.timeoutAt ?? timeoutFrom(ctx, cfg.timeoutHours) };
}

const askChoice: BlockDefinition = {
  type: 'ask_choice',
  async run(ctx, run, node) {
    const cfg = node.config as unknown as AskChoiceConfig;
    await send(ctx, run, { text: await ctx.render(menuText(cfg)) });
    return { wait: 'reply', timeoutAt: timeoutFrom(ctx, cfg.timeoutHours) };
  },
  async resume(ctx, run, node, ev) {
    const cfg = node.config as unknown as AskChoiceConfig;
    if (ev.kind === 'timeout') return { next: 'timeout' };
    if (ev.kind !== 'reply') throw new BlockError('Evento inesperado no bloco "Pedir para escolher"');
    // Same matching as the triage: key or label, no accents, no case, surrounding punctuation dropped. Media (body null) never matches.
    const answer = ev.reply.body === null ? '' : normalize(ev.reply.body);
    const option = answer
      ? (cfg.options ?? []).find((o) => normalize(o.key) === answer || normalize(o.label) === answer)
      : undefined;
    if (option) {
      run.vars[varName(node)] = { raw: ev.reply.body ?? '', value: option.key, label: option.label };
      return { next: `opt:${option.key}` };
    }
    return retryOrInvalid(ctx, run, cfg, 'Opção inválida.', await ctx.render(menuText(cfg)));
  },
};

async function acceptAnswer(ctx: BotCtx, run: BotRunRow, node: BotNode, cfg: AskInputConfig, answer: { raw: string; value: string }): Promise<BlockResult> {
  run.vars[varName(node)] = { raw: answer.raw, value: answer.value };
  if (cfg.saveToField) await saveContactField(ctx, cfg.saveToField, answer.value);
  return { next: 'next' };
}

const askInput: BlockDefinition = {
  type: 'ask_input',
  async run(ctx, run, node) {
    const cfg = node.config as unknown as AskInputConfig;
    if (cfg.useLastMessage) {
      const last = await ctx.lastInbound();
      const result = last ? validateAnswer(cfg, last) : null;
      if (result && result.ok) return acceptAnswer(ctx, run, node, cfg, result);
    }
    await send(ctx, run, { text: await ctx.render(cfg.text ?? '') });
    return { wait: 'reply', timeoutAt: timeoutFrom(ctx, cfg.timeoutHours) };
  },
  async resume(ctx, run, node, ev) {
    const cfg = node.config as unknown as AskInputConfig;
    if (ev.kind === 'timeout') return { next: 'timeout' };
    if (ev.kind !== 'reply') throw new BlockError('Evento inesperado no bloco "Pedir informação"');
    const result = validateAnswer(cfg, ev.reply);
    if (result.ok) return acceptAnswer(ctx, run, node, cfg, result);
    return retryOrInvalid(ctx, run, cfg, 'Resposta inválida. Tente de novo.', null);
  },
};
```

5. Replace the `actionBlocks` export with:

```ts
export const actionBlocks: BlockRegistry = {
  send_message: sendMessage,
  note,
  ask_choice: askChoice,
  ask_input: askInput,
  set_contact_field: setContactField,
  edit_tags: editTags,
};
```

- [ ] **Step 16: Run the tests and confirm they pass**

Run: `npm test -w server -- test/bots/actions-1.test.ts`
Expected: PASS. Every describe passes: `sendSystemMessage`, `send_message`, `note`, `set_contact_field`, `edit_tags`, `ask_choice` and `ask_input`. That includes `treats a sticker reply to ask_choice as invalid and an audio reply to ask_input(any) as valid`.

- [ ] **Step 17: Run the typecheck and the whole server suite**

Run: `npm run typecheck -w server`
Expected: exits 0 with no errors.

Run: `npm test -w server`
Expected: PASS for the whole suite, including `test/triage/triage.test.ts`, `test/messages/send.test.ts` and the earlier `test/bots/*` files.

- [ ] **Step 18: Commit**

```bash
git add server/src/bots/blocks/actions.ts server/test/bots/actions-1.test.ts
git commit -m "feat(server): blocos de chatbot pedir para escolher e pedir informação com validação, tentativas e prazo

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


---

### Task 8: Action blocks II and start/finish blocks

Adds the remaining ten block types: `transfer_sector`, `transfer_agent`, `privacy`, `notify_agent`, `call_flow`, `block_contact`, `close_chat`, `start_channel`, `start_manual` and `sticky_note`. It also adds the bot versions of the chat actions in `inbox/chats.ts` (no `canSee`, `authorId = null`, `botName` in every event) and `publishNotification` on both hubs. After this task, `defaultRegistry` has a definition for every type in `BLOCK_TYPES`.

**Files:**
- Modify: `server/src/realtime/hub.ts` (`Hub.publishNotification`, both hubs)
- Modify: `server/src/inbox/chats.ts` (export `getClosingMessage`; add `transferChatAsBot`, `setChatPrivacyAsBot`, `closeChatAsBot`)
- Create: `server/src/bots/blocks/start.ts` (`startBlocks`: `start_channel`, `start_manual`, `sticky_note`)
- Create: `server/src/bots/blocks/finish.ts` (`finishBlocks`: `close_chat`)
- Create: `server/src/bots/blocks/actions-2.ts` (`actionBlocks2`: `transfer_sector`, `transfer_agent`, `privacy`, `notify_agent`, `call_flow`, `block_contact`)
- Modify: `server/src/bots/registry.ts` (`defaultRegistry` spreads `startBlocks`, `actionBlocks2` and `finishBlocks`)
- Test: `server/test/realtime/hub.test.ts` (append a `publishNotification` describe)
- Test: `server/test/bots/actions-2.test.ts` (create)

> **Why `actions-2.ts` and not an append to `actions.ts`:** Task 7 owns `actions.ts` and its import list. If Task 8 appended code that imports `BlockError`, `chats`, `and` or `eq` a second time, the file would fail to compile with a duplicate identifier. A separate module with its own `actionBlocks2` registry avoids that. The registry then spreads both.

**Interfaces:**
- Consumes:
  - Task 1 (`@talk/shared`): `BLOCK_TYPES`, `BlockType`, `BotNode`, `BotEdge`, `BotRunState`, `NotificationDto`, `WsEvent` (with `{ type: 'notification'; notification }`), `TransferSectorConfig`, `TransferAgentConfig`, `PrivacyConfig`, `NotifyAgentConfig`, `CallFlowConfig`, `CloseChatConfig`. Also `ChatEventKind`, which includes `'bot_transferred'` and `'bot_note'`.
  - Task 2 (`server/src/bots/repo.ts`): `type BotRunRow`, `createBot(db, { name, graph, valid, publish, createdBy, manualStart? })`. From the schema: `bots`, `botRuns`, `messages.botRunId`.
  - Task 5 (`server/src/bots/registry.ts`): `BlockError`, `type BotActor`, `type BlockRegistry`, `type BlockResult`, `type BotCtx` (`app`, `now`, `chat` (assignable), `bot`, `actor`, `render`, `startChild`, `stopOtherRuns`), `type InboundReply`, `defaultRegistry`.
  - Task 5 (`server/src/bots/engine.ts`): `startRun(ctx, { botId, chatId, entry, startedBy })`, `resumeOnReply(ctx, chatId, reply)`. From `makeTestCtx()`: `clock: FakeClock`.
  - Task 6 (`server/src/bots/blocks/conditions.ts`): `conditionBlocks`. Task 7 (`server/src/bots/blocks/actions.ts`): `actionBlocks`, which includes `note` (writes `bot_note {text}`) and `ask_choice`. Task 7 (`server/src/messages/send.ts`): `sendSystemMessage(ctx, chat, { text?, attachment?, botRunId? }) → { ok, messageId, echoDropped }`.
  - Existing code: `setContactBlocked(ctx, id, true)` (`contacts/service.ts`); the private `updateChat`, `sectorExists`, `activeUserExists` and `sameOwner` (`inbox/chats.ts`).
- Produces:
  - `server/src/realtime/hub.ts`: `Hub.publishNotification(chatId: string, userIds: string[], notification: NotificationDto): Promise<void>`. The real hub sends `{ type: 'notification', notification }` once per listed user who `canSee` the chat. The recording hub pushes `{ type: 'notification', chatId, userId }` per listed user.
  - `server/src/inbox/chats.ts`:
    - `export async function getClosingMessage(db: Db | Tx): Promise<string>`
    - `export async function transferChatAsBot(ctx: AppCtx, actor: BotActor, chatId: string, to: { sectorId?: string; ownerId?: string | null }): Promise<ChatRow>`
    - `export async function setChatPrivacyAsBot(ctx: AppCtx, actor: BotActor, chatId: string, isPrivate: boolean): Promise<ChatRow>`
    - `export async function closeChatAsBot(ctx: AppCtx, actor: BotActor, chatId: string, opts: { closingText: string | null }): Promise<ChatRow>`
  - The `BlockError` messages these functions throw:
    - `'Conversa não encontrada'`
    - `'A conversa está finalizada'`
    - `'Setor não encontrado'`
    - `'Atendente não encontrado ou inativo'`
    - `'A conversa não tem atendente'`
    - `'Mensagem de encerramento não enviada'`
    - `'A conversa foi alterada durante o chatbot'` (the 409 STALE)
  - `server/src/bots/blocks/start.ts`: `export const startBlocks: BlockRegistry`
  - `server/src/bots/blocks/finish.ts`: `export const finishBlocks: BlockRegistry`
  - `server/src/bots/blocks/actions-2.ts`: `export const actionBlocks2: BlockRegistry`
  - `server/src/bots/registry.ts`: `defaultRegistry = { ...startBlocks, ...conditionBlocks, ...actionBlocks, ...actionBlocks2, ...finishBlocks }`, which covers all 33 `BLOCK_TYPES`

---

#### Cycle 1: `publishNotification` on both hubs

- [ ] **Step 1: Write the failing test**

Append to `server/test/realtime/hub.test.ts`. Add this import line below the existing `import type { WsEvent } from '@talk/shared';`:

```ts
import type { NotificationDto } from '@talk/shared';
```

Then append at the end of the file:

```ts
describe('publishNotification', () => {
  it('real hub sends the notification once, only to listed users who can see the chat', async () => {
    const a = fakeSocket(); const b = fakeSocket(); const adm = fakeSocket();
    hub.register(s.agentA, a); hub.register(s.agentB, b); hub.register(s.admin, adm);
    await enableSeeAll(ctx, s.admin);
    const { chat } = await insertChat(ctx, s.channelId, { sectorId: s.sectorA });
    const notification: NotificationDto = {
      id: randomUUID(), chatId: chat.id, title: 'Nova conversa', text: 'Nova conversa de Maria Souza',
      botName: 'Fluxo do escritório', createdAt: '2026-10-14T13:00:00.000Z',
    };

    await hub.publishNotification(chat.id, [s.agentA.id, s.agentB.id, s.agentA.id], notification);

    expect(a.events).toEqual([{ type: 'notification', notification }]); // listed twice, delivered once
    expect(b.events).toEqual([]);   // listed, but a sector B agent cannot see a sector A chat
    expect(adm.events).toEqual([]); // sees every chat, but was not listed
  });

  it('recording hub records one event per listed user', async () => {
    const rec = createRecordingHub();
    const n: NotificationDto = { id: 'n1', chatId: 'c1', title: 't', text: 'x', botName: 'B', createdAt: '2026-10-14T13:00:00.000Z' };
    await rec.publishNotification('c1', ['u1', 'u2'], n);
    expect(rec.events).toEqual([
      { type: 'notification', chatId: 'c1', userId: 'u1' },
      { type: 'notification', chatId: 'c1', userId: 'u2' },
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w server -- test/realtime/hub.test.ts`
Expected: the two new tests FAIL with `TypeError: hub.publishNotification is not a function` (and `rec.publishNotification is not a function`). `npm run typecheck -w server` also reports `Property 'publishNotification' does not exist on type 'Hub'`.

- [ ] **Step 3: Implement it in `server/src/realtime/hub.ts`**

Replace the import of `WsEvent`:

```ts
import type { NotificationDto, WsEvent } from '@talk/shared';
```

Add the method to the `Hub` interface, after `publishChannel`:

```ts
  publishChannel(channelId: string): Promise<void>;
  /** Chatbot "Notificar atendente": WS only, to the listed users who can see the chat. */
  publishNotification(chatId: string, userIds: string[], notification: NotificationDto): Promise<void>;
}
```

In `createHub`, add this method after `publishChannel` (inside the returned object):

```ts
    // ponytail: WS-only; offline agents miss it — add a notifications table when 2b's "notificar só se online" lands.
    async publishNotification(chatId, userIds, notification) {
      if (byUser.size === 0) return;
      const db = getDb();
      const [chat] = await db.select().from(chats).where(eq(chats.id, chatId));
      if (!chat) return;
      const event: WsEvent = { type: 'notification', notification };
      for (const userId of new Set(userIds)) {
        const sockets = byUser.get(userId);
        if (!sockets) continue;
        const user = await loadAuthUser(db, userId);
        if (user && canSee(user, chat)) for (const socket of [...sockets]) send(socket, event);
      }
    },
```

In `createRecordingHub`, add after the `publishChannel` line:

```ts
    publishNotification: async (chatId, userIds) => {
      for (const userId of userIds) events.push({ type: 'notification', chatId, userId });
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w server -- test/realtime/hub.test.ts`
Expected: PASS (every test in the file, the existing ones included).

Run: `npm run typecheck -w server`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add server/src/realtime/hub.ts server/test/realtime/hub.test.ts
git commit -m "feat(server): notificação do chatbot pelo hub (publishNotification)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

#### Cycle 2: chat actions as the bot, the start/utility blocks and `close_chat`

- [ ] **Step 1: Write the failing test**

Create `server/test/bots/actions-2.test.ts`. The header and helpers below serve the whole task; Cycle 3 appends more `describe` blocks to this file.

```ts
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BLOCK_TYPES, type BlockType, type BotEdge, type BotNode } from '@talk/shared';
import { botRuns, bots, channels, chats, contacts, messages, settings, users } from '../../src/db/schema.js';
import { createBot, type BotRunRow } from '../../src/bots/repo.js';
import { resumeOnReply, startRun } from '../../src/bots/engine.js';
import { defaultRegistry, type BotCtx, type InboundReply } from '../../src/bots/registry.js';
import { startBlocks } from '../../src/bots/blocks/start.js';
import { makeTestCtx, seedBasics } from '../helpers.js';
import { eventsOf, insertChat, newContact } from '../inbox/fixtures.js';

let ctx: Awaited<ReturnType<typeof makeTestCtx>>;
let s: Awaited<ReturnType<typeof seedBasics>>;
let botSeq = 0;

beforeEach(async () => {
  ctx = await makeTestCtx();
  s = await seedBasics(ctx);
});

// Node id === node name, so step assertions work whichever one the engine logs.
const node = (id: string, type: BlockType, config: Record<string, unknown> = {}): BotNode => ({
  id, type, name: id, position: { x: 0, y: 0 }, config,
});
const edge = (source: string, sourceHandle: string, target: string): BotEdge => ({
  id: `${source}:${sourceHandle}`, source, sourceHandle, target,
});
const ASK = { text: 'Confirma?', options: [{ key: '1', label: 'Sim' }], invalidRetries: 0, timeoutHours: null };

/** start_manual 'inicio' → nodes[0]; published and active. Returns the bot id. */
async function makeBot(nodes: BotNode[], edges: BotEdge[] = []): Promise<string> {
  const graph = {
    nodes: [node('inicio', 'start_manual'), ...nodes],
    edges: [...(nodes[0] ? [edge('inicio', 'next', nodes[0].id)] : []), ...edges],
  };
  const bot = await createBot(ctx.db, { name: `Bot ${++botSeq}`, graph, valid: true, publish: true, createdBy: null, manualStart: true });
  await ctx.db.update(bots).set({ status: 'active' }).where(eq(bots.id, bot.id));
  return bot.id;
}

async function openChat(f: { ownerId?: string | null; sectorId?: string; contactId?: string; channelId?: string; private?: boolean } = {}) {
  const contactId = f.contactId ?? (await newContact(ctx, { name: 'Maria Souza' }));
  const chatId = await insertChat(ctx, {
    channelId: f.channelId ?? s.channelId, sectorId: f.sectorId ?? s.sectorA, contactId,
    ownerId: f.ownerId ?? null, private: f.private ?? false,
  });
  return { chatId, contactId };
}

async function runRow(id: string): Promise<BotRunRow> {
  const [row] = await ctx.db.select().from(botRuns).where(eq(botRuns.id, id));
  return row;
}

async function runBot(botId: string, chatId: string): Promise<BotRunRow> {
  const started = await startRun(ctx, { botId, chatId, entry: 'manual', startedBy: null });
  return runRow(started.id);
}

async function chatRow(id: string) {
  const [row] = await ctx.db.select().from(chats).where(eq(chats.id, id));
  return row;
}

const notes = async (chatId: string) =>
  (await eventsOf(ctx, chatId)).filter((e) => e.kind === 'bot_note').map((e) => e.data.text);

const sentTexts = () =>
  ctx.wa.sent.filter((m) => m.method === 'sendText').map((m) => (m.payload as { text: string }).text);

/** Stores an inbound text and returns it as the engine's InboundReply. */
async function reply(chatId: string, body: string): Promise<InboundReply> {
  const [m] = await ctx.db.insert(messages).values({
    chatId, channelId: s.channelId, direction: 'in', kind: 'text', body, status: 'sent', sentAt: new Date(),
    // A reply counts only at/after bot_runs.waiting_since (DB clock_timestamp, microseconds); +1 s keeps a
    // same-millisecond JS Date from landing just before it.
    createdAt: new Date(Date.now() + 1000),
  }).returning();
  return { messageId: m.id, kind: 'text', body, mediaMime: null, mediaName: null, createdAt: m.createdAt };
}

describe('start and utility blocks', () => {
  it('start_channel and start_manual continue on next; sticky_note never runs', async () => {
    const fake = {} as BotCtx;
    const run = {} as BotRunRow;
    expect(await startBlocks.start_channel!.run(fake, run, node('a', 'start_channel'))).toEqual({ next: 'next' });
    expect(await startBlocks.start_manual!.run(fake, run, node('b', 'start_manual'))).toEqual({ next: 'next' });
    expect(await startBlocks.sticky_note!.run(fake, run, node('c', 'sticky_note', { text: 'lembrete', color: 'yellow' })))
      .toEqual({ end: 'failed', error: 'Anotação não executa' });
  });

  it('a manual start runs through start_manual into the next block', async () => {
    const { chatId } = await openChat();
    const botId = await makeBot([node('ola', 'note', { text: 'começou' })]);
    const run = await runBot(botId, chatId);
    expect(run.state).toBe('finished');
    expect(await notes(chatId)).toEqual(['começou']);
  });
});

describe('close_chat', () => {
  it('sends the settings closing message as the bot, closes the chat and stops the other bots', async () => {
    await ctx.db.insert(settings).values({ key: 'closing_message', value: 'Obrigado pelo contato!' });
    const { chatId } = await openChat({ ownerId: s.agentA.id });
    const waiting = await runBot(await makeBot([node('pergunta', 'ask_choice', ASK)]), chatId);
    expect(waiting.state).toBe('waiting_reply');
    const closer = await makeBot([node('fim', 'close_chat', { sendClosingMessage: true })]);
    ctx.hub.events.length = 0;

    const run = await runBot(closer, chatId);

    expect(run.state).toBe('finished');
    expect(await chatRow(chatId)).toMatchObject({ state: 'closed', waiting: false, triagePending: false });
    expect(sentTexts().at(-1)).toBe('Obrigado pelo contato!');
    const [msg] = await ctx.db.select().from(messages).where(and(eq(messages.chatId, chatId), eq(messages.botRunId, run.id)));
    expect(msg).toMatchObject({ body: 'Obrigado pelo contato!', authorId: null, direction: 'out' });
    const closed = (await eventsOf(ctx, chatId)).find((e) => e.kind === 'closed');
    expect(closed).toMatchObject({ authorId: null, data: { closingMessageSent: true, botId: closer, runId: run.id } });
    expect(closed?.data.botName).toMatch(/^Bot /);
    expect(ctx.hub.events).toContainEqual({ type: 'chat', chatId });
    expect((await runRow(waiting.id)).state).toBe('stopped');
    const stopped = (await eventsOf(ctx, chatId)).find((e) => e.kind === 'bot_stopped');
    expect(stopped?.data.reason).toBe('chat_closed');
  });

  it('renders its own closing text, and sends nothing when sendClosingMessage is off', async () => {
    await ctx.db.insert(settings).values({ key: 'closing_message', value: 'Texto das configurações' });
    const own = await makeBot([node('fim', 'close_chat', { sendClosingMessage: true, closingText: 'Até logo, {{contato.primeiro_nome}}!' })]);
    const silent = await makeBot([node('fim', 'close_chat', { sendClosingMessage: false })]);
    const a = await openChat();
    const b = await openChat();

    await runBot(own, a.chatId);
    await runBot(silent, b.chatId);

    expect(sentTexts()).toEqual(['Até logo, Maria!']);
    expect((await chatRow(b.chatId)).state).toBe('closed');
    const closedB = (await eventsOf(ctx, b.chatId)).find((e) => e.kind === 'closed');
    expect(closedB?.data.closingMessageSent).toBe(false);
  });

  it('keeps the chat open and fails the run when the closing message cannot be sent', async () => {
    await ctx.db.insert(settings).values({ key: 'closing_message', value: 'Obrigado!' });
    const { chatId } = await openChat();
    const botId = await makeBot([node('fim', 'close_chat', { sendClosingMessage: true })]);
    ctx.wa.failNext();

    const run = await runBot(botId, chatId);

    expect(run).toMatchObject({ state: 'failed', error: 'Mensagem de encerramento não enviada' });
    expect((await chatRow(chatId)).state).toBe('open');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w server -- test/bots/actions-2.test.ts`
Expected: FAIL. The suite cannot load `../../src/bots/blocks/start.js` (module not found), so no test runs.

- [ ] **Step 3: Add the bot chat actions to `server/src/inbox/chats.ts`**

Replace the `http-error` import line and add three imports below it:

```ts
import { HttpError, badRequest, conflict, forbidden, notFound } from '../lib/http-error.js';
import { BlockError } from '../bots/block-error.js';
import type { BotActor } from '../bots/registry.js';
import { sendSystemMessage } from '../messages/send.js';
```

Export the closing-message reader. Change `async function getClosingMessage(db: Db | Tx): Promise<string> {` to:

```ts
export async function getClosingMessage(db: Db | Tx): Promise<string> {
```

Append at the end of the file:

```ts
// ---------- the chatbot acting as the system (spec §5.6) ----------
// No canSee: the bot is not a user. Every event has authorId null and carries botId/botName/runId;
// updateChat publishes chat.updated after commit, so each viewer's sector barrier still applies.
// Failures throw BlockError so the run takes the block's `error` edge with a readable reason.

const actorData = (a: BotActor) => ({ botId: a.botId, botName: a.botName, runId: a.runId });

async function chatForBot(ctx: AppCtx, chatId: string, mustBeOpen: boolean): Promise<ChatRow> {
  const [chat] = await ctx.db.select().from(chats).where(eq(chats.id, chatId));
  if (!chat) throw new BlockError('Conversa não encontrada');
  if (mustBeOpen && chat.state !== 'open') throw new BlockError('A conversa está finalizada');
  return chat;
}

/** updateChat, with the 409 STALE (someone changed the chat mid-step) turned into a BlockError. */
async function updateChatAsBot(
  ctx: AppCtx,
  chatId: string,
  expected: SQL | undefined,
  set: Partial<typeof chats.$inferInsert>,
  event: { kind: ChatEventKind; data: Record<string, unknown> },
): Promise<ChatRow> {
  try {
    return await updateChat(ctx, chatId, expected, set, { ...event, authorId: null });
  } catch (e) {
    if (e instanceof HttpError && e.status === 409) throw new BlockError('A conversa foi alterada durante o chatbot');
    throw e;
  }
}

/** ownerId undefined = keep the owner; null clears it (and privacy, like a manual transfer). Always ends triage. */
export async function transferChatAsBot(
  ctx: AppCtx,
  actor: BotActor,
  chatId: string,
  to: { sectorId?: string; ownerId?: string | null },
): Promise<ChatRow> {
  const chat = await chatForBot(ctx, chatId, true);
  if (to.sectorId !== undefined && !(await sectorExists(ctx.db, to.sectorId))) throw new BlockError('Setor não encontrado');
  if (to.ownerId && !(await activeUserExists(ctx.db, to.ownerId))) throw new BlockError('Atendente não encontrado ou inativo');
  const sectorId = to.sectorId ?? chat.sectorId;
  const ownerId = to.ownerId === undefined ? chat.ownerId : to.ownerId;
  return updateChatAsBot(
    ctx,
    chatId,
    and(eq(chats.state, 'open'), eq(chats.sectorId, chat.sectorId), sameOwner(chat.ownerId)),
    ownerId === null ? { sectorId, ownerId, private: false, triagePending: false } : { sectorId, ownerId, triagePending: false },
    {
      kind: 'bot_transferred',
      data: { ...actorData(actor), fromSectorId: chat.sectorId, toSectorId: sectorId, fromOwnerId: chat.ownerId, toOwnerId: ownerId },
    },
  );
}

export async function setChatPrivacyAsBot(ctx: AppCtx, actor: BotActor, chatId: string, isPrivate: boolean): Promise<ChatRow> {
  const chat = await chatForBot(ctx, chatId, false);
  if (chat.private === isPrivate) return chat;
  if (isPrivate && chat.ownerId === null) throw new BlockError('A conversa não tem atendente');
  return updateChatAsBot(
    ctx,
    chatId,
    and(eq(chats.private, chat.private), sameOwner(chat.ownerId)),
    { private: isPrivate },
    { kind: 'privacy_changed', data: { private: isPrivate, ...actorData(actor) } },
  );
}

/** Sends closingText (when non-null) as the bot BEFORE the UPDATE; a failed send keeps the chat open, like closeChat. */
export async function closeChatAsBot(
  ctx: AppCtx,
  actor: BotActor,
  chatId: string,
  opts: { closingText: string | null },
): Promise<ChatRow> {
  const chat = await chatForBot(ctx, chatId, true);
  let closingMessageSent = false;
  if (opts.closingText) {
    const sent = await sendSystemMessage(ctx, chat, { text: opts.closingText, botRunId: actor.runId });
    if (!sent.ok) throw new BlockError('Mensagem de encerramento não enviada');
    closingMessageSent = true;
  }
  return updateChatAsBot(
    ctx,
    chatId,
    eq(chats.state, 'open'),
    { state: 'closed', closedAt: new Date(), waiting: false, triagePending: false },
    { kind: 'closed', data: { closingMessageSent, ...actorData(actor) } },
  );
}
```

chats.ts imports only `block-error.js` (value) and types from `registry.js`, so it never loads the registry. The registry spreads the block maps at module top level, and a value import here would hit a TDZ error when a test loads a block module first.

- [ ] **Step 4: Create `server/src/bots/blocks/start.ts`**

```ts
import type { BlockRegistry } from '../registry.js';

// Start blocks only hand over to `next`. Which channels and manual flags apply lives on the bot row (spec §4 Início).
export const startBlocks: BlockRegistry = {
  start_channel: { type: 'start_channel', run: async () => ({ next: 'next' }) },
  start_manual: { type: 'start_manual', run: async () => ({ next: 'next' }) },
  // Unreachable: validateGraph forbids edges to a sticky note. It is here so the registry covers every BlockType.
  sticky_note: { type: 'sticky_note', run: async () => ({ end: 'failed', error: 'Anotação não executa' }) },
};
```

- [ ] **Step 5: Create `server/src/bots/blocks/finish.ts`**

```ts
import type { CloseChatConfig } from '@talk/shared';
import { closeChatAsBot, getClosingMessage } from '../../inbox/chats.js';
import type { BlockRegistry } from '../registry.js';

export const finishBlocks: BlockRegistry = {
  close_chat: {
    type: 'close_chat',
    async run(ctx, _run, node) {
      const c = node.config as unknown as CloseChatConfig;
      let closingText: string | null = null;
      if (c.sendClosingMessage) {
        // The block's own text takes variables; the settings message goes out as is, like a manual close.
        const text = c.closingText?.trim() ? await ctx.render(c.closingText) : await getClosingMessage(ctx.app.db);
        closingText = text.trim() || null;
      }
      ctx.chat = await closeChatAsBot(ctx.app, ctx.actor, ctx.chat.id, { closingText });
      await ctx.stopOtherRuns(ctx.chat.id, 'chat_closed');
      return { end: 'finished' };
    },
  },
};
```

- [ ] **Step 6: Register the new families in `server/src/bots/registry.ts`**

Add these imports next to the existing `./blocks/*.js` imports:

```ts
import { finishBlocks } from './blocks/finish.js';
import { startBlocks } from './blocks/start.js';
```

Change the `defaultRegistry` initializer. After Task 7 it is `{ ...conditionBlocks, ...actionBlocks }`. It must now read:

```ts
export const defaultRegistry: BlockRegistry = { ...startBlocks, ...conditionBlocks, ...actionBlocks, ...finishBlocks };
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test -w server -- test/bots/actions-2.test.ts`
Expected: PASS (5 tests).

Run: `npm test -w server -- test/inbox test/bots/engine.test.ts test/bots/conditions.test.ts`
Expected: PASS. The existing chat actions are unchanged, and `conditions.test.ts` (which loads `blocks/conditions.js` → … → `inbox/chats.js` first) still loads without a TDZ error.

Run: `npm run typecheck -w server`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add server/src/inbox/chats.ts server/src/bots/blocks/start.ts server/src/bots/blocks/finish.ts server/src/bots/registry.ts server/test/bots/actions-2.test.ts
git commit -m "feat(server): blocos de início, anotação e finalizar conversa do chatbot

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

#### Cycle 3: transfer, privacy, notify, call_flow and block_contact

- [ ] **Step 1: Write the failing tests**

Append to `server/test/bots/actions-2.test.ts`:

```ts
describe('registry', () => {
  it('has a definition for every block type', () => {
    expect(BLOCK_TYPES.filter((t) => !defaultRegistry[t])).toEqual([]);
  });
});

describe('transfer_sector', () => {
  it('moves the chat as the bot, keeps the owner, records bot_transferred and publishes', async () => {
    const { chatId } = await openChat({ ownerId: s.agentA.id });
    const botId = await makeBot([node('mover', 'transfer_sector', { sectorId: s.sectorB, onlyIfAgentAllowed: false })]);
    ctx.hub.events.length = 0;

    const run = await runBot(botId, chatId);

    expect(run.state).toBe('finished');
    expect(await chatRow(chatId)).toMatchObject({ sectorId: s.sectorB, ownerId: s.agentA.id, triagePending: false });
    const ev = (await eventsOf(ctx, chatId)).find((e) => e.kind === 'bot_transferred');
    expect(ev).toMatchObject({
      authorId: null,
      data: { botId, runId: run.id, fromSectorId: s.sectorA, toSectorId: s.sectorB, fromOwnerId: s.agentA.id, toOwnerId: s.agentA.id },
    });
    expect(ev?.data.botName).toMatch(/^Bot /);
    expect(ctx.hub.events).toContainEqual({ type: 'chat', chatId });
  });

  it('onlyIfAgentAllowed clears an owner outside the destination and keeps one inside it', async () => {
    const botId = await makeBot([node('mover', 'transfer_sector', { sectorId: s.sectorB, onlyIfAgentAllowed: true })]);
    const outside = await openChat({ ownerId: s.agentA.id, private: true }); // Ana is only in sector A
    const inside = await openChat({ ownerId: s.agentB.id });                  // Bruno is in sector B

    await runBot(botId, outside.chatId);
    await runBot(botId, inside.chatId);

    expect(await chatRow(outside.chatId)).toMatchObject({ sectorId: s.sectorB, ownerId: null, private: false });
    expect(await chatRow(inside.chatId)).toMatchObject({ sectorId: s.sectorB, ownerId: s.agentB.id });
  });

  it('a missing sector takes the error edge, or fails the run without one', async () => {
    const missing = crypto.randomUUID();
    const withEdge = await makeBot(
      [node('mover', 'transfer_sector', { sectorId: missing, onlyIfAgentAllowed: false }), node('falha', 'note', { text: 'sem setor' })],
      [edge('mover', 'error', 'falha')],
    );
    const withoutEdge = await makeBot([node('mover', 'transfer_sector', { sectorId: missing, onlyIfAgentAllowed: false })]);
    const a = await openChat();
    const b = await openChat();

    const handled = await runBot(withEdge, a.chatId);
    const failed = await runBot(withoutEdge, b.chatId);

    expect(handled.state).toBe('finished');
    expect(handled.steps).toContainEqual(expect.objectContaining({ node: 'mover', outcome: 'error' }));
    expect(await notes(a.chatId)).toEqual(['sem setor']);
    expect(failed).toMatchObject({ state: 'failed', error: 'Setor não encontrado' });
    expect((await chatRow(b.chatId)).sectorId).toBe(s.sectorA);
  });
});

describe('transfer_agent', () => {
  it('specific takes the first active user in list order', async () => {
    await ctx.db.update(users).set({ active: false }).where(eq(users.id, s.agentA.id));
    const { chatId } = await openChat();
    const botId = await makeBot([node('agente', 'transfer_agent', { rule: 'specific', userIds: [s.agentA.id, s.agentB.id], sectorIds: [] })]);

    await runBot(botId, chatId);

    expect(await chatRow(chatId)).toMatchObject({ ownerId: s.agentB.id, sectorId: s.sectorA });
    const ev = (await eventsOf(ctx, chatId)).find((e) => e.kind === 'bot_transferred');
    expect(ev?.data).toMatchObject({ fromOwnerId: null, toOwnerId: s.agentB.id, toSectorId: s.sectorA });
  });

  it('least_busy picks the fewest open chats in the sectors, ties by name, and fails with no candidate', async () => {
    await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, ownerId: s.agentA.id });
    await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, ownerId: s.agentA.id });
    await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorB, ownerId: s.agentB.id });
    for (let i = 0; i < 3; i++) {
      await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorB, ownerId: s.agentB.id, state: 'closed' }); // closed: not counted
    }
    const botId = await makeBot([node('agente', 'transfer_agent', { rule: 'least_busy', userIds: [], sectorIds: [s.sectorA, s.sectorB] })]);
    const first = await openChat({ sectorId: s.defaultSector });
    const second = await openChat({ sectorId: s.defaultSector });

    await runBot(botId, first.chatId);  // Ana 2 open, Bruno 1 → Bruno (now 2)
    await runBot(botId, second.chatId); // 2 × 2 → "Ana Financeiro" before "Bruno Jurídico"

    expect((await chatRow(first.chatId)).ownerId).toBe(s.agentB.id);
    expect((await chatRow(second.chatId)).ownerId).toBe(s.agentA.id);

    const nobody = await makeBot([node('agente', 'transfer_agent', { rule: 'least_busy', userIds: [], sectorIds: [s.defaultSector] })]);
    const third = await openChat();
    expect(await runBot(nobody, third.chatId)).toMatchObject({ state: 'failed', error: 'Nenhum atendente disponível' });
  });
});

describe('privacy', () => {
  it('makes an owned chat private and public again, as the bot', async () => {
    const { chatId } = await openChat({ ownerId: s.agentA.id });
    const lock = await makeBot([node('privar', 'privacy', { mode: 'private' })]);
    const unlock = await makeBot([node('abrir', 'privacy', { mode: 'public' })]);

    await runBot(lock, chatId);
    expect((await chatRow(chatId)).private).toBe(true);
    const ev = (await eventsOf(ctx, chatId)).find((e) => e.kind === 'privacy_changed');
    expect(ev).toMatchObject({ authorId: null, data: { private: true, botId: lock } });

    await runBot(unlock, chatId);
    expect((await chatRow(chatId)).private).toBe(false);
  });

  it('fails when making a chat without owner private', async () => {
    const { chatId } = await openChat();
    const botId = await makeBot([node('privar', 'privacy', { mode: 'private' })]);
    expect(await runBot(botId, chatId)).toMatchObject({ state: 'failed', error: 'A conversa não tem atendente' });
    expect((await chatRow(chatId)).private).toBe(false);
  });
});

describe('notify_agent', () => {
  it('notifies the owner with rendered title and text', async () => {
    const { chatId } = await openChat({ ownerId: s.agentA.id });
    const botId = await makeBot([node('aviso', 'notify_agent', {
      title: 'Nova conversa', text: 'Nova conversa de {{contato.nome}}', target: 'owner', userIds: [],
    })]);
    const spy = vi.spyOn(ctx.hub, 'publishNotification');

    const run = await runBot(botId, chatId);

    expect(run.state).toBe('finished');
    expect(ctx.hub.events.filter((e) => e.type === 'notification')).toEqual([{ type: 'notification', chatId, userId: s.agentA.id }]);
    expect(spy).toHaveBeenCalledWith(chatId, [s.agentA.id], {
      id: expect.any(String), chatId, title: 'Nova conversa', text: 'Nova conversa de Maria Souza',
      botName: expect.stringMatching(/^Bot /), createdAt: ctx.clock.now().toISOString(),
    });
  });

  it('notifies the listed users, and fails for target owner on a chat without owner', async () => {
    const { chatId } = await openChat();
    const users2 = await makeBot([node('aviso', 'notify_agent', { title: 'Oi', text: 'x', target: 'users', userIds: [s.agentA.id, s.agentB.id] })]);
    const owner = await makeBot([node('aviso', 'notify_agent', { title: 'Oi', text: 'x', target: 'owner', userIds: [] })]);

    await runBot(users2, chatId);
    const failed = await runBot(owner, chatId);

    expect(ctx.hub.events.filter((e) => e.type === 'notification').map((e) => e.userId)).toEqual([s.agentA.id, s.agentB.id]);
    expect(failed).toMatchObject({ state: 'failed', error: 'A conversa não tem atendente para notificar' });
  });
});

describe('call_flow', () => {
  async function parentOf(childId: string, continueAfter: boolean) {
    return makeBot(
      [node('chamar', 'call_flow', { botId: childId, continueAfter }), node('depois', 'note', { text: 'no pai' })],
      [edge('chamar', 'next', 'depois')],
    );
  }
  const childRuns = (parentRunId: string) => ctx.db.select().from(botRuns).where(eq(botRuns.parentRunId, parentRunId));

  it('continueAfter=false starts the child and ends the caller', async () => {
    const child = await makeBot([node('filho', 'note', { text: 'no filho' })]);
    const { chatId } = await openChat();

    const run = await runBot(await parentOf(child, false), chatId);

    expect(run.state).toBe('finished');
    expect(await notes(chatId)).toEqual(['no filho']);
    expect(await childRuns(run.id)).toEqual([expect.objectContaining({ botId: child, depth: 1, state: 'finished' })]);
  });

  it('continueAfter=true follows next right away when the child finishes at once', async () => {
    const child = await makeBot([node('filho', 'note', { text: 'no filho' })]);
    const { chatId } = await openChat();

    const run = await runBot(await parentOf(child, true), chatId);

    expect(run.state).toBe('finished');
    expect(await notes(chatId)).toEqual(['no filho', 'no pai']);
  });

  it('continueAfter=true waits for a waiting child and resumes when it finishes', async () => {
    const child = await makeBot([node('pergunta', 'ask_choice', ASK)]);
    const { chatId } = await openChat();

    const parent = await runBot(await parentOf(child, true), chatId);
    expect(parent.state).toBe('waiting_flow');
    const [kid] = await childRuns(parent.id);
    expect(kid).toMatchObject({ state: 'waiting_reply', depth: 1 });

    expect(await resumeOnReply(ctx, chatId, await reply(chatId, '1'))).toBe(1); // the parent in waiting_flow is skipped

    expect((await runRow(kid.id)).state).toBe('finished');
    expect((await runRow(parent.id)).state).toBe('finished');
    expect(await notes(chatId)).toEqual(['no pai']);
  });

  it('fails with the start error when the called bot is paused', async () => {
    const child = await makeBot([node('filho', 'note', { text: 'no filho' })]);
    await ctx.db.update(bots).set({ status: 'paused' }).where(eq(bots.id, child));
    const { chatId } = await openChat();

    expect(await runBot(await parentOf(child, true), chatId)).toMatchObject({ state: 'failed', error: 'Este chatbot não está ativo' });
  });

  it('stops at 5 chained levels', async () => {
    let target = await makeBot([node('folha', 'note', { text: 'nunca' })]);
    for (let i = 0; i < 5; i++) target = await makeBot([node('chamar', 'call_flow', { botId: target, continueAfter: true })]);
    const { chatId } = await openChat();

    const root = await runBot(target, chatId);

    const runs = await ctx.db.select().from(botRuns).where(eq(botRuns.chatId, chatId)).orderBy(botRuns.depth);
    expect(runs.map((r) => [r.depth, r.state])).toEqual([[0, 'failed'], [1, 'failed'], [2, 'failed'], [3, 'failed'], [4, 'failed']]);
    expect(runs[4].error).toBe('Limite de 5 fluxos encadeados');
    expect(root.error).toBe('O fluxo acionado não terminou');
    expect(await notes(chatId)).toEqual([]);
  });
});

describe('block_contact', () => {
  it('blocks the contact, closes all of their open chats without a message and stops their other bots', async () => {
    const [second] = await ctx.db.insert(channels).values({ name: 'Segundo número', evolutionInstance: 'talk-test-2', status: 'connected' }).returning();
    const { chatId, contactId } = await openChat();
    const other = await openChat({ contactId, channelId: second.id });
    const waiting = await runBot(await makeBot([node('pergunta', 'ask_choice', ASK)]), other.chatId);
    expect(waiting.state).toBe('waiting_reply');
    const blocker = await makeBot([node('bloquear', 'block_contact')]);

    const run = await runBot(blocker, chatId);

    expect(run.state).toBe('finished');
    const [contact] = await ctx.db.select().from(contacts).where(eq(contacts.id, contactId));
    expect(contact.blocked).toBe(true);
    for (const id of [chatId, other.chatId]) {
      expect((await chatRow(id)).state).toBe('closed');
      const closed = (await eventsOf(ctx, id)).find((e) => e.kind === 'closed');
      expect(closed).toMatchObject({ authorId: null, data: { closingMessageSent: false, botId: blocker, runId: run.id } });
    }
    expect((await runRow(waiting.id)).state).toBe('stopped');
    const stopped = (await eventsOf(ctx, other.chatId)).find((e) => e.kind === 'bot_stopped');
    expect(stopped?.data.reason).toBe('contact_blocked');
    expect(sentTexts()).toHaveLength(1); // only the question of the waiting bot
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w server -- test/bots/actions-2.test.ts`
Expected: the Cycle 2 tests still PASS. The new ones FAIL:
- `registry` lists the six missing types: `['transfer_sector', 'transfer_agent', 'privacy', 'notify_agent', 'call_flow', 'block_contact']`.
- The block tests show runs with `state: 'failed'` and `error: 'Bloco não suportado'`.

- [ ] **Step 3: Create `server/src/bots/blocks/actions-2.ts`**

```ts
import { randomUUID } from 'node:crypto';
import { and, count, eq, isNotNull } from 'drizzle-orm';
import type {
  BotNode, BotRunState, CallFlowConfig, NotificationDto, NotifyAgentConfig, PrivacyConfig, TransferAgentConfig, TransferSectorConfig,
} from '@talk/shared';
import { setContactBlocked } from '../../contacts/service.js';
import { chats, userSectors, users } from '../../db/schema.js';
import { closeChatAsBot, setChatPrivacyAsBot, transferChatAsBot } from '../../inbox/chats.js';
import { HttpError } from '../../lib/http-error.js';
import { BlockError } from '../block-error.js';
import type { BlockRegistry, BlockResult, BotCtx } from '../registry.js';

function cfg<T>(node: BotNode): T {
  return node.config as unknown as T;
}

// The id filters below run in JS on purpose. A malformed id in an old draft would otherwise make Postgres
// throw "invalid input syntax for type uuid", which reaches the run as "Erro inesperado" instead of a reason.
// ponytail: loads every active user / sector link and the open-chat counts per call; fine for an office,
// push the filters into SQL if users grow past a few hundred.

async function ownerIsIn(ctx: BotCtx, sectorId: string): Promise<boolean> {
  const owner = ctx.chat.ownerId;
  if (!owner) return false;
  const rows = await ctx.app.db.select({ sectorId: userSectors.sectorId }).from(userSectors).where(eq(userSectors.userId, owner));
  return rows.some((r) => r.sectorId === sectorId);
}

async function pickAgent(ctx: BotCtx, c: TransferAgentConfig): Promise<string> {
  const db = ctx.app.db;
  if (c.rule === 'specific') {
    const active = new Set((await db.select({ id: users.id }).from(users).where(eq(users.active, true))).map((u) => u.id));
    const id = (c.userIds ?? []).find((u) => active.has(u));
    if (!id) throw new BlockError('Nenhum atendente disponível');
    return id;
  }
  const wanted = new Set(c.sectorIds ?? []);
  const members = await db
    .select({ id: users.id, name: users.name, sectorId: userSectors.sectorId })
    .from(userSectors)
    .innerJoin(users, eq(users.id, userSectors.userId))
    .where(eq(users.active, true));
  const candidates = new Map<string, string>(); // id → name
  for (const m of members) if (wanted.has(m.sectorId)) candidates.set(m.id, m.name);
  if (candidates.size === 0) throw new BlockError('Nenhum atendente disponível');
  const load = await db
    .select({ ownerId: chats.ownerId, n: count() })
    .from(chats)
    .where(and(eq(chats.state, 'open'), isNotNull(chats.ownerId)))
    .groupBy(chats.ownerId);
  const open = new Map(load.map((r) => [r.ownerId, r.n]));
  const [best] = [...candidates].sort(
    ([a, aName], [b, bName]) => (open.get(a) ?? 0) - (open.get(b) ?? 0) || aName.localeCompare(bName, 'pt-BR'),
  );
  return best[0];
}

/** call_flow with continueAfter: the child's state (or the flow resume outcome) → this block's result. */
function flowResult(state: BotRunState): BlockResult {
  if (state === 'finished') return { next: 'next' };
  if (state === 'failed' || state === 'stopped') throw new BlockError('O fluxo acionado não terminou');
  return { wait: 'flow' };
}

export const actionBlocks2: BlockRegistry = {
  transfer_sector: {
    type: 'transfer_sector',
    async run(ctx, _run, node) {
      const c = cfg<TransferSectorConfig>(node);
      const keepOwner = !c.onlyIfAgentAllowed || (await ownerIsIn(ctx, c.sectorId));
      ctx.chat = await transferChatAsBot(
        ctx.app, ctx.actor, ctx.chat.id, keepOwner ? { sectorId: c.sectorId } : { sectorId: c.sectorId, ownerId: null },
      );
      return { next: 'next' };
    },
  },

  transfer_agent: {
    type: 'transfer_agent',
    async run(ctx, _run, node) {
      const ownerId = await pickAgent(ctx, cfg<TransferAgentConfig>(node));
      ctx.chat = await transferChatAsBot(ctx.app, ctx.actor, ctx.chat.id, { ownerId });
      return { next: 'next' };
    },
  },

  privacy: {
    type: 'privacy',
    async run(ctx, _run, node) {
      const c = cfg<PrivacyConfig>(node);
      ctx.chat = await setChatPrivacyAsBot(ctx.app, ctx.actor, ctx.chat.id, c.mode === 'private');
      return { next: 'next' };
    },
  },

  notify_agent: {
    type: 'notify_agent',
    async run(ctx, _run, node) {
      const c = cfg<NotifyAgentConfig>(node);
      const userIds = c.target === 'owner' ? (ctx.chat.ownerId ? [ctx.chat.ownerId] : []) : (c.userIds ?? []);
      if (userIds.length === 0) throw new BlockError('A conversa não tem atendente para notificar');
      const notification: NotificationDto = {
        id: randomUUID(),
        chatId: ctx.chat.id,
        title: (await ctx.render(c.title ?? '')).trim() || `Chatbot ${ctx.bot.name}`,
        text: await ctx.render(c.text ?? ''),
        botName: ctx.bot.name,
        createdAt: ctx.now.toISOString(),
      };
      await ctx.app.hub.publishNotification(ctx.chat.id, userIds, notification);
      return { next: 'next' };
    },
  },

  call_flow: {
    type: 'call_flow',
    async run(ctx, _run, node) {
      const c = cfg<CallFlowConfig>(node);
      // startRun refuses a paused/unpublished bot with an HttpError: keep its message as the run's reason.
      // The depth limit already arrives as a BlockError.
      const child = await ctx.startChild(c.botId).catch((e: unknown) => {
        if (e instanceof HttpError) throw new BlockError(e.message);
        throw e;
      });
      if (!c.continueAfter) return { end: 'finished' };
      return flowResult(child.state);
    },
    async resume(_ctx, _run, _node, ev) {
      return flowResult(ev.kind === 'flow' ? ev.outcome : 'failed');
    },
  },

  block_contact: {
    type: 'block_contact',
    async run(ctx) {
      const { contactId } = ctx.chat;
      await setContactBlocked(ctx.app, contactId, true);
      const open = await ctx.app.db
        .select({ id: chats.id })
        .from(chats)
        .where(and(eq(chats.contactId, contactId), eq(chats.state, 'open')));
      for (const { id } of open) {
        await closeChatAsBot(ctx.app, ctx.actor, id, { closingText: null });
        await ctx.stopOtherRuns(id, 'contact_blocked');
      }
      return { end: 'finished' };
    },
  },
};
```

- [ ] **Step 4: Register `actionBlocks2` in `server/src/bots/registry.ts`**

Add the import next to the other `./blocks/*.js` imports:

```ts
import { actionBlocks2 } from './blocks/actions-2.js';
```

Change the `defaultRegistry` declaration to read exactly:

```ts
export const defaultRegistry: BlockRegistry = { ...startBlocks, ...conditionBlocks, ...actionBlocks, ...actionBlocks2, ...finishBlocks };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w server -- test/bots/actions-2.test.ts`
Expected: PASS (21 tests).

Run: `npm test -w server`
Expected: PASS. That covers the whole server suite, including `test/bots/engine.test.ts`, `conditions.test.ts`, `actions-1.test.ts` and `test/realtime/hub.test.ts`.

Run: `npm run typecheck -w server`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/bots/blocks/actions-2.ts server/src/bots/registry.ts server/test/bots/actions-2.test.ts
git commit -m "feat(server): blocos de transferir, privacidade, notificar, acionar fluxo e bloquear contato

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


---

### Task 9: Scheduler and startup wiring

**Files:**
- Create: `server/src/bots/scheduler.ts`
- `server/src/bots/engine.ts`: no change (Task 5 already implements `failInterruptedRuns`)
- Modify: `server/src/index.ts` (boot: `failInterruptedRuns`; after listen: scheduler start; shutdown: scheduler stop)
- Test: `server/test/bots/scheduler.test.ts`

**Interfaces:**
- Consumes:
  - Task 2: `createBot(db: Db, input: { name: string; graph: BotGraph; valid: boolean; publish: boolean; createdBy: string | null; … }): Promise<BotRow>`, the tables `bots`, `botRuns`, `messages.botRunId`.
  - Task 5: `startRun(ctx: AppCtx, input: StartRunInput): Promise<BotRunRow>`, `resumeOnTimer(ctx: AppCtx, runId: string, now: Date): Promise<BotRunRow | null>` (null = no longer due), `resumeOnReply(ctx: AppCtx, chatId: string, reply: InboundReply): Promise<number>`, `runningRunsForChat(db: Db | Tx, chatId: string): Promise<BotRunRow[]>`, `InboundReply` (from `bots/registry.ts`), `createBotRuntime(opts?: { now?: () => Date; … }): BotRuntime`, `createFakeClock(start?: Date): FakeClock`, `failInterruptedRuns(db: Db): Promise<number>` (boot only; returns runs failed), `AppCtx.botRuntime`, and `makeTestCtx()` returning `clock: FakeClock` (start `2026-10-14T13:00:00Z`).
  - Tasks 6–8 blocks used by the tests: `wait_interval` (timer → `next`; with `resumeOnReply`, timeout → `next`), `ask_choice` (timeout → `timeout`), `send_message`, `start_manual`.
  - Task 1: `addEvent` accepts `'bot_failed'`; `BotEventData`, `BotRunState`, `MAX_FLOW_LEVELS` from `@talk/shared`.
- Produces:
  ```ts
  // server/src/bots/scheduler.ts
  export interface Scheduler {
    tick(now?: Date): Promise<number>; // now defaults to ctx.botRuntime.now(); returns runs resumed
    start(): void;                     // setInterval every intervalMs; idempotent; skips a beat while a tick is still running
    stop(): void;                      // clearInterval; idempotent
  }
  export function createScheduler(ctx: AppCtx, opts?: { intervalMs?: number }): Scheduler; // default 5000
  ```

Notes for the implementer:
- Task 5 implements `failInterruptedRuns`; this task only adds the Review Focus 3 tests and the boot wiring. Do not add a second `failInterruptedRuns` to `engine.ts` (TS2393 duplicate implementation).
- `FOR UPDATE SKIP LOCKED` is real-Postgres behavior. PGlite has one connection and serializes transactions, so the tests cannot hold a competing lock; they prove "no double processing" through overlapping ticks and a tick racing a reply. That guard is `resumeOnTimer`'s locked re-check, which the tick relies on.

- [ ] **Step 1: Write the failing scheduler tests**

Create `server/test/bots/scheduler.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { BotEdge, BotGraph, BotNode } from '@talk/shared';
import { botRuns, bots, messages } from '../../src/db/schema.js';
import { createBot } from '../../src/bots/repo.js';
import { resumeOnReply, startRun } from '../../src/bots/engine.js';
import type { InboundReply } from '../../src/bots/registry.js';
import { createBotRuntime, createFakeClock } from '../../src/bots/runtime.js';
import { createScheduler } from '../../src/bots/scheduler.js';
import { makeTestCtx, seedBasics, type Seeded } from '../helpers.js';
import { insertChat, newContact } from '../inbox/fixtures.js';

type Ctx = Awaited<ReturnType<typeof makeTestCtx>>;
const MIN = 60_000;
const HOUR = 60 * MIN;

let ctx: Ctx;
let s: Seeded;

beforeEach(async () => {
  ctx = await makeTestCtx();
  s = await seedBasics(ctx);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const node = (id: string, type: BotNode['type'], config: Record<string, unknown> = {}): BotNode => ({
  id, type, name: id, position: { x: 0, y: 0 }, config,
});
const edge = (source: string, sourceHandle: string, target: string): BotEdge => ({
  id: `${source}-${sourceHandle}`, source, sourceHandle, target,
});
const say = (text: string) => ({ text, attachment: null, signature: false });

/** inicio → espera (10 min) → depois; with resumeOnReply also espera.replied → respondeu. */
function timerGraph(resumeOnReply: boolean): BotGraph {
  return {
    nodes: [
      node('inicio', 'start_manual'),
      node('espera', 'wait_interval', { mode: 'fixed', amount: 10, unit: 'minutes', resumeOnReply }),
      node('depois', 'send_message', say('Passou o tempo')),
      ...(resumeOnReply ? [node('respondeu', 'send_message', say('Respondeu antes'))] : []),
    ],
    edges: [
      edge('inicio', 'next', 'espera'),
      edge('espera', 'next', 'depois'),
      ...(resumeOnReply ? [edge('espera', 'replied', 'respondeu')] : []),
    ],
  };
}

/** inicio → menu (ask_choice "1: Sim"); opt:1 → escolheu; timeout → sem_resposta when timeoutHours is set. */
function menuGraph(timeoutHours: number | null): BotGraph {
  return {
    nodes: [
      node('inicio', 'start_manual'),
      node('menu', 'ask_choice', { text: 'Escolha uma opção', options: [{ key: '1', label: 'Sim' }], invalidRetries: 1, timeoutHours }),
      node('escolheu', 'send_message', say('Escolheu sim')),
      ...(timeoutHours ? [node('sem_resposta', 'send_message', say('Sem resposta, encerrando'))] : []),
    ],
    edges: [
      edge('inicio', 'next', 'menu'),
      edge('menu', 'opt:1', 'escolheu'),
      ...(timeoutHours ? [edge('menu', 'timeout', 'sem_resposta')] : []),
    ],
  };
}

async function activeBot(graph: BotGraph, name = 'Bot teste') {
  const created = await createBot(ctx.db, { name, graph, valid: true, publish: true, createdBy: null });
  const [row] = await ctx.db.update(bots).set({ status: 'active' }).where(eq(bots.id, created.id)).returning();
  return { botId: row.id, versionId: row.publishedVersionId! };
}

async function openChat() {
  const contactId = await newContact(ctx);
  const chatId = await insertChat(ctx, { channelId: s.channelId, sectorId: s.defaultSector, contactId });
  return { chatId, contactId };
}

async function startManual(graph: BotGraph) {
  const { botId, versionId } = await activeBot(graph);
  const { chatId, contactId } = await openChat();
  const run = await startRun(ctx, { botId, chatId, entry: 'manual', startedBy: s.admin.id });
  return { botId, versionId, chatId, contactId, runId: run.id };
}

async function runOf(id: string) {
  const [row] = await ctx.db.select().from(botRuns).where(eq(botRuns.id, id));
  return row;
}

function texts(): string[] {
  return ctx.wa.sent.filter((m) => m.method === 'sendText').map((m) => (m.payload as { text: string }).text);
}

/** Stores an inbound text 1 ms after the run started waiting, so it counts as the answer (Review Focus 1). */
async function replyAfterWait(runId: string, chatId: string, body: string): Promise<InboundReply> {
  const { waitingSince } = await runOf(runId);
  const createdAt = new Date(waitingSince!.getTime() + 1);
  const [m] = await ctx.db
    .insert(messages)
    .values({ chatId, channelId: s.channelId, direction: 'in', kind: 'text', body, status: 'sent', sentAt: createdAt, createdAt })
    .returning({ id: messages.id });
  return { messageId: m.id, kind: 'text', body, mediaMime: null, mediaName: null, createdAt };
}

describe('scheduler tick', () => {
  it('resumes a wait_interval timer only once it is due, using the runtime clock by default', async () => {
    const t0 = ctx.clock.now();
    const { runId } = await startManual(timerGraph(false));
    expect((await runOf(runId)).state).toBe('waiting_timer');

    const sched = createScheduler(ctx);
    expect(await sched.tick(new Date(t0.getTime() + 5 * MIN))).toBe(0);
    expect(texts()).toEqual([]);

    ctx.clock.set(new Date(t0.getTime() + 10 * MIN));
    expect(await sched.tick()).toBe(1);
    expect(texts()).toEqual(['Passou o tempo']);
    const run = await runOf(runId);
    expect(run.state).toBe('finished');
    expect(run.wakeAt).toBeNull();

    expect(await sched.tick()).toBe(0);
    expect(texts()).toEqual(['Passou o tempo']);
  });

  it('sends a waiting ask_choice down its timeout output when timeout_at passes', async () => {
    const t0 = ctx.clock.now();
    const { runId } = await startManual(menuGraph(1));
    const waiting = await runOf(runId);
    expect(waiting.state).toBe('waiting_reply');
    expect(waiting.timeoutAt?.getTime()).toBe(t0.getTime() + HOUR);

    const sched = createScheduler(ctx);
    expect(await sched.tick(new Date(t0.getTime() + HOUR - 1000))).toBe(0);
    expect(await sched.tick(new Date(t0.getTime() + HOUR))).toBe(1);

    const run = await runOf(runId);
    expect(run.state).toBe('finished');
    expect(run.steps.map((st) => st.outcome)).toContain('timeout');
    expect(texts()).toHaveLength(2); // the menu, then the timeout branch
    expect(texts()[1]).toBe('Sem resposta, encerrando');
  });

  it('continues a wait_interval with resumeOnReply through "next" when nobody replies', async () => {
    const t0 = ctx.clock.now();
    const { runId } = await startManual(timerGraph(true));
    const waiting = await runOf(runId);
    expect(waiting.state).toBe('waiting_reply');
    expect(waiting.timeoutAt?.getTime()).toBe(t0.getTime() + 10 * MIN);

    expect(await createScheduler(ctx).tick(new Date(t0.getTime() + 10 * MIN))).toBe(1);
    expect(texts()).toEqual(['Passou o tempo']);
    expect((await runOf(runId)).state).toBe('finished');
  });

  it('never wakes a reply wait that has no timeout', async () => {
    const t0 = ctx.clock.now();
    const { runId } = await startManual(menuGraph(null));
    expect(await createScheduler(ctx).tick(new Date(t0.getTime() + 365 * 24 * HOUR))).toBe(0);
    expect((await runOf(runId)).state).toBe('waiting_reply');
  });

  it('takes at most 50 due runs per tick, earliest due first', async () => {
    const t0 = ctx.clock.now();
    const { botId, versionId } = await activeBot(timerGraph(false));
    const { chatId, contactId } = await openChat();
    // depth 1: the one-active-run-per-(chat, bot) index covers root runs only, so 51 waits can share one chat
    const rows = await ctx.db
      .insert(botRuns)
      .values(
        Array.from({ length: 51 }, (_, i) => ({
          botId, versionId, chatId, contactId, state: 'waiting_timer' as const,
          currentNodeId: 'espera', waitNodeId: 'espera', depth: 1, wakeAt: new Date(t0.getTime() - i * MIN),
        })),
      )
      .returning({ id: botRuns.id });

    const sched = createScheduler(ctx);
    expect(await sched.tick(t0)).toBe(50);
    expect(texts()).toHaveLength(50);
    const left = await ctx.db.select({ id: botRuns.id }).from(botRuns).where(eq(botRuns.state, 'waiting_timer'));
    expect(left.map((r) => r.id)).toEqual([rows[0].id]); // the latest-due one waits for the next tick

    expect(await sched.tick(t0)).toBe(1);
    expect(await sched.tick(t0)).toBe(0);
    expect(texts()).toHaveLength(51);
  });

  it('never processes a run twice when two ticks overlap', async () => {
    const t0 = ctx.clock.now();
    const { runId } = await startManual(timerGraph(false));
    const due = new Date(t0.getTime() + 10 * MIN);

    const [a, b] = await Promise.all([createScheduler(ctx).tick(due), createScheduler(ctx).tick(due)]);
    expect(a + b).toBe(1);
    expect(texts()).toEqual(['Passou o tempo']);
    expect((await runOf(runId)).state).toBe('finished');
  });

  it('lets a reply and a due timeout race without resuming the run twice', async () => {
    const t0 = ctx.clock.now();
    const { runId, chatId } = await startManual(menuGraph(1));
    const reply = await replyAfterWait(runId, chatId, '1');
    ctx.clock.set(new Date(t0.getTime() + HOUR));

    const [byTick, byReply] = await Promise.all([createScheduler(ctx).tick(), resumeOnReply(ctx, chatId, reply)]);
    expect(byTick + byReply).toBe(1);
    const run = await runOf(runId);
    expect(run.state).toBe('finished');
    expect(run.steps.map((st) => st.outcome).filter((o) => o === 'opt:1' || o === 'timeout')).toHaveLength(1);
    expect(texts()).toHaveLength(2); // the menu, then exactly one of "Escolheu sim" / "Sem resposta, encerrando"
  });

  it('picks up a due timer after a restart (new ctx and runtime over the same database)', async () => {
    const t0 = ctx.clock.now();
    const { runId } = await startManual(timerGraph(false));

    const clock = createFakeClock(new Date(t0.getTime() + 10 * MIN));
    const restarted = { ...ctx, botRuntime: createBotRuntime({ now: clock.now }) };
    expect(await createScheduler(restarted).tick()).toBe(1);
    expect(texts()).toEqual(['Passou o tempo']);
    expect((await runOf(runId)).state).toBe('finished');
  });
});

describe('scheduler start/stop', () => {
  const flush = () => new Promise<void>((r) => setImmediate(r)); // setImmediate is not faked below

  it('ticks every interval, skips a beat while a tick is running, survives a failed tick and stops', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const sched = createScheduler(ctx, { intervalMs: 1000 });
    let release!: () => void;
    const tick = vi
      .spyOn(sched, 'tick')
      .mockImplementationOnce(() => new Promise<number>((r) => { release = () => r(0); }))
      .mockRejectedValueOnce(Object.assign(new Error('segredo do contato'), { code: '57P01' }))
      .mockResolvedValue(0);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});

    sched.start();
    sched.start();
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(999);
    expect(tick).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(1);
    expect(tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3000);
    expect(tick).toHaveBeenCalledTimes(1); // the first tick is still running

    release();
    await flush();
    vi.advanceTimersByTime(1000);
    expect(tick).toHaveBeenCalledTimes(2); // this one rejects
    await flush();
    expect(log).toHaveBeenCalledWith('chatbot: falha no relógio', 'Error 57P01');
    expect(JSON.stringify(log.mock.calls)).not.toContain('segredo');

    vi.advanceTimersByTime(1000);
    expect(tick).toHaveBeenCalledTimes(3);
    await flush();

    sched.stop();
    sched.stop();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(tick).toHaveBeenCalledTimes(3);
  });

  it('defaults to a 5 s interval', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const sched = createScheduler(ctx);
    const tick = vi.spyOn(sched, 'tick').mockResolvedValue(0);
    sched.start();
    vi.advanceTimersByTime(4999);
    expect(tick).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(1);
    expect(tick).toHaveBeenCalledTimes(1);
    sched.stop();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w server -- test/bots/scheduler.test.ts`
Expected: FAIL. The suite cannot load `../../src/bots/scheduler.js` because the file does not exist yet.

- [ ] **Step 3: Write the scheduler**

Create `server/src/bots/scheduler.ts`:

```ts
import { and, eq, lte, or, sql } from 'drizzle-orm';
import type { AppCtx } from '../ctx.js';
import { botRuns } from '../db/schema.js';
import { resumeOnTimer } from './engine.js';

export interface Scheduler {
  tick(now?: Date): Promise<number>;
  start(): void;
  stop(): void;
}

const TICK_LIMIT = 50;

/** Error name and pg code only: never the message, which may quote contact data. */
function errorTag(err: unknown): string {
  const e = err as { name?: unknown; code?: unknown } | null;
  const name = typeof e?.name === 'string' ? e.name : 'Error';
  return typeof e?.code === 'string' ? `${name} ${e.code}` : name;
}

export function createScheduler(ctx: AppCtx, opts: { intervalMs?: number } = {}): Scheduler {
  const intervalMs = opts.intervalMs ?? 5000;
  let timer: ReturnType<typeof setInterval> | null = null;
  let busy = false;

  const scheduler: Scheduler = {
    async tick(now: Date = ctx.botRuntime.now()): Promise<number> {
      // Claim the due ids in a short tx; SKIP LOCKED passes over runs a reply/timer is resuming right now.
      // The locks end at commit, so resumeOnTimer's own locked re-check is what stops a run resuming twice.
      const ids = await ctx.db.transaction(async (tx) => {
        const rows = await tx
          .select({ id: botRuns.id })
          .from(botRuns)
          .where(
            or(
              and(eq(botRuns.state, 'waiting_timer'), lte(botRuns.wakeAt, now)),
              and(eq(botRuns.state, 'waiting_reply'), lte(botRuns.timeoutAt, now)),
            ),
          )
          .orderBy(sql`case when ${botRuns.state} = 'waiting_timer' then ${botRuns.wakeAt} else ${botRuns.timeoutAt} end`, botRuns.id)
          .limit(TICK_LIMIT)
          .for('update', { skipLocked: true });
        return rows.map((r) => r.id);
      });

      let resumed = 0;
      for (const id of ids) {
        try {
          if (await resumeOnTimer(ctx, id, now)) resumed += 1;
        } catch (err) {
          // one broken run must not hold back the rest of the batch
          console.error('chatbot: falha ao retomar execução', id, errorTag(err));
        }
      }
      return resumed;
    },

    start() {
      if (timer) return;
      timer = setInterval(() => {
        if (busy) return; // a slow tick is still draining; the next beat picks up whatever is left
        busy = true;
        scheduler
          .tick()
          .catch((err: unknown) => console.error('chatbot: falha no relógio', errorTag(err)))
          .finally(() => {
            busy = false;
          });
      }, intervalMs);
      timer.unref();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
  return scheduler;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w server -- test/bots/scheduler.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/bots/scheduler.ts server/test/bots/scheduler.test.ts
git commit -m "feat(server): scheduler that wakes due bot timers and reply timeouts" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Write the regression tests for `failInterruptedRuns` (Review Focus 3)**

In `server/test/bots/scheduler.test.ts`, replace these three import lines:

```ts
import type { BotEdge, BotGraph, BotNode } from '@talk/shared';
```
```ts
import { resumeOnReply, startRun } from '../../src/bots/engine.js';
```
```ts
import { insertChat, newContact } from '../inbox/fixtures.js';
```

with:

```ts
import type { BotEdge, BotGraph, BotNode, BotRunState } from '@talk/shared';
```
```ts
import { failInterruptedRuns, resumeOnReply, runningRunsForChat, startRun } from '../../src/bots/engine.js';
```
```ts
import { eventsOf, insertChat, newContact } from '../inbox/fixtures.js';
```

Then append at the end of the file:

```ts
describe('failInterruptedRuns', () => {
  const INTERRUPTED = 'Interrompido por reinício do servidor';

  it('failInterruptedRuns fails runs left running and frees the chat', async () => {
    const { botId, chatId, runId } = await startManual(menuGraph(null));
    // the process died mid-step: the run is stuck in 'running'
    await ctx.db.update(botRuns).set({ state: 'running' }).where(eq(botRuns.id, runId));

    expect(await failInterruptedRuns(ctx.db)).toBe(1);

    const run = await runOf(runId);
    expect(run.state).toBe('failed');
    expect(run.error).toBe(INTERRUPTED);
    expect(run.finishedAt).not.toBeNull();
    expect(run.waitingSince).toBeNull();
    const failed = (await eventsOf(ctx, chatId)).filter((e) => e.kind === 'bot_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].data).toEqual({ botId, botName: 'Bot teste', runId, reason: INTERRUPTED });
    expect(failed[0].authorId).toBeNull();

    // the one-active-run index no longer blocks the chat
    const again = await startRun(ctx, { botId, chatId, entry: 'manual', startedBy: s.admin.id });
    expect((await runningRunsForChat(ctx.db, chatId)).map((r) => r.id)).toEqual([again.id]);
    expect(await failInterruptedRuns(ctx.db)).toBe(0);
  });

  it('also fails call_flow parents left waiting on a dead child chain, and leaves healthy waits alone', async () => {
    const { botId, versionId } = await activeBot(timerGraph(false));
    const a = await openChat();
    const b = await openChat();
    const insertRun = async (chat: { chatId: string; contactId: string }, state: BotRunState, depth: number, parentRunId: string | null) => {
      const [row] = await ctx.db
        .insert(botRuns)
        .values({
          botId, versionId, chatId: chat.chatId, contactId: chat.contactId, state, currentNodeId: 'espera', depth, parentRunId,
          wakeAt: state === 'waiting_timer' ? new Date(ctx.clock.now().getTime() + HOUR) : null,
        })
        .returning({ id: botRuns.id });
      return row.id;
    };
    const grand = await insertRun(a, 'waiting_flow', 0, null);
    const parent = await insertRun(a, 'waiting_flow', 1, grand);
    const child = await insertRun(a, 'running', 2, parent);
    const okParent = await insertRun(b, 'waiting_flow', 0, null);
    const okChild = await insertRun(b, 'waiting_timer', 1, okParent);

    expect(await failInterruptedRuns(ctx.db)).toBe(3);

    for (const id of [child, parent, grand]) {
      const run = await runOf(id);
      expect(run.state).toBe('failed');
      expect(run.error).toBe(INTERRUPTED);
    }
    expect((await runOf(okParent)).state).toBe('waiting_flow');
    expect((await runOf(okChild)).state).toBe('waiting_timer');
    expect((await eventsOf(ctx, a.chatId)).filter((e) => e.kind === 'bot_failed')).toHaveLength(3);
    expect((await eventsOf(ctx, b.chatId)).filter((e) => e.kind === 'bot_failed')).toHaveLength(0);
  });
});
```

- [ ] **Step 7: Run the new tests**

Run: `npm test -w server -- test/bots/scheduler.test.ts -t failInterruptedRuns`
Expected: PASS (2 tests). These are regression tests for Task 5's implementation: `engine.ts` already exports `failInterruptedRuns`, with the running → failed pass, the level-by-level `waiting_flow` orphan pass and `bot_failed {botId, botName, runId, reason}` events. Do not add code to `engine.ts`.

- [ ] **Step 8: Run the scheduler test file to verify everything passes**

Run: `npm test -w server -- test/bots/scheduler.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 9: Commit**

```bash
git add server/test/bots/scheduler.test.ts
git commit -m "test(server): cover failInterruptedRuns at boot (Review Focus 3)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 10: Wire the boot cleanup and the scheduler into `server/src/index.ts`**

Replace the whole file with this. It keeps Task 5's `botRuntime: createBotRuntime()`; the new lines are the three bot imports, `failInterruptedRuns`, the scheduler start and `scheduler.stop()`:

```ts
import { loadConfig } from './config.js';
import { createPgDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { createEvolutionGateway } from './whatsapp/evolution.js';
import { createHub } from './realtime/hub.js';
import { buildApp } from './app.js';
import { syncChannelStatuses } from './channels/service.js';
import { failInterruptedSends } from './messages/send.js';
import { createBotRuntime } from './bots/runtime.js';
import { failInterruptedRuns } from './bots/engine.js';
import { createScheduler } from './bots/scheduler.js';
import type { AppCtx } from './ctx.js';

const config = loadConfig(process.env);
const db = createPgDb(config.databaseUrl);
await runMigrations(db);
await failInterruptedSends(db); // before listen: nothing can be mid-send yet
await failInterruptedRuns(db); // same: a bot run still 'running' died with the previous process; frees its chat

const ctx: AppCtx = {
  db,
  wa: createEvolutionGateway(config.evolution),
  hub: createHub(() => db),
  config,
  botRuntime: createBotRuntime(),
};
const app = await buildApp(ctx, {
  // Only Caddy is in front (§6), over the private Docker network: req.ip is the client's, so the login limit is
  // per client IP. Fastify 5.12 fails closed on a hop count (trustProxy: 1 is a type error and trusts nobody),
  // so trust the private ranges instead: a public peer can never spoof X-Forwarded-For.
  trustProxy: 'loopback,linklocal,uniquelocal',
  logger: {
    level: 'info',
    serializers: {
      // the webhook secret sits in the URL path; never write it to the request log
      req: (r) => ({ method: r.method, url: r.url?.replace(/^\/webhooks\/evolution\/[^/?]+/, '/webhooks/evolution/***') }),
    },
  },
});

// ponytail: one-shot correction at boot (§5.6), no periodic polling; on failure the stored status stays until the next connection.update
syncChannelStatuses(ctx).catch((err: unknown) => app.log.error({ err }, 'falha ao sincronizar status dos canais'));

await app.listen({ host: '0.0.0.0', port: config.port });

// Waiting bot runs live in the DB; every 5 s this wakes the due ones (wait_interval timers and reply timeouts).
const scheduler = createScheduler(ctx);
scheduler.start();

// Node as PID 1 in Docker ignores SIGTERM unless handled; close cleanly so `docker compose stop` is fast
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    scheduler.stop();
    void app.close().then(() => process.exit(0));
  });
}
```

- [ ] **Step 11: Typecheck and run the whole server suite**

Run: `npm run typecheck -w server`
Expected: exits 0 with no errors.

Run: `npm test -w server`
Expected: PASS. Every existing test file plus `test/bots/scheduler.test.ts` (12 tests) is green.

- [ ] **Step 12: Commit**

```bash
git add server/src/index.ts
git commit -m "feat(server): start the bot scheduler at boot and stop it on shutdown" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


---

### Task 10: Ingest and agent interaction integration

This task connects the engine (Tasks 5–9) to the rest of the app. Spec references:

- **§5.1 "Por canal".** A new chat opened by an inbound message starts the oldest active channel bot **instead of** the triage. With no bot, the triage runs as today.
- **§5.4.** An inbound reply resumes `waiting_reply` runs after the commit.
- **§5.5.** `settings.bot_running_behavior` (`ask` / `stop` / `keep`) decides what an agent send does while a bot runs. `ask` answers 409 `BOT_RUNNING` unless the request carries `botAction`. A manual transfer follows the same setting. Closing a chat stops all of its runs. Notes never affect the bot.
- **Review Focus 5.** Outbound and echo messages never start or resume a bot, and never count as an agent message.

The task has three cycles. Cycle 1 adds the setting. Cycle 2 adds the bot hooks and wires them into ingest. Cycle 3 adds the agent side: `HttpError.body`, `botRunningError`, `sendAgentMessage`, and the chat routes.

**Files:**
- Modify: `shared/src/index.ts` (`SettingsDto`, line 26, plus one `import type`)
- Modify: `server/src/catalog/settings.ts` (whole file shown)
- Modify: `server/test/catalog/settings.test.ts` (the two `toEqual(body)` lines, the import line, and a new `it`)
- Create: `server/src/bots/hooks.ts`
- Modify: `server/src/messages/ingest.ts` (imports, `IngestHooks`, `handleInbound`, `ingestMessage`)
- Modify: `server/src/lib/http-error.ts` (whole file shown)
- Modify: `server/src/app.ts:33` (error handler spreads `err.body`)
- Modify: `server/src/messages/send.ts` (imports, `SendInput`, `sendAgentMessage`)
- Modify: `server/src/chats/routes.ts` (whole file shown)
- Test: `server/test/bots/integration.test.ts` (create)
- Regression (unchanged, must still pass): `server/test/messages/ingest.test.ts`, `server/test/contacts/avatar.test.ts`, `server/test/chats/actions.test.ts`, `server/test/messages/send.test.ts`, `server/test/triage/*.test.ts`, `server/test/app.test.ts`

**Interfaces:**
- Consumes:
  - From Task 1 (`@talk/shared`): `type BotAction = 'stop' | 'keep'`, `type BotRunningBehavior = 'ask' | 'stop' | 'keep'`, `type BotStopReason`, `interface BotGraph`.
  - From Task 2:
    - `server/src/db/schema.ts`: `bots`, `botRuns`, and `messages.botRunId`.
    - `server/src/bots/repo.ts`:
      - `createBot(db: Db, input: { name; description?; graph: BotGraph; valid: boolean; publish: boolean; createdBy: string | null; startChannelIds?: string[]; manualStart?; manualTitle? }): Promise<BotRow>`. A new bot is `status 'paused'`.
      - `findChannelBot(db: Db | Tx, channelId: string): Promise<BotRow | null>`.
  - From Task 5:
    - `server/src/bots/registry.ts`: `interface InboundReply { messageId: string; kind: MessageKind; body: string | null; mediaMime: string | null; mediaName: string | null; createdAt: Date }`.
    - `server/src/bots/engine.ts`:
      - `startRun(ctx: AppCtx, input: StartRunInput): Promise<BotRunRow>`
      - `resumeOnReply(ctx: AppCtx, chatId: string, reply: InboundReply): Promise<number>`
      - `stopRunsForChat(ctx: AppCtx, chatId: string, by: { userId: string | null; reason: BotStopReason }, opts?: { exceptRunIds?: string[] }): Promise<BotRunRow[]>`
      - `runningRunsForChat(db: Db | Tx, chatId: string): Promise<BotRunRow[]>`
    - `makeTestCtx()` builds `ctx.botRuntime`.
    - `stopRun` / `stopRunsForChat` write `bot_stopped` with `authorId = by.userId` and `data` `{ botId, botName, runId, reason, by }`.
  - From Tasks 7–8: the real `start_channel`, `ask_choice` and `send_message` blocks in `defaultRegistry`. Bot sends go through `sendSystemMessage`, which sets `messages.bot_run_id` and calls the fake gateway's `sendText`.
    - `ask_choice` sends `text + '\n\n' + '<key>: <label>'` lines.
    - A matching reply sets `run.vars[name] = { raw, value: key, label }` and follows `opt:<key>`.
  - Existing code: `getChatForUser`, `transferChat` and `closeChat` (`inbox/chats.ts`), `sendAgentMessage`, `addNote` and `SendInput` (`messages/send.ts`), `handleInbound` and `IngestHooks` (`messages/ingest.ts`).
  - Test helpers: `makeTestCtx`, `makeTestApp`, `seedBasics`, `loginAs`, `enableSeeAll` (`server/test/helpers.ts`), and `eventsOf` (`server/test/inbox/fixtures.ts`).
- Produces (Tasks 11–16 rely on exactly these):
  ```ts
  // shared/src/index.ts
  export interface SettingsDto { closingMessage: string; triageMenu: TriageMenuDto; botRunningBehavior: BotRunningBehavior }

  // server/src/catalog/settings.ts
  export async function getBotRunningBehavior(db: Db | Tx): Promise<BotRunningBehavior>; // 'ask' when missing/invalid
  // PUT /api/settings Body gains botRunningBehavior: z.enum(['ask','stop','keep']).default('ask'), stored as key 'bot_running_behavior'

  // server/src/lib/http-error.ts
  export class HttpError extends Error { constructor(public status: number, message: string, public body?: Record<string, unknown>) }
  export function botRunningError(runs: Array<{ id: string; botName: string }>): HttpError;
  // 409, message 'O chatbot está em execução nesta conversa', body { code: 'BOT_RUNNING', runs }
  // app.ts error handler sends { error: err.message, ...err.body }

  // server/src/bots/hooks.ts
  export async function startChannelBot(ctx: AppCtx, chat: ChatRow): Promise<boolean>;
  export async function resumeBotsOnReply(ctx: AppCtx, chatId: string, reply: InboundReply): Promise<number>;
  export async function applyBotRunningBehavior(ctx: AppCtx, user: AuthUser, chatId: string,
    botAction: BotAction | undefined, reason: 'agent_message' | 'transfer'): Promise<void>;

  // server/src/messages/ingest.ts
  export interface IngestHooks {
    startTriage: typeof startTriage; handleTriageReply: typeof handleTriageReply;
    startChannelBot?: typeof startChannelBot; resumeBotsOnReply?: typeof resumeBotsOnReply;
  }

  // server/src/messages/send.ts
  export interface SendInput { text?; file?; asVoice?; signature: boolean; replyToId?; botAction?: BotAction }
  ```
  HTTP behavior:
  - `POST /api/chats/:id/messages` accepts `botAction?: 'stop' | 'keep'` (JSON field, or a multipart text field) and answers 409 `BotRunningErrorBody` under `ask`.
  - `POST /api/chats/:id/transfer` accepts `botAction?` and answers 409 `BotRunningErrorBody` under `ask`. A user who cannot see the chat gets 404 first.
  - `POST /api/chats/:id/close` never asks, and stops every run of the chat with reason `chat_closed` (`authorId` = the closing user).

#### Cycle 1: the `bot_running_behavior` setting

- [ ] **Step 1: Write the failing test**

In `server/test/catalog/settings.test.ts`, replace the import line

```ts
import { settings } from '../../src/db/schema.js';
```

with

```ts
import { getBotRunningBehavior } from '../../src/catalog/settings.js';
import { settings } from '../../src/db/schema.js';
```

In the existing `it('saves the closing message and triage menu …')`, replace

```ts
  const saved = await put(admin, body);
  expect(saved.statusCode).toBe(200);
  expect(saved.json()).toEqual(body);

  const got = await app.inject({ method: 'GET', url: '/api/settings', headers: agent });
  expect(got.statusCode).toBe(200);
  expect(got.json()).toEqual(body);
```

with

```ts
  const saved = await put(admin, body);
  expect(saved.statusCode).toBe(200);
  expect(saved.json()).toEqual({ ...body, botRunningBehavior: 'ask' }); // omitted → default

  const got = await app.inject({ method: 'GET', url: '/api/settings', headers: agent });
  expect(got.statusCode).toBe(200);
  expect(got.json()).toEqual({ ...body, botRunningBehavior: 'ask' });
```

Append at the end of the file:

```ts
it('stores bot_running_behavior, defaults to ask and rejects unknown values', async () => {
  const base = { closingMessage: '', triageMenu: { enabled: false, welcomeText: '', invalidText: '', options: [] } };

  const fresh = await app.inject({ method: 'GET', url: '/api/settings', headers: agent });
  expect(fresh.json().botRunningBehavior).toBe('ask'); // key missing
  expect(await getBotRunningBehavior(ctx.db)).toBe('ask');

  expect((await put(admin, { ...base, botRunningBehavior: 'sempre' })).statusCode).toBe(400);
  expect((await put(agent, { ...base, botRunningBehavior: 'stop' })).statusCode).toBe(403);

  const saved = await put(admin, { ...base, botRunningBehavior: 'stop' });
  expect(saved.statusCode).toBe(200);
  expect(saved.json().botRunningBehavior).toBe('stop');
  const [row] = await ctx.db.select().from(settings).where(eq(settings.key, 'bot_running_behavior'));
  expect(row.value).toBe('stop');
  expect(await getBotRunningBehavior(ctx.db)).toBe('stop');

  await put(admin, { ...base, botRunningBehavior: 'keep' });
  expect(await getBotRunningBehavior(ctx.db)).toBe('keep');

  // A value that is not one of the three (hand-edited DB, older build) reads as the default.
  await ctx.db.update(settings).set({ value: 'talvez' }).where(eq(settings.key, 'bot_running_behavior'));
  expect(await getBotRunningBehavior(ctx.db)).toBe('ask');
  const got = await app.inject({ method: 'GET', url: '/api/settings', headers: agent });
  expect(got.json().botRunningBehavior).toBe('ask');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- test/catalog/settings.test.ts`
Expected: FAIL.
- The existing case fails on `toEqual`, because the response has no `botRunningBehavior` key.
- The new case fails with `TypeError: getBotRunningBehavior is not a function`, because it is not exported yet.

- [ ] **Step 3: Write minimal implementation**

In `shared/src/index.ts`, add this line directly below `export { TAG_COLORS, tagColorHex } from './palette.js';`:

```ts
import type { BotRunningBehavior } from './bots.js';
```

Then replace

```ts
export interface SettingsDto { closingMessage: string; triageMenu: TriageMenuDto }
```

with

```ts
export interface SettingsDto { closingMessage: string; triageMenu: TriageMenuDto; botRunningBehavior: BotRunningBehavior }
```

Replace the whole of `server/src/catalog/settings.ts` with:

```ts
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { BotRunningBehavior, SettingsDto } from '@talk/shared';
import type { AppCtx } from '../ctx.js';
import type { Db, Tx } from '../db/client.js';
import { sectors, settings } from '../db/schema.js';
import { badRequest, forbidden } from '../lib/http-error.js';
import { getTriageMenu } from '../triage/triage.js';

const BotRunningBehaviorEnum = z.enum(['ask', 'stop', 'keep']);

const Body = z.object({
  closingMessage: z.string().trim().max(2000),
  triageMenu: z
    .object({
      enabled: z.boolean(),
      welcomeText: z.string().trim().max(2000),
      invalidText: z.string().trim().max(2000),
      options: z
        .array(z.object({ key: z.string().trim().min(1).max(10), label: z.string().trim().min(1).max(60), sectorId: z.uuid() }))
        .max(20),
    })
    .refine((m) => !m.enabled || m.options.length > 0, { error: 'O menu ativo precisa de pelo menos uma opção' })
    .refine((m) => new Set(m.options.map((o) => o.key.toLowerCase())).size === m.options.length, {
      error: 'Há opções com o mesmo número',
    }),
  // Spec §5.5. PUT replaces everything, so an omitted value resets to 'ask'; the web always PUTs the whole SettingsDto back.
  botRunningBehavior: BotRunningBehaviorEnum.default('ask'),
});

/** settings 'bot_running_behavior' (a jsonb string); 'ask' when the key is missing or holds anything else. */
export async function getBotRunningBehavior(db: Db | Tx): Promise<BotRunningBehavior> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, 'bot_running_behavior'));
  const parsed = BotRunningBehaviorEnum.safeParse(row?.value);
  return parsed.success ? parsed.data : 'ask';
}

async function readSettings(db: Db): Promise<SettingsDto> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, 'closing_message'));
  return {
    closingMessage: typeof row?.value === 'string' ? row.value : '',
    triageMenu: await getTriageMenu(db),
    botRunningBehavior: await getBotRunningBehavior(db),
  };
}

export function registerSettingsRoutes(app: FastifyInstance, ctx: AppCtx): void {
  app.get('/api/settings', async () => readSettings(ctx.db));

  app.put('/api/settings', async (req) => {
    if (req.user.role !== 'admin') throw forbidden();
    const b = Body.parse(req.body);
    const sectorIds = [...new Set(b.triageMenu.options.map((o) => o.sectorId))];
    if (sectorIds.length && (await ctx.db.$count(sectors, inArray(sectors.id, sectorIds))) !== sectorIds.length) {
      throw badRequest('O menu de triagem aponta para um setor que não existe');
    }
    // Stored snake_case exactly as spec §4; triage/getTriageMenu reads it back.
    const triage = {
      enabled: b.triageMenu.enabled,
      welcome_text: b.triageMenu.welcomeText,
      invalid_text: b.triageMenu.invalidText,
      options: b.triageMenu.options.map((o) => ({ key: o.key, label: o.label, sector_id: o.sectorId })),
    };
    await ctx.db.transaction(async (tx) => {
      await tx
        .insert(settings)
        .values({ key: 'closing_message', value: b.closingMessage })
        .onConflictDoUpdate({ target: settings.key, set: { value: b.closingMessage } });
      await tx
        .insert(settings)
        .values({ key: 'triage_menu', value: triage })
        .onConflictDoUpdate({ target: settings.key, set: { value: triage } });
      await tx
        .insert(settings)
        .values({ key: 'bot_running_behavior', value: b.botRunningBehavior })
        .onConflictDoUpdate({ target: settings.key, set: { value: b.botRunningBehavior } });
    });
    return readSettings(ctx.db);
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w server -- test/catalog/settings.test.ts`
Expected: PASS (2 tests).

Run: `npm run typecheck`
Expected: exit 0 for all three workspaces. On the web side, `ChatSettings` and `TriageSettings` PUT `{ ...settings, … }`, so the new required DTO field carries through, and no web test builds a `SettingsDto` literal.

- [ ] **Step 5: Commit**

```bash
git add shared/src/index.ts server/src/catalog/settings.ts server/test/catalog/settings.test.ts
git commit -m "feat(server): bot_running_behavior setting

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

#### Cycle 2: start by channel before triage, resume on reply

- [ ] **Step 1: Write the failing test**

Create `server/test/bots/integration.test.ts`:

```ts
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { BotGraph } from '@talk/shared';
import type { InboundReply } from '../../src/bots/registry.js';
import { createBot } from '../../src/bots/repo.js';
import { botRuns, bots, chats, contacts, messages } from '../../src/db/schema.js';
import { handleInbound, type IngestHooks } from '../../src/messages/ingest.js';
import type { InboundEvent } from '../../src/whatsapp/types.js';
import { makeTestCtx, seedBasics } from '../helpers.js';

type Ctx = Awaited<ReturnType<typeof makeTestCtx>>;
type MessageEvent = Extract<InboundEvent, { type: 'message' }>;

const PHONE = '5565999990001';
const OTHER_PHONE = '5565999990002';
const MENU_TEXT = 'Escolha uma opção:\n\n1: Financeiro';
let seq = 0;

function msg(over: Partial<MessageEvent> = {}): MessageEvent {
  seq += 1;
  return {
    type: 'message',
    instance: 'talk-test',
    externalId: `BOT-EXT${seq}`,
    direction: 'in',
    phone: PHONE,
    lid: null,
    pushName: 'Maria Cliente',
    kind: 'text',
    body: `mensagem ${seq}`,
    hasMedia: false,
    mediaMime: null,
    mediaName: null,
    replyToExternalId: null,
    sentAt: new Date(Date.UTC(2026, 9, 14, 13, 0, seq % 60)),
    raw: { key: { id: `BOT-EXT${seq}` } },
    ...over,
  };
}

/** start_channel → ask_choice "menu" (1: Financeiro, no retries, no timeout) → send_message "Certo!". */
const menuGraph = (): BotGraph => ({
  nodes: [
    { id: 'n1', type: 'start_channel', name: 'inicio', position: { x: 0, y: 0 }, config: {} },
    {
      id: 'n2', type: 'ask_choice', name: 'menu', position: { x: 300, y: 0 },
      config: { text: 'Escolha uma opção:', options: [{ key: '1', label: 'Financeiro' }], invalidRetries: 0, timeoutHours: null },
    },
    { id: 'n3', type: 'send_message', name: 'ok', position: { x: 600, y: 0 }, config: { text: 'Certo!', attachment: null, signature: false } },
  ],
  edges: [
    { id: 'e1', source: 'n1', sourceHandle: 'next', target: 'n2' },
    { id: 'e2', source: 'n2', sourceHandle: 'opt:1', target: 'n3' },
  ],
});

/** Triage stubs only: the bot hooks stay the real ones (handleInbound merges the defaults). */
function triageStub() {
  const calls: string[] = [];
  const hooks: IngestHooks = {
    startTriage: async (_c, chat) => {
      calls.push(`triage:start:${chat.id}`);
    },
    handleTriageReply: async (_c, chat, text) => {
      calls.push(`triage:reply:${chat.id}:${text}`);
      return false;
    },
  };
  return { calls, hooks };
}

let ctx: Ctx;
let seed: Awaited<ReturnType<typeof seedBasics>>;
let triage: ReturnType<typeof triageStub>;

beforeEach(async () => {
  ctx = await makeTestCtx();
  seed = await seedBasics(ctx);
  triage = triageStub();
});

const ingest = (...events: InboundEvent[]) => handleInbound(ctx, events, triage.hooks);
const allRuns = () => ctx.db.select().from(botRuns);
const sentTexts = () => ctx.wa.sent.filter((s) => s.method === 'sendText').map((s) => (s.payload as { text: string }).text);

async function activeChannelBot(name = 'Recepção') {
  const bot = await createBot(ctx.db, {
    name, graph: menuGraph(), valid: true, publish: true, createdBy: null, startChannelIds: [seed.channelId],
  });
  await ctx.db.update(bots).set({ status: 'active' }).where(eq(bots.id, bot.id));
  return bot;
}

async function chatOf(phone: string) {
  const [row] = await ctx.db
    .select({ chat: chats })
    .from(chats)
    .innerJoin(contacts, eq(contacts.id, chats.contactId))
    .where(eq(contacts.phone, phone));
  return row!.chat;
}

describe('ingest and bots', () => {
  it('starts the channel bot instead of the triage when a contact opens a chat', async () => {
    const bot = await activeChannelBot();
    await ingest(msg({ body: 'Bom dia' }));

    const chat = await chatOf(PHONE);
    const runs = await allRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ botId: bot.id, chatId: chat.id, state: 'waiting_reply', startedBy: null, depth: 0 });
    expect(triage.calls).toEqual([]);
    expect(sentTexts()).toEqual([MENU_TEXT]);
    const [botMsg] = await ctx.db.select().from(messages).where(eq(messages.botRunId, runs[0]!.id));
    expect(botMsg).toMatchObject({ direction: 'out', authorId: null, body: MENU_TEXT });
  });

  it('runs the triage as before when no active bot starts on the channel', async () => {
    const paused = await createBot(ctx.db, {
      name: 'Pausado', graph: menuGraph(), valid: true, publish: true, createdBy: null, startChannelIds: [seed.channelId],
    });
    expect(paused.status).toBe('paused');

    await ingest(msg({ body: 'Bom dia' }));

    const chat = await chatOf(PHONE);
    expect(triage.calls).toEqual([`triage:start:${chat.id}`]);
    expect(await allRuns()).toEqual([]);
    expect(ctx.wa.sent).toEqual([]);
  });

  it('resumes the waiting run with the contact reply', async () => {
    await activeChannelBot();
    await ingest(msg({ body: 'Bom dia' }));
    await ingest(msg({ body: '1' }));

    const [run] = await allRuns();
    expect(run!.state).toBe('finished');
    expect(run!.vars.menu).toMatchObject({ raw: '1', value: '1', label: 'Financeiro' });
    expect(sentTexts()).toEqual([MENU_TEXT, 'Certo!']);
    expect(triage.calls).toEqual([]);
  });

  it('hands a reply to the triage first and then to the bots, as the stored message', async () => {
    const calls: string[] = [];
    const replies: InboundReply[] = [];
    const hooks: IngestHooks = {
      startTriage: async (_c, chat) => {
        calls.push(`triage:start:${chat.id}`);
      },
      handleTriageReply: async (_c, chat, text) => {
        calls.push(`triage:reply:${chat.id}:${text}`);
        return true;
      },
      startChannelBot: async (_c, chat) => {
        calls.push(`bot:start:${chat.id}`);
        return false; // no bot → the triage must start
      },
      resumeBotsOnReply: async (_c, chatId, reply) => {
        calls.push(`bot:resume:${chatId}`);
        replies.push(reply);
        return 0;
      },
    };

    await handleInbound(ctx, [msg({ body: 'Bom dia' })], hooks);
    const chat = await chatOf(PHONE);
    expect(calls).toEqual([`bot:start:${chat.id}`, `triage:start:${chat.id}`]);

    await ctx.db.update(chats).set({ triagePending: true }).where(eq(chats.id, chat.id));
    await handleInbound(ctx, [msg({ body: '2' })], hooks);
    expect(calls.slice(2)).toEqual([`triage:reply:${chat.id}:2`, `bot:resume:${chat.id}`]);

    const [stored] = await ctx.db.select().from(messages).where(and(eq(messages.chatId, chat.id), eq(messages.body, '2')));
    expect(replies).toEqual([
      { messageId: stored!.id, kind: 'text', body: '2', mediaMime: null, mediaName: null, createdAt: stored!.createdAt },
    ]);
  });

  it('outbound and echo messages neither start nor resume bots', async () => {
    await activeChannelBot();

    // The office phone writes first to a new contact: the chat opens, but no bot starts on an outbound message.
    await ingest(msg({ direction: 'out', phone: OTHER_PHONE, body: 'Olá, aqui é o escritório' }));
    expect(await allRuns()).toEqual([]);

    await ingest(msg({ body: 'Bom dia' }));
    const [run] = await allRuns();
    expect(run!.state).toBe('waiting_reply');
    const [menu] = await ctx.db.select().from(messages).where(eq(messages.botRunId, run!.id));
    const sentBefore = ctx.wa.sent.length;

    await ingest(
      msg({ direction: 'out', body: '1' }), // an agent types "1" on the office phone
      msg({ direction: 'out', externalId: menu!.externalId!, body: MENU_TEXT }), // the webhook echo of the bot's own menu
    );

    const after = await allRuns();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: run!.id, state: 'waiting_reply', currentNodeId: run!.currentNodeId });
    expect(after[0]!.steps).toEqual(run!.steps);
    expect(ctx.wa.sent.length).toBe(sentBefore);
    expect(triage.calls).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- test/bots/integration.test.ts`
Expected: FAIL. Ingest does not know the bot hooks yet:
- `starts the channel bot …` fails with `expected [] to have a length of 1`.
- `resumes the waiting run …` and `outbound and echo …` fail with `TypeError: Cannot read properties of undefined (reading 'state')`.
- `hands a reply …` fails because `calls` lacks `bot:start:…` and `bot:resume:…`.
- `runs the triage as before …` already passes. It is the regression guard for the triage fallback.

- [ ] **Step 3: Write minimal implementation**

Create `server/src/bots/hooks.ts`:

```ts
import { inArray } from 'drizzle-orm';
import type { BotAction } from '@talk/shared';
import { getBotRunningBehavior } from '../catalog/settings.js';
import type { AppCtx } from '../ctx.js';
import { bots } from '../db/schema.js';
import type { ChatRow } from '../inbox/chats.js';
import type { AuthUser } from '../inbox/visibility.js';
import { botRunningError } from '../lib/http-error.js';
import { resumeOnReply, runningRunsForChat, startRun, stopRunsForChat } from './engine.js';
import type { InboundReply } from './registry.js';
import { findChannelBot } from './repo.js';

const errName = (err: unknown) => (err instanceof Error ? err.name : typeof err);

/**
 * Spec §5.1 "Por canal": a chat just opened by an inbound message starts the oldest active published bot of
 * its channel. true = a bot took the chat, so the caller skips the triage. Never throws: a failed start
 * falls back to the triage, and the log gets ids and the error name only.
 */
export async function startChannelBot(ctx: AppCtx, chat: ChatRow): Promise<boolean> {
  const bot = await findChannelBot(ctx.db, chat.channelId);
  if (!bot) return false;
  try {
    await startRun(ctx, { botId: bot.id, chatId: chat.id, entry: 'channel', startedBy: null });
    return true;
  } catch (err) {
    console.error('channel bot start failed', { botId: bot.id, chatId: chat.id, err: errName(err) });
    return false;
  }
}

/** Spec §5.4: called by ingest after the reply is committed. Never throws, so one bad run cannot drop the rest of a webhook batch. */
export async function resumeBotsOnReply(ctx: AppCtx, chatId: string, reply: InboundReply): Promise<number> {
  try {
    return await resumeOnReply(ctx, chatId, reply);
  } catch (err) {
    console.error('bot resume failed', { chatId, messageId: reply.messageId, err: errName(err) });
    return 0;
  }
}

/**
 * Spec §5.5: what an agent action (send, manual transfer) does to the chat's running bots.
 * The caller has already checked that the user can see the chat (404 first, so a 409 never leaks bot names).
 */
export async function applyBotRunningBehavior(
  ctx: AppCtx,
  user: AuthUser,
  chatId: string,
  botAction: BotAction | undefined,
  reason: 'agent_message' | 'transfer',
): Promise<void> {
  const runs = await runningRunsForChat(ctx.db, chatId);
  if (runs.length === 0) return;
  const effective = botAction ?? (await getBotRunningBehavior(ctx.db));
  if (effective === 'keep') return;
  if (effective === 'stop') {
    await stopRunsForChat(ctx, chatId, { userId: user.id, reason });
    return;
  }
  const names = await ctx.db
    .select({ id: bots.id, name: bots.name })
    .from(bots)
    .where(inArray(bots.id, [...new Set(runs.map((r) => r.botId))]));
  const nameOf = new Map(names.map((b) => [b.id, b.name]));
  throw botRunningError(runs.map((r) => ({ id: r.id, botName: nameOf.get(r.botId) ?? 'Chatbot' })));
}
```

`hooks.ts` imports `botRunningError`, which Cycle 3 adds to `http-error.ts`. Add it now so this cycle compiles. Replace the whole of `server/src/lib/http-error.ts` with:

```ts
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Extra fields the error handler sends next to `error` (e.g. code, runs, problems). */
    public body?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (m = 'Requisição inválida') => new HttpError(400, m);
export const forbidden = (m = 'Sem permissão') => new HttpError(403, m);
export const notFound = (m = 'Não encontrado') => new HttpError(404, m);
export const conflict = (m = 'Conflito') => new HttpError(409, m);

/** Spec §5.5 `ask`: the composer and the transfer dialog show "Parar e enviar / Enviar e manter / Cancelar". */
export function botRunningError(runs: Array<{ id: string; botName: string }>): HttpError {
  return new HttpError(409, 'O chatbot está em execução nesta conversa', { code: 'BOT_RUNNING', runs });
}
```

Then edit `server/src/messages/ingest.ts`.

(a) Replace

```ts
import { findOrOpenChat, getDefaultSectorId, type ChatRow } from '../inbox/chats.js';
```

with

```ts
import { resumeBotsOnReply, startChannelBot } from '../bots/hooks.js';
import type { InboundReply } from '../bots/registry.js';
import { findOrOpenChat, getDefaultSectorId, type ChatRow } from '../inbox/chats.js';
```

(b) Replace

```ts
export interface IngestHooks {
  startTriage: typeof startTriage;
  handleTriageReply: typeof handleTriageReply;
}

const defaultHooks: IngestHooks = { startTriage, handleTriageReply };
```

with

```ts
/** Test seams. The bot hooks are optional so triage-only stubs keep compiling; a missing hook uses the real code. */
export interface IngestHooks {
  startTriage: typeof startTriage;
  handleTriageReply: typeof handleTriageReply;
  startChannelBot?: typeof startChannelBot;
  resumeBotsOnReply?: typeof resumeBotsOnReply;
}

const defaultHooks: Required<IngestHooks> = { startTriage, handleTriageReply, startChannelBot, resumeBotsOnReply };
```

(c) Replace

```ts
export async function handleInbound(ctx: AppCtx, events: InboundEvent[], hooks: IngestHooks = defaultHooks): Promise<void> {
  for (const ev of events) {
```

with

```ts
export async function handleInbound(ctx: AppCtx, events: InboundEvent[], hooks: IngestHooks = defaultHooks): Promise<void> {
  const h: Required<IngestHooks> = { ...defaultHooks, ...hooks };
  for (const ev of events) {
```

and in the same function replace

```ts
    else await ingestMessage(ctx, channel.id, ev, hooks);
```

with

```ts
    else await ingestMessage(ctx, channel.id, ev, h);
```

(d) Replace

```ts
async function ingestMessage(ctx: AppCtx, channelId: string, ev: MessageEvent, hooks: IngestHooks): Promise<void> {
  const inbound = ev.direction === 'in';
  let stored: { messageId: string; chat: ChatRow; created: boolean };
```

with

```ts
async function ingestMessage(ctx: AppCtx, channelId: string, ev: MessageEvent, hooks: Required<IngestHooks>): Promise<void> {
  const inbound = ev.direction === 'in';
  let stored: { messageId: string; createdAt: Date; chat: ChatRow; created: boolean };
```

(e) Replace

```ts
        .returning({ id: messages.id });
      if (!inserted) throw new Skip(); // a concurrent copy of this webhook won the race
```

with

```ts
        .returning({ id: messages.id, createdAt: messages.createdAt });
      if (!inserted) throw new Skip(); // a concurrent copy of this webhook won the race
```

(f) Replace

```ts
      return { messageId: inserted.id, chat: updated, created };
```

with

```ts
      return { messageId: inserted.id, createdAt: inserted.createdAt, chat: updated, created };
```

(g) Replace the hook block at the end of `ingestMessage`

```ts
  if (inbound) {
    if (stored.created) await hooks.startTriage(ctx, stored.chat);
    else if (stored.chat.triagePending) await hooks.handleTriageReply(ctx, stored.chat, ev.body);
  }
}
```

with

```ts
  // Outbound messages (office phone, agents' phones, webhook echoes) never reach the triage or the bots (Review Focus 5).
  if (inbound) {
    if (stored.created) {
      // Spec §5.1: a channel bot has priority; the triage runs only when no bot took the new chat.
      if (!(await hooks.startChannelBot(ctx, stored.chat))) await hooks.startTriage(ctx, stored.chat);
    } else {
      if (stored.chat.triagePending) await hooks.handleTriageReply(ctx, stored.chat, ev.body);
      const reply: InboundReply = {
        messageId: stored.messageId,
        kind: ev.kind,
        body: ev.body,
        mediaMime: ev.mediaMime,
        mediaName: ev.mediaName,
        createdAt: stored.createdAt, // compared with bot_runs.waiting_since by resumeOnReply (Review Focus 1)
      };
      await hooks.resumeBotsOnReply(ctx, stored.chat.id, reply);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w server -- test/bots/integration.test.ts test/messages/ingest.test.ts test/contacts/avatar.test.ts test/triage`
Expected: PASS. The existing ingest, avatar and triage tests pass unchanged. Their stubs omit the bot hooks, so the real ones run, find no bot and no run, and do nothing.

Run: `npm run typecheck -w server`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add server/src/bots/hooks.ts server/src/lib/http-error.ts server/src/messages/ingest.ts server/test/bots/integration.test.ts
git commit -m "feat(server): start channel bots before triage and resume them on replies

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

#### Cycle 3: agent sends, manual transfer and close

- [ ] **Step 1: Write the failing test**

In `server/test/bots/integration.test.ts`, replace the whole import block (the first nine lines) with:

```ts
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BotGraph } from '@talk/shared';
import type { InboundReply } from '../../src/bots/registry.js';
import { createBot } from '../../src/bots/repo.js';
import { botRuns, bots, chats, contacts, messages, settings } from '../../src/db/schema.js';
import { handleInbound, type IngestHooks } from '../../src/messages/ingest.js';
import type { InboundEvent } from '../../src/whatsapp/types.js';
import { enableSeeAll, loginAs, makeTestApp, makeTestCtx, seedBasics } from '../helpers.js';
import { eventsOf } from '../inbox/fixtures.js';
```

Then append at the end of the file:

```ts
function multipart(fields: Record<string, string>, file: { name: string; mime: string; data: Buffer }) {
  const boundary = '----talkbotboundary';
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  chunks.push(
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.mime}\r\n\r\n`),
    file.data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return { payload: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

describe('agents and running bots (bot_running_behavior)', () => {
  let app: FastifyInstance;
  let admin: Record<string, string>;
  let chatId: string;
  let runId: string;

  beforeEach(async () => {
    await enableSeeAll(ctx, seed.admin); // the chat sits in the default sector, which no seeded agent belongs to
    await activeChannelBot();
    await ingest(msg({ body: 'Bom dia' }));
    chatId = (await chatOf(PHONE)).id;
    runId = (await allRuns())[0]!.id;
    ({ app } = await makeTestApp(ctx));
    admin = (await loginAs(app, seed.admin.email)).headers;
  });

  afterEach(async () => {
    await app.close();
  });

  const post = (path: string, payload: object, headers = admin) =>
    app.inject({ method: 'POST', url: `/api/chats/${chatId}/${path}`, headers, payload });
  const runState = async () =>
    (await ctx.db.select({ state: botRuns.state }).from(botRuns).where(eq(botRuns.id, runId)))[0]!.state;
  const stops = async () => (await eventsOf(ctx, chatId)).filter((e) => e.kind === 'bot_stopped');
  const agentMessages = () =>
    ctx.db.select().from(messages).where(and(eq(messages.chatId, chatId), eq(messages.authorId, seed.admin.id)));
  const botRunning = () => ({
    error: 'O chatbot está em execução nesta conversa',
    code: 'BOT_RUNNING',
    runs: [{ id: runId, botName: 'Recepção' }],
  });
  async function setBehavior(value: 'ask' | 'stop' | 'keep') {
    await ctx.db
      .insert(settings)
      .values({ key: 'bot_running_behavior', value })
      .onConflictDoUpdate({ target: settings.key, set: { value } });
  }

  it('asks with 409 BOT_RUNNING by default and sends nothing until botAction comes', async () => {
    const asked = await post('messages', { text: 'Olá, sou a atendente' });
    expect(asked.statusCode).toBe(409);
    expect(asked.json()).toEqual(botRunning());
    expect(await agentMessages()).toHaveLength(0);
    expect(sentTexts()).toEqual([MENU_TEXT]);
    expect(await runState()).toBe('waiting_reply');

    const kept = await post('messages', { text: 'Olá, sou a atendente', botAction: 'keep' });
    expect(kept.statusCode).toBe(200);
    expect(await agentMessages()).toHaveLength(1);
    expect(await runState()).toBe('waiting_reply');
    expect(await stops()).toEqual([]);
  });

  it('botAction stop stops the run as the agent, then sends', async () => {
    const res = await post('messages', { text: 'Assumo daqui', botAction: 'stop' });
    expect(res.statusCode).toBe(200);
    expect(await runState()).toBe('stopped');
    expect(await stops()).toMatchObject([
      { authorId: seed.admin.id, data: { reason: 'agent_message', runId, botName: 'Recepção' } },
    ]);
    expect(sentTexts().at(-1)).toContain('Assumo daqui');

    // No run left: the next send goes straight through, even under 'ask'.
    expect((await post('messages', { text: 'Mais uma' })).statusCode).toBe(200);
  });

  it('the keep and stop settings decide without asking', async () => {
    await setBehavior('keep');
    expect((await post('messages', { text: 'Primeira' })).statusCode).toBe(200);
    expect(await runState()).toBe('waiting_reply');

    await setBehavior('stop');
    expect((await post('messages', { text: 'Segunda' })).statusCode).toBe(200);
    expect(await runState()).toBe('stopped');
    expect(await stops()).toMatchObject([{ authorId: seed.admin.id, data: { reason: 'agent_message' } }]);
  });

  it('a multipart send carries botAction', async () => {
    const file = { name: 'doc.pdf', mime: 'application/pdf', data: Buffer.from('%PDF-1.4 teste') };
    const upload = (fields: Record<string, string>) => {
      const { payload, contentType } = multipart(fields, file);
      return app.inject({
        method: 'POST', url: `/api/chats/${chatId}/messages`, headers: { ...admin, 'content-type': contentType }, payload,
      });
    };

    const asked = await upload({ signature: 'false' });
    expect(asked.statusCode).toBe(409);
    expect(asked.json().code).toBe('BOT_RUNNING');

    const stopped = await upload({ signature: 'false', botAction: 'stop' });
    expect(stopped.statusCode).toBe(200);
    expect(await runState()).toBe('stopped');
    expect(ctx.wa.sent.filter((s) => s.method === 'sendMedia')).toHaveLength(1);
  });

  it('internal notes never touch the bot', async () => {
    const res = await post('notes', { text: 'Cliente ligou antes' });
    expect(res.statusCode).toBe(200);
    expect(await runState()).toBe('waiting_reply');
  });

  it('a user who cannot see the chat gets 404, never the bot names', async () => {
    const ana = (await loginAs(app, seed.agentA.email)).headers; // sector Financeiro; the chat is in Atendimento
    expect((await post('messages', { text: 'Oi' }, ana)).statusCode).toBe(404);
    expect((await post('transfer', { sectorId: seed.sectorA }, ana)).statusCode).toBe(404);
    expect(await runState()).toBe('waiting_reply');
  });

  it('a manual transfer follows the setting: ask answers 409, then keep or stop', async () => {
    const asked = await post('transfer', { sectorId: seed.sectorA });
    expect(asked.statusCode).toBe(409);
    expect(asked.json()).toEqual(botRunning());
    const [still] = await ctx.db.select().from(chats).where(eq(chats.id, chatId));
    expect(still!.sectorId).toBe(seed.defaultSector);

    const kept = await post('transfer', { sectorId: seed.sectorA, botAction: 'keep' });
    expect(kept.statusCode).toBe(200);
    expect(kept.json().sectorId).toBe(seed.sectorA);
    expect(await runState()).toBe('waiting_reply');

    const stopped = await post('transfer', { sectorId: seed.sectorB, botAction: 'stop' });
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json().sectorId).toBe(seed.sectorB);
    expect(await runState()).toBe('stopped');
    expect(await stops()).toMatchObject([{ authorId: seed.admin.id, data: { reason: 'transfer', runId } }]);
  });

  it('closing the chat stops its bots without asking, also when the closing message is sent', async () => {
    await ctx.db.insert(settings).values({ key: 'closing_message', value: 'Atendimento finalizado.' });

    const res = await post('close', { sendClosingMessage: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBe('closed');
    expect(sentTexts().at(-1)).toBe('Atendimento finalizado.');
    expect(await runState()).toBe('stopped');
    expect(await stops()).toMatchObject([{ authorId: seed.admin.id, data: { reason: 'chat_closed', runId } }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- test/bots/integration.test.ts`
Expected: FAIL. The five `ingest and bots` tests still pass.
- `asks with 409 …` gets status 200 instead of 409.
- `botAction stop …` and `the keep and stop settings …` find the run still `waiting_reply`. The route's zod strips the unknown `botAction`, and nothing consults the setting.
- `a multipart send …` gets 200 instead of 409.
- `a manual transfer …` gets 200 instead of 409.
- `closing the chat …` finds the run still `waiting_reply`.
- `internal notes …` and `a user who cannot see …` already pass. They are regression guards.

- [ ] **Step 3: Write minimal implementation**

In `server/src/app.ts`, replace

```ts
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
```

with

```ts
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message, ...err.body });
```

In `server/src/messages/send.ts`:

(a) Replace

```ts
import type { AppCtx } from '../ctx.js';
```

with

```ts
import type { BotAction } from '@talk/shared';
import { applyBotRunningBehavior } from '../bots/hooks.js';
import type { AppCtx } from '../ctx.js';
```

(b) Replace, in `interface SendInput`,

```ts
  signature: boolean;
  replyToId?: string;
}
```

with

```ts
  signature: boolean;
  replyToId?: string;
  /** Spec §5.5: the agent's answer to BOT_RUNNING; absent = settings.bot_running_behavior decides. */
  botAction?: BotAction;
}
```

(c) In `sendAgentMessage`, replace

```ts
    if (!orig) throw badRequest('Mensagem citada não encontrada');
    replyToId = orig.id;
  }
```

with

```ts
    if (!orig) throw badRequest('Mensagem citada não encontrada');
    replyToId = orig.id;
  }

  // Spec §5.5, after input validation and before anything is saved or sent: 'ask' → 409 BOT_RUNNING, 'stop' stops the bots.
  await applyBotRunningBehavior(ctx, user, chatId, input.botAction, 'agent_message');
```

`addNote` and `resendMessage` stay as they are. Notes never affect the bot, and a resend repeats a message that was already decided.

Replace the whole of `server/src/chats/routes.ts` with:

```ts
import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { stopRunsForChat } from '../bots/engine.js';
import { applyBotRunningBehavior } from '../bots/hooks.js';
import type { AppCtx } from '../ctx.js';
import {
  assumeChat, closeChat, getChatForUser, markChatRead, pinChat, reopenChat, setChatPrivacy, startChat, transferChat,
  type ChatRow,
} from '../inbox/chats.js';
import { getChatDetail, getTimeline, listChats, toChatDetail } from '../inbox/queries.js';
import type { AuthUser } from '../inbox/visibility.js';
import { HttpError, badRequest } from '../lib/http-error.js';
import { addNote, resendMessage, sendAgentMessage, type SendInput } from '../messages/send.js';

const MAX_FILE_BYTES = 64 * 1024 * 1024;

const idParams = z.object({ id: z.uuid() });
const listQuery = z.object({
  tab: z.enum(['inbox', 'waiting', 'closed']).default('inbox'),
  q: z.string().max(100).optional(),
  sectorId: z.uuid().optional(),
  ownerId: z.union([z.literal('none'), z.uuid()]).optional(),
  tagId: z.uuid().optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
const timelineQuery = z.object({
  before: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
const startBody = z
  .object({
    contactId: z.uuid().optional(),
    phone: z.string().trim().min(8).max(30).optional(),
    name: z.string().trim().max(120).optional(),
    sectorId: z.uuid().optional(),
  })
  .refine((b) => b.contactId !== undefined || b.phone !== undefined, 'Informe o contato ou o telefone');
/** Spec §5.5: the answer to a BOT_RUNNING 409, sent back with the retried request. */
const botActionField = z.enum(['stop', 'keep']).optional();
const transferBody = z
  .object({ sectorId: z.uuid().optional(), ownerId: z.uuid().nullable().optional(), botAction: botActionField })
  .refine((b) => b.sectorId !== undefined || b.ownerId !== undefined, 'Informe o setor ou o atendente');
const privacyBody = z.object({ private: z.boolean() });
const closeBody = z.object({ sendClosingMessage: z.boolean().default(false) });
const textBody = z.object({
  text: z.string().trim().min(1).max(4096),
  signature: z.boolean().default(true),
  replyToId: z.uuid().optional(),
  botAction: botActionField,
});
const multipartFields = z.object({
  text: z.string().trim().max(4096).optional(),
  signature: z.stringbool().default(true),
  asVoice: z.stringbool().default(false),
  replyToId: z.uuid().optional(),
  botAction: botActionField,
});
const noteBody = z.object({ text: z.string().trim().min(1).max(4096) });

async function readMultipart(req: FastifyRequest): Promise<SendInput> {
  const fields: Record<string, string> = {};
  let file: SendInput['file'];
  try {
    for await (const part of req.parts({ limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 10 } })) {
      if (part.type === 'file') {
        file = { buffer: await part.toBuffer(), mime: part.mimetype, name: part.filename || 'arquivo' };
      } else {
        fields[part.fieldname] = String(part.value);
      }
    }
  } catch (err) {
    // @fastify/multipart limit errors carry statusCode 413; map them to our Portuguese message.
    if ((err as { statusCode?: number }).statusCode === 413) {
      throw new HttpError(413, 'Envie um único arquivo de até 64 MB');
    }
    throw err;
  }
  if (!file) throw badRequest('Arquivo ausente');
  const f = multipartFields.parse(fields);
  return {
    file, text: f.text || undefined, signature: f.signature, asVoice: f.asVoice, replyToId: f.replyToId, botAction: f.botAction,
  };
}

export async function chatRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  await app.register(async (r) => {
    // buildApp registers multipart at the root; this only covers a bare app. Scoped so a second registration cannot clash.
    if (!r.hasContentTypeParser('multipart/form-data')) await r.register(multipart);

    r.get('/api/chats', async (req) => listChats(ctx, req.user, listQuery.parse(req.query)));

    r.post('/api/chats', async (req) => {
      const chat = await startChat(ctx, req.user, startBody.parse(req.body));
      return toChatDetail(ctx.db, chat, req.user.id);
    });

    r.get('/api/chats/:id', async (req) => getChatDetail(ctx, req.user, idParams.parse(req.params).id));

    r.get('/api/chats/:id/timeline', async (req) => {
      const { id } = idParams.parse(req.params);
      return getTimeline(ctx, req.user, id, timelineQuery.parse(req.query));
    });

    // The detail is built from the row the service returned, without a second visibility check:
    // after a transfer the caller may no longer see the chat but still gets its new state.
    const action = (path: string, run: (user: AuthUser, id: string, body: unknown) => Promise<ChatRow>) =>
      r.post(`/api/chats/:id/${path}`, async (req) => {
        const { id } = idParams.parse(req.params);
        return toChatDetail(ctx.db, await run(req.user, id, req.body), req.user.id);
      });

    action('assume', (user, id) => assumeChat(ctx, user, id));
    action('reopen', (user, id) => reopenChat(ctx, user, id));
    action('transfer', async (user, id, body) => {
      const { botAction, ...to } = transferBody.parse(body);
      await getChatForUser(ctx, user, id); // 404 before a 409 could reveal bot names
      // ponytail: 'stop' runs before transferChat validates the destination, so a transfer that then fails (400/409)
      // has still stopped the bot; split the ask check from the stop if that ever matters.
      await applyBotRunningBehavior(ctx, user, id, botAction, 'transfer');
      return transferChat(ctx, user, id, to);
    });
    action('privacy', (user, id, body) => setChatPrivacy(ctx, user, id, privacyBody.parse(body).private));
    action('close', async (user, id, body) => {
      const closed = await closeChat(ctx, user, id, {
        sendClosingMessage: closeBody.parse(body ?? {}).sendClosingMessage,
        // Closing text is the office's canned message, so it goes without the agent signature.
        // botAction 'keep': closing never asks, the runs are stopped right below.
        sendClosing: async (text: string) =>
          (await sendAgentMessage(ctx, user, id, { text, signature: false, botAction: 'keep' })).status !== 'failed',
      });
      // Spec §5.5: closing the chat stops every bot run in it.
      await stopRunsForChat(ctx, id, { userId: user.id, reason: 'chat_closed' });
      return closed;
    });

    r.post('/api/chats/:id/read', async (req, reply) => {
      await markChatRead(ctx, req.user, idParams.parse(req.params).id);
      return reply.code(204).send();
    });

    r.put('/api/chats/:id/pin', async (req, reply) => {
      await pinChat(ctx, req.user, idParams.parse(req.params).id, true);
      return reply.code(204).send();
    });

    r.delete('/api/chats/:id/pin', async (req, reply) => {
      await pinChat(ctx, req.user, idParams.parse(req.params).id, false);
      return reply.code(204).send();
    });

    r.post('/api/chats/:id/messages', async (req) => {
      const { id } = idParams.parse(req.params);
      const input: SendInput = req.isMultipart() ? await readMultipart(req) : textBody.parse(req.body);
      return sendAgentMessage(ctx, req.user, id, input);
    });

    r.post('/api/chats/:id/notes', async (req) => {
      const { id } = idParams.parse(req.params);
      return addNote(ctx, req.user, id, noteBody.parse(req.body).text);
    });

    r.post('/api/messages/:id/resend', async (req) =>
      resendMessage(ctx, req.user, idParams.parse(req.params).id),
    );
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w server -- test/bots/integration.test.ts test/chats test/messages test/catalog/settings.test.ts test/app.test.ts`
Expected: PASS. This includes the existing `chat action routes` tests: `transfer` with `{}` is still 400 from the refine, `transfer` by a user who cannot see the chat is still 404, and closing with the closing message still sends it.

Run: `npm test -w server`
Expected: PASS (the whole server suite).

Run: `npm run typecheck`
Expected: exit 0 for `shared`, `server` and `web`.

- [ ] **Step 5: Commit**

```bash
git add server/src/app.ts server/src/messages/send.ts server/src/chats/routes.ts server/test/bots/integration.test.ts
git commit -m "feat(server): bot_running_behavior on agent sends, manual transfers and close

POST /api/chats/:id/messages and /transfer answer 409 BOT_RUNNING under 'ask'
unless botAction is sent; 'stop' stops the runs as the agent; closing stops them.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


---

### Task 11: Bot REST API

**Files:**
- Modify: `server/src/messages/media.ts` (`saveMedia` gains an optional `subdir`)
- Create: `server/src/bots/routes.ts` (`registerBotRoutes`, every route of spec §6 / contract §3.10 except `from-template`, which Task 12 adds)
- Modify: `server/src/app.ts` (import and register `registerBotRoutes` right after `registerChannelRoutes`)
- Test: `server/test/messages/media.test.ts` (one new `describe`)
- Test: `server/test/bots/routes.test.ts` (create)

**Interfaces:**
- Consumes:
  - Task 1 (`@talk/shared`): `BLOCK_TYPES`, `NON_TERMINAL_RUN_STATES`, types `BotGraph`, `BotExport`, `BotMediaDto`, `BotVersionDto`, `ManualBotDto`, `BotDto`.
  - Task 2 (`server/src/bots/repo.ts`):
    `toBotDto(db, row): Promise<BotDto>`, `toBotDtos(db, rows): Promise<BotDto[]>`,
    `toBotVersionSummaries(db, bot: BotRow): Promise<BotVersionSummaryDto[]>`, `toBotRunDto(db, row: BotRunRow): Promise<BotRunDto>`,
    `getBot(db, id): Promise<BotRow>` (404 'Chatbot não encontrado'), `getVersionRow(db, versionId): Promise<BotVersionRow | null>`,
    `getVersionByNumber(db, botId, n): Promise<BotVersionRow>` (404), `latestVersion(db, botId): Promise<BotVersionRow>`,
    `insertBotVersion(db, { botId, graph, valid, createdBy, label? }): Promise<BotVersionRow>`,
    `createBot(db: Db, { name, description?, graph, valid, publish, createdBy, startChannelIds?, manualStart?, manualTitle? }): Promise<BotRow>`,
    `uniqueBotName(db, base): Promise<string>`, `STARTER_GRAPH: () => BotGraph`, types `BotRow`, `BotVersionRow`; tables `bots`, `botRuns` in `db/schema.ts`.
  - Task 3 (`server/src/bots/graph.ts`): `loadGraphCatalog(db, selfBotId: string | null): Promise<GraphCatalog>`, `validateGraph(graph, catalog): GraphProblem[]` (problem `{ nodeId: null, message: 'O fluxo precisa de um bloco de início' }` when there is no start node).
  - Task 5 (`server/src/bots/engine.ts`): `startRun(ctx, { botId, chatId, entry: 'manual', startedBy }): Promise<BotRunRow>` (throws `conflict` on a duplicate run), `stopRun(ctx, runId, { userId, reason: 'manual' }): Promise<BotRunRow>`, `runningRunsForChat(db, chatId): Promise<BotRunRow[]>`.
  - Task 10 (`server/src/lib/http-error.ts`): `new HttpError(status, message, body?: Record<string, unknown>)`; the `app.ts` error handler sends `{ error: message, ...body }`.
  - Existing: `requireAdmin(req)` (`auth/plugin.ts`), `getChatForUser(ctx, user, chatId)` (`inbox/chats.ts`, 404 unless `canSee`), `baseMime(mime)` (`messages/media.ts`), test helpers `makeTestCtx`, `makeTestApp`, `seedBasics`, `loginAs`, `insertChat` (`test/inbox/fixtures.ts`).
- Produces:
  - `saveMedia(mediaDir: string, data: Buffer, mime: string, originalName?: string | null, subdir?: string): Promise<{ path: string; size: number }>`; with `subdir`, the file lands at `<subdir>/<uuid>.<ext>` instead of `YYYY/MM/<uuid>.<ext>`.
  - `export function registerBotRoutes(app: FastifyInstance, ctx: AppCtx): void` in `server/src/bots/routes.ts`.
  - `export const GraphSchema` (zod, exactly as in contract §3.10) in `server/src/bots/routes.ts`. Task 12 adds `POST /api/bots/from-template` inside `registerBotRoutes`, reusing `Name`, `TemplateDest` and `TemplateBody` (Task 12 declares the last two itself).
  - HTTP routes (all JSON; mutations need `Origin`, already enforced by `authPlugin`):
    - admin (`preHandler: requireAdmin`, 403 otherwise): `GET/POST /api/bots`, `GET/PATCH/DELETE /api/bots/:id`, `POST /api/bots/:id/duplicate`, `GET /api/bots/:id/versions`, `GET /api/bots/:id/versions/:n`, `POST /api/bots/:id/versions`, `POST /api/bots/:id/status`, `POST /api/bots/import`, `GET /api/bots/:id/export`, `POST /api/bots/media`.
    - any user: `GET /api/bots/manual`, and the chat-scoped `POST/GET /api/chats/:id/bot-runs` and `POST /api/bot-runs/:id/stop` (404 unless the user `canSee` the chat).
  - Error bodies the web relies on (Task 13/14): 400 `{ error: 'O fluxo tem problemas', problems: GraphProblem[] }`; 409 `{ error: 'Este chatbot é acionado por outros fluxos', usedBy: Array<{ id: string; name: string }> }`.

Decisions this task makes (not spelled out in the contract):
- A single `BotVersionDto` is built in `routes.ts` (`toVersionDto`) from `toBotVersionSummaries` plus `validateGraph(graph, loadGraphCatalog(db, bot.id))`, so `problems` is always recomputed on read.
- Duplicate and import validate with `selfBotId = null` (the new bot has no id yet; a `call_flow` to the original bot is legal in the copy).
- `createBot` has no `manualUnlisted` input, so duplicate copies that flag with one follow-up `UPDATE`.
- Saving any version bumps `bots.updated_at` (the list shows "atualizado em"). A refused publish still saves the draft, as spec §9 requires.
- A missing `botId` on a manual start answers the same 400 as a non-startable bot, never 404, so it does not leak which bot ids exist.
- The start route re-reads the run after `startRun`, so the DTO shows the state after the first step (`waiting_reply`, `finished`…).

---

- [ ] **Step 1: Write the failing test for `saveMedia` with a subdir**

In `server/test/messages/media.test.ts`, insert this block immediately **before** the line `describe('mediaResponseHeaders', () => {` (the file already imports `mkdtemp`, `readFile`, `tmpdir`, `join`, `saveMedia` and defines `UUID`):

```ts
describe('saveMedia subdir', () => {
  it('stores under the given subdir instead of YYYY/MM', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'talk-media-'));
    const r = await saveMedia(dir, Buffer.from('%PDF'), 'application/pdf', 'Contrato.pdf', 'bots');
    expect(r.path).toMatch(new RegExp(`^bots/${UUID}\\.pdf$`));
    expect(r.size).toBe(4);
    expect(await readFile(join(dir, r.path), 'utf8')).toBe('%PDF');
  });
});

```

- [ ] **Step 2: Run it and see it fail**

Run: `npm test -w server -- test/messages/media.test.ts`
Expected: FAIL in `saveMedia subdir`: `expected '2026/10/<uuid>.pdf' to match /^bots\/…\.pdf$/` (the fifth argument is ignored today).

- [ ] **Step 3: Add the `subdir` parameter**

In `server/src/messages/media.ts`, replace:

```ts
/** Writes media to `<mediaDir>/YYYY/MM/<uuid>.<ext>`; the original name never becomes part of the path. */
export async function saveMedia(
  mediaDir: string,
  data: Buffer,
  mime: string,
  originalName?: string | null,
): Promise<{ path: string; size: number }> {
  const now = new Date();
  const folder = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
```

with:

```ts
/**
 * Writes media to `<mediaDir>/YYYY/MM/<uuid>.<ext>`, or `<mediaDir>/<subdir>/<uuid>.<ext>` when `subdir` is given
 * (the bot media library uses 'bots'). `subdir` is a constant from code, never user input; the original name
 * never becomes part of the path.
 */
export async function saveMedia(
  mediaDir: string,
  data: Buffer,
  mime: string,
  originalName?: string | null,
  subdir?: string,
): Promise<{ path: string; size: number }> {
  const now = new Date();
  const folder = subdir ?? `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
```

- [ ] **Step 4: Run it and see it pass**

Run: `npm test -w server -- test/messages/media.test.ts`
Expected: PASS (all `saveMedia` and `mediaResponseHeaders` tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/messages/media.ts server/test/messages/media.test.ts
git commit -m "feat(server): saveMedia accepts a fixed subdir for the bot media library" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Write the failing admin route tests**

Create `server/test/bots/routes.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BotDto, BotGraph } from '@talk/shared';
import { latestVersion } from '../../src/bots/repo.js';
import { botRuns, chats } from '../../src/db/schema.js';
import { insertChat } from '../inbox/fixtures.js';
import { loginAs, makeTestApp, makeTestCtx, seedBasics } from '../helpers.js';

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

let app: FastifyInstance;
let ctx: Awaited<ReturnType<typeof makeTestCtx>>;
let seed: Awaited<ReturnType<typeof seedBasics>>;
let admin: Record<string, string>;
let agentA: Record<string, string>;
let agentB: Record<string, string>;

beforeEach(async () => {
  ctx = await makeTestCtx();
  seed = await seedBasics(ctx);
  ({ app } = await makeTestApp(ctx));
  admin = (await loginAs(app, seed.admin.email)).headers;
  agentA = (await loginAs(app, seed.agentA.email)).headers;
  agentB = (await loginAs(app, seed.agentB.email)).headers;
});

afterEach(async () => {
  await app.close();
});

function call(method: Method, url: string, headers: Record<string, string>, payload?: object) {
  return app.inject({ method, url, headers, payload });
}

/** start_manual → ask_choice: a run started from it stops at waiting_reply. */
const manualGraph = (): BotGraph => ({
  nodes: [
    { id: 'n1', type: 'start_manual', name: 'inicio', position: { x: 0, y: 0 }, config: {} },
    {
      id: 'n2', type: 'ask_choice', name: 'menu', position: { x: 300, y: 0 },
      config: { text: 'Escolha uma opção', options: [{ key: '1', label: 'Atendimento' }], invalidRetries: 1, timeoutHours: null },
    },
  ],
  edges: [{ id: 'e1', source: 'n1', sourceHandle: 'next', target: 'n2' }],
});

const callerGraph = (botId: string): BotGraph => ({
  nodes: [
    { id: 'n1', type: 'start_manual', name: 'inicio', position: { x: 0, y: 0 }, config: {} },
    { id: 'n2', type: 'call_flow', name: 'fluxo', position: { x: 300, y: 0 }, config: { botId, continueAfter: false } },
  ],
  edges: [{ id: 'e1', source: 'n1', sourceHandle: 'next', target: 'n2' }],
});

const noStartGraph = (): BotGraph => ({
  nodes: [{ id: 'n1', type: 'note', name: 'nota', position: { x: 0, y: 0 }, config: { text: 'x' } }],
  edges: [],
});

async function newBot(name: string): Promise<BotDto> {
  const res = await call('POST', '/api/bots', admin, { name });
  expect(res.statusCode).toBe(200);
  return res.json();
}

async function saveVersion(botId: string, graph: BotGraph, publish: boolean) {
  return call('POST', `/api/bots/${botId}/versions`, admin, { graph, publish });
}

/** Active, published, manual-start bot built from manualGraph(). */
async function publishManual(name: string): Promise<BotDto> {
  const bot = await newBot(name);
  expect((await saveVersion(bot.id, manualGraph(), true)).statusCode).toBe(200);
  expect((await call('PATCH', `/api/bots/${bot.id}`, admin, { manualStart: true })).statusCode).toBe(200);
  const res = await call('POST', `/api/bots/${bot.id}/status`, admin, { status: 'active' });
  expect(res.statusCode).toBe(200);
  return res.json();
}

function pngUpload(): { payload: Buffer; headers: Record<string, string> } {
  const boundary = '----talkbotmediaboundary';
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="logo.png"\r\nContent-Type: image/png\r\n\r\n`),
    Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

describe('admin bot routes', () => {
  it('lets only admins manage bots', async () => {
    expect((await call('GET', '/api/bots', agentA)).statusCode).toBe(403);
    expect((await call('POST', '/api/bots', agentA, { name: 'X' })).statusCode).toBe(403);
    const bot = await newBot('X');
    expect((await call('GET', `/api/bots/${bot.id}`, agentA)).statusCode).toBe(403);
    expect((await call('PATCH', `/api/bots/${bot.id}`, agentA, { name: 'Y' })).statusCode).toBe(403);
    expect((await call('DELETE', `/api/bots/${bot.id}`, agentA)).statusCode).toBe(403);
    expect((await call('GET', `/api/bots/${bot.id}/versions`, agentA)).statusCode).toBe(403);
    expect((await call('POST', `/api/bots/${bot.id}/versions`, agentA, { graph: manualGraph(), publish: false })).statusCode).toBe(403);
    expect((await call('GET', `/api/bots/${bot.id}/export`, agentA)).statusCode).toBe(403);
  });

  it('creates a paused bot whose version 1 is the starter graph', async () => {
    const res = await call('POST', '/api/bots', admin, { name: 'Boas-vindas', description: 'Primeiro' });
    expect(res.statusCode).toBe(200);
    const bot: BotDto = res.json();
    expect(bot).toMatchObject({
      name: 'Boas-vindas', description: 'Primeiro', status: 'paused', publishedVersionId: null,
      publishedVersionNumber: null, latestVersionNumber: 1, runCount: 0, activeRunCount: 0,
    });

    const dup = await call('POST', '/api/bots', admin, { name: 'Boas-vindas' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe('Já existe um chatbot com esse nome');
    expect((await call('POST', '/api/bots', admin, { name: '   ' })).statusCode).toBe(400);

    await newBot('Abertura');
    expect((await call('GET', '/api/bots', admin)).json().map((b: BotDto) => b.name)).toEqual(['Abertura', 'Boas-vindas']);

    const v1 = (await call('GET', `/api/bots/${bot.id}/versions/1`, admin)).json();
    expect(v1).toMatchObject({ botId: bot.id, number: 1, published: false, createdByName: 'Admin Teste' });
    expect(v1.graph.nodes.map((n: { type: string }) => n.type)).toEqual(['start_channel', 'send_message']);

    expect((await call('GET', `/api/bots/${bot.id}`, admin)).json().id).toBe(bot.id);
    expect((await call('GET', `/api/bots/${randomUUID()}`, admin)).statusCode).toBe(404);
  });

  it('saves an invalid draft but refuses to publish it, then publishes a valid version', async () => {
    const bot = await newBot('Fluxo');

    const refused = await saveVersion(bot.id, noStartGraph(), true);
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toBe('O fluxo tem problemas');
    expect(refused.json().problems).toContainEqual({ nodeId: null, message: 'O fluxo precisa de um bloco de início' });

    const list = (await call('GET', `/api/bots/${bot.id}/versions`, admin)).json();
    expect(list.map((v: { number: number }) => v.number)).toEqual([2, 1]);
    expect(list[0]).toMatchObject({ number: 2, valid: false, published: false });
    expect((await call('GET', `/api/bots/${bot.id}`, admin)).json()).toMatchObject({ publishedVersionId: null, latestVersionNumber: 2 });

    const ok = await call('POST', `/api/bots/${bot.id}/versions`, admin, { graph: manualGraph(), label: 'Primeira', publish: true });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ number: 3, valid: true, published: true, label: 'Primeira', problems: [], createdByName: 'Admin Teste' });
    expect((await call('GET', `/api/bots/${bot.id}`, admin)).json().publishedVersionNumber).toBe(3);

    const draft = await saveVersion(bot.id, noStartGraph(), false);
    expect(draft.statusCode).toBe(200);
    expect(draft.json()).toMatchObject({ number: 4, valid: false, published: false });
    expect(draft.json().problems.length).toBeGreaterThan(0);
    expect((await call('GET', `/api/bots/${bot.id}`, admin)).json()).toMatchObject({ publishedVersionNumber: 3, latestVersionNumber: 4 });

    const v3 = (await call('GET', `/api/bots/${bot.id}/versions/3`, admin)).json();
    expect(v3.graph).toEqual(manualGraph());
    expect(v3).toMatchObject({ published: true, problems: [] });
    expect((await call('GET', `/api/bots/${bot.id}/versions/99`, admin)).statusCode).toBe(404);

    const malformed = { nodes: [{ id: 'n1', type: 'nao_existe', position: { x: 0, y: 0 }, config: {} }], edges: [] };
    expect((await call('POST', `/api/bots/${bot.id}/versions`, admin, { graph: malformed, publish: false })).statusCode).toBe(400);
  });

  it('activates only a bot with a published version', async () => {
    const bot = await newBot('Ativação');
    const early = await call('POST', `/api/bots/${bot.id}/status`, admin, { status: 'active' });
    expect(early.statusCode).toBe(400);
    expect(early.json().error).toBe('Publique uma versão antes de ativar');

    await saveVersion(bot.id, manualGraph(), true);
    expect((await call('POST', `/api/bots/${bot.id}/status`, admin, { status: 'active' })).json().status).toBe('active');
    expect((await call('POST', `/api/bots/${bot.id}/status`, admin, { status: 'paused' })).json().status).toBe('paused');
  });

  it('patches fields, rejecting duplicate names and unknown channels', async () => {
    const a = await newBot('A');
    await newBot('B');

    const dup = await call('PATCH', `/api/bots/${a.id}`, admin, { name: 'B' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe('Já existe um chatbot com esse nome');

    const badChannel = await call('PATCH', `/api/bots/${a.id}`, admin, { startChannelIds: [randomUUID()] });
    expect(badChannel.statusCode).toBe(400);
    expect(badChannel.json().error).toBe('Canal inexistente');

    const res = await call('PATCH', `/api/bots/${a.id}`, admin, {
      description: 'Menu do escritório', startChannelIds: [seed.channelId, seed.channelId],
      manualStart: true, manualTitle: 'Iniciar A', manualUnlisted: true,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      name: 'A', description: 'Menu do escritório', startChannelIds: [seed.channelId],
      manualStart: true, manualTitle: 'Iniciar A', manualUnlisted: true,
    });
    expect((await call('PATCH', `/api/bots/${a.id}`, admin, {})).json().name).toBe('A');
    expect((await call('PATCH', `/api/bots/${a.id}`, admin, { name: 'A2' })).json().name).toBe('A2');
  });

  it('refuses to delete a bot with live runs or callers, then deletes it', async () => {
    const target = await publishManual('Alvo');
    const chatId = await insertChat(ctx, { channelId: seed.channelId, sectorId: seed.sectorA });
    const [chat] = await ctx.db.select().from(chats).where(eq(chats.id, chatId));
    const [run] = await ctx.db
      .insert(botRuns)
      .values({
        botId: target.id, versionId: (await latestVersion(ctx.db, target.id)).id, chatId,
        contactId: chat.contactId, state: 'waiting_reply', currentNodeId: 'n2',
      })
      .returning();

    const live = await call('DELETE', `/api/bots/${target.id}`, admin);
    expect(live.statusCode).toBe(409);
    expect(live.json().error).toBe('Este chatbot tem execuções em andamento');
    await ctx.db.update(botRuns).set({ state: 'finished' }).where(eq(botRuns.id, run.id));

    const caller = await newBot('Chamador');
    const expectUsedBy = async () => {
      const res = await call('DELETE', `/api/bots/${target.id}`, admin);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'Este chatbot é acionado por outros fluxos', usedBy: [{ id: caller.id, name: 'Chamador' }] });
    };

    // Only the latest (draft) version calls the target.
    expect((await saveVersion(caller.id, callerGraph(target.id), false)).statusCode).toBe(200);
    await expectUsedBy();
    // Only the published version calls it: a newer draft dropped the call.
    expect((await saveVersion(caller.id, callerGraph(target.id), true)).statusCode).toBe(200);
    expect((await saveVersion(caller.id, manualGraph(), false)).statusCode).toBe(200);
    await expectUsedBy();
    // Neither calls it any more.
    expect((await saveVersion(caller.id, manualGraph(), true)).statusCode).toBe(200);

    expect((await call('DELETE', `/api/bots/${target.id}`, admin)).statusCode).toBe(204);
    expect((await call('GET', `/api/bots/${target.id}`, admin)).statusCode).toBe(404);
    expect(await ctx.db.select().from(botRuns)).toHaveLength(0);
    expect((await call('DELETE', `/api/bots/${target.id}`, admin)).statusCode).toBe(404);
  });

  it('duplicates the latest graph as a paused, unpublished copy with the same start settings', async () => {
    const src = await publishManual('Origem');
    await call('PATCH', `/api/bots/${src.id}`, admin, { startChannelIds: [seed.channelId], manualTitle: 'Menu', manualUnlisted: true });
    await saveVersion(src.id, noStartGraph(), false);

    const res = await call('POST', `/api/bots/${src.id}/duplicate`, admin);
    expect(res.statusCode).toBe(200);
    const copy: BotDto = res.json();
    expect(copy).toMatchObject({
      name: 'Origem (cópia)', status: 'paused', publishedVersionId: null, latestVersionNumber: 1,
      startChannelIds: [seed.channelId], manualStart: true, manualTitle: 'Menu', manualUnlisted: true,
    });
    const v1 = (await call('GET', `/api/bots/${copy.id}/versions/1`, admin)).json();
    expect(v1).toMatchObject({ valid: false, published: false });
    expect(v1.graph).toEqual(noStartGraph());

    expect((await call('POST', `/api/bots/${src.id}/duplicate`, admin)).json().name).toBe('Origem (cópia) (2)');
  });

  it('exports the latest version as a file and imports it under a unique name', async () => {
    const bot = await newBot('Atendimento Inicial');
    await saveVersion(bot.id, manualGraph(), false);

    const exp = await call('GET', `/api/bots/${bot.id}/export`, admin);
    expect(exp.statusCode).toBe(200);
    expect(exp.headers['content-disposition']).toBe('attachment; filename="atendimento-inicial.json"');
    const file = exp.json();
    expect(file).toEqual({ name: 'Atendimento Inicial', graph: manualGraph() });

    const imp = await call('POST', '/api/bots/import', admin, file);
    expect(imp.statusCode).toBe(200);
    const imported: BotDto = imp.json();
    expect(imported).toMatchObject({ name: 'Atendimento Inicial (2)', status: 'paused', publishedVersionId: null, latestVersionNumber: 1 });
    const v1 = (await call('GET', `/api/bots/${imported.id}/versions/1`, admin)).json();
    expect(v1).toMatchObject({ valid: true });
    expect(v1.graph).toEqual(manualGraph());

    expect((await call('POST', '/api/bots/import', admin, { name: 'Quebrado', graph: { nodes: 'x' } })).statusCode).toBe(400);
    expect((await call('POST', '/api/bots/import', agentA, file)).statusCode).toBe(403);
  });

  it('uploads bot media under bots/ in the media dir', async () => {
    const up = pngUpload();
    const res = await app.inject({ method: 'POST', url: '/api/bots/media', headers: { ...admin, ...up.headers }, payload: up.payload });
    expect(res.statusCode).toBe(200);
    const media = res.json();
    expect(media).toMatchObject({ name: 'logo.png', mime: 'image/png', size: 4 });
    expect(media.path).toMatch(new RegExp(`^bots/${UUID}\\.png$`));
    expect(existsSync(join(ctx.config.mediaDir, media.path))).toBe(true);

    const agent = await app.inject({ method: 'POST', url: '/api/bots/media', headers: { ...agentA, ...up.headers }, payload: up.payload });
    expect(agent.statusCode).toBe(403);
    expect((await call('POST', '/api/bots/media', admin, {})).statusCode).toBe(400);
  });
});
```

- [ ] **Step 7: Run it and see it fail**

Run: `npm test -w server -- test/bots/routes.test.ts`
Expected: FAIL in every test of `admin bot routes`: the routes do not exist yet, so the not-found handler answers 404 (`expected 404 to be 403` / `expected 404 to be 200`).

- [ ] **Step 8: Write the admin routes**

Create `server/src/bots/routes.ts`:

```ts
import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  BLOCK_TYPES, NON_TERMINAL_RUN_STATES,
  type BotExport, type BotGraph, type BotMediaDto, type BotVersionDto, type GraphProblem,
} from '@talk/shared';
import { requireAdmin } from '../auth/plugin.js';
import type { AppCtx } from '../ctx.js';
import type { Db } from '../db/client.js';
import { botRuns, bots, channels } from '../db/schema.js';
import { HttpError, badRequest, conflict, notFound } from '../lib/http-error.js';
import { baseMime, saveMedia } from '../messages/media.js';
import { loadGraphCatalog, validateGraph } from './graph.js';
import {
  STARTER_GRAPH, createBot, getBot, getVersionByNumber, getVersionRow, insertBotVersion, latestVersion,
  toBotDto, toBotDtos, toBotVersionSummaries, uniqueBotName, type BotRow, type BotVersionRow,
} from './repo.js';

const IdParams = z.object({ id: z.uuid() });
const VersionParams = z.object({ id: z.uuid(), n: z.coerce.number().int().positive() });
const NodeSchema = z.object({
  id: z.string().min(1).max(64), type: z.enum(BLOCK_TYPES),
  position: z.object({ x: z.number().finite(), y: z.number().finite() }),
  config: z.record(z.string(), z.unknown()), name: z.string().max(40).optional(),
});
const EdgeSchema = z.object({
  id: z.string().min(1).max(64), source: z.string().min(1).max(64),
  sourceHandle: z.string().min(1).max(64), target: z.string().min(1).max(64),
});
export const GraphSchema = z.object({ nodes: z.array(NodeSchema).max(500), edges: z.array(EdgeSchema).max(2000) });
export const Name = z.string().trim().min(1).max(80);
const CreateBody = z.object({ name: Name, description: z.string().trim().max(500).optional() });
const PatchBody = z
  .object({
    name: Name, description: z.string().trim().max(500), startChannelIds: z.array(z.uuid()).max(50),
    manualStart: z.boolean(), manualTitle: z.string().trim().max(80), manualUnlisted: z.boolean(),
  })
  .partial();
const SaveVersionBody = z.object({ graph: GraphSchema, label: z.string().trim().max(80).optional(), publish: z.boolean() });
const StatusBody = z.object({ status: z.enum(['active', 'paused']) });
const ImportBody = z.object({ name: Name, graph: GraphSchema });

const admin = { preHandler: requireAdmin };
const NAME_TAKEN = 'Já existe um chatbot com esse nome';
const BAD_MEDIA = 'Envie um único arquivo de até 64 MB no campo "file"';

async function problemsFor(db: Db, selfBotId: string | null, graph: BotGraph): Promise<GraphProblem[]> {
  return validateGraph(graph, await loadGraphCatalog(db, selfBotId));
}

// ponytail: builds every summary to pick one (one query per call); fine for tens of versions.
async function toVersionDto(db: Db, bot: BotRow, row: BotVersionRow): Promise<BotVersionDto> {
  const summary = (await toBotVersionSummaries(db, bot)).find((s) => s.id === row.id);
  if (!summary) throw notFound('Versão não encontrada');
  return { ...summary, graph: row.graph, problems: await problemsFor(db, bot.id, row.graph) };
}

// ponytail: check-then-insert; two admins racing on one name get a 500 from the unique index, retrying shows the 409.
async function assertNameFree(db: Db, name: string, exceptId?: string): Promise<void> {
  const where = exceptId ? and(eq(bots.name, name), ne(bots.id, exceptId)) : eq(bots.name, name);
  if (await db.$count(bots, where)) throw conflict(NAME_TAKEN);
}

async function assertChannelsExist(db: Db, ids: string[]): Promise<void> {
  if (ids.length > 0 && (await db.$count(channels, inArray(channels.id, ids))) !== ids.length) {
    throw badRequest('Canal inexistente');
  }
}

/** Other bots whose latest or published version has a call_flow to botId. */
// ponytail: two queries per bot; fine for tens of bots. A jsonb @> query if this ever gets slow.
async function callersOf(db: Db, botId: string): Promise<Array<{ id: string; name: string }>> {
  const others = await db.select().from(bots).where(ne(bots.id, botId)).orderBy(asc(bots.name));
  const usedBy: Array<{ id: string; name: string }> = [];
  for (const other of others) {
    const graphs = [(await latestVersion(db, other.id)).graph];
    const published = other.publishedVersionId ? await getVersionRow(db, other.publishedVersionId) : null;
    if (published) graphs.push(published.graph);
    const calls = graphs.some((g) => g.nodes.some((n) => n.type === 'call_flow' && n.config.botId === botId));
    if (calls) usedBy.push({ id: other.id, name: other.name });
  }
  return usedBy;
}

const fileSlug = (s: string) =>
  s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'chatbot';

/** The `file` part of a multipart body; 400 for a missing file, a non-multipart body or one past the 64 MB limit. */
async function readBotMedia(req: FastifyRequest): Promise<{ buffer: Buffer; mime: string; name: string }> {
  try {
    const part = await req.file();
    if (!part) throw badRequest(BAD_MEDIA);
    const buffer = await part.toBuffer(); // throws (413) past the limit set in buildApp
    return {
      buffer,
      mime: baseMime(part.mimetype) || 'application/octet-stream',
      name: (part.filename || 'arquivo').slice(0, 200),
    };
  } catch (err) {
    // @fastify/multipart: 406 not multipart, 413 file too large, ...
    if (err instanceof HttpError) throw err;
    if (typeof (err as { statusCode?: unknown }).statusCode === 'number') throw badRequest(BAD_MEDIA);
    throw err;
  }
}

export function registerBotRoutes(app: FastifyInstance, ctx: AppCtx): void {
  app.get('/api/bots', admin, async () =>
    toBotDtos(ctx.db, await ctx.db.select().from(bots).orderBy(asc(bots.name))),
  );

  app.post('/api/bots', admin, async (req) => {
    const b = CreateBody.parse(req.body);
    await assertNameFree(ctx.db, b.name);
    const graph = STARTER_GRAPH();
    const row = await createBot(ctx.db, {
      name: b.name, description: b.description, graph, publish: false, createdBy: req.user.id,
      valid: (await problemsFor(ctx.db, null, graph)).length === 0,
    });
    return toBotDto(ctx.db, row);
  });

  app.get('/api/bots/:id', admin, async (req) => toBotDto(ctx.db, await getBot(ctx.db, IdParams.parse(req.params).id)));

  app.patch('/api/bots/:id', admin, async (req) => {
    const { id } = IdParams.parse(req.params);
    const b = PatchBody.parse(req.body);
    const bot = await getBot(ctx.db, id);
    if (b.name !== undefined) await assertNameFree(ctx.db, b.name, id);
    const startChannelIds = b.startChannelIds && [...new Set(b.startChannelIds)];
    if (startChannelIds) await assertChannelsExist(ctx.db, startChannelIds);
    const set = { ...b, startChannelIds };
    if (Object.values(set).every((v) => v === undefined)) return toBotDto(ctx.db, bot);
    const [row] = await ctx.db.update(bots).set(set).where(eq(bots.id, id)).returning();
    return toBotDto(ctx.db, row);
  });

  app.delete('/api/bots/:id', admin, async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    await getBot(ctx.db, id);
    const live = await ctx.db.$count(
      botRuns,
      and(eq(botRuns.botId, id), inArray(botRuns.state, [...NON_TERMINAL_RUN_STATES])),
    );
    if (live) throw conflict('Este chatbot tem execuções em andamento');
    const usedBy = await callersOf(ctx.db, id);
    if (usedBy.length) throw new HttpError(409, 'Este chatbot é acionado por outros fluxos', { usedBy });
    // Cascades to bot_versions and bot_runs; messages.bot_run_id becomes null.
    await ctx.db.delete(bots).where(eq(bots.id, id));
    return reply.code(204).send();
  });

  app.post('/api/bots/:id/duplicate', admin, async (req) => {
    const bot = await getBot(ctx.db, IdParams.parse(req.params).id);
    const { graph } = await latestVersion(ctx.db, bot.id);
    const row = await createBot(ctx.db, {
      name: await uniqueBotName(ctx.db, `${bot.name} (cópia)`),
      description: bot.description, graph, publish: false, createdBy: req.user.id,
      valid: (await problemsFor(ctx.db, null, graph)).length === 0,
      startChannelIds: bot.startChannelIds, manualStart: bot.manualStart, manualTitle: bot.manualTitle,
    });
    if (!bot.manualUnlisted) return toBotDto(ctx.db, row);
    // createBot has no manualUnlisted input.
    const [copy] = await ctx.db.update(bots).set({ manualUnlisted: true }).where(eq(bots.id, row.id)).returning();
    return toBotDto(ctx.db, copy);
  });

  app.get('/api/bots/:id/versions', admin, async (req) =>
    toBotVersionSummaries(ctx.db, await getBot(ctx.db, IdParams.parse(req.params).id)),
  );

  app.get('/api/bots/:id/versions/:n', admin, async (req) => {
    const { id, n } = VersionParams.parse(req.params);
    const bot = await getBot(ctx.db, id);
    return toVersionDto(ctx.db, bot, await getVersionByNumber(ctx.db, id, n));
  });

  // Spec §9: an invalid graph is still saved as a draft (valid=false); only publishing it is refused.
  app.post('/api/bots/:id/versions', admin, async (req) => {
    const { id } = IdParams.parse(req.params);
    const b = SaveVersionBody.parse(req.body);
    await getBot(ctx.db, id);
    const problems = await problemsFor(ctx.db, id, b.graph);
    const valid = problems.length === 0;
    const version = await insertBotVersion(ctx.db, {
      botId: id, graph: b.graph, valid, createdBy: req.user.id, label: b.label || null,
    });
    await ctx.db
      .update(bots)
      .set(b.publish && valid ? { publishedVersionId: version.id } : { updatedAt: new Date() })
      .where(eq(bots.id, id));
    if (b.publish && !valid) throw new HttpError(400, 'O fluxo tem problemas', { problems });
    return toVersionDto(ctx.db, await getBot(ctx.db, id), version);
  });

  app.post('/api/bots/:id/status', admin, async (req) => {
    const { id } = IdParams.parse(req.params);
    const { status } = StatusBody.parse(req.body);
    const bot = await getBot(ctx.db, id);
    if (status === 'active' && !bot.publishedVersionId) throw badRequest('Publique uma versão antes de ativar');
    const [row] = await ctx.db.update(bots).set({ status }).where(eq(bots.id, id)).returning();
    return toBotDto(ctx.db, row);
  });

  app.post('/api/bots/import', admin, async (req) => {
    const b = ImportBody.parse(req.body);
    const row = await createBot(ctx.db, {
      name: await uniqueBotName(ctx.db, b.name), graph: b.graph, publish: false, createdBy: req.user.id,
      valid: (await problemsFor(ctx.db, null, b.graph)).length === 0,
    });
    return toBotDto(ctx.db, row);
  });

  app.get('/api/bots/:id/export', admin, async (req, reply) => {
    const bot = await getBot(ctx.db, IdParams.parse(req.params).id);
    const body: BotExport = { name: bot.name, graph: (await latestVersion(ctx.db, bot.id)).graph };
    return reply.header('content-disposition', `attachment; filename="${fileSlug(bot.name)}.json"`).send(body);
  });

  app.post('/api/bots/media', admin, async (req): Promise<BotMediaDto> => {
    const { buffer, mime, name } = await readBotMedia(req);
    const saved = await saveMedia(ctx.config.mediaDir, buffer, mime, name, 'bots');
    return { path: saved.path, name, mime, size: saved.size };
  });
}
```

Then register it in `server/src/app.ts`. Replace:

```ts
import { authRoutes } from './auth/routes.js';
```

with:

```ts
import { authRoutes } from './auth/routes.js';
import { registerBotRoutes } from './bots/routes.js';
```

and replace:

```ts
  registerChannelRoutes(app, ctx);
```

with:

```ts
  registerChannelRoutes(app, ctx);
  registerBotRoutes(app, ctx);
```

- [ ] **Step 9: Run the tests and the typecheck**

Run: `npm test -w server -- test/bots/routes.test.ts`
Expected: PASS (the 9 tests in `admin bot routes`).

Run: `npm run typecheck -w server`
Expected: exit 0, no errors.

- [ ] **Step 10: Commit**

```bash
git add server/src/bots/routes.ts server/src/app.ts server/test/bots/routes.test.ts
git commit -m "feat(server): admin REST API for chatbots (CRUD, versions, publish, import/export, media)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 11: Write the failing tests for manual runs**

Append to the end of `server/test/bots/routes.test.ts` (every import and helper it uses is already at the top of the file):

```ts
describe('manual bots and runs', () => {
  it('lists active, published, listed manual bots for any user, by title', async () => {
    const b = await publishManual('Menu B');
    await call('PATCH', `/api/bots/${b.id}`, admin, { manualTitle: 'Abertura' });
    const a = await publishManual('Menu A');
    const hidden = await publishManual('Oculto');
    await call('PATCH', `/api/bots/${hidden.id}`, admin, { manualUnlisted: true });
    const paused = await publishManual('Pausado');
    await call('POST', `/api/bots/${paused.id}/status`, admin, { status: 'paused' });
    await newBot('Sem início manual');

    const res = await call('GET', '/api/bots/manual', agentA);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ id: b.id, title: 'Abertura' }, { id: a.id, title: 'Menu A' }]);
  });

  it('starts a manual bot in a visible chat, lists it, refuses a duplicate and stops it', async () => {
    const bot = await publishManual('Menu manual');
    const chatId = await insertChat(ctx, { channelId: seed.channelId, sectorId: seed.sectorA });

    const started = await call('POST', `/api/chats/${chatId}/bot-runs`, agentA, { botId: bot.id });
    expect(started.statusCode).toBe(200);
    const run = started.json();
    expect(run).toMatchObject({
      botId: bot.id, botName: 'Menu manual', chatId, state: 'waiting_reply', currentNodeId: 'n2',
      depth: 0, startedByName: 'Ana Financeiro', finishedAt: null,
    });

    expect((await call('POST', `/api/chats/${chatId}/bot-runs`, agentA, { botId: bot.id })).statusCode).toBe(409);
    expect((await call('GET', `/api/chats/${chatId}/bot-runs`, agentA)).json().map((r: { id: string }) => r.id)).toEqual([run.id]);

    // Bruno (sector B) cannot see the chat: everything is 404.
    expect((await call('POST', `/api/chats/${chatId}/bot-runs`, agentB, { botId: bot.id })).statusCode).toBe(404);
    expect((await call('GET', `/api/chats/${chatId}/bot-runs`, agentB)).statusCode).toBe(404);
    expect((await call('POST', `/api/bot-runs/${run.id}/stop`, agentB)).statusCode).toBe(404);

    const stopped = await call('POST', `/api/bot-runs/${run.id}/stop`, agentA);
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json()).toMatchObject({ id: run.id, state: 'stopped' });
    const again = await call('POST', `/api/bot-runs/${run.id}/stop`, agentA);
    expect(again.statusCode).toBe(200);
    expect(again.json().state).toBe('stopped');
    expect((await call('GET', `/api/chats/${chatId}/bot-runs`, agentA)).json()).toEqual([]);
  });

  it('refuses closed chats, bots that cannot start manually and unknown runs', async () => {
    const manual = await publishManual('Manual');
    const closedChat = await insertChat(ctx, { channelId: seed.channelId, sectorId: seed.sectorA, state: 'closed' });
    const closed = await call('POST', `/api/chats/${closedChat}/bot-runs`, agentA, { botId: manual.id });
    expect(closed.statusCode).toBe(409);
    expect(closed.json().error).toBe('Conversa finalizada');

    const chatId = await insertChat(ctx, { channelId: seed.channelId, sectorId: seed.sectorA });
    const NOT_MANUAL = 'Este chatbot não pode ser iniciado manualmente';
    const draft = await newBot('Rascunho');
    const noManual = await publishManual('Sem manual');
    await call('PATCH', `/api/bots/${noManual.id}`, admin, { manualStart: false });
    for (const botId of [draft.id, noManual.id, randomUUID()]) {
      const res = await call('POST', `/api/chats/${chatId}/bot-runs`, agentA, { botId });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe(NOT_MANUAL);
    }
    expect((await call('POST', `/api/chats/${chatId}/bot-runs`, agentA, { botId: 'x' })).statusCode).toBe(400);
    expect((await call('POST', `/api/bot-runs/${randomUUID()}/stop`, agentA)).statusCode).toBe(404);
  });
});
```

- [ ] **Step 12: Run them and see them fail**

Run: `npm test -w server -- test/bots/routes.test.ts`
Expected: the 9 `admin bot routes` tests PASS; the 3 `manual bots and runs` tests FAIL because `/api/bots/manual` falls into the admin-only `/api/bots/:id` (`expected 403 to be 200` for Ana) and `/api/chats/:id/bot-runs` / `/api/bot-runs/:id/stop` are 404 (`expected 404 to be 200`).

- [ ] **Step 13: Add the manual list and the run routes**

In `server/src/bots/routes.ts` make these edits.

Replace:

```ts
import { and, asc, eq, inArray, ne } from 'drizzle-orm';
```

with:

```ts
import { and, asc, eq, inArray, isNotNull, ne } from 'drizzle-orm';
```

Replace:

```ts
  type BotExport, type BotGraph, type BotMediaDto, type BotVersionDto, type GraphProblem,
} from '@talk/shared';
```

with:

```ts
  type BotExport, type BotGraph, type BotMediaDto, type BotVersionDto, type GraphProblem, type ManualBotDto,
} from '@talk/shared';
```

Replace:

```ts
import { botRuns, bots, channels } from '../db/schema.js';
```

with:

```ts
import { botRuns, bots, channels } from '../db/schema.js';
import { getChatForUser } from '../inbox/chats.js';
```

Replace:

```ts
import { loadGraphCatalog, validateGraph } from './graph.js';
```

with:

```ts
import { runningRunsForChat, startRun, stopRun } from './engine.js';
import { loadGraphCatalog, validateGraph } from './graph.js';
```

Replace:

```ts
  toBotDto, toBotDtos, toBotVersionSummaries, uniqueBotName, type BotRow, type BotVersionRow,
```

with:

```ts
  toBotDto, toBotDtos, toBotRunDto, toBotVersionSummaries, uniqueBotName, type BotRow, type BotVersionRow,
```

Replace:

```ts
const ImportBody = z.object({ name: Name, graph: GraphSchema });
```

with:

```ts
const ImportBody = z.object({ name: Name, graph: GraphSchema });
const StartRunBody = z.object({ botId: z.uuid() });
```

Replace the end of `registerBotRoutes`:

```ts
    const saved = await saveMedia(ctx.config.mediaDir, buffer, mime, name, 'bots');
    return { path: saved.path, name, mime, size: saved.size };
  });
}
```

with:

```ts
    const saved = await saveMedia(ctx.config.mediaDir, buffer, mime, name, 'bots');
    return { path: saved.path, name, mime, size: saved.size };
  });

  registerRunRoutes(app, ctx);
}

/** Routes for every user. The chat-scoped ones go through getChatForUser, so a chat the user cannot see is 404. */
function registerRunRoutes(app: FastifyInstance, ctx: AppCtx): void {
  app.get('/api/bots/manual', async (): Promise<ManualBotDto[]> => {
    const rows = await ctx.db
      .select({ id: bots.id, name: bots.name, manualTitle: bots.manualTitle })
      .from(bots)
      .where(
        and(
          eq(bots.status, 'active'), isNotNull(bots.publishedVersionId),
          eq(bots.manualStart, true), eq(bots.manualUnlisted, false),
        ),
      );
    return rows
      .map((r) => ({ id: r.id, title: r.manualTitle || r.name }))
      .sort((a, b) => a.title.localeCompare(b.title, 'pt-BR'));
  });

  app.post('/api/chats/:id/bot-runs', async (req) => {
    const { id } = IdParams.parse(req.params);
    const { botId } = StartRunBody.parse(req.body);
    const chat = await getChatForUser(ctx, req.user, id);
    if (chat.state !== 'open') throw conflict('Conversa finalizada');
    const [bot] = await ctx.db.select().from(bots).where(eq(bots.id, botId));
    // A missing bot gets the same answer, so the route does not reveal which bot ids exist.
    if (!bot || bot.status !== 'active' || !bot.publishedVersionId || !bot.manualStart) {
      throw badRequest('Este chatbot não pode ser iniciado manualmente');
    }
    const started = await startRun(ctx, { botId, chatId: chat.id, entry: 'manual', startedBy: req.user.id }); // 409 on a duplicate
    // Re-read: the DTO shows the state after the first step (waiting_reply, finished…).
    const [run] = await ctx.db.select().from(botRuns).where(eq(botRuns.id, started.id));
    return toBotRunDto(ctx.db, run ?? started);
  });

  app.get('/api/chats/:id/bot-runs', async (req) => {
    const chat = await getChatForUser(ctx, req.user, IdParams.parse(req.params).id);
    const runs = await runningRunsForChat(ctx.db, chat.id);
    return Promise.all(runs.map((r) => toBotRunDto(ctx.db, r)));
  });

  // Idempotent: an already terminal run comes back as it is.
  app.post('/api/bot-runs/:id/stop', async (req) => {
    const { id } = IdParams.parse(req.params);
    const [run] = await ctx.db.select().from(botRuns).where(eq(botRuns.id, id));
    if (!run) throw notFound();
    await getChatForUser(ctx, req.user, run.chatId); // 404 unless canSee
    const row = NON_TERMINAL_RUN_STATES.includes(run.state)
      ? await stopRun(ctx, id, { userId: req.user.id, reason: 'manual' })
      : run;
    return toBotRunDto(ctx.db, row);
  });
}
```

- [ ] **Step 14: Run the tests, the typecheck and the whole server suite**

Run: `npm test -w server -- test/bots/routes.test.ts`
Expected: PASS (12 tests).

Run: `npm run typecheck -w server`
Expected: exit 0, no errors.

Run: `npm test -w server`
Expected: PASS, no regressions (the new routes only add paths; `app.test.ts` and `spa.test.ts` still see the SPA/not-found block last).

- [ ] **Step 15: Commit**

```bash
git add server/src/bots/routes.ts server/test/bots/routes.test.ts
git commit -m "feat(server): manual bot runs API (list manual bots, start, list, stop)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


---

### Task 12: Office template, create-from-template and end-to-end test

This task builds the "Fluxo do escritório" graph of spec §8 and adds `POST /api/bots/from-template`. It then runs that template through the real ingest path with the fake gateway and the fake clock. This test is the plan's definition of done: hours in and out, the welcome text, the menu, an invalid option, a CPF that is invalid and then valid and saved to the field, the transfer, the notification and the menu timeout.

**Files:**
- Create: `server/src/bots/templates.ts`
- Modify: `server/src/bots/routes.ts` (one import, plus one route at the end of `registerBotRoutes`)
- Test: `server/test/bots/template.test.ts`

**Interfaces:**
- Consumes:
  - `@talk/shared` (Task 1): the types `OfficeTemplateInput`, `OfficeTemplateDestination`, `BotGraph`, `BotNode`, `BotEdge`, `BotDto`, `BotVersionDto`, `Weekday`, `HoursConfig`, `SendMessageConfig`, `AskChoiceConfig`, `AskInputConfig`, `MultiConditionConfig`, `TransferSectorConfig`, `TransferAgentConfig` and `NotifyAgentConfig`, plus the constant `DEFAULT_TIMEZONE` (`'America/Cuiaba'`).
  - `server/src/bots/graph.ts` (Task 3):
    - `loadGraphCatalog(db: Db | Tx, selfBotId: string | null): Promise<GraphCatalog>`
    - `validateGraph(graph: BotGraph, catalog: GraphCatalog): GraphProblem[]`
    - `GraphCatalog { selfBotId; sectorIds; activeUserIds; tagIds; customFieldIds; channelIds; botIds }`, where every field except `selfBotId` is a `Set<string>`
  - `server/src/bots/repo.ts` (Task 2):
    - `createBot(db: Db, input: { name; description?; graph; valid; publish; createdBy; startChannelIds?; manualStart?; manualTitle? }): Promise<BotRow>`
    - `uniqueBotName(db: Db | Tx, base: string): Promise<string>`
    - `toBotDto(db: Db | Tx, row: BotRow): Promise<BotDto>`
  - `server/src/bots/routes.ts` (Task 11): `registerBotRoutes(app, ctx)`, the zod `Name`, the `const admin = { preHandler: requireAdmin }` route option, `POST /api/bots/:id/status` and `GET /api/bots/:id/versions/:n`.
  - `server/src/bots/scheduler.ts` (Task 9): `createScheduler(ctx: AppCtx, opts?): Scheduler`, with `tick(now?: Date): Promise<number>`.
  - `server/src/messages/ingest.ts` (Task 10): `handleInbound(ctx, events)` with the default hooks. These start the channel bot ahead of triage and resume a waiting run on a reply.
  - `Hub.publishNotification(chatId, userIds, notification)` (Task 8). The recording hub pushes `{ type: 'notification', chatId, userId }`.
  - `makeTestCtx()` (Task 5) returns `clock: FakeClock` (`now`, `set`, `advance`), which is wired into `ctx.botRuntime`.
  - `eventsOf(ctx, chatId)` (`server/test/inbox/fixtures.ts`) and `avatarRefreshesIdle()` (`messages/ingest.ts`), both existing.
- Produces (contract §3.10, names unchanged):
  - `export function buildOfficeGraph(input: OfficeTemplateInput, cpfFieldId: string): BotGraph`. It is pure. Node ids equal node names.
  - `export async function createOfficeTemplate(ctx: AppCtx, input: OfficeTemplateInput, createdBy: string): Promise<BotDto>`. It checks the channel, sectors and users first: 400 `'Canal inexistente'`, `'Setor inexistente'` or `'Atendente inexistente'`, and nothing is created. Then it ensures the custom field `CPF` (kind `cpf`), validates the built graph and creates the bot published, `paused`, on `[channelId]`.
  - In `server/src/bots/routes.ts`, the zod schemas `TemplateDest` and `TemplateBody` (§3.10), which Task 12 declares itself.
  - `POST /api/bots/from-template` (admin, via Task 11's `admin` preHandler) with `TemplateBody`, returning `BotDto`. The web dialog in Task 13 calls it through `api.bots.fromTemplate`.

Graph built by `buildOfficeGraph`. `<k>` stands for `atendimento` (option `1`, `case:0`), `financeiro` (`2`, `case:1`) or `processos` (`3`, `case:2`).

| node (id = name) | type | outgoing edges |
|---|---|---|
| `inicio` | start_channel | `next` → `horario` |
| `horario` | hours (Cuiabá; Mon–Fri 08:00–12:00 and 14:00–18:00) | `in` → `boas_vindas`, `out` → `fora_do_horario` |
| `fora_do_horario` | send_message | none, so the run finishes and the chat stays open in the queue |
| `boas_vindas` | send_message (`{{empresa}}` replaced) | `next` → `menu` |
| `menu` | ask_choice (1/2/3, 1 retry, 24 h) | `opt:1`, `opt:2`, `opt:3` → `comunicado`; `invalid` and `timeout` are unconnected, so the run ends |
| `comunicado` | send_message | `next` → `cpf` |
| `cpf` | ask_input `cpf` (2 retries, saves to the CPF field) | `next` → `destino`, `invalid` → `destino` |
| `destino` | multi_condition on `var menu` eq `1`/`2`/`3` | `case:<i>` → `setor_<k>`; `else` is unconnected |
| `setor_<k>` | transfer_sector | `next` → `agente_<k>` only when `userId` is mapped |
| `agente_<k>` | transfer_agent `specific` [userId] | `next` → `aviso_<k>` |
| `aviso_<k>` | notify_agent `owner` | none |

- [ ] **Step 1: Write the failing graph-builder test**

Create `server/test/bots/template.test.ts`. The imports already cover the later steps, which append to this file.

```ts
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotDto, BotVersionDto, OfficeTemplateInput } from '@talk/shared';
import { validateGraph, type GraphCatalog } from '../../src/bots/graph.js';
import { createScheduler } from '../../src/bots/scheduler.js';
import { buildOfficeGraph } from '../../src/bots/templates.js';
import { botRuns, bots, chats, contactFieldValues, customFields, messages } from '../../src/db/schema.js';
import { avatarRefreshesIdle, handleInbound } from '../../src/messages/ingest.js';
import type { InboundEvent } from '../../src/whatsapp/types.js';
import { loginAs, makeTestApp, makeTestCtx, seedBasics, type Seeded } from '../helpers.js';
import { eventsOf } from '../inbox/fixtures.js';

// Spec §8 texts, copied verbatim on purpose: the test pins the spec, not the implementation's constants.
const OUT_OF_HOURS = 'Estamos fora do horário de atendimento. Deixe sua mensagem que retornaremos assim que possível.';
const WELCOME = 'Olá Maria! 👋 Sou o assistente virtual da Silva Advogados. Como posso te ajudar hoje?';
const MENU_TEXT = 'Escolha uma das opções abaixo digitando o número correspondente:';
const MENU = `${MENU_TEXT}\n\n1: Atendimento\n2: Financeiro\n3: Processos`;
const NOTICE =
  '⚠️ COMUNICADO — Informamos que nosso WhatsApp está com uma demanda muito alta no momento. Por isso, pedimos um prazo de até 2 dias úteis para retorno. Enquanto isso, deixe aqui sua dúvida ou necessidade. Agradecemos a compreensão! 🤝';
const CPF_ASK = 'Para agilizar, digite seu CPF:';
const CPF_INVALID = 'CPF inválido, confira e digite de novo.';
const WORKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];

describe('buildOfficeGraph', () => {
  const ids = {
    channel: randomUUID(),
    atendimento: randomUUID(),
    financeiro: randomUUID(),
    processos: randomUUID(),
    ana: randomUUID(),
    cpf: randomUUID(),
  };
  const input: OfficeTemplateInput = {
    companyName: 'Silva Advogados',
    channelId: ids.channel,
    destinations: {
      atendimento: { sectorId: ids.atendimento },
      financeiro: { sectorId: ids.financeiro, userId: ids.ana },
      processos: { sectorId: ids.processos, userId: null },
    },
  };
  const catalog: GraphCatalog = {
    selfBotId: null,
    sectorIds: new Set([ids.atendimento, ids.financeiro, ids.processos]),
    activeUserIds: new Set([ids.ana]),
    tagIds: new Set(),
    customFieldIds: new Set([ids.cpf]),
    channelIds: new Set([ids.channel]),
    botIds: new Set(),
  };
  const g = buildOfficeGraph(input, ids.cpf);
  const node = (name: string) => g.nodes.find((n) => n.name === name);
  const target = (source: string, handle: string) =>
    g.edges.find((e) => e.source === source && e.sourceHandle === handle)?.target ?? null;

  it('is a valid graph with the contract node names', () => {
    expect(validateGraph(g, catalog)).toEqual([]);
    expect(g.nodes.map((n) => n.name).sort()).toEqual(
      [
        'inicio', 'horario', 'fora_do_horario', 'boas_vindas', 'menu', 'comunicado', 'cpf', 'destino',
        'setor_atendimento', 'setor_financeiro', 'agente_financeiro', 'aviso_financeiro', 'setor_processos',
      ].sort(),
    );
    for (const n of g.nodes) expect(n.id).toBe(n.name);
  });

  it('checks the office hours in Cuiabá and sends the notice when closed', () => {
    expect(node('inicio')?.type).toBe('start_channel');
    expect(target('inicio', 'next')).toBe('horario');
    expect(node('horario')).toMatchObject({
      type: 'hours',
      config: {
        timezone: 'America/Cuiaba',
        intervals: [
          { from: '08:00', to: '12:00', days: WORKDAYS },
          { from: '14:00', to: '18:00', days: WORKDAYS },
        ],
      },
    });
    expect(target('horario', 'in')).toBe('boas_vindas');
    expect(target('horario', 'out')).toBe('fora_do_horario');
    expect(node('fora_do_horario')).toMatchObject({ type: 'send_message', config: { text: OUT_OF_HOURS, signature: false } });
    expect(target('fora_do_horario', 'next')).toBeNull(); // run ends; the chat is not closed
  });

  it('fills the company name into the welcome text and nothing else', () => {
    expect(node('boas_vindas')?.config.text).toBe(
      'Olá {{contato.primeiro_nome}}! 👋 Sou o assistente virtual da Silva Advogados. Como posso te ajudar hoje?',
    );
    // `$&` must stay literal (String.replace patterns)
    const odd = buildOfficeGraph({ ...input, companyName: 'Souza $& Cia' }, ids.cpf);
    expect(odd.nodes.find((n) => n.name === 'boas_vindas')?.config.text).toContain('da Souza $& Cia. Como');
    expect(target('boas_vindas', 'next')).toBe('menu');
  });

  it('asks the menu with one retry and a 24 h timeout, every option going to the notice', () => {
    expect(node('menu')).toMatchObject({
      type: 'ask_choice',
      config: {
        text: MENU_TEXT,
        options: [
          { key: '1', label: 'Atendimento' },
          { key: '2', label: 'Financeiro' },
          { key: '3', label: 'Processos' },
        ],
        invalidRetries: 1,
        timeoutHours: 24,
      },
    });
    for (const k of ['1', '2', '3']) expect(target('menu', `opt:${k}`)).toBe('comunicado');
    expect(target('menu', 'invalid')).toBeNull();
    expect(target('menu', 'timeout')).toBeNull();
    expect(node('comunicado')).toMatchObject({ type: 'send_message', config: { text: NOTICE } });
    expect(target('comunicado', 'next')).toBe('cpf');
  });

  it('asks the CPF with two retries, saves it to the field and goes on even when invalid', () => {
    expect(node('cpf')).toMatchObject({
      type: 'ask_input',
      config: {
        text: CPF_ASK,
        validator: 'cpf',
        useLastMessage: false,
        invalidText: CPF_INVALID,
        invalidRetries: 2,
        saveToField: ids.cpf,
      },
    });
    expect(target('cpf', 'next')).toBe('destino');
    expect(target('cpf', 'invalid')).toBe('destino');
  });

  it('routes by the menu answer; only a mapped agent gets the transfer and the notification', () => {
    const cases = node('destino')?.config.cases as Array<{ rules: unknown[] }>;
    expect(cases.map((c) => c.rules)).toEqual(
      ['1', '2', '3'].map((v) => [{ left: { kind: 'var', value: 'menu' }, operator: 'eq', right: { kind: 'literal', value: v } }]),
    );
    expect(target('destino', 'case:0')).toBe('setor_atendimento');
    expect(target('destino', 'case:1')).toBe('setor_financeiro');
    expect(target('destino', 'case:2')).toBe('setor_processos');
    expect(target('destino', 'else')).toBeNull();

    expect(node('setor_atendimento')?.config).toEqual({ sectorId: ids.atendimento, onlyIfAgentAllowed: false });
    expect(node('setor_processos')?.config).toEqual({ sectorId: ids.processos, onlyIfAgentAllowed: false });
    expect(target('setor_atendimento', 'next')).toBeNull();
    expect(target('setor_processos', 'next')).toBeNull();

    expect(target('setor_financeiro', 'next')).toBe('agente_financeiro');
    expect(node('agente_financeiro')?.config).toEqual({ rule: 'specific', userIds: [ids.ana], sectorIds: [] });
    expect(target('agente_financeiro', 'next')).toBe('aviso_financeiro');
    expect(node('aviso_financeiro')?.config).toEqual({
      title: 'Nova conversa',
      text: 'Nova conversa de {{contato.nome}} — CPF {{contexto.cpf}}',
      target: 'owner',
      userIds: [],
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w server -- test/bots/template.test.ts -t "buildOfficeGraph"`
Expected: FAIL. The suite cannot load because `../../src/bots/templates.js` does not exist yet ("Failed to load url ../../src/bots/templates.js").

- [ ] **Step 3: Write the template module**

Create `server/src/bots/templates.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w server -- test/bots/template.test.ts -t "buildOfficeGraph"`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/bots/templates.ts server/test/bots/template.test.ts
git commit -m "feat(server): office template graph builder

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Write the failing route tests**

Append to `server/test/bots/template.test.ts`:

```ts
type Ctx = Awaited<ReturnType<typeof makeTestCtx>>;
let ctx: Ctx;
let seed: Seeded;
let app: FastifyInstance;
let admin: Record<string, string>;

async function boot() {
  ctx = await makeTestCtx();
  seed = await seedBasics(ctx);
  ({ app } = await makeTestApp(ctx));
  admin = (await loginAs(app, seed.admin.email)).headers;
}

const templateBody = (over: Record<string, unknown> = {}) => ({
  companyName: 'Silva Advogados',
  channelId: seed.channelId,
  destinations: {
    atendimento: { sectorId: seed.defaultSector },
    financeiro: { sectorId: seed.sectorA, userId: seed.agentA.id },
    processos: { sectorId: seed.sectorB, userId: null },
  },
  ...over,
});
const fromTemplate = (payload: object, headers = admin) =>
  app.inject({ method: 'POST', url: '/api/bots/from-template', headers, payload });
const cpfFields = () => ctx.db.select().from(customFields).where(eq(customFields.name, 'CPF'));

describe('POST /api/bots/from-template', () => {
  beforeEach(boot);
  afterEach(async () => {
    await app.close();
  });

  it('creates a published, paused bot on the channel and the CPF field only once', async () => {
    const res = await fromTemplate(templateBody());
    expect(res.statusCode).toBe(200);
    const bot = res.json() as BotDto;
    expect(bot).toMatchObject({
      name: 'Fluxo do escritório',
      status: 'paused',
      startChannelIds: [seed.channelId],
      manualStart: false,
      publishedVersionNumber: 1,
      latestVersionNumber: 1,
    });

    const [field] = await cpfFields();
    expect(field).toMatchObject({ kind: 'cpf' });
    const v = await app.inject({ method: 'GET', url: `/api/bots/${bot.id}/versions/1`, headers: admin });
    const version = v.json() as BotVersionDto;
    expect(version).toMatchObject({ valid: true, published: true, problems: [] });
    expect(version.graph.nodes.find((n) => n.name === 'cpf')?.config.saveToField).toBe(field.id);
    expect(version.graph.nodes.find((n) => n.name === 'boas_vindas')?.config.text).toContain('da Silva Advogados.');

    const again = await fromTemplate(templateBody());
    expect(again.statusCode).toBe(200);
    expect((again.json() as BotDto).name).toBe('Fluxo do escritório (2)');
    expect(await cpfFields()).toHaveLength(1);
  });

  it('uses the given name and reuses an existing CPF field', async () => {
    const [existing] = await ctx.db.insert(customFields).values({ name: 'CPF', kind: 'text' }).returning();
    const res = await fromTemplate(templateBody({ name: 'Atendimento inicial' }));
    expect(res.statusCode).toBe(200);
    const bot = res.json() as BotDto;
    expect(bot.name).toBe('Atendimento inicial');
    const v = (await app.inject({ method: 'GET', url: `/api/bots/${bot.id}/versions/1`, headers: admin })).json() as BotVersionDto;
    expect(v.graph.nodes.find((n) => n.name === 'cpf')?.config.saveToField).toBe(existing.id);
    expect(await cpfFields()).toHaveLength(1);
  });

  it('rejects agents with 403', async () => {
    const agent = (await loginAs(app, seed.agentA.email)).headers;
    expect((await fromTemplate(templateBody(), agent)).statusCode).toBe(403);
  });

  it('rejects an unknown channel, sector or agent with 400 and creates nothing', async () => {
    const missing = randomUUID();
    const cases: Array<[object, string]> = [
      [templateBody({ channelId: missing }), 'Canal inexistente'],
      [
        templateBody({
          destinations: {
            atendimento: { sectorId: missing },
            financeiro: { sectorId: seed.sectorA },
            processos: { sectorId: seed.sectorB },
          },
        }),
        'Setor inexistente',
      ],
      [
        templateBody({
          destinations: {
            atendimento: { sectorId: seed.defaultSector },
            financeiro: { sectorId: seed.sectorA, userId: missing },
            processos: { sectorId: seed.sectorB },
          },
        }),
        'Atendente inexistente',
      ],
    ];
    for (const [payload, error] of cases) {
      const res = await fromTemplate(payload);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error });
    }
    expect((await fromTemplate(templateBody({ companyName: '  ' }))).statusCode).toBe(400); // zod
    expect(await ctx.db.$count(bots)).toBe(0);
    expect(await cpfFields()).toHaveLength(0);
  });
});
```

- [ ] **Step 7: Run the route tests to verify they fail**

Run: `npm test -w server -- test/bots/template.test.ts -t "from-template"`
Expected: FAIL. The route is not registered yet, so the first assertion reports `expected 404 to be 200`. The 400 cases fail the same way (`expected 404 to be 400`), and the agent case gets `expected 404 to be 403`.

- [ ] **Step 8: Register the route**

In `server/src/bots/routes.ts`, add this import next to the other `./` imports:

```ts
import { createOfficeTemplate } from './templates.js';
```

Task 11 does not declare `TemplateDest` or `TemplateBody`, so add exactly these lines (§3.10) above `registerBotRoutes`, below Task 11's `export const Name`. Admin access reuses Task 11's existing `const admin = { preHandler: requireAdmin };` (403 for agents), so no new http-error import is needed.

```ts
const TemplateDest = z.object({ sectorId: z.uuid(), userId: z.uuid().nullable().optional() });
const TemplateBody = z.object({ name: Name.optional(), companyName: z.string().trim().min(1).max(80), channelId: z.uuid(),
  destinations: z.object({ atendimento: TemplateDest, financeiro: TemplateDest, processos: TemplateDest }) });
```

Then add this block as the last statement inside `registerBotRoutes`, just before its closing `}`. It is a static path, so Fastify matches it ahead of the `/api/bots/:id…` routes whatever the order.

```ts
  app.post('/api/bots/from-template', admin, async (req) => {
    const body = TemplateBody.parse(req.body);
    return createOfficeTemplate(ctx, body, req.user.id);
  });
```

- [ ] **Step 9: Run the route tests to verify they pass**

Run: `npm test -w server -- test/bots/template.test.ts -t "from-template"`
Expected: PASS (4 tests).

- [ ] **Step 10: Commit**

```bash
git add server/src/bots/routes.ts server/test/bots/template.test.ts
git commit -m "feat(server): create a bot from the office template

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 11: Write the end-to-end test**

Append to `server/test/bots/template.test.ts`. It creates the template through the API, activates it, then plays a WhatsApp contact through `handleInbound` with the default hooks. These are the real channel-bot start and reply resume from Task 10. Each `say()` returns the texts the fake gateway sent during that message.

```ts
const PHONE = '5565999999999';
let seq = 0;

function inbound(body: string): Extract<InboundEvent, { type: 'message' }> {
  seq += 1;
  return {
    type: 'message',
    instance: seed.instance,
    externalId: `TPL${seq}`,
    direction: 'in',
    phone: PHONE,
    lid: null,
    pushName: 'Maria Cliente',
    kind: 'text',
    body,
    hasMedia: false,
    mediaMime: null,
    mediaName: null,
    replyToExternalId: null,
    sentAt: ctx.clock.now(),
    raw: {},
  };
}

async function say(body: string): Promise<string[]> {
  const before = ctx.wa.sent.length;
  await handleInbound(ctx, [inbound(body)]);
  await avatarRefreshesIdle();
  return ctx.wa.sent.slice(before).map((s) => (s.payload as { text: string }).text);
}

const theChat = async () => (await ctx.db.select().from(chats))[0]!;
const theRun = async () => (await ctx.db.select().from(botRuns))[0]!;
async function cpfValue(): Promise<string | undefined> {
  const [field] = await cpfFields();
  const [row] = await ctx.db.select().from(contactFieldValues).where(eq(contactFieldValues.fieldId, field!.id));
  return row?.value;
}

describe('Fluxo do escritório end to end', () => {
  let botId: string;

  beforeEach(async () => {
    await boot();
    ctx.clock.set(new Date('2026-10-14T13:00:00Z')); // Wednesday 09:00 in Cuiabá (UTC-4)
    const created = await fromTemplate(templateBody());
    botId = (created.json() as BotDto).id;
    const activated = await app.inject({
      method: 'POST',
      url: `/api/bots/${botId}/status`,
      headers: admin,
      payload: { status: 'active' },
    });
    expect(activated.statusCode).toBe(200);
  });
  afterEach(async () => {
    await app.close();
  });

  it('in hours: welcome, menu, invalid option, CPF invalid then valid, transfer and notification', async () => {
    const notify = vi.spyOn(ctx.hub, 'publishNotification');

    expect(await say('Bom dia')).toEqual([WELCOME, MENU]);
    expect(await theRun()).toMatchObject({ botId, state: 'waiting_reply', waitNodeId: 'menu' });
    expect((await theChat()).triagePending).toBe(false); // the bot took priority over triage

    const invalid = (await say('7')).join('\n');
    expect(invalid).toContain('Opção inválida.');
    expect(invalid).toContain('3: Processos'); // menu repeated once
    expect(await theRun()).toMatchObject({ state: 'waiting_reply', waitNodeId: 'menu', retries: 1 });

    expect(await say('2')).toEqual([NOTICE, CPF_ASK]);
    expect(await theRun()).toMatchObject({ state: 'waiting_reply', waitNodeId: 'cpf', retries: 0 });

    expect(await say('123.456.789-00')).toEqual([CPF_INVALID]); // wrong check digits
    expect(await cpfValue()).toBeUndefined();

    expect(await say('52998224725')).toEqual([]); // valid; transfer and notification send nothing on WhatsApp
    expect(await cpfValue()).toBe('529.982.247-25');

    const chat = await theChat();
    expect(chat).toMatchObject({ state: 'open', sectorId: seed.sectorA, ownerId: seed.agentA.id });
    const run = await theRun();
    expect(run.state).toBe('finished');
    expect(run.vars.menu).toMatchObject({ value: '2', label: 'Financeiro' });
    expect(run.vars.cpf).toMatchObject({ value: '529.982.247-25' });

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      chat.id,
      [seed.agentA.id],
      expect.objectContaining({
        chatId: chat.id,
        title: 'Nova conversa',
        text: 'Nova conversa de Maria Cliente — CPF 529.982.247-25',
        botName: 'Fluxo do escritório',
      }),
    );
    expect(ctx.hub.events).toContainEqual({ type: 'notification', chatId: chat.id, userId: seed.agentA.id });

    const out = await ctx.db.select().from(messages).where(eq(messages.direction, 'out'));
    expect(out).toHaveLength(ctx.wa.sent.length);
    for (const m of out) expect(m).toMatchObject({ botRunId: run.id, authorId: null, status: 'sent' });

    const kinds = (await eventsOf(ctx, chat.id)).map((e) => e.kind);
    expect(kinds.filter((k) => k === 'bot_started')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'bot_transferred')).toHaveLength(2); // sector, then agent
    expect(kinds.at(-1)).toBe('bot_finished');
  });

  it.each([
    ['at opening time', '2026-10-14T12:00:00Z'], // 08:00
    ['right after lunch', '2026-10-14T18:00:00Z'], // 14:00
  ])('in hours %s: greets with the menu', async (_label, at) => {
    ctx.clock.set(new Date(at));
    expect(await say('Olá')).toEqual([WELCOME, MENU]);
  });

  it.each([
    ['at lunch on a weekday', '2026-10-14T16:30:00Z'], // Wednesday 12:30
    ['at closing time', '2026-10-14T22:00:00Z'], // Wednesday 18:00 (`to` is exclusive)
    ['on a Saturday morning', '2026-10-17T14:00:00Z'], // Saturday 10:00
  ])('out of hours %s: sends the notice and leaves the chat open in the queue', async (_label, at) => {
    ctx.clock.set(new Date(at));
    expect(await say('Olá')).toEqual([OUT_OF_HOURS]);
    expect(await theRun()).toMatchObject({ state: 'finished' });
    expect(await theChat()).toMatchObject({ state: 'open', sectorId: seed.defaultSector, ownerId: null, triagePending: false });
    expect(await say('Alguém aí?')).toEqual([]); // same open chat: the bot does not start again
    expect(await ctx.db.$count(botRuns)).toBe(1);
  });

  it('a label answer and three invalid CPFs still route to Processos, with no agent and no notification', async () => {
    const notify = vi.spyOn(ctx.hub, 'publishNotification');
    await say('Oi');
    expect(await say('PROCESSOS')).toEqual([NOTICE, CPF_ASK]);
    expect(await say('123')).toEqual([CPF_INVALID]);
    expect(await say('não sei')).toEqual([CPF_INVALID]);
    expect(await say('123.456.789-00')).toEqual([]); // retries used up → invalid → destino

    expect(await theChat()).toMatchObject({ state: 'open', sectorId: seed.sectorB, ownerId: null });
    const run = await theRun();
    expect(run.state).toBe('finished');
    expect(run.vars.cpf).toBeUndefined();
    expect(await cpfValue()).toBeUndefined();
    expect(notify).not.toHaveBeenCalled();
  });

  it('no answer to the menu for 24 h ends the bot and keeps the chat open', async () => {
    await say('Oi');
    expect((await theRun()).timeoutAt?.toISOString()).toBe('2026-10-15T13:00:00.000Z');
    const sends = ctx.wa.sent.length;
    const scheduler = createScheduler(ctx);

    ctx.clock.advance(24 * 60 * 60 * 1000 - 1000);
    expect(await scheduler.tick(ctx.clock.now())).toBe(0);
    ctx.clock.advance(2000);
    expect(await scheduler.tick(ctx.clock.now())).toBe(1);

    expect(await theRun()).toMatchObject({ state: 'finished', timeoutAt: null });
    expect(ctx.wa.sent).toHaveLength(sends);
    expect((await theChat()).state).toBe('open');
  });
});
```

- [ ] **Step 12: Run the end-to-end test**

Run: `npm test -w server -- test/bots/template.test.ts -t "end to end"`
Expected: PASS (8 tests). This is an acceptance test over Tasks 5–11, which already ship the code it needs, so there is no new code to make it pass. If it fails, the defect is in the block or engine named by the failing assertion. Fix it there (superpowers:systematic-debugging) and add a regression test in that task's test file. Never loosen this test.

- [ ] **Step 13: Run the whole server suite and the typecheck**

Run: `npm test -w server`
Expected: PASS, every file, including the 18 tests in `test/bots/template.test.ts`.

Run: `npm run typecheck`
Expected: exit 0 for `shared`, `server` and `web`.

- [ ] **Step 14: Commit**

```bash
git add server/test/bots/template.test.ts
git commit -m "test(server): office template end to end through ingest

Hours in and out, menu with an invalid option, CPF invalid then valid and
saved to the field, transfer, notification and the 24 h menu timeout, driven
by the fake gateway and the fake clock.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


---

### Task 13: Web bots list and Conversas setting

Three cycles:
1. The API client: `ApiError.data`, the bot helpers, `api.bots`, `api.botRuns`, `botAction` and the `qk` keys.
2. The "Quando o atendente enviar mensagem com chatbot em execução" select in Settings › Conversas.
3. The Settings › Chatbots page, including "Criar a partir do modelo", import and export, duplicate, activate or pause, and delete with the "usado por" list, plus its nav entry.

**Files:**
- Modify: `web/src/lib/api.ts` (imports lines 2-18, `ApiError` 20-29, `SendTextInput`/`SendFileInput` 42-43, the `throw` at 81, `chats.transfer` 134-135, `chats.sendFile` 142-151, end of `api` 188-193, end of `qk` 214-215)
- Modify: `web/src/lib/api.test.ts` (append one `describe`)
- Modify: `web/src/pages/settings/ChatSettings.tsx` (whole file)
- Create: `web/src/pages/settings/ChatSettings.test.tsx`
- Modify: `web/src/components/conversation/ChatDialogs.tsx:7,28` (export `Modal` and `Actions`)
- Modify: `web/src/pages/settings/SettingsPage.tsx:12,22-23` (the `chatbots` section)
- Create: `web/src/pages/settings/bots/BotsSettings.tsx`
- Create: `web/src/pages/settings/bots/OfficeTemplateDialog.tsx`
- Test: `web/src/pages/settings/bots/BotsSettings.test.tsx`

**Interfaces:**
- Consumes:
  - Task 1 (`@talk/shared`): the types `BotAction`, `BotDto`, `BotExport`, `BotMediaDto`, `BotPatch`, `BotRunDto`, `BotRunningErrorBody`, `BotRunningBehavior`, `BotVersionDto`, `BotVersionSummaryDto`, `GraphProblem`, `ManualBotDto`, `OfficeTemplateDestination`, `OfficeTemplateInput`, `SaveVersionInput`.
  - Task 10: `SettingsDto.botRunningBehavior: BotRunningBehavior`, which is required, and `PUT /api/settings` accepting `botRunningBehavior`.
  - Task 11: the routes `GET/POST /api/bots`, `DELETE /api/bots/:id`, which can return 409 with `{ error, usedBy: [{ id, name }] }`, plus `POST /api/bots/:id/duplicate`, `POST /api/bots/:id/status`, `POST /api/bots/import` and `GET /api/bots/:id/export`.
  - Task 12: `POST /api/bots/from-template`, which takes `OfficeTemplateInput` and returns `BotDto`.
  - Existing code: `useSend`, `send`, `btn`, `btnPrimary`, `field`, `Section`, `Loading` and `ErrorText` (`components/settings/common.tsx`); `useCurrentUser` (`lib/auth.tsx`).
- Produces (later tasks import these exact names):
  - `web/src/lib/api.ts`:
    ```ts
    export class ApiError extends Error { constructor(public status: number, message: string, public correlationId?: string, public data?: unknown) }
    export function botRunningRuns(e: unknown): BotRunningErrorBody['runs'] | null;   // ApiError 409 whose data.code === 'BOT_RUNNING'
    export function graphProblems(e: unknown): GraphProblem[] | null;                 // ApiError 400 whose data.problems is an array
    export interface SendTextInput { text: string; signature: boolean; replyToId?: string; botAction?: BotAction }
    export interface SendFileInput { file: Blob; fileName?: string; text?: string; signature: boolean; replyToId?: string; asVoice?: boolean; botAction?: BotAction }
    api.chats.transfer(id: string, to: { sectorId?: string; ownerId?: string | null; botAction?: BotAction }): Promise<ChatDetail>
    api.bots: { list, create, get, update, remove, duplicate, versions, version, saveVersion, setStatus, importBot, exportUrl, uploadMedia, fromTemplate, manual } // signatures as in contract §3.11
    api.botRuns: { listForChat(chatId), start(chatId, botId), stop(runId) }
    qk.bots, qk.bot(id), qk.botVersions(id), qk.botVersion(id, n), qk.botManual, qk.chatBotRuns(chatId)
    ```
  - `web/src/components/conversation/ChatDialogs.tsx`: `export function Modal({ title, onCancel, children })` and `export function Actions({ busy, error, confirmLabel, onCancel, onConfirm })`. Task 16 finds both already exported and must not export them again.
  - `web/src/pages/settings/bots/BotsSettings.tsx`: `export function BotsSettings(): JSX.Element`.
  - `web/src/pages/settings/bots/OfficeTemplateDialog.tsx`: `export function OfficeTemplateDialog({ onCancel, onCreated }: { onCancel: () => void; onCreated: (bot: BotDto) => void })`.
  - Every bot name, and every "Editar" action, links to `/configuracoes/chatbots/:id`. Task 14 adds that route. Until then the link opens the app's NotFound page.

---

#### Cycle 1: API client

- [ ] **Step 1: Write the failing test**

Append this block to the end of `web/src/lib/api.test.ts`. Also change its first import line to the following:

```ts
import { api, ApiError, botRunningRuns, graphProblems, request } from './api';
```

```ts
describe('bot client', () => {
  it('keeps the error body in ApiError.data and reads the BOT_RUNNING runs from it', async () => {
    const body = { error: 'O chatbot está em execução nesta conversa', code: 'BOT_RUNNING', runs: [{ id: 'r1', botName: 'Fluxo' }] };
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => json(409, body)));
    const err = await api.chats.sendText('c1', { text: 'oi', signature: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, message: body.error, data: body });
    expect(botRunningRuns(err)).toEqual(body.runs);
    expect(graphProblems(err)).toBeNull();
  });

  it('reads graph problems from a 400 and ignores every other error', async () => {
    const problems = [{ nodeId: 'n1', message: 'Bloco sem entrada' }];
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => json(400, { error: 'O fluxo tem problemas', problems })));
    const err = await api.bots.saveVersion('b1', { graph: { nodes: [], edges: [] }, publish: true }).catch((e: unknown) => e);
    expect(graphProblems(err)).toEqual(problems);
    expect(botRunningRuns(err)).toBeNull();
    expect(botRunningRuns(new ApiError(409, 'Conflito'))).toBeNull();
    expect(botRunningRuns(new ApiError(409, 'Conflito', undefined, null))).toBeNull();
    expect(graphProblems(new Error('x'))).toBeNull();
  });

  it('sends botAction in the JSON of text and transfer, and before the file in multipart', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json(200, { id: 'm1' }));
    vi.stubGlobal('fetch', fetchMock);
    await api.chats.sendText('c1', { text: 'oi', signature: false, botAction: 'stop' });
    await api.chats.transfer('c1', { sectorId: 's1', botAction: 'keep' });
    await api.chats.sendFile('c1', { file: new File(['x'], 'a.pdf', { type: 'application/pdf' }), signature: true, botAction: 'keep' });
    expect(fetchMock.mock.calls[0]![1]?.body).toBe('{"text":"oi","signature":false,"botAction":"stop"}');
    expect(fetchMock.mock.calls[1]![1]?.body).toBe('{"sectorId":"s1","botAction":"keep"}');
    const form = fetchMock.mock.calls[2]![1]?.body as FormData;
    expect([...form.keys()]).toEqual(['signature', 'botAction', 'file']);
    expect(form.get('botAction')).toBe('keep');
  });

  it('calls the bot routes with the right method, path and body', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json(200, {}));
    vi.stubGlobal('fetch', fetchMock);
    const graph = { nodes: [], edges: [] };
    await api.bots.importBot({ name: 'Cobrança', graph });
    await api.bots.setStatus('b1', 'active');
    await api.bots.duplicate('b1');
    await api.bots.version('b1', 3);
    await api.botRuns.start('c1', 'b1');
    await api.botRuns.stop('r1');
    await api.bots.uploadMedia(new File(['png'], 'logo.png', { type: 'image/png' }));
    expect(fetchMock.mock.calls.map(([u, i]) => `${i?.method} ${String(u)}`)).toEqual([
      'POST /api/bots/import',
      'POST /api/bots/b1/status',
      'POST /api/bots/b1/duplicate',
      'GET /api/bots/b1/versions/3',
      'POST /api/chats/c1/bot-runs',
      'POST /api/bot-runs/r1/stop',
      'POST /api/bots/media',
    ]);
    expect(fetchMock.mock.calls[0]![1]?.body).toBe(JSON.stringify({ name: 'Cobrança', graph }));
    expect(fetchMock.mock.calls[1]![1]?.body).toBe('{"status":"active"}');
    expect(fetchMock.mock.calls[4]![1]?.body).toBe('{"botId":"b1"}');
    expect(((fetchMock.mock.calls[6]![1]?.body as FormData).get('file') as File).name).toBe('logo.png');
    expect(api.bots.exportUrl('b 1')).toBe('/api/bots/b%201/export');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w web -- src/lib/api.test.ts`
Expected: FAIL. The existing 12 tests pass. The 4 new ones fail: the first because `data` is missing from the `ApiError` (`toMatchObject`), and the others with `TypeError: Cannot read properties of undefined (reading 'saveVersion')` and `botRunningRuns is not a function`.

- [ ] **Step 3: Implement it in `web/src/lib/api.ts`**

3a. Replace the type import block (lines 2-18) with:

```ts
import type {
  BotAction,
  BotDto,
  BotExport,
  BotMediaDto,
  BotPatch,
  BotRunDto,
  BotRunningErrorBody,
  BotVersionDto,
  BotVersionSummaryDto,
  ChannelDto,
  ChatDetail,
  ChatListFilters,
  ChatListItem,
  ContactDto,
  ContactNoteDto,
  CustomFieldDto,
  GraphProblem,
  ManualBotDto,
  Me,
  MessageDto,
  OfficeTemplateInput,
  QuickAnswerDto,
  SaveVersionInput,
  SectorDto,
  SettingsDto,
  TagDto,
  TimelineItem,
  UserDto,
} from '@talk/shared';
```

3b. Replace the `ApiError` class (lines 20-29) with the class below, and add the two readers right after it:

```ts
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public correlationId?: string,
    /** Parsed error body (null when it was not JSON): carries `code`/`runs`, `problems`, `usedBy`. */
    public data?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** The runs from a 409 `{ code: 'BOT_RUNNING', runs }`; null for any other error. */
export function botRunningRuns(e: unknown): BotRunningErrorBody['runs'] | null {
  if (!(e instanceof ApiError) || e.status !== 409) return null;
  const d = e.data as Partial<BotRunningErrorBody> | null | undefined;
  return d?.code === 'BOT_RUNNING' && Array.isArray(d.runs) ? d.runs : null;
}

/** The problems from a 400 `{ error, problems }` (publish of an invalid graph); null for any other error. */
export function graphProblems(e: unknown): GraphProblem[] | null {
  if (!(e instanceof ApiError) || e.status !== 400) return null;
  const p = (e.data as { problems?: unknown } | null | undefined)?.problems;
  return Array.isArray(p) ? (p as GraphProblem[]) : null;
}
```

3c. Replace lines 42-43 (`SendTextInput` and `SendFileInput`) with:

```ts
export interface SendTextInput { text: string; signature: boolean; replyToId?: string; botAction?: BotAction }
export interface SendFileInput {
  file: Blob; fileName?: string; text?: string; signature: boolean; replyToId?: string; asVoice?: boolean; botAction?: BotAction;
}
```

3d. In `request()`, replace

```ts
    throw new ApiError(res.status, cid ? `${msg} (${cid})` : msg, cid);
```

with

```ts
    throw new ApiError(res.status, cid ? `${msg} (${cid})` : msg, cid, data);
```

3e. In `api.chats`, replace the `transfer` entry with:

```ts
    transfer: (id: string, to: { sectorId?: string; ownerId?: string | null; botAction?: BotAction }) =>
      request<ChatDetail>('POST', `/api/chats/${enc(id)}/transfer`, to),
```

and replace the whole `sendFile` entry with:

```ts
    sendFile: (id: string, input: SendFileInput) => {
      // @fastify/multipart only exposes fields that come BEFORE the file part — keep the file last.
      const form = new FormData();
      if (input.text) form.append('text', input.text);
      form.append('signature', String(input.signature));
      if (input.replyToId) form.append('replyToId', input.replyToId);
      if (input.asVoice) form.append('asVoice', 'true');
      if (input.botAction) form.append('botAction', input.botAction);
      form.append('file', input.file, input.fileName ?? (input.file instanceof File ? input.file.name : 'arquivo'));
      return request<MessageDto>('POST', `/api/chats/${enc(id)}/messages`, form);
    },
```

3f. At the end of the `api` object, replace

```ts
  channels: {
    list: () => request<ChannelDto[]>('GET', '/api/channels'),
    create: (name: string) => request<ChannelDto>('POST', '/api/channels', { name }),
    connect: (id: string) => request<{ qrBase64: string | null }>('POST', `/api/channels/${enc(id)}/connect`),
  },
});
```

with

```ts
  channels: {
    list: () => request<ChannelDto[]>('GET', '/api/channels'),
    create: (name: string) => request<ChannelDto>('POST', '/api/channels', { name }),
    connect: (id: string) => request<{ qrBase64: string | null }>('POST', `/api/channels/${enc(id)}/connect`),
  },
  bots: {
    list: () => request<BotDto[]>('GET', '/api/bots'),
    create: (input: { name: string; description?: string }) => request<BotDto>('POST', '/api/bots', input),
    get: (id: string) => request<BotDto>('GET', `/api/bots/${enc(id)}`),
    update: (id: string, patch: BotPatch) => request<BotDto>('PATCH', `/api/bots/${enc(id)}`, patch),
    remove: (id: string) => request<void>('DELETE', `/api/bots/${enc(id)}`),
    duplicate: (id: string) => request<BotDto>('POST', `/api/bots/${enc(id)}/duplicate`),
    versions: (id: string) => request<BotVersionSummaryDto[]>('GET', `/api/bots/${enc(id)}/versions`),
    version: (id: string, n: number) => request<BotVersionDto>('GET', `/api/bots/${enc(id)}/versions/${n}`),
    saveVersion: (id: string, input: SaveVersionInput) => request<BotVersionDto>('POST', `/api/bots/${enc(id)}/versions`, input),
    setStatus: (id: string, status: 'active' | 'paused') => request<BotDto>('POST', `/api/bots/${enc(id)}/status`, { status }),
    importBot: (data: BotExport) => request<BotDto>('POST', '/api/bots/import', data),
    exportUrl: (id: string) => `/api/bots/${enc(id)}/export`,
    uploadMedia: (file: Blob, name?: string) => {
      const form = new FormData();
      form.append('file', file, name ?? (file instanceof File ? file.name : 'arquivo'));
      return request<BotMediaDto>('POST', '/api/bots/media', form);
    },
    fromTemplate: (input: OfficeTemplateInput) => request<BotDto>('POST', '/api/bots/from-template', input),
    manual: () => request<ManualBotDto[]>('GET', '/api/bots/manual'),
  },
  botRuns: {
    listForChat: (chatId: string) => request<BotRunDto[]>('GET', `/api/chats/${enc(chatId)}/bot-runs`),
    start: (chatId: string, botId: string) => request<BotRunDto>('POST', `/api/chats/${enc(chatId)}/bot-runs`, { botId }),
    stop: (runId: string) => request<BotRunDto>('POST', `/api/bot-runs/${enc(runId)}/stop`),
  },
});
```

3g. At the end of `qk`, replace

```ts
  channels: ['channels'] as const,
};
```

with

```ts
  channels: ['channels'] as const,
  bots: ['bots'] as const,
  bot: (id: string) => ['bots', 'detail', id] as const,
  botVersions: (id: string) => ['bots', 'versions', id] as const,
  botVersion: (id: string, n: number) => ['bots', 'versions', id, n] as const,
  botManual: ['bots', 'manual'] as const,
  /** Under ['chats'] so the WS reconnect invalidation refreshes it too. */
  chatBotRuns: (chatId: string) => ['chats', 'bot-runs', chatId] as const,
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w web -- src/lib/api.test.ts`
Expected: PASS (16 tests).

Run: `npm run typecheck -w web`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/api.ts web/src/lib/api.test.ts
git commit -m "feat(web): cliente da API de chatbots e corpo do erro em ApiError.data

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

#### Cycle 2: Settings › Conversas, bot running behavior

- [ ] **Step 6: Write the failing test**

Create `web/src/pages/settings/ChatSettings.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SettingsDto } from '@talk/shared';
import { ChatSettings } from './ChatSettings';

const settings: SettingsDto = {
  closingMessage: 'Obrigado pelo contato!',
  triageMenu: { enabled: false, welcomeText: '', invalidText: '', options: [] },
  botRunningBehavior: 'ask',
};
const calls: Array<{ method: string; path: string; body: unknown }> = [];
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    if (path === '/api/settings' && method === 'GET') return json(settings);
    if (path === '/api/settings' && method === 'PUT') return json(body);
    return json({ error: 'inesperado' }, 500);
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('saves the bot running behavior together with the closing message', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ChatSettings />
    </QueryClientProvider>,
  );

  const select = (await screen.findByLabelText('Quando o atendente enviar mensagem com chatbot em execução')) as HTMLSelectElement;
  expect(select.value).toBe('ask');
  expect([...select.options].map((o) => o.text)).toEqual(['Perguntar', 'Parar o bot', 'Manter rodando']);

  fireEvent.change(select, { target: { value: 'stop' } });
  fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

  await screen.findByText('Configurações salvas.');
  expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ ...settings, botRunningBehavior: 'stop' });
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `npm test -w web -- src/pages/settings/ChatSettings.test.tsx`
Expected: FAIL with `Unable to find a label with the text of: Quando o atendente enviar mensagem com chatbot em execução`.

- [ ] **Step 8: Implement it**

Replace the whole of `web/src/pages/settings/ChatSettings.tsx` with:

```tsx
import { useId, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { BotRunningBehavior, SettingsDto } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { ErrorText, Loading, Section, btnPrimary, field, send, useSend } from '../../components/settings/common';

const BEHAVIORS: Array<{ value: BotRunningBehavior; label: string }> = [
  { value: 'ask', label: 'Perguntar' },
  { value: 'stop', label: 'Parar o bot' },
  { value: 'keep', label: 'Manter rodando' },
];

export function ChatSettings() {
  const settings = useQuery({ queryKey: qk.settings, queryFn: api.settings.get });
  if (!settings.data) return <Loading error={settings.error} />;
  return <ChatSettingsForm settings={settings.data} />;
}

function ChatSettingsForm({ settings }: { settings: SettingsDto }) {
  const [text, setText] = useState(settings.closingMessage);
  const [behavior, setBehavior] = useState<BotRunningBehavior>(settings.botRunningBehavior);
  const behaviorId = useId();
  const save = useSend(qk.settings);

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate(() => send('/api/settings', 'PUT', { ...settings, closingMessage: text.trim(), botRunningBehavior: behavior }));
  }

  return (
    <Section title="Conversas">
      <form onSubmit={submit} className="space-y-4">
        <label className="block text-sm font-medium">
          Mensagem de encerramento
          <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} className={field} />
          <span className="mt-1 block text-xs font-normal text-muted">
            Enviada ao contato quando o atendente finaliza a conversa com a opção “Enviar mensagem de encerramento” marcada.
            Deixe em branco para não usar.
          </span>
        </label>
        <div>
          <label htmlFor={behaviorId} className="block text-sm font-medium">
            Quando o atendente enviar mensagem com chatbot em execução
          </label>
          <select
            id={behaviorId}
            value={behavior}
            onChange={(e) => setBehavior(e.target.value as BotRunningBehavior)}
            className={field}
          >
            {BEHAVIORS.map((b) => (
              <option key={b.value} value={b.value}>
                {b.label}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-xs text-muted">
            Perguntar mostra um aviso antes de enviar. Parar o bot encerra o chatbot e envia. Manter rodando envia e deixa o
            chatbot continuar. A mesma regra vale para transferências feitas pelo atendente.
          </span>
        </div>
        <ErrorText error={save.error} />
        {save.isSuccess && <p className="text-sm text-success">Configurações salvas.</p>}
        <button type="submit" disabled={save.isPending} className={btnPrimary}>
          Salvar
        </button>
      </form>
    </Section>
  );
}
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `npm test -w web -- src/pages/settings/ChatSettings.test.tsx`
Expected: PASS (1 test).

- [ ] **Step 10: Commit**

```bash
git add web/src/pages/settings/ChatSettings.tsx web/src/pages/settings/ChatSettings.test.tsx
git commit -m "feat(web): opção do chatbot em execução em Configurações › Conversas

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

#### Cycle 3: Settings › Chatbots page

- [ ] **Step 11: Write the failing test**

Create `web/src/pages/settings/bots/BotsSettings.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useParams } from 'react-router';
import type { BotDto, ChannelDto, Me, SectorDto, UserDto } from '@talk/shared';
import { SettingsPage } from '../SettingsPage';

const admin: Me = { id: 'u-admin', name: 'Admin Teste', email: 'admin@teste.local', role: 'admin', signature: null, sectorIds: [], seeAllSectors: false, avatarUrl: null };
const agent: Me = { ...admin, id: 'u-agent', name: 'Ana Financeiro', role: 'agent' };
const channels: ChannelDto[] = [{ id: 'ch1', name: 'WhatsApp escritório', status: 'connected', phone: null }];
const sectors: SectorDto[] = [
  { id: 's-at', name: 'Atendimento', position: 0, isDefault: true },
  { id: 's-fin', name: 'Financeiro', position: 1, isDefault: false },
  { id: 's-jur', name: 'Jurídico', position: 2, isDefault: false },
];
const user = (over: Partial<UserDto>): UserDto => ({
  id: 'u', name: 'U', email: 'u@teste.local', role: 'agent', signature: null, active: true, sectorIds: [], avatarUrl: null, ...over,
});
const users: UserDto[] = [
  user({ id: 'u-ana', name: 'Ana Financeiro', sectorIds: ['s-fin'] }),
  user({ id: 'u-old', name: 'Carlos Inativo', sectorIds: ['s-fin'], active: false }),
];
const bot = (over: Partial<BotDto>): BotDto => ({
  id: 'b1', name: 'Fluxo do escritório', description: '', status: 'active', startChannelIds: ['ch1'], manualStart: false,
  manualTitle: '', manualUnlisted: false, publishedVersionId: 'v1', publishedVersionNumber: 1, latestVersionNumber: 2,
  runCount: 12, activeRunCount: 3, createdAt: '2026-10-10T12:00:00.000Z', updatedAt: '2026-10-14T15:30:00.000Z', ...over,
});
const office = bot({});
const draft = bot({
  id: 'b2', name: 'Cobrança', status: 'paused', startChannelIds: [], manualStart: true, publishedVersionId: null,
  publishedVersionNumber: null, latestVersionNumber: 1, runCount: 0, activeRunCount: 0,
});

interface Reply { status?: number; body?: unknown }
let routes: Record<string, Reply>;
const calls: Array<{ method: string; path: string; body: unknown }> = [];
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

beforeAll(() => {
  // jsdom has no showModal(); the dialogs only need it to open
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
});

beforeEach(() => {
  calls.length = 0;
  routes = {
    'GET /api/bots': { body: [office, draft] },
    'GET /api/channels': { body: channels },
    'GET /api/sectors': { body: sectors },
    'GET /api/users': { body: users },
  };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    const method = init?.method ?? 'GET';
    calls.push({ method, path, body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body });
    const reply = routes[`${method} ${path}`];
    if (!reply) return json({ error: 'inesperado' }, 500);
    if (reply.status === 204) return new Response(null, { status: 204 });
    return json(reply.body ?? null, reply.status ?? 200);
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function EditorStub() {
  const { id } = useParams();
  return <p>editor {id}</p>;
}

function renderAt(path: string, me: Me = admin) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(['me'], me);
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/configuracoes/chatbots/:id" element={<EditorStub />} />
          <Route path="/configuracoes/:section?" element={<SettingsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const called = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);

describe('Settings › Chatbots', () => {
  it('lists the bots with channels, status and runs, and links each one to its editor', async () => {
    renderAt('/configuracoes/chatbots');
    const officeRow = await screen.findByRole('row', { name: /Fluxo do escritório/ });
    expect(within(officeRow).getByText('WhatsApp escritório')).toBeTruthy();
    expect(within(officeRow).getByText('Ativo')).toBeTruthy();
    expect(within(officeRow).getByText('12 (3 em andamento)')).toBeTruthy();
    expect(within(officeRow).getByRole('link', { name: 'Fluxo do escritório' }).getAttribute('href')).toBe('/configuracoes/chatbots/b1');
    expect(within(officeRow).getByRole('link', { name: 'Editar' }).getAttribute('href')).toBe('/configuracoes/chatbots/b1');

    const draftRow = screen.getByRole('row', { name: /Cobrança/ });
    expect(within(draftRow).getByText('Início manual')).toBeTruthy();
    expect(within(draftRow).getByText('Rascunho')).toBeTruthy();
    expect(within(draftRow).getByText('0')).toBeTruthy();
    expect(within(draftRow).getByRole('link', { name: 'Exportar' }).getAttribute('href')).toBe('/api/bots/b2/export');

    const nav = screen.getByRole('navigation', { name: 'Configurações' });
    expect(within(nav).getByRole('link', { name: 'Chatbots' }).getAttribute('href')).toBe('/configuracoes/chatbots');
  });

  it('shows the Chatbots entry to admins only', async () => {
    renderAt('/configuracoes/chatbots', agent);
    const nav = await screen.findByRole('navigation', { name: 'Configurações' });
    expect(within(nav).queryByRole('link', { name: 'Chatbots' })).toBeNull();
    expect(called('GET', '/api/bots')).toHaveLength(0);
  });

  it('creates a bot from a name and opens the editor', async () => {
    routes['POST /api/bots'] = { body: bot({ id: 'b3', name: 'Boleto', status: 'paused', publishedVersionId: null }) };
    renderAt('/configuracoes/chatbots');
    fireEvent.click(await screen.findByRole('button', { name: 'Novo chatbot' }));
    fireEvent.change(screen.getByLabelText('Nome do chatbot'), { target: { value: ' Boleto ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Criar' }));

    await screen.findByText('editor b3');
    expect(called('POST', '/api/bots')[0]?.body).toEqual({ name: 'Boleto' });
  });

  it('pauses an active bot and only lets a published bot be activated', async () => {
    routes['POST /api/bots/b1/status'] = { body: bot({ status: 'paused' }) };
    renderAt('/configuracoes/chatbots');
    const officeRow = await screen.findByRole('row', { name: /Fluxo do escritório/ });
    const activate = within(screen.getByRole('row', { name: /Cobrança/ })).getByRole('button', { name: 'Ativar' }) as HTMLButtonElement;
    expect(activate.disabled).toBe(true);

    fireEvent.click(within(officeRow).getByRole('button', { name: 'Pausar' }));
    await waitFor(() => expect(called('POST', '/api/bots/b1/status')).toHaveLength(1));
    expect(called('POST', '/api/bots/b1/status')[0]?.body).toEqual({ status: 'paused' });
    await waitFor(() => expect(called('GET', '/api/bots')).toHaveLength(2)); // list refetched
  });

  it('duplicates a bot and refreshes the list', async () => {
    routes['POST /api/bots/b1/duplicate'] = { body: bot({ id: 'b4', name: 'Fluxo do escritório (cópia)' }) };
    renderAt('/configuracoes/chatbots');
    fireEvent.click(within(await screen.findByRole('row', { name: /Fluxo do escritório/ })).getByRole('button', { name: 'Duplicar' }));
    await waitFor(() => expect(called('POST', '/api/bots/b1/duplicate')).toHaveLength(1));
    await waitFor(() => expect(called('GET', '/api/bots')).toHaveLength(2));
  });

  it('asks before deleting and shows which flows still call the bot', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    routes['DELETE /api/bots/b2'] = {
      status: 409,
      body: {
        error: 'Este chatbot é acionado por outros fluxos',
        usedBy: [{ id: 'b1', name: 'Fluxo do escritório' }, { id: 'b7', name: 'Retorno' }],
      },
    };
    renderAt('/configuracoes/chatbots');
    fireEvent.click(within(await screen.findByRole('row', { name: /Cobrança/ })).getByRole('button', { name: 'Excluir' }));

    const alert = await screen.findByRole('alert');
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('"Cobrança"'));
    expect(alert.textContent).toContain('Este chatbot é acionado por outros fluxos');
    expect(alert.textContent).toContain('Usado por: Fluxo do escritório, Retorno');
  });

  it('does not delete when the confirmation is refused', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderAt('/configuracoes/chatbots');
    fireEvent.click(within(await screen.findByRole('row', { name: /Cobrança/ })).getByRole('button', { name: 'Excluir' }));
    expect(called('DELETE', '/api/bots/b2')).toHaveLength(0);
  });

  it('imports an exported file and rejects a file that is not JSON', async () => {
    routes['POST /api/bots/import'] = { body: bot({ id: 'b5', name: 'Cobrança (2)', status: 'paused', publishedVersionId: null }) };
    renderAt('/configuracoes/chatbots');
    const input = await screen.findByLabelText('Importar');
    const graph = { nodes: [{ id: 'n1', type: 'start_manual', position: { x: 0, y: 0 }, config: {}, name: 'inicio' }], edges: [] };
    const exported = new File([JSON.stringify({ name: 'Cobrança', graph })], 'cobranca.json', { type: 'application/json' });
    fireEvent.change(input, { target: { files: [exported] } });
    await waitFor(() => expect(called('POST', '/api/bots/import')[0]?.body).toEqual({ name: 'Cobrança', graph }));

    fireEvent.change(input, { target: { files: [new File(['não é json'], 'x.json', { type: 'application/json' })] } });
    expect((await screen.findByRole('alert')).textContent).toContain('Arquivo inválido: não é um JSON.');
    expect(called('POST', '/api/bots/import')).toHaveLength(1);
  });

  it('creates the office flow from the template and opens it in the editor', async () => {
    routes['POST /api/bots/from-template'] = { body: bot({ id: 'b9', status: 'paused' }) };
    renderAt('/configuracoes/chatbots');
    fireEvent.click(await screen.findByRole('button', { name: 'Criar a partir do modelo' }));

    const dialog = await screen.findByRole('dialog', { name: 'Criar a partir do modelo' });
    const financeiro = await within(dialog).findByRole('group', { name: 'Financeiro' });
    const processos = within(dialog).getByRole('group', { name: 'Processos' });
    expect((within(processos).getByLabelText('Setor') as HTMLSelectElement).value).toBe('s-jur'); // "Jurídico" guessed
    expect(within(financeiro).queryByRole('option', { name: 'Carlos Inativo' })).toBeNull();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Criar' }));
    expect(within(dialog).getByRole('alert').textContent).toBe('Informe o nome do escritório.');
    expect(called('POST', '/api/bots/from-template')).toHaveLength(0);

    fireEvent.change(within(dialog).getByLabelText('Nome do escritório'), { target: { value: ' JVO Advogados ' } });
    fireEvent.change(within(financeiro).getByLabelText('Atendente'), { target: { value: 'u-ana' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Criar' }));

    await screen.findByText('editor b9');
    expect(called('POST', '/api/bots/from-template')[0]?.body).toEqual({
      name: 'Fluxo do escritório',
      companyName: 'JVO Advogados',
      channelId: 'ch1',
      destinations: {
        atendimento: { sectorId: 's-at', userId: null },
        financeiro: { sectorId: 's-fin', userId: 'u-ana' },
        processos: { sectorId: 's-jur', userId: null },
      },
    });
  });
});
```

- [ ] **Step 12: Run the test to verify it fails**

Run: `npm test -w web -- src/pages/settings/bots/BotsSettings.test.tsx`
Expected: FAIL. `SettingsPage` has no `chatbots` section yet, so `/configuracoes/chatbots` redirects to Perfil. The admin tests fail with `Unable to find role="row"` or `Unable to find role="button" and name "Novo chatbot"`. Only `shows the Chatbots entry to admins only` passes.

- [ ] **Step 13: Export `Modal` and `Actions` from `web/src/components/conversation/ChatDialogs.tsx`**

Replace line 7

```tsx
function Modal({ title, onCancel, children }: { title: string; onCancel: () => void; children: ReactNode }) {
```

with

```tsx
export function Modal({ title, onCancel, children }: { title: string; onCancel: () => void; children: ReactNode }) {
```

and replace line 28

```tsx
function Actions(props: { busy: boolean; error: string | null; confirmLabel: string; onCancel: () => void; onConfirm: () => void }) {
```

with

```tsx
export function Actions(props: { busy: boolean; error: string | null; confirmLabel: string; onCancel: () => void; onConfirm: () => void }) {
```

- [ ] **Step 14: Create `web/src/pages/settings/bots/OfficeTemplateDialog.tsx`**

```tsx
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { BotDto, OfficeTemplateDestination, OfficeTemplateInput, SectorDto } from '@talk/shared';
import { Actions, Modal } from '../../../components/conversation/ChatDialogs';
import { Loading, field } from '../../../components/settings/common';
import { api, qk } from '../../../lib/api';

type DestKey = keyof OfficeTemplateInput['destinations'];
interface Picked { sectorId: string; userId: string }

const DESTS: Record<DestKey, { label: string; match: string[] }> = {
  atendimento: { label: 'Atendimento', match: ['atendimento'] },
  financeiro: { label: 'Financeiro', match: ['financeiro'] },
  processos: { label: 'Processos', match: ['processos', 'juridico'] },
};
const KEYS = Object.keys(DESTS) as DestKey[];
const input = `${field} bg-surface text-fg`;

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** First sector whose name contains one of the words (accents ignored), else the default sector. */
function guessSector(sectors: SectorDto[], words: string[]): string {
  const hit = sectors.find((s) => words.some((w) => fold(s.name).includes(w)));
  return (hit ?? sectors.find((s) => s.isDefault) ?? sectors[0])?.id ?? '';
}

/** "Criar a partir do modelo": channel + three destinations → POST /api/bots/from-template (created paused). */
export function OfficeTemplateDialog({ onCancel, onCreated }: { onCancel: () => void; onCreated: (bot: BotDto) => void }) {
  const channels = useQuery({ queryKey: qk.channels, queryFn: api.channels.list });
  const sectors = useQuery({ queryKey: qk.sectors, queryFn: api.sectors.list });
  const users = useQuery({ queryKey: qk.users, queryFn: api.users.list });
  const [name, setName] = useState('Fluxo do escritório');
  const [companyName, setCompanyName] = useState('');
  const [channelId, setChannelId] = useState('');
  const [picked, setPicked] = useState<Partial<Record<DestKey, Picked>>>({});
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: api.bots.fromTemplate,
    onSuccess: (bot) => onCreated(bot),
    onError: (e) => setError(e.message),
  });

  const ready = channels.data && sectors.data && users.data
    ? { channels: channels.data, sectors: sectors.data, users: users.data }
    : null;
  const channel = channelId || ready?.channels[0]?.id || '';
  const current = (k: DestKey): Picked =>
    picked[k] ?? { sectorId: guessSector(ready?.sectors ?? [], DESTS[k].match), userId: '' };
  const destination = (k: DestKey): OfficeTemplateDestination => {
    const v = current(k);
    return { sectorId: v.sectorId, userId: v.userId || null };
  };

  function submit() {
    const company = companyName.trim();
    if (!company) {
      setError('Informe o nome do escritório.');
      return;
    }
    if (!channel) {
      setError('Cadastre um canal antes de criar o fluxo.');
      return;
    }
    setError(null);
    create.mutate({
      ...(name.trim() ? { name: name.trim() } : {}),
      companyName: company,
      channelId: channel,
      destinations: {
        atendimento: destination('atendimento'),
        financeiro: destination('financeiro'),
        processos: destination('processos'),
      },
    });
  }

  return (
    <Modal title="Criar a partir do modelo" onCancel={onCancel}>
      {!ready ? (
        <Loading error={channels.error ?? sectors.error ?? users.error} />
      ) : (
        <div className="space-y-3 text-sm">
          <p className="text-xs text-muted">
            Recria o fluxo do escritório: horário de atendimento, boas-vindas, menu, comunicado, CPF e transferência. Textos e
            horários podem ser editados depois no editor. O chatbot é criado pausado.
          </p>
          <label className="block">
            Nome do chatbot
            <input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} className={input} />
          </label>
          <label className="block">
            Nome do escritório
            <input
              value={companyName}
              maxLength={80}
              placeholder="Aparece na mensagem de boas-vindas"
              onChange={(e) => setCompanyName(e.target.value)}
              className={input}
            />
          </label>
          <label className="block">
            Canal
            <select value={channel} onChange={(e) => setChannelId(e.target.value)} className={input}>
              {ready.channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          {KEYS.map((k) => {
            const v = current(k);
            const agents = ready.users.filter((u) => u.active && u.sectorIds.includes(v.sectorId));
            return (
              <fieldset key={k} className="rounded border border-border p-2">
                <legend className="px-1 text-xs font-medium">{DESTS[k].label}</legend>
                <div className="grid grid-cols-2 gap-2">
                  <label className="block">
                    Setor
                    <select
                      value={v.sectorId}
                      onChange={(e) => setPicked((p) => ({ ...p, [k]: { sectorId: e.target.value, userId: '' } }))}
                      className={input}
                    >
                      {ready.sectors.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    Atendente
                    <select
                      value={v.userId}
                      onChange={(e) => setPicked((p) => ({ ...p, [k]: { ...v, userId: e.target.value } }))}
                      className={input}
                    >
                      <option value="">Nenhum (fila do setor)</option>
                      {agents.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </fieldset>
            );
          })}
        </div>
      )}
      <Actions busy={create.isPending || !ready} error={error} confirmLabel="Criar" onCancel={onCancel} onConfirm={submit} />
    </Modal>
  );
}
```

- [ ] **Step 15: Create `web/src/pages/settings/bots/BotsSettings.tsx`**

```tsx
import { useState, type ChangeEvent, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { BotDto, BotExport } from '@talk/shared';
import { Loading, Section, btn, btnPrimary, field, useSend } from '../../../components/settings/common';
import { api, ApiError, qk } from '../../../lib/api';
import { OfficeTemplateDialog } from './OfficeTemplateDialog';

const editorPath = (id: string) => `/configuracoes/chatbots/${id}`;

function statusLabel(b: BotDto): string {
  if (b.status === 'active') return 'Ativo';
  return b.publishedVersionId ? 'Pausado' : 'Rascunho';
}

function runsLabel(b: BotDto): string {
  return b.activeRunCount > 0 ? `${b.runCount} (${b.activeRunCount} em andamento)` : String(b.runCount);
}

function channelsLabel(b: BotDto, names: Map<string, string>): string {
  const list = b.startChannelIds.map((id) => names.get(id) ?? 'Canal removido');
  if (b.manualStart) list.push('Início manual');
  return list.join(', ') || '—';
}

/** Names from the DELETE 409 `{ usedBy: [{ id, name }] }`; [] for any other error. */
function usedByNames(e: unknown): string[] {
  if (!(e instanceof ApiError)) return [];
  const list = (e.data as { usedBy?: unknown } | null | undefined)?.usedBy;
  return Array.isArray(list) ? list.map((b) => String((b as { name?: unknown }).name ?? '')) : [];
}

/** Catches the wrong file only; the server validates the graph again (zod) and recomputes `valid`. */
async function readExport(file: Blob): Promise<BotExport> {
  let data: unknown;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new Error('Arquivo inválido: não é um JSON.');
  }
  const d = data as Partial<BotExport> | null;
  if (!d || typeof d.name !== 'string' || !d.graph || !Array.isArray(d.graph.nodes) || !Array.isArray(d.graph.edges)) {
    throw new Error('Arquivo inválido: não é um chatbot exportado.');
  }
  return { name: d.name, graph: d.graph };
}

export function BotsSettings() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const bots = useQuery({ queryKey: qk.bots, queryFn: api.bots.list });
  const channels = useQuery({ queryKey: qk.channels, queryFn: api.channels.list });
  const save = useSend(qk.bots);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [template, setTemplate] = useState(false);

  if (!bots.data) return <Loading error={bots.error} />;
  const channelNames = new Map((channels.data ?? []).map((c) => [c.id, c.name]));
  const used = usedByNames(save.error);

  function create(e: FormEvent) {
    e.preventDefault();
    save.mutate(async () => {
      const bot = await api.bots.create({ name: name.trim() });
      navigate(editorPath(bot.id));
    });
  }

  function importFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // lets the same file be picked again
    if (file) save.mutate(async () => api.bots.importBot(await readExport(file)));
  }

  function toggle(b: BotDto) {
    save.mutate(() => api.bots.setStatus(b.id, b.status === 'active' ? 'paused' : 'active'));
  }

  function remove(b: BotDto) {
    if (window.confirm(`Excluir o chatbot "${b.name}"? As versões e o histórico de execuções também serão apagados.`)) {
      save.mutate(() => api.bots.remove(b.id));
    }
  }

  return (
    <Section
      title="Chatbots"
      action={
        <div className="flex flex-wrap justify-end gap-2">
          <label className={`${btn} cursor-pointer`}>
            Importar
            <input type="file" accept=".json,application/json" onChange={importFile} className="sr-only" />
          </label>
          <button type="button" onClick={() => setTemplate(true)} className={btn}>
            Criar a partir do modelo
          </button>
          <button
            type="button"
            onClick={() => {
              save.reset();
              setName('');
              setCreating(true);
            }}
            className={btnPrimary}
          >
            Novo chatbot
          </button>
        </div>
      }
    >
      {template && (
        <OfficeTemplateDialog
          onCancel={() => setTemplate(false)}
          onCreated={(bot) => {
            setTemplate(false);
            void qc.invalidateQueries({ queryKey: qk.bots });
            navigate(editorPath(bot.id));
          }}
        />
      )}
      {creating && (
        <form onSubmit={create} className="mb-4 flex items-end gap-2 rounded border border-border p-3">
          <label className="flex-1 text-sm">
            Nome do chatbot
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus className={field} />
          </label>
          <button type="submit" disabled={save.isPending || !name.trim()} className={btnPrimary}>
            Criar
          </button>
          <button type="button" onClick={() => setCreating(false)} className={btn}>
            Cancelar
          </button>
        </form>
      )}
      {save.error && (
        <div role="alert" className="my-2 text-sm text-danger">
          <p>{save.error.message}</p>
          {used.length > 0 && <p>Usado por: {used.join(', ')}</p>}
        </div>
      )}
      {bots.data.length === 0 ? (
        <p className="text-sm text-muted">Nenhum chatbot. Crie um novo, importe um arquivo ou comece pelo modelo do escritório.</p>
      ) : (
        <div className="overflow-x-auto rounded border border-border">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Nome</th>
                <th className="px-3 py-2 font-medium">Canais</th>
                <th className="px-3 py-2 font-medium">Situação</th>
                <th className="px-3 py-2 font-medium">Execuções</th>
                <th className="px-3 py-2 font-medium">Atualizado em</th>
                <th className="px-3 py-2">
                  <span className="sr-only">Ações</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {bots.data.map((b) => (
                <tr key={b.id} className="align-top">
                  <td className="px-3 py-2">
                    <Link to={editorPath(b.id)} className="font-medium hover:underline">
                      {b.name}
                    </Link>
                    {b.description && <span className="block text-xs text-muted">{b.description}</span>}
                  </td>
                  <td className="px-3 py-2">{channelsLabel(b, channelNames)}</td>
                  <td className="px-3 py-2">{statusLabel(b)}</td>
                  <td className="px-3 py-2">{runsLabel(b)}</td>
                  <td className="whitespace-nowrap px-3 py-2">
                    {new Date(b.updatedAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap justify-end gap-1">
                      <Link to={editorPath(b.id)} className={btn}>
                        Editar
                      </Link>
                      <button
                        type="button"
                        disabled={save.isPending || (b.status === 'paused' && !b.publishedVersionId)}
                        title={b.publishedVersionId ? undefined : 'Publique uma versão no editor antes de ativar'}
                        onClick={() => toggle(b)}
                        className={btn}
                      >
                        {b.status === 'active' ? 'Pausar' : 'Ativar'}
                      </button>
                      <button
                        type="button"
                        disabled={save.isPending}
                        onClick={() => save.mutate(() => api.bots.duplicate(b.id))}
                        className={btn}
                      >
                        Duplicar
                      </button>
                      <a href={api.bots.exportUrl(b.id)} download className={btn}>
                        Exportar
                      </a>
                      <button type="button" disabled={save.isPending} onClick={() => remove(b)} className={btn}>
                        Excluir
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}
```

- [ ] **Step 16: Register the section in `web/src/pages/settings/SettingsPage.tsx`**

After line 12 (`import { ChatSettings } from './ChatSettings';`), add:

```tsx
import { BotsSettings } from './bots/BotsSettings';
```

Replace lines 22-23

```tsx
  { path: 'triagem', label: 'Triagem', adminOnly: true, page: TriageSettings },
  { path: 'conversas', label: 'Conversas', adminOnly: true, page: ChatSettings },
```

with

```tsx
  { path: 'triagem', label: 'Triagem', adminOnly: true, page: TriageSettings },
  { path: 'chatbots', label: 'Chatbots', adminOnly: true, page: BotsSettings },
  { path: 'conversas', label: 'Conversas', adminOnly: true, page: ChatSettings },
```

- [ ] **Step 17: Run the test to verify it passes**

Run: `npm test -w web -- src/pages/settings/bots/BotsSettings.test.tsx`
Expected: PASS (9 tests).

- [ ] **Step 18: Run the whole web suite and the typecheck**

Run: `npm test -w web`
Expected: PASS. Every existing test still passes; `Composer.test.tsx` and the dialogs are unaffected by exporting `Modal` and `Actions`.

Run: `npm run typecheck -w web`
Expected: exits 0.

- [ ] **Step 19: Commit**

```bash
git add web/src/components/conversation/ChatDialogs.tsx web/src/pages/settings/SettingsPage.tsx web/src/pages/settings/bots/BotsSettings.tsx web/src/pages/settings/bots/OfficeTemplateDialog.tsx web/src/pages/settings/bots/BotsSettings.test.tsx
git commit -m "feat(web): Configurações › Chatbots com lista, modelo do escritório, importar e exportar

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


---

### Task 14: Web editor foundation

The full-screen editor at `/configuracoes/chatbots/:id` (spec §7). It has a React Flow 12 canvas with dots, a minimap and zoom controls. Each node is a card from `BLOCK_CATALOG` with one source handle per `outputsOf` output. The config body is delegated to `BlockConfigCard`, which Task 15 fills in; this task ships its fallback. The editor also has:
- a palette with search, the Tab shortcut, and drag or click to insert;
- connect (one edge per source handle), delete, and undo/redo (50 steps);
- dagre auto-layout;
- save draft, and save & publish with the server's problems highlighted;
- activate/pause, a versions panel (list, view read-only, restore as draft), name edit and export;
- a guard against leaving with unsaved changes.

**Files:**
- Create: `web/src/components/bot-editor/editor-state.ts`: pure graph operations, graph↔flow mapping, history, shortcuts
- Create: `web/src/components/bot-editor/layout.ts`: `autoLayout` with dagre
- Create: `web/src/components/bot-editor/icons.ts`: Phosphor name → component
- Create: `web/src/components/bot-editor/Palette.tsx`
- Create: `web/src/components/bot-editor/useEditorCatalog.ts`
- Create: `web/src/components/bot-editor/cards/index.tsx`: `BlockConfigCard` fallback, which Task 15 replaces
- Create: `web/src/components/bot-editor/BlockNode.tsx`
- Create: `web/src/components/bot-editor/Toolbar.tsx`
- Create: `web/src/components/bot-editor/VersionsPanel.tsx`
- Create: `web/src/components/bot-editor/ProblemsList.tsx`
- Create: `web/src/components/bot-editor/flow.css`: dark overrides for React Flow
- Create: `web/src/components/bot-editor/BotEditor.tsx`
- Create: `web/src/pages/settings/bots/BotEditorPage.tsx`
- Modify: `web/src/App.tsx`: the top-level route `/configuracoes/chatbots/:id`, placed before `/`
- Test: `web/src/components/bot-editor/editor-state.test.ts` (it also covers `layout.ts`)
- Test: `web/src/components/bot-editor/Palette.test.tsx`
- Test: `web/src/components/bot-editor/BotEditor.test.tsx`
- Test: `web/src/pages/settings/bots/BotEditorPage.test.tsx`

**Interfaces:**
- Consumes:
  - From Task 1 (`@talk/shared`):
    - Types: `BlockType`, `BlockCategory`, `BotGraph`, `BotNode`, `BotEdge`, `BotDto`, `BotPatch`, `BotVersionDto`, `BotVersionSummaryDto`, `GraphProblem`.
    - Values and functions: `BLOCK_TYPES`, `BLOCK_CATALOG`, `BLOCK_CATEGORY_LABELS`, `EDITOR_HISTORY_LIMIT` (50), `catalogEntry(type)`, `outputsOf(type, config)`, `defaultConfig(type)`, `nodeNameFor(type, taken)`.
    - Dependencies: `@xyflow/react@12.12.0` and `@dagrejs/dagre@3.1.1`, already installed in `web`.
  - From Task 13 (`web/src/lib/api.ts`):
    - `api.bots.get(id)`, `api.bots.list()`, `api.bots.update(id, patch)`, `api.bots.version(id, n)`, `api.bots.versions(id)`.
    - `api.bots.saveVersion(id, { graph, publish })`, `api.bots.setStatus(id, status)`, `api.bots.exportUrl(id)`.
    - `graphProblems(e: unknown): GraphProblem[] | null`, where `ApiError.data` carries the 400 body.
    - The keys `qk.bots`, `qk.bot(id)`, `qk.botVersions(id)` and `qk.botVersion(id, n)`.
    - The list page links its rows to `/configuracoes/chatbots/:id`, and the `chatbots` section lives at `/configuracoes/chatbots`.
  - Existing code:
    - `api.sectors|users|tags|customFields.list`, `api.channels.list` and `qk.sectors|users|tags|customFields|channels`.
    - `btn`, `btnPrimary`, `field` and `Loading` from `web/src/components/settings/common.tsx`.
    - `errorMessage(e)` from `web/src/components/conversation/model.ts`.
    - `useCurrentUser()` and `RequireAuth` from `web/src/lib/auth.tsx`.
- Produces (Task 15 relies on these exactly):
  ```ts
  // editor-state.ts
  export type BlockNodeData = { node: BotNode; problems: string[] };          // type alias: React Flow's Node<T> needs T extends Record<string, unknown>
  export type BlockFlowNode = import('@xyflow/react').Node<BlockNodeData, 'block'>;
  export function toFlowNodes(graph: BotGraph, problems: GraphProblem[]): BlockFlowNode[];
  export function toFlowEdges(graph: BotGraph): import('@xyflow/react').Edge[];
  export function canBeTarget(type: BlockType): boolean;                        // false for start blocks and sticky_note
  export function addNode(graph: BotGraph, type: BlockType, position: { x: number; y: number }): { graph: BotGraph; nodeId: string };
  export function connect(graph: BotGraph, c: { source: string; sourceHandle: string; target: string }): BotGraph;
  export function removeElements(graph: BotGraph, nodeIds: string[], edgeIds: string[]): BotGraph;
  export function updateNodeConfig(graph: BotGraph, nodeId: string, config: Record<string, unknown>): BotGraph;
  export function renameNode(graph: BotGraph, nodeId: string, name: string): BotGraph;
  export function moveNodes(graph: BotGraph, positions: Record<string, { x: number; y: number }>): BotGraph;
  export interface History { graph: BotGraph; canUndo: boolean; canRedo: boolean }
  export interface HistoryState { past: BotGraph[]; present: BotGraph; future: BotGraph[]; mergeKey: string | null }
  export function historyInit(graph: BotGraph): HistoryState;
  export function historyPush(h: HistoryState, graph: BotGraph, mergeKey?: string): HistoryState;
  export function historyUndo(h: HistoryState): HistoryState;
  export function historyRedo(h: HistoryState): HistoryState;
  export type GraphUpdate = BotGraph | ((g: BotGraph) => BotGraph);
  export function useGraphHistory(initial: BotGraph): History & { set(next: GraphUpdate, mergeKey?: string): void; undo(): void; redo(): void; reset(g: BotGraph): void };
  export type EditorShortcut = 'palette' | 'undo' | 'redo';
  export function shortcutFor(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'target'>): EditorShortcut | null;
  // layout.ts
  export const NODE_WIDTH = 280; export const NODE_HEIGHT = 160;
  export type NodeSizes = Record<string, { width: number; height: number }>;
  export function autoLayout(graph: BotGraph, sizes?: NodeSizes): BotGraph;    // dagre LR, nodesep 40, ranksep 80; sticky notes keep position
  // icons.ts
  export function blockIcon(name: string): import('@phosphor-icons/react').Icon;
  // useEditorCatalog.ts
  export interface EditorCatalog { sectors: SectorDto[]; users: UserDto[]; tags: TagDto[]; customFields: CustomFieldDto[]; channels: ChannelDto[]; bots: BotDto[] }
  export function useEditorCatalog(): EditorCatalog | null;
  // cards/index.tsx (Task 15 replaces the body of BlockConfigCard, keeps these exports)
  export interface BlockCardProps { node: BotNode; catalog: EditorCatalog; bot: BotDto; problems: string[];
    onChange(config: Record<string, unknown>): void; onBotChange(patch: BotPatch): void }
  export function BlockConfigCard(props: BlockCardProps): JSX.Element;
  // BlockNode.tsx
  export interface NodeActions { catalog: EditorCatalog | null; bot: BotDto; readOnly: boolean;
    changeConfig(nodeId: string, config: Record<string, unknown>): void; rename(nodeId: string, name: string): void;
    changeBot(patch: BotPatch): void; remove(nodeId: string): void }
  export const NodeActionsContext: React.Context<NodeActions | null>;
  export const CATEGORY_BORDER: Record<BlockCategory, string>;
  export function BlockNode(props: NodeProps<BlockFlowNode>): JSX.Element;
  // Palette.tsx
  export const PALETTE_DRAG_TYPE = 'application/x-talk-block';
  export function Palette(props: { open: boolean; onInsert(type: BlockType): void }): JSX.Element | null;
  // Toolbar.tsx, VersionsPanel.tsx, ProblemsList.tsx
  export function Toolbar(props: ToolbarProps): JSX.Element;
  export function VersionsPanel(props: { botId: string; onRestore(graph: BotGraph, number: number): void; onView?(version: BotVersionDto): void }): JSX.Element;
  export function ProblemsList(props: { problems: GraphProblem[]; onFocus(nodeId: string): void; labelOf?(nodeId: string): string }): JSX.Element | null;
  // BotEditor.tsx
  export function BotEditor(props: { bot: BotDto; initial: BotVersionDto }): JSX.Element; // `initial` is read once
  // pages/settings/bots/BotEditorPage.tsx
  export function BotEditorPage(): JSX.Element;
  ```

**What each part does:**
- **History.** `set` accepts an updater, so callbacks never close over a stale graph. Edits with the same `mergeKey`, such as `config:<id>` or `name:<id>`, collapse into one undo step, so typing in a card is not 40 steps.
- **Card body.** `BlockNode` reads the editor's callbacks from `NodeActionsContext`, which keeps the node data serializable, and renders `BlockConfigCard` inside `nodrag nowheel` so inputs never drag the canvas.
- **Bot fields.** Start cards call `onBotChange`. `BotEditor` keeps that pending `BotPatch`, together with the toolbar name, and PATCHes it before `saveVersion`.

- [ ] **Step 1: Confirm the Task 1 dependencies are installed**

Run: `npm ls -w web @xyflow/react @dagrejs/dagre`
Expected: `@xyflow/react@12.12.0` and `@dagrejs/dagre@3.1.1` are listed. If either is missing, Task 1 is not done, so stop here.

- [ ] **Step 2: Write the failing test for the pure helpers and the layout**

Create `web/src/components/bot-editor/editor-state.test.ts`:

```ts
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { EDITOR_HISTORY_LIMIT, defaultConfig, type BotGraph } from '@talk/shared';
import {
  addNode,
  canBeTarget,
  connect,
  historyInit,
  historyPush,
  historyRedo,
  historyUndo,
  moveNodes,
  removeElements,
  renameNode,
  shortcutFor,
  toFlowEdges,
  toFlowNodes,
  updateNodeConfig,
} from './editor-state';
import { autoLayout } from './layout';

const graph: BotGraph = {
  nodes: [
    { id: 'n1', type: 'start_channel', position: { x: 0, y: 0 }, config: {}, name: 'inicio' },
    {
      id: 'n2',
      type: 'ask_choice',
      position: { x: 300, y: 0 },
      name: 'menu',
      config: { text: 'Escolha', options: [{ key: '1', label: 'Atendimento' }, { key: '2', label: 'Financeiro' }], invalidRetries: 1, timeoutHours: null },
    },
    { id: 'n3', type: 'send_message', position: { x: 600, y: 0 }, name: 'mensagem', config: { text: 'Olá', attachment: null, signature: false } },
    { id: 'n4', type: 'sticky_note', position: { x: 50, y: 400 }, config: { text: 'lembrete', color: 'yellow' } },
    { id: 'n5', type: 'note', position: { x: 900, y: 0 }, name: 'nota', config: { text: 'Cliente atendido pelo bot' } },
  ],
  edges: [
    { id: 'e1', source: 'n1', sourceHandle: 'next', target: 'n2' },
    { id: 'e2', source: 'n2', sourceHandle: 'opt:2', target: 'n3' },
    { id: 'e3', source: 'n3', sourceHandle: 'next', target: 'n5' },
  ],
};

describe('graph ↔ flow mapping', () => {
  it('maps every node to a block node carrying only its own problems', () => {
    const nodes = toFlowNodes(graph, [
      { nodeId: 'n3', message: 'Texto obrigatório' },
      { nodeId: null, message: 'O fluxo precisa de um bloco de início' },
    ]);
    expect(nodes).toHaveLength(5);
    expect(nodes[2]).toMatchObject({ id: 'n3', type: 'block', position: { x: 600, y: 0 }, data: { node: graph.nodes[2], problems: ['Texto obrigatório'] } });
    expect(nodes[0]!.data.problems).toEqual([]);
  });

  it('maps edges with their source handle', () => {
    expect(toFlowEdges(graph)[1]).toEqual({ id: 'e2', source: 'n2', sourceHandle: 'opt:2', target: 'n3' });
  });
});

describe('graph operations', () => {
  it('adds a node with a unique contexto name and the default config, without touching the input', () => {
    const a = addNode(graph, 'condition', { x: 10, y: 20 });
    const b = addNode(a.graph, 'condition', { x: 0, y: 0 });
    expect(a.graph.nodes.find((n) => n.id === a.nodeId)).toMatchObject({
      type: 'condition',
      name: 'condition',
      position: { x: 10, y: 20 },
      config: defaultConfig('condition'),
    });
    expect(b.graph.nodes.find((n) => n.id === b.nodeId)!.name).toBe('condition_2');
    expect(a.nodeId).not.toBe(b.nodeId);
    expect(graph.nodes).toHaveLength(5);
    const sticky = addNode(graph, 'sticky_note', { x: 0, y: 0 });
    expect(sticky.graph.nodes.at(-1)!.name).toBeUndefined();
  });

  it('keeps one edge per source handle by replacing the old one', () => {
    const g2 = connect(graph, { source: 'n2', sourceHandle: 'opt:2', target: 'n5' });
    expect(g2.edges.filter((e) => e.source === 'n2' && e.sourceHandle === 'opt:2')).toEqual([expect.objectContaining({ target: 'n5' })]);
    expect(g2.edges).toHaveLength(3);
    expect(connect(g2, { source: 'n2', sourceHandle: 'opt:1', target: 'n3' }).edges).toHaveLength(4);
  });

  it('ignores connections to start or sticky blocks, unknown handles and repeats', () => {
    expect(canBeTarget('start_manual')).toBe(false);
    expect(canBeTarget('send_message')).toBe(true);
    expect(connect(graph, { source: 'n2', sourceHandle: 'opt:1', target: 'n1' })).toBe(graph);
    expect(connect(graph, { source: 'n2', sourceHandle: 'opt:1', target: 'n4' })).toBe(graph);
    expect(connect(graph, { source: 'n2', sourceHandle: 'opt:9', target: 'n3' })).toBe(graph);
    expect(connect(graph, { source: 'n2', sourceHandle: 'opt:2', target: 'n3' })).toBe(graph);
  });

  it('removes nodes with their edges, and single edges', () => {
    const g2 = removeElements(graph, ['n2'], []);
    expect(g2.nodes.map((n) => n.id)).toEqual(['n1', 'n3', 'n4', 'n5']);
    expect(g2.edges.map((e) => e.id)).toEqual(['e3']);
    expect(removeElements(graph, [], ['e3']).edges.map((e) => e.id)).toEqual(['e1', 'e2']);
  });

  it('drops the edges of outputs that a config change removed', () => {
    const menu = graph.nodes[1]!;
    const g2 = updateNodeConfig(graph, 'n2', { ...menu.config, options: [{ key: '1', label: 'Atendimento' }] });
    expect(g2.nodes[1]!.config.options).toEqual([{ key: '1', label: 'Atendimento' }]);
    expect(g2.edges.map((e) => e.id)).toEqual(['e1', 'e3']);
  });

  it('renames and moves nodes, and a move to the same spot changes nothing', () => {
    expect(renameNode(graph, 'n3', 'boas_vindas').nodes[2]!.name).toBe('boas_vindas');
    expect(moveNodes(graph, { n3: { x: 1, y: 2 } }).nodes[2]!.position).toEqual({ x: 1, y: 2 });
    expect(moveNodes(graph, { n3: { x: 600, y: 0 } })).toBe(graph);
  });
});

describe('history', () => {
  it('undoes and redoes, and a new edit clears the redo stack', () => {
    const g1 = renameNode(graph, 'n3', 'a');
    const g2 = renameNode(g1, 'n3', 'b');
    let h = historyPush(historyPush(historyInit(graph), g1), g2);
    h = historyUndo(h);
    expect(h.present).toBe(g1);
    h = historyUndo(h);
    expect(h.present).toBe(graph);
    expect(historyUndo(h)).toBe(h);
    h = historyRedo(h);
    expect(h.present).toBe(g1);
    h = historyPush(h, renameNode(g1, 'n3', 'c'));
    expect(h.future).toEqual([]);
    expect(historyRedo(h)).toBe(h);
  });

  it(`keeps at most ${EDITOR_HISTORY_LIMIT} undo steps`, () => {
    let h = historyInit(graph);
    for (let i = 0; i < EDITOR_HISTORY_LIMIT + 10; i++) h = historyPush(h, renameNode(graph, 'n3', `v${i}`));
    expect(h.past).toHaveLength(EDITOR_HISTORY_LIMIT);
    for (let i = 0; i < EDITOR_HISTORY_LIMIT; i++) h = historyUndo(h);
    expect(h.past).toHaveLength(0);
    expect(h.present.nodes[2]!.name).toBe('v9');
  });

  it('merges consecutive edits with the same key into one step and ignores no-ops', () => {
    let h = historyInit(graph);
    h = historyPush(h, renameNode(graph, 'n3', 'b'), 'name:n3');
    h = historyPush(h, renameNode(graph, 'n3', 'bo'), 'name:n3');
    expect(h.past).toHaveLength(1);
    expect(h.present.nodes[2]!.name).toBe('bo');
    h = historyPush(h, moveNodes(h.present, { n3: { x: 5, y: 5 } }));
    expect(h.past).toHaveLength(2);
    expect(historyPush(h, h.present)).toBe(h);
  });
});

describe('shortcuts', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });
  const key = (k: string, target: EventTarget | null, mods: Partial<Record<'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey', boolean>> = {}) => ({
    key: k,
    target,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...mods,
  });

  it('toggles the palette with Tab only from the page or the canvas, never while typing', () => {
    const canvas = document.createElement('div');
    canvas.className = 'react-flow';
    const inside = document.createElement('div');
    canvas.append(inside);
    const input = document.createElement('input');
    const toolbarButton = document.createElement('button');
    document.body.append(canvas, input, toolbarButton);
    expect(shortcutFor(key('Tab', document.body))).toBe('palette');
    expect(shortcutFor(key('Tab', inside))).toBe('palette');
    expect(shortcutFor(key('Tab', input))).toBeNull();
    expect(shortcutFor(key('Tab', toolbarButton))).toBeNull();
    expect(shortcutFor(key('Tab', document.body, { shiftKey: true }))).toBeNull();
  });

  it('maps Ctrl/Cmd+Z, Ctrl+Shift+Z and Ctrl+Y outside inputs', () => {
    const textarea = document.createElement('textarea');
    document.body.append(textarea);
    expect(shortcutFor(key('z', document.body, { ctrlKey: true }))).toBe('undo');
    expect(shortcutFor(key('Z', document.body, { metaKey: true, shiftKey: true }))).toBe('redo');
    expect(shortcutFor(key('y', document.body, { ctrlKey: true }))).toBe('redo');
    expect(shortcutFor(key('z', textarea, { ctrlKey: true }))).toBeNull();
    expect(shortcutFor(key('z', document.body))).toBeNull();
  });
});

describe('autoLayout', () => {
  it('lays the flow out left to right and leaves sticky notes and edges alone', () => {
    const out = autoLayout(graph);
    const x = (id: string) => out.nodes.find((n) => n.id === id)!.position.x;
    expect(x('n2') - x('n1')).toBeGreaterThanOrEqual(360); // 280 wide + ranksep 80
    expect(x('n3')).toBeGreaterThan(x('n2'));
    expect(x('n5')).toBeGreaterThan(x('n3'));
    expect(out.nodes.find((n) => n.id === 'n4')!.position).toEqual({ x: 50, y: 400 });
    expect(out.edges).toBe(graph.edges);
  });

  it('uses measured sizes so tall siblings do not overlap, without mutating them', () => {
    const fan: BotGraph = {
      nodes: [
        { id: 's', type: 'start_channel', position: { x: 0, y: 0 }, config: {}, name: 'inicio' },
        { id: 'a', type: 'ask_choice', position: { x: 0, y: 0 }, name: 'menu', config: { text: 'x', options: [{ key: '1', label: 'A' }, { key: '2', label: 'B' }], invalidRetries: 1 } },
        { id: 'b', type: 'send_message', position: { x: 0, y: 0 }, name: 'b', config: { text: 'b', signature: false } },
        { id: 'c', type: 'send_message', position: { x: 0, y: 0 }, name: 'c', config: { text: 'c', signature: false } },
      ],
      edges: [
        { id: 'e1', source: 's', sourceHandle: 'next', target: 'a' },
        { id: 'e2', source: 'a', sourceHandle: 'opt:1', target: 'b' },
        { id: 'e3', source: 'a', sourceHandle: 'opt:2', target: 'c' },
      ],
    };
    const sizes = { b: { width: 280, height: 400 }, c: { width: 280, height: 400 } };
    const out = autoLayout(fan, sizes);
    const pos = (id: string) => out.nodes.find((n) => n.id === id)!.position;
    expect(pos('b').x).toBe(pos('c').x);
    expect(Math.abs(pos('b').y - pos('c').y)).toBeGreaterThanOrEqual(400);
    expect(sizes.b).toEqual({ width: 280, height: 400 });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -w web -- src/components/bot-editor/editor-state.test.ts`
Expected: FAIL with `Failed to resolve import "./editor-state" from "src/components/bot-editor/editor-state.test.ts"`.

- [ ] **Step 4: Implement the pure helpers, the history hook and the layout**

Create `web/src/components/bot-editor/editor-state.ts`:

```ts
import { useCallback, useReducer } from 'react';
import type { Edge, Node } from '@xyflow/react';
import {
  EDITOR_HISTORY_LIMIT,
  catalogEntry,
  defaultConfig,
  nodeNameFor,
  outputsOf,
  type BlockType,
  type BotGraph,
  type BotNode,
  type GraphProblem,
} from '@talk/shared';

/** A type alias, not an interface: React Flow's Node<T> requires T extends Record<string, unknown>. */
export type BlockNodeData = { node: BotNode; problems: string[] };
export type BlockFlowNode = Node<BlockNodeData, 'block'>;

// ---------- graph ↔ React Flow ----------

export function toFlowNodes(graph: BotGraph, problems: GraphProblem[]): BlockFlowNode[] {
  const byNode = new Map<string, string[]>();
  for (const p of problems) {
    if (p.nodeId) byNode.set(p.nodeId, [...(byNode.get(p.nodeId) ?? []), p.message]);
  }
  return graph.nodes.map((node) => ({
    id: node.id,
    type: 'block' as const,
    position: node.position,
    data: { node, problems: byNode.get(node.id) ?? [] },
  }));
}

export function toFlowEdges(graph: BotGraph): Edge[] {
  return graph.edges.map((e) => ({ id: e.id, source: e.source, sourceHandle: e.sourceHandle, target: e.target }));
}

// ---------- graph operations (pure; every one returns a new graph or the same reference when nothing changed) ----------

/** Start blocks have no input and sticky notes never connect. */
export function canBeTarget(type: BlockType): boolean {
  return catalogEntry(type).category !== 'start' && type !== 'sticky_note';
}

export function addNode(graph: BotGraph, type: BlockType, position: { x: number; y: number }): { graph: BotGraph; nodeId: string } {
  const id = crypto.randomUUID();
  // ponytail: JSON round-trip = deep copy of a plain-JSON config, so two nodes never share arrays
  const config = JSON.parse(JSON.stringify(defaultConfig(type))) as Record<string, unknown>;
  const node: BotNode = { id, type, position: { x: position.x, y: position.y }, config };
  if (type !== 'sticky_note') node.name = nodeNameFor(type, graph.nodes.flatMap((n) => (n.name ? [n.name] : [])));
  return { graph: { ...graph, nodes: [...graph.nodes, node] }, nodeId: id };
}

/** One edge per (source, sourceHandle): a new connection replaces the old one. */
export function connect(graph: BotGraph, c: { source: string; sourceHandle: string; target: string }): BotGraph {
  const source = graph.nodes.find((n) => n.id === c.source);
  const target = graph.nodes.find((n) => n.id === c.target);
  if (!source || !target || source.type === 'sticky_note' || !canBeTarget(target.type)) return graph;
  if (!outputsOf(source.type, source.config).some((o) => o.id === c.sourceHandle)) return graph;
  const existing = graph.edges.find((e) => e.source === c.source && e.sourceHandle === c.sourceHandle);
  if (existing?.target === c.target) return graph;
  const edges = graph.edges.filter((e) => e !== existing);
  return { ...graph, edges: [...edges, { id: crypto.randomUUID(), source: c.source, sourceHandle: c.sourceHandle, target: c.target }] };
}

export function removeElements(graph: BotGraph, nodeIds: string[], edgeIds: string[]): BotGraph {
  const nodes = new Set(nodeIds);
  const edges = new Set(edgeIds);
  return {
    nodes: graph.nodes.filter((n) => !nodes.has(n.id)),
    edges: graph.edges.filter((e) => !edges.has(e.id) && !nodes.has(e.source) && !nodes.has(e.target)),
  };
}

/** Replaces the config, then drops the edges whose handle is no longer in outputsOf (e.g. a removed option). */
export function updateNodeConfig(graph: BotGraph, nodeId: string, config: Record<string, unknown>): BotGraph {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) return graph;
  const handles = new Set(outputsOf(node.type, config).map((o) => o.id));
  return {
    nodes: graph.nodes.map((n) => (n.id === nodeId ? { ...n, config } : n)),
    edges: graph.edges.filter((e) => e.source !== nodeId || handles.has(e.sourceHandle)),
  };
}

export function renameNode(graph: BotGraph, nodeId: string, name: string): BotGraph {
  return { ...graph, nodes: graph.nodes.map((n) => (n.id === nodeId ? { ...n, name } : n)) };
}

export function moveNodes(graph: BotGraph, positions: Record<string, { x: number; y: number }>): BotGraph {
  let changed = false;
  const nodes = graph.nodes.map((n) => {
    const p = positions[n.id];
    if (!p || (p.x === n.position.x && p.y === n.position.y)) return n;
    changed = true;
    return { ...n, position: { x: p.x, y: p.y } };
  });
  return changed ? { ...graph, nodes } : graph;
}

// ---------- undo / redo ----------

export interface History { graph: BotGraph; canUndo: boolean; canRedo: boolean }
export interface HistoryState { past: BotGraph[]; present: BotGraph; future: BotGraph[]; mergeKey: string | null }

export function historyInit(graph: BotGraph): HistoryState {
  return { past: [], present: graph, future: [], mergeKey: null };
}

/** Same mergeKey as the previous push → replace the present instead of adding a step (typing in a card). */
export function historyPush(h: HistoryState, graph: BotGraph, mergeKey?: string): HistoryState {
  if (graph === h.present) return h;
  if (mergeKey !== undefined && mergeKey === h.mergeKey) return { ...h, present: graph, future: [] };
  return { past: [...h.past, h.present].slice(-EDITOR_HISTORY_LIMIT), present: graph, future: [], mergeKey: mergeKey ?? null };
}

export function historyUndo(h: HistoryState): HistoryState {
  const previous = h.past.at(-1);
  if (!previous) return h;
  return { past: h.past.slice(0, -1), present: previous, future: [h.present, ...h.future], mergeKey: null };
}

export function historyRedo(h: HistoryState): HistoryState {
  const [next, ...rest] = h.future;
  if (!next) return h;
  return { past: [...h.past, h.present].slice(-EDITOR_HISTORY_LIMIT), present: next, future: rest, mergeKey: null };
}

export type GraphUpdate = BotGraph | ((g: BotGraph) => BotGraph);
type HistoryAction =
  | { type: 'set'; next: GraphUpdate; mergeKey?: string }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'reset'; graph: BotGraph };

function historyReducer(h: HistoryState, a: HistoryAction): HistoryState {
  switch (a.type) {
    case 'set':
      return historyPush(h, typeof a.next === 'function' ? a.next(h.present) : a.next, a.mergeKey);
    case 'undo':
      return historyUndo(h);
    case 'redo':
      return historyRedo(h);
    case 'reset':
      return historyInit(a.graph);
  }
}

/** `set` takes a graph or an updater (so callbacks never close over a stale graph); all callbacks are stable. */
export function useGraphHistory(initial: BotGraph): History & {
  set(next: GraphUpdate, mergeKey?: string): void;
  undo(): void;
  redo(): void;
  reset(g: BotGraph): void;
} {
  const [h, dispatch] = useReducer(historyReducer, initial, historyInit);
  const set = useCallback((next: GraphUpdate, mergeKey?: string) => dispatch({ type: 'set', next, mergeKey }), []);
  const undo = useCallback(() => dispatch({ type: 'undo' }), []);
  const redo = useCallback(() => dispatch({ type: 'redo' }), []);
  const reset = useCallback((graph: BotGraph) => dispatch({ type: 'reset', graph }), []);
  return { graph: h.present, canUndo: h.past.length > 0, canRedo: h.future.length > 0, set, undo, redo, reset };
}

// ---------- keyboard ----------

export type EditorShortcut = 'palette' | 'undo' | 'redo';

/** Inputs keep their own keys (Tab moves focus, Ctrl+Z undoes text). Tab toggles the palette only from the page or the canvas. */
export function shortcutFor(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'target'>): EditorShortcut | null {
  const el = e.target instanceof Element ? e.target : null;
  if (el?.closest('input, textarea, select, [contenteditable="true"]')) return null;
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === 'Tab') {
    if (mod || e.altKey || e.shiftKey) return null;
    return !el || el === document.body || el.closest('.react-flow') ? 'palette' : null;
  }
  if (!mod || e.altKey) return null;
  const k = e.key.toLowerCase();
  if (k === 'z') return e.shiftKey ? 'redo' : 'undo';
  if (k === 'y') return 'redo';
  return null;
}
```

Create `web/src/components/bot-editor/layout.ts`:

```ts
import dagre from '@dagrejs/dagre';
import type { BotGraph } from '@talk/shared';

export const NODE_WIDTH = 280;
export const NODE_HEIGHT = 160;
export type NodeSizes = Record<string, { width: number; height: number }>;

/**
 * Left-to-right dagre layout (nodesep 40, ranksep 80). `sizes` are the measured card sizes;
 * a node without one counts as 280×160. Sticky notes keep their position.
 */
export function autoLayout(graph: BotGraph, sizes: NodeSizes = {}): BotGraph {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 80 });
  g.setDefaultEdgeLabel(() => ({}));
  const size = (id: string) => sizes[id] ?? { width: NODE_WIDTH, height: NODE_HEIGHT };
  for (const n of graph.nodes) {
    if (n.type !== 'sticky_note') g.setNode(n.id, { ...size(n.id) }); // copy: dagre writes x/y into the label
  }
  for (const e of graph.edges) {
    if (g.hasNode(e.source) && g.hasNode(e.target)) g.setEdge(e.source, e.target);
  }
  dagre.layout(g);
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      if (!g.hasNode(n.id)) return n;
      const { x, y } = g.node(n.id) as { x: number; y: number };
      const { width, height } = size(n.id);
      return { ...n, position: { x: Math.round(x - width / 2), y: Math.round(y - height / 2) } }; // dagre gives centers
    }),
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -w web -- src/components/bot-editor/editor-state.test.ts`
Expected: PASS (15 tests).

- [ ] **Step 6: Commit**

```bash
git add web/src/components/bot-editor/editor-state.ts web/src/components/bot-editor/layout.ts web/src/components/bot-editor/editor-state.test.ts
git commit -m "feat(web): bot editor graph operations, history and auto-layout" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Write the failing palette test**

Create `web/src/components/bot-editor/Palette.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { BLOCK_CATALOG } from '@talk/shared';
import { PALETTE_DRAG_TYPE, Palette } from './Palette';

afterEach(cleanup);

it('lists every block under its category', () => {
  render(<Palette open onInsert={() => {}} />);
  for (const heading of ['Início', 'Condições', 'Ações', 'Finalização', 'Utilitários']) {
    expect(screen.getByRole('heading', { name: heading })).toBeTruthy();
  }
  expect(screen.getAllByRole('button')).toHaveLength(BLOCK_CATALOG.length);
});

it('filters by label or description, ignoring accents and case', () => {
  render(<Palette open onInsert={() => {}} />);
  const search = screen.getByRole('searchbox', { name: 'Buscar bloco' });
  fireEvent.change(search, { target: { value: 'CONDIC' } });
  expect(screen.getByRole('button', { name: 'Condição' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Várias condições' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Enviar mensagem' })).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Ações' })).toBeNull();
  fireEvent.change(search, { target: { value: 'horario' } });
  expect(screen.getByRole('button', { name: 'Horário' })).toBeTruthy();
  fireEvent.change(search, { target: { value: 'zzz' } });
  expect(screen.getByText('Nenhum bloco encontrado.')).toBeTruthy();
});

it('inserts on click and carries the block type on drag', () => {
  const onInsert = vi.fn();
  render(<Palette open onInsert={onInsert} />);
  fireEvent.click(screen.getByRole('button', { name: 'Enviar mensagem' }));
  expect(onInsert).toHaveBeenCalledWith('send_message');
  const setData = vi.fn();
  fireEvent.dragStart(screen.getByRole('button', { name: 'Pedir para escolher' }), { dataTransfer: { setData, effectAllowed: 'none' } });
  expect(setData).toHaveBeenCalledWith(PALETTE_DRAG_TYPE, 'ask_choice');
});

it('renders nothing when closed', () => {
  const { container } = render(<Palette open={false} onInsert={() => {}} />);
  expect(container.innerHTML).toBe('');
});
```

- [ ] **Step 8: Run the test to verify it fails**

Run: `npm test -w web -- src/components/bot-editor/Palette.test.tsx`
Expected: FAIL with `Failed to resolve import "./Palette" from "src/components/bot-editor/Palette.test.tsx"`.

- [ ] **Step 9: Implement the icon map and the palette**

Create `web/src/components/bot-editor/icons.ts`:

```ts
import {
  ArrowsLeftRightIcon,
  BellRingingIcon,
  BroadcastIcon,
  CalendarBlankIcon,
  ChatTextIcon,
  CheckCircleIcon,
  ClockIcon,
  CubeIcon,
  EqualsIcon,
  FlowArrowIcon,
  GitBranchIcon,
  HandTapIcon,
  HourglassIcon,
  HourglassMediumIcon,
  IdentificationCardIcon,
  ListNumbersIcon,
  LockSimpleIcon,
  MagnifyingGlassIcon,
  NoteIcon,
  NotePencilIcon,
  PencilSimpleIcon,
  ProhibitIcon,
  PulseIcon,
  RobotIcon,
  ShuffleIcon,
  SparkleIcon,
  TagIcon,
  TagSimpleIcon,
  TextboxIcon,
  TreeStructureIcon,
  UserCircleIcon,
  UserSwitchIcon,
  UsersThreeIcon,
  WhatsappLogoIcon,
  type Icon,
} from '@phosphor-icons/react';

// Keys are the `icon` names in BLOCK_CATALOG (Phosphor component names without the "Icon" suffix).
const ICONS: Record<string, Icon> = {
  WhatsappLogo: WhatsappLogoIcon,
  HandTap: HandTapIcon,
  CalendarBlank: CalendarBlankIcon,
  Clock: ClockIcon,
  Hourglass: HourglassIcon,
  GitBranch: GitBranchIcon,
  TreeStructure: TreeStructureIcon,
  Equals: EqualsIcon,
  Shuffle: ShuffleIcon,
  Pulse: PulseIcon,
  Sparkle: SparkleIcon,
  IdentificationCard: IdentificationCardIcon,
  Tag: TagIcon,
  UsersThree: UsersThreeIcon,
  Broadcast: BroadcastIcon,
  UserCircle: UserCircleIcon,
  HourglassMedium: HourglassMediumIcon,
  MagnifyingGlass: MagnifyingGlassIcon,
  Robot: RobotIcon,
  ChatText: ChatTextIcon,
  NotePencil: NotePencilIcon,
  ListNumbers: ListNumbersIcon,
  Textbox: TextboxIcon,
  PencilSimple: PencilSimpleIcon,
  TagSimple: TagSimpleIcon,
  ArrowsLeftRight: ArrowsLeftRightIcon,
  UserSwitch: UserSwitchIcon,
  LockSimple: LockSimpleIcon,
  BellRinging: BellRingingIcon,
  FlowArrow: FlowArrowIcon,
  Prohibit: ProhibitIcon,
  CheckCircle: CheckCircleIcon,
  Note: NoteIcon,
};

export function blockIcon(name: string): Icon {
  return ICONS[name] ?? CubeIcon;
}
```

Create `web/src/components/bot-editor/Palette.tsx`:

```tsx
import { useState } from 'react';
import { BLOCK_CATALOG, BLOCK_CATEGORY_LABELS, type BlockCategory, type BlockType } from '@talk/shared';
import { field } from '../settings/common';
import { blockIcon } from './icons';

/** dataTransfer type the canvas reads on drop. */
export const PALETTE_DRAG_TYPE = 'application/x-talk-block';

const CATEGORIES = Object.keys(BLOCK_CATEGORY_LABELS) as BlockCategory[];
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export interface PaletteProps {
  open: boolean;
  onInsert(type: BlockType): void;
}

export function Palette({ open, onInsert }: PaletteProps) {
  const [query, setQuery] = useState('');
  if (!open) return null;
  const needle = fold(query.trim());
  const matches = BLOCK_CATALOG.filter((e) => !needle || fold(`${e.label} ${e.description}`).includes(needle));

  return (
    <aside aria-label="Paleta de blocos" className="flex w-64 shrink-0 flex-col border-r border-border bg-panel">
      <div className="p-3">
        <input
          type="search"
          aria-label="Buscar bloco"
          placeholder="Buscar bloco…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className={`${field} bg-surface`}
        />
        <p className="mt-1 text-xs text-muted">Clique ou arraste para inserir. Tab abre e fecha.</p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {CATEGORIES.map((category) => {
          const list = matches.filter((e) => e.category === category);
          if (list.length === 0) return null;
          return (
            <section key={category} className="mb-3">
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">{BLOCK_CATEGORY_LABELS[category]}</h3>
              <ul className="space-y-1">
                {list.map((entry) => {
                  const Icon = blockIcon(entry.icon);
                  return (
                    <li key={entry.type}>
                      <button
                        type="button"
                        draggable
                        aria-label={entry.label}
                        title={entry.description}
                        onClick={() => onInsert(entry.type)}
                        onDragStart={(e) => {
                          e.dataTransfer.setData(PALETTE_DRAG_TYPE, entry.type);
                          e.dataTransfer.effectAllowed = 'move';
                        }}
                        className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-sidebar-hover"
                      >
                        <Icon size={16} className="mt-0.5 shrink-0" aria-hidden />
                        <span>
                          <span className="block">{entry.label}</span>
                          <span className="block text-xs text-muted">{entry.description}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
        {matches.length === 0 && <p className="text-sm text-muted">Nenhum bloco encontrado.</p>}
      </div>
    </aside>
  );
}
```

- [ ] **Step 10: Run the test to verify it passes**

Run: `npm test -w web -- src/components/bot-editor/Palette.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 11: Commit**

```bash
git add web/src/components/bot-editor/icons.ts web/src/components/bot-editor/Palette.tsx web/src/components/bot-editor/Palette.test.tsx
git commit -m "feat(web): bot editor block palette with search" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 12: Write the failing editor interaction test**

Create `web/src/components/bot-editor/BotEditor.test.tsx`:

```tsx
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
    this.cb([{ target } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
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
```

- [ ] **Step 13: Run the test to verify it fails**

Run: `npm test -w web -- src/components/bot-editor/BotEditor.test.tsx`
Expected: FAIL with `Failed to resolve import "./BotEditor" from "src/components/bot-editor/BotEditor.test.tsx"`.

- [ ] **Step 14: Implement the catalog hook, the fallback card and the node**

Create `web/src/components/bot-editor/useEditorCatalog.ts`:

```ts
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { BotDto, ChannelDto, CustomFieldDto, SectorDto, TagDto, UserDto } from '@talk/shared';
import { api, qk } from '../../lib/api';

export interface EditorCatalog {
  sectors: SectorDto[];
  users: UserDto[];
  tags: TagDto[];
  customFields: CustomFieldDto[];
  channels: ChannelDto[];
  bots: BotDto[];
}

/** Everything the block cards pick from (selects of sectors, agents, tags, fields, channels, bots). null until all have loaded. */
export function useEditorCatalog(): EditorCatalog | null {
  const sectors = useQuery({ queryKey: qk.sectors, queryFn: api.sectors.list });
  const users = useQuery({ queryKey: qk.users, queryFn: api.users.list });
  const tags = useQuery({ queryKey: qk.tags, queryFn: api.tags.list });
  const customFields = useQuery({ queryKey: qk.customFields, queryFn: api.customFields.list });
  const channels = useQuery({ queryKey: qk.channels, queryFn: api.channels.list });
  const bots = useQuery({ queryKey: qk.bots, queryFn: api.bots.list });
  return useMemo(
    () =>
      sectors.data && users.data && tags.data && customFields.data && channels.data && bots.data
        ? { sectors: sectors.data, users: users.data, tags: tags.data, customFields: customFields.data, channels: channels.data, bots: bots.data }
        : null,
    [sectors.data, users.data, tags.data, customFields.data, channels.data, bots.data],
  );
}
```

Create `web/src/components/bot-editor/cards/index.tsx`:

```tsx
import type { JSX } from 'react';
import { catalogEntry, type BotDto, type BotNode, type BotPatch } from '@talk/shared';
import type { EditorCatalog } from '../useEditorCatalog';

export interface BlockCardProps {
  node: BotNode;
  catalog: EditorCatalog;
  bot: BotDto; // with the editor's pending BotPatch applied
  problems: string[];
  onChange(config: Record<string, unknown>): void;
  onBotChange(patch: BotPatch): void;
}

/** Task 15 replaces this body with a switch on node.type. Until then every block only shows its description. */
export function BlockConfigCard({ node }: BlockCardProps): JSX.Element {
  return <p className="text-xs text-muted">{catalogEntry(node.type).description}</p>;
}
```

Create `web/src/components/bot-editor/BlockNode.tsx`:

```tsx
import { createContext, useContext, useEffect } from 'react';
import { Handle, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { TrashIcon } from '@phosphor-icons/react';
import { catalogEntry, outputsOf, type BlockCategory, type BotDto, type BotPatch } from '@talk/shared';
import { field } from '../settings/common';
import { BlockConfigCard } from './cards';
import { canBeTarget, type BlockFlowNode } from './editor-state';
import { blockIcon } from './icons';
import type { EditorCatalog } from './useEditorCatalog';

/** What a node needs from the editor. Kept out of node.data so the data stays a plain BotNode. */
export interface NodeActions {
  catalog: EditorCatalog | null;
  bot: BotDto; // with the pending BotPatch applied
  readOnly: boolean; // viewing an old version
  changeConfig(nodeId: string, config: Record<string, unknown>): void;
  rename(nodeId: string, name: string): void;
  changeBot(patch: BotPatch): void;
  remove(nodeId: string): void;
}

export const NodeActionsContext = createContext<NodeActions | null>(null);

export const CATEGORY_BORDER: Record<BlockCategory, string> = {
  start: 'border-success',
  condition: 'border-amber-500',
  action: 'border-primary',
  finish: 'border-danger',
  utility: 'border-border',
};

export function BlockNode({ id, data, selected }: NodeProps<BlockFlowNode>) {
  const actions = useContext(NodeActionsContext);
  const updateNodeInternals = useUpdateNodeInternals();
  const { node, problems } = data;
  const entry = catalogEntry(node.type);
  const outputs = outputsOf(node.type, node.config);
  const handleKey = outputs.map((o) => o.id).join('|');
  // React Flow caches handle positions; tell it when a config change adds or removes outputs.
  useEffect(() => updateNodeInternals(id), [id, handleKey, updateNodeInternals]);
  if (!actions) throw new Error('BlockNode usado fora do BotEditor');
  const Icon = blockIcon(entry.icon);
  const ring = problems.length > 0 ? 'ring-2 ring-danger' : selected ? 'ring-2 ring-primary/50' : '';

  return (
    <div
      data-testid={`block-${node.id}`}
      data-invalid={problems.length > 0 ? 'true' : undefined}
      className={`w-[280px] rounded-lg border-2 bg-panel text-fg shadow-lg ${CATEGORY_BORDER[entry.category]} ${ring}`}
    >
      {canBeTarget(node.type) && <Handle type="target" position={Position.Left} />}
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Icon size={16} aria-hidden />
        <span className="flex-1 truncate text-sm font-medium">{entry.label}</span>
        {!actions.readOnly && (
          <button
            type="button"
            aria-label={`Excluir bloco ${entry.label}`}
            title="Excluir bloco"
            onClick={() => actions.remove(id)}
            className="nodrag rounded p-0.5 text-muted hover:text-danger"
          >
            <TrashIcon size={14} />
          </button>
        )}
      </header>
      <fieldset disabled={actions.readOnly} className="nodrag nowheel min-w-0 cursor-default space-y-2 px-3 py-2">
        {node.type !== 'sticky_note' && (
          <label className="block text-xs text-muted">
            Nome (variável)
            <input
              value={node.name ?? ''}
              maxLength={40}
              onChange={(e) => actions.rename(id, e.target.value)}
              className={`${field} bg-surface text-fg`}
            />
          </label>
        )}
        {actions.catalog ? (
          <BlockConfigCard
            node={node}
            catalog={actions.catalog}
            bot={actions.bot}
            problems={problems}
            onChange={(config) => actions.changeConfig(id, config)}
            onBotChange={actions.changeBot}
          />
        ) : (
          <p className="text-xs text-muted">Carregando…</p>
        )}
        {problems.length > 0 && (
          <ul className="space-y-0.5 text-xs text-danger">
            {problems.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        )}
      </fieldset>
      {outputs.length > 0 && (
        <ul className="border-t border-border py-1">
          {outputs.map((o) => (
            <li key={o.id} className="relative py-1 pr-4 text-right text-xs text-muted">
              {o.label}
              <Handle type="source" position={Position.Right} id={o.id} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 15: Implement the toolbar, the versions panel and the problems list**

Create `web/src/components/bot-editor/Toolbar.tsx`:

```tsx
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import {
  ArrowClockwiseIcon,
  ArrowCounterClockwiseIcon,
  ArrowLeftIcon,
  ClockCounterClockwiseIcon,
  DownloadSimpleIcon,
  SquaresFourIcon,
  TreeStructureIcon,
} from '@phosphor-icons/react';
import type { BotDto } from '@talk/shared';
import { btn, btnPrimary } from '../settings/common';

export interface ToolbarProps {
  name: string;
  onRename(name: string): void;
  status: BotDto['status'];
  publishedVersionNumber: number | null;
  onToggleStatus(): void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo(): void;
  onRedo(): void;
  onLayout(): void;
  onSave(publish: boolean): void;
  busy: boolean;
  dirty: boolean;
  readOnly: boolean;
  exportUrl: string;
  paletteOpen: boolean;
  onTogglePalette(): void;
  versionsOpen: boolean;
  onToggleVersions(): void;
}

function IconButton(props: { label: string; onClick(): void; disabled?: boolean; pressed?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      aria-pressed={props.pressed}
      disabled={props.disabled}
      onClick={props.onClick}
      className={`rounded p-1.5 text-muted hover:bg-sidebar-hover hover:text-fg disabled:opacity-40 ${props.pressed ? 'bg-sidebar-active text-fg' : ''}`}
    >
      {props.children}
    </button>
  );
}

function NameInput({ name, disabled, onRename }: { name: string; disabled: boolean; onRename(name: string): void }) {
  const [value, setValue] = useState(name);
  useEffect(() => setValue(name), [name]);
  function commit() {
    const v = value.trim();
    if (v && v !== name) onRename(v);
    else setValue(name);
  }
  return (
    <input
      aria-label="Nome do chatbot"
      value={value}
      maxLength={80}
      disabled={disabled}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
      className="w-64 rounded border border-transparent bg-transparent px-2 py-1 text-sm font-semibold hover:border-border focus:border-border"
    />
  );
}

export function Toolbar(p: ToolbarProps) {
  const active = p.status === 'active';
  return (
    <header className="flex flex-wrap items-center gap-2 border-b border-border bg-panel px-3 py-2">
      <Link
        to="/configuracoes/chatbots"
        aria-label="Voltar para a lista de chatbots"
        title="Voltar"
        className="rounded p-1.5 text-muted hover:bg-sidebar-hover hover:text-fg"
      >
        <ArrowLeftIcon size={18} />
      </Link>
      <NameInput name={p.name} disabled={p.readOnly} onRename={p.onRename} />
      <span className={`rounded px-2 py-0.5 text-xs ${active ? 'bg-success/20 text-success' : 'bg-border text-muted'}`}>
        {active ? 'Ativo' : 'Pausado'}
      </span>
      <span className="text-xs text-muted">
        {p.publishedVersionNumber ? `Publicada: versão ${p.publishedVersionNumber}` : 'Nenhuma versão publicada'}
      </span>
      {p.dirty && <span className="text-xs text-amber-400">Alterações não salvas</span>}
      <div className="ml-auto flex flex-wrap items-center gap-1">
        <IconButton label="Paleta de blocos (Tab)" pressed={p.paletteOpen} disabled={p.readOnly} onClick={p.onTogglePalette}>
          <SquaresFourIcon size={18} />
        </IconButton>
        <IconButton label="Desfazer" disabled={!p.canUndo} onClick={p.onUndo}>
          <ArrowCounterClockwiseIcon size={18} />
        </IconButton>
        <IconButton label="Refazer" disabled={!p.canRedo} onClick={p.onRedo}>
          <ArrowClockwiseIcon size={18} />
        </IconButton>
        <IconButton label="Auto-organizar" disabled={p.readOnly} onClick={p.onLayout}>
          <TreeStructureIcon size={18} />
        </IconButton>
        <IconButton label="Versões" pressed={p.versionsOpen} onClick={p.onToggleVersions}>
          <ClockCounterClockwiseIcon size={18} />
        </IconButton>
        <a href={p.exportUrl} download title="Baixa a última versão salva" className={`${btn} inline-flex items-center gap-1`}>
          <DownloadSimpleIcon size={16} aria-hidden />
          Exportar
        </a>
        <button type="button" className={btn} disabled={p.busy} onClick={p.onToggleStatus}>
          {active ? 'Pausar' : 'Ativar'}
        </button>
        <button type="button" className={btn} disabled={p.busy || p.readOnly} onClick={() => p.onSave(false)}>
          Salvar rascunho
        </button>
        <button type="button" className={btnPrimary} disabled={p.busy || p.readOnly} onClick={() => p.onSave(true)}>
          Salvar e publicar
        </button>
      </div>
    </header>
  );
}
```

Create `web/src/components/bot-editor/VersionsPanel.tsx`:

```tsx
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { BotGraph, BotVersionDto } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { btn, Loading } from '../settings/common';
import { errorMessage } from '../conversation/model';

export interface VersionsPanelProps {
  botId: string;
  onRestore(graph: BotGraph, number: number): void;
  onView?(version: BotVersionDto): void;
}

const when = (iso: string) => new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

export function VersionsPanel({ botId, onRestore, onView }: VersionsPanelProps) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: qk.botVersions(botId), queryFn: () => api.bots.versions(botId) });
  const [loading, setLoading] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function open(n: number, then: (v: BotVersionDto) => void) {
    setLoading(n);
    setError(null);
    try {
      // versions are immutable, so the cached copy never goes stale
      then(await qc.fetchQuery({ queryKey: qk.botVersion(botId, n), queryFn: () => api.bots.version(botId, n), staleTime: Infinity }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(null);
    }
  }

  return (
    <section aria-label="Versões" className="border-t border-border p-3 first:border-t-0">
      <h2 className="mb-2 text-sm font-semibold">Versões</h2>
      {!list.data ? (
        <Loading error={list.error} />
      ) : (
        <ul className="divide-y divide-border rounded border border-border">
          {list.data.map((v) => (
            <li key={v.id} className="p-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">Versão {v.number}</span>
                {v.published && <span className="rounded bg-success/20 px-1.5 text-xs text-success">Publicada</span>}
                {!v.valid && <span className="rounded bg-danger/20 px-1.5 text-xs text-danger">Com problemas</span>}
              </div>
              <p className="text-xs text-muted">
                {when(v.createdAt)} · {v.createdByName ?? 'Sistema'}
                {v.label ? ` · ${v.label}` : ''}
              </p>
              <div className="mt-1 flex flex-wrap gap-1">
                {onView && (
                  <button type="button" className={btn} disabled={loading !== null} onClick={() => void open(v.number, onView)}>
                    Visualizar
                  </button>
                )}
                <button
                  type="button"
                  className={btn}
                  disabled={loading !== null}
                  onClick={() => void open(v.number, (full) => onRestore(full.graph, full.number))}
                >
                  Restaurar como rascunho
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
```

Create `web/src/components/bot-editor/ProblemsList.tsx`:

```tsx
import type { GraphProblem } from '@talk/shared';

export interface ProblemsListProps {
  problems: GraphProblem[];
  onFocus(nodeId: string): void;
  labelOf?(nodeId: string): string;
}

export function ProblemsList({ problems, onFocus, labelOf }: ProblemsListProps) {
  if (problems.length === 0) return null;
  return (
    <section aria-label="Problemas do fluxo" className="p-3">
      <h2 className="mb-2 text-sm font-semibold text-danger">{problems.length === 1 ? '1 problema' : `${problems.length} problemas`}</h2>
      <ul className="space-y-1 text-sm">
        {problems.map((p, i) => {
          const nodeId = p.nodeId;
          return (
            <li key={i}>
              {nodeId ? (
                <button type="button" onClick={() => onFocus(nodeId)} className="text-left hover:underline">
                  {labelOf && <strong>{labelOf(nodeId)}: </strong>}
                  {p.message}
                </button>
              ) : (
                p.message
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
```

- [ ] **Step 16: Implement the dark theme overrides and the editor**

Create `web/src/components/bot-editor/flow.css`:

```css
/* React Flow in the app's dark theme. The fallbacks repeat the @theme values in index.css. */
.react-flow.dark {
  --xy-background-color: var(--color-surface, #1b1e25);
  --xy-background-pattern-color: var(--color-border, #313543);
  --xy-edge-stroke: var(--color-muted, #9aa1b1);
  --xy-edge-stroke-selected: var(--color-primary, #4a6cf7);
  --xy-connectionline-stroke: var(--color-primary, #4a6cf7);
  --xy-handle-background-color: var(--color-primary, #4a6cf7);
  --xy-handle-border-color: var(--color-panel, #23262f);
  --xy-minimap-background-color: var(--color-panel, #23262f);
  --xy-minimap-mask-background-color: rgb(20 22 27 / 0.6);
  --xy-minimap-node-background-color: var(--color-border, #313543);
  --xy-controls-button-background-color: var(--color-panel, #23262f);
  --xy-controls-button-background-color-hover: var(--color-sidebar-hover, #22252d);
  --xy-controls-button-color: var(--color-fg, #e7e9ef);
  --xy-controls-button-color-hover: var(--color-fg, #e7e9ef);
  --xy-controls-button-border-color: var(--color-border, #313543);
  --xy-attribution-background-color: transparent;
}

.react-flow__handle {
  width: 10px;
  height: 10px;
}

.react-flow__attribution a {
  color: var(--color-muted, #9aa1b1);
}
```

Create `web/src/components/bot-editor/BotEditor.tsx`:

```tsx
import '@xyflow/react/dist/style.css';
import './flow.css';
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useBlocker } from 'react-router';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type AriaLabelConfig,
  type Connection,
  type Edge,
  type EdgeChange,
  type IsValidConnection,
  type NodeChange,
  type OnDelete,
  type OnNodeDrag,
} from '@xyflow/react';
import {
  BLOCK_TYPES,
  catalogEntry,
  type BlockType,
  type BotDto,
  type BotGraph,
  type BotPatch,
  type BotVersionDto,
  type GraphProblem,
} from '@talk/shared';
import { api, graphProblems, qk } from '../../lib/api';
import { btn } from '../settings/common';
import { errorMessage } from '../conversation/model';
import { BlockNode, NodeActionsContext, type NodeActions } from './BlockNode';
import {
  addNode,
  canBeTarget,
  connect,
  moveNodes,
  removeElements,
  renameNode,
  shortcutFor,
  toFlowEdges,
  toFlowNodes,
  updateNodeConfig,
  useGraphHistory,
  type BlockFlowNode,
} from './editor-state';
import { NODE_WIDTH, autoLayout, type NodeSizes } from './layout';
import { PALETTE_DRAG_TYPE, Palette } from './Palette';
import { ProblemsList } from './ProblemsList';
import { Toolbar } from './Toolbar';
import { VersionsPanel } from './VersionsPanel';
import { useEditorCatalog } from './useEditorCatalog';

const nodeTypes = { block: BlockNode };

const ARIA_PT: Partial<AriaLabelConfig> = {
  'node.a11yDescription.default': 'Pressione Enter ou espaço para selecionar o bloco. Pressione Delete para excluí-lo e Esc para cancelar.',
  'node.a11yDescription.keyboardDisabled':
    'Pressione Enter ou espaço para selecionar o bloco. Use as setas para movê-lo, Delete para excluí-lo e Esc para cancelar.',
  'node.a11yDescription.ariaLiveMessage': ({ direction, x, y }) => `Bloco movido para ${direction}. Nova posição: x ${x}, y ${y}`,
  'edge.a11yDescription.default': 'Pressione Enter ou espaço para selecionar a ligação. Depois pressione Delete para excluí-la ou Esc para cancelar.',
  'controls.ariaLabel': 'Controles',
  'controls.zoomIn.ariaLabel': 'Aproximar',
  'controls.zoomOut.ariaLabel': 'Afastar',
  'controls.fitView.ariaLabel': 'Ajustar à tela',
  'minimap.ariaLabel': 'Minimapa',
  'handle.ariaLabel': 'Conector',
};

const LEAVE_PROMPT = 'Há alterações não salvas. Sair mesmo assim?';

export interface BotEditorProps {
  bot: BotDto;
  initial: BotVersionDto;
}

/** Full-screen flow editor. `initial` is read once: refetches of the version do not reset the canvas or the undo history. */
export function BotEditor(props: BotEditorProps) {
  return (
    <ReactFlowProvider>
      <EditorCanvas {...props} />
    </ReactFlowProvider>
  );
}

type Message = { kind: 'error' | 'notice'; text: string };

function EditorCanvas({ bot, initial }: BotEditorProps) {
  const qc = useQueryClient();
  const rf = useReactFlow<BlockFlowNode, Edge>();
  const wrapper = useRef<HTMLDivElement>(null);
  const { graph, canUndo, canRedo, set, undo, redo } = useGraphHistory(initial.graph);
  const [saved, setSaved] = useState<BotGraph>(initial.graph);
  const [patch, setPatch] = useState<BotPatch>({});
  const [problems, setProblems] = useState<GraphProblem[]>(initial.problems);
  const [preview, setPreview] = useState<BotVersionDto | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(true);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const catalog = useEditorCatalog();

  const readOnly = preview !== null;
  const shown = preview ? preview.graph : graph;
  const shownProblems = preview ? preview.problems : problems;
  const dirty = graph !== saved || Object.keys(patch).length > 0;
  const editedBot = useMemo<BotDto>(() => ({ ...bot, ...patch }), [bot, patch]);

  // React Flow owns selection, drag positions and measured sizes; the graph (history) owns everything else.
  const [nodes, setNodes] = useState(() => toFlowNodes(shown, shownProblems));
  const [edges, setEdges] = useState(() => toFlowEdges(shown));
  useEffect(() => {
    setNodes((prev) => {
      const old = new Map(prev.map((n) => [n.id, n]));
      return toFlowNodes(shown, shownProblems).map((n) => {
        const o = old.get(n.id);
        return o ? { ...n, selected: o.selected, measured: o.measured } : n;
      });
    });
    setEdges((prev) => {
      const selected = new Set(prev.filter((e) => e.selected).map((e) => e.id));
      return toFlowEdges(shown).map((e) => (selected.has(e.id) ? { ...e, selected: true } : e));
    });
  }, [shown, shownProblems]);

  const actions = useMemo<NodeActions>(
    () => ({
      catalog,
      bot: editedBot,
      readOnly,
      changeConfig: (id, config) => set((g) => updateNodeConfig(g, id, config), `config:${id}`),
      rename: (id, name) => set((g) => renameNode(g, id, name), `name:${id}`),
      changeBot: (p) => setPatch((prev) => ({ ...prev, ...p })),
      remove: (id) => set((g) => removeElements(g, [id], [])),
    }),
    [catalog, editedBot, readOnly, set],
  );

  // Keyboard: Tab toggles the palette, Ctrl/Cmd+Z and Ctrl+Shift+Z / Ctrl+Y undo and redo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const shortcut = shortcutFor(e);
      if (!shortcut) return;
      e.preventDefault();
      if (shortcut === 'palette') setPaletteOpen((o) => !o);
      else if (preview) return;
      else if (shortcut === 'undo') undo();
      else redo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [preview, undo, redo]);

  // Unsaved-changes guard: in-app navigation asks, and closing or reloading the tab gets the browser prompt.
  const blocker = useBlocker(dirty);
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    if (window.confirm(LEAVE_PROMPT)) blocker.proceed();
    else blocker.reset();
  }, [blocker]);
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  function onNodesChange(changes: NodeChange<BlockFlowNode>[]) {
    // removals go through onDelete so they land in the undo history
    setNodes((ns) => applyNodeChanges(changes.filter((c) => c.type !== 'remove'), ns));
  }
  function onEdgesChange(changes: EdgeChange[]) {
    setEdges((es) => applyEdgeChanges(changes.filter((c) => c.type !== 'remove'), es));
  }
  const onDelete: OnDelete<BlockFlowNode, Edge> = ({ nodes: gone, edges: cut }) =>
    set((g) => removeElements(g, gone.map((n) => n.id), cut.map((e) => e.id)));
  const onNodeDragStop: OnNodeDrag<BlockFlowNode> = (_event, _node, dragged) =>
    set((g) => moveNodes(g, Object.fromEntries(dragged.map((n) => [n.id, n.position]))));
  function onConnect(c: Connection) {
    const sourceHandle = c.sourceHandle;
    if (sourceHandle) set((g) => connect(g, { source: c.source, sourceHandle, target: c.target }));
  }
  const isValidConnection: IsValidConnection<Edge> = (c) => {
    const target = shown.nodes.find((n) => n.id === c.target);
    return target !== undefined && canBeTarget(target.type);
  };

  function insert(type: BlockType, at?: { x: number; y: number }) {
    const entry = catalogEntry(type);
    if (entry.category === 'start' && graph.nodes.some((n) => n.type === type)) {
      setMessage({ kind: 'error', text: `O fluxo já tem o bloco "${entry.label}".` });
      return;
    }
    const box = wrapper.current?.getBoundingClientRect();
    const center = rf.screenToFlowPosition({ x: (box?.left ?? 0) + (box?.width ?? 0) / 2, y: (box?.top ?? 0) + (box?.height ?? 0) / 2 });
    const position = at ?? { x: Math.round(center.x - NODE_WIDTH / 2), y: Math.round(center.y - 40) };
    set((g) => addNode(g, type, position).graph);
    setMessage(null);
  }
  function onDragOver(e: DragEvent) {
    if (!e.dataTransfer.types.includes(PALETTE_DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }
  function onDrop(e: DragEvent) {
    const type = e.dataTransfer.getData(PALETTE_DRAG_TYPE);
    if (!(BLOCK_TYPES as readonly string[]).includes(type)) return;
    e.preventDefault();
    insert(type as BlockType, rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
  }

  function layout() {
    const sizes: NodeSizes = {};
    for (const n of rf.getNodes()) {
      if (n.measured?.width && n.measured.height) sizes[n.id] = { width: n.measured.width, height: n.measured.height };
    }
    set((g) => autoLayout(g, sizes));
    requestAnimationFrame(() => void rf.fitView({ duration: 300 }));
  }

  function focusNode(id: string) {
    setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === id })));
    void rf.fitView({ nodes: [{ id }], duration: 300, maxZoom: 1.2 });
  }
  function labelOf(id: string): string {
    const n = shown.nodes.find((x) => x.id === id);
    return n ? (n.name ?? catalogEntry(n.type).label) : 'Bloco removido';
  }

  function restore(g: BotGraph, n: number) {
    set(g); // undoable; saving it creates the new draft version
    setPreview(null);
    setProblems([]);
    setMessage({ kind: 'notice', text: `Versão ${n} restaurada. Salve para criar um novo rascunho.` });
  }

  async function save(publish: boolean) {
    const snapshot = graph;
    const pending = patch;
    setBusy(true);
    setMessage(null);
    try {
      if (Object.keys(pending).length > 0) {
        qc.setQueryData(qk.bot(bot.id), await api.bots.update(bot.id, pending));
        setPatch((p) => (p === pending ? {} : p));
      }
      const v = await api.bots.saveVersion(bot.id, { graph: snapshot, publish });
      setSaved(snapshot);
      setProblems(v.problems);
      const text = publish
        ? `Versão ${v.number} publicada.`
        : v.valid
          ? `Rascunho salvo (versão ${v.number}).`
          : `Rascunho salvo (versão ${v.number}) com ${v.problems.length} problema(s).`;
      setMessage({ kind: 'notice', text });
    } catch (e) {
      const found = graphProblems(e);
      if (found) {
        setSaved(snapshot); // the server stores the draft even when publishing is refused
        setProblems(found);
        setMessage({ kind: 'error', text: 'O fluxo tem problemas e não foi publicado. O rascunho foi salvo.' });
      } else {
        setMessage({ kind: 'error', text: errorMessage(e) });
      }
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: qk.bots });
    }
  }

  async function toggleStatus() {
    setBusy(true);
    setMessage(null);
    try {
      qc.setQueryData(qk.bot(bot.id), await api.bots.setStatus(bot.id, bot.status === 'active' ? 'paused' : 'active'));
      void qc.invalidateQueries({ queryKey: qk.bots });
    } catch (e) {
      setMessage({ kind: 'error', text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <NodeActionsContext.Provider value={actions}>
      <div className="flex h-dvh flex-col bg-surface text-fg">
        <Toolbar
          name={editedBot.name}
          onRename={(name) => setPatch((p) => ({ ...p, name }))}
          status={bot.status}
          publishedVersionNumber={bot.publishedVersionNumber}
          onToggleStatus={() => void toggleStatus()}
          canUndo={canUndo && !readOnly}
          canRedo={canRedo && !readOnly}
          onUndo={undo}
          onRedo={redo}
          onLayout={layout}
          onSave={(publish) => void save(publish)}
          busy={busy}
          dirty={dirty}
          readOnly={readOnly}
          exportUrl={api.bots.exportUrl(bot.id)}
          paletteOpen={paletteOpen}
          onTogglePalette={() => setPaletteOpen((o) => !o)}
          versionsOpen={versionsOpen}
          onToggleVersions={() => setVersionsOpen((o) => !o)}
        />
        {message && (
          <p
            role={message.kind === 'error' ? 'alert' : 'status'}
            className={`border-b border-border px-4 py-2 text-sm ${message.kind === 'error' ? 'text-danger' : 'text-success'}`}
          >
            {message.text}
          </p>
        )}
        {preview && (
          <div className="flex flex-wrap items-center gap-2 border-b border-border bg-panel px-4 py-2 text-sm">
            <span className="flex-1">Visualizando a versão {preview.number} (somente leitura).</span>
            <button type="button" className={btn} onClick={() => restore(preview.graph, preview.number)}>
              Restaurar como rascunho
            </button>
            <button type="button" className={btn} onClick={() => setPreview(null)}>
              Voltar à edição
            </button>
          </div>
        )}
        <div className="flex min-h-0 flex-1">
          <Palette open={paletteOpen && !readOnly} onInsert={(type) => insert(type)} />
          <div ref={wrapper} className="relative min-w-0 flex-1" onDragOver={onDragOver} onDrop={onDrop}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onDelete={onDelete}
              onNodeDragStop={onNodeDragStop}
              isValidConnection={isValidConnection}
              nodesDraggable={!readOnly}
              nodesConnectable={!readOnly}
              deleteKeyCode={readOnly ? null : ['Backspace', 'Delete']}
              colorMode="dark"
              ariaLabelConfig={ARIA_PT}
              minZoom={0.2}
              fitView
            >
              <Background variant={BackgroundVariant.Dots} gap={20} />
              <MiniMap pannable zoomable />
              <Controls showInteractive={false} />
            </ReactFlow>
          </div>
          {(versionsOpen || shownProblems.length > 0) && (
            <aside aria-label="Painel lateral" className="w-80 shrink-0 overflow-y-auto border-l border-border bg-panel">
              <ProblemsList problems={shownProblems} onFocus={focusNode} labelOf={labelOf} />
              {versionsOpen && <VersionsPanel botId={bot.id} onRestore={restore} onView={setPreview} />}
            </aside>
          )}
        </div>
      </div>
    </NodeActionsContext.Provider>
  );
}
```

- [ ] **Step 17: Run the editor test to verify it passes**

Run: `npm test -w web -- src/components/bot-editor`
Expected: PASS: `editor-state.test.ts` (15), `Palette.test.tsx` (4) and `BotEditor.test.tsx` (9). React Flow may print a `React Flow parent container needs a width and a height` warning in jsdom. That warning is expected, and no test fails.

- [ ] **Step 18: Commit**

```bash
git add web/src/components/bot-editor/useEditorCatalog.ts web/src/components/bot-editor/cards/index.tsx web/src/components/bot-editor/BlockNode.tsx web/src/components/bot-editor/Toolbar.tsx web/src/components/bot-editor/VersionsPanel.tsx web/src/components/bot-editor/ProblemsList.tsx web/src/components/bot-editor/flow.css web/src/components/bot-editor/BotEditor.tsx web/src/components/bot-editor/BotEditor.test.tsx
git commit -m "feat(web): bot flow editor canvas with save, publish and versions" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 19: Write the failing page test**

Create `web/src/pages/settings/bots/BotEditorPage.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryRouter } from 'react-router';
import type { BotDto, BotVersionDto, Me } from '@talk/shared';
import { BotEditorPage } from './BotEditorPage';

// The canvas has its own test; here only the page logic matters.
vi.mock('../../../components/bot-editor/BotEditor', async () => {
  const { createElement } = await import('react');
  return {
    BotEditor: ({ bot, initial }: { bot: BotDto; initial: BotVersionDto }) =>
      createElement('p', null, `Editor de ${bot.name}, versão ${initial.number}`),
  };
});

const bot: BotDto = {
  id: 'b1', name: 'Fluxo teste', description: '', status: 'paused', startChannelIds: [], manualStart: false, manualTitle: '',
  manualUnlisted: false, publishedVersionId: null, publishedVersionNumber: null, latestVersionNumber: 2, runCount: 0,
  activeRunCount: 0, createdAt: '2026-10-15T12:00:00.000Z', updatedAt: '2026-10-15T12:00:00.000Z',
};
const version: BotVersionDto = {
  id: 'v2', botId: 'b1', number: 2, valid: true, label: null, createdByName: 'Admin Teste',
  createdAt: '2026-10-15T12:00:00.000Z', published: false, graph: { nodes: [], edges: [] }, problems: [],
};
const admin: Me = { id: 'adm', name: 'Admin', email: 'adm@exemplo.com.br', role: 'admin', signature: null, sectorIds: [], seeAllSectors: false, avatarUrl: null };
const agent: Me = { ...admin, id: 'ag', role: 'agent' };

let routes: Record<string, { status?: number; body: unknown }>;
const paths: string[] = [];

beforeEach(() => {
  paths.length = 0;
  routes = {
    'GET /api/bots/b1': { body: bot },
    'GET /api/bots/b1/versions/2': { body: version },
  };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    paths.push(url.pathname);
    const reply = routes[`${init?.method ?? 'GET'} ${url.pathname}`];
    if (!reply) return new Response(JSON.stringify({ error: 'inesperado' }), { status: 500 });
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPage(me: Me) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  qc.setQueryData(['me'], me);
  const router = createMemoryRouter(
    [
      { path: '/configuracoes/chatbots/:id', element: <BotEditorPage /> },
      { path: '/configuracoes/perfil', element: <p>Perfil</p> },
    ],
    { initialEntries: ['/configuracoes/chatbots/b1'] },
  );
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

it('loads the bot and its latest version for an admin', async () => {
  renderPage(admin);
  expect(await screen.findByText('Editor de Fluxo teste, versão 2')).toBeTruthy();
});

it('sends an agent to Perfil without loading the bot', async () => {
  renderPage(agent);
  expect(await screen.findByText('Perfil')).toBeTruthy();
  expect(paths).not.toContain('/api/bots/b1');
});

it('shows the error when the bot does not exist', async () => {
  routes['GET /api/bots/b1'] = { status: 404, body: { error: 'Chatbot não encontrado' } };
  renderPage(admin);
  expect(await screen.findByText('Chatbot não encontrado')).toBeTruthy();
});
```

- [ ] **Step 20: Run the test to verify it fails**

Run: `npm test -w web -- src/pages/settings/bots/BotEditorPage.test.tsx`
Expected: FAIL with `Failed to resolve import "./BotEditorPage" from "src/pages/settings/bots/BotEditorPage.test.tsx"`.

- [ ] **Step 21: Implement the page and register the route**

Create `web/src/pages/settings/bots/BotEditorPage.tsx`:

```tsx
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Navigate, useParams } from 'react-router';
import { api, qk } from '../../../lib/api';
import { useCurrentUser } from '../../../lib/auth';
import { Loading } from '../../../components/settings/common';
import { BotEditor } from '../../../components/bot-editor/BotEditor';

/** `/configuracoes/chatbots/:id`, full screen outside AppLayout. Admin only (the API answers 403 anyway). */
export function BotEditorPage() {
  const { id = '' } = useParams();
  return <EditorLoader key={id} id={id} />; // a different bot id remounts with fresh state
}

function EditorLoader({ id }: { id: string }) {
  const me = useCurrentUser();
  const isAdmin = me.role === 'admin';
  const bot = useQuery({ queryKey: qk.bot(id), queryFn: () => api.bots.get(id), enabled: isAdmin });
  // Freeze the version number seen on first load: saving bumps latestVersionNumber, and a new
  // query key would drop version.data for a moment and unmount the editor with its undo history.
  const [n, setN] = useState<number | null>(null);
  if (n === null && bot.data) setN(bot.data.latestVersionNumber);
  const version = useQuery({
    queryKey: qk.botVersion(id, n ?? 0),
    queryFn: () => api.bots.version(id, n ?? 0),
    enabled: isAdmin && n !== null,
    staleTime: Infinity, // versions are immutable
  });

  if (!isAdmin) return <Navigate to="/configuracoes/perfil" replace />;
  if (!bot.data || !version.data) {
    return (
      <div className="grid h-dvh place-items-center bg-surface p-6">
        <Loading error={bot.error ?? version.error} />
      </div>
    );
  }
  return <BotEditor bot={bot.data} initial={version.data} />;
}
```

Modify `web/src/App.tsx`. Add the import after the `SettingsPage` import:

```tsx
import { BotEditorPage } from './pages/settings/bots/BotEditorPage';
```

Then add the editor route as the second entry of `routes`, right after `/login` and before `/`. It sits outside `AppLayout`, so the editor is full screen:

```tsx
export const routes: RouteObject[] = [
  { path: '/login', element: <Login /> },
  {
    path: '/configuracoes/chatbots/:id',
    element: (
      <RequireAuth>
        <BotEditorPage />
      </RequireAuth>
    ),
  },
  {
    path: '/',
```

The rest of the `routes` array stays unchanged.

- [ ] **Step 22: Run the page test, the whole web suite, the typecheck and the build**

Run: `npm test -w web -- src/pages/settings/bots/BotEditorPage.test.tsx`
Expected: PASS (3 tests).

Run: `npm test -w web`
Expected: PASS. Every web test passes, including Task 13's `BotsSettings.test.tsx`.

Run: `npm run typecheck -w web`
Expected: exit 0 with no errors.

Run: `npm run build`
Expected: exit 0. Vite reports the bundle, and the React Flow CSS is included.

- [ ] **Step 23: Commit**

```bash
git add web/src/pages/settings/bots/BotEditorPage.tsx web/src/pages/settings/bots/BotEditorPage.test.tsx web/src/App.tsx
git commit -m "feat(web): full-screen bot editor route" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


---

### Task 15: Web block config cards

Fill in `BlockConfigCard` with a real form for every type in `BLOCK_TYPES` (33, see the Global Constraints note). Task 14 created `cards/index.tsx` with a fallback; this task replaces the whole file. The cards are controlled: they read `node.config` merged over `defaultConfig(node.type)` and report each edit through `onChange`. The two start cards edit bot fields through `onBotChange`. The catalog data (sectors, users, tags, custom fields, channels, bots) comes in through the `catalog` prop, which Task 14 loads with `useEditorCatalog()`. The only request a card makes is the attachment upload in `send_message`, through `api.bots.uploadMedia`.

Variable insertion reuses `FIXED_VARIABLES` and `insertAtCursor` from `web/src/components/settings/QuickAnswerForm.tsx`, so the chips are the same as in quick answers, plus `{{campo.<nome>}}` for each custom field.

**Files:**
- Create: `web/src/components/bot-editor/cards/fields.tsx`: shared controls (`VarText`, `CheckList`, `RulesEditor`, `RuleRow`, `TimezoneInput`, `Select`, `TextInput`, `NumberInput`, `Check`, `RemoveButton`), catalog item helpers and `clampInt`.
- Create: `web/src/components/bot-editor/cards/conditions.tsx`: forms for the condition blocks.
- Create: `web/src/components/bot-editor/cards/actions.tsx`: forms for the action and finish blocks.
- Create: `web/src/components/bot-editor/cards/start.tsx`: `start_channel`, `start_manual` and `sticky_note`.
- Modify (replace the whole file): `web/src/components/bot-editor/cards/index.tsx`
- Test: `web/src/components/bot-editor/cards/cards.test.tsx`

**Interfaces:**
- Consumes:
  - `@talk/shared` (Task 1):
    - Values: `BLOCK_TYPES`, `WEEKDAYS`, `WEEKDAY_LABELS`, `RULE_OPERATOR_LABELS`, `NATIVE_CONTACT_FIELDS`, `defaultConfig(type)` and `catalogEntry(type)`.
    - Types: `BlockType`, `BotNode`, `BotDto`, `BotPatch`, `BotAttachment`, `Rule`, `Operand`, `RuleOperator`, `Logic`, `Weekday`, `TimeUnit`, `InputValidator`, `MediaType`, `StickyColor`, and every `*Config` interface in §3.1.
  - `web/src/lib/api.ts` (Task 13): `api.bots.uploadMedia(file: Blob, name?: string): Promise<BotMediaDto>`, which does `POST /api/bots/media` with a FormData field `file`.
  - `web/src/components/bot-editor/useEditorCatalog.ts` (Task 14): `export interface EditorCatalog { sectors: SectorDto[]; users: UserDto[]; tags: TagDto[]; customFields: CustomFieldDto[]; channels: ChannelDto[]; bots: BotDto[] }`. It must be exported. If Task 14 left it unexported, add `export` to it in that file as part of this task.
  - `web/src/components/settings/QuickAnswerForm.tsx` (existing):
    - `FIXED_VARIABLES: readonly (readonly [string, string])[]`
    - `insertAtCursor(text: string, start: number, end: number, snippet: string): { text: string; caret: number }`
  - Task 14 renders `<BlockConfigCard … />` and handles `onChange` with `updateNodeConfig`, which drops edges whose handle left `outputsOf`. It keeps the pending `BotPatch` from `onBotChange` and PATCHes it before `saveVersion`.
- Produces (the contract signature is unchanged):
  ```ts
  // cards/index.tsx
  export interface BlockCardProps { node: BotNode; catalog: EditorCatalog; bot: BotDto; problems: string[];
    onChange(config: Record<string, unknown>): void; onBotChange(patch: BotPatch): void }
  export function BlockConfigCard(props: BlockCardProps): JSX.Element;
  // cards/fields.tsx (reusable by later tasks)
  export interface FormProps<C> { config: C; onChange(next: C): void; catalog: EditorCatalog }
  export function VarText(props: { label: string; value: string; onChange(v: string): void; catalog: EditorCatalog; rows?: number; placeholder?: string; hint?: string }): JSX.Element;
  export function clampInt(raw: string, min: number, max?: number): number;
  ```
  - `onBotChange` always receives the **cumulative** patch made in that card, for example `{ manualStart: true, manualTitle: 'X' }`. Merging it into a pending patch, or replacing the pending patch with it, gives the same result.
  - The root element has the classes `nodrag nowheel`, so typing in a field or scrolling a textarea inside a React Flow node neither drags the node nor zooms the canvas.

Behavior worth knowing before reading the code:
- An edit that removes an output also disconnects that output's edge, through Task 14's `updateNodeConfig`. This happens when an option key changes, a case or branch is removed, `resumeOnReply` is unchecked, or the timeout is turned off. The `ask_choice` card says so next to the options.
- `hours`: when all 7 days are checked, the `days` key is dropped, because absent means every day. Unchecking the last checked day is ignored, so an interval always has at least one day.
- `ask_input`: switching the validator drops `regex` and `mediaTypes` unless the new validator uses them.
- Rules: choosing `empty` or `not_empty` drops `right`. Choosing another operator restores `right` as an empty literal.
- Number fields keep whole numbers in range through `clampInt`. Weights are at least 1, timeouts are 1..720 h, and amounts are at least 1.
- The forms keep the list sizes from §3.1:
  - `ask_choice` options: 1..20
  - `multi_condition` cases: 1..20
  - `distribute` branches: 2..10
  - rules: at least 1
  - `hours` intervals: at least 1
- Lists of users show only active users. `call_flow` lists every bot except this one, and adds " (inativo)" to a bot that is paused or unpublished.
- The `var` operand is a free-text node name, for example `menu`. The props carry no graph, so the card cannot list the other nodes. `// ponytail: free text for node names; add a varNames prop fed by BotEditor if admins mistype them.`

- [ ] **Step 1: Write the failing test**

Create `web/src/components/bot-editor/cards/cards.test.tsx`:

```tsx
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w web -- src/components/bot-editor/cards`
Expected: FAIL. Task 14's fallback card shows only the description, so every test except `renders every block type…` fails with `TestingLibraryElementError: Unable to find a label with the text of: …` or `Unable to find an accessible element with the role "button"…`.

- [ ] **Step 3: Write the shared controls**

Create `web/src/components/bot-editor/cards/fields.tsx`:

```tsx
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { TrashIcon } from '@phosphor-icons/react';
import { NATIVE_CONTACT_FIELDS, RULE_OPERATOR_LABELS, type Logic, type Operand, type Rule, type RuleOperator } from '@talk/shared';
import { FIXED_VARIABLES, insertAtCursor } from '../../settings/QuickAnswerForm';
import type { EditorCatalog } from '../useEditorCatalog';

/** Props of every config form. `config` is already merged over defaultConfig(type). */
export interface FormProps<C> {
  config: C;
  onChange(next: C): void;
  catalog: EditorCatalog;
}
export interface Item {
  id: string;
  label: string;
}

export const control = 'w-full rounded border border-border bg-surface px-2 py-1 text-sm';
export const addBtn = 'rounded border border-border px-2 py-1 text-xs hover:bg-sidebar-hover disabled:opacity-50';

export const entries = <V extends string>(r: Record<V, string>) => Object.entries(r) as Array<[V, string]>;
export const sectorItems = (c: EditorCatalog): Item[] => c.sectors.map((s) => ({ id: s.id, label: s.name }));
export const userItems = (c: EditorCatalog): Item[] => c.users.filter((u) => u.active).map((u) => ({ id: u.id, label: u.name }));
export const tagItems = (c: EditorCatalog): Item[] => c.tags.map((t) => ({ id: t.id, label: t.emoji ? `${t.emoji} ${t.name}` : t.name }));
export const channelItems = (c: EditorCatalog): Item[] => c.channels.map((ch) => ({ id: ch.id, label: ch.name }));
/** Native contact fields first, then the custom ones; ids are what configs store (NativeFieldId or custom field id). */
export const fieldItems = (c: EditorCatalog): Item[] => [
  ...NATIVE_CONTACT_FIELDS.map((f) => ({ id: f.id as string, label: f.label })),
  ...c.customFields.map((f) => ({ id: f.id, label: f.name })),
];
const pairs = (items: Item[]) => items.map((i) => [i.id, i.label] as const);

/** Whole number clamped to [min, max]; empty or junk input becomes `min`. */
export function clampInt(raw: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const n = Math.trunc(Number(raw));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <span className="block text-xs font-medium text-muted">{label}</span>
      <div className="mt-0.5">{children}</div>
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
    </div>
  );
}

export function Select<V extends string>({
  label,
  hint,
  value,
  options,
  onChange,
  placeholder,
  allowEmpty = false,
}: {
  label: string;
  hint?: string;
  value: V | '';
  options: ReadonlyArray<readonly [V, string]>;
  onChange(v: V | ''): void;
  placeholder?: string;
  allowEmpty?: boolean;
}) {
  return (
    <Field label={label} hint={hint}>
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value as V | '')} className={control}>
        {placeholder !== undefined && (
          <option value="" disabled={!allowEmpty}>
            {placeholder}
          </option>
        )}
        {options.map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function TextInput({
  label,
  hint,
  value,
  onChange,
  placeholder,
  maxLength,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange(v: string): void;
  placeholder?: string;
  maxLength?: number;
}) {
  return (
    <Field label={label} hint={hint}>
      <input aria-label={label} value={value} placeholder={placeholder} maxLength={maxLength} onChange={(e) => onChange(e.target.value)} className={control} />
    </Field>
  );
}

export function NumberInput({ label, value, min, max, onChange }: { label: string; value: number; min: number; max?: number; onChange(v: number): void }) {
  return (
    <Field label={label}>
      <input
        type="number"
        aria-label={label}
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(e) => onChange(clampInt(e.target.value, min, max))}
        className={control}
      />
    </Field>
  );
}

export function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange(v: boolean): void }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export function RemoveButton({ label, onClick, disabled = false }: { label: string; onClick(): void; disabled?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title="Remover"
      disabled={disabled}
      onClick={onClick}
      className="shrink-0 rounded p-1 text-muted hover:bg-danger/15 hover:text-danger disabled:opacity-30"
    >
      <TrashIcon size={14} />
    </button>
  );
}

/** Checkbox list of ids. The result keeps the catalog order; ids missing from the catalog are dropped on the next check. */
export function CheckList({
  label,
  items,
  selected,
  onChange,
  hint,
}: {
  label: string;
  items: Item[];
  selected: string[];
  onChange(next: string[]): void;
  hint?: string;
}) {
  function toggle(id: string, on: boolean) {
    onChange(on ? items.filter((it) => it.id === id || selected.includes(it.id)).map((it) => it.id) : selected.filter((x) => x !== id));
  }
  return (
    <fieldset>
      <legend className="text-xs font-medium text-muted">{label}</legend>
      {items.length === 0 ? (
        <p className="text-xs text-muted">Nada cadastrado ainda.</p>
      ) : (
        <div className="mt-0.5 max-h-40 space-y-0.5 overflow-y-auto">
          {items.map((it) => (
            <label key={it.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={selected.includes(it.id)} onChange={(e) => toggle(it.id, e.target.checked)} />
              {it.label}
            </label>
          ))}
        </div>
      )}
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
    </fieldset>
  );
}

/** Text with variables: a textarea plus "Inserir variável" chips that insert {{…}} at the cursor. */
export function VarText({
  label,
  value,
  onChange,
  catalog,
  rows = 3,
  placeholder,
  hint,
}: {
  label: string;
  value: string;
  onChange(v: string): void;
  catalog: EditorCatalog;
  rows?: number;
  placeholder?: string;
  hint?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const caret = useRef<number | null>(null);
  const [open, setOpen] = useState(false);

  // after an insert, put the caret right after the variable so typing continues there
  useLayoutEffect(() => {
    const el = ref.current;
    if (caret.current === null || !el) return;
    el.focus();
    el.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  });

  const variables: Array<readonly [string, string]> = [
    ...FIXED_VARIABLES,
    ...catalog.customFields.map((f) => [`campo.${f.name}`, `Campo: ${f.name}`] as const),
  ];

  function insert(variable: string) {
    const el = ref.current;
    if (!el) return;
    const result = insertAtCursor(el.value, el.selectionStart, el.selectionEnd, `{{${variable}}}`);
    caret.current = result.caret;
    onChange(result.text);
  }

  return (
    <Field label={label} hint={hint}>
      <textarea
        ref={ref}
        aria-label={label}
        rows={rows}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={control}
      />
      <button
        type="button"
        aria-label={`Inserir variável em ${label}`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="text-xs text-primary hover:underline"
      >
        Inserir variável
      </button>
      {open && (
        <div className="mt-1 flex flex-wrap gap-1">
          {variables.map(([variable, text]) => (
            <button
              key={variable}
              type="button"
              title={`{{${variable}}}`}
              // keep the textarea focused so its selection is not lost
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insert(variable)}
              className="rounded-full border border-border px-2 py-0.5 text-xs hover:bg-sidebar-hover"
            >
              {text}
            </button>
          ))}
          <p className="w-full text-xs text-muted">
            Resposta de um bloco: {'{{contexto.nome_do_bloco}}'}; texto original: {'{{contexto.nome_do_bloco:raw}}'}.
          </p>
        </div>
      )}
    </Field>
  );
}

const TIME_ZONES = Intl.supportedValuesOf('timeZone');

export function TimezoneInput({ value, onChange }: { value: string; onChange(v: string): void }) {
  const listId = useId();
  return (
    <Field label="Fuso horário" hint="Padrão: America/Cuiaba (Mato Grosso).">
      <input aria-label="Fuso horário" list={listId} value={value} onChange={(e) => onChange(e.target.value.trim())} className={control} />
      <datalist id={listId}>
        {TIME_ZONES.map((z) => (
          <option key={z} value={z} />
        ))}
      </datalist>
    </Field>
  );
}

// ---------- rules ----------
export const newRule = (): Rule => ({ left: { kind: 'var', value: '' }, operator: 'eq', right: { kind: 'literal', value: '' } });
export const needsRight = (op: RuleOperator) => op !== 'empty' && op !== 'not_empty';
const OPERAND_KINDS: Record<Operand['kind'], string> = { var: 'Resposta de bloco', field: 'Campo do contato', literal: 'Texto' };

function OperandInput({ label, operand, onChange, catalog }: { label: string; operand: Operand; onChange(o: Operand): void; catalog: EditorCatalog }) {
  return (
    <div className="flex gap-1">
      <select
        aria-label={`${label}: tipo`}
        value={operand.kind}
        onChange={(e) => onChange({ kind: e.target.value as Operand['kind'], value: '' })}
        className={`${control} w-32 shrink-0`}
      >
        {entries(OPERAND_KINDS).map(([k, text]) => (
          <option key={k} value={k}>
            {text}
          </option>
        ))}
      </select>
      {operand.kind === 'field' ? (
        <select aria-label={`${label}: valor`} value={operand.value} onChange={(e) => onChange({ kind: 'field', value: e.target.value })} className={control}>
          <option value="" disabled>
            Escolha o campo…
          </option>
          {pairs(fieldItems(catalog)).map(([id, text]) => (
            <option key={id} value={id}>
              {text}
            </option>
          ))}
        </select>
      ) : (
        <input
          aria-label={`${label}: valor`}
          value={operand.value}
          placeholder={operand.kind === 'var' ? 'nome do bloco (ex.: menu)' : 'texto ou {{variável}}'}
          onChange={(e) => onChange({ kind: operand.kind, value: e.target.value })}
          className={control}
        />
      )}
    </div>
  );
}

export function RuleRow({ label, rule, onChange, catalog }: { label: string; rule: Rule; onChange(r: Rule): void; catalog: EditorCatalog }) {
  function setOperator(operator: RuleOperator) {
    const { right, ...rest } = rule;
    onChange(needsRight(operator) ? { ...rest, operator, right: right ?? { kind: 'literal', value: '' } } : { ...rest, operator });
  }
  return (
    <div className="space-y-1">
      <OperandInput label={`${label}: esquerda`} operand={rule.left} onChange={(left) => onChange({ ...rule, left })} catalog={catalog} />
      <select aria-label={`${label}: operador`} value={rule.operator} onChange={(e) => setOperator(e.target.value as RuleOperator)} className={control}>
        {entries(RULE_OPERATOR_LABELS).map(([op, text]) => (
          <option key={op} value={op}>
            {text}
          </option>
        ))}
      </select>
      {needsRight(rule.operator) && (
        <OperandInput
          label={`${label}: direita`}
          operand={rule.right ?? { kind: 'literal', value: '' }}
          onChange={(right) => onChange({ ...rule, right })}
          catalog={catalog}
        />
      )}
    </div>
  );
}

/** At least one rule; the and/or select appears once there are two or more. `prefix` makes labels unique ("Caso 1 · "). */
export function RulesEditor({
  prefix,
  logic,
  rules,
  onChange,
  catalog,
}: {
  prefix: string;
  logic: Logic;
  rules: Rule[];
  onChange(next: { logic: Logic; rules: Rule[] }): void;
  catalog: EditorCatalog;
}) {
  const list = rules ?? []; // an imported graph may lack the array
  const setRule = (i: number, r: Rule) => onChange({ logic, rules: list.map((x, j) => (j === i ? r : x)) });
  return (
    <div className="space-y-2">
      {list.length > 1 && (
        <select
          aria-label={`${prefix}Combinar regras`}
          value={logic}
          onChange={(e) => onChange({ logic: e.target.value as Logic, rules: list })}
          className={control}
        >
          <option value="and">Todas as regras valem (E)</option>
          <option value="or">Qualquer regra vale (OU)</option>
        </select>
      )}
      {list.map((r, i) => (
        <div key={i} className="rounded border border-border p-2">
          <div className="mb-1 flex items-center justify-between text-xs text-muted">
            <span>Regra {i + 1}</span>
            <RemoveButton
              label={`${prefix}Remover regra ${i + 1}`}
              disabled={list.length === 1}
              onClick={() => onChange({ logic, rules: list.filter((_, j) => j !== i) })}
            />
          </div>
          <RuleRow label={`${prefix}Regra ${i + 1}`} rule={r} onChange={(next) => setRule(i, next)} catalog={catalog} />
        </div>
      ))}
      <button type="button" aria-label={`${prefix}Adicionar regra`} className={addBtn} onClick={() => onChange({ logic, rules: [...list, newRule()] })}>
        Adicionar regra
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Write the condition forms**

Create `web/src/components/bot-editor/cards/conditions.tsx`:

```tsx
import { useState } from 'react';
import {
  RULE_OPERATOR_LABELS,
  WEEKDAYS,
  WEEKDAY_LABELS,
  type ChatAgentConfig,
  type ChatChannelConfig,
  type ChatSectorConfig,
  type ConditionConfig,
  type ContactFieldConfig,
  type DistributeConfig,
  type HoursConfig,
  type HoursInterval,
  type MessageContainsConfig,
  type MultiConditionConfig,
  type TagsConfig,
  type TimeUnit,
  type ValueConfig,
  type WaitIntervalConfig,
  type Weekday,
  type WeekdaysConfig,
} from '@talk/shared';
import {
  Check,
  CheckList,
  Field,
  NumberInput,
  RemoveButton,
  RuleRow,
  RulesEditor,
  Select,
  TextInput,
  TimezoneInput,
  VarText,
  addBtn,
  channelItems,
  clampInt,
  control,
  entries,
  fieldItems,
  needsRight,
  newRule,
  sectorItems,
  tagItems,
  userItems,
  type FormProps,
} from './fields';

const WORKDAYS: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri'];
export const UNIT_LABELS: Record<TimeUnit, string> = { seconds: 'segundos', minutes: 'minutos', hours: 'horas', days: 'dias' };

export function WeekdaysForm({ config, onChange }: FormProps<WeekdaysConfig>) {
  return <TimezoneInput value={config.timezone} onChange={(timezone) => onChange({ ...config, timezone })} />;
}

export function HoursForm({ config, onChange }: FormProps<HoursConfig>) {
  const intervals = config.intervals ?? [];
  const setIntervals = (next: HoursInterval[]) => onChange({ ...config, intervals: next });
  const set = (i: number, patch: Partial<HoursInterval>) => setIntervals(intervals.map((it, j) => (j === i ? { ...it, ...patch } : it)));

  function toggleDay(i: number, day: Weekday) {
    const { days, ...rest } = intervals[i]!;
    const current = days ?? WEEKDAYS;
    const next = WEEKDAYS.filter((d) => (d === day ? !current.includes(d) : current.includes(d)));
    if (next.length === 0) return; // an interval with no day would never match
    // every day = no `days` key (HoursInterval: absent = every day)
    setIntervals(intervals.map((it, j) => (j !== i ? it : next.length === WEEKDAYS.length ? rest : { ...rest, days: next })));
  }

  return (
    <div className="space-y-2">
      <TimezoneInput value={config.timezone} onChange={(timezone) => onChange({ ...config, timezone })} />
      {intervals.map((it, i) => (
        <div key={i} className="rounded border border-border p-2">
          <div className="flex items-center gap-1">
            <input type="time" aria-label={`Intervalo ${i + 1}: início`} value={it.from} onChange={(e) => set(i, { from: e.target.value })} className={control} />
            <span className="text-xs text-muted">até</span>
            <input type="time" aria-label={`Intervalo ${i + 1}: fim`} value={it.to} onChange={(e) => set(i, { to: e.target.value })} className={control} />
            <RemoveButton
              label={`Remover intervalo ${i + 1}`}
              disabled={intervals.length === 1}
              onClick={() => setIntervals(intervals.filter((_, j) => j !== i))}
            />
          </div>
          <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5">
            {WEEKDAYS.map((d) => (
              <label key={d} className="flex items-center gap-0.5 text-xs">
                <input
                  type="checkbox"
                  aria-label={`Intervalo ${i + 1}: ${WEEKDAY_LABELS[d]}`}
                  checked={(it.days ?? WEEKDAYS).includes(d)}
                  onChange={() => toggleDay(i, d)}
                />
                {WEEKDAY_LABELS[d].slice(0, 3)}
              </label>
            ))}
          </div>
        </div>
      ))}
      <button
        type="button"
        className={addBtn}
        onClick={() => setIntervals([...intervals, { from: '08:00', to: '18:00', days: [...WORKDAYS] }])}
      >
        Adicionar intervalo
      </button>
      <p className="text-xs text-muted">O horário final não entra: 08:00 até 12:00 vale até 11:59.</p>
    </div>
  );
}

export function WaitIntervalForm({ config, onChange, catalog }: FormProps<WaitIntervalConfig>) {
  function setMode(mode: WaitIntervalConfig['mode']) {
    const { variable, ...rest } = config;
    onChange(mode === 'variable' ? { ...rest, mode, variable: variable ?? '' } : { ...rest, mode });
  }
  return (
    <div className="space-y-2">
      <Select
        label="Esperar"
        value={config.mode}
        options={[
          ['fixed', 'Um tempo fixo'],
          ['variable', 'O número de uma variável'],
        ]}
        onChange={(v) => v && setMode(v)}
      />
      {config.mode === 'fixed' ? (
        <NumberInput label="Quantidade" value={config.amount} min={1} onChange={(amount) => onChange({ ...config, amount })} />
      ) : (
        <VarText
          label="Variável com o número"
          rows={1}
          value={config.variable ?? ''}
          placeholder="{{contexto.prazo}}"
          onChange={(variable) => onChange({ ...config, variable })}
          catalog={catalog}
        />
      )}
      <Select label="Unidade" value={config.unit} options={entries(UNIT_LABELS)} onChange={(unit) => unit && onChange({ ...config, unit })} />
      <Check
        label="Continuar antes se o contato responder"
        checked={config.resumeOnReply}
        onChange={(resumeOnReply) => onChange({ ...config, resumeOnReply })}
      />
    </div>
  );
}

export function ConditionForm({ config, onChange, catalog }: FormProps<ConditionConfig>) {
  return <RulesEditor prefix="" logic={config.logic} rules={config.rules} catalog={catalog} onChange={(next) => onChange({ ...config, ...next })} />;
}

export function MultiConditionForm({ config, onChange, catalog }: FormProps<MultiConditionConfig>) {
  const cases = config.cases ?? [];
  const setCase = (i: number, patch: Partial<MultiConditionConfig['cases'][number]>) =>
    onChange({ ...config, cases: cases.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  return (
    <div className="space-y-2">
      {cases.map((c, i) => (
        <div key={i} className="space-y-1 rounded border border-border p-2">
          <div className="flex items-center gap-1">
            <input aria-label={`Caso ${i + 1}: nome`} value={c.label} maxLength={40} onChange={(e) => setCase(i, { label: e.target.value })} className={control} />
            <RemoveButton
              label={`Remover caso ${i + 1}`}
              disabled={cases.length === 1}
              onClick={() => onChange({ ...config, cases: cases.filter((_, j) => j !== i) })}
            />
          </div>
          <RulesEditor prefix={`Caso ${i + 1} · `} logic={c.logic} rules={c.rules} catalog={catalog} onChange={(next) => setCase(i, next)} />
        </div>
      ))}
      <button
        type="button"
        className={addBtn}
        disabled={cases.length >= 20}
        onClick={() => onChange({ ...config, cases: [...cases, { label: `Caso ${cases.length + 1}`, logic: 'and', rules: [newRule()] }] })}
      >
        Adicionar caso
      </button>
      <p className="text-xs text-muted">Segue o primeiro caso verdadeiro; se nenhum for, sai por “Senão”.</p>
    </div>
  );
}

export function ValueForm({ config, onChange, catalog }: FormProps<ValueConfig>) {
  return <RuleRow label="Regra" rule={config} onChange={onChange} catalog={catalog} />;
}

export function DistributeForm({ config, onChange }: FormProps<DistributeConfig>) {
  const branches = config.branches ?? [];
  const total = branches.reduce((sum, b) => sum + b.weight, 0) || 1;
  const set = (i: number, patch: Partial<DistributeConfig['branches'][number]>) =>
    onChange({ ...config, branches: branches.map((b, j) => (j === i ? { ...b, ...patch } : b)) });
  return (
    <div className="space-y-1">
      {branches.map((b, i) => (
        <div key={i} className="flex items-center gap-1">
          <input aria-label={`Caminho ${i + 1}: nome`} value={b.label} maxLength={40} onChange={(e) => set(i, { label: e.target.value })} className={control} />
          <input
            type="number"
            aria-label={`Caminho ${i + 1}: peso`}
            min={1}
            step={1}
            value={b.weight}
            onChange={(e) => set(i, { weight: clampInt(e.target.value, 1) })}
            className={`${control} w-16 shrink-0`}
          />
          <span className="w-10 shrink-0 text-right text-xs text-muted">{Math.round((b.weight / total) * 100)}%</span>
          <RemoveButton
            label={`Remover caminho ${i + 1}`}
            disabled={branches.length <= 2}
            onClick={() => onChange({ ...config, branches: branches.filter((_, j) => j !== i) })}
          />
        </div>
      ))}
      <button
        type="button"
        className={addBtn}
        disabled={branches.length >= 10}
        onClick={() => onChange({ ...config, branches: [...branches, { label: String.fromCharCode(65 + branches.length), weight: 1 }] })}
      >
        Adicionar caminho
      </button>
    </div>
  );
}

export function ContactFieldForm({ config, onChange, catalog }: FormProps<ContactFieldConfig>) {
  return (
    <div className="space-y-2">
      <Select
        label="Campo"
        value={config.fieldId}
        placeholder="Escolha o campo…"
        options={fieldItems(catalog).map((f) => [f.id, f.label] as const)}
        onChange={(fieldId) => onChange({ ...config, fieldId })}
      />
      <Select
        label="Condição"
        value={config.operator}
        options={entries(RULE_OPERATOR_LABELS)}
        onChange={(operator) => operator && onChange({ ...config, operator })}
      />
      {needsRight(config.operator) && <TextInput label="Valor" value={config.value} onChange={(value) => onChange({ ...config, value })} />}
    </div>
  );
}

const TAG_MODES: Record<TagsConfig['mode'], string> = {
  any: 'Tem alguma destas etiquetas',
  all: 'Tem todas estas etiquetas',
  none: 'Não tem nenhuma destas etiquetas',
};

export function TagsForm({ config, onChange, catalog }: FormProps<TagsConfig>) {
  return (
    <div className="space-y-2">
      <Select label="Regra" value={config.mode} options={entries(TAG_MODES)} onChange={(mode) => mode && onChange({ ...config, mode })} />
      <CheckList label="Etiquetas" items={tagItems(catalog)} selected={config.tagIds} onChange={(tagIds) => onChange({ ...config, tagIds })} />
    </div>
  );
}

export function ChatSectorForm({ config, onChange, catalog }: FormProps<ChatSectorConfig>) {
  return <CheckList label="Setores" items={sectorItems(catalog)} selected={config.sectorIds} onChange={(sectorIds) => onChange({ ...config, sectorIds })} />;
}

export function ChatChannelForm({ config, onChange, catalog }: FormProps<ChatChannelConfig>) {
  return (
    <CheckList label="Canais" items={channelItems(catalog)} selected={config.channelIds} onChange={(channelIds) => onChange({ ...config, channelIds })} />
  );
}

const AGENT_MODES: Record<ChatAgentConfig['mode'], string> = {
  none: 'Sem atendente',
  any: 'Com qualquer atendente',
  specific: 'Com um destes atendentes',
};

export function ChatAgentForm({ config, onChange, catalog }: FormProps<ChatAgentConfig>) {
  return (
    <div className="space-y-2">
      <Select label="A conversa está" value={config.mode} options={entries(AGENT_MODES)} onChange={(mode) => mode && onChange({ ...config, mode })} />
      {config.mode === 'specific' && (
        <CheckList label="Atendentes" items={userItems(catalog)} selected={config.userIds} onChange={(userIds) => onChange({ ...config, userIds })} />
      )}
    </div>
  );
}

export function MessageContainsForm({ config, onChange }: FormProps<MessageContainsConfig>) {
  // keep the text as typed (blank lines included) so Enter works; store only the non-empty trimmed lines
  const [text, setText] = useState(() => (config.keywords ?? []).join('\n'));
  return (
    <div className="space-y-2">
      <Field label="Palavras ou frases" hint="Uma por linha. Maiúsculas e acentos não importam.">
        <textarea
          aria-label="Palavras ou frases"
          rows={3}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            onChange({ ...config, keywords: e.target.value.split('\n').map((k) => k.trim()).filter(Boolean) });
          }}
          className={control}
        />
      </Field>
      <Select
        label="A mensagem precisa ter"
        value={config.match}
        options={[
          ['any', 'Qualquer uma delas'],
          ['all', 'Todas elas'],
        ]}
        onChange={(match) => match && onChange({ ...config, match })}
      />
    </div>
  );
}
```

- [ ] **Step 5: Write the action and finish forms**

Create `web/src/components/bot-editor/cards/actions.tsx`:

```tsx
import { useRef, useState } from 'react';
import type {
  AskChoiceConfig,
  AskInputConfig,
  BotDto,
  CallFlowConfig,
  CloseChatConfig,
  EditTagsConfig,
  InputValidator,
  MediaType,
  NoteConfig,
  NotifyAgentConfig,
  PrivacyConfig,
  SendMessageConfig,
  SetContactFieldConfig,
  TransferAgentConfig,
  TransferSectorConfig,
} from '@talk/shared';
import { api } from '../../../lib/api';
import {
  Check,
  CheckList,
  Field,
  NumberInput,
  RemoveButton,
  Select,
  VarText,
  addBtn,
  control,
  entries,
  fieldItems,
  sectorItems,
  tagItems,
  userItems,
  type FormProps,
} from './fields';

export function SendMessageForm({ config, onChange, catalog }: FormProps<SendMessageConfig>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // the upload is async: merge into the config current when it finishes, not the one when it started
  const latest = useRef(config);
  latest.current = config;

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    try {
      const attachment = await api.bots.uploadMedia(file, file.name);
      onChange({ ...latest.current, attachment });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível enviar o arquivo');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <VarText label="Mensagem" value={config.text} onChange={(text) => onChange({ ...config, text })} catalog={catalog} />
      <Field label="Arquivo (opcional)" hint="Com arquivo, o texto vai como legenda. O chatbot não usa assinatura.">
        {config.attachment ? (
          <div className="flex items-center gap-1">
            <span className="truncate text-sm">{config.attachment.name}</span>
            <RemoveButton label="Remover arquivo" onClick={() => onChange({ ...config, attachment: null })} />
          </div>
        ) : (
          <input
            type="file"
            aria-label="Arquivo"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void upload(file);
            }}
            className="text-xs"
          />
        )}
        {busy && <p className="text-xs text-muted">Enviando…</p>}
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
      </Field>
    </div>
  );
}

export function NoteForm({ config, onChange, catalog }: FormProps<NoteConfig>) {
  return (
    <VarText
      label="Nota"
      hint="Aparece na conversa só para a equipe."
      value={config.text}
      onChange={(text) => onChange({ ...config, text })}
      catalog={catalog}
    />
  );
}

type AskShared = { invalidText?: string; invalidRetries: number; timeoutHours?: number | null };

/** Fields shared by ask_choice and ask_input: invalid text, extra attempts and the optional timeout. */
function AskCommon<C extends AskShared>({ config, onChange, catalog, invalidPlaceholder }: FormProps<C> & { invalidPlaceholder: string }) {
  const hasTimeout = (config.timeoutHours ?? 0) > 0;
  return (
    <>
      <VarText
        label="Mensagem se a resposta for inválida"
        rows={2}
        value={config.invalidText ?? ''}
        placeholder={invalidPlaceholder}
        onChange={(invalidText) => onChange({ ...config, invalidText })}
        catalog={catalog}
      />
      <Select
        label="Tentativas extras"
        hint="Depois delas, segue pela saída “Resposta inválida”."
        value={String(config.invalidRetries)}
        options={[
          ['0', 'Não repetir'],
          ['1', '1 vez'],
          ['2', '2 vezes'],
          ['3', '3 vezes'],
        ]}
        onChange={(v) => onChange({ ...config, invalidRetries: Number(v) })}
      />
      <Check
        label="Limitar tempo de espera"
        checked={hasTimeout}
        onChange={(on) => onChange({ ...config, timeoutHours: on ? 24 : null })}
      />
      {hasTimeout && (
        <NumberInput
          label="Horas sem resposta"
          value={config.timeoutHours ?? 24}
          min={1}
          max={720}
          onChange={(timeoutHours) => onChange({ ...config, timeoutHours })}
        />
      )}
    </>
  );
}

export function AskChoiceForm({ config, onChange, catalog }: FormProps<AskChoiceConfig>) {
  const options = config.options ?? [];
  const set = (i: number, patch: Partial<AskChoiceConfig['options'][number]>) =>
    onChange({ ...config, options: options.map((o, j) => (j === i ? { ...o, ...patch } : o)) });

  function add() {
    const next = Math.max(0, ...options.map((o) => Number.parseInt(o.key, 10) || 0)) + 1;
    onChange({ ...config, options: [...options, { key: String(next), label: '' }] });
  }

  return (
    <div className="space-y-2">
      <VarText label="Mensagem" value={config.text} onChange={(text) => onChange({ ...config, text })} catalog={catalog} />
      <fieldset>
        <legend className="text-xs font-medium text-muted">Opções</legend>
        {options.map((o, i) => (
          <div key={i} className="mt-1 flex items-center gap-1">
            <input
              aria-label={`Opção ${i + 1}: número`}
              value={o.key}
              maxLength={10}
              onChange={(e) => set(i, { key: e.target.value.trim() })}
              className={`${control} w-14 shrink-0`}
            />
            <input aria-label={`Opção ${i + 1}: texto`} value={o.label} maxLength={60} onChange={(e) => set(i, { label: e.target.value })} className={control} />
            <RemoveButton
              label={`Remover opção ${i + 1}`}
              disabled={options.length === 1}
              onClick={() => onChange({ ...config, options: options.filter((_, j) => j !== i) })}
            />
          </div>
        ))}
        <p className="mt-1 text-xs text-muted">O contato pode digitar o número ou o texto. Mudar o número desconecta a saída da opção.</p>
      </fieldset>
      <button type="button" className={addBtn} disabled={options.length >= 20} onClick={add}>
        Adicionar opção
      </button>
      <AskCommon config={config} onChange={onChange} catalog={catalog} invalidPlaceholder="Opção inválida." />
    </div>
  );
}

const VALIDATOR_LABELS: Record<InputValidator, string> = {
  any: 'Qualquer resposta',
  email: 'E-mail',
  phone: 'Telefone (Brasil)',
  cpf: 'CPF',
  cnpj: 'CNPJ',
  media: 'Arquivo ou mídia',
  regex: 'Formato próprio (expressão regular)',
};
const MEDIA_LABELS: Record<MediaType, string> = { pdf: 'PDF', audio: 'Áudio', image: 'Imagem', video: 'Vídeo' };

/** Same rule as the server's compileUserRegex: flag 'u', at most 200 chars. */
function regexProblem(pattern: string): string | null {
  if (pattern.length > 200) return 'Use no máximo 200 caracteres';
  try {
    new RegExp(pattern, 'u');
    return null;
  } catch {
    return 'Expressão inválida';
  }
}

export function AskInputForm({ config, onChange, catalog }: FormProps<AskInputConfig>) {
  function setValidator(validator: InputValidator) {
    const { mediaTypes, regex, ...rest } = config;
    onChange({
      ...rest,
      validator,
      ...(validator === 'media' ? { mediaTypes: mediaTypes ?? [] } : {}),
      ...(validator === 'regex' ? { regex: regex ?? '' } : {}),
    });
  }
  const problem = config.validator === 'regex' && config.regex ? regexProblem(config.regex) : null;

  return (
    <div className="space-y-2">
      <VarText label="Mensagem" value={config.text} onChange={(text) => onChange({ ...config, text })} catalog={catalog} />
      <Select label="Tipo de resposta" value={config.validator} options={entries(VALIDATOR_LABELS)} onChange={(v) => v && setValidator(v)} />
      {config.validator === 'media' && (
        <CheckList
          label="Tipos aceitos"
          hint="Nenhum marcado aceita qualquer mídia."
          items={entries(MEDIA_LABELS).map(([id, label]) => ({ id, label }))}
          selected={config.mediaTypes ?? []}
          onChange={(ids) => onChange({ ...config, mediaTypes: ids as MediaType[] })}
        />
      )}
      {config.validator === 'regex' && (
        <Field label="Expressão regular" hint="Exemplo para CEP: ^\d{5}-?\d{3}$">
          <input
            aria-label="Expressão regular"
            value={config.regex ?? ''}
            maxLength={200}
            onChange={(e) => onChange({ ...config, regex: e.target.value })}
            className={control}
          />
          {problem && <p className="text-xs text-danger">{problem}</p>}
        </Field>
      )}
      <Check
        label="Aproveitar a última mensagem do contato, se for válida"
        checked={config.useLastMessage}
        onChange={(useLastMessage) => onChange({ ...config, useLastMessage })}
      />
      <Select
        label="Salvar no campo"
        value={config.saveToField ?? ''}
        placeholder="Não salvar"
        allowEmpty
        options={fieldItems(catalog).map((f) => [f.id, f.label] as const)}
        onChange={(v) => onChange({ ...config, saveToField: v || null })}
      />
      <AskCommon config={config} onChange={onChange} catalog={catalog} invalidPlaceholder="Resposta inválida. Tente de novo." />
    </div>
  );
}

export function SetContactFieldForm({ config, onChange, catalog }: FormProps<SetContactFieldConfig>) {
  return (
    <div className="space-y-2">
      <Select
        label="Campo"
        value={config.fieldId}
        placeholder="Escolha o campo…"
        options={fieldItems(catalog).map((f) => [f.id, f.label] as const)}
        onChange={(fieldId) => onChange({ ...config, fieldId })}
      />
      <VarText label="Valor" rows={1} value={config.value} onChange={(value) => onChange({ ...config, value })} catalog={catalog} />
    </div>
  );
}

export function EditTagsForm({ config, onChange, catalog }: FormProps<EditTagsConfig>) {
  return (
    <div className="space-y-2">
      <CheckList label="Adicionar ao contato" items={tagItems(catalog)} selected={config.add} onChange={(add) => onChange({ ...config, add })} />
      <CheckList label="Remover do contato" items={tagItems(catalog)} selected={config.remove} onChange={(remove) => onChange({ ...config, remove })} />
    </div>
  );
}

export function TransferSectorForm({ config, onChange, catalog }: FormProps<TransferSectorConfig>) {
  return (
    <div className="space-y-2">
      <Select
        label="Setor"
        value={config.sectorId}
        placeholder="Escolha o setor…"
        options={sectorItems(catalog).map((s) => [s.id, s.label] as const)}
        onChange={(sectorId) => onChange({ ...config, sectorId })}
      />
      <Check
        label="Manter o atendente só se ele pertencer ao setor de destino"
        checked={config.onlyIfAgentAllowed}
        onChange={(onlyIfAgentAllowed) => onChange({ ...config, onlyIfAgentAllowed })}
      />
    </div>
  );
}

const AGENT_RULES: Record<TransferAgentConfig['rule'], string> = {
  specific: 'O primeiro ativo desta lista',
  least_busy: 'Quem tiver menos conversas abertas',
};

export function TransferAgentForm({ config, onChange, catalog }: FormProps<TransferAgentConfig>) {
  return (
    <div className="space-y-2">
      <Select label="Como escolher o atendente" value={config.rule} options={entries(AGENT_RULES)} onChange={(rule) => rule && onChange({ ...config, rule })} />
      {config.rule === 'specific' ? (
        <CheckList label="Atendentes" items={userItems(catalog)} selected={config.userIds} onChange={(userIds) => onChange({ ...config, userIds })} />
      ) : (
        <CheckList label="Nos setores" items={sectorItems(catalog)} selected={config.sectorIds} onChange={(sectorIds) => onChange({ ...config, sectorIds })} />
      )}
    </div>
  );
}

export function PrivacyForm({ config, onChange }: FormProps<PrivacyConfig>) {
  return (
    <Select
      label="Tornar a conversa"
      value={config.mode}
      options={[
        ['private', 'Privada (só o atendente e admins veem)'],
        ['public', 'Pública para o setor'],
      ]}
      onChange={(mode) => mode && onChange({ ...config, mode })}
    />
  );
}

export function NotifyAgentForm({ config, onChange, catalog }: FormProps<NotifyAgentConfig>) {
  return (
    <div className="space-y-2">
      <VarText label="Título" rows={1} value={config.title} onChange={(title) => onChange({ ...config, title })} catalog={catalog} />
      <VarText label="Texto" value={config.text} onChange={(text) => onChange({ ...config, text })} catalog={catalog} />
      <Select
        label="Quem recebe"
        value={config.target}
        options={[
          ['owner', 'O atendente da conversa'],
          ['users', 'Atendentes escolhidos'],
        ]}
        onChange={(target) => target && onChange({ ...config, target })}
      />
      {config.target === 'users' && (
        <CheckList label="Atendentes" items={userItems(catalog)} selected={config.userIds} onChange={(userIds) => onChange({ ...config, userIds })} />
      )}
    </div>
  );
}

export function CallFlowForm({ config, onChange, catalog, bot }: FormProps<CallFlowConfig> & { bot: BotDto }) {
  const others = catalog.bots
    .filter((b) => b.id !== bot.id)
    .map((b) => [b.id, b.status === 'active' && b.publishedVersionId ? b.name : `${b.name} (inativo)`] as const);
  return (
    <div className="space-y-2">
      <Select
        label="Fluxo"
        hint="O fluxo escolhido precisa estar ativo e publicado."
        value={config.botId}
        placeholder="Escolha o fluxo…"
        options={others}
        onChange={(botId) => onChange({ ...config, botId })}
      />
      <Check
        label="Voltar para este fluxo quando o outro terminar"
        checked={config.continueAfter}
        onChange={(continueAfter) => onChange({ ...config, continueAfter })}
      />
    </div>
  );
}

export function CloseChatForm({ config, onChange, catalog }: FormProps<CloseChatConfig>) {
  return (
    <div className="space-y-2">
      <Check
        label="Enviar mensagem de finalização"
        checked={config.sendClosingMessage}
        onChange={(sendClosingMessage) => onChange({ ...config, sendClosingMessage })}
      />
      {config.sendClosingMessage && (
        <VarText
          label="Mensagem de finalização"
          hint="Em branco, usa a mensagem de Configurações › Conversas."
          value={config.closingText ?? ''}
          onChange={(closingText) => onChange({ ...config, closingText })}
          catalog={catalog}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 6: Write the start and utility forms**

Create `web/src/components/bot-editor/cards/start.tsx`:

```tsx
import { useState } from 'react';
import type { BotDto, BotPatch, StickyColor, StickyNoteConfig } from '@talk/shared';
import type { EditorCatalog } from '../useEditorCatalog';
import { Check, CheckList, Field, Select, TextInput, channelItems, control, entries, type FormProps } from './fields';

interface BotFormProps {
  bot: BotDto;
  catalog: EditorCatalog;
  onBotChange(patch: BotPatch): void;
}

/** Shows the bot with this card's edits and reports the cumulative patch, so merging or replacing it upstream gives the same result. */
function useBotDraft(bot: BotDto, onBotChange: (patch: BotPatch) => void) {
  const [patch, setPatch] = useState<BotPatch>({});
  return {
    current: { ...bot, ...patch },
    change(p: BotPatch) {
      const next = { ...patch, ...p };
      setPatch(next);
      onBotChange(next);
    },
  };
}

export function StartChannelForm({ bot, catalog, onBotChange }: BotFormProps) {
  const { current, change } = useBotDraft(bot, onBotChange);
  return (
    <CheckList
      label="Canais"
      hint="Se dois chatbots ativos usam o mesmo canal, inicia o mais antigo. A triagem simples não roda nesses canais."
      items={channelItems(catalog)}
      selected={current.startChannelIds}
      onChange={(startChannelIds) => change({ startChannelIds })}
    />
  );
}

export function StartManualForm({ bot, onBotChange }: BotFormProps) {
  const { current, change } = useBotDraft(bot, onBotChange);
  return (
    <div className="space-y-2">
      <Check
        label="Permitir que atendentes iniciem pela conversa"
        checked={current.manualStart}
        onChange={(manualStart) => change({ manualStart })}
      />
      <TextInput
        label="Título no painel"
        hint="Em branco, usa o nome do chatbot."
        value={current.manualTitle}
        placeholder={bot.name}
        maxLength={80}
        onChange={(manualTitle) => change({ manualTitle })}
      />
      <Check
        label="Não mostrar no painel (só outro fluxo aciona)"
        checked={current.manualUnlisted}
        onChange={(manualUnlisted) => change({ manualUnlisted })}
      />
    </div>
  );
}

const STICKY_COLORS: Record<StickyColor, string> = { yellow: 'Amarelo', blue: 'Azul', green: 'Verde', pink: 'Rosa', gray: 'Cinza' };

export function StickyNoteForm({ config, onChange }: FormProps<StickyNoteConfig>) {
  return (
    <div className="space-y-2">
      <Field label="Texto da anotação">
        <textarea
          aria-label="Texto da anotação"
          rows={4}
          value={config.text}
          onChange={(e) => onChange({ ...config, text: e.target.value })}
          className={control}
        />
      </Field>
      <Select label="Cor" value={config.color} options={entries(STICKY_COLORS)} onChange={(color) => color && onChange({ ...config, color })} />
    </div>
  );
}
```

- [ ] **Step 7: Replace the card entry point**

Replace the whole content of `web/src/components/bot-editor/cards/index.tsx` (Task 14's fallback) with:

```tsx
import type { JSX, ReactNode } from 'react';
import { catalogEntry, defaultConfig, type BlockType, type BotDto, type BotNode, type BotPatch } from '@talk/shared';
import type { EditorCatalog } from '../useEditorCatalog';
import {
  AskChoiceForm,
  AskInputForm,
  CallFlowForm,
  CloseChatForm,
  EditTagsForm,
  NoteForm,
  NotifyAgentForm,
  PrivacyForm,
  SendMessageForm,
  SetContactFieldForm,
  TransferAgentForm,
  TransferSectorForm,
} from './actions';
import {
  ChatAgentForm,
  ChatChannelForm,
  ChatSectorForm,
  ConditionForm,
  ContactFieldForm,
  DistributeForm,
  HoursForm,
  MessageContainsForm,
  MultiConditionForm,
  TagsForm,
  ValueForm,
  WaitIntervalForm,
  WeekdaysForm,
} from './conditions';
import { StartChannelForm, StartManualForm, StickyNoteForm } from './start';

export interface BlockCardProps {
  node: BotNode;
  catalog: EditorCatalog;
  bot: BotDto;
  problems: string[];
  onChange(config: Record<string, unknown>): void;
  onBotChange(patch: BotPatch): void;
}

/** What every form receives; `config: never` lets one object satisfy each form's FormProps<XConfig>. */
interface FormInput {
  config: never;
  onChange(next: unknown): void;
  catalog: EditorCatalog;
  bot: BotDto;
  onBotChange(patch: BotPatch): void;
}

const none = () => null; // blocks with no config: the description says it all

// Record<BlockType, …> makes the compiler fail when a type in BLOCK_TYPES has no form.
const FORMS: Record<BlockType, (p: FormInput) => ReactNode> = {
  start_channel: (p) => <StartChannelForm {...p} />,
  start_manual: (p) => <StartManualForm {...p} />,
  weekdays: (p) => <WeekdaysForm {...p} />,
  hours: (p) => <HoursForm {...p} />,
  wait_interval: (p) => <WaitIntervalForm {...p} />,
  condition: (p) => <ConditionForm {...p} />,
  multi_condition: (p) => <MultiConditionForm {...p} />,
  value: (p) => <ValueForm {...p} />,
  distribute: (p) => <DistributeForm {...p} />,
  contact_active: none,
  first_chat: none,
  contact_field: (p) => <ContactFieldForm {...p} />,
  tags: (p) => <TagsForm {...p} />,
  chat_sector: (p) => <ChatSectorForm {...p} />,
  chat_channel: (p) => <ChatChannelForm {...p} />,
  chat_agent: (p) => <ChatAgentForm {...p} />,
  chat_status: none,
  message_contains: (p) => <MessageContainsForm {...p} />,
  parallel_bot: none,
  send_message: (p) => <SendMessageForm {...p} />,
  note: (p) => <NoteForm {...p} />,
  ask_choice: (p) => <AskChoiceForm {...p} />,
  ask_input: (p) => <AskInputForm {...p} />,
  set_contact_field: (p) => <SetContactFieldForm {...p} />,
  edit_tags: (p) => <EditTagsForm {...p} />,
  transfer_sector: (p) => <TransferSectorForm {...p} />,
  transfer_agent: (p) => <TransferAgentForm {...p} />,
  privacy: (p) => <PrivacyForm {...p} />,
  notify_agent: (p) => <NotifyAgentForm {...p} />,
  call_flow: (p) => <CallFlowForm {...p} />,
  block_contact: none,
  close_chat: (p) => <CloseChatForm {...p} />,
  sticky_note: (p) => <StickyNoteForm {...p} />,
};

export function BlockConfigCard({ node, catalog, bot, problems, onChange, onBotChange }: BlockCardProps): JSX.Element {
  // defaults first, so a config from an older or imported graph never misses a key the form reads
  const config = { ...defaultConfig(node.type), ...node.config } as never;
  const input: FormInput = { config, onChange: (c) => onChange(c as Record<string, unknown>), catalog, bot, onBotChange };
  return (
    // nodrag/nowheel: typing or scrolling inside a React Flow node must not drag the node or zoom the canvas
    <div className="nodrag nowheel space-y-2 text-sm">
      <p className="text-xs text-muted">{catalogEntry(node.type).description}</p>
      {problems.length > 0 && (
        <ul role="alert" className="space-y-0.5 text-xs text-danger">
          {problems.map((m, i) => (
            <li key={i}>{m}</li>
          ))}
        </ul>
      )}
      {/* key: local state (keywords text, bot draft, upload) belongs to one node */}
      <div key={node.id} className="space-y-2">
        {FORMS[node.type](input)}
      </div>
    </div>
  );
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npm test -w web -- src/components/bot-editor/cards`
Expected: PASS (16 tests).

- [ ] **Step 9: Typecheck and run the whole web suite**

Run: `npm run typecheck -w web`, then `npm test -w web`
Expected: `tsc --noEmit` exits 0, and every web test passes, including Task 14's `BotEditor.test.tsx`, which now renders the real cards. If tsc reports `Module '"../useEditorCatalog"' has no exported member 'EditorCatalog'`, add `export` to the `EditorCatalog` interface in `web/src/components/bot-editor/useEditorCatalog.ts` and run the command again.

- [ ] **Step 10: Commit**

```bash
git add web/src/components/bot-editor/cards/index.tsx web/src/components/bot-editor/cards/fields.tsx web/src/components/bot-editor/cards/conditions.tsx web/src/components/bot-editor/cards/actions.tsx web/src/components/bot-editor/cards/start.tsx web/src/components/bot-editor/cards/cards.test.tsx web/src/components/bot-editor/useEditorCatalog.ts
git commit -m "feat(web): cartões de configuração de todos os blocos do chatbot

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
(If `useEditorCatalog.ts` did not change, git ignores the unchanged path in `git add`.)


---

### Task 16: Web conversation integration

Bot messages get a robot icon and the label `Chatbot <nome>`, and `bot_*` events in the timeline get a robot icon. The composer gets a robot button that opens the "Executar chatbot" panel (manual bots, start, and "Parar chatbot" for running runs). A 409 `BOT_RUNNING` on send or transfer opens a 3-choice dialog and retries with `botAction`. `notify_agent` notifications show as an 8 s toast and, when allowed, as a browser notification.

**Files:**
- Modify: `web/src/components/conversation/MessageBubble.tsx` (icon import, `label`, label `<p>`)
- Modify: `web/src/components/conversation/Timeline.tsx` (icon import, event row icon)
- Create: `web/src/components/conversation/Timeline.test.tsx`
- Modify: `web/src/components/conversation/MessageBubble.test.tsx` (append a `describe`)
- Modify: `web/src/components/conversation/ChatDialogs.tsx` (add `BotRunningDialog`; `Modal` and `Actions` are already exported by Task 13)
- Modify: `web/src/components/conversation/Composer.tsx` (imports, state, `submit`, `send`, `toggleRecording`, robot button, dialog)
- Modify: `web/src/components/conversation/ConversationHeader.tsx` (transfer retry with `botAction`)
- Create: `web/src/components/conversation/ConversationHeader.test.tsx`
- Modify: `web/src/components/conversation/Composer.test.tsx` (`showModal` stub, appended `describe`)
- Create: `web/src/components/conversation/BotPanel.tsx`
- Create: `web/src/components/conversation/BotPanel.test.tsx`
- Create: `web/src/components/layout/NotificationToasts.tsx`
- Create: `web/src/components/layout/NotificationToasts.test.tsx`
- Modify: `web/src/components/layout/AppLayout.tsx` (mount `NotificationToasts`)

**Interfaces:**
- Consumes (Task 1, `@talk/shared`):
  - `MessageDto.botRunId?: string | null` and `MessageDto.botName?: string | null`
  - `ChatEventDto.kind` with `'bot_started' | 'bot_finished' | 'bot_stopped' | 'bot_failed' | 'bot_transferred' | 'bot_note'`, and `eventText` already returning `Chatbot ${n} iniciado` and the rest
  - `WsEvent` member `{ type: 'notification'; notification: NotificationDto }` and the no-op `case 'notification': return;` in `applyWsEvent`
  - `interface NotificationDto { id: string; chatId: string; title: string; text: string; botName: string; createdAt: string }`
  - `interface BotRunningErrorBody { error: string; code: 'BOT_RUNNING'; runs: Array<{ id: string; botName: string }> }`
  - `type BotAction = 'stop' | 'keep'`
  - `interface ManualBotDto { id: string; title: string }`, `interface BotRunDto { id; botId; botName; chatId; state: BotRunState; currentNodeId; depth; startedByName; error; createdAt; updatedAt; finishedAt }`
- Consumes (Task 13, `web/src/lib/api.ts`):
  - `ApiError.data?: unknown`, which `request()` fills with the parsed error body
  - `botRunningRuns(e: unknown): BotRunningErrorBody['runs'] | null` (an `ApiError` 409 with `data.code === 'BOT_RUNNING'`)
  - `SendTextInput.botAction?: BotAction`, `SendFileInput.botAction?: BotAction` (multipart field appended before the file), and `api.chats.transfer(id, to: { sectorId?: string; ownerId?: string | null; botAction?: BotAction })`
  - `api.bots.manual(): Promise<ManualBotDto[]>` (GET `/api/bots/manual`)
  - `api.botRuns.listForChat(chatId): Promise<BotRunDto[]>` (GET `/api/chats/:id/bot-runs`), `api.botRuns.start(chatId, botId): Promise<BotRunDto>` (POST `/api/chats/:id/bot-runs` `{ botId }`), `api.botRuns.stop(runId): Promise<BotRunDto>` (POST `/api/bot-runs/:id/stop`)
  - `qk.botManual = ['bots', 'manual']`, `qk.chatBotRuns(chatId) = ['chats', 'bot-runs', chatId]`
- Consumes (existing): `useSend`, `ErrorText` from `web/src/components/settings/common.tsx`; `useWsEvent`, `connectWs` from `web/src/lib/ws.ts`
- Consumes (Task 13): `Modal` and `Actions`, already exported from `ChatDialogs.tsx`:
  - `export function Modal({ title, onCancel, children }: { title: string; onCancel: () => void; children: ReactNode }): JSX.Element` and `export function Actions(props: { busy: boolean; error: string | null; confirmLabel: string; onCancel: () => void; onConfirm: () => void }): JSX.Element` in `ChatDialogs.tsx`
  - `export function BotRunningDialog({ runs, onChoose, action }: { runs: BotRunningErrorBody['runs']; onChoose: (a: BotAction | null) => void; action?: 'send' | 'transfer' }): JSX.Element`. Its title is "O chatbot está rodando". With `action` `'send'` (the default) the buttons are "Parar e enviar" (`'stop'`), "Enviar e manter" (`'keep'`) and "Cancelar" (`null`). With `'transfer'` they are "Parar e transferir", "Transferir e manter" and "Cancelar".
  - `export interface BotPanelProps { chatId: string; onClose: () => void }` and `export function BotPanel(props: BotPanelProps): JSX.Element` in `web/src/components/conversation/BotPanel.tsx`
  - `export const TOAST_MS = 8000` and `export function NotificationToasts(): JSX.Element` in `web/src/components/layout/NotificationToasts.tsx`

**Test note:** jsdom 30 has no `HTMLDialogElement.prototype.showModal`, so `Modal` would throw in its effect. Every test file that opens a `ChatDialogs` modal stubs it at module level so that it sets the `open` attribute, which makes the dialog queryable by role.

---

#### Cycle 1: bot messages and bot events

- [ ] **Step 1: Write the failing tests**

Append this block to the end of `web/src/components/conversation/MessageBubble.test.tsx`. Its imports and `base` / `renderBubble` already exist in the file.

```tsx
describe('MessageBubble chatbot messages', () => {
  const system = { ...base, authorId: null, authorName: null, authorAvatarUrl: null };

  it('labels a message sent by a chatbot run with the robot icon and "Chatbot <nome>"', () => {
    const c = renderBubble({ ...system, botRunId: 'r1', botName: 'Fluxo do escritório' });
    expect(c.textContent).toContain('Chatbot Fluxo do escritório');
    expect(c.textContent).not.toContain('Celular ou sistema');
    expect(c.querySelector('[data-bot-icon]')).not.toBeNull();
    expect(c.querySelector('[data-author-avatar]')).toBeNull();
  });

  it('keeps the phone/system label and no robot when the message has no bot', () => {
    const c = renderBubble({ ...system, botRunId: null, botName: null });
    expect(c.textContent).toContain('Celular ou sistema');
    expect(c.querySelector('[data-bot-icon]')).toBeNull();
  });

  it('never shows the robot on an incoming message', () => {
    const c = renderBubble({ ...system, direction: 'in', botName: 'Fluxo do escritório' });
    expect(c.querySelector('[data-bot-icon]')).toBeNull();
    expect(c.textContent).not.toContain('Chatbot');
  });
});
```

Create `web/src/components/conversation/Timeline.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TimelineItem } from '@talk/shared';
import { Timeline } from './Timeline';

const ITEMS: TimelineItem[] = [
  { type: 'event', id: 'e1', chatId: 'c1', kind: 'created', data: {}, authorName: null, createdAt: '2026-10-15T12:00:00.000Z' },
  {
    type: 'event', id: 'e2', chatId: 'c1', kind: 'bot_started',
    data: { botId: 'b1', botName: 'Fluxo do escritório', runId: 'r1' }, authorName: null, createdAt: '2026-10-15T12:00:01.000Z',
  },
];

function stubFetch(routes: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const key = `${init?.method ?? 'GET'} ${url.pathname}`;
      if (!(key in routes)) return new Response(JSON.stringify({ error: 'inesperado' }), { status: 500 });
      return new Response(JSON.stringify(routes[key]), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Timeline chatbot events', () => {
  it('marks bot_* events with the robot icon and other events with the info icon', async () => {
    stubFetch({ 'GET /api/chats/c1/timeline': ITEMS, 'GET /api/sectors': [], 'GET /api/users': [] });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <Timeline chatId="c1" onReply={() => {}} />
      </QueryClientProvider>,
    );
    const bot = await screen.findByText(/Chatbot Fluxo do escritório iniciado/);
    expect(bot.querySelector('[data-bot-event]')).not.toBeNull();
    const created = screen.getByText(/Conversa iniciada pelo contato/);
    expect(created.querySelector('[data-bot-event]')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w web -- src/components/conversation/MessageBubble.test.tsx src/components/conversation/Timeline.test.tsx`
Expected: FAIL. The first MessageBubble test fails with `expected '…Celular ou sistema…' to contain 'Chatbot Fluxo do escritório'`, and the Timeline test fails with `expected null not to be null` (no `[data-bot-event]` icon yet). The other new tests pass already.

- [ ] **Step 3: Implement**

In `web/src/components/conversation/MessageBubble.tsx`, replace the icon import line

```tsx
import { ArrowBendUpLeft, Check, Checks, Clock, FileText, ImageBroken, WarningCircle } from '@phosphor-icons/react';
```

with

```tsx
import { ArrowBendUpLeft, Check, Checks, Clock, FileText, ImageBroken, Robot, WarningCircle } from '@phosphor-icons/react';
```

Replace the `label` declaration

```tsx
  const label = isNote
    ? `Nota interna · ${m.authorName ?? 'Atendente'}`
    : m.direction === 'out'
      ? (m.authorName ?? 'Celular ou sistema') // authorId null = sent from the phone or by the triage bot
      : null;
```

with

```tsx
  // a chatbot run sends as the system (authorId null) and the server fills botName
  const botName = !isNote && m.direction === 'out' ? (m.botName ?? null) : null;
  const label = isNote
    ? `Nota interna · ${m.authorName ?? 'Atendente'}`
    : botName
      ? `Chatbot ${botName}`
      : m.direction === 'out'
        ? (m.authorName ?? 'Celular ou sistema') // authorId null = sent from the phone or by the triage
        : null;
```

Replace the label paragraph

```tsx
        {label && <p className="mb-1 text-xs font-semibold opacity-75">{label}</p>}
```

with

```tsx
        {label && (
          <p className="mb-1 flex items-center gap-1 text-xs font-semibold opacity-75">
            {botName && <Robot size={14} weight="fill" aria-hidden data-bot-icon className="shrink-0" />}
            {label}
          </p>
        )}
```

In `web/src/components/conversation/Timeline.tsx`, replace

```tsx
import { Info } from '@phosphor-icons/react';
```

with

```tsx
import { Info, Robot } from '@phosphor-icons/react';
```

and replace

```tsx
              <Info size={14} className="shrink-0" />
              {eventText(item, names)} · {timeOfDay(item.createdAt)}
```

with

```tsx
              {item.kind.startsWith('bot_') ? (
                <Robot size={14} aria-hidden data-bot-event className="shrink-0" />
              ) : (
                <Info size={14} className="shrink-0" />
              )}
              {eventText(item, names)} · {timeOfDay(item.createdAt)}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w web -- src/components/conversation/MessageBubble.test.tsx src/components/conversation/Timeline.test.tsx`
Expected: PASS (6 MessageBubble tests and 1 Timeline test).

- [ ] **Step 5: Commit**

```bash
git add web/src/components/conversation/MessageBubble.tsx web/src/components/conversation/MessageBubble.test.tsx web/src/components/conversation/Timeline.tsx web/src/components/conversation/Timeline.test.tsx
git commit -m "feat(web): robot label on chatbot messages and bot events

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

#### Cycle 2: the BOT_RUNNING dialog on send and transfer

- [ ] **Step 1: Write the failing tests**

In `web/src/components/conversation/Composer.test.tsx`, add this right after the last `import` line:

```tsx
// jsdom has no modal <dialog> API; the browser opens ChatDialogs' Modal with showModal()
HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
  this.setAttribute('open', '');
};
```

Then append this block to the end of the file (it reuses `calls`, `message`, `renderComposer`, `box` and `posts` from the file):

```tsx
const BOT_RUNNING = {
  error: 'O chatbot está em execução nesta conversa',
  code: 'BOT_RUNNING',
  runs: [{ id: 'r1', botName: 'Fluxo do escritório' }],
};

/** The first request answers 409 BOT_RUNNING; every later one succeeds with message(). */
function stubBotRunning() {
  calls.length = 0;
  let first = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      calls.push({
        method: init?.method ?? 'GET',
        path: url.pathname,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
      });
      const status = first ? 409 : 200;
      first = false;
      return new Response(JSON.stringify(status === 409 ? BOT_RUNNING : message()), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

describe('Composer with a running chatbot', () => {
  it.each([
    ['Parar e enviar', 'stop'],
    ['Enviar e manter', 'keep'],
  ] as const)('asks on 409 BOT_RUNNING and "%s" resends with botAction "%s"', async (label, botAction) => {
    stubBotRunning();
    const { qc } = renderComposer();
    fireEvent.change(box(), { target: { value: 'Bom dia' } });
    fireEvent.keyDown(box(), { key: 'Enter' });

    const dialog = await screen.findByRole('dialog', { name: 'O chatbot está rodando' });
    expect(dialog.textContent).toContain('Fluxo do escritório');
    expect(screen.queryByRole('alert')).toBeNull(); // the 409 is a question, not an error
    fireEvent.click(screen.getByRole('button', { name: label }));

    await waitFor(() => expect(qc.getQueryData<TimelineData>(qk.timeline('c1'))!.pages[0]).toHaveLength(1));
    expect(posts('/api/chats/c1/messages').map((c) => c.body)).toEqual([
      { text: 'Bom dia', signature: true },
      { text: 'Bom dia', signature: true, botAction },
    ]);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('"Cancelar" sends nothing more and puts the text back', async () => {
    stubBotRunning();
    renderComposer();
    fireEvent.change(box(), { target: { value: 'Bom dia' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await screen.findByRole('dialog', { name: 'O chatbot está rodando' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));

    await waitFor(() => expect(box().value).toBe('Bom dia'));
    expect(posts('/api/chats/c1/messages')).toHaveLength(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
```

Create `web/src/components/conversation/ConversationHeader.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ChatDetail, Me, SectorDto } from '@talk/shared';
import { qk } from '../../lib/api';
import { ConversationHeader } from './ConversationHeader';

// jsdom has no modal <dialog> API; the browser opens ChatDialogs' Modal with showModal()
HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
  this.setAttribute('open', '');
};

const ME: Me = {
  id: 'u-admin', name: 'Admin Teste', email: 'admin@teste.local', role: 'admin', signature: null,
  sectorIds: [], seeAllSectors: true, avatarUrl: null,
};
const CHAT: ChatDetail = {
  id: 'c1', contact: { id: 'k1', name: 'Maria', phone: '5565999990000', avatarUrl: null }, channelId: 'ch1',
  sectorId: 's1', ownerId: null, state: 'open', waiting: true, private: false, unread: 0, lastMessageAt: null,
  lastMessagePreview: null, pinned: false, tagIds: [], triagePending: false, createdAt: '2026-10-15T12:00:00.000Z', closedAt: null,
};
const SECTORS: SectorDto[] = [
  { id: 's1', name: 'Atendimento', position: 0, isDefault: true },
  { id: 's2', name: 'Financeiro', position: 1, isDefault: false },
];
const BOT_RUNNING = {
  error: 'O chatbot está em execução nesta conversa',
  code: 'BOT_RUNNING',
  runs: [{ id: 'r1', botName: 'Fluxo do escritório' }],
};

type Call = { method: string; path: string; body: unknown };
const calls: Call[] = [];

/** The first transfer answers 409 BOT_RUNNING; the next one succeeds. */
function stubFetch() {
  calls.length = 0;
  let transfers = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init?.method ?? 'GET';
      calls.push({ method, path: url.pathname, body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body });
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (method === 'GET' && url.pathname === '/api/sectors') return json(200, SECTORS);
      if (method === 'GET' && url.pathname === '/api/users') return json(200, []);
      if (method === 'POST' && url.pathname === '/api/chats/c1/transfer') {
        return transfers++ === 0 ? json(409, BOT_RUNNING) : json(200, { ...CHAT, sectorId: 's2' });
      }
      return json(500, { error: 'inesperado' });
    }),
  );
}

const transfers = () => calls.filter((c) => c.method === 'POST' && c.path === '/api/chats/c1/transfer');

function renderHeader() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  qc.setQueryData(qk.me, ME);
  render(
    <QueryClientProvider client={qc}>
      <ConversationHeader chat={CHAT} contactPanelOpen={false} onToggleContactPanel={() => {}} onOpenChat={() => {}} />
    </QueryClientProvider>,
  );
  return qc;
}

/** Opens "Transferir conversa", picks Financeiro, confirms, and returns the BOT_RUNNING dialog. */
async function transferToFinanceiro(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: 'Transferir' }));
  const dialog = await screen.findByRole('dialog', { name: 'Transferir conversa' });
  await within(dialog).findByRole('option', { name: 'Financeiro' });
  fireEvent.change(within(dialog).getByLabelText('Setor'), { target: { value: 's2' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Transferir' }));
  return screen.findByRole('dialog', { name: 'O chatbot está rodando' });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ConversationHeader transfer with a running chatbot', () => {
  it('asks on 409 BOT_RUNNING and retries the same transfer with the chosen botAction', async () => {
    stubFetch();
    const qc = renderHeader();
    const ask = await transferToFinanceiro();
    expect(ask.textContent).toContain('Fluxo do escritório');
    expect(screen.queryByRole('dialog', { name: 'Transferir conversa' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull(); // not the "alterada por outra pessoa" conflict

    fireEvent.click(within(ask).getByRole('button', { name: 'Transferir e manter' }));
    await waitFor(() => expect(qc.getQueryData<ChatDetail>(qk.chat('c1'))?.sectorId).toBe('s2'));
    expect(transfers().map((c) => c.body)).toEqual([
      { sectorId: 's2', ownerId: null },
      { sectorId: 's2', ownerId: null, botAction: 'keep' },
    ]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('"Cancelar" leaves the chat where it is and shows no error', async () => {
    stubFetch();
    renderHeader();
    const ask = await transferToFinanceiro();
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(transfers()).toHaveLength(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w web -- src/components/conversation/Composer.test.tsx src/components/conversation/ConversationHeader.test.tsx`
Expected: FAIL. The three new Composer tests fail with `Unable to find role="dialog" and name "O chatbot está rodando"`, because the Composer shows the 409 message as an error instead. Both ConversationHeader tests fail with the same message, because the header treats the 409 as a stale-chat conflict. The existing Composer tests still pass.

- [ ] **Step 3: Implement**

In `web/src/components/conversation/ChatDialogs.tsx` (`Modal` and `Actions` are already exported by Task 13), replace the type import line

```tsx
import type { ChatDetail, SectorDto, UserDto } from '@talk/shared';
```

with

```tsx
import type { BotAction, BotRunningErrorBody, ChatDetail, SectorDto, UserDto } from '@talk/shared';
```

and append this to the end of the file:

```tsx
const BOT_RUNNING_LABELS = {
  send: { stop: 'Parar e enviar', keep: 'Enviar e manter' },
  transfer: { stop: 'Parar e transferir', keep: 'Transferir e manter' },
} as const;

/** 409 BOT_RUNNING (spec §5.5 "ask"). The caller retries with the chosen botAction; null = Cancelar. */
export function BotRunningDialog({
  runs,
  onChoose,
  action = 'send',
}: {
  runs: BotRunningErrorBody['runs'];
  onChoose: (a: BotAction | null) => void;
  action?: 'send' | 'transfer';
}) {
  const labels = BOT_RUNNING_LABELS[action];
  return (
    <Modal title="O chatbot está rodando" onCancel={() => onChoose(null)}>
      <p className="text-sm">
        Em execução nesta conversa: <strong>{runs.map((r) => r.botName).join(', ')}</strong>.
      </p>
      <p className="mt-2 text-sm text-muted">Parar o chatbot evita que ele continue respondendo o contato.</p>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <button type="button" onClick={() => onChoose(null)} className="rounded px-3 py-2 text-sm hover:bg-surface">
          Cancelar
        </button>
        <button
          type="button"
          onClick={() => onChoose('keep')}
          className="rounded border border-border px-3 py-2 text-sm hover:bg-surface"
        >
          {labels.keep}
        </button>
        <button
          type="button"
          onClick={() => onChoose('stop')}
          className="rounded bg-primary px-3 py-2 text-sm font-medium text-white hover:bg-primary-hover"
        >
          {labels.stop}
        </button>
      </div>
    </Modal>
  );
}
```

In `web/src/components/conversation/Composer.tsx`, replace the three import lines

```tsx
import type { MessageDto, QuickAnswerDto } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { applyWsEvent } from '../../lib/ws';
```

with

```tsx
import type { BotAction, BotRunningErrorBody, MessageDto, QuickAnswerDto } from '@talk/shared';
import { api, botRunningRuns, qk } from '../../lib/api';
import { applyWsEvent } from '../../lib/ws';
import { BotRunningDialog } from './ChatDialogs';
```

Replace

```tsx
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
```

with

```tsx
  const [error, setError] = useState<string | null>(null);
  // 409 BOT_RUNNING (spec §5.5 "ask"): submit() waits on this dialog, then resends with the choice
  const [botAsk, setBotAsk] = useState<{ runs: BotRunningErrorBody['runs']; resolve: (a: BotAction | null) => void } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
```

Replace the whole `submit` function

```tsx
  async function submit(call: () => Promise<MessageDto>): Promise<boolean> {
    setSending(true);
    setError(null);
    try {
      // same cache path as the WS echo, so the POST response and the event never duplicate
      applyWsEvent(qc, { type: 'message.created', message: await call() });
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setSending(false);
    }
  }
```

with

```tsx
  async function submit(call: (botAction?: BotAction) => Promise<MessageDto>): Promise<boolean> {
    setSending(true);
    setError(null);
    try {
      let message: MessageDto;
      try {
        message = await call();
      } catch (e) {
        const runs = botRunningRuns(e);
        if (!runs) throw e;
        const choice = await new Promise<BotAction | null>((resolve) => setBotAsk({ runs, resolve }));
        if (!choice) return false; // Cancelar: the caller puts the text back
        message = await call(choice);
      }
      // same cache path as the WS echo, so the POST response and the event never duplicate
      applyWsEvent(qc, { type: 'message.created', message });
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setSending(false);
    }
  }
```

In `send()`, replace

```tsx
    const ok = await submit(() =>
      isNote
        ? api.chats.addNote(chatId, value)
        : sentFile
          ? api.chats.sendFile(chatId, { file: sentFile, text: value || undefined, signature, replyToId })
          : api.chats.sendText(chatId, { text: value, signature, replyToId }),
    );
```

with

```tsx
    const ok = await submit((botAction) =>
      isNote
        ? api.chats.addNote(chatId, value) // notes never affect the bot (spec §5.5)
        : sentFile
          ? api.chats.sendFile(chatId, { file: sentFile, text: value || undefined, signature, replyToId, botAction })
          : api.chats.sendText(chatId, { text: value, signature, replyToId, botAction }),
    );
```

In `toggleRecording()`, replace

```tsx
    const ok = await submit(() =>
      api.chats.sendFile(chatId, { file: audio, signature: false, asVoice: true, replyToId: sentReply?.id }),
    );
```

with

```tsx
    const ok = await submit((botAction) =>
      api.chats.sendFile(chatId, { file: audio, signature: false, asVoice: true, replyToId: sentReply?.id, botAction }),
    );
```

At the end of the JSX, replace the closing of the recorder ternary and the root `div`

```tsx
        </>
      )}
    </div>
  );
}
```

with

```tsx
        </>
      )}

      {botAsk && (
        <BotRunningDialog
          runs={botAsk.runs}
          onChoose={(choice) => {
            botAsk.resolve(choice);
            setBotAsk(null);
          }}
        />
      )}
    </div>
  );
}
```

In `web/src/components/conversation/ConversationHeader.tsx`, replace the three import lines

```tsx
import type { ChatDetail } from '@talk/shared';
import { api, qk } from '../../lib/api';
```

and

```tsx
import { CloseDialog, TransferDialog } from './ChatDialogs';
```

with, respectively,

```tsx
import type { BotAction, BotRunningErrorBody, ChatDetail } from '@talk/shared';
import { api, botRunningRuns, qk } from '../../lib/api';
```

and

```tsx
import { BotRunningDialog, CloseDialog, TransferDialog } from './ChatDialogs';
```

Replace the `Action` type and `runAction`'s transfer case. Change

```tsx
  | { kind: 'transfer'; to: { sectorId: string; ownerId: string | null } }
```

to

```tsx
  | { kind: 'transfer'; to: { sectorId: string; ownerId: string | null }; botAction?: BotAction }
```

and change

```tsx
    case 'transfer':
      return api.chats.transfer(chatId, a.to);
```

to

```tsx
    case 'transfer':
      return api.chats.transfer(chatId, { ...a.to, botAction: a.botAction });
```

Replace

```tsx
  const [error, setError] = useState<string | null>(null);

  const open = chat.state === 'open';
```

with

```tsx
  const [error, setError] = useState<string | null>(null);
  const [botAsk, setBotAsk] = useState<{
    runs: BotRunningErrorBody['runs'];
    transfer: Extract<Action, { kind: 'transfer' }>;
  } | null>(null);

  const open = chat.state === 'open';
```

In `act`, replace

```tsx
    } catch (e) {
      if (isConflict(e)) {
```

with

```tsx
    } catch (e) {
      const runs = botRunningRuns(e);
      if (runs && a.kind === 'transfer') {
        // spec §5.5 "ask": confirm first, then the same transfer goes again with botAction
        setDialog(null);
        setBotAsk({ runs, transfer: a });
        return;
      }
      if (isConflict(e)) {
```

Replace the closing of the component

```tsx
      {dialog === 'close' && (
        <CloseDialog
          busy={busy}
          error={error}
          onCancel={closeDialog}
          onConfirm={(sendClosingMessage) => void act({ kind: 'close', sendClosingMessage })}
        />
      )}
    </>
  );
}
```

with

```tsx
      {dialog === 'close' && (
        <CloseDialog
          busy={busy}
          error={error}
          onCancel={closeDialog}
          onConfirm={(sendClosingMessage) => void act({ kind: 'close', sendClosingMessage })}
        />
      )}
      {botAsk && (
        <BotRunningDialog
          runs={botAsk.runs}
          action="transfer"
          onChoose={(botAction) => {
            const retry = botAsk.transfer;
            setBotAsk(null);
            if (botAction) void act({ ...retry, botAction });
          }}
        />
      )}
    </>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w web -- src/components/conversation/Composer.test.tsx src/components/conversation/ConversationHeader.test.tsx`
Expected: PASS (12 Composer tests and 2 ConversationHeader tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/components/conversation/ChatDialogs.tsx web/src/components/conversation/Composer.tsx web/src/components/conversation/Composer.test.tsx web/src/components/conversation/ConversationHeader.tsx web/src/components/conversation/ConversationHeader.test.tsx
git commit -m "feat(web): ask before sending or transferring while a chatbot runs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

#### Cycle 3: the composer robot button and the "Executar chatbot" panel

- [ ] **Step 1: Write the failing tests**

Create `web/src/components/conversation/BotPanel.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { BotRunDto, ChatListItem, ManualBotDto } from '@talk/shared';
import { connectWs } from '../../lib/ws';
import { BotPanel } from './BotPanel';

type Call = { method: string; path: string; body: unknown };
const calls: Call[] = [];

function stubFetch(routes: Record<string, unknown>) {
  calls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init?.method ?? 'GET';
      calls.push({ method, path: url.pathname, body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body });
      const key = `${method} ${url.pathname}`;
      if (!(key in routes)) return new Response(JSON.stringify({ error: 'inesperado' }), { status: 500 });
      return new Response(JSON.stringify(routes[key]), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
}

class FakeWs {
  static instances: FakeWs[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) {
    FakeWs.instances.push(this);
  }
  close() {}
}

const run = (over: Partial<BotRunDto> = {}): BotRunDto => ({
  id: 'r1', botId: 'b1', botName: 'Fluxo do escritório', chatId: 'c1', state: 'waiting_reply', currentNodeId: 'menu',
  depth: 0, startedByName: null, error: null, createdAt: '2026-10-15T12:00:00.000Z', updatedAt: '2026-10-15T12:00:00.000Z',
  finishedAt: null, ...over,
});

const chatItem = (id: string): ChatListItem => ({
  id, contact: { id: 'k1', name: 'Maria', phone: '5565999990000', avatarUrl: null }, channelId: 'ch1', sectorId: 's1',
  ownerId: null, state: 'open', waiting: false, private: false, unread: 0, lastMessageAt: null, lastMessagePreview: null,
  pinned: false, tagIds: [],
});

const MANUAL: ManualBotDto[] = [
  { id: 'b1', title: 'Fluxo do escritório' },
  { id: 'b2', title: 'Pesquisa de satisfação' },
];

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <BotPanel chatId="c1" onClose={onClose} />
    </QueryClientProvider>,
  );
  return { qc, onClose };
}

const byPath = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  FakeWs.instances = [];
});

describe('BotPanel', () => {
  it('lists the manual chatbots under "Executar chatbot" and starts the chosen one', async () => {
    stubFetch({
      'GET /api/bots/manual': MANUAL,
      'GET /api/chats/c1/bot-runs': [],
      'POST /api/chats/c1/bot-runs': run({ botId: 'b2', botName: 'Pesquisa de satisfação' }),
    });
    const { onClose } = renderPanel();
    expect(screen.getByText('Executar chatbot')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Pesquisa de satisfação' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(byPath('POST', '/api/chats/c1/bot-runs').map((c) => c.body)).toEqual([{ botId: 'b2' }]);
    expect(byPath('GET', '/api/chats/c1/bot-runs')).toHaveLength(2); // refetched before closing
    expect(screen.queryByRole('button', { name: 'Parar chatbot' })).toBeNull();
  });

  it('shows the running chatbot with "Parar chatbot", disables starting it again, and stops it', async () => {
    stubFetch({
      'GET /api/bots/manual': MANUAL,
      'GET /api/chats/c1/bot-runs': [run()],
      'POST /api/bot-runs/r1/stop': run({ state: 'stopped' }),
    });
    const { onClose } = renderPanel();
    const stop = await screen.findByRole('button', { name: 'Parar chatbot' });
    const again = (await screen.findByRole('button', { name: 'Fluxo do escritório' })) as HTMLButtonElement;
    expect(again.disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Pesquisa de satisfação' }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(stop);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(byPath('POST', '/api/bot-runs/r1/stop')).toHaveLength(1);
  });

  it('says so when no chatbot can be started manually', async () => {
    stubFetch({ 'GET /api/bots/manual': [], 'GET /api/chats/c1/bot-runs': [] });
    renderPanel();
    expect(await screen.findByText('Nenhum chatbot disponível para início manual.')).toBeTruthy();
  });

  it('shows the server error and stays open when the start fails', async () => {
    stubFetch({ 'GET /api/bots/manual': MANUAL, 'GET /api/chats/c1/bot-runs': [] }); // POST answers 500 'inesperado'
    const { onClose } = renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Pesquisa de satisfação' }));
    expect((await screen.findByRole('alert')).textContent).toBe('inesperado');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('reloads the running list when this chat (and only this chat) is updated over the WebSocket', async () => {
    stubFetch({ 'GET /api/bots/manual': MANUAL, 'GET /api/chats/c1/bot-runs': [] });
    vi.stubGlobal('WebSocket', FakeWs);
    const { qc } = renderPanel();
    const stopWs = connectWs(qc, 'ws://test/ws');
    await waitFor(() => expect(byPath('GET', '/api/chats/c1/bot-runs')).toHaveLength(1));

    await act(async () => {
      FakeWs.instances[0]!.onmessage!({ data: JSON.stringify({ type: 'chat.updated', chat: chatItem('c2') }) });
    });
    expect(byPath('GET', '/api/chats/c1/bot-runs')).toHaveLength(1);

    await act(async () => {
      FakeWs.instances[0]!.onmessage!({ data: JSON.stringify({ type: 'chat.updated', chat: chatItem('c1') }) });
    });
    await waitFor(() => expect(byPath('GET', '/api/chats/c1/bot-runs')).toHaveLength(2));
    stopWs();
  });
});
```

Append this test inside the `describe('Composer with a running chatbot', …)` block in `web/src/components/conversation/Composer.test.tsx`, after the `"Cancelar"` test:

```tsx
  it('the robot button toggles the "Executar chatbot" panel', async () => {
    stubFetch({ 'GET /api/bots/manual': [{ id: 'b1', title: 'Fluxo do escritório' }], 'GET /api/chats/c1/bot-runs': [] });
    renderComposer();
    expect(screen.queryByText('Executar chatbot')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Chatbot' }));
    expect(await screen.findByRole('button', { name: 'Fluxo do escritório' })).toBeTruthy();
    expect(screen.getByText('Executar chatbot')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Chatbot' }));
    expect(screen.queryByText('Executar chatbot')).toBeNull();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w web -- src/components/conversation/BotPanel.test.tsx src/components/conversation/Composer.test.tsx`
Expected: FAIL. `BotPanel.test.tsx` fails with `Failed to resolve import "./BotPanel"`. The new Composer test fails with `Unable to find an accessible element with the role "button" and name "Chatbot"`.

- [ ] **Step 3: Implement**

Create `web/src/components/conversation/BotPanel.tsx`:

```tsx
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Robot } from '@phosphor-icons/react';
import { api, qk } from '../../lib/api';
import { useWsEvent } from '../../lib/ws';
import { ErrorText, useSend } from '../settings/common';

export interface BotPanelProps {
  chatId: string;
  onClose: () => void;
}

/** Composer popover (spec §7): "Executar chatbot" lists the manual bots; each running run gets "Parar chatbot". */
export function BotPanel({ chatId, onClose }: BotPanelProps) {
  const qc = useQueryClient();
  const runs = useQuery({ queryKey: qk.chatBotRuns(chatId), queryFn: () => api.botRuns.listForChat(chatId) });
  const manual = useQuery({ queryKey: qk.botManual, queryFn: () => api.bots.manual() });
  const act = useSend(qk.chatBotRuns(chatId));

  // the engine publishes the chat on every start, wait, end and stop, including ones made by someone else
  useWsEvent((ev) => {
    if (ev.type === 'chat.updated' && ev.chat.id === chatId) {
      void qc.invalidateQueries({ queryKey: qk.chatBotRuns(chatId), exact: true });
    }
  });

  const running = runs.data ?? [];
  const runningBotIds = new Set(running.map((r) => r.botId));
  const bots = manual.data ?? [];

  return (
    <div className="absolute bottom-full left-0 z-10 mb-1 w-72 rounded-md border border-border bg-panel p-2 text-sm text-fg shadow-lg">
      {running.length > 0 && (
        <ul aria-label="Chatbots em execução" className="mb-2 border-b border-border pb-2">
          {running.map((r) => (
            <li key={r.id} className="flex items-center gap-2 px-1 py-1">
              <Robot size={16} weight="fill" aria-hidden className="shrink-0 text-primary" />
              <span className="min-w-0 flex-1 truncate">{r.botName}</span>
              <button
                type="button"
                disabled={act.isPending}
                onClick={() => act.mutate(() => api.botRuns.stop(r.id), { onSuccess: onClose })}
                className="rounded px-2 py-1 text-xs font-medium text-danger hover:bg-surface disabled:opacity-50"
              >
                Parar chatbot
              </button>
            </li>
          ))}
        </ul>
      )}
      <h4 className="px-1 pb-1 text-xs font-semibold text-muted uppercase">Executar chatbot</h4>
      {manual.isPending ? (
        <p className="px-1 py-1 text-muted">Carregando…</p>
      ) : bots.length === 0 ? (
        <p className="px-1 py-1 text-muted">Nenhum chatbot disponível para início manual.</p>
      ) : (
        <ul className="max-h-60 overflow-y-auto">
          {bots.map((b) => {
            const alreadyRunning = runningBotIds.has(b.id);
            return (
              <li key={b.id}>
                <button
                  type="button"
                  disabled={act.isPending || alreadyRunning}
                  title={alreadyRunning ? 'Já em execução nesta conversa' : undefined}
                  onClick={() => act.mutate(() => api.botRuns.start(chatId, b.id), { onSuccess: onClose })}
                  className="w-full truncate rounded px-2 py-1.5 text-left hover:bg-surface disabled:opacity-50"
                >
                  {b.title}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <ErrorText error={act.error ?? manual.error ?? runs.error} />
    </div>
  );
}
```

In `web/src/components/conversation/Composer.tsx`, replace

```tsx
import { ArrowBendUpLeft, Lightning, Microphone, Paperclip, PaperPlaneRight, Smiley, Trash, X } from '@phosphor-icons/react';
```

with

```tsx
import { ArrowBendUpLeft, Lightning, Microphone, Paperclip, PaperPlaneRight, Robot, Smiley, Trash, X } from '@phosphor-icons/react';
```

and replace

```tsx
import { BotRunningDialog } from './ChatDialogs';
```

with

```tsx
import { BotPanel } from './BotPanel';
import { BotRunningDialog } from './ChatDialogs';
```

Replace

```tsx
  const [emojiOpen, setEmojiOpen] = useState(false);
```

with

```tsx
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [botOpen, setBotOpen] = useState(false);
```

In the tool row, insert the robot button between the emoji block and the signature label. Replace

```tsx
                  ))}
                </div>
              )}
            </div>
            {!isNote && (
              <label className="ml-2 flex items-center gap-1 text-xs text-muted">
```

with

```tsx
                  ))}
                </div>
              )}
            </div>
            <div className="relative">
              <ToolButton label="Chatbot" onClick={() => setBotOpen((o) => !o)}>
                <Robot size={20} />
              </ToolButton>
              {botOpen && <BotPanel chatId={chatId} onClose={() => setBotOpen(false)} />}
            </div>
            {!isNote && (
              <label className="ml-2 flex items-center gap-1 text-xs text-muted">
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w web -- src/components/conversation/BotPanel.test.tsx src/components/conversation/Composer.test.tsx`
Expected: PASS (5 BotPanel tests and 13 Composer tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/components/conversation/BotPanel.tsx web/src/components/conversation/BotPanel.test.tsx web/src/components/conversation/Composer.tsx web/src/components/conversation/Composer.test.tsx
git commit -m "feat(web): composer chatbot panel to start and stop runs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

#### Cycle 4: notify_agent toasts and browser notifications

- [ ] **Step 1: Write the failing test**

Create `web/src/components/layout/NotificationToasts.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { NotificationDto } from '@talk/shared';
import { connectWs } from '../../lib/ws';
import { NotificationToasts, TOAST_MS } from './NotificationToasts';

class FakeWs {
  static instances: FakeWs[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) {
    FakeWs.instances.push(this);
  }
  close() {}
}

class FakeNotification {
  static permission: NotificationPermission = 'default';
  static instances: FakeNotification[] = [];
  onclick: (() => void) | null = null;
  closed = false;
  constructor(public title: string, public options?: NotificationOptions) {
    FakeNotification.instances.push(this);
  }
  close() {
    this.closed = true;
  }
}

const NOTE: NotificationDto = {
  id: 'n1', chatId: 'c1', title: 'Nova conversa', text: 'Nova conversa de Maria — CPF 123.456.789-09',
  botName: 'Fluxo do escritório', createdAt: '2026-10-15T12:00:00.000Z',
};

let stopWs: () => void = () => {};

function setup(permission: NotificationPermission) {
  vi.useFakeTimers();
  FakeNotification.permission = permission;
  FakeNotification.instances = [];
  vi.stubGlobal('WebSocket', FakeWs);
  vi.stubGlobal('Notification', FakeNotification);
  vi.spyOn(window, 'focus').mockImplementation(() => {}); // jsdom: window.focus is "not implemented"
  stopWs = connectWs(new QueryClient(), 'ws://test/ws');
  render(
    <MemoryRouter initialEntries={['/chats']}>
      <NotificationToasts />
      <Routes>
        <Route path="/chats" element={<p>Lista</p>} />
        <Route path="/chats/:id" element={<p>Conversa aberta</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

function emit(ev: unknown) {
  act(() => {
    FakeWs.instances[0]!.onmessage!({ data: JSON.stringify(ev) });
  });
}

afterEach(() => {
  cleanup();
  stopWs();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  FakeWs.instances = [];
});

describe('NotificationToasts', () => {
  it('shows the title, text and bot name for 8 seconds, without a browser notification when not allowed', () => {
    setup('default');
    emit({ type: 'notification', notification: NOTE });
    expect(screen.getByText('Nova conversa')).toBeTruthy();
    expect(screen.getByText(NOTE.text)).toBeTruthy();
    expect(screen.getByText('Chatbot Fluxo do escritório')).toBeTruthy();
    expect(FakeNotification.instances).toHaveLength(0);

    act(() => {
      vi.advanceTimersByTime(TOAST_MS - 1);
    });
    expect(screen.queryByText('Nova conversa')).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByText('Nova conversa')).toBeNull();
  });

  it('ignores other WebSocket events', () => {
    setup('granted');
    emit({ type: 'chat.removed', chatId: 'c9' });
    expect(screen.queryByRole('link')).toBeNull();
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it('clicking the toast opens the chat and closes the toast', () => {
    setup('default');
    emit({ type: 'notification', notification: NOTE });
    fireEvent.click(screen.getByRole('link', { name: /Nova conversa/ }));
    expect(screen.getByText('Conversa aberta')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('also raises a browser notification when allowed; clicking it opens the chat', () => {
    setup('granted');
    emit({ type: 'notification', notification: NOTE });
    expect(FakeNotification.instances).toHaveLength(1);
    const n = FakeNotification.instances[0]!;
    expect(n.title).toBe('Nova conversa');
    expect(n.options?.body).toBe(NOTE.text);

    act(() => {
      n.onclick!();
    });
    expect(screen.getByText('Conversa aberta')).toBeTruthy();
    expect(n.closed).toBe(true);
  });

  it('falls back to a generic title when the block has none', () => {
    setup('granted');
    emit({ type: 'notification', notification: { ...NOTE, id: 'n2', title: '' } });
    expect(screen.getByText('Notificação do chatbot')).toBeTruthy();
    expect(FakeNotification.instances[0]!.title).toBe('Notificação do chatbot');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w web -- src/components/layout/NotificationToasts.test.tsx`
Expected: FAIL with `Failed to resolve import "./NotificationToasts"`.

- [ ] **Step 3: Implement**

Create `web/src/components/layout/NotificationToasts.tsx`:

```tsx
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { BellRingingIcon } from '@phosphor-icons/react';
import type { NotificationDto } from '@talk/shared';
import { useWsEvent } from '../../lib/ws';

export const TOAST_MS = 8000;

const titleOf = (n: NotificationDto) => n.title.trim() || 'Notificação do chatbot';

/** notify_agent (spec §4): an 8 s toast plus a browser notification when allowed. Mount once in AppLayout. */
export function NotificationToasts() {
  const navigate = useNavigate();
  const [items, setItems] = useState<NotificationDto[]>([]);
  const dismiss = (id: string) => setItems((cur) => cur.filter((n) => n.id !== id));

  useWsEvent((ev) => {
    if (ev.type !== 'notification') return;
    const n = ev.notification;
    setItems((cur) => [...cur, n]);
    // ponytail: one timer per toast, not cleared on unmount (a setState after unmount is a no-op)
    setTimeout(() => dismiss(n.id), TOAST_MS);
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const browser = new Notification(titleOf(n), { body: n.text, tag: n.id });
    browser.onclick = () => {
      window.focus();
      navigate(`/chats/${n.chatId}`);
      browser.close();
    };
  });

  return (
    <div aria-live="polite" className="fixed right-4 bottom-4 z-50 flex w-80 max-w-[calc(100%-2rem)] flex-col gap-2">
      {items.map((n) => (
        <Link
          key={n.id}
          to={`/chats/${n.chatId}`}
          onClick={() => dismiss(n.id)}
          className="block rounded-lg border border-border bg-panel p-3 text-fg shadow-xl hover:bg-sidebar-hover"
        >
          <p className="flex items-center gap-1.5 text-sm font-semibold">
            <BellRingingIcon size={16} weight="fill" aria-hidden className="shrink-0 text-primary" />
            {titleOf(n)}
          </p>
          {n.text && <p className="mt-1 text-sm break-words whitespace-pre-wrap">{n.text}</p>}
          <p className="mt-1 text-xs text-muted">Chatbot {n.botName}</p>
        </Link>
      ))}
    </div>
  );
}
```

In `web/src/components/layout/AppLayout.tsx`, replace

```tsx
import { NotificationPermissionButton, useMessageNotifications } from '../../lib/notify';
```

with

```tsx
import { NotificationPermissionButton, useMessageNotifications } from '../../lib/notify';
import { NotificationToasts } from './NotificationToasts';
```

and replace

```tsx
        <main className="min-h-0 flex-1">
          <Outlet />
        </main>
      </div>
    </div>
```

with

```tsx
        <main className="min-h-0 flex-1">
          <Outlet />
        </main>
      </div>
      <NotificationToasts />
    </div>
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w web -- src/components/layout/NotificationToasts.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the whole web suite and the type check**

Run: `npm test -w web`
Expected: PASS, with no failures in any web test file.

Run: `npm run typecheck -w web`
Expected: exit code 0, with no errors.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/layout/NotificationToasts.tsx web/src/components/layout/NotificationToasts.test.tsx web/src/components/layout/AppLayout.tsx
git commit -m "feat(web): chatbot notification toasts and browser notifications

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


---

### Task 17: Docs and manual acceptance checklist

Docs only, no code. This task adds three things. First, a chatbot section in `README.md`. Second, the chatbot items in the go-live checklist of `docs/IMPLANTACAO.md`: create the office template, map the sectors, review it and activate it. Third, a step-by-step manual acceptance script for spec §1 criterion 1, run in the local environment with the test number. All doc text is pt-BR, like the rest of `docs/`.

The checklist quotes on-screen labels and bot texts that Tasks 12–16 produce. Step 6 checks each quoted string against the code. When a string is missing, fix the doc wording to match the screen. Never change code in this task.

**Files:**
- Create: `docs/superpowers/plans/2026-10-15-chatbot-fluxos-2a-aceite.md`
- Modify: `README.md` (line 29 "Fica para os próximos módulos…", the "Telas" row of the stack table, the repository tree, the "Documentação do projeto" list)
- Modify: `docs/IMPLANTACAO.md` (§6.1 before "**Voltar a versão**", §10 "Antes do dia", "Teste manual", "Virada")

**Interfaces:**
- Consumes. The doc quotes these exactly:
  - UI labels:
    - "Chatbots" (settings section, Task 13)
    - "Criar a partir do modelo" (Task 13)
    - "Quando o atendente enviar mensagem com chatbot em execução", with options `Perguntar` / `Parar o bot` / `Manter rodando` (Task 13)
    - "Salvar e publicar", "Versões" and restore as a draft (Task 14)
    - "O chatbot está rodando" / "Parar e enviar" / "Enviar e manter" / "Cancelar" (Task 16)
    - "Executar chatbot" / "Parar chatbot" (Task 16)
    - "Ver todos os setores" (existing)
    - "Finalizar" (existing)
  - Timeline texts (Task 1 `eventText`): `Chatbot ${n} iniciado`, `Chatbot ${n} finalizado`, `Chatbot ${n} parado por <nome>`, and `Chatbot ${n} transferiu para <setor>` plus ` · <atendente>`.
  - Bubble label `Chatbot <nome>` with the robot icon (Task 16). Notification toast title `Nova conversa` (Task 12 template, Task 16 toast).
  - Template texts and behavior (spec §8, contract §3.10 Template):
    - default name `Fluxo do escritório`, created published and **paused**;
    - CPF custom field reused or created;
    - menu keys `1`/`2`/`3`, invalid repeated once, timeout 24 h;
    - CPF `invalidRetries: 2`, and both `next` and `invalid` go to the destination;
    - `hours` is `America/Cuiaba`, Mon–Fri 08:00–12:00 and 14:00–18:00.
  - `ask_choice` fallback invalid text `'Opção inválida.'` (contract §3.8). It matches by key or by normalized label.
  - Engine: a run in `waiting_reply` survives a restart. A run left in `running` becomes `failed` with `'Interrompido por reinício do servidor'` (Task 9).
  - Automated end-to-end test file `server/test/bots/template.test.ts` (Task 12).
- Produces: nothing that code depends on. The acceptance file path `docs/superpowers/plans/2026-10-15-chatbot-fluxos-2a-aceite.md` is linked from README and IMPLANTACAO.

- [ ] **Step 1: Run the doc check and confirm it fails**

Run (bash, from repo root):
```bash
grep -c -e 'Criar a partir do modelo' -e '529.982.247-25' -e 'Parar chatbot' -e 'fora do horário' docs/superpowers/plans/2026-10-15-chatbot-fluxos-2a-aceite.md
grep -c -e 'Criar a partir do modelo' -e 'Ativar' -e 'aceite' docs/IMPLANTACAO.md
grep -c -e 'Chatbot (entrega 2a)' -e 'src/bots/' -e 'chatbot-fluxos-2a' README.md
```
Expected: FAIL. The first command prints `No such file or directory`, and the other two print `0`.

- [ ] **Step 2: Create the acceptance script**

Create `docs/superpowers/plans/2026-10-15-chatbot-fluxos-2a-aceite.md` with exactly:

````markdown
# Aceite manual: chatbot "Fluxo do escritório" (entrega 2a)

Roteiro do critério 1 do §1 da [especificação](../specs/2026-10-15-chatbot-fluxos-2a-design.md). O modelo "Fluxo do escritório" precisa rodar de ponta a ponta no ambiente local, com o número de teste. O cliente passa por horário e dia, boas-vindas, menu e comunicado. Depois informa o CPF, que é validado e salvo no campo. A conversa então cai no setor certo e o atendente é notificado.

> ⚠️ Use só o **número de teste**. Se você ler o QR com o número do escritório, ele sai do Umbler Talk na hora.
> Para o CPF, use o número de teste `529.982.247-25`. Ele é válido no dígito verificador, mas não é de ninguém. Nunca use o CPF de um cliente.

## 0. Antes de começar

- [ ] Testes automáticos passando, incluindo o de ponta a ponta do modelo:

```bash
npm test
npm test -w server -- test/bots/template.test.ts
```

- [ ] O ambiente local está rodando, conforme o README ("Rodar localmente"): `npm run dev:up`, `npm run dev` e o administrador criado.
- [ ] Em Configurações › Canais, o canal do **número de teste** aparece como **Conectado**.
- [ ] Os setores **Atendimento**, **Financeiro** e **Processos** estão criados.
- [ ] Existe um usuário atendente, aqui chamado de "Atendente Teste", que participa dos três setores.
- [ ] O admin enxerga todas as conversas, porque entrou nos três setores ou ligou **Ver todos os setores** na caixa de entrada.
- [ ] Configurações › Conversas: "Quando o atendente enviar mensagem com chatbot em execução" está em **Perguntar**.
- [ ] O celular do "cliente" (outro número) tem um nome no perfil do WhatsApp e **não** tem conversa aberta no sistema. Se tiver, finalize a conversa.
- [ ] Duas janelas do navegador estão abertas:
  - uma normal, com o admin;
  - uma anônima (`Ctrl+Shift+N`), com o Atendente Teste, para ver o aviso.
- [ ] A hora está dentro do horário do modelo: **seg–sex, 08:00–12:00 ou 14:00–18:00 no horário de Cuiabá** (em Brasília, 09:00–13:00 ou 15:00–19:00).
- [ ] Anote a versão testada: `git log -1 --format=%h` → `________`

Regra entre as partes: no fim de cada parte, **finalize** a conversa (sem mensagem de encerramento). Assim a próxima mensagem do cliente abre uma conversa nova e o chatbot começa de novo.

## A. Criar e ativar o modelo

1. [ ] Admin: Configurações › **Chatbots** › **Criar a partir do modelo**.
2. [ ] Preencha:
   - **Nome do escritório:** `Escritório Teste`;
   - **Canal:** o canal de teste;
   - **Destinos:** Atendimento → setor Atendimento e Atendente Teste; Financeiro → setor Financeiro e Atendente Teste; Processos → setor Processos e Atendente Teste.

   Depois clique em criar.
3. [ ] Esperado:
   - a lista mostra **Fluxo do escritório**, pausado, com o canal de teste;
   - em Configurações › Campos personalizados existe **um** campo **CPF**, sem duplicar se ele já existia.
4. [ ] Abra o fluxo no editor. Esperado:
   - os blocos estão ligados, de **Iniciar por um canal** → **Horário** até os blocos de transferência e aviso;
   - nenhum bloco aparece em vermelho;
   - em **Versões**, a versão 1 está publicada.

   Saia sem mexer em nada.
5. [ ] Na lista, clique em **Ativar**. Esperado: o fluxo aparece como ativo.

## B. Dentro do horário: opção pelo número, CPF errado e depois certo

1. [ ] O cliente envia `Oi`.
2. [ ] O cliente recebe, nesta ordem, e **não** recebe o menu da triagem simples:
   - `Olá <primeiro nome>! 👋 Sou o assistente virtual da Escritório Teste. Como posso te ajudar hoje?`
   - `Escolha uma das opções abaixo digitando o número correspondente:`, seguido das linhas `1: Atendimento`, `2: Financeiro` e `3: Processos`.
3. [ ] No sistema, na conversa nova:
   - as duas mensagens aparecem com o ícone de robô e **Chatbot Fluxo do escritório**;
   - a linha do tempo mostra `Chatbot Fluxo do escritório iniciado`.
4. [ ] O cliente envia `2`. Ele recebe o comunicado (`⚠️ COMUNICADO — Informamos que nosso WhatsApp está com uma demanda muito alta…`) e depois `Para agilizar, digite seu CPF:`.
5. [ ] O cliente envia `123`. Ele recebe `CPF inválido, confira e digite de novo.`
6. [ ] Na janela do Atendente Teste, deixe a caixa de entrada aberta. O cliente envia `529.982.247-25`. Esperado: o cliente não recebe mais nada.
7. [ ] No sistema, esperado:
   - a conversa está no setor **Financeiro**, com o atendente **Atendente Teste**;
   - a linha do tempo mostra `Chatbot Fluxo do escritório transferiu para Financeiro`, depois a mesma frase com ` · Atendente Teste`, e por fim `Chatbot Fluxo do escritório finalizado`;
   - a ficha do contato mostra **CPF** = `529.982.247-25`.
8. [ ] Na janela do Atendente Teste aparece o aviso **Nova conversa**, com `Nova conversa de <nome do cliente> — CPF 529.982.247-25`. Clicar no aviso abre a conversa.
9. [ ] Finalize a conversa.

## C. Fora do horário, e voltar a versão

1. [ ] No editor, no bloco **Horário**, troque o intervalo por um que não inclua a hora atual, por exemplo 03:00–04:00, e clique em **Salvar e publicar**. Esperado: em **Versões**, a versão 2 está publicada.
2. [ ] O cliente envia `Oi`. Ele recebe só `Estamos fora do horário de atendimento. Deixe sua mensagem que retornaremos assim que possível.`, sem boas-vindas e sem menu.
3. [ ] No sistema, esperado:
   - a conversa continua **aberta** na Entrada, no setor padrão e sem atendente, ou seja, **não** foi finalizada;
   - a linha do tempo mostra `… iniciado` e `… finalizado`.
4. [ ] No editor, abra **Versões**, escolha a versão 1, restaure-a como novo rascunho e clique em **Salvar e publicar**. Esperado:
   - a versão 3 está publicada;
   - o bloco **Horário** voltou a seg–sex, 08:00–12:00 e 14:00–18:00.
5. [ ] Finalize a conversa.

## D. Opção pelo nome, atendente escreve com o bot rodando, reinício do servidor

1. [ ] O cliente envia `Oi` e recebe as boas-vindas e o menu.
2. [ ] O admin digita `Teste do atendente` na conversa e envia. Esperado: abre o diálogo **O chatbot está rodando**. Clique em **Cancelar**. Esperado: nada é enviado.
3. [ ] O admin envia de novo e escolhe **Enviar e manter**. Esperado: o cliente recebe a mensagem do admin, com assinatura, e o chatbot continua esperando a escolha.
4. [ ] O cliente envia `processos`, em minúsculas e escrito por extenso. Ele recebe o comunicado e o pedido de CPF.
5. [ ] Reinicie o servidor: `Ctrl+C` no terminal do `npm run dev` e depois `npm run dev` de novo. Espere a API subir. Recarregue as duas janelas do navegador.
6. [ ] O cliente envia `52998224725`, só os dígitos. Esperado:
   - a conversa está em **Processos**, com o Atendente Teste;
   - o aviso mostra `CPF 529.982.247-25`, já formatado;
   - a linha do tempo termina em `… finalizado`.
7. [ ] No terminal do `npm run dev`, procure `529.982.247-25`, `52998224725` e `Teste do atendente`. **Nenhum** deles pode aparecer, porque o log mostra só nomes, ids e códigos de erro.
8. [ ] Finalize a conversa.

## E. Opção inválida e CPF inválido três vezes

1. [ ] O cliente envia `Oi` e recebe as boas-vindas e o menu.
2. [ ] O cliente envia `9`. Ele recebe o aviso de opção inválida (o padrão é `Opção inválida.`) e o menu de novo.
3. [ ] O cliente envia `1`. Ele recebe o comunicado e o pedido de CPF.
4. [ ] O cliente envia `abc` três vezes. Ele recebe `CPF inválido, confira e digite de novo.` depois da 1ª e da 2ª vez. Depois da 3ª, não recebe nada.
5. [ ] Esperado:
   - o fluxo segue mesmo assim: a conversa vai para **Atendimento**, com o Atendente Teste;
   - o aviso diz `Nova conversa de <nome> — CPF `, com o CPF vazio, porque nenhum CPF válido foi digitado nesta conversa;
   - a ficha do contato continua com o CPF da parte B.
6. [ ] Finalize a conversa.

## F. Parar o chatbot pela conversa

1. [ ] O cliente envia `Oi` e recebe as boas-vindas e o menu.
2. [ ] Na conversa, o admin clica no botão de robô do compositor e depois em **Parar chatbot**. Esperado: a linha do tempo mostra `Chatbot Fluxo do escritório parado por <nome do admin>`.
3. [ ] O cliente envia `2`. Esperado: o chatbot não responde e a conversa continua na Entrada para os atendentes.
4. [ ] Finalize a conversa.

## Resultado

| Data | Quem testou | Versão (`git log -1 --format=%h`) | A | B | C | D | E | F | Observações |
|---|---|---|---|---|---|---|---|---|---|
| | | | | | | | | | |

O critério 1 só está cumprido com **todas** as partes marcadas. Se alguma falhar, anote o passo e o que apareceu. Não anote textos de clientes nem CPFs reais.
````

- [ ] **Step 3: Update `README.md`**

Make four exact replacements.

(a) Replace the line
```markdown
Fica para os próximos módulos (sub-projetos 2 e 3): editor visual de chatbot, horários, agendamentos, relatórios, logs de atividade, webhooks e permissões finas.
```
with
```markdown
## Chatbot (entrega 2a)

- **Editor visual de fluxos** em Configurações › Chatbots:
  - blocos ligados por setas (React Flow) e paleta por categoria com busca (atalho `Tab`);
  - auto-organizar e desfazer/refazer;
  - salvar rascunho e **Salvar e publicar** (só publica um fluxo sem problemas);
  - versões com restauração, e importar ou exportar em JSON.
- **Blocos:**
  - início por um canal ou manual;
  - condições: dia da semana, horário, aguardar intervalo, regras com E/OU, várias condições, comparar valor, distribuir por peso, contato ativo, primeira conversa, campo e etiquetas do contato, setor, canal, atendente e situação da conversa, mensagem contém e outro chatbot rodando;
  - ações: enviar mensagem e arquivo, nota interna, pedir para escolher, pedir informação (com validação de CPF, CNPJ, e-mail, telefone, mídia ou expressão própria), preencher campo, editar etiquetas, transferir para setor ou atendente, privacidade, notificar atendente, acionar outro fluxo e bloquear contato;
  - finalizar conversa;
  - anotação.
- **Motor gravado no banco:** cada passo fica salvo no Postgres. As esperas (resposta do contato, intervalo de tempo, "sem resposta em X horas") voltam sozinhas por um relógio interno, mesmo depois de reiniciar o servidor.
- **Modelo "Fluxo do escritório":** recria o fluxo usado hoje no Umbler com **Criar a partir do modelo**. Ele passa por horário, boas-vindas, menu, comunicado e CPF validado e salvo no campo, e termina no setor certo com o atendente notificado.
- **Na conversa:**
  - as mensagens do bot aparecem com o ícone de robô e "Chatbot <nome>", e os eventos do bot entram na linha do tempo;
  - o botão de robô no compositor executa ou para um chatbot;
  - em Configurações › Conversas você escolhe o que fazer quando o atendente escreve com o bot rodando: Perguntar, Parar o bot ou Manter rodando.
- Com um chatbot ativo que inicia pelo canal, a triagem simples não roda nesse canal.

Fica para os próximos módulos:
- chatbot 2b (avaliação, etiquetas da conversa, fluxo de espera, presença do atendente e outros blocos);
- chatbot 2c (Webhook, Pipedrive, Asaas);
- horários, agendamentos, relatórios, logs de atividade, webhooks e permissões finas.
```

(b) Replace the line
```markdown
| Telas | React 19, Vite 8, Tailwind 4, TanStack Query 5, React Router 8, Phosphor Icons |
```
with
```markdown
| Telas | React 19, Vite 8, Tailwind 4, TanStack Query 5, React Router 8, Phosphor Icons, React Flow 12 (`@xyflow/react`), dagre |
```

(c) Replace the two lines
```text
  src/messages/   entrada, envio, mídia, respostas rápidas
  src/importer/   importação única do Umbler Talk
```
with
```text
  src/messages/   entrada, envio, mídia, respostas rápidas
  src/bots/       chatbot: motor, blocos, relógio, validação dos fluxos, modelo do escritório
  src/importer/   importação única do Umbler Talk
```
and replace the line
```text
web/           telas (caixa de entrada, conversa, contatos, configurações)
```
with
```text
web/           telas (caixa de entrada, conversa, contatos, configurações, editor de chatbot)
```

(d) Replace the line
```markdown
- [Especificação do núcleo](docs/superpowers/specs/2026-10-14-nucleo-atendimento-design.md): o que o sistema faz, regras e segurança.
```
with
```markdown
- [Especificação do núcleo](docs/superpowers/specs/2026-10-14-nucleo-atendimento-design.md): o que o sistema faz, regras e segurança.
- [Especificação do chatbot, entrega 2a](docs/superpowers/specs/2026-10-15-chatbot-fluxos-2a-design.md) e [roteiro de aceite manual](docs/superpowers/plans/2026-10-15-chatbot-fluxos-2a-aceite.md).
```

- [ ] **Step 4: Update `docs/IMPLANTACAO.md`**

Make four exact replacements.

(a) §6.1. Replace the line
```markdown
**Voltar a versão** se algo quebrar:
```
with
```markdown
Chatbots durante a atualização:
- Uma execução que espera resposta do contato ou um tempo continua sozinha depois que o app volta.
- Uma execução que estava no meio de um passo quando o app parou fica como falhou, com o motivo "Interrompido por reinício do servidor". A conversa segue com os atendentes.

**Voltar a versão** se algo quebrar:
```

(b) §10 "Antes do dia". Replace the line
```markdown
- [ ] Menu de triagem e mensagem de encerramento configurados.
```
with
```markdown
- [ ] Menu de triagem e mensagem de encerramento configurados.
- [ ] Chatbot: em Configurações › Chatbots, clicar em **Criar a partir do modelo** e preencher:
  - o nome do escritório;
  - o canal;
  - os três destinos (Atendimento, Financeiro e Processos), cada um com o seu setor e o seu atendente. O campo personalizado **CPF** é reaproveitado, ou criado se não existir.
- [ ] Chatbot: abrir o **Fluxo do escritório** no editor e conferir os textos e o bloco **Horário** com o horário real do escritório. O modelo vem com seg–sex, 08:00–12:00 e 14:00–18:00, no horário de Cuiabá. Se mudar algo, clicar em **Salvar e publicar**.
- [ ] Chatbot: clicar em **Ativar** na lista, porque o modelo é criado pausado. Com ele ativo, a triagem simples deixa de rodar nesse canal.
- [ ] Configurações › Conversas: escolher o que acontece quando o atendente escreve com o chatbot rodando. O padrão é Perguntar.
```

(c) §10 "Teste manual". Replace the two lines
```markdown
- [ ] Mensagem digitada no celular do escritório aparece como enviada, sem ligar "Esperando" e sem menu de triagem.
```
and
```markdown
- [ ] Triagem: o contato novo recebe o menu, escolhe uma opção e a conversa vai para o setor certo.
```
with, respectively,
```markdown
- [ ] Mensagem digitada no celular do escritório aparece como enviada, sem ligar "Esperando", sem menu de triagem e sem iniciar o chatbot.
```
and
```markdown
- [ ] Triagem (com o chatbot pausado): o contato novo recebe o menu, escolhe uma opção e a conversa vai para o setor certo.
- [ ] Chatbot (ativo): o [roteiro de aceite](superpowers/plans/2026-10-15-chatbot-fluxos-2a-aceite.md) passa inteiro, com todas as partes, de A a F, marcadas.
```

(d) §10 "Virada". Replace the three lines
```markdown
2. [ ] Conectar o **número oficial** no sistema novo (seção 4). Isso desconecta o número do Umbler.
3. [ ] Durante uma semana, consultar o histórico antigo no Umbler quando preciso.
4. [ ] Cancelar a assinatura do Umbler Talk.
```
with
```markdown
2. [ ] Conectar o **número oficial** no sistema novo (seção 4). Isso desconecta o número do Umbler.
3. [ ] Se o número oficial ficou num canal diferente do canal de teste: no **Fluxo do escritório**, marcar esse canal no bloco **Iniciar por um canal** e clicar em **Salvar e publicar**. Em seguida, conferir na lista que o fluxo está ativo e mandar um `Oi` de um celular de teste para ver as boas-vindas.
4. [ ] Durante uma semana, consultar o histórico antigo no Umbler quando preciso.
5. [ ] Cancelar a assinatura do Umbler Talk.
```

- [ ] **Step 5: Run the doc check and confirm it passes**

Run (bash, from repo root): the three commands from Step 1.
Expected: PASS. The first prints a number ≥ 4. The second prints a number ≥ 3, from the lines with "Criar a partir do modelo", "Ativar" and "aceite". The third prints a number ≥ 3, from the lines with "Chatbot (entrega 2a)", "src/bots/" and the two `chatbot-fluxos-2a` links.

- [ ] **Step 6: Check that every quoted label and bot text exists in the code**

Run (bash, from repo root):
```bash
for s in 'Chatbots' 'Criar a partir do modelo' 'Salvar e publicar' 'Ativar' 'Versões' 'Restaurar' 'O chatbot está rodando' 'Enviar e manter' 'Executar chatbot' 'Parar chatbot' 'Quando o atendente enviar mensagem com chatbot em execução' 'Ver todos os setores' 'iniciado' 'parado'; do printf '%s: %s\n' "$s" "$(grep -rliF "$s" web/src | wc -l)"; done
for s in 'Fluxo do escritório' 'Estamos fora do horário de atendimento' 'Escolha uma das opções abaixo digitando o número correspondente:' 'Para agilizar, digite seu CPF:' 'CPF inválido, confira e digite de novo.' 'Nova conversa de' 'Nova conversa' 'Opção inválida.' 'Interrompido por reinício do servidor'; do printf '%s: %s\n' "$s" "$(grep -rlF "$s" server/src/bots | wc -l)"; done
```
Expected: every line ends in a number ≥ 1.

If a line prints `0`, the screen or the template uses different wording. Find the real text with `grep -rn` near the feature (for example `grep -rn "Restaur" web/src/components/bot-editor`). Then edit **only** the doc text in the acceptance script, README or IMPLANTACAO to match it, and rerun this step.

- [ ] **Step 7: Confirm only docs changed**

Run: `git status --short`
Expected: exactly these three paths, and nothing under `server/`, `web/` or `shared/`:
```text
 M README.md
 M docs/IMPLANTACAO.md
?? docs/superpowers/plans/2026-10-15-chatbot-fluxos-2a-aceite.md
```

- [ ] **Step 8: Commit**

```bash
git add README.md docs/IMPLANTACAO.md docs/superpowers/plans/2026-10-15-chatbot-fluxos-2a-aceite.md
git commit -m "docs: chatbot no README, checklist da virada e roteiro de aceite manual

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
