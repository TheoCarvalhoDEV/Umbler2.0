# 00 — Codebase map for the chatbot plan (branch `feat/chatbot-fluxos`, read 2026-10-15)

Exact current interfaces the chatbot subsystem (spec `docs/superpowers/specs/2026-10-15-chatbot-fluxos-2a-design.md`) must call or extend. All paths are relative to the repo root. Server imports use the `.js` extension.

## 0. Gaps between the spec and the code (read first)

These are spec assumptions the current code does **not** meet. Plan tasks must close them on purpose.

1. **`sendSystemText` is private.** It lives in `server/src/triage/triage.ts` and is not exported. It does not set `bot_run_id`. The spec wants the system send in `messages/send.ts`, so move or export it and add an optional `botRunId`. `markSent` and `waAddress` are already exported from `send.ts`. `deliver` and `callGateway`, which handle media sends, are private.
2. **The chat actions all need an `AuthUser`.** `transferChat`, `setChatPrivacy`, `closeChat`, `assumeChat` and `reopenChat` take `(ctx, user: AuthUser, …)` and call `getChatForUser`, which runs the `canSee` check and throws 404. `updateChat`, which does the conditional UPDATE, the event and the publish, is **private**, and `ChatEventKind` limits which events it can write. A bot acts as the system with `authorId=null`, so it needs either new exported system variants or an exported `updateChat`.
3. **`Hub` has no `publishUsersChanged` and does not track online users.** The interface is `register`, `disconnectUser`, `publishChat`, `publishMessage` and `publishChannel`. "Notificar só se online" is deferred to 2b anyway.
4. **The text normalizer is private.** `normalize()` in `triage/triage.ts` is not exported. Only `matchTriageOption` is.
5. **The quick-answer variables are built inline** in the `POST /api/quick-answers/:id/render` route. There is no exported "vars for chat" helper, and `firstName` is private. `renderQuickAnswer` only knows the groups `atendente`, `contato` and `campo`, so the `contexto` prefix must be added to its `groups` map. A group it does not know stays as literal text.
6. **The chat event kind union is defined in 4 places**, and all must change together:
   - `schema.ts` (`chatEvents.kind` `$type`)
   - `inbox/events.ts` (`ChatEventKind`)
   - `shared/src/index.ts` (`ChatEventDto.kind`)
   - `web/src/components/conversation/model.ts` (`eventText`, a `switch` with no `default`; TS2366 fails the build if a kind is missing)

   The column is `text`, so no SQL is needed for new kinds.
7. **`PUT /api/settings` replaces everything.** Its zod `Body` requires `closingMessage` and `triageMenu`. The tests in `server/test/catalog/settings.test.ts` check `toEqual(body)` on the PUT and GET responses. Add `botRunningBehavior` as optional with the default `'ask'`, or update those tests. The web `ChatSettings` PUTs `{ ...settings, closingMessage }`, so a new key carries through.
8. **`server/test/db/schema.test.ts`** checks `expect(tables).toHaveLength(17)`. Adding `bots`, `bot_versions` and `bot_runs` makes it 20.
9. **`setContactTags` replaces the whole set.** There is no add or remove for a single tag, so a bot "add tag" must read the current tags and pass the union. `setContactFields` merges by **field id**, and an empty value deletes. `setContactBlocked` exists.
10. **PGlite serializes transactions.** Inside `ctx.db.transaction(tx => …)`, use only `tx`. Touching `ctx.db` deadlocks (see the comment in `ingest.ts`). `FOR UPDATE SKIP LOCKED` is valid SQL on PGlite and real Postgres.

## 1. Server core

### `server/src/ctx.ts`
```ts
export interface AppCtx { db: Db; config: Config; wa: WhatsAppGateway; hub: Hub; }
```
Every module receives its dependencies through this. There is no logger in the ctx: use `console.error` with names only, never bodies.

### `server/src/config.ts`
```ts
export interface Config {
  port: number; databaseUrl: string; appOrigin: string; cookieSecure: boolean; webhookSecret: string;
  webhookBaseUrl: string; mediaDir: string; webDistDir: string | null;
  evolution: { url: string; apiKey: string }; sessionDays: number;
}
export function loadConfig(env: NodeJS.ProcessEnv): Config
```
Config comes from env through zod. No timezone setting exists: the bot's `hours` block takes `America/Cuiaba` from its own block config.

### `server/src/db/client.ts`
```ts
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export const migrationsFolder: string;            // server/drizzle
export function createPgDb(url: string): Db;
export async function createTestDb(): Promise<Db>; // fresh in-memory PGlite, migrated (~1 s)
```
- `server/src/db/migrate.ts` has `runMigrations(db)` (production only; tests migrate inside `createTestDb`).
- Migrations live in `server/drizzle/`. The latest is **`0001_visibilidade_e_fotos`** (idx 1 in `meta/_journal.json`), so **the next one is `0002_…`**.
- To add a migration:
  1. Edit `server/src/db/schema.ts`.
  2. Run `npm run db:generate -w server -- --name chatbot_fluxos`. This is drizzle-kit 0.31.11 and runs offline from `server/drizzle.config.ts`. It writes `drizzle/0002_chatbot_fluxos.sql`, `meta/0002_snapshot.json` and the journal entry.
  3. Commit all three.

  The SQL uses `--> statement-breakpoint` separators. Never hand-edit the snapshots.

### `server/src/db/schema.ts`
Conventions:
- Helpers `const id = () => uuid('id').primaryKey().$defaultFn(() => randomUUID())` and `const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()`.
- Enums are `text(...).$type<'a'|'b'>()`, never pg enums.
- jsonb is typed with `.$type<T>()`.
- Partial unique indexes use `uniqueIndex(name).on(...).where(sql\`...\`)`.

Imports available: `boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid, varchar, type AnyPgColumn` and `sql`. For `uuid[]`, use `uuid('start_channel_ids').array().notNull().default(sql\`'{}'::uuid[]\`)`.

The tables that matter here, verbatim:
```ts
export const users = pgTable('users', {
  id: id(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').$type<'admin' | 'agent'>().notNull(),
  signature: text('signature'),
  active: boolean('active').notNull().default(true),
  seeAllSectors: boolean('see_all_sectors').notNull().default(false),
  avatarPath: text('avatar_path'),
  createdAt: createdAt(),
});

export const contacts = pgTable(
  'contacts',
  {
    id: id(),
    name: text('name'),
    phone: text('phone'), // canonical 13 digits (normalizePhoneBR)
    lid: text('lid'),
    email: text('email'),
    landline: text('landline'),
    address: jsonb('address').$type<Record<string, string>>(),
    blocked: boolean('blocked').notNull().default(false),
    avatarPath: text('avatar_path'),
    avatarCheckedAt: timestamp('avatar_checked_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('contacts_phone_unique').on(t.phone).where(sql`${t.phone} is not null`),
    uniqueIndex('contacts_lid_unique').on(t.lid).where(sql`${t.lid} is not null`),
  ],
);

export const customFields = pgTable('custom_fields', {
  id: id(),
  name: text('name').notNull().unique(),
  kind: text('kind').$type<'text' | 'number' | 'date' | 'cpf' | 'cnpj'>().notNull(),
  position: integer('position').notNull().default(0),
});

export const contactFieldValues = pgTable(
  'contact_field_values',
  {
    contactId: uuid('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
    fieldId: uuid('field_id').notNull().references(() => customFields.id, { onDelete: 'cascade' }),
    value: text('value').notNull(),
  },
  (t) => [primaryKey({ columns: [t.contactId, t.fieldId] })],
);

export const tags = pgTable('tags', {
  id: id(),
  name: varchar('name', { length: 30 }).notNull().unique(),
  emoji: text('emoji'),
  color: text('color').notNull(),
  position: integer('position').notNull().default(0),
});

export const contactTags = pgTable(
  'contact_tags',
  {
    contactId: uuid('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id').notNull().references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.contactId, t.tagId] })],
);

export const chats = pgTable(
  'chats',
  {
    id: id(),
    contactId: uuid('contact_id').notNull().references(() => contacts.id),
    channelId: uuid('channel_id').notNull().references(() => channels.id),
    sectorId: uuid('sector_id').notNull().references(() => sectors.id),
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
    state: text('state').$type<'open' | 'closed'>().notNull().default('open'),
    waiting: boolean('waiting').notNull().default(false),
    private: boolean('private').notNull().default(false),
    triagePending: boolean('triage_pending').notNull().default(false),
    unread: integer('unread').notNull().default(0),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    lastMessagePreview: text('last_message_preview'),
    createdAt: createdAt(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('chats_one_open_per_contact_channel').on(t.contactId, t.channelId).where(sql`${t.state} = 'open'`),
    index('chats_last_message_at_idx').on(t.lastMessageAt),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: id(),
    chatId: uuid('chat_id').notNull().references(() => chats.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id').notNull().references(() => channels.id),
    direction: text('direction').$type<'in' | 'out'>().notNull(),
    kind: text('kind').$type<'text' | 'image' | 'audio' | 'video' | 'document' | 'sticker' | 'note' | 'unsupported'>().notNull(),
    body: text('body'),
    mediaPath: text('media_path'), // relative to config.mediaDir
    mediaMime: text('media_mime'),
    mediaSize: integer('media_size'),
    mediaName: text('media_name'),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }), // null = contact, phone or system
    replyToId: uuid('reply_to_id').references((): AnyPgColumn => messages.id, { onDelete: 'set null' }),
    externalId: text('external_id'), // null for notes and pending sends
    reaction: text('reaction'),
    status: text('status').$type<'pending' | 'sent' | 'delivered' | 'read' | 'failed'>().notNull().default('pending'),
    error: text('error'),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('messages_channel_external_unique').on(t.channelId, t.externalId),
    index('messages_chat_sent_idx').on(t.chatId, t.sentAt),
  ],
);

export const chatEvents = pgTable(
  'chat_events',
  {
    id: id(),
    chatId: uuid('chat_id').notNull().references(() => chats.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<'created' | 'assigned' | 'transferred' | 'closed' | 'reopened' | 'privacy_changed' | 'triage_routed'>().notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('chat_events_chat_idx').on(t.chatId, t.createdAt)],
);

export const settings = pgTable('settings', {
  key: text('key').primaryKey(), // 'closing_message' | 'triage_menu'
  value: jsonb('value').$type<unknown>().notNull(),
});
```
Other tables: `sessions`, `sectors` (`id, name, position, isDefault`, with a partial unique index on the one default), `userSectors`, `channels` (`id, name, kind, evolutionInstance, status, phone, createdAt`), `contactNotes`, `chatPins` and `quickAnswers`. That makes 17 in total.

### `server/src/lib/http-error.ts`
```ts
export class HttpError extends Error { constructor(public status: number, message: string) }
export const badRequest = (m = 'Requisição inválida') => new HttpError(400, m);
export const forbidden  = (m = 'Sem permissão')       => new HttpError(403, m);
export const notFound   = (m = 'Não encontrado')      => new HttpError(404, m);
export const conflict   = (m = 'Conflito')            => new HttpError(409, m);
```
- The error handler in `app.ts` sends `{ error: err.message }` with `err.status`. A `ZodError` becomes 400 `'Requisição inválida'`.
- Any other error becomes 500 `{ error: 'Ocorreu um erro', correlationId }`, and the log keeps only the name, code and stack frames.
- **No extra fields are sent today.** The spec's 409 `{ error, code: 'BOT_RUNNING', runs }` and 400 `{ problems }` need an `HttpError` subclass with a `body` (or similar) that the error handler spreads. Change `app.ts setErrorHandler` for it.

### `server/src/auth/plugin.ts`
```ts
declare module 'fastify' { interface FastifyRequest { user: AuthUser } }
export const SESSION_COOKIE = 'sid';
export const authPlugin: FastifyPluginAsync<{ ctx: AppCtx }>;  // non-encapsulated
export function authUser(req: FastifyRequest): AuthUser;        // throws 401
export async function requireUser(req: FastifyRequest): Promise<void>;
export async function requireAdmin(req: FastifyRequest): Promise<void>; // 403 unless role === 'admin'
```
- The `onRequest` hook requires a session for every `/api/*` route except login and health. Every non-GET/HEAD `/api/*` request and `/ws` must have `Origin === config.appOrigin`; otherwise it returns 403.
- In handlers `req.user` is always set.
- The catalog routes check admin inline as `if (req.user.role !== 'admin') throw forbidden();`. Channels use `await requireAdmin(request)`, or pass `{ preHandler: requireAdmin }`.

### `server/src/inbox/visibility.ts`
```ts
export interface AuthUser { id: string; name: string; email: string; role: 'admin' | 'agent'; signature: string | null;
  sectorIds: string[]; seeAllSectors: boolean; avatarUrl: string | null }
export interface ChatVisibilityFields { sectorId: string; ownerId: string | null; private: boolean }
export function canSee(user: AuthUser, chat: ChatVisibilityFields): boolean;
export function visibleChatsWhere(user: AuthUser): SQL | undefined; // undefined = admin with "ver todos"
export async function loadAuthUser(db: Db | Tx, userId: string): Promise<AuthUser | null>; // null if inactive/missing
```
- `canSee`: an admin with `seeAllSectors` sees everything. Otherwise the user sees chats they own, plus non-private chats in their sectors.
- Use `loadAuthUser(ctx.db, chat.ownerId)` to get the "atendente" for `{{atendente.*}}`.

### `server/src/inbox/chats.ts`
```ts
export type ChatRow = typeof chats.$inferSelect;
const UUID_RE = /^[0-9a-f]{8}-…$/i;                                         // private
const STALE = 'A conversa foi alterada por outra pessoa. Recarregue e tente de novo.'; // private
const BUSY_ELSEWHERE = 'Este contato já está em atendimento em outro setor.';           // private (NOT exported)

export async function findOrOpenChat(db: Db | Tx, args: { contactId: string; channelId: string;
  init: { sectorId: string; ownerId: string | null; waiting: boolean; triagePending: boolean; createdBy: string | null } })
  : Promise<{ chat: ChatRow; created: boolean }>;   // INSERT … ON CONFLICT DO NOTHING; writes 'created' event; no publish
export async function getDefaultSectorId(db: Db | Tx): Promise<string>;           // throws if none
export async function getChatForUser(ctx: AppCtx, user: AuthUser, chatId: string): Promise<ChatRow>; // 404 on bad id / !canSee
async function updateChat(ctx, chatId, expected: SQL | undefined, set: Partial<typeof chats.$inferInsert>,
  event: { kind: ChatEventKind; data: Record<string, unknown>; authorId: string | null }): Promise<ChatRow>; // PRIVATE
export async function assumeChat(ctx: AppCtx, user: AuthUser, chatId: string): Promise<ChatRow>;
export async function transferChat(ctx: AppCtx, user: AuthUser, chatId: string,
  to: { sectorId?: string; ownerId?: string | null }): Promise<ChatRow>;
export async function setChatPrivacy(ctx: AppCtx, user: AuthUser, chatId: string, isPrivate: boolean): Promise<ChatRow>;
export async function closeChat(ctx: AppCtx, user: AuthUser, chatId: string,
  opts: { sendClosingMessage: boolean; sendClosing?: (text: string) => Promise<boolean> }): Promise<ChatRow>;
export async function reopenChat(ctx: AppCtx, user: AuthUser, chatId: string): Promise<ChatRow>;
export async function markChatRead(ctx: AppCtx, user: AuthUser, chatId: string): Promise<void>;
export async function pinChat(ctx: AppCtx, user: AuthUser, chatId: string, pinned: boolean): Promise<void>;
export async function startChat(ctx: AppCtx, user: AuthUser,
  input: { contactId?: string; phone?: string; name?: string; sectorId?: string }): Promise<ChatRow>;
```
- `updateChat` runs the UPDATE in one tx with `WHERE id AND expected`. Zero rows means 409 `STALE`; otherwise it calls `addEvent`, and after commit `ctx.hub.publishChat`.
- Transfer sets `triagePending:false`. When `ownerId` becomes null it also sets `private:false`. The event is `transferred {fromSectorId,toSectorId,fromOwnerId,toOwnerId}`.
- `closeChat` sends the closing text **before** the UPDATE. The route wires it to `sendAgentMessage(…,{text, signature:false})`. The update sets `{state:'closed', closedAt, waiting:false, triagePending:false}` and writes the event `closed {closingMessageSent}`.
- Privacy: only the owner or an admin may change it. Making a chat private needs an owner.
- Sector and user existence checks (`sectorExists`, `activeUserExists`) are private helpers.
- Routes in `server/src/chats/routes.ts` use an `action(path, run)` helper that returns `toChatDetail`.

### `server/src/inbox/events.ts`
```ts
export type ChatEventKind = 'created' | 'assigned' | 'transferred' | 'closed' | 'reopened' | 'privacy_changed' | 'triage_routed';
export async function addEvent(db: Db | Tx, chatId: string, kind: ChatEventKind,
  data: Record<string, unknown>, authorId: string | null): Promise<void>; // created_at = clock_timestamp()
```

### `server/src/inbox/queries.ts`
```ts
export async function toChatListItem(db: Db | Tx, chat: ChatRow, userId: string): Promise<ChatListItem>;
export async function toChatDetail(db: Db | Tx, chat: ChatRow, userId: string): Promise<ChatDetail>; // no visibility check
export async function listChats(ctx: AppCtx, user: AuthUser, f: ChatListFilters): Promise<{ items: ChatListItem[]; nextCursor: string | null }>;
export async function getChatDetail(ctx: AppCtx, user: AuthUser, chatId: string): Promise<ChatDetail>;
export async function getTimeline(ctx: AppCtx, user: AuthUser, chatId: string,
  q: { before?: string; limit?: number }): Promise<TimelineItem[]>;
```
- `getTimeline` merges messages (through `toMessageDto`) with events. Each event comes out as `{ type:'event', id, chatId, kind, data, authorName (users.name via authorId), createdAt }`.
- A bot event has `authorId=null`, so `authorName` is null. Put `botName` in `data`.

### `server/src/messages/send.ts`
```ts
export interface SendInput { text?: string; file?: { buffer: Buffer; mime: string; name: string };
  asVoice?: boolean; signature: boolean; replyToId?: string }
export async function markSent(db: Db, messageId: string, channelId: string, externalId: string)
  : Promise<{ row: MessageRow; echoDropped: boolean }>; // deletes author-less echo with same external_id, then sets sent; 1 retry on 23505
export async function failInterruptedSends(db: Db): Promise<void>;   // boot: pending → failed
export function waAddress(c: { phone: string | null; lid: string | null } | undefined): string | null; // phone or '<lid>@lid'
export async function sendAgentMessage(ctx: AppCtx, user: AuthUser, chatId: string, input: SendInput): Promise<MessageDto>;
export async function resendMessage(ctx: AppCtx, user: AuthUser, messageId: string): Promise<MessageDto>;
export async function addNote(ctx: AppCtx, user: AuthUser, chatId: string, text: string): Promise<MessageDto>;
// private: touchChat(tx,user,chat,last?), quotedRef, callGateway(ctx,msg), deliver(ctx,msg), fileKind
```
`sendAgentMessage` steps:
(1) `getChatForUser`. (2) 409 `'Conversa finalizada'` if the chat is closed. (3) Signature through `formatSignature` and `signatureLabel`. (4) `saveMedia`. (5) One tx with `touchChat`, which makes the sender owner if there is none (event `assigned`) and sets `waiting/unread/triagePending` to false, plus a pending INSERT. (6) Publish `message.created` and the chat. (7) `deliver`: call the gateway **outside the tx**, then `markSent` or `failed`, then publish `message.updated`.

The spec's `botAction` and `BOT_RUNNING` check belongs at the start, before step 5. The route `POST /api/chats/:id/messages` uses `textBody` zod `{text, signature=true, replyToId?}` or `readMultipart`. Add `botAction` to both.

### The system send path (`server/src/triage/triage.ts`, private)
```ts
async function sendSystemText(ctx: AppCtx, chat: ChatRow, text: string): Promise<{ ok: boolean; echoDropped: boolean }>;
```
1. Looks up the contact address (`waAddress`) and the channel instance. With no address it returns `{ok:false}`.
2. In one tx: INSERTs an `out` text message (`authorId:null`, `status:'pending'`) and UPDATEs `lastMessageAt` (greatest) and `lastMessagePreview` (`messagePreview`). It does **not** touch `waiting`, `unread` or the owner.
3. Publishes `message.created`.
4. Calls `ctx.wa.sendText` outside the tx.
5. On success it calls `markSent`. If an echo was dropped, it restores `waiting` from the snapshot. On failure the message becomes `failed` with `error`.
6. Publishes `message.updated`. The **caller** publishes the chat.

### `server/src/messages/ingest.ts`
```ts
export interface IngestHooks { startTriage: typeof startTriage; handleTriageReply: typeof handleTriageReply }
export const MEDIA_UNAVAILABLE = 'mídia indisponível';
export async function handleInbound(ctx: AppCtx, events: InboundEvent[], hooks: IngestHooks = defaultHooks): Promise<void>;
export async function avatarRefreshesIdle(): Promise<void>;
```
`ingestMessage` steps:
1. One tx: dedup by `(channel, externalId)` → `resolveContact`, where a blocked contact means skip → `findOrOpenChat` (default sector, owner null, `waiting: inbound`) → insert the message (`authorId:null`, `status:'sent'`) → update the chat. Inbound: `unread+1, waiting:true`. Outbound or echo: `waiting:false, triagePending:false`.
2. After commit: publish `message.created` and the chat, start the avatar refresh, then `fetchMedia` if there is media.
3. **The exact hook point**, at the end of `ingestMessage`:
```ts
  if (inbound) {
    if (stored.created) await hooks.startTriage(ctx, stored.chat);
    else if (stored.chat.triagePending) await hooks.handleTriageReply(ctx, stored.chat, ev.body);
  }
```
- The bot start-by-channel replaces `startTriage` when a bot matches. `resumeOnReply` goes into the `else` branch.
- `stored.chat` is the chat row **after** the update. `stored.messageId` is the new message id, `ev.kind`, `ev.body` and `ev.mediaMime` describe the message, and `ev.direction` tells inbound from outbound.
- In tests the hooks are stubbed: `handleInbound(ctx, events, hooks)`. Extend `IngestHooks`, for example with `startBot` or `resumeBot`, so the existing stubs keep compiling. The defaults are `{ startTriage, handleTriageReply }`.

### `server/src/triage/triage.ts`
```ts
export interface TriageOption { key: string; label: string; sectorId: string }
export interface TriageMenu { enabled: boolean; welcomeText: string; invalidText: string; options: TriageOption[] }
export async function getTriageMenu(db: Db | Tx): Promise<TriageMenu>;    // settings 'triage_menu' (snake_case), safeParse → disabled default
export function matchTriageOption(text: string, menu: TriageMenu, sectorNames: Map<string, string>): TriageOption | null;
export async function startTriage(ctx: AppCtx, chat: ChatRow): Promise<void>;   // arms triagePending first, then sends
export async function handleTriageReply(ctx: AppCtx, chat: ChatRow, text: string | null): Promise<boolean>; // UPDATE … WHERE triage_pending=true wins once
// private:
function normalize(s: string): string { return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
  .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').replace(/\s+/g, ' '); }
```
- Matching compares `normalize` of the text with the option's key, label and sector name.
- A routed triage writes `triage_routed {sectorId, option}` with author null.

### `server/src/messages/quick-answers.ts`
```ts
export interface QuickAnswerVars {
  atendente: { nome: string; primeiro_nome: string; email: string };
  contato: { nome: string; primeiro_nome: string; telefone: string; email: string };
  campo: Record<string, string>;            // keyed by custom field NAME (slugged on lookup)
}
export function renderQuickAnswer(body: string, vars: QuickAnswerVars): string; // /\{\{\s*([^{}.]+)\.([^{}]+?)\s*\}\}/g
export function convertUmblerVariables(body: string, variables: Array<{ defaultValue: string }>): { body: string; unmapped: string[] };
```
- The group and the name are compared after `slug()` (no accents, lowercase, `_`).
- A known group with an unknown name renders `''`. An unknown group stays literal. The regex is `NAMED_VAR`. Note that `{{contexto.cpf:raw}}` puts `cpf:raw` in the name, and slug turns it into `cpf_raw`.
- **How the vars are built today** (`server/src/catalog/quick-answers.ts`, render route):
```ts
const firstName = (s: string) => s.trim().split(/\s+/)[0] ?? '';   // private
const [contact] = await ctx.db.select().from(contacts).where(eq(contacts.id, chat.contactId));
const fieldRows = await ctx.db.select({ name: customFields.name, value: contactFieldValues.value })
  .from(contactFieldValues).innerJoin(customFields, eq(customFields.id, contactFieldValues.fieldId))
  .where(eq(contactFieldValues.contactId, chat.contactId));
const contactName = contact?.name ?? '';
renderQuickAnswer(qa.body, {
  atendente: { nome: req.user.name, primeiro_nome: firstName(req.user.name), email: req.user.email },
  contato: { nome: contactName, primeiro_nome: firstName(contactName), telefone: contact?.phone ?? '', email: contact?.email ?? '' },
  campo: Object.fromEntries(fieldRows.map((f) => [f.name, f.value])),
});
```
Pull this into an exported `buildChatVars(db, chat, atendente: AuthUser | null)` so the render route and the bot share it.

### `server/src/messages/dto.ts`
```ts
export function messagePreview(kind: MessageDto['kind'], body: string | null): string; // body || label, max 100 chars
export async function toMessageDto(db: Db | Tx, row: MessageRow): Promise<MessageDto>;
```
- `toMessageDto` does one query for the author (`id, name, avatarPath` → `authorName`, `authorAvatarUrl` via `userAvatarUrl`) and one for `replyTo`. The `media` url is `/api/media/${row.id}`.
- For the bot, add `botRunId` and `botName` here. Join `bot_runs` → `bots` when `row.botRunId` is set.

### `server/src/messages/media.ts`
```ts
export function baseMime(mime: string): string;
export async function saveMedia(mediaDir: string, data: Buffer, mime: string, originalName?: string | null)
  : Promise<{ path: string; size: number }>;            // <mediaDir>/YYYY/MM/<uuid>.<ext>, path is relative
export function mediaResponseHeaders(mime: string, fileName: string): Record<string, string>; // nosniff, inline only for safe types
```
Quick-answer attachments use the same store (`quickAnswers.attachmentPath`), and their mime is guessed from the extension by `MIME_BY_EXT` in `catalog/quick-answers.ts`.

### `server/src/contacts/service.ts`
```ts
export async function toContactDtos(db: Db | Tx, rows: ContactRow[]): Promise<ContactDto[]>;
export async function getContact(db: Db | Tx, id: string): Promise<ContactDto>;                 // 404
export async function publishOpenChats(ctx: AppCtx, contactId: string): Promise<void>;           // publishChat for each open chat
export async function createContact(ctx: AppCtx, input: ContactInput & { phone: string }): Promise<ContactDto>;
export async function updateContact(ctx: AppCtx, id: string, p: ContactInput): Promise<ContactDto>; // publishes open chats
export async function setContactBlocked(ctx: AppCtx, id: string, blocked: boolean): Promise<ContactDto>; // no publish
export async function setContactTags(ctx: AppCtx, id: string, tagIds: string[]): Promise<ContactDto>;   // REPLACES set; 400 'Etiqueta inexistente'; publishes
export async function setContactFields(ctx: AppCtx, id: string, values: Record<string /*fieldId*/, string>): Promise<ContactDto>; // merge; '' deletes; 400 'Campo inexistente'; no publish
export async function listContactChats(ctx: AppCtx, user: AuthUser, id: string): Promise<ChatListItem[]>;
export interface ContactInput { name?: string | null; phone?: string; email?: string | null; landline?: string | null; address?: Record<string, string> | null }
```
These run their own `ctx.db.transaction`, so never call them inside another tx (PGlite deadlock). A custom field is created through `POST /api/custom-fields` `{name, kind, position?}` (admin; 409 on a duplicate name). From the bot template, insert into `customFields` directly with `onConflictDoNothing`.

### `server/src/catalog/settings.ts`
```ts
const Body = z.object({ closingMessage: z.string().trim().max(2000), triageMenu: z.object({ enabled, welcomeText, invalidText,
  options: z.array({ key, label, sectorId: z.uuid() }).max(20) }).refine(...).refine(...) });
async function readSettings(db: Db): Promise<SettingsDto>;   // private
export function registerSettingsRoutes(app: FastifyInstance, ctx: AppCtx): void; // GET /api/settings (any user), PUT (admin)
```
- Keys today: `closing_message` (a jsonb string) and `triage_menu` (jsonb snake_case). Each is upserted with `insert(settings).values({key, value}).onConflictDoUpdate({ target: settings.key, set: { value } })` inside one tx.
- `getClosingMessage` (private, `inbox/chats.ts`) shows the pattern for reading one key: `select value where key=…` and fall back to a default when the type is wrong.
- **To add `bot_running_behavior`:**
  1. Extend `SettingsDto` (shared).
  2. Extend `Body`, optional with a default, see §0.7.
  3. Read it in `readSettings`.
  4. Upsert it in the PUT tx.
  5. Export a reader such as `getBotRunningBehavior(db)`.

### `server/src/realtime/hub.ts`
```ts
export interface Hub {
  register(user: AuthUser, socket: Socket): () => void; // returns unregister
  disconnectUser(userId: string): void;
  publishChat(chatId: string): Promise<void>;           // per user: canSee → chat.updated(toChatListItem) else chat.removed
  publishMessage(chatId: string, type: 'message.created' | 'message.updated', messageId: string): Promise<void>; // canSee users only
  publishChannel(channelId: string): Promise<void>;     // channel.status to all
}
export function createHub(getDb: () => Db): Hub;
export function createRecordingHub(): Hub & { events: Array<{ type: string; chatId?: string; messageId?: string; channelId?: string; userId?: string }> };
```
- Recording-hub event `type`s: `'chat'`, `'message.created'`, `'message.updated'`, `'channel'` and `'disconnect'`.
- There is no online-users API. `byUser` is a private map, and `/ws` keepalive pings every 30 s (`realtime/routes.ts`).
- Publish **after** commit, never inside a tx.

### `server/src/whatsapp/types.ts`
```ts
export interface WhatsAppGateway {
  createInstance(instance: string, webhookUrl: string): Promise<void>;
  connect(instance: string): Promise<{ qrBase64: string | null }>;
  connectionState(instance: string): Promise<ChannelStatus>;
  sendText(instance: string, phone: string, text: string, quoted?: QuotedRef): Promise<SendResult>;
  sendMedia(instance: string, phone: string, media: OutgoingMedia, quoted?: QuotedRef): Promise<SendResult>;
  sendAudio(instance: string, phone: string, base64: string, quoted?: QuotedRef): Promise<SendResult>;
  downloadMedia(instance: string, rawMessage: unknown): Promise<DownloadedMedia>;
  fetchProfilePicture(instance: string, address: string): Promise<string | null>;
}
export interface SendResult { externalId: string }
export interface OutgoingMedia { kind: 'image' | 'video' | 'document'; base64: string; mime: string; fileName: string; caption?: string }
export type MessageKind = 'text' | 'image' | 'audio' | 'video' | 'document' | 'sticker' | 'note' | 'unsupported';
export type InboundEvent = | { type: 'message'; instance; externalId; direction: 'in'|'out'; phone; lid; pushName; kind: MessageKind;
    body: string | null; hasMedia: boolean; mediaMime: string | null; mediaName: string | null; replyToExternalId; sentAt: Date; raw: unknown }
  | { type: 'reaction'… } | { type: 'status'… } | { type: 'connection'… } | { type: 'qrcode'… } | { type: 'ignored'; reason: string };
```
The `instance` comes from `channels.evolutionInstance`. The `phone` is `waAddress(contact)`.

### Fake gateway (`server/src/whatsapp/fake.ts`)
```ts
export function createFakeGateway(): WhatsAppGateway & {
  sent: Array<{ method: string; instance: string; phone?: string; payload: unknown }>; // sendText payload = { text, quoted }
  failNext(err?: Error): void;      // next call (except fetchProfilePicture) throws once
  status: Map<string, ChannelStatus>;
  profilePictures: Map<string, string | Error>;
  pictureLookups: Array<{ instance: string; address: string }>;
};
```
External ids come out as `fake-1`, `fake-2` and so on. `sendMedia`'s payload is `{ media, quoted }`.

### `server/src/app.ts`
`export async function buildApp(ctx: AppCtx, opts: BuildAppOptions = {}): Promise<FastifyInstance>`

Registration order: `setErrorHandler` → `cookie` → `multipart` (64 MB, 1 file) → `rateLimit` (global false) → `websocket` → `authPlugin` → `authRoutes` → `realtimeRoutes(ctx)` → `registerWebhookRoutes` → `await mediaRoutes` → `/api/health` → `registerSectorRoutes` → `registerTagRoutes` → `registerCustomFieldRoutes` → `registerContactRoutes` → `registerUserRoutes` → `registerQuickAnswerRoutes` → `registerSettingsRoutes` → `await chatRoutes` → `registerChannelRoutes` → **SPA static and not-found, which stays LAST**

Add `registerBotRoutes(app, ctx)` after `registerChannelRoutes`, before the SPA block. The pattern is `export function registerXRoutes(app: FastifyInstance, ctx: AppCtx): void`, parsing input with `z.object(...).parse(req.body)` and `IdParams = z.object({ id: z.uuid() })`.

### `server/src/index.ts` (startup and shutdown)
Startup runs in this order:
(1) `loadConfig` (2) `createPgDb` (3) `await runMigrations` (4) `await failInterruptedSends` (5) Build the ctx `{db, wa: createEvolutionGateway(config.evolution), hub: createHub(() => db), config}` (6) `buildApp(ctx, {trustProxy, logger})` (7) `syncChannelStatuses(ctx).catch(...)` (8) `await app.listen({host:'0.0.0.0', port})` (9) The shutdown handler:

```ts
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => { void app.close().then(() => process.exit(0)); });
}
```
The scheduler fits here: start it after `app.listen`, for example `const stopScheduler = startScheduler(ctx)` → `setInterval(() => void tick(new Date()), 5000)`. Stop it in that signal handler before `app.close()`, or via `app.addHook('onClose', …)`. No other module-level timers exist; `/ws` keepalive timers are per socket.

## 2. Server test helpers (`server/test/helpers.ts`)
```ts
export const makeTestDb = createTestDb;
export const TEST_PASSWORD = 'senha-teste-123';
export const TEST_ORIGIN = 'http://localhost:5173';
export function testPasswordHash(): Promise<string>;
export interface SeededUser { id; name; email; role: 'admin'|'agent'; signature: string|null; sectorIds: string[]; seeAllSectors: boolean; avatarUrl: string|null } // assignable to AuthUser
export interface Seeded { admin: SeededUser; agentA: SeededUser; agentB: SeededUser; sectorA: string; sectorB: string; defaultSector: string; channelId: string; instance: string }
export async function seedBasics(ctx: { db: Db | Tx }): Promise<Seeded>;
export async function enableSeeAll(ctx: { db: Db | Tx }, user: SeededUser): Promise<SeededUser>;
export async function makeTestCtx(): Promise<AppCtx & { wa: ReturnType<typeof createFakeGateway>; hub: ReturnType<typeof createRecordingHub> }>;
export async function makeTestApp(ctx?: AppCtx): Promise<{ app: FastifyInstance; ctx: AppCtx }>;
export async function loginAs(app: FastifyInstance, email: string, password = TEST_PASSWORD): Promise<{ cookie: string; headers: Record<string, string> }>; // headers include origin
```
`seedBasics` inserts the following. The ids are random UUIDs.
- Sectors: `'Atendimento'` (position 0, isDefault) → `defaultSector`; `'Financeiro'` (1) → `sectorA`; `'Jurídico'` (2) → `sectorB`
- Users: `'Admin Teste'` `admin@teste.local` (admin, no sectors); `'Ana Financeiro'` `ana@teste.local` (agent, sectorA); `'Bruno Jurídico'` `bruno@teste.local` (agent, sectorB)
- Channel `'WhatsApp teste'`, instance `'talk-test'`, status `connected`.
- No contacts and no settings.

`makeTestCtx` config: `appOrigin: TEST_ORIGIN`, `mediaDir` is a fresh `mkdtemp` folder, `webDistDir: null`, `webhookSecret: 'test-webhook-secret-0123456789abcdef'`.

Other fixtures:
- `server/test/inbox/fixtures.ts`:
  - `newContact(ctx, {phone?, name?})`: unique `55659…` phone.
  - `insertChat(ctx, {channelId, sectorId, contactId?, ownerId?, private?, state?, unread?})`: no event, no hub.
  - `eventsOf(ctx, chatId)`.
  - `statusOf(promise)`: 200 or the HttpError status.
- `server/test/chats/seed.ts`:
  - `seedChat(ctx, {channelId, sectorId, …})` → `{chatId, contactId}`.
  - `seedMessage(ctx, chatId, channelId, at, extra?)`.
  - `seedEvent(ctx, chatId, kind: ChatEventKind, at)`.
- Ingest test pattern: build an Evolution payload, then `parseEvolution` → `handleInbound(ctx, events, stubHooks().hooks)` (see `server/test/messages/ingest.test.ts`). There are fixtures in `server/test/fixtures/evolution/*.json`, for example `text-in.json`.

`server/vitest.config.ts` uses the `node` env, includes `test/**/*.test.ts`, and sets `testTimeout`/`hookTimeout` to 30 s.

## 3. Shared (`shared/`)
- `shared/package.json`:
  - `"type": "module"`.
  - `exports: { ".": { types: "./src/index.ts", default: "./src/index.ts" } }`, with **no build step**. tsx (server) and Vite (web) load the TS source.
  - The web tsconfig maps it with `paths: { "@talk/shared": ["../shared/src/index.ts"] }`.
- `shared/src/index.ts` has only types, plus a re-export of `TAG_COLORS` and `tagColorHex` from `./palette.js`, the only runtime code.
  - Import types with `import type`.
  - A new runtime module (`shared/src/bots.ts` with `BLOCK_CATALOG` and `outputsOf`) is re-exported the same way as the palette: `export { … } from './bots.js'`, `export type { … } from './bots.js'`.
- Current DTOs:
```ts
export type Role = 'admin' | 'agent';
export interface Me { id; name; email; role: Role; signature: string | null; sectorIds: string[]; seeAllSectors: boolean; avatarUrl: string | null }
export interface SectorDto { id: string; name: string; position: number; isDefault: boolean }
export interface TagDto { id: string; name: string; emoji: string | null; color: string; position: number }
export interface UserDto { id; name; email; role: Role; signature: string | null; active: boolean; sectorIds: string[]; avatarUrl: string | null }
export interface ChannelDto { id: string; name: string; status: 'disconnected' | 'connecting' | 'connected'; phone: string | null }
export interface ContactRef { id: string; name: string | null; phone: string | null; avatarUrl: string | null }
export interface ChatListItem { id; contact: ContactRef; channelId; sectorId; ownerId: string | null; state: 'open' | 'closed'; waiting: boolean; private: boolean; unread: number; lastMessageAt: string | null; lastMessagePreview: string | null; pinned: boolean; tagIds: string[] }
export interface ChatDetail extends ChatListItem { triagePending: boolean; createdAt: string; closedAt: string | null }
export interface MediaDto { url: string; mime: string; name: string | null; size: number | null }
export interface MessageDto { id: string; chatId: string; direction: 'in' | 'out'; kind: 'text' | 'image' | 'audio' | 'video' | 'document' | 'sticker' | 'note' | 'unsupported'; body: string | null; media: MediaDto | null; mediaUnavailable: boolean; authorId: string | null; authorName: string | null; authorAvatarUrl: string | null; replyTo: { id: string; body: string | null; kind: string } | null; reaction: string | null; status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed'; error: string | null; sentAt: string }
export interface ChatEventDto { id: string; chatId: string; kind: 'created' | 'assigned' | 'transferred' | 'closed' | 'reopened' | 'privacy_changed' | 'triage_routed'; data: Record<string, unknown>; authorName: string | null; createdAt: string }
export type TimelineItem = ({ type: 'message' } & MessageDto) | ({ type: 'event' } & ChatEventDto);
export interface ContactDto { id; name; phone; lid; email; landline; address: Record<string, string> | null; blocked: boolean; tagIds: string[]; fields: Record<string /*fieldId*/, string>; createdAt: string; avatarUrl: string | null }
export interface CustomFieldDto { id: string; name: string; kind: 'text' | 'number' | 'date' | 'cpf' | 'cnpj'; position: number }
export interface QuickAnswerDto { id; name; body; hasAttachment: boolean; visibility: 'all' | 'owner'; ownerId: string | null }
export interface TriageMenuDto { enabled: boolean; welcomeText: string; invalidText: string; options: Array<{ key: string; label: string; sectorId: string }> }
export interface SettingsDto { closingMessage: string; triageMenu: TriageMenuDto }
export type WsEvent =
  | { type: 'chat.updated'; chat: ChatListItem } | { type: 'chat.removed'; chatId: string }
  | { type: 'message.created'; message: MessageDto } | { type: 'message.updated'; message: MessageDto }
  | { type: 'channel.status'; channel: ChannelDto };
```
Adding `botRunId` and `botName` to `MessageDto` breaks every test literal that builds a `MessageDto`, for example `message()` in `Composer.test.tsx` and the factories in `model.test.ts` and `MessageBubble.test.tsx`. Add the fields there, or make them optional (`botName?: string | null`).

## 4. Web (`web/`)

### Routing (`web/src/App.tsx`)
`export const routes: RouteObject[]`. Children of `/`, wrapped in `<RequireAuth><AppLayout/></RequireAuth>`:
- `index` → `/chats`
- `chats` (`<Inbox/>`) with children index and `:id` (`<ConversationPage/>`)
- `contacts`
- `contacts/new`
- **`configuracoes/:section?`** → `<SettingsPage/>`
- `*` → NotFound

`main.tsx` calls `createBrowserRouter(routes)` and wraps it in `QueryClientProvider(createQueryClient())`. The full-screen editor `/configuracoes/chatbots/:id` needs a new explicit route **before** `configuracoes/:section?`, either as a child of `/` or outside `AppLayout` for real full screen.

### Settings registry (`web/src/pages/settings/SettingsPage.tsx`)
```ts
const SECTIONS: Array<{ path: string; label: string; adminOnly: boolean; page: ComponentType }> = [
  perfil, canais*, atendentes*, setores*, etiquetas*, campos*, respostas-rapidas, triagem*, conversas*  // * adminOnly
];
```
- The list filters by `me.role === 'admin'`. An unknown or forbidden section redirects to `/configuracoes/perfil`.
- To add the list page, add `{ path: 'chatbots', label: 'Chatbots', adminOnly: true, page: BotsSettings }`.
- The left nav is `NavLink` with `bg-sidebar-active` when active. The main sidebar (`components/layout/AppLayout.tsx`) has `NavItem`s for `/chats`, `/contacts` and `/configuracoes` (Phosphor `*Icon` names).
- `useCurrentUser(): Me` and `useMe()` come from `web/src/lib/auth.tsx`.

### `web/src/lib/api.ts`
```ts
export class ApiError extends Error { constructor(public status: number, message: string, public correlationId?: string) }
export async function request<T>(method: string, path: string, body?: unknown): Promise<T>; // credentials include; FormData passthrough; 204 → undefined; !ok → ApiError(status, data.error)
export const api: ((path, init?) => Promise<T>) & { auth, chats, messages, contacts, sectors, tags, customFields, users, quickAnswers, settings, channels };
export const qk = { me, chats: ['chats'], chatLists, chatList(f), chat(id): ['chats','detail',id], timeline(id): ['chats','timeline',id],
  contacts, contactList(q), contact(id), contactChats(id), contactNotes(id), sectors, tags, customFields: ['custom-fields'], users,
  quickAnswers: ['quick-answers'], settings, channels };
export interface SendTextInput { text: string; signature: boolean; replyToId?: string }
export interface SendFileInput { file: Blob; fileName?: string; text?: string; signature: boolean; replyToId?: string; asVoice?: boolean }
export type TimelineData = InfiniteData<TimelineItem[], string | undefined>;
```
- `crud<T, I>(base)` gives `{ list, create, update (PATCH), remove }`.
- **`ApiError` keeps only the message.** The 409 body fields (`code`, `runs`, `problems`) are lost, so extend `ApiError` with a `data`/`body` field filled in `request()`.
- Add the namespaces `api.bots` and `api.botRuns`, and the keys `qk.bots`, `qk.bot(id)`, `qk.botVersions(id)`, `qk.botManual` and `qk.chatBotRuns(chatId)`. Put the chat runs under `['chats', …]` so a WS reconnect refreshes them.

### `web/src/lib/ws.ts`
```ts
export function onWsEvent(fn: (ev: WsEvent) => void): () => void;
export function useWsEvent(fn: (ev: WsEvent) => void): void;
export function applyWsEvent(qc: QueryClient, ev: WsEvent): void; // pure cache reducer
export function connectWs(qc: QueryClient, url?: string): () => void; // reconnect 1s→30s; onopen invalidates qk.chats + qk.channels
```
- `chat.updated` patches lists and detail, then invalidates the lists.
- `chat.removed` filters and resets.
- `message.created` and `message.updated` upsert into `qk.timeline(chatId)`, with insert only on `created`.
- `ConversationView` invalidates the timeline on any `chat.updated` for the open chat. Bot events therefore show up once the bot publishes the chat.

### Theme tokens (`web/src/index.css`, Tailwind v4 `@theme`, dark)
`--color-sidebar #14161b`, `sidebar-hover #22252d`, `sidebar-active #2b3040`, `surface #1b1e25`, `panel #23262f`, `border #313543`, `fg #e7e9ef`, `muted #9aa1b1`, `primary #4a6cf7`, `primary-hover #3b5ce6`, `danger #e5484d`, `success #30a46c`, and `--font-sans`.

Use them as classes: `bg-panel`, `text-muted`, `border-border`, `bg-primary`, `text-danger` and so on. `color-scheme: dark`. React Flow's CSS (`@xyflow/react/dist/style.css`) needs dark overrides with these tokens.

### Component patterns
- **Buttons and fields** (`web/src/components/settings/common.tsx`):
```ts
export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export function send<T = unknown>(path: string, method: Method, body?: unknown): Promise<T>;
export function useSend(...refresh: QueryKey[]); // useMutation({ mutationFn: (run: () => Promise<unknown>) => run(), onSuccess: invalidate refresh keys })
export const btn = 'rounded border border-border px-3 py-1.5 text-sm hover:bg-sidebar-hover disabled:opacity-50';
export const btnPrimary = 'rounded bg-primary px-3 py-1.5 text-sm text-white hover:bg-primary-hover disabled:opacity-50';
export const field = 'mt-1 w-full rounded border border-border px-2 py-1.5 text-sm';
export function Section({ title, action, children }); export function ErrorText({ error }); export function Loading({ error });
```
- **Settings page pattern** (`TagsSettings.tsx`):
  - `useQuery({queryKey: qk.tags, queryFn: api.tags.list})`, `const save = useSend(qk.tags)`, and an `editing` state of `T | 'new' | null`.
  - Saving is `save.mutate(() => send(path, method, v), {onSuccess})`. Deleting asks `window.confirm`.
  - Rows are `<ul className="divide-y divide-border rounded border border-border">`.
- **Dialogs** (`components/conversation/ChatDialogs.tsx`) use a private `Modal({title, onCancel, children})` on a native `<dialog>` with `showModal()` in `useEffect`. `onCancel` calls `preventDefault` before `onCancel()`. The class is `m-auto w-[min(28rem,calc(100%-2rem))] rounded-lg bg-panel p-5 text-fg shadow-xl backdrop:bg-black/50`. `Actions({busy, error, confirmLabel, onCancel, onConfirm})` is also private; export both to reuse them. The exported dialogs are `TransferDialog` and `CloseDialog`.
- **Icons:** `@phosphor-icons/react` 2.1.10. The Composer imports the legacy names (`Lightning`, `Paperclip`); the layout imports `*Icon` names. `Robot` / `RobotIcon` exist.

### `web/src/components/conversation/Composer.tsx`
```ts
export const SIGNATURE_KEY = 'talk.composer.signature';
export interface ComposerProps { chatId: string; replyTo: MessageDto | null; onClearReply: () => void }
export function Composer({ chatId, replyTo, onClearReply }: ComposerProps);
function ToolButton({ label, onClick, children }); // private: rounded p-1.5 text-muted hover:bg-panel hover:text-fg
```
- Sending goes through `submit(call)`. It sets `sending`, awaits `call()`, then `applyWsEvent(qc, {type:'message.created', message})`. On error it does `setError(errorMessage(e))` and returns false.
- `send()` clears the text and file first and restores them on failure.
- The calls are `api.chats.addNote`, `sendFile({file, text, signature, replyToId})` and `sendText({text, signature, replyToId})`.
- **The `BOT_RUNNING` 409 is handled inside `submit`/`send`.** Catch an `ApiError` with status 409 and code `BOT_RUNNING`, open the 3-choice dialog, then resend with `botAction`.
- **The robot button goes in the tool row** `<div className="mt-1 flex items-center gap-1">`, after the Emoji `<div className="relative">` and before the signature label, as a `ToolButton` opening a popover panel the same way as the emoji grid (`absolute bottom-full left-0 z-10 mb-1 … bg-panel`).
- The Composer is rendered by `ConversationView.tsx` (`ConversationPane`) only when `chat.state === 'open'`.

### Timeline and MessageBubble
- `Timeline({ chatId, onReply })` loads `useInfiniteQuery(qk.timeline)` and builds a `names` Map of sector and user ids → names. An event renders as `<p className="my-2 flex … text-xs text-muted"><Info/>{eventText(item, names)} · {timeOfDay(item.createdAt)}</p>`. A message renders as `<MessageBubble m onReply/>`.
- `web/src/components/conversation/model.ts`:
  - `export function eventText(e: ChatEventDto, names: Map<string, string>): string` is the exhaustive switch. Add the `bot_*` cases and read `e.data.botName`.
  - Also exports `previewText`, `errorMessage(e)`, `isConflict(e)` (an `ApiError` with 409), `timeOfDay` and `buildTimelineRows`.
- `MessageBubble({ m, onReply })` computes the label as `isNote ? 'Nota interna · '+author : direction==='out' ? (m.authorName ?? 'Celular ou sistema') : null`. The avatar is `<Avatar name={m.authorName} src={m.authorAvatarUrl} …/>`. Add a robot icon and the text `Chatbot <botName>` when `m.botName` is set.

### Web tests
- Vitest 5 runs with `environment: 'jsdom'` from `web/vite.config.ts`. Each test file also starts with `// @vitest-environment jsdom`. There are **no setupFiles**: call `cleanup()` and `vi.unstubAllGlobals()` in `afterEach`.
- `fetch` is stubbed per file:
```ts
vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), 'http://localhost'); const method = init?.method ?? 'GET';
  calls.push({ method, path: url.pathname, body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body });
  const key = `${method} ${url.pathname}`;
  if (!(key in routes)) return new Response(JSON.stringify({ error: 'inesperado' }), { status: 500 });
  return new Response(JSON.stringify(routes[key]), { status: 200, headers: { 'content-type': 'application/json' } });
}));
```
- Render inside `new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })` + `QueryClientProvider`. Seed the cache with `qc.setQueryData(['me'], me)` or `qk.timeline('c1')`, and wrap in `MemoryRouter`/`Routes` when routing matters (`Inbox.test.tsx`, `NewChatDialog.test.tsx`).
- `@testing-library/react` 16.3.3 provides `render`, `screen`, `fireEvent` and `waitFor`. There is no user-event.
- React Flow in jsdom needs `ResizeObserver` and `DOMMatrixReadOnly` stubs (`vi.stubGlobal`). Test the logic (`outputsOf`, validation, graph ↔ state) apart from the canvas.

## 5. Scripts and dependencies
- Root `package.json` has workspaces `shared`, `server` and `web`, plus these scripts:
  - `test`: `npm test --workspaces --if-present`
  - `typecheck`: `npm run typecheck --workspaces`
  - `build`: `npm run build -w web`
  - `dev`, `dev:up`, `dev:down` and `dev:admin`
- `server`: `test`=`vitest run`, `typecheck`=`tsc -p .`, `db:generate`=`drizzle-kit generate`, `dev`, `start`, `seed:admin`, `import:umbler`.
- `web`: `test`=`vitest run`, `typecheck`=`tsc --noEmit`, `build`=`tsc --noEmit && vite build`.
- `shared`: `typecheck` only.
- To run one test, use `npm test -w server -- test/bots/engine.test.ts` or `npm test -w web -- src/components/bot-editor`.
- **New web dependencies, pinned exactly.** Both were checked on npm on 2026-10-15 and both versions are at least 2 weeks old:
  ```
  npm install -w web --save-exact @xyflow/react@12.12.0 @dagrejs/dagre@3.1.1
  ```
  - @xyflow/react 12.12.0 was published 2026-09-24. Its peers are react and react-dom `>=17`. `13.0.0-next.0` is a prerelease; do not use it.
  - @dagrejs/dagre 3.1.1 was published 2026-08-08. It is ESM and ships its own types (`dist/types/index.d.ts`), so it needs no `@types`.
  - The command updates `web/package.json` and the root `package-lock.json`. Commit both.
- No new server dependency.

## 6. Global Constraints that still apply (from `docs/superpowers/plans/2026-10-14-nucleo-atendimento.md`)
- Node `>=24` (v24.13.1 locally). Docker image `node:24-alpine`.
- Exact dependency versions pinned with `--save-exact`. The current pins stay as listed in that plan: fastify 5.12.7, drizzle-orm 0.45.4, drizzle-kit 0.31.11, pglite 0.5.10, zod 4.6.7, vitest 5.0.4, typescript 5.9.3, react 19.3.1, react-router 8.4.0, tailwindcss 4.3.3, @phosphor-icons/react 2.1.10, @tanstack/react-query 5.104.2 and the rest. Add the two new web pins above.
- ESM everywhere, `strict: true`, and `.js` import extensions in server code.
- IDs come from `crypto.randomUUID()`. Timestamps are `timestamptz` in UTC.
- Phones are canonical 13 digits via `normalizePhoneBR` at every entry point. This matters for the bot's phone validator and its save-to-contact.
- UI copy is Brazilian Portuguese. Code identifiers are English.
- Never log message bodies, and never log contact answers such as CPF. Never commit `.env`, `screenshots/` or `data/`.
- Every module receives its dependencies through `AppCtx`, with no module-level singletons. A scheduler must take `ctx` and return a stop function. Its `tick(now)` must be callable from tests.
- Every chat, message, media or contact-history read or write **by a user** goes through `canSee` or `visibleChatsWhere`, and no access means 404. The bot acts as the system.
- Every mutating `/api/*` request and the `/ws` upgrade require `Origin === config.appOrigin`. Tests send `loginAs(...).headers`.
- No WhatsApp send inside a DB transaction. Publish after commit. This is spec §11.
- Commit after every task, with a Conventional message ending in `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
