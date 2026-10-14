# Núcleo de Atendimento — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the law office's own WhatsApp helpdesk (sub-project 1, "núcleo") so the office can switch off Umbler Talk for daily customer service.

**Architecture:** One Node/TypeScript service (`server/`, Fastify) exposes the REST API, a WebSocket hub and serves the compiled React SPA (`web/`). WhatsApp traffic goes through a separate Evolution API v2 container (QR-code connection) that calls our webhook and receives HTTP send requests. PostgreSQL holds two databases: `talk` (ours) and `evolution` (Evolution's). All business rules live in server modules; only `server/src/whatsapp/` knows Evolution's payload format.

**Tech Stack:** Node 24, npm workspaces, TypeScript, Fastify 5, Drizzle ORM + postgres.js (prod) / PGlite (tests), Zod 4, @node-rs/argon2, Vitest, React 19 + Vite + Tailwind 4 + TanStack Query + Phosphor Icons, Docker Compose, Caddy, Evolution API v2.3.7.

**Spec:** `docs/superpowers/specs/2026-10-14-nucleo-atendimento-design.md` (read it before any task; section numbers below — §N — refer to it).

## Global Constraints

- Node `>=24`; Docker image `node:24-alpine`.
- Exact dependency versions (pin with `--save-exact`): fastify 5.12.7, @fastify/websocket 11.3.4, @fastify/cookie 11.1.3, @fastify/multipart 10.1.3, @fastify/static 10.1.6, @fastify/rate-limit 11.2.1, drizzle-orm 0.45.4, drizzle-kit 0.31.11, postgres 3.4.9, @electric-sql/pglite 0.5.10, @node-rs/argon2 2.2.2, zod 4.6.7, vitest 5.0.4, typescript 5.9.3, tsx 4.23.15, @types/node 24.19.2, ws 8.22.0, react 19.3.1, react-dom 19.3.1, react-router 8.4.0, vite 8.3.4, @vitejs/plugin-react 6.1.2, tailwindcss 4.3.3, @tailwindcss/vite 4.3.3, @phosphor-icons/react 2.1.10, @tanstack/react-query 5.104.2, @testing-library/react 16.3.3, jsdom 30.1.2.
- Evolution image: `evoapicloud/evolution-api:v2.3.7` (never `latest`).
- ESM everywhere (`"type": "module"`), `strict: true`, imports use `.js` extension in server code.
- IDs: `crypto.randomUUID()`; timestamps `timestamptz` UTC.
- Phones: canonical 13-digit `55DDD9XXXXXXXX` via `normalizePhoneBR` (§4) at every entry point (webhook, importer, search, manual create).
- UI copy is Brazilian Portuguese; code identifiers are English.
- Never log message bodies. Never commit `.env`, `screenshots/`, `data/`.
- Every module receives dependencies through `AppCtx` (see contract) — no module-level singletons except the Fastify instance in `server/src/index.ts`.
- Authorization: every read/write of chats, messages, media and contact history goes through `canSee` / `visibleChatsWhere` (§6). No access → 404.
- All mutating `/api/*` requests and the `/ws` upgrade require `Origin === config.appOrigin` (§6).
- Commit after every task with a conventional message ending in `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Brazilian phone variants** — a 12-digit JID (`556599999999@s.whatsapp.net`) must reach the same contact imported as `5565999999999`; a landline `556532221111` must NOT gain a 9. Owned by Task 3 (unit) and Task 9 (integration).
2. **Duplicate/out-of-order webhooks** — the same `messages.upsert` delivered twice, or a `messages.update` (status) arriving for an `external_id` we have not stored yet, must not create duplicates or throw. Owned by Task 9.
3. **Phone-originated messages** — a message the office types on the physical phone (`fromMe=true`, not sent by us) must appear as `out` without turning on "Esperando", without unread and without triage. Owned by Task 9.
4. **Visibility leaks** — an agent of sector A must get 404 for a chat/message/media/contact-history item of sector B, and must receive `chat.removed` when a chat is transferred away. Owned by Task 7 (unit), Task 8 (WS), Task 13 (REST).
5. **Malicious media** — an `.html`/`.svg` sent by a contact must download as attachment with `application/octet-stream` and `CSP: sandbox`, never render inline. Owned by Task 10.

**Execution order:** 1, 2, 3, 4, 5, 6, 7, 8, 11, 9, 10, 12, 13 … 21 (Task 11 runs before Task 9, because ingest imports triage).

---

## File Structure

```
package.json                      # npm workspaces: shared, server, web
tsconfig.base.json
.env.example
docker-compose.yml  Caddyfile  Dockerfile
scripts/init-db.sql               # creates databases talk + evolution and evolution user
scripts/backup.sh                 # pg_dumpall to /data/backup (atomic rename)
README.md                         # install, update, backup/restore runbook, go-live checklist
shared/
  package.json  tsconfig.json
  src/index.ts                    # DTO + WS event types shared by server and web (types only)
server/
  package.json  tsconfig.json  vitest.config.ts  drizzle.config.ts
  drizzle/                        # generated SQL migrations (drizzle-kit generate)
  src/
    index.ts                      # production entry: loads config, db, gateway, hub, starts server
    app.ts                        # buildApp(ctx): registers plugins + all routes, returns Fastify
    config.ts                     # loadConfig(env) with zod
    ctx.ts                        # AppCtx type
    lib/http-error.ts             # HttpError + helpers notFound/forbidden/conflict/badRequest
    db/schema.ts                  # Drizzle schema (verbatim in Task 2)
    db/client.ts                  # Db type, createPgDb(url), createTestDb()
    db/migrate.ts                 # runMigrations(db)
    auth/password.ts  auth/sessions.ts  auth/plugin.ts  auth/routes.ts  auth/seed-admin.ts
    whatsapp/phone.ts  whatsapp/types.ts  whatsapp/parse.ts  whatsapp/evolution.ts  whatsapp/fake.ts
    inbox/visibility.ts  inbox/chats.ts  inbox/queries.ts  inbox/events.ts
    messages/ingest.ts  messages/send.ts  messages/media.ts  messages/signature.ts  messages/quick-answers.ts  messages/dto.ts
    triage/triage.ts
    realtime/hub.ts  realtime/routes.ts
    chats/routes.ts  contacts/routes.ts  contacts/service.ts
    catalog/sectors.ts  catalog/tags.ts  catalog/custom-fields.ts  catalog/users.ts  catalog/quick-answers.ts  catalog/settings.ts
    channels/service.ts  channels/routes.ts
    webhooks/routes.ts  media/routes.ts
    importer/umbler.ts  importer/cli.ts
  test/
    helpers.ts                    # makeTestCtx(), makeTestApp(), seed helpers, loginAs()
    fixtures/evolution/*.json     # webhook payloads (synthetic, no real data)
web/
  package.json  tsconfig.json  vite.config.ts  index.html
  src/
    main.tsx  App.tsx  index.css
    lib/api.ts  lib/ws.ts  lib/auth.tsx  lib/format.ts
    components/…                  # per feature, see web tasks
    pages/…
```

## Shared Contract (all tasks MUST use these exact names and types)

### `server/src/ctx.ts`
```ts
import type { Db } from './db/client.js';
import type { WhatsAppGateway } from './whatsapp/types.js';
import type { Hub } from './realtime/hub.js';
import type { Config } from './config.js';

export interface AppCtx {
  db: Db;
  wa: WhatsAppGateway;
  hub: Hub;
  config: Config;
}
```

### `server/src/config.ts`
```ts
export interface Config {
  port: number;                 // PORT, default 3000
  databaseUrl: string;          // DATABASE_URL
  appOrigin: string;            // APP_ORIGIN e.g. https://talk.jvo.adv.br
  cookieSecure: boolean;        // COOKIE_SECURE, default true
  webhookSecret: string;        // WEBHOOK_SECRET (>= 32 chars)
  webhookBaseUrl: string;       // WEBHOOK_BASE_URL, default http://app:3000
  mediaDir: string;             // MEDIA_DIR, default /data/media
  webDistDir: string | null;    // WEB_DIST_DIR, default ../web/dist resolved; null disables static
  evolution: { url: string; apiKey: string }; // EVOLUTION_URL, EVOLUTION_API_KEY
  sessionDays: number;          // 30
}
export function loadConfig(env: NodeJS.ProcessEnv): Config;
```

### `server/src/lib/http-error.ts`
```ts
export class HttpError extends Error { constructor(public status: number, message: string) }
export const badRequest = (m = 'Requisição inválida') => new HttpError(400, m);
export const forbidden  = (m = 'Sem permissão') => new HttpError(403, m);
export const notFound   = (m = 'Não encontrado') => new HttpError(404, m);
export const conflict   = (m = 'Conflito') => new HttpError(409, m);
```
`buildApp` installs an error handler: `HttpError` → `{ error: message }` with its status; zod errors → 400; anything else → 500 `{ error: 'Ocorreu um erro', correlationId }` (correlationId = request.id, logged with the error).

### `server/src/db/client.ts`
```ts
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema.js';
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
export function createPgDb(url: string): Db;           // drizzle-orm/postgres-js
export async function createTestDb(): Promise<Db>;      // drizzle-orm/pglite, in-memory, migrations applied
```
`Tx` = the transaction parameter type: `type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]`; functions that may run inside or outside a transaction take `db: Db | Tx`.

### `server/src/db/schema.ts` — written verbatim in Task 2
Tables and TS export names: `users`, `sessions`, `sectors`, `userSectors`, `channels`, `contacts`, `customFields`, `contactFieldValues`, `contactNotes`, `tags`, `contactTags`, `chats`, `chatPins`, `messages`, `chatEvents`, `quickAnswers`, `settings`. Columns are camelCase in TS and snake_case in SQL, exactly as listed in spec §4. Enums are `text` columns with TS union types (`$type<…>()`), not pg enums.

### `server/src/whatsapp/types.ts`
```ts
export type ChannelStatus = 'disconnected' | 'connecting' | 'connected';
export type MessageKind = 'text' | 'image' | 'audio' | 'video' | 'document' | 'sticker' | 'note' | 'unsupported';
export interface QuotedRef { externalId: string; body: string | null; fromMe: boolean }
export interface SendResult { externalId: string }
export interface OutgoingMedia { kind: 'image' | 'video' | 'document'; base64: string; mime: string; fileName: string; caption?: string }
export interface DownloadedMedia { base64: string; mime: string; fileName?: string }

export interface WhatsAppGateway {
  createInstance(instance: string, webhookUrl: string): Promise<void>;
  connect(instance: string): Promise<{ qrBase64: string | null }>;
  connectionState(instance: string): Promise<ChannelStatus>;
  sendText(instance: string, phone: string, text: string, quoted?: QuotedRef): Promise<SendResult>;
  sendMedia(instance: string, phone: string, media: OutgoingMedia, quoted?: QuotedRef): Promise<SendResult>;
  sendAudio(instance: string, phone: string, base64: string): Promise<SendResult>;
  downloadMedia(instance: string, rawMessage: unknown): Promise<DownloadedMedia>;
}

export type InboundEvent =
  | { type: 'message'; instance: string; externalId: string; direction: 'in' | 'out';
      phone: string | null; lid: string | null; pushName: string | null;
      kind: MessageKind; body: string | null; hasMedia: boolean;
      mediaMime: string | null; mediaName: string | null;
      replyToExternalId: string | null; sentAt: Date; raw: unknown }
  | { type: 'reaction'; instance: string; targetExternalId: string; emoji: string | null }
  | { type: 'status'; instance: string; externalId: string; status: 'sent' | 'delivered' | 'read' | 'failed' }
  | { type: 'connection'; instance: string; status: ChannelStatus }
  | { type: 'qrcode'; instance: string; qrBase64: string }
  | { type: 'ignored'; reason: string };
```
- `whatsapp/phone.ts`: `normalizePhoneBR(raw: string): string` (strips non-digits, adds 55 if 10–11 digits, inserts the 9 per §4) and `phoneFromJid(jid: string): string | null` (`…@s.whatsapp.net` → normalized phone; `@lid`/`@g.us`/other → null) and `lidFromJid(jid: string): string | null`.
- `whatsapp/parse.ts`: `parseEvolutionWebhook(body: unknown): InboundEvent[]`.
- `whatsapp/evolution.ts`: `createEvolutionGateway(cfg: { url: string; apiKey: string }, fetchImpl?: typeof fetch): WhatsAppGateway`.
- `whatsapp/fake.ts`: `createFakeGateway(): WhatsAppGateway & { sent: Array<{ method: string; instance: string; phone?: string; payload: unknown }>; failNext(err?: Error): void; status: Map<string, ChannelStatus> }` — `send*` return `{ externalId: 'fake-' + n }`; `downloadMedia` returns a 1×1 PNG base64 with mime `image/png`.

### `server/src/inbox/visibility.ts`
```ts
export interface AuthUser { id: string; name: string; email: string; role: 'admin' | 'agent'; signature: string | null; sectorIds: string[] }
export interface ChatVisibilityFields { sectorId: string; ownerId: string | null; private: boolean }
export function canSee(user: AuthUser, chat: ChatVisibilityFields): boolean;
export function visibleChatsWhere(user: AuthUser): SQL | undefined; // drizzle SQL over `chats`; undefined for admin
export async function loadAuthUser(db: Db | Tx, userId: string): Promise<AuthUser | null>;
```
Rule: admin → true; private → owner only; else sector ∈ user.sectorIds OR owner = user.

### `server/src/inbox/events.ts`
```ts
export type ChatEventKind = 'created' | 'assigned' | 'transferred' | 'closed' | 'reopened' | 'privacy_changed' | 'triage_routed';
export async function addEvent(db: Db | Tx, chatId: string, kind: ChatEventKind, data: Record<string, unknown>, authorId: string | null): Promise<void>;
```

### `server/src/inbox/chats.ts`
```ts
export type ChatRow = typeof chats.$inferSelect;
export async function findOrOpenChat(db: Db | Tx, args: { contactId: string; channelId: string;
  init: { sectorId: string; ownerId: string | null; waiting: boolean; triagePending: boolean; createdBy: string | null } }): Promise<{ chat: ChatRow; created: boolean }>;
export async function getDefaultSectorId(db: Db | Tx): Promise<string>;
export async function getChatForUser(ctx: AppCtx, user: AuthUser, chatId: string): Promise<ChatRow>; // 404 if missing or !canSee
export async function assumeChat(ctx: AppCtx, user: AuthUser, chatId: string): Promise<ChatRow>;
export async function transferChat(ctx: AppCtx, user: AuthUser, chatId: string, to: { sectorId?: string; ownerId?: string | null }): Promise<ChatRow>;
export async function setChatPrivacy(ctx: AppCtx, user: AuthUser, chatId: string, isPrivate: boolean): Promise<ChatRow>;
export async function closeChat(ctx: AppCtx, user: AuthUser, chatId: string, opts: { sendClosingMessage: boolean }): Promise<ChatRow>;
export async function reopenChat(ctx: AppCtx, user: AuthUser, chatId: string): Promise<ChatRow>;
export async function markChatRead(ctx: AppCtx, user: AuthUser, chatId: string): Promise<void>;
export async function pinChat(ctx: AppCtx, user: AuthUser, chatId: string, pinned: boolean): Promise<void>; // max 3 → 409
export async function startChat(ctx: AppCtx, user: AuthUser, input: { contactId?: string; phone?: string; name?: string; sectorId?: string }): Promise<ChatRow>;
```
Every mutating function: checks `canSee` (404), uses `UPDATE … WHERE id = ? AND <expected state>` (0 rows → 409), calls `addEvent`, then `ctx.hub.publishChat(chatId)`. `closeChat` with `sendClosingMessage` sends `settings.closing_message` through `sendAgentMessage` (Task 10) before closing.

### `server/src/inbox/queries.ts`
```ts
export async function listChats(ctx: AppCtx, user: AuthUser, f: ChatListFilters): Promise<{ items: ChatListItem[]; nextCursor: string | null }>;
export async function getChatDetail(ctx: AppCtx, user: AuthUser, chatId: string): Promise<ChatDetail>;
export async function getTimeline(ctx: AppCtx, user: AuthUser, chatId: string, q: { before?: string; limit?: number }): Promise<TimelineItem[]>; // newest page, ascending order
export async function toChatListItem(db: Db | Tx, chat: ChatRow, userId: string): Promise<ChatListItem>;
```

### `server/src/messages/*`
```ts
// ingest.ts
export async function handleInbound(ctx: AppCtx, events: InboundEvent[]): Promise<void>;
// send.ts
export interface SendInput { text?: string; file?: { buffer: Buffer; mime: string; name: string }; asVoice?: boolean; signature: boolean; replyToId?: string }
export async function sendAgentMessage(ctx: AppCtx, user: AuthUser, chatId: string, input: SendInput): Promise<MessageDto>;
export async function resendMessage(ctx: AppCtx, user: AuthUser, messageId: string): Promise<MessageDto>;
export async function addNote(ctx: AppCtx, user: AuthUser, chatId: string, text: string): Promise<MessageDto>;
// media.ts
export async function saveMedia(mediaDir: string, data: Buffer, mime: string, originalName?: string | null): Promise<{ path: string; size: number }>; // path relative to mediaDir
export function mediaResponseHeaders(mime: string, fileName: string): Record<string, string>;
// signature.ts
export function formatSignature(text: string, signatureLabel: string): string; // `*${label}:*\n${text}`
export function signatureLabel(user: AuthUser, sectorName: string): string;    // user.signature?.trim() || `${sectorName} - ${user.name}`
// quick-answers.ts
export interface QuickAnswerVars { atendente: { nome: string; primeiro_nome: string; email: string }; contato: { nome: string; primeiro_nome: string; telefone: string; email: string }; campo: Record<string, string> }
export function renderQuickAnswer(body: string, vars: QuickAnswerVars): string;
export function convertUmblerVariables(body: string, variables: Array<{ defaultValue: string }>): { body: string; unmapped: string[] };
// dto.ts
export async function toMessageDto(db: Db | Tx, row: typeof messages.$inferSelect): Promise<MessageDto>;
```

### `server/src/triage/triage.ts`
```ts
export interface TriageOption { key: string; label: string; sectorId: string }
export interface TriageMenu { enabled: boolean; welcomeText: string; invalidText: string; options: TriageOption[] }
export async function getTriageMenu(db: Db | Tx): Promise<TriageMenu>;
export function matchTriageOption(text: string, menu: TriageMenu, sectorNames: Map<string, string>): TriageOption | null;
export async function startTriage(ctx: AppCtx, chat: ChatRow): Promise<void>;          // after a chat is created by an `in` message
export async function handleTriageReply(ctx: AppCtx, chat: ChatRow, text: string | null): Promise<boolean>; // true if consumed
```

### `server/src/realtime/hub.ts`
```ts
export interface Hub {
  register(user: AuthUser, socket: { send(data: string): void; close(): void }): () => void; // returns unregister
  disconnectUser(userId: string): void;
  publishChat(chatId: string): Promise<void>;                       // chat.updated / chat.removed per §5.5
  publishMessage(chatId: string, type: 'message.created' | 'message.updated', messageId: string): Promise<void>;
  publishChannel(channelId: string): Promise<void>;                 // channel.status to everyone
}
export function createHub(getDb: () => Db): Hub;
export function createRecordingHub(): Hub & { events: Array<{ type: string; chatId?: string; messageId?: string; channelId?: string }> }; // tests
```
Note: `createHub` takes `getDb` because `AppCtx` is built after the hub; services always call `ctx.hub.*` after their transaction commits.

### `server/src/channels/service.ts`
```ts
export async function createChannel(ctx: AppCtx, name: string): Promise<ChannelDto>;
export async function connectChannel(ctx: AppCtx, channelId: string): Promise<{ qrBase64: string | null }>;
export async function syncChannelStatuses(ctx: AppCtx): Promise<void>; // on startup
export async function setChannelStatus(ctx: AppCtx, instance: string, status: ChannelStatus): Promise<void>;
export async function getChannelByInstance(db: Db | Tx, instance: string): Promise<typeof channels.$inferSelect | null>;
```
Instance naming: `talk-` + first 8 chars of the channel id.

### `shared/src/index.ts` (DTOs; types only)
```ts
export type Role = 'admin' | 'agent';
export interface Me { id: string; name: string; email: string; role: Role; signature: string | null; sectorIds: string[] }
export interface SectorDto { id: string; name: string; position: number; isDefault: boolean }
export interface TagDto { id: string; name: string; emoji: string | null; color: string; position: number }
export interface UserDto { id: string; name: string; email: string; role: Role; signature: string | null; active: boolean; sectorIds: string[] }
export interface ChannelDto { id: string; name: string; status: 'disconnected' | 'connecting' | 'connected'; phone: string | null }
export interface ContactRef { id: string; name: string | null; phone: string | null }
export type ChatTab = 'inbox' | 'waiting' | 'closed';
export interface ChatListFilters { tab: ChatTab; q?: string; sectorId?: string; ownerId?: string; tagId?: string; from?: string; to?: string; cursor?: string; limit?: number }
export interface ChatListItem { id: string; contact: ContactRef; channelId: string; sectorId: string; ownerId: string | null; state: 'open' | 'closed'; waiting: boolean; private: boolean; unread: number; lastMessageAt: string | null; lastMessagePreview: string | null; pinned: boolean; tagIds: string[] }
export interface ChatDetail extends ChatListItem { triagePending: boolean; createdAt: string; closedAt: string | null }
export interface MediaDto { url: string; mime: string; name: string | null; size: number | null }
export interface MessageDto { id: string; chatId: string; direction: 'in' | 'out'; kind: 'text' | 'image' | 'audio' | 'video' | 'document' | 'sticker' | 'note' | 'unsupported'; body: string | null; media: MediaDto | null; mediaUnavailable: boolean; authorId: string | null; authorName: string | null; replyTo: { id: string; body: string | null; kind: string } | null; reaction: string | null; status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed'; error: string | null; sentAt: string }
export interface ChatEventDto { id: string; chatId: string; kind: 'created' | 'assigned' | 'transferred' | 'closed' | 'reopened' | 'privacy_changed' | 'triage_routed'; data: Record<string, unknown>; authorName: string | null; createdAt: string }
export type TimelineItem = ({ type: 'message' } & MessageDto) | ({ type: 'event' } & ChatEventDto);
export interface ContactDto { id: string; name: string | null; phone: string | null; lid: string | null; email: string | null; landline: string | null; address: Record<string, string> | null; blocked: boolean; tagIds: string[]; fields: Record<string, string>; createdAt: string }
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
  | { type: 'channel.status'; channel: ChannelDto };
```

### REST API (all JSON; errors `{ error: string }`)
| Method & path | Body / query | Returns | Auth |
|---|---|---|---|
| POST `/api/auth/login` | `{email,password}` | `Me` (sets cookie `sid`) | public, rate-limited 5/min |
| POST `/api/auth/logout` | — | 204 | user |
| GET `/api/auth/me` | — | `Me` | user |
| GET `/api/chats` | `ChatListFilters` as query | `{items: ChatListItem[], nextCursor}` | user |
| POST `/api/chats` | `{contactId?, phone?, name?, sectorId?}` | `ChatDetail` | user |
| GET `/api/chats/:id` | — | `ChatDetail` | user |
| GET `/api/chats/:id/timeline` | `?before&limit` | `TimelineItem[]` | user |
| POST `/api/chats/:id/assume` · `/reopen` · `/read` | — | `ChatDetail` (read → 204) | user |
| POST `/api/chats/:id/transfer` | `{sectorId?, ownerId?}` | `ChatDetail` | user |
| POST `/api/chats/:id/privacy` | `{private: boolean}` | `ChatDetail` | user |
| POST `/api/chats/:id/close` | `{sendClosingMessage: boolean}` | `ChatDetail` | user |
| PUT / DELETE `/api/chats/:id/pin` | — | 204 | user |
| POST `/api/chats/:id/messages` | JSON `{text, signature, replyToId?}` or multipart (`file`, `text?`, `signature`, `replyToId?`, `asVoice?`) | `MessageDto` | user |
| POST `/api/chats/:id/notes` | `{text}` | `MessageDto` | user |
| POST `/api/messages/:id/resend` | — | `MessageDto` | user |
| GET `/api/media/:messageId` | — | file stream | user + canSee |
| GET `/api/contacts` | `?q&tagId&cursor&limit` | `{items: ContactDto[], nextCursor}` | user |
| POST `/api/contacts` · GET/PATCH `/api/contacts/:id` | contact fields | `ContactDto` | user |
| POST `/api/contacts/:id/block` | `{blocked}` | `ContactDto` | user |
| PUT `/api/contacts/:id/tags` | `{tagIds}` | `ContactDto` | user |
| PUT `/api/contacts/:id/fields` | `{[fieldId]: value}` | `ContactDto` | user |
| GET `/api/contacts/:id/chats` | — | `ChatListItem[]` (visible only) | user |
| GET/POST `/api/contacts/:id/notes`, PATCH/DELETE `/api/contacts/:id/notes/:noteId` | `{body}` / `{pinned}` | `ContactNoteDto[]` / `ContactNoteDto` | user |
| GET `/api/sectors` `/api/tags` `/api/custom-fields` `/api/users` `/api/channels` | — | lists of DTOs | user |
| POST/PATCH/DELETE on sectors, tags, custom-fields, users | DTO fields (+`password` for users) | DTO | admin |
| GET `/api/quick-answers` | — | `QuickAnswerDto[]` (all + own) | user |
| POST/PATCH/DELETE `/api/quick-answers[/:id]` | multipart or JSON | `QuickAnswerDto` | user (own) / admin (visibility all) |
| POST `/api/quick-answers/:id/render` | `{chatId}` | `{text: string}` | user |
| GET `/api/quick-answers/:id/attachment` | — | file | user |
| GET/PUT `/api/settings` | `SettingsDto` | `SettingsDto` | GET user, PUT admin |
| POST `/api/channels` | `{name}` | `ChannelDto` | admin |
| POST `/api/channels/:id/connect` | — | `{qrBase64}` | admin |
| POST `/webhooks/evolution/:secret` | Evolution payload | 200 | secret |
| GET `/ws` (upgrade) | — | `WsEvent` stream | user + Origin |

### Test helpers `server/test/helpers.ts` (Task 2 creates the db part; Task 6 adds auth helpers)
```ts
export async function makeTestCtx(): Promise<AppCtx & { wa: ReturnType<typeof createFakeGateway>; hub: ReturnType<typeof createRecordingHub> }>;
export async function seedBasics(ctx: AppCtx): Promise<{ admin: AuthUser; agentA: AuthUser; agentB: AuthUser; sectorA: string; sectorB: string; defaultSector: string; channelId: string; instance: string }>;
// defaultSector = 'Atendimento' (is_default), sectorA = 'Financeiro', sectorB = 'Jurídico'; agentA ∈ sectorA, agentB ∈ sectorB; channel instance 'talk-test'
export async function makeTestApp(ctx?: AppCtx): Promise<{ app: FastifyInstance; ctx: AppCtx }>;
export async function loginAs(app: FastifyInstance, email: string, password?: string): Promise<{ cookie: string; headers: Record<string, string> }>; // headers include cookie + origin
export const TEST_PASSWORD = 'senha-teste-123';
export const TEST_ORIGIN = 'http://localhost:5173';
```


---

### Task 1: Monorepo scaffold and health endpoint

**Files:**
- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `scripts/dev.mjs`
- Create: `shared/package.json`, `shared/tsconfig.json`, `shared/src/index.ts`
- Create: `server/package.json`, `server/tsconfig.json`, `server/vitest.config.ts`
- Create: `server/src/config.ts`, `server/src/lib/http-error.ts`, `server/src/ctx.ts`, `server/src/app.ts`
- Create: `web/package.json`, `web/tsconfig.json`, `web/vite.config.ts`, `web/index.html`, `web/src/main.tsx`, `web/src/App.tsx`, `web/src/index.css`
- Test: `server/test/config.test.ts`, `server/test/app.test.ts`
- Generated: `package-lock.json` (by `npm install`)
- `.gitignore` is unchanged: it already ignores `node_modules/`, `dist/`, `.env`, `data/`, `screenshots/`.

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `loadConfig(env: NodeJS.ProcessEnv): Config` in `server/src/config.ts`, with `Config` exactly as in the Shared Contract. Required env vars: `DATABASE_URL`, `APP_ORIGIN`, `WEBHOOK_SECRET` (at least 32 chars), `EVOLUTION_URL`, `EVOLUTION_API_KEY`. Defaults: `port` 3000, `cookieSecure` true, `webhookBaseUrl` `http://app:3000`, `mediaDir` `/data/media`, `webDistDir` = absolute `<repo>/web/dist`, `sessionDays` 30. Normalization: `appOrigin` is reduced to `scheme://host[:port]` (`new URL(v).origin`, so it is directly comparable with the `Origin` header). `evolution.url` and `webhookBaseUrl` have no trailing slash. `WEB_DIST_DIR=""` gives `webDistDir: null`. Invalid env throws `Error('Configuração inválida:\n…')`, which names the variable but never its value.
  - `server/src/lib/http-error.ts`: `class HttpError extends Error { constructor(public status: number, message: string) }`, `badRequest`, `forbidden`, `notFound`, `conflict` (default messages as in the contract).
  - `server/src/ctx.ts`: `interface AppCtx { config: Config }`. **Task 2 adds `db: Db`, Task 4 adds `wa: WhatsAppGateway`, Task 8 adds `hub: Hub`**, each in its own task, until it matches the contract.
  - `server/src/app.ts`: `type BuildAppOptions = Pick<FastifyServerOptions, 'logger' | 'trustProxy'>` and `buildApp(ctx: AppCtx, opts?: BuildAppOptions): Promise<FastifyInstance>`. Both options default to `false`. The returned instance is not yet `ready()`, so tests may add routes before `inject`. It registers `@fastify/cookie` with no secret, the error handler and `GET /api/health → { ok: true }`. Later tasks add their routes inside `buildApp`.
  - Error handler order:
    1. `HttpError` → its `status` with `{ error: message }`.
    2. `z.ZodError` → 400 with `{ error: 'Requisição inválida' }`.
    3. Fastify's own 4xx errors (`statusCode` 400–499: malformed JSON, body too large, rate limit) → that status with `{ error: err.message }`.
    4. Anything else → logged with `correlationId = req.id`, then 500 with `{ error: 'Ocorreu um erro', correlationId }`.
  - `@talk/shared` workspace package: all DTO types from the contract. It has no build and no runtime code. Consumers write `import type { … } from '@talk/shared'`, which `verbatimModuleSyntax` enforces.
  - Commands (from the repo root):
    - `npm test -w server -- <file>` runs one server test file.
    - `npm test -w web -- <file>` runs one web test file (Vitest, jsdom, files `web/src/**/*.test.{ts,tsx}`).
    - `npm test` runs all tests.
    - `npm run typecheck` checks shared, server and web.
    - `npm run build` builds `web/dist`.
    - `npm run dev` starts the server (`tsx watch`, port 3000, reads `../.env`) and Vite (port 5173), which proxies `/api` and `/ws` to port 3000.
  - The server is **not compiled**: production runs `npm run start -w server` = `node --import tsx src/index.ts`, so `tsx` is a runtime dependency. Task 21's Dockerfile uses this. `server/src/index.ts` itself is created by a later task.
  - **Every pinned dependency from Global Constraints is installed in this task.** Later tasks must not run `npm install` for them.

- [ ] **Step 1: Create the root workspace files**

`package.json`:
```json
{
  "name": "talk",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "workspaces": ["shared", "server", "web"],
  "scripts": {
    "dev": "node scripts/dev.mjs",
    "build": "npm run build -w web",
    "test": "npm test --workspaces --if-present",
    "typecheck": "npm run typecheck --workspaces"
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  }
}
```

`scripts/dev.mjs`:
```js
// Starts the API (tsx watch, port 3000) and the Vite dev server (port 5173) together. Ctrl+C stops both.
import { spawn } from 'node:child_process';

for (const ws of ['server', 'web']) {
  spawn('npm', ['run', 'dev', '-w', ws], { stdio: 'inherit', shell: true });
}
```

- [ ] **Step 2: Create the `shared` package with every DTO from the contract**

`shared/package.json`:
```json
{
  "name": "@talk/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "types": "./src/index.ts",
  "exports": {
    ".": { "types": "./src/index.ts" }
  },
  "scripts": {
    "typecheck": "tsc -p ."
  }
}
```

`shared/tsconfig.json`:
```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext"
  },
  "include": ["src"]
}
```

`shared/src/index.ts`:
```ts
// DTOs and WebSocket event types shared by server and web. Types only: never put runtime code here
// (the package has no build step; consumers must use `import type`).

export type Role = 'admin' | 'agent';
export interface Me { id: string; name: string; email: string; role: Role; signature: string | null; sectorIds: string[] }
export interface SectorDto { id: string; name: string; position: number; isDefault: boolean }
export interface TagDto { id: string; name: string; emoji: string | null; color: string; position: number }
export interface UserDto { id: string; name: string; email: string; role: Role; signature: string | null; active: boolean; sectorIds: string[] }
export interface ChannelDto { id: string; name: string; status: 'disconnected' | 'connecting' | 'connected'; phone: string | null }
export interface ContactRef { id: string; name: string | null; phone: string | null }
export type ChatTab = 'inbox' | 'waiting' | 'closed';
export interface ChatListFilters { tab: ChatTab; q?: string; sectorId?: string; ownerId?: string; tagId?: string; from?: string; to?: string; cursor?: string; limit?: number }
export interface ChatListItem { id: string; contact: ContactRef; channelId: string; sectorId: string; ownerId: string | null; state: 'open' | 'closed'; waiting: boolean; private: boolean; unread: number; lastMessageAt: string | null; lastMessagePreview: string | null; pinned: boolean; tagIds: string[] }
export interface ChatDetail extends ChatListItem { triagePending: boolean; createdAt: string; closedAt: string | null }
export interface MediaDto { url: string; mime: string; name: string | null; size: number | null }
export interface MessageDto { id: string; chatId: string; direction: 'in' | 'out'; kind: 'text' | 'image' | 'audio' | 'video' | 'document' | 'sticker' | 'note' | 'unsupported'; body: string | null; media: MediaDto | null; mediaUnavailable: boolean; authorId: string | null; authorName: string | null; replyTo: { id: string; body: string | null; kind: string } | null; reaction: string | null; status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed'; error: string | null; sentAt: string }
export interface ChatEventDto { id: string; chatId: string; kind: 'created' | 'assigned' | 'transferred' | 'closed' | 'reopened' | 'privacy_changed' | 'triage_routed'; data: Record<string, unknown>; authorName: string | null; createdAt: string }
export type TimelineItem = ({ type: 'message' } & MessageDto) | ({ type: 'event' } & ChatEventDto);
export interface ContactDto { id: string; name: string | null; phone: string | null; lid: string | null; email: string | null; landline: string | null; address: Record<string, string> | null; blocked: boolean; tagIds: string[]; fields: Record<string, string>; createdAt: string }
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
  | { type: 'channel.status'; channel: ChannelDto };
```

- [ ] **Step 3: Create the `server` and `web` package manifests and configs**

`server/package.json` (`npm install` in Step 4 adds `dependencies`/`devDependencies`):
```json
{
  "name": "@talk/server",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch --env-file=../.env src/index.ts",
    "start": "node --import tsx src/index.ts",
    "test": "vitest run",
    "typecheck": "tsc -p ."
  },
  "dependencies": {
    "@talk/shared": "*"
  }
}
```

`server/tsconfig.json`:
```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "types": ["node"]
  },
  "include": ["src", "test", "*.ts"]
}
```

`server/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
```

`web/package.json`:
```json
{
  "name": "@talk/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "test": "vitest run --passWithNoTests",
    "typecheck": "tsc -p ."
  },
  "dependencies": {
    "@talk/shared": "*"
  }
}
```

- [ ] **Step 4: Install every pinned dependency (exact versions)**

Run from the repo root, in this order:
```bash
npm install --save-exact -w server fastify@5.12.7 @fastify/cookie@11.1.3 @fastify/websocket@11.3.4 @fastify/multipart@10.1.3 @fastify/static@10.1.6 @fastify/rate-limit@11.2.1 drizzle-orm@0.45.4 postgres@3.4.9 @electric-sql/pglite@0.5.10 @node-rs/argon2@2.2.2 zod@4.6.7 tsx@4.23.15
npm install --save-exact --save-dev -w server drizzle-kit@0.31.11 vitest@5.0.4 typescript@5.9.3 @types/node@24.19.2 ws@8.22.0
npm install --save-exact -w web react@19.3.1 react-dom@19.3.1 react-router@8.4.0 @tanstack/react-query@5.104.2 @phosphor-icons/react@2.1.10
npm install --save-exact --save-dev -w web vite@8.3.4 @vitejs/plugin-react@6.1.2 tailwindcss@4.3.3 @tailwindcss/vite@4.3.3 typescript@5.9.3 vitest@5.0.4 jsdom@30.1.2 @testing-library/react@16.3.3 @testing-library/dom@10.4.2 @types/react@19.3.0 @types/react-dom@19.3.0
npm install --save-exact --save-dev -w shared typescript@5.9.3
```
Expected: each command ends with `found 0 vulnerabilities` or an audit note. drizzle-kit's transitive esbuild may print an audit note; it is dev-only, so ignore it. `server/package.json` and `web/package.json` now list every version without `^`.

The contract does not pin `@types/react`, `@types/react-dom` or `@testing-library/dom` (a required peer of `@testing-library/react` 16). The versions used are the current ones on 2026-10-14.

Verify the shared types compile:
Run: `npm run typecheck -w shared`
Expected: exits 0 with no output from `tsc`.

- [ ] **Step 5: Write the failing config test**

`server/test/config.test.ts`:
```ts
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = {
  DATABASE_URL: 'postgres://talk:talk@localhost:5432/talk',
  APP_ORIGIN: 'http://localhost:5173',
  WEBHOOK_SECRET: 'x'.repeat(32),
  EVOLUTION_URL: 'http://evolution:8080',
  EVOLUTION_API_KEY: 'evo-key',
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig(base);
    expect(c.port).toBe(3000);
    expect(c.databaseUrl).toBe(base.DATABASE_URL);
    expect(c.appOrigin).toBe('http://localhost:5173');
    expect(c.cookieSecure).toBe(true);
    expect(c.webhookSecret).toBe(base.WEBHOOK_SECRET);
    expect(c.webhookBaseUrl).toBe('http://app:3000');
    expect(c.mediaDir).toBe('/data/media');
    expect(c.webDistDir).toBe(path.resolve(import.meta.dirname, '../../web/dist'));
    expect(c.evolution).toEqual({ url: 'http://evolution:8080', apiKey: 'evo-key' });
    expect(c.sessionDays).toBe(30);
  });

  it('parses overrides and normalizes URLs', () => {
    const c = loadConfig({
      ...base,
      PORT: '8080',
      COOKIE_SECURE: 'false',
      APP_ORIGIN: 'https://talk.jvo.adv.br/',
      WEBHOOK_BASE_URL: 'http://app:3000/',
      EVOLUTION_URL: 'http://evolution:8080/',
      MEDIA_DIR: '/tmp/media',
      WEB_DIST_DIR: '',
    });
    expect(c.port).toBe(8080);
    expect(c.cookieSecure).toBe(false);
    expect(c.appOrigin).toBe('https://talk.jvo.adv.br');
    expect(c.webhookBaseUrl).toBe('http://app:3000');
    expect(c.evolution.url).toBe('http://evolution:8080');
    expect(c.mediaDir).toBe('/tmp/media');
    expect(c.webDistDir).toBeNull();
  });

  it('rejects a short webhook secret', () => {
    expect(() => loadConfig({ ...base, WEBHOOK_SECRET: 'curto' })).toThrow(/WEBHOOK_SECRET/);
  });

  it('rejects missing required variables', () => {
    const { DATABASE_URL: _omit, ...rest } = base;
    expect(() => loadConfig(rest)).toThrow(/DATABASE_URL/);
  });

  it('rejects an APP_ORIGIN that is not a URL', () => {
    expect(() => loadConfig({ ...base, APP_ORIGIN: 'talk.jvo.adv.br' })).toThrow(/APP_ORIGIN/);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npm test -w server -- test/config.test.ts`
Expected: FAIL. Vitest reports `Failed to load url ../src/config.js … Does the file exist?`, because `server/src/config.ts` has not been created yet.

- [ ] **Step 7: Implement `loadConfig`**

`server/src/config.ts`:
```ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export interface Config {
  port: number;
  databaseUrl: string;
  appOrigin: string;
  cookieSecure: boolean;
  webhookSecret: string;
  webhookBaseUrl: string;
  mediaDir: string;
  webDistDir: string | null;
  evolution: { url: string; apiKey: string };
  sessionDays: number;
}

const baseUrl = z.url().transform((u) => u.replace(/\/+$/, ''));

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  // Compared byte-for-byte with the browser's Origin header, so keep only scheme://host[:port].
  APP_ORIGIN: z.url().transform((u) => new URL(u).origin),
  COOKIE_SECURE: z.stringbool().default(true),
  WEBHOOK_SECRET: z.string().min(32),
  WEBHOOK_BASE_URL: baseUrl.default('http://app:3000'),
  MEDIA_DIR: z.string().min(1).default('/data/media'),
  WEB_DIST_DIR: z.string().optional(),
  EVOLUTION_URL: baseUrl,
  EVOLUTION_API_KEY: z.string().min(1),
});

const defaultWebDist = fileURLToPath(new URL('../../web/dist', import.meta.url));

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = envSchema.safeParse(env);
  // prettifyError lists paths and messages only, never the (secret) values.
  if (!parsed.success) throw new Error(`Configuração inválida:\n${z.prettifyError(parsed.error)}`);
  const e = parsed.data;
  return {
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    appOrigin: e.APP_ORIGIN,
    cookieSecure: e.COOKIE_SECURE,
    webhookSecret: e.WEBHOOK_SECRET,
    webhookBaseUrl: e.WEBHOOK_BASE_URL,
    mediaDir: e.MEDIA_DIR,
    webDistDir: e.WEB_DIST_DIR === undefined ? defaultWebDist : e.WEB_DIST_DIR === '' ? null : path.resolve(e.WEB_DIST_DIR),
    evolution: { url: e.EVOLUTION_URL, apiKey: e.EVOLUTION_API_KEY },
    sessionDays: 30,
  };
}
```

- [ ] **Step 8: Run it to verify it passes**

Run: `npm test -w server -- test/config.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 9: Write the failing app test (health + error handler)**

`server/test/app.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { AppCtx } from '../src/ctx.js';
import { notFound } from '../src/lib/http-error.js';

// Task 1 stub: AppCtx only has `config` until Tasks 2/4/8 add db, wa and hub.
const ctx: AppCtx = {
  config: loadConfig({
    DATABASE_URL: 'postgres://unused',
    APP_ORIGIN: 'http://localhost:5173',
    WEBHOOK_SECRET: 'x'.repeat(32),
    EVOLUTION_URL: 'http://evolution:8080',
    EVOLUTION_API_KEY: 'evo-key',
  }),
};

let app: FastifyInstance;
afterEach(async () => {
  await app.close();
});

describe('buildApp', () => {
  it('GET /api/health returns ok', async () => {
    app = await buildApp(ctx);
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('maps HttpError to its status and message', async () => {
    app = await buildApp(ctx);
    app.get('/t/http', async () => {
      throw notFound();
    });
    const res = await app.inject({ method: 'GET', url: '/t/http' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Não encontrado' });
  });

  it('maps zod errors to 400', async () => {
    app = await buildApp(ctx);
    app.get('/t/zod', async () => z.object({ a: z.string() }).parse({}));
    const res = await app.inject({ method: 'GET', url: '/t/zod' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Requisição inválida' });
  });

  it('keeps Fastify 4xx errors (malformed JSON body) as 4xx', async () => {
    app = await buildApp(ctx);
    app.post('/t/echo', async (req) => req.body);
    const res = await app.inject({
      method: 'POST',
      url: '/t/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(res.statusCode).toBe(400);
    expect(typeof res.json().error).toBe('string');
  });

  it('hides unexpected errors behind a correlation id', async () => {
    app = await buildApp(ctx);
    app.get('/t/boom', async () => {
      throw new Error('segredo interno');
    });
    const res = await app.inject({ method: 'GET', url: '/t/boom' });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.error).toBe('Ocorreu um erro');
    expect(typeof body.correlationId).toBe('string');
    expect(res.body).not.toContain('segredo');
  });
});
```

- [ ] **Step 10: Run it to verify it fails**

Run: `npm test -w server -- test/app.test.ts`
Expected: FAIL. Vitest reports `Failed to load url ../src/app.js … Does the file exist?`.

- [ ] **Step 11: Implement `HttpError`, `AppCtx` and `buildApp`**

`server/src/lib/http-error.ts`:
```ts
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (m = 'Requisição inválida') => new HttpError(400, m);
export const forbidden = (m = 'Sem permissão') => new HttpError(403, m);
export const notFound = (m = 'Não encontrado') => new HttpError(404, m);
export const conflict = (m = 'Conflito') => new HttpError(409, m);
```

`server/src/ctx.ts`:
```ts
import type { Config } from './config.js';

// Grows with the plan: Task 2 adds `db: Db`, Task 4 adds `wa: WhatsAppGateway`, Task 8 adds `hub: Hub`
// (final shape in the plan's Shared Contract).
export interface AppCtx {
  config: Config;
}
```

`server/src/app.ts`:
```ts
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cookie from '@fastify/cookie';
import { z } from 'zod';
import type { AppCtx } from './ctx.js';
import { HttpError } from './lib/http-error.js';

export type BuildAppOptions = Pick<FastifyServerOptions, 'logger' | 'trustProxy'>;

export async function buildApp(ctx: AppCtx, opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: opts.trustProxy ?? false });

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    if (err instanceof z.ZodError) return reply.status(400).send({ error: 'Requisição inválida' });
    // Fastify's own client errors (malformed JSON, body too large, rate limit, ...)
    const status = (err as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return reply.status(status).send({ error: err instanceof Error ? err.message : 'Requisição inválida' });
    }
    req.log.error({ err, correlationId: req.id }, 'unhandled error');
    return reply.status(500).send({ error: 'Ocorreu um erro', correlationId: req.id });
  });

  await app.register(cookie);

  app.get('/api/health', async () => ({ ok: true }));
  // Later tasks register their routes here, passing `ctx`.

  return app;
}
```

- [ ] **Step 12: Run it to verify it passes**

Run: `npm test -w server -- test/app.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 13: Create the minimal web app**

`web/tsconfig.json`:
```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "types": ["vite/client"]
  },
  "include": ["src"]
}
```

`web/vite.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // The browser keeps Origin = http://localhost:5173, which must equal APP_ORIGIN in the dev .env.
    proxy: {
      '/api': 'http://localhost:3000',
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
```

`web/index.html`:
```html
<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Talk</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`web/src/main.tsx`:
```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

`web/src/App.tsx`:
```tsx
export function App() {
  return (
    <main className="flex h-screen items-center justify-center bg-slate-50">
      <h1 className="text-2xl font-semibold text-slate-800">Talk</h1>
    </main>
  );
}
```

`web/src/index.css`:
```css
@import "tailwindcss";
```

- [ ] **Step 14: Verify the whole workspace**

Run: `npm test`
Expected: server `Test Files 2 passed (2)`, `Tests 10 passed (10)`. For web, `No test files found, exiting with code 0`.

Run: `npm run typecheck`
Expected: `tsc -p .` exits 0 for `@talk/shared`, `@talk/server` and `@talk/web`.

Run: `npm run build`
Expected: Vite prints `✓ built in …` and writes `web/dist/index.html` plus `web/dist/assets/index-*.css` and `index-*.js`. `web/dist/` is ignored by git.

- [ ] **Step 15: Commit**

```bash
git add package.json package-lock.json tsconfig.base.json scripts/dev.mjs shared server/package.json server/tsconfig.json server/vitest.config.ts server/src server/test web/package.json web/tsconfig.json web/vite.config.ts web/index.html web/src
git commit -m "chore: scaffold npm workspaces, server config and health endpoint

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


---

### Task 2: Database schema, migrations and test DB

**Files:**
- Modify: `server/package.json` (dependencies + `db:generate` script, via `npm install` / `npm pkg set`)
- Create: `server/src/db/schema.ts`
- Create: `server/src/db/client.ts`
- Create: `server/src/db/migrate.ts`
- Create: `server/drizzle.config.ts`
- Create (generated): `server/drizzle/0000_init.sql`, `server/drizzle/meta/_journal.json`, `server/drizzle/meta/0000_snapshot.json`
- Create: `server/test/helpers.ts`
- Modify: `server/src/ctx.ts` (adds `db: Db` to `AppCtx`)
- Modify: `server/test/app.test.ts` (stub ctx becomes `{ config } as AppCtx`)
- Test: `server/test/db/schema.test.ts`

**Interfaces:**
- Consumes: Task 1 scaffold (`server/` workspace with `"type": "module"`, `tsconfig.json`, Vitest wired to `npm test -w server`).
- Produces:
  - `server/src/db/schema.ts`: tables `users`, `sessions`, `sectors`, `userSectors`, `channels`, `contacts`, `customFields`, `contactFieldValues`, `contactNotes`, `tags`, `contactTags`, `chats`, `chatPins`, `messages`, `chatEvents`, `quickAnswers`, `settings`. Every `id` column is `uuid` with `$defaultFn(() => randomUUID())`, so inserts may omit `id` (raw SQL inserts must supply it; there is no DB default). `messages.status` defaults to `'pending'`: inbound, phone-originated and note rows must set `status` explicitly. `contacts.updatedAt` refreshes automatically on drizzle `update()`.
  - Named indexes that later tasks rely on:
    - `sectors_one_default`: partial unique, `WHERE is_default = true`.
    - `contacts_phone_unique` / `contacts_lid_unique`: partial unique, `WHERE … IS NOT NULL`.
    - `chats_one_open_per_contact_channel`: partial unique on `(contact_id, channel_id) WHERE state = 'open'`.
    - `messages_channel_external_unique`: **non-partial** unique on `(channel_id, external_id)`. NULLs never collide, so `onConflictDoNothing({ target: [messages.channelId, messages.externalId] })` works without `where`.
    - `chats_last_message_at_idx`, `messages_chat_sent_idx (chat_id, sent_at)`, `chat_events_chat_idx (chat_id, created_at)`.
    - For the partial unique indexes on `contacts` and `chats`, call `onConflictDoNothing()` with **no target**, then read the row again.
  - `server/src/db/client.ts`:
    - `type Db = PgDatabase<PgQueryResultHKT, typeof schema>`
    - `type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]`
    - `const migrationsFolder: string` (absolute path of `server/drizzle`)
    - `createPgDb(url: string): Db`
    - `createTestDb(): Promise<Db>`: a fresh in-memory PGlite with the migrations applied.
  - `server/src/db/migrate.ts`: `runMigrations(db: Db): Promise<void>` (postgres-js migrator; `src/index.ts` calls it at startup with the `createPgDb` instance).
  - `server/test/helpers.ts` after this task:
    - `makeTestDb(): Promise<Db>`
    - `interface SeededUser`: the same fields as `AuthUser` (`id, name, email, role, signature, sectorIds`), so it is structurally assignable to it.
    - `interface Seeded`
    - `seedBasics(ctx: { db: Db | Tx }): Promise<Seeded>`: accepts any `AppCtx`.
  - Seed data:
    - Sectors: `Atendimento` (the default), `Financeiro` (`sectorA`) and `Jurídico` (`sectorB`).
    - Users: `admin@teste.local` (admin, `sectorIds: []`), `ana@teste.local` (agentA, in sectorA) and `bruno@teste.local` (agentB, in sectorB). All have `passwordHash: 'not-set'`.
    - Channel: `WhatsApp teste`, instance `talk-test`, status `connected`.
  - Helpers that later tasks add (do not add them in this task):
    - **Task 4** adds `makeTestCtx()`: `createTestDb()` + `createFakeGateway()` + a test `Config`. Task 8 fills its hub slot.
    - **Task 6** adds `TEST_PASSWORD` and `TEST_ORIGIN`, replaces `'not-set'` in `seedBasics` with `await hashPassword(TEST_PASSWORD)`, and adds `makeTestApp()` and `loginAs()`.
    - **Task 8** puts `createRecordingHub()` into `makeTestCtx()`.

- [ ] **Step 1: Install the database dependencies and add the generate script**

PGlite and drizzle-kit are dev-only. `client.ts` imports PGlite lazily, so the production image never needs either package.

```bash
npm install -w server --save-exact drizzle-orm@0.45.4 postgres@3.4.9
npm install -w server --save-exact -D drizzle-kit@0.31.11 @electric-sql/pglite@0.5.10
npm pkg set -w server "scripts.db:generate=drizzle-kit generate"
```

Expected: `server/package.json` lists the four packages at exact versions and has `"db:generate": "drizzle-kit generate"`.

- [ ] **Step 2: Write the failing test**

`server/test/db/schema.test.ts`:

```ts
import { is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import * as schema from '../../src/db/schema.js';
import { chats, contacts, messages, sectors } from '../../src/db/schema.js';
import { makeTestDb, seedBasics, type Seeded } from '../helpers.js';

// Postgres error code of a rejected query (drizzle wraps driver errors in `cause`), null if it succeeded.
async function pgCode(query: PromiseLike<unknown>): Promise<string | null> {
  try {
    await query;
    return null;
  } catch (e) {
    const err = e as { code?: string; cause?: { code?: string } };
    return err.cause?.code ?? err.code ?? 'unknown';
  }
}

const UNIQUE_VIOLATION = '23505';

describe('database schema', () => {
  let db: Db;
  let s: Seeded;

  beforeEach(async () => {
    db = await makeTestDb();
    s = await seedBasics({ db });
  });

  it('applies the migration: every schema table and column exists', async () => {
    const tables = Object.values(schema).filter((t) => is(t, PgTable));
    expect(tables).toHaveLength(17);
    // select() lists every column explicitly, so a column missing from the SQL fails here.
    for (const t of tables) await db.select().from(t).limit(1);
  });

  it('allows only one default sector', async () => {
    expect(await pgCode(db.insert(sectors).values({ name: 'Outro', isDefault: true }))).toBe(UNIQUE_VIOLATION);
    expect(await pgCode(db.insert(sectors).values({ name: 'Outro', isDefault: false }))).toBeNull();
  });

  it('allows one open chat per contact and channel, plus any number of closed ones', async () => {
    const [contact] = await db.insert(contacts).values({ phone: '5565999999999' }).returning();
    const chat = { contactId: contact.id, channelId: s.channelId, sectorId: s.defaultSector };

    expect(await pgCode(db.insert(chats).values({ ...chat, state: 'open' }))).toBeNull();
    expect(await pgCode(db.insert(chats).values({ ...chat, state: 'open' }))).toBe(UNIQUE_VIOLATION);
    expect(await pgCode(db.insert(chats).values({ ...chat, state: 'closed', closedAt: new Date() }))).toBeNull();
    expect(await pgCode(db.insert(chats).values({ ...chat, state: 'closed', closedAt: new Date() }))).toBeNull();
  });

  it('rejects a duplicate (channel_id, external_id) but accepts many NULL external ids', async () => {
    const [contact] = await db.insert(contacts).values({ phone: '5565999999999' }).returning();
    const [chat] = await db
      .insert(chats)
      .values({ contactId: contact.id, channelId: s.channelId, sectorId: s.defaultSector })
      .returning();
    const msg = { chatId: chat.id, channelId: s.channelId, direction: 'in' as const, kind: 'text' as const, body: 'oi', sentAt: new Date() };

    expect(await pgCode(db.insert(messages).values({ ...msg, externalId: 'ABC' }))).toBeNull();
    expect(await pgCode(db.insert(messages).values({ ...msg, externalId: 'ABC' }))).toBe(UNIQUE_VIOLATION);
    expect(await pgCode(db.insert(messages).values({ ...msg, kind: 'note', externalId: null }))).toBeNull();
    expect(await pgCode(db.insert(messages).values({ ...msg, kind: 'note', externalId: null }))).toBeNull();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -w server -- test/db/schema.test.ts`
Expected: FAIL with `Failed to load url ../helpers.js` (or "Cannot find module"), because the helpers, client and schema do not exist yet.

- [ ] **Step 4: Write the schema**

`server/src/db/schema.ts` (copy it verbatim). SQL names are written explicitly in snake_case, so the drizzle `casing` option is not used:

```ts
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

// ponytail: enums are text + TS unions (contract); no pg enums to migrate.
const id = () => uuid('id').primaryKey().$defaultFn(() => randomUUID());
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const users = pgTable('users', {
  id: id(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').$type<'admin' | 'agent'>().notNull(),
  signature: text('signature'),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
});

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(), // SHA-256 hex of the cookie token
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

export const sectors = pgTable(
  'sectors',
  {
    id: id(),
    name: text('name').notNull(),
    position: integer('position').notNull().default(0),
    isDefault: boolean('is_default').notNull().default(false),
  },
  (t) => [uniqueIndex('sectors_one_default').on(t.isDefault).where(sql`${t.isDefault} = true`)],
);

export const userSectors = pgTable(
  'user_sectors',
  {
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    sectorId: uuid('sector_id').notNull().references(() => sectors.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.sectorId] })],
);

export const channels = pgTable('channels', {
  id: id(),
  name: text('name').notNull(),
  kind: text('kind').$type<'whatsapp_qr'>().notNull().default('whatsapp_qr'),
  evolutionInstance: text('evolution_instance').notNull().unique(),
  status: text('status').$type<'disconnected' | 'connecting' | 'connected'>().notNull().default('disconnected'),
  phone: text('phone'),
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
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
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

export const contactNotes = pgTable('contact_notes', {
  id: id(),
  contactId: uuid('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
  body: text('body').notNull(),
  pinned: boolean('pinned').notNull().default(false),
  createdAt: createdAt(),
});

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
    uniqueIndex('chats_one_open_per_contact_channel')
      .on(t.contactId, t.channelId)
      .where(sql`${t.state} = 'open'`),
    index('chats_last_message_at_idx').on(t.lastMessageAt),
  ],
);

export const chatPins = pgTable(
  'chat_pins',
  {
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    chatId: uuid('chat_id').notNull().references(() => chats.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.chatId] })],
);

export const messages = pgTable(
  'messages',
  {
    id: id(),
    chatId: uuid('chat_id').notNull().references(() => chats.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id').notNull().references(() => channels.id),
    direction: text('direction').$type<'in' | 'out'>().notNull(),
    kind: text('kind')
      .$type<'text' | 'image' | 'audio' | 'video' | 'document' | 'sticker' | 'note' | 'unsupported'>()
      .notNull(),
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
    // NULLs never collide, so notes/pending rows coexist; ingest uses ON CONFLICT (channel_id, external_id).
    uniqueIndex('messages_channel_external_unique').on(t.channelId, t.externalId),
    index('messages_chat_sent_idx').on(t.chatId, t.sentAt),
  ],
);

export const chatEvents = pgTable(
  'chat_events',
  {
    id: id(),
    chatId: uuid('chat_id').notNull().references(() => chats.id, { onDelete: 'cascade' }),
    kind: text('kind')
      .$type<'created' | 'assigned' | 'transferred' | 'closed' | 'reopened' | 'privacy_changed' | 'triage_routed'>()
      .notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('chat_events_chat_idx').on(t.chatId, t.createdAt)],
);

export const quickAnswers = pgTable('quick_answers', {
  id: id(),
  name: text('name').notNull(),
  body: text('body').notNull(),
  attachmentPath: text('attachment_path'), // relative to config.mediaDir
  visibility: text('visibility').$type<'all' | 'owner'>().notNull().default('all'),
  ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'cascade' }),
  createdAt: createdAt(),
});

export const settings = pgTable('settings', {
  key: text('key').primaryKey(), // 'closing_message' | 'triage_menu'
  value: jsonb('value').$type<unknown>().notNull(),
});
```

- [ ] **Step 5: Write the DB client, the production migrator and the drizzle-kit config**

`server/src/db/client.ts`:

```ts
import { fileURLToPath } from 'node:url';
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import * as schema from './schema.js';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

// server/drizzle — same relative path from src/db (tsx) and dist/db (compiled).
export const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

export function createPgDb(url: string): Db {
  return drizzlePg(postgres(url), { schema });
}

// PGlite is a devDependency: imported lazily so the production image never loads it.
// ponytail: one fresh in-memory PGlite per call (~1s); clone a migrated template if suites get slow.
export async function createTestDb(): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const { migrate } = await import('drizzle-orm/pglite/migrator');
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder });
  return db;
}
```

`server/src/db/migrate.ts`:

```ts
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { migrationsFolder, type Db } from './client.js';
import type * as schema from './schema.js';

// Production only: `db` must come from createPgDb (tests use createTestDb, which migrates itself).
export async function runMigrations(db: Db): Promise<void> {
  await migrate(db as PostgresJsDatabase<typeof schema>, { migrationsFolder });
}
```

`server/drizzle.config.ts`:

```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
```

- [ ] **Step 6: Write the test helpers (DB part)**

`server/test/helpers.ts`:

```ts
import { createTestDb, type Db, type Tx } from '../src/db/client.js';
import { channels, sectors, userSectors, users } from '../src/db/schema.js';

// Task 2 provides the DB part only. Later tasks extend this file (never rename):
//   Task 4 adds makeTestCtx() (fake gateway), Task 6 adds TEST_PASSWORD/TEST_ORIGIN, real
//   password hashes in seedBasics, makeTestApp() and loginAs(); Task 8 swaps in createRecordingHub().

export const makeTestDb = createTestDb;

// Same shape as AuthUser (inbox/visibility.ts, Task 7) — structurally assignable.
export interface SeededUser {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'agent';
  signature: string | null;
  sectorIds: string[];
}

export interface Seeded {
  admin: SeededUser;
  agentA: SeededUser;
  agentB: SeededUser;
  sectorA: string;
  sectorB: string;
  defaultSector: string;
  channelId: string;
  instance: string;
}

// Accepts any AppCtx (only `db` is used).
export async function seedBasics(ctx: { db: Db | Tx }): Promise<Seeded> {
  const { db } = ctx;
  const [defaultSector, sectorA, sectorB] = await db
    .insert(sectors)
    .values([
      { name: 'Atendimento', position: 0, isDefault: true },
      { name: 'Financeiro', position: 1 },
      { name: 'Jurídico', position: 2 },
    ])
    .returning({ id: sectors.id });

  // ponytail: 'not-set' hash until Task 6 seeds real argon2 hashes of TEST_PASSWORD.
  const [admin, agentA, agentB] = await db
    .insert(users)
    .values([
      { name: 'Admin Teste', email: 'admin@teste.local', passwordHash: 'not-set', role: 'admin' },
      { name: 'Ana Financeiro', email: 'ana@teste.local', passwordHash: 'not-set', role: 'agent' },
      { name: 'Bruno Jurídico', email: 'bruno@teste.local', passwordHash: 'not-set', role: 'agent' },
    ])
    .returning({ id: users.id, name: users.name, email: users.email, role: users.role, signature: users.signature });

  await db.insert(userSectors).values([
    { userId: agentA.id, sectorId: sectorA.id },
    { userId: agentB.id, sectorId: sectorB.id },
  ]);

  const instance = 'talk-test';
  const [channel] = await db
    .insert(channels)
    .values({ name: 'WhatsApp teste', evolutionInstance: instance, status: 'connected' })
    .returning({ id: channels.id });

  return {
    admin: { ...admin, sectorIds: [] },
    agentA: { ...agentA, sectorIds: [sectorA.id] },
    agentB: { ...agentB, sectorIds: [sectorB.id] },
    sectorA: sectorA.id,
    sectorB: sectorB.id,
    defaultSector: defaultSector.id,
    channelId: channel.id,
    instance,
  };
}
```

- [ ] **Step 7: Run the test again; it still fails, now because the migration is missing**

Run: `npm test -w server -- test/db/schema.test.ts`
Expected: FAIL with `Error: Can't find meta/_journal.json file`, because no migration has been generated yet.

- [ ] **Step 8: Generate the initial migration**

Run: `npm run db:generate -w server -- --name init`
Expected: the output lists `17 tables` and ends with `[✓] Your SQL migration file ➜ drizzle/0000_init.sql` (backslash on Windows). The command creates `server/drizzle/0000_init.sql`, `server/drizzle/meta/_journal.json` and `server/drizzle/meta/0000_snapshot.json`. Never edit these files by hand. For a future schema change, edit `schema.ts` and run `db:generate` again.

Check that the end of `server/drizzle/0000_init.sql` has exactly these indexes:

```sql
CREATE INDEX "chat_events_chat_idx" ON "chat_events" USING btree ("chat_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "chats_one_open_per_contact_channel" ON "chats" USING btree ("contact_id","channel_id") WHERE "chats"."state" = 'open';--> statement-breakpoint
CREATE INDEX "chats_last_message_at_idx" ON "chats" USING btree ("last_message_at");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_phone_unique" ON "contacts" USING btree ("phone") WHERE "contacts"."phone" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_lid_unique" ON "contacts" USING btree ("lid") WHERE "contacts"."lid" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_channel_external_unique" ON "messages" USING btree ("channel_id","external_id");--> statement-breakpoint
CREATE INDEX "messages_chat_sent_idx" ON "messages" USING btree ("chat_id","sent_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sectors_one_default" ON "sectors" USING btree ("is_default") WHERE "sectors"."is_default" = true;
```

- [ ] **Step 8b: Add `db` to `AppCtx` and loosen the Task 1 app test stub**

Replace `server/src/ctx.ts` with:
```ts
import type { Db } from './db/client.js';
import type { Config } from './config.js';

// Grows with the plan: Task 4 adds `wa: WhatsAppGateway`, Task 8 adds `hub: Hub`
// (final shape in the plan's Shared Contract).
export interface AppCtx {
  db: Db;
  config: Config;
}
```

In `server/test/app.test.ts`, replace the stub block (the comment line and `const ctx: AppCtx = { ... };`) with the version below. The test never touches `db`, `wa` or `hub`, so a cast keeps it compiling as `AppCtx` grows:
```ts
// The app test never touches db, wa or hub, so a config-only cast is enough.
const ctx = {
  config: loadConfig({
    DATABASE_URL: 'postgres://unused',
    APP_ORIGIN: 'http://localhost:5173',
    WEBHOOK_SECRET: 'x'.repeat(32),
    EVOLUTION_URL: 'http://evolution:8080',
    EVOLUTION_API_KEY: 'evo-key',
  }),
} as AppCtx;
```

- [ ] **Step 9: Run the test to verify it passes, then typecheck**

Run: `npm test -w server -- test/db/schema.test.ts`
Expected: PASS, 4 tests. Each takes about 1 s because every test gets a fresh in-memory PGlite.

Run: `npm test -w server -- test/app.test.ts`
Expected: PASS (5 tests), unchanged by the cast.

Run: `npx tsc -p server/tsconfig.json --noEmit`
Expected: exit 0 with no output.

- [ ] **Step 10: Commit**

```bash
git add server/package.json package-lock.json server/drizzle.config.ts server/drizzle server/src/db server/test/helpers.ts server/test/db/schema.test.ts server/src/ctx.ts server/test/app.test.ts
git commit -m "feat(db): drizzle schema, initial migration and PGlite test database

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


---

### Task 3: Brazilian phone normalization

Every place a phone number enters the system (webhook, importer, search, manual create) goes through one function. It produces the canonical 13-digit `55DDD9XXXXXXXX` form for Brazilian mobiles (spec §4). Evolution delivers many Brazilian mobiles as 12-digit JIDs without the 9, while the Umbler import has 13 digits. Both must map to the same `contacts.phone` (Review Focus 1). Landlines and WhatsApp Business numbers whose first local digit is 2–5 must never gain a 9.

**Files:**
- Create: `server/src/whatsapp/phone.ts`
- Test: `server/test/whatsapp/phone.test.ts`

**Interfaces:**
- Consumes: nothing. This is a pure module with no DB and no `AppCtx`. It needs only the `server` workspace and Vitest from Task 1.
- Produces (exact signatures from the contract):
  - `normalizePhoneBR(raw: string): string`
    - Strips every non-digit (`+`, spaces, dashes, parentheses, dots).
    - If the result has 10 or 11 digits and `raw` did not start with `+`, prefixes `55`. A local number like `(65) 99999-9999` is treated as Brazilian. An explicit international number like `+1 202-555-0123` is left alone.
    - Then applies `/^55(\d{2})([6-9]\d{7})$/` → `55$1` + `9` + `$2`.
    - Anything else is returned as plain digits. Non-BR numbers pass through, and `''` returns `''`. Callers must reject an empty result.
    - Idempotent: `normalizePhoneBR(normalizePhoneBR(x)) === normalizePhoneBR(x)`, except for a 10/11-digit foreign number typed with `+` (e.g. `+1 202-555-0123`): its digits without `+` look like a BR local number and gain `55` on a second pass.
  - `phoneFromJid(jid: string): string | null`
    - Accepts only `<digits>[:device]@s.whatsapp.net`. The user part never gets the `55` prefix because JIDs already carry the country code, but it does get the 9 insertion.
    - Returns `null` for `@lid`, `@g.us`, `@broadcast`, `@newsletter`, a non-numeric user part or a malformed JID.
  - `lidFromJid(jid: string): string | null`
    - Accepts only `<digits>[:device]@lid` and returns **the digits only**, with no `@lid` and no device suffix. This is the value stored in `contacts.lid`.
    - Returns `null` for anything else.
    - Any caller that needs to address a LID-only contact must append `@lid` itself.

- [ ] **Step 1: Write the failing test**

Create `server/test/whatsapp/phone.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { lidFromJid, normalizePhoneBR, phoneFromJid } from '../../src/whatsapp/phone.js';

const normalizeCases: Array<[label: string, raw: string, expected: string]> = [
  // Review Focus 1: Evolution's 12-digit form and Umbler's 13-digit form converge
  ['12-digit mobile DDD 65 gains the 9 (Review Focus 1)', '556599999999', '5565999999999'],
  ['13-digit mobile DDD 65 unchanged (Umbler import form)', '5565999999999', '5565999999999'],
  ['12-digit landline starting with 3 unchanged (Review Focus 1)', '556532221111', '556532221111'],
  // first local digit decides: 2-5 fixed / business, 6-9 mobile
  ['12-digit landline starting with 2 unchanged', '552125556666', '552125556666'],
  ['12-digit landline starting with 4 unchanged', '551145556666', '551145556666'],
  ['12-digit landline starting with 5 unchanged', '554755556666', '554755556666'],
  ['12-digit mobile starting with 6 gains the 9', '556566543210', '5565966543210'],
  ['12-digit mobile starting with 7 gains the 9', '556576543210', '5565976543210'],
  ['12-digit mobile starting with 8 gains the 9', '553188887777', '5531988887777'],
  // DDD 11 (below 31): Evolution keeps the 9, but a 12-digit form is still repaired
  ['13-digit mobile DDD 11 unchanged', '5511988887777', '5511988887777'],
  ['12-digit mobile DDD 11 gains the 9', '551188887777', '5511988887777'],
  ['12-digit landline DDD 11 unchanged', '551132221111', '551132221111'],
  // formatting characters are stripped
  ['+55 with spaces, parentheses and dash', '+55 (65) 99999-9999', '5565999999999'],
  ['+55 old 8-digit mobile format gains the 9', '+55 65 9999-9999', '5565999999999'],
  ['dots and surrounding whitespace', '  55.65.99999.9999  ', '5565999999999'],
  ['+55 landline with formatting unchanged', '+55 (65) 3222-1111', '556532221111'],
  // local numbers (no country code) get 55
  ['11-digit local mobile gets 55', '(65) 99999-9999', '5565999999999'],
  ['10-digit local old mobile gets 55 and the 9', '(65) 9999-9999', '5565999999999'],
  ['10-digit local landline gets 55 only', '(65) 3222-1111', '556532221111'],
  ['11-digit local DDD 11 mobile gets 55', '11 98888-7777', '5511988887777'],
  // explicit international numbers are not treated as Brazilian
  ['+1 US number (11 digits) is not prefixed', '+1 202-555-0123', '12025550123'],
  ['+351 Portuguese number passes through', '+351 912 345 678', '351912345678'],
  // degenerate input
  ['empty string stays empty', '', ''],
  ['only formatting stays empty', ' ( ) - + ', ''],
];

describe('normalizePhoneBR', () => {
  it.each(normalizeCases)('%s', (_label, raw, expected) => {
    expect(normalizePhoneBR(raw)).toBe(expected);
  });

  // An 11-digit foreign number without '+' is indistinguishable from a BR local
  // number, so only the '+'-prefixed input is canonical: '12025550123' would gain 55.
  it.each(normalizeCases.filter(([, raw]) => !raw.trim().startsWith('+1 ')))('is idempotent: %s', (_label, raw) => {
    const once = normalizePhoneBR(raw);
    expect(normalizePhoneBR(once)).toBe(once);
  });
});

describe('phoneFromJid', () => {
  it.each<[string, string | null]>([
    ['556599999999@s.whatsapp.net', '5565999999999'], // Review Focus 1
    ['5565999999999@s.whatsapp.net', '5565999999999'],
    ['556599999999:12@s.whatsapp.net', '5565999999999'], // device suffix
    ['5565999999999:3@s.whatsapp.net', '5565999999999'],
    ['556532221111@s.whatsapp.net', '556532221111'], // landline keeps 12 digits
    ['551188887777@s.whatsapp.net', '5511988887777'],
    ['12025550123@s.whatsapp.net', '12025550123'], // 11-digit foreign JID never gets 55
    ['123456789012345@lid', null],
    ['120363025246125486@g.us', null],
    ['556599999999-1600000000@g.us', null],
    ['status@broadcast', null],
    ['120363000000000000@newsletter', null],
    ['abc@s.whatsapp.net', null],
    ['@s.whatsapp.net', null],
    ['556599999999', null],
    ['', null],
  ])('%s -> %s', (jid, expected) => {
    expect(phoneFromJid(jid)).toBe(expected);
  });
});

describe('lidFromJid', () => {
  it.each<[string, string | null]>([
    ['123456789012345@lid', '123456789012345'],
    ['123456789012345:7@lid', '123456789012345'],
    ['556599999999@s.whatsapp.net', null],
    ['120363025246125486@g.us', null],
    ['abc@lid', null],
    ['@lid', null],
    ['123456789012345', null],
    ['', null],
  ])('%s -> %s', (jid, expected) => {
    expect(lidFromJid(jid)).toBe(expected);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- test/whatsapp/phone.test.ts`
Expected: FAIL. The suite cannot load because `server/src/whatsapp/phone.ts` does not exist (`Failed to resolve import "../../src/whatsapp/phone.js"` / `Cannot find module`).

- [ ] **Step 3: Write minimal implementation**

Create `server/src/whatsapp/phone.ts`:

```ts
// Spec §4: canonical BR mobile = 55 + DDD + 9 + 8 digits (13 digits, no '+').
// A 12-digit number whose first local digit is 6-9 is a mobile missing its 9
// (Evolution strips it for DDD >= 31). First local digit 2-5 = landline or
// WhatsApp Business and stays as is.
const MOBILE_WITHOUT_9 = /^55(\d{2})([6-9]\d{7})$/;

export function normalizePhoneBR(raw: string): string {
  let digits = raw.replace(/\D/g, '');
  // A local number (DDD + number) gets the country code, unless the user typed
  // an explicit '+' (international number such as +1 202-555-0123).
  if ((digits.length === 10 || digits.length === 11) && !raw.trim().startsWith('+')) {
    digits = '55' + digits;
  }
  return digits.replace(MOBILE_WITHOUT_9, '55$19$2');
}

// '5565...:12@s.whatsapp.net' -> { user: '5565...', server: 's.whatsapp.net' }
function splitJid(jid: string): { user: string; server: string } | null {
  const at = jid.indexOf('@');
  if (at <= 0) return null;
  const user = jid.slice(0, at).split(':')[0];
  return /^\d+$/.test(user) ? { user, server: jid.slice(at + 1) } : null;
}

export function phoneFromJid(jid: string): string | null {
  const p = splitJid(jid);
  // JIDs always carry the country code: the '+' stops normalizePhoneBR from prefixing 55.
  return p?.server === 's.whatsapp.net' ? normalizePhoneBR('+' + p.user) : null;
}

// Returns the LID digits only (what contacts.lid stores); callers append '@lid' when addressing.
export function lidFromJid(jid: string): string | null {
  const p = splitJid(jid);
  return p?.server === 'lid' ? p.user : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w server -- test/whatsapp/phone.test.ts`
Expected: PASS. All `normalizePhoneBR` cases and their idempotence checks pass, plus 16 `phoneFromJid` cases and 8 `lidFromJid` cases.

- [ ] **Step 5: Commit**

```bash
git add server/src/whatsapp/phone.ts server/test/whatsapp/phone.test.ts
git commit -m "feat(whatsapp): add Brazilian phone normalization and JID helpers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


---

### Task 4: Evolution API gateway and fake gateway

`server/src/whatsapp/` is the only place that knows Evolution's HTTP format (spec §3). This task adds three things: the gateway types, a `fetch`-based client for Evolution API **v2.3.7**, and an in-memory fake that every server test uses through `makeTestCtx()`.

**Files:**
- Create: `server/src/whatsapp/types.ts`
- Create: `server/src/whatsapp/evolution.ts`
- Create: `server/src/whatsapp/fake.ts`
- Modify: `server/src/ctx.ts` (`AppCtx` gains `db: Db` and `wa: WhatsAppGateway`)
- Modify: `server/test/helpers.ts` (create `makeTestCtx()`)
- Modify: `server/test/app.test.ts` (Task 1's config-only ctx becomes a cast, so `tsc` still passes)
- Test: `server/test/whatsapp/evolution.test.ts`
- Test: `server/test/whatsapp/fake.test.ts`

**Interfaces:**
- Consumes:
  - `createTestDb(): Promise<Db>` and `type Db` from `server/src/db/client.ts` (Task 2)
  - `AppCtx { config: Config }` from `server/src/ctx.ts` (Task 1), `Config` from `server/src/config.ts` (Task 1)
- Produces:
  - `server/src/whatsapp/types.ts`: `ChannelStatus`, `MessageKind`, `QuotedRef`, `SendResult`, `OutgoingMedia`, `DownloadedMedia`, `WhatsAppGateway` and `InboundEvent`, copied verbatim from the contract.
  - `createEvolutionGateway(cfg: { url: string; apiKey: string }, fetchImpl?: typeof fetch): WhatsAppGateway`, used by `server/src/index.ts` with `config.evolution`.
  - `createFakeGateway(): WhatsAppGateway & { sent: Array<{ method: string; instance: string; phone?: string; payload: unknown }>; failNext(err?: Error): void; status: Map<string, ChannelStatus> }`
  - `server/src/ctx.ts`: `AppCtx { config: Config; db: Db; wa: WhatsAppGateway }`. Task 8 adds `hub: Hub`.
  - `server/test/helpers.ts`: `makeTestCtx(): Promise<AppCtx & { wa: ReturnType<typeof createFakeGateway> }>`: a fresh `createTestDb()`, `createFakeGateway()` and a test `Config` (`appOrigin: 'http://localhost:5173'`, `mediaDir` = a fresh temp directory). Task 8 adds the `hub` member to reach the contract signature.
- Behavior that later tasks rely on:
  - **Errors:**
    - Any non-2xx response from Evolution throws `Error("Evolution <METHOD> <path> failed: <status> <first 300 chars of body>")`.
    - A network failure throws the original `fetch` error.
    - A send response without `key.id` throws.
    - A `downloadMedia` response without `base64` throws.
  - **`connect`:** `qrBase64` is the full data URL that Evolution returns (`data:image/png;base64,...`), so the web can use it directly as `<img src>`. It is `null` when the instance is already `open`.
  - **`downloadMedia(instance, raw)`:** sends `{ message: raw, convertToMp4: false }`, where `raw` is the webhook `data` object (`{ key, message, ... }`, i.e. `InboundEvent.raw` from Task 5). The returned `mime` is Evolution's `mimetype`, which can include parameters such as `audio/ogg; codecs=opus`. It falls back to `application/octet-stream`.
  - **`QuotedRef` mapping:** a `QuotedRef` is sent as `quoted: { key: { id, fromMe, remoteJid: '<phone>@s.whatsapp.net' }, message: { conversation: body ?? '' } }`. Because `message` is present, Evolution uses the quote as given and does not need the original message in its own database.
  - **Fake `sent` log:**
    - It records `createInstance`, `connect`, `sendText`, `sendMedia` and `sendAudio`.
    - It does not record `connectionState` or `downloadMedia`, which only read.
    - Payloads by method:

      | Method | `payload` |
      |---|---|
      | `createInstance` | `{ webhookUrl }` |
      | `connect` | `null` |
      | `sendText` | `{ text, quoted }` |
      | `sendMedia` | `{ media, quoted }` |
      | `sendAudio` | `{ base64 }` |

    - `phone` is set only for the `send*` calls.
    - A call that fails is not recorded.
  - **Fake `failNext(err?)`:**
    - The **next call of any method**, including `downloadMedia` and `connectionState`, rejects with `err`. The default is `new Error('fake gateway failure')`.
    - The call after that succeeds again.
  - **Fake `connectionState`:** returns `status.get(instance) ?? 'disconnected'`. Tests set `wa.status` directly.
  - **Fake `connect`:** returns `qrBase64: null` if the status is `connected`. Otherwise it returns a PNG data URL.
  - **Fake `send*`:** returns `{ externalId: 'fake-1' }`, then `'fake-2'`, and so on. One counter is shared by all `send*` methods.
  - **Fake `downloadMedia`:** returns `{ base64: <1×1 PNG>, mime: 'image/png' }`.

- [ ] **Step 1: Create the gateway types (verbatim from the contract)**

`server/src/whatsapp/types.ts`:

```ts
export type ChannelStatus = 'disconnected' | 'connecting' | 'connected';
export type MessageKind = 'text' | 'image' | 'audio' | 'video' | 'document' | 'sticker' | 'note' | 'unsupported';
export interface QuotedRef { externalId: string; body: string | null; fromMe: boolean }
export interface SendResult { externalId: string }
export interface OutgoingMedia { kind: 'image' | 'video' | 'document'; base64: string; mime: string; fileName: string; caption?: string }
export interface DownloadedMedia { base64: string; mime: string; fileName?: string }

export interface WhatsAppGateway {
  createInstance(instance: string, webhookUrl: string): Promise<void>;
  connect(instance: string): Promise<{ qrBase64: string | null }>;
  connectionState(instance: string): Promise<ChannelStatus>;
  sendText(instance: string, phone: string, text: string, quoted?: QuotedRef): Promise<SendResult>;
  sendMedia(instance: string, phone: string, media: OutgoingMedia, quoted?: QuotedRef): Promise<SendResult>;
  sendAudio(instance: string, phone: string, base64: string): Promise<SendResult>;
  downloadMedia(instance: string, rawMessage: unknown): Promise<DownloadedMedia>;
}

export type InboundEvent =
  | { type: 'message'; instance: string; externalId: string; direction: 'in' | 'out';
      phone: string | null; lid: string | null; pushName: string | null;
      kind: MessageKind; body: string | null; hasMedia: boolean;
      mediaMime: string | null; mediaName: string | null;
      replyToExternalId: string | null; sentAt: Date; raw: unknown }
  | { type: 'reaction'; instance: string; targetExternalId: string; emoji: string | null }
  | { type: 'status'; instance: string; externalId: string; status: 'sent' | 'delivered' | 'read' | 'failed' }
  | { type: 'connection'; instance: string; status: ChannelStatus }
  | { type: 'qrcode'; instance: string; qrBase64: string }
  | { type: 'ignored'; reason: string };
```

- [ ] **Step 2: Write the failing fake-gateway test**

`server/test/whatsapp/fake.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createFakeGateway } from '../../src/whatsapp/fake.js';

describe('createFakeGateway', () => {
  it('returns sequential fake external ids shared by all send methods and records each send', async () => {
    const wa = createFakeGateway();
    const quoted = { externalId: 'ABC', body: 'oi', fromMe: false };
    const media = { kind: 'document' as const, base64: 'JVBERi0=', mime: 'application/pdf', fileName: 'a.pdf' };

    expect(await wa.sendText('talk-test', '5565999999999', 'Olá', quoted)).toEqual({ externalId: 'fake-1' });
    expect(await wa.sendMedia('talk-test', '5565999999999', media)).toEqual({ externalId: 'fake-2' });
    expect(await wa.sendAudio('talk-test', '5565999999999', 'T2dnUw==')).toEqual({ externalId: 'fake-3' });

    expect(wa.sent).toEqual([
      { method: 'sendText', instance: 'talk-test', phone: '5565999999999', payload: { text: 'Olá', quoted } },
      { method: 'sendMedia', instance: 'talk-test', phone: '5565999999999', payload: { media, quoted: undefined } },
      { method: 'sendAudio', instance: 'talk-test', phone: '5565999999999', payload: { base64: 'T2dnUw==' } },
    ]);
  });

  it('records createInstance and connect but not read-only calls', async () => {
    const wa = createFakeGateway();
    await wa.createInstance('talk-test', 'http://app:3000/webhooks/evolution/s');
    await wa.connect('talk-test');
    await wa.connectionState('talk-test');
    await wa.downloadMedia('talk-test', { key: { id: 'X' } });

    expect(wa.sent).toEqual([
      { method: 'createInstance', instance: 'talk-test', payload: { webhookUrl: 'http://app:3000/webhooks/evolution/s' } },
      { method: 'connect', instance: 'talk-test', payload: null },
    ]);
  });

  it('failNext makes only the next call reject, with the given or a default error', async () => {
    const wa = createFakeGateway();
    const boom = new Error('evolution down');
    wa.failNext(boom);
    await expect(wa.sendText('talk-test', '5565999999999', 'a')).rejects.toBe(boom);
    expect(wa.sent).toEqual([]);
    expect(await wa.sendText('talk-test', '5565999999999', 'b')).toEqual({ externalId: 'fake-1' });

    wa.failNext();
    await expect(wa.downloadMedia('talk-test', {})).rejects.toThrow('fake gateway failure');
    await expect(wa.downloadMedia('talk-test', {})).resolves.toMatchObject({ mime: 'image/png' });
  });

  it('connectionState reflects the status map and defaults to disconnected', async () => {
    const wa = createFakeGateway();
    expect(await wa.connectionState('talk-test')).toBe('disconnected');
    wa.status.set('talk-test', 'connected');
    expect(await wa.connectionState('talk-test')).toBe('connected');
  });

  it('connect returns a PNG data URL unless already connected', async () => {
    const wa = createFakeGateway();
    const { qrBase64 } = await wa.connect('talk-test');
    expect(qrBase64).toMatch(/^data:image\/png;base64,/);
    wa.status.set('talk-test', 'connected');
    expect(await wa.connect('talk-test')).toEqual({ qrBase64: null });
  });

  it('downloadMedia returns a real 1x1 PNG', async () => {
    const wa = createFakeGateway();
    const media = await wa.downloadMedia('talk-test', {});
    expect(media.mime).toBe('image/png');
    const bytes = Buffer.from(media.base64, 'base64');
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -w server -- test/whatsapp/fake.test.ts`
Expected: FAIL, because Vitest cannot resolve `../../src/whatsapp/fake.js`.

- [ ] **Step 4: Implement the fake gateway**

`server/src/whatsapp/fake.ts`:

```ts
import type { ChannelStatus, SendResult, WhatsAppGateway } from './types.js';

// 1×1 transparent PNG.
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

export function createFakeGateway(): WhatsAppGateway & {
  sent: Array<{ method: string; instance: string; phone?: string; payload: unknown }>;
  failNext(err?: Error): void;
  status: Map<string, ChannelStatus>;
} {
  const sent: Array<{ method: string; instance: string; phone?: string; payload: unknown }> = [];
  const status = new Map<string, ChannelStatus>();
  let pendingError: Error | null = null;
  let n = 0;

  // Throws (once) the error armed by failNext. Called first in every method.
  function guard(): void {
    if (pendingError) {
      const err = pendingError;
      pendingError = null;
      throw err;
    }
  }

  function send(method: string, instance: string, phone: string, payload: unknown): SendResult {
    guard();
    sent.push({ method, instance, phone, payload });
    n += 1;
    return { externalId: `fake-${n}` };
  }

  return {
    sent,
    status,
    failNext(err = new Error('fake gateway failure')) {
      pendingError = err;
    },
    async createInstance(instance, webhookUrl) {
      guard();
      sent.push({ method: 'createInstance', instance, payload: { webhookUrl } });
    },
    async connect(instance) {
      guard();
      sent.push({ method: 'connect', instance, payload: null });
      return { qrBase64: status.get(instance) === 'connected' ? null : `data:image/png;base64,${PNG_1X1}` };
    },
    async connectionState(instance) {
      guard();
      return status.get(instance) ?? 'disconnected';
    },
    async sendText(instance, phone, text, quoted) {
      return send('sendText', instance, phone, { text, quoted });
    },
    async sendMedia(instance, phone, media, quoted) {
      return send('sendMedia', instance, phone, { media, quoted });
    },
    async sendAudio(instance, phone, base64) {
      return send('sendAudio', instance, phone, { base64 });
    },
    async downloadMedia() {
      guard();
      return { base64: PNG_1X1, mime: 'image/png' };
    },
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -w server -- test/whatsapp/fake.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Write the failing Evolution gateway test**

`server/test/whatsapp/evolution.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { createEvolutionGateway } from '../../src/whatsapp/evolution.js';

const PHONE = '5565999999999';
const JSON_HEADERS = { apikey: 'k-123', 'content-type': 'application/json' };

// Builds a gateway whose fetch always answers `status` + `body` and records each request.
function setup(status: number, body: unknown) {
  const fetchMock = vi.fn<typeof fetch>(async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
  // Trailing slash on purpose: the gateway must not produce "//instance".
  const wa = createEvolutionGateway({ url: 'http://evolution:8080/', apiKey: 'k-123' }, fetchMock);
  const req = (i = 0) => {
    const [url, init] = fetchMock.mock.calls[i]!;
    return {
      url: String(url),
      method: init?.method,
      headers: init?.headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
    };
  };
  return { wa, fetchMock, req };
}

const SENT_MESSAGE = {
  key: { remoteJid: `${PHONE}@s.whatsapp.net`, fromMe: true, id: '3EB0ABCDEF' },
  message: { conversation: 'Olá' },
  messageTimestamp: '1760440000',
  status: 'PENDING',
};

describe('createEvolutionGateway', () => {
  it('createInstance posts a Baileys instance with QR, groups ignored and our webhook', async () => {
    const { wa, req } = setup(201, { instance: { instanceName: 'talk-abc', status: 'connecting' }, hash: 'x' });
    await expect(wa.createInstance('talk-abc', 'http://app:3000/webhooks/evolution/s3cr3t')).resolves.toBeUndefined();
    expect(req()).toEqual({
      url: 'http://evolution:8080/instance/create',
      method: 'POST',
      headers: JSON_HEADERS,
      body: {
        instanceName: 'talk-abc',
        integration: 'WHATSAPP-BAILEYS',
        qrcode: true,
        groupsIgnore: true,
        webhook: {
          enabled: true,
          url: 'http://app:3000/webhooks/evolution/s3cr3t',
          byEvents: false,
          base64: false,
          events: ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'CONNECTION_UPDATE', 'QRCODE_UPDATED'],
        },
      },
    });
  });

  it('connect GETs /instance/connect and returns the QR data URL', async () => {
    const { wa, req } = setup(200, { pairingCode: null, code: '2@abc', base64: 'data:image/png;base64,QRDATA', count: 1 });
    expect(await wa.connect('talk-abc')).toEqual({ qrBase64: 'data:image/png;base64,QRDATA' });
    expect(req()).toEqual({ url: 'http://evolution:8080/instance/connect/talk-abc', method: 'GET', headers: JSON_HEADERS, body: undefined });
  });

  it('connect returns null when the instance is already open', async () => {
    const { wa } = setup(200, { instance: { instanceName: 'talk-abc', state: 'open' } });
    expect(await wa.connect('talk-abc')).toEqual({ qrBase64: null });
  });

  it.each([
    ['open', 'connected'],
    ['connecting', 'connecting'],
    ['close', 'disconnected'],
  ] as const)('connectionState maps %s to %s', async (state, expected) => {
    const { wa, req } = setup(200, { instance: { instanceName: 'talk-abc', state } });
    expect(await wa.connectionState('talk-abc')).toBe(expected);
    expect(req()).toEqual({ url: 'http://evolution:8080/instance/connectionState/talk-abc', method: 'GET', headers: JSON_HEADERS, body: undefined });
  });

  it('sendText posts number + text and returns key.id', async () => {
    const { wa, req } = setup(201, SENT_MESSAGE);
    expect(await wa.sendText('talk-abc', PHONE, 'Olá')).toEqual({ externalId: '3EB0ABCDEF' });
    expect(req()).toEqual({
      url: 'http://evolution:8080/message/sendText/talk-abc',
      method: 'POST',
      headers: JSON_HEADERS,
      body: { number: PHONE, text: 'Olá' },
    });
  });

  it('sendText sends quoted with key and inline message', async () => {
    const { wa, req } = setup(201, SENT_MESSAGE);
    await wa.sendText('talk-abc', PHONE, 'Resposta', { externalId: 'QUOTED1', body: 'Pergunta', fromMe: false });
    expect(req().body).toEqual({
      number: PHONE,
      text: 'Resposta',
      quoted: {
        key: { id: 'QUOTED1', fromMe: false, remoteJid: `${PHONE}@s.whatsapp.net` },
        message: { conversation: 'Pergunta' },
      },
    });
  });

  it('sendMedia posts base64 media with mediatype, mimetype, fileName, caption and quoted', async () => {
    const { wa, req } = setup(201, SENT_MESSAGE);
    const res = await wa.sendMedia(
      'talk-abc',
      PHONE,
      { kind: 'document', base64: 'JVBERi0=', mime: 'application/pdf', fileName: 'contrato.pdf', caption: 'Segue' },
      { externalId: 'QUOTED2', body: null, fromMe: true },
    );
    expect(res).toEqual({ externalId: '3EB0ABCDEF' });
    expect(req()).toEqual({
      url: 'http://evolution:8080/message/sendMedia/talk-abc',
      method: 'POST',
      headers: JSON_HEADERS,
      body: {
        number: PHONE,
        mediatype: 'document',
        mimetype: 'application/pdf',
        media: 'JVBERi0=',
        fileName: 'contrato.pdf',
        caption: 'Segue',
        quoted: {
          key: { id: 'QUOTED2', fromMe: true, remoteJid: `${PHONE}@s.whatsapp.net` },
          message: { conversation: '' },
        },
      },
    });
  });

  it('sendAudio posts to sendWhatsAppAudio with base64 audio', async () => {
    const { wa, req } = setup(201, SENT_MESSAGE);
    expect(await wa.sendAudio('talk-abc', PHONE, 'T2dnUw==')).toEqual({ externalId: '3EB0ABCDEF' });
    expect(req()).toEqual({
      url: 'http://evolution:8080/message/sendWhatsAppAudio/talk-abc',
      method: 'POST',
      headers: JSON_HEADERS,
      body: { number: PHONE, audio: 'T2dnUw==' },
    });
  });

  it('downloadMedia posts the raw webhook message and maps the response', async () => {
    const raw = { key: { id: 'IN1', remoteJid: `${PHONE}@s.whatsapp.net`, fromMe: false }, message: { imageMessage: { mimetype: 'image/jpeg' } } };
    const { wa, req } = setup(201, {
      mediaType: 'imageMessage',
      fileName: 'IN1.jpeg',
      caption: null,
      size: { fileLength: { low: 10, high: 0, unsigned: true }, height: 1, width: 1 },
      mimetype: 'image/jpeg',
      base64: '/9j/4AAQ',
      buffer: null,
    });
    expect(await wa.downloadMedia('talk-abc', raw)).toEqual({ base64: '/9j/4AAQ', mime: 'image/jpeg', fileName: 'IN1.jpeg' });
    expect(req()).toEqual({
      url: 'http://evolution:8080/chat/getBase64FromMediaMessage/talk-abc',
      method: 'POST',
      headers: JSON_HEADERS,
      body: { message: raw, convertToMp4: false },
    });
  });

  it('downloadMedia throws when Evolution returns no base64', async () => {
    const { wa } = setup(201, '');
    await expect(wa.downloadMedia('talk-abc', {})).rejects.toThrow(/no media/);
  });

  it('throws with status and a truncated body on non-2xx', async () => {
    const { wa } = setup(400, 'x'.repeat(1000));
    const err = (await wa.sendText('talk-abc', PHONE, 'Olá').catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('Evolution POST /message/sendText/talk-abc failed: 400');
    expect(err.message).toContain('x'.repeat(300));
    expect(err.message).not.toContain('x'.repeat(301));
  });

  it('throws when a send response has no key.id', async () => {
    const { wa } = setup(201, { error: true, message: 'whatever' });
    await expect(wa.sendText('talk-abc', PHONE, 'Olá')).rejects.toThrow(/no key\.id/);
  });

  it('encodes the instance name in the path', async () => {
    const { wa, req } = setup(200, { instance: { state: 'open' } });
    await wa.connectionState('a b');
    expect(req().url).toBe('http://evolution:8080/instance/connectionState/a%20b');
  });
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `npm test -w server -- test/whatsapp/evolution.test.ts`
Expected: FAIL, because Vitest cannot resolve `../../src/whatsapp/evolution.js`.

- [ ] **Step 8: Implement the Evolution gateway**

`server/src/whatsapp/evolution.ts`:

```ts
// HTTP client for Evolution API v2.3.7 (image evoapicloud/evolution-api:v2.3.7).
// Request and response shapes were checked against the 2.3.7 tag of the source:
// - Route prefixes /instance, /message, /chat:
//   https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/api/routes/index.router.ts
// - routerPath(name) → "/<name>/:instanceName":
//   https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/api/abstract/abstract.router.ts
// - Routes: POST /instance/create, GET /instance/connect/:i, GET /instance/connectionState/:i
//   https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/api/routes/instance.router.ts
// - Routes: POST /message/sendText|sendMedia|sendWhatsAppAudio/:i (201)
//   https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/api/routes/sendMessage.router.ts
// - Route: POST /chat/getBase64FromMediaMessage/:i (201)
//   https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/api/routes/chat.router.ts
// - Auth header "apikey":
//   https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/api/guards/auth.guard.ts
// - InstanceDto: webhook { enabled, url, byEvents, base64, events, headers }, integration, qrcode, groupsIgnore
//   https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/api/dto/instance.dto.ts
//   https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/api/integrations/event/event.manager.ts
// - SendTextDto { number, text, quoted? }, SendMediaDto { number, mediatype, mimetype, caption, fileName, media },
//   SendAudioDto { number, audio }, Quoted { key, message }:
//   https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/api/dto/sendMessage.dto.ts
// - getBase64FromMediaMessageDto { message, convertToMp4 }:
//   https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/api/dto/chat.dto.ts
// - Response shapes (instance.controller.ts):
//   connectionState → { instance: { instanceName, state } }
//   connect → { pairingCode, code, base64, count }, or the connectionState shape when already open
//   https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/api/controllers/instance.controller.ts
// - Response shapes (whatsapp.baileys.service.ts):
//   send* → prepared message with key.id
//   getBase64FromMediaMessage → { mediaType, fileName, caption, size, mimetype, base64 }
//   a quoted object that carries `message` is used as-is (no lookup in Evolution's database)
//   https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts
import type { ChannelStatus, DownloadedMedia, QuotedRef, SendResult, WhatsAppGateway } from './types.js';

const WEBHOOK_EVENTS = ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'CONNECTION_UPDATE', 'QRCODE_UPDATED'];

export function createEvolutionGateway(
  cfg: { url: string; apiKey: string },
  fetchImpl: typeof fetch = fetch,
): WhatsAppGateway {
  const base = cfg.url.replace(/\/+$/, '');

  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T | null> {
    const res = await fetchImpl(base + path, {
      method,
      headers: { apikey: cfg.apiKey, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Evolution ${method} ${path} failed: ${res.status} ${text.slice(0, 300)}`);
    return text ? (JSON.parse(text) as T) : null;
  }

  const seg = (instance: string) => encodeURIComponent(instance);

  function quotedPayload(phone: string, q: QuotedRef | undefined) {
    if (!q) return undefined;
    // ponytail: remoteJid uses our canonical 13-digit phone. If WhatsApp knows the contact by its 12-digit JID,
    // the quote still threads by key.id; only the quoted author label may differ. Upgrade: store the real JID per contact.
    return {
      key: { id: q.externalId, fromMe: q.fromMe, remoteJid: `${phone}@s.whatsapp.net` },
      message: { conversation: q.body ?? '' },
    };
  }

  async function send(path: string, body: unknown): Promise<SendResult> {
    const res = await call<{ key?: { id?: string } }>('POST', path, body);
    const id = res?.key?.id;
    if (!id) throw new Error(`Evolution POST ${path} returned no key.id`);
    return { externalId: id };
  }

  return {
    async createInstance(instance, webhookUrl) {
      await call('POST', '/instance/create', {
        instanceName: instance,
        integration: 'WHATSAPP-BAILEYS',
        qrcode: true,
        groupsIgnore: true,
        webhook: { enabled: true, url: webhookUrl, byEvents: false, base64: false, events: WEBHOOK_EVENTS },
      });
    },

    async connect(instance) {
      const res = await call<{ base64?: string | null }>('GET', `/instance/connect/${seg(instance)}`);
      return { qrBase64: res?.base64 ?? null };
    },

    async connectionState(instance): Promise<ChannelStatus> {
      const res = await call<{ instance?: { state?: string } }>('GET', `/instance/connectionState/${seg(instance)}`);
      const state = res?.instance?.state;
      if (state === 'open') return 'connected';
      if (state === 'connecting') return 'connecting';
      return 'disconnected';
    },

    sendText(instance, phone, text, quoted) {
      return send(`/message/sendText/${seg(instance)}`, { number: phone, text, quoted: quotedPayload(phone, quoted) });
    },

    sendMedia(instance, phone, media, quoted) {
      return send(`/message/sendMedia/${seg(instance)}`, {
        number: phone,
        mediatype: media.kind,
        mimetype: media.mime,
        media: media.base64,
        fileName: media.fileName,
        caption: media.caption,
        quoted: quotedPayload(phone, quoted),
      });
    },

    sendAudio(instance, phone, base64) {
      return send(`/message/sendWhatsAppAudio/${seg(instance)}`, { number: phone, audio: base64 });
    },

    async downloadMedia(instance, rawMessage): Promise<DownloadedMedia> {
      const res = await call<{ base64?: string; mimetype?: string; fileName?: string }>(
        'POST',
        `/chat/getBase64FromMediaMessage/${seg(instance)}`,
        { message: rawMessage, convertToMp4: false },
      );
      if (!res?.base64) throw new Error('Evolution getBase64FromMediaMessage returned no media');
      return { base64: res.base64, mime: res.mimetype || 'application/octet-stream', fileName: res.fileName || undefined };
    },
  };
}
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `npm test -w server -- test/whatsapp/evolution.test.ts`
Expected: PASS (15 tests; `it.each` counts 3).

- [ ] **Step 10: Write the failing test that `makeTestCtx` uses the fake gateway**

Append to `server/test/whatsapp/fake.test.ts`. Put the import at the top of the file, next to the other imports, and the `describe` block at the end:

```ts
import { makeTestCtx } from '../helpers.js';

describe('makeTestCtx', () => {
  it('wires the fake gateway into ctx.wa', async () => {
    const ctx = await makeTestCtx();
    expect(ctx.wa.sent).toEqual([]);
    expect(await ctx.wa.sendText('talk-test', '5565999999999', 'x')).toEqual({ externalId: 'fake-1' });
    ctx.wa.failNext();
    await expect(ctx.wa.connectionState('talk-test')).rejects.toThrow('fake gateway failure');
  });
});
```

- [ ] **Step 11: Run the test to verify it fails**

Run: `npm test -w server -- test/whatsapp/fake.test.ts`
Expected: FAIL. The whole file fails with `SyntaxError: The requested module '../helpers.js' does not provide an export named 'makeTestCtx'`, because Task 2's helpers export only `makeTestDb`, `SeededUser`, `Seeded` and `seedBasics`.

- [ ] **Step 12: Extend `AppCtx` and create `makeTestCtx`**

Replace `server/src/ctx.ts` with:

```ts
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import type { WhatsAppGateway } from './whatsapp/types.js';

// Grows with the plan: Task 8 adds `hub: Hub` (final shape in the plan's Shared Contract).
export interface AppCtx {
  config: Config;
  db: Db;
  wa: WhatsAppGateway;
}
```

In `server/test/helpers.ts`, add these imports below the existing ones:

```ts
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../src/config.js';
import type { AppCtx } from '../src/ctx.js';
import { createFakeGateway } from '../src/whatsapp/fake.js';
```

Then append this function at the end of the file. Leave everything else in the file unchanged:

```ts
// Fresh in-memory DB, fake gateway and test config per call. Task 8 adds `hub: createRecordingHub()`
// and widens the return type to the contract signature.
export async function makeTestCtx(): Promise<AppCtx & { wa: ReturnType<typeof createFakeGateway> }> {
  const db = await createTestDb();
  const config: Config = {
    port: 0,
    databaseUrl: 'pglite://memory',
    appOrigin: 'http://localhost:5173', // same value as TEST_ORIGIN (Task 6)
    cookieSecure: false,
    webhookSecret: 'test-webhook-secret-0123456789abcdef',
    webhookBaseUrl: 'http://app:3000',
    mediaDir: await mkdtemp(join(tmpdir(), 'talk-media-')),
    webDistDir: null,
    evolution: { url: 'http://evolution.test', apiKey: 'test-key' },
    sessionDays: 30,
  };
  return { db, wa: createFakeGateway(), config };
}
```

`AppCtx` now requires `db` and `wa`, so Task 1's config-only ctx in `server/test/app.test.ts` no longer typechecks. Those routes never touch `db` or `wa`, so turn the annotation into a cast. In `server/test/app.test.ts`, replace:

```ts
// Task 1 stub: AppCtx only has `config` until Tasks 2/4/8 add db, wa and hub.
const ctx: AppCtx = {
```

with:

```ts
// Only `config` is used by these routes; db/wa/hub are never touched.
const ctx = {
```

and replace the closing `};` of that object (the line right after `  }),`) with:

```ts
} as AppCtx;
```

- [ ] **Step 13: Run the whatsapp tests, the full server suite and the typecheck**

Run: `npm test -w server -- test/whatsapp/fake.test.ts test/whatsapp/evolution.test.ts`
Expected: PASS (7 tests in `fake.test.ts`, 15 tests in `evolution.test.ts`).

Run: `npm test -w server`
Expected: PASS. Earlier tasks' tests still pass.

Run: `npx tsc -p server/tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 14: Commit**

```bash
git add server/src/ctx.ts server/src/whatsapp/types.ts server/src/whatsapp/evolution.ts server/src/whatsapp/fake.ts server/test/helpers.ts server/test/app.test.ts server/test/whatsapp/evolution.test.ts server/test/whatsapp/fake.test.ts
git commit -m "feat(whatsapp): add Evolution API v2.3.7 gateway and fake gateway for tests

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


---

### Task 5: Evolution webhook parser

Turns one Evolution API v2.3.7 webhook body into `InboundEvent[]` (contract type). This is the only place that knows Evolution's payload format. The parser is pure: no DB, no logging, and it never throws. It returns at least one event per call, and a malformed payload becomes `{ type: 'ignored', reason }` so the webhook route (Task 9) can log the reason.

Payload facts (checked against the Evolution `2.3.7` source, `whatsapp.baileys.service.ts` and `utils/renderStatus.ts`):
- Envelope: `{ event, instance, data, date_time, sender, server_url, apikey }`. `event` is lowercase with dots (`messages.upsert`). We also accept the `MESSAGES_UPSERT` form.
- `messages.upsert` `data` is the Baileys `WAMessage` after Evolution's `prepareMessage`: `{ key{remoteJid, fromMe, id, remoteJidAlt?, senderPn?, participant?, addressingMode?}, pushName, status, message, contextInfo, messageType, messageTimestamp, instanceId, source }`. Evolution converts a Long `messageTimestamp` to a number, but we still accept a number, a numeric string or `{low, high}`. When `remoteJid` is `@lid` and `remoteJidAlt` exists, Evolution may already have replaced `remoteJid` with the phone JID. Older Baileys builds send `senderPn` instead of `remoteJidAlt`.
- `messages.update` `data` is `{ messageId (Evolution DB id), keyId, remoteJid, fromMe, participant, status, instanceId }`. `status` is one of `ERROR | PENDING | SERVER_ACK | DELIVERY_ACK | READ | PLAYED`, plus `DELETED` on deletes.
- `connection.update` `data` is `{ instance, state: 'open'|'connecting'|'close', statusReason, wuid?, profileName? }`.
- `qrcode.updated` `data` is `{ qrcode: { instance, pairingCode, code, base64 } }`.

Classification rules (spec §5.1 step 2):
- **Ignored:** `@g.us` groups, `@broadcast` (including `status@broadcast`), `protocolMessage` (revoke/edit), `editedMessage`, messages with no content, unknown events, our own reactions sent from the phone, statuses for inbound messages (`fromMe=false`), `PENDING`/`DELETED` statuses, and JIDs with no phone or LID (for example newsletters).
- **Not decided here:** echoes of messages that the system sent itself. Those arrive as normal `direction: 'out'` messages, and Task 9 drops them by `external_id`.
- **`fromMe=true`:** `direction: 'out'` and `pushName: null`. On `fromMe` messages, Evolution's `pushName` is the office's own name, so it must never overwrite the contact's name.
- **Address:** `phone` is the first non-null `phoneFromJid` over `[remoteJid, remoteJidAlt, senderPn]`, and `lid` is the first non-null `lidFromJid` over the same list. This handles three cases: LID primary with a phone alternate, phone primary with a LID alternate (Baileys 7), and LID only.
- **`raw`:** `{ key, message }`. This is the minimal WAMessage that `gateway.downloadMedia(instance, raw)` (Task 4) wraps as `{ message: raw }` for `POST /chat/getBase64FromMediaMessage/{instance}`.
- **Unsupported content** (location, contact card, poll, and so on): `kind: 'unsupported'`, `body: null`, `hasMedia: false`.
- **Timestamp:** a missing or invalid `messageTimestamp` becomes `sentAt = now`.

**Files:**
- Create: `server/src/whatsapp/parse.ts`
- Create: `server/test/whatsapp/parse.test.ts`
- Create: `server/test/fixtures/evolution/` with these 26 files: `text-in.json`, `text-reply-in.json`, `ephemeral-text-in.json`, `image-in.json`, `audio-in.json`, `video-in.json`, `document-in.json`, `sticker-in.json`, `location-in.json`, `from-phone-out.json`, `lid-alt-in.json`, `lid-sender-pn-in.json`, `lid-only-in.json`, `pn-lid-alt-in.json`, `group.json`, `status-broadcast.json`, `protocol-revoke.json`, `edited.json`, `unknown-event.json`, `status-inbound.json`, `reaction.json`, `reaction-removed.json`, `status-delivered.json`, `status-read.json`, `connection-open.json`, `qrcode.json`

**Interfaces:**
- Consumes:
  - From Task 3 (`server/src/whatsapp/phone.ts`):
    - `phoneFromJid(jid: string): string | null`: `…@s.whatsapp.net` becomes the canonical 13-digit phone; anything else returns null.
    - `lidFromJid(jid: string): string | null`.
  - From Task 4 (`server/src/whatsapp/types.ts`): `InboundEvent`, `MessageKind`, `ChannelStatus`, exactly as in the contract.
- Produces:
  - `server/src/whatsapp/parse.ts`: `export function parseEvolutionWebhook(body: unknown): InboundEvent[]`. It never throws and always returns at least one element. `type: 'ignored'` events carry a short English `reason` for logs and never contain the message body.
  - Task 9 (ingest/webhook route) consumes it.
  - Fixtures in `server/test/fixtures/evolution/*.json` (instance `talk-test`, contact JID `556599999999@s.whatsapp.net`, LID `201234567890123@lid`, our sent message id `MSG-OUT-0001`). Task 9 may reuse them.

- [ ] **Step 1: Create the synthetic fixtures**

All data is fake. Every file is a full Evolution webhook body.

`server/test/fixtures/evolution/text-in.json` (12-digit JID without the 9; numeric timestamp):
```json
{
  "event": "messages.upsert",
  "instance": "talk-test",
  "data": {
    "key": { "remoteJid": "556599999999@s.whatsapp.net", "fromMe": false, "id": "MSG-TEXT-IN" },
    "pushName": "Maria Teste",
    "status": "DELIVERY_ACK",
    "message": { "conversation": "Olá, preciso de ajuda", "messageContextInfo": { "deviceListMetadataVersion": 2 } },
    "messageType": "conversation",
    "messageTimestamp": 1760440000,
    "instanceId": "00000000-0000-4000-8000-000000000001",
    "source": "android"
  },
  "date_time": "2025-10-14T11:06:40.000Z",
  "sender": "556500000000@s.whatsapp.net",
  "server_url": "http://evolution:8080",
  "apikey": "chave-falsa-da-instancia"
}
```

`server/test/fixtures/evolution/text-reply-in.json` (uppercase event name; string timestamp; quoted reply):
```json
{
  "event": "MESSAGES_UPSERT",
  "instance": "talk-test",
  "data": {
    "key": { "remoteJid": "556599999999@s.whatsapp.net", "fromMe": false, "id": "MSG-REPLY-IN" },
    "pushName": "Maria Teste",
    "status": "DELIVERY_ACK",
    "message": {
      "extendedTextMessage": {
        "text": "Sobre isso aqui",
        "contextInfo": {
          "stanzaId": "MSG-OUT-0001",
          "participant": "556500000000@s.whatsapp.net",
          "quotedMessage": { "conversation": "Bom dia! Como podemos ajudar?" }
        }
      }
    },
    "contextInfo": {
      "stanzaId": "MSG-OUT-0001",
      "participant": "556500000000@s.whatsapp.net",
      "quotedMessage": { "conversation": "Bom dia! Como podemos ajudar?" }
    },
    "messageType": "extendedTextMessage",
    "messageTimestamp": "1760440000",
    "instanceId": "00000000-0000-4000-8000-000000000001",
    "source": "ios"
  },
  "date_time": "2025-10-14T11:06:40.000Z",
  "sender": "556500000000@s.whatsapp.net",
  "server_url": "http://evolution:8080",
  "apikey": "chave-falsa-da-instancia"
}
```

`server/test/fixtures/evolution/ephemeral-text-in.json` (disappearing-message wrapper):
```json
{
  "event": "messages.upsert",
  "instance": "talk-test",
  "data": {
    "key": { "remoteJid": "556599999999@s.whatsapp.net", "fromMe": false, "id": "MSG-EPHEMERAL-IN" },
    "pushName": "Maria Teste",
    "status": "DELIVERY_ACK",
    "message": {
      "ephemeralMessage": {
        "message": { "extendedTextMessage": { "text": "Mensagem temporária", "contextInfo": { "expiration": 604800 } } }
      }
    },
    "messageType": "ephemeralMessage",
    "messageTimestamp": 1760440000,
    "instanceId": "00000000-0000-4000-8000-000000000001",
    "source": "android"
  },
  "date_time": "2025-10-14T11:06:40.000Z",
  "sender": "556500000000@s.whatsapp.net",
  "server_url": "http://evolution:8080",
  "apikey": "chave-falsa-da-instancia"
}
```

`server/test/fixtures/evolution/image-in.json` (Long timestamp `{low, high}`):
```json
{
  "event": "messages.upsert",
  "instance": "talk-test",
  "data": {
    "key": { "remoteJid": "556599999999@s.whatsapp.net", "fromMe": false, "id": "MSG-IMAGE-IN" },
    "pushName": "Maria Teste",
    "status": "DELIVERY_ACK",
    "message": {
      "messageContextInfo": { "deviceListMetadataVersion": 2 },
      "imageMessage": {
        "url": "https://mmg.whatsapp.net/v/t62.0-24/fake.enc",
        "mimetype": "image/jpeg",
        "caption": "Foto do documento",
        "fileLength": "12345",
        "height": 800,
        "width": 600,
        "mediaKey": "ZmFrZS1tZWRpYS1rZXk=",
        "directPath": "/v/t62.0-24/fake.enc"
      }
    },
    "messageType": "imageMessage",
    "messageTimestamp": { "low": 1760440000, "high": 0, "unsigned": false },
    "instanceId": "00000000-0000-4000-8000-000000000001",
    "source": "android"
  },
  "date_time": "2025-10-14T11:06:40.000Z",
  "sender": "556500000000@s.whatsapp.net",
  "server_url": "http://evolution:8080",
  "apikey": "chave-falsa-da-instancia"
}
```

`server/test/fixtures/evolution/audio-in.json`:
```json
{
  "event": "messages.upsert",
  "instance": "talk-test",
  "data": {
    "key": { "remoteJid": "556599999999@s.whatsapp.net", "fromMe": false, "id": "MSG-AUDIO-IN" },
    "pushName": "Maria Teste",
    "status": "DELIVERY_ACK",
    "message": {
      "audioMessage": {
        "url": "https://mmg.whatsapp.net/v/t62.0-24/fake-audio.enc",
        "mimetype": "audio/ogg; codecs=opus",
        "seconds": 7,
        "ptt": true,
        "mediaKey": "ZmFrZS1tZWRpYS1rZXk="
      }
    },
    "messageType": "audioMessage",
    "messageTimestamp": 1760440000,
    "instanceId": "00000000-0000-4000-8000-000000000001",
    "source": "android"
  },
  "date_time": "2025-10-14T11:06:40.000Z",
  "sender": "556500000000@s.whatsapp.net",
  "server_url": "http://evolution:8080",
  "apikey": "chave-falsa-da-instancia"
}
```

`server/test/fixtures/evolution/video-in.json` (an empty caption becomes `body: null`):
```json
{
  "event": "messages.upsert",
  "instance": "talk-test",
  "data": {
    "key": { "remoteJid": "556599999999@s.whatsapp.net", "fromMe": false, "id": "MSG-VIDEO-IN" },
    "pushName": "Maria Teste",
    "status": "DELIVERY_ACK",
    "message": {
      "videoMessage": {
        "url": "https://mmg.whatsapp.net/v/t62.0-24/fake-video.enc",
        "mimetype": "video/mp4",
        "caption": "",
        "seconds": 12,
        "mediaKey": "ZmFrZS1tZWRpYS1rZXk="
      }
    },
    "messageType": "videoMessage",
    "messageTimestamp": 1760440000,
    "instanceId": "00000000-0000-4000-8000-000000000001",
    "source": "android"
  },
  "date_time": "2025-10-14T11:06:40.000Z",
  "sender": "556500000000@s.whatsapp.net",
  "server_url": "http://evolution:8080",
  "apikey": "chave-falsa-da-instancia"
}
```

`server/test/fixtures/evolution/document-in.json` (document with caption, wrapped):
```json
{
  "event": "messages.upsert",
  "instance": "talk-test",
  "data": {
    "key": { "remoteJid": "556599999999@s.whatsapp.net", "fromMe": false, "id": "MSG-DOC-IN" },
    "pushName": "Maria Teste",
    "status": "DELIVERY_ACK",
    "message": {
      "documentWithCaptionMessage": {
        "message": {
          "documentMessage": {
            "url": "https://mmg.whatsapp.net/v/t62.0-24/fake-doc.enc",
            "mimetype": "application/pdf",
            "fileName": "contrato.pdf",
            "caption": "Segue o contrato",
            "fileLength": "54321",
            "mediaKey": "ZmFrZS1tZWRpYS1rZXk="
          }
        }
      }
    },
    "messageType": "documentWithCaptionMessage",
    "messageTimestamp": 1760440000,
    "instanceId": "00000000-0000-4000-8000-000000000001",
    "source": "android"
  },
  "date_time": "2025-10-14T11:06:40.000Z",
  "sender": "556500000000@s.whatsapp.net",
  "server_url": "http://evolution:8080",
  "apikey": "chave-falsa-da-instancia"
}
```

`server/test/fixtures/evolution/sticker-in.json`:
```json
{
  "event": "messages.upsert",
  "instance": "talk-test",
  "data": {
    "key": { "remoteJid": "556599999999@s.whatsapp.net", "fromMe": false, "id": "MSG-STICKER-IN" },
    "pushName": "Maria Teste",
    "status": "DELIVERY_ACK",
    "message": {
      "stickerMessage": {
        "url": "https://mmg.whatsapp.net/v/t62.0-24/fake-sticker.enc",
        "mimetype": "image/webp",
        "isAnimated": false,
        "mediaKey": "ZmFrZS1tZWRpYS1rZXk="
      }
    },
    "messageType": "stickerMessage",
    "messageTimestamp": 1760440000,
    "instanceId": "00000000-0000-4000-8000-000000000001",
    "source": "android"
  },
  "date_time": "2025-10-14T11:06:40.000Z",
  "sender": "556500000000@s.whatsapp.net",
  "server_url": "http://evolution:8080",
  "apikey": "chave-falsa-da-instancia"
}
```

`server/test/fixtures/evolution/location-in.json` (unsupported content):
```json
{
  "event": "messages.upsert",
  "instance": "talk-test",
  "data": {
    "key": { "remoteJid": "556599999999@s.whatsapp.net", "fromMe": false, "id": "MSG-LOCATION-IN" },
    "pushName": "Maria Teste",
    "status": "DELIVERY_ACK",
    "message": { "locationMessage": { "degreesLatitude": -15.6, "degreesLongitude": -56.1 } },
    "messageType": "locationMessage",
    "messageTimestamp": 1760440000,
    "instanceId": "00000000-0000-4000-8000-000000000001",
    "source": "android"
  },
  "date_time": "2025-10-14T11:06:40.000Z",
  "sender": "556500000000@s.whatsapp.net",
  "server_url": "http://evolution:8080",
  "apikey": "chave-falsa-da-instancia"
}
```

`server/test/fixtures/evolution/from-phone-out.json` (the office typed on the physical phone):
```json
{
  "event": "messages.upsert",
  "instance": "talk-test",
  "data": {
    "key": { "remoteJid": "556599999999@s.whatsapp.net", "fromMe": true, "id": "MSG-PHONE-OUT" },
    "pushName": "Escritório Teste",
    "status": "SERVER_ACK",
    "message": { "conversation": "Respondi pelo celular" },
    "messageType": "conversation",
    "messageTimestamp": 1760440000,
    "instanceId": "00000000-0000-4000-8000-000000000001",
    "source": "android"
  },
  "date_time": "2025-10-14T11:06:40.000Z",
  "sender": "556500000000@s.whatsapp.net",
  "server_url": "http://evolution:8080",
  "apikey": "chave-falsa-da-instancia"
}
```

`server/test/fixtures/evolution/lid-alt-in.json` (LID primary, phone in `remoteJidAlt`):
```json
{
  "event": "messages.upsert",
  "instance": "talk-test",
  "data": {
    "key": {
      "remoteJid": "201234567890123@lid",
      "remoteJidAlt": "556599999999@s.whatsapp.net",
      "addressingMode": "lid",
      "fromMe": false,
      "id": "MSG-LID-ALT-IN"
    },
    "pushName": "Maria Teste",
    "status": "DELIVERY_ACK",
    "message": { "conversation": "Oi pelo LID" },
    "messageType": "conversation",
    "messageTimestamp": 1760440000,
    "instanceId": "00000000-0000-4000-8000-000000000001",
    "source": "android"
  },
  "date_time": "2025-10-14T11:06:40.000Z",
  "sender": "556500000000@s.whatsapp.net",
  "server_url": "http://evolution:8080",
  "apikey": "chave-falsa-da-instancia"
}
```

`server/test/fixtures/evolution/lid-sender-pn-in.json` (LID primary, phone in `senderPn`, older Baileys):
```json
{
  "event": "messages.upsert",
  "instance": "talk-test",
  "data": {
    "key": {
      "remoteJid": "201234567890123@lid",
      "senderPn": "556599999999@s.whatsapp.net",
      "fromMe": false,
      "id": "MSG-LID-PN-IN"
    },
    "pushName": "Maria Teste",
    "status": "DELIVERY_ACK",
    "message": { "conversation": "Oi pelo LID com senderPn" },
    "messageType": "conversation",
    "messageTimestamp": 1760440000,
    "instanceId": "00000000-0000-4000-8000-000000000001",
    "source": "android"
  },
  "date_time": "2025-10-14T11:06:40.000Z",
  "sender": "556500000000@s.whatsapp.net",
  "server_url": "http://evolution:8080",
  "apikey": "chave-falsa-da-instancia"
}
```

`server/test/fixtures/evolution/lid-only-in.json` (no phone anywhere):
```json
{
  "event": "messages.upsert",
  "instance": "talk-test",
  "data": {
    "key": { "remoteJid": "201234567890123@lid", "addressingMode": "lid", "fromMe": false, "id": "MSG-LID-ONLY-IN" },
    "pushName": "Maria Teste",
    "status": "DELIVERY_ACK",
    "message": { "conversation": "Só LID" },
    "messageType": "conversation",
    "messageTimestamp": 1760440000,
    "instanceId": "00000000-0000-4000-8000-000000000001",
    "source": "android"
  },
  "date_time": "2025-10-14T11:06:40.000Z",
  "sender": "556500000000@s.whatsapp.net",
  "server_url": "http://evolution:8080",
  "apikey": "chave-falsa-da-instancia"
}
```

`server/test/fixtures/evolution/pn-lid-alt-in.json` (phone primary, LID in `remoteJidAlt`, Baileys 7):
```json
{
  "event": "messages.upsert",
  "instance": "talk-test",
  "data": {
    "key": {
      "remoteJid": "556599999999@s.whatsapp.net",
      "remoteJidAlt": "201234567890123@lid",
      "addressingMode": "pn",
      "fromMe": false,
      "id": "MSG-PN-LID-IN"
    },
    "pushName": "Maria Teste",
    "status": "DELIVERY_ACK",
    "message": { "conversation": "Telefone com LID alternativo" },
    "messageType": "conversation",
    "messageTimestamp": 1760440000,
    "instanceId": "00000000-0000-4000-8000-000000000001",
    "source": "android"
  },
  "date_time": "2025-10-14T11:06:40.000Z",
  "sender": "556500000000@s.whatsapp.net",
  "server_url": "http://evolution:8080",
  "apikey": "chave-falsa-da-instancia"
}
```

`server/test/fixtures/evolution/group.json`:
```json
{
  "event": "messages.upsert",
  "instance": "talk-test",
  "data": {
    "key": {
      "remoteJid": "120363000000000000@g.us",
      "participant": "556599999999@s.whatsapp.net",
      "fromMe": false,
      "id": "MSG-GROUP-IN"
    },
    "pushName": "Maria Teste",
    "status": "DELIVERY_ACK",
    "message": { "conversation": "Mensagem no grupo" },
    "messageType": "conversation",
    "messageTimestamp": 1760440000,
    "instanceId": "00000000-0000-4000-8000-000000000001",
    "source": "android"
  },
  "date_time": "2025-10-14T11:06:40.000Z",
  "sender": "556500000000@s.whatsapp.net",
  "server_url": "http://evolution:8080",
  "apikey": "chave-falsa-da-instancia"
}
```

`server/test/fixtures/evolution/status-broadcast.json`:
```json
{
  "event": "messages.upsert",
  "instance": "talk-test",
  "data": {
    "key": {
      "remoteJid": "status@broadcast",
      "participant": "556599999999@s.whatsapp.net",
      "fromMe": false,
      "id": "MSG-STATUS-BROADCAST"
    },
    "pushName": "Maria Teste",
    "status": "DELIVERY_ACK",
    "message": { "imageMessage": { "mimetype": "image/jpeg", "caption": "Meu status" } },
    "messageType": "imageMessage",
    "messageTimestamp": 1760440000,
    "instanceId": "00000000-0000-4000-8000-000000000001",
    "source": "android"
  },
  "date_time": "2025-10-14T11:06:40.000Z",
  "sender": "556500000000@s.whatsapp.net",
  "server_url": "http://evolution:8080",
  "apikey": "chave-falsa-da-instancia"
}
```

`server/test/fixtures/evolution/protocol-revoke.json` (contact deleted a message):
```json
{
  "event": "messages.upsert",
  "instance": "talk-test",
  "data": {
    "key": { "remoteJid": "556599999999@s.whatsapp.net", "fromMe": false, "id": "MSG-REVOKE-IN" },
    "pushName": "Maria Teste",
    "status": "DELIVERY_ACK",
    "message": {
      "protocolMessage": {
        "key": { "remoteJid": "556500000000@s.whatsapp.net", "fromMe": true, "id": "MSG-TEXT-IN" },
        "type": "REVOKE"
      }
    },
    "messageType": "protocolMessage",
    "messageTimestamp": 1760440000,
    "instanceId": "00000000-0000-4000-8000-000000000001",
    "source": "android"
  },
  "date_time": "2025-10-14T11:06:40.000Z",
  "sender": "556500000000@s.whatsapp.net",
  "server_url": "http://evolution:8080",
  "apikey": "chave-falsa-da-instancia"
}
```

`server/test/fixtures/evolution/edited.json` (contact edited a message):
```json
{
  "event": "messages.upsert",
  "instance": "talk-test",
  "data": {
    "key": { "remoteJid": "556599999999@s.whatsapp.net", "fromMe": false, "id": "MSG-EDIT-IN" },
    "pushName": "Maria Teste",
    "status": "DELIVERY_ACK",
    "message": {
      "editedMessage": {
        "message": {
          "protocolMessage": {
            "key": { "remoteJid": "556500000000@s.whatsapp.net", "fromMe": true, "id": "MSG-TEXT-IN" },
            "type": "MESSAGE_EDIT",
            "editedMessage": { "conversation": "Olá, preciso de ajuda urgente" }
          }
        }
      }
    },
    "messageType": "editedMessage",
    "messageTimestamp": 1760440000,
    "instanceId": "00000000-0000-4000-8000-000000000001",
    "source": "android"
  },
  "date_time": "2025-10-14T11:06:40.000Z",
  "sender": "556500000000@s.whatsapp.net",
  "server_url": "http://evolution:8080",
  "apikey": "chave-falsa-da-instancia"
}
```

`server/test/fixtures/evolution/unknown-event.json`:
```json
{
  "event": "contacts.update",
  "instance": "talk-test",
  "data": [{ "remoteJid": "556599999999@s.whatsapp.net", "pushName": "Maria Teste", "profilePicUrl": null }],
  "date_time": "2025-10-14T11:06:40.000Z",
  "sender": "556500000000@s.whatsapp.net",
  "server_url": "http://evolution:8080",
  "apikey": "chave-falsa-da-instancia"
}
```

`server/test/fixtures/evolution/status-inbound.json` (the office read the contact's message on the phone, so this is not our message):
```json
{
  "event": "messages.update",
  "instance": "talk-test",
  "data": {
    "messageId": "cm0000000000000000000001",
    "keyId": "MSG-TEXT-IN",
    "remoteJid": "556599999999@s.whatsapp.net",
    "fromMe": false,
    "status": "READ",
    "instanceId": "00000000-0000-4000-8000-000000000001"
  },
  "date_time": "2025-10-14T11:06:40.000Z",
  "sender": "556500000000@s.whatsapp.net",
  "server_url": "http://evolution:8080",
  "apikey": "chave-falsa-da-instancia"
}
```

`server/test/fixtures/evolution/reaction.json`:
```json
{
  "event": "messages.upsert",
  "instance": "talk-test",
  "data": {
    "key": { "remoteJid": "556599999999@s.whatsapp.net", "fromMe": false, "id": "MSG-REACTION-IN" },
    "pushName": "Maria Teste",
    "status": "DELIVERY_ACK",
    "message": {
      "reactionMessage": {
        "key": { "remoteJid": "556599999999@s.whatsapp.net", "fromMe": true, "id": "MSG-OUT-0001" },
        "text": "👍",
        "senderTimestampMs": "1760440000000"
      }
    },
    "messageType": "reactionMessage",
    "messageTimestamp": 1760440000,
    "instanceId": "00000000-0000-4000-8000-000000000001",
    "source": "android"
  },
  "date_time": "2025-10-14T11:06:40.000Z",
  "sender": "556500000000@s.whatsapp.net",
  "server_url": "http://evolution:8080",
  "apikey": "chave-falsa-da-instancia"
}
```

`server/test/fixtures/evolution/reaction-removed.json` (an empty text means the reaction was removed):
```json
{
  "event": "messages.upsert",
  "instance": "talk-test",
  "data": {
    "key": { "remoteJid": "556599999999@s.whatsapp.net", "fromMe": false, "id": "MSG-REACTION-OFF-IN" },
    "pushName": "Maria Teste",
    "status": "DELIVERY_ACK",
    "message": {
      "reactionMessage": {
        "key": { "remoteJid": "556599999999@s.whatsapp.net", "fromMe": true, "id": "MSG-OUT-0001" },
        "text": "",
        "senderTimestampMs": "1760440060000"
      }
    },
    "messageType": "reactionMessage",
    "messageTimestamp": 1760440060,
    "instanceId": "00000000-0000-4000-8000-000000000001",
    "source": "android"
  },
  "date_time": "2025-10-14T11:07:40.000Z",
  "sender": "556500000000@s.whatsapp.net",
  "server_url": "http://evolution:8080",
  "apikey": "chave-falsa-da-instancia"
}
```

`server/test/fixtures/evolution/status-delivered.json`:
```json
{
  "event": "messages.update",
  "instance": "talk-test",
  "data": {
    "messageId": "cm0000000000000000000002",
    "keyId": "MSG-OUT-0001",
    "remoteJid": "556599999999@s.whatsapp.net",
    "fromMe": true,
    "status": "DELIVERY_ACK",
    "instanceId": "00000000-0000-4000-8000-000000000001"
  },
  "date_time": "2025-10-14T11:06:41.000Z",
  "sender": "556500000000@s.whatsapp.net",
  "server_url": "http://evolution:8080",
  "apikey": "chave-falsa-da-instancia"
}
```

`server/test/fixtures/evolution/status-read.json` (uppercase event name):
```json
{
  "event": "MESSAGES_UPDATE",
  "instance": "talk-test",
  "data": {
    "messageId": "cm0000000000000000000002",
    "keyId": "MSG-OUT-0001",
    "remoteJid": "556599999999@s.whatsapp.net",
    "fromMe": true,
    "status": "READ",
    "instanceId": "00000000-0000-4000-8000-000000000001"
  },
  "date_time": "2025-10-14T11:06:42.000Z",
  "sender": "556500000000@s.whatsapp.net",
  "server_url": "http://evolution:8080",
  "apikey": "chave-falsa-da-instancia"
}
```

`server/test/fixtures/evolution/connection-open.json`:
```json
{
  "event": "connection.update",
  "instance": "talk-test",
  "data": {
    "instance": "talk-test",
    "wuid": "556500000000@s.whatsapp.net",
    "profileName": "Escritório Teste",
    "profilePictureUrl": null,
    "state": "open",
    "statusReason": 200
  },
  "date_time": "2025-10-14T11:06:40.000Z",
  "sender": "556500000000@s.whatsapp.net",
  "server_url": "http://evolution:8080",
  "apikey": "chave-falsa-da-instancia"
}
```

`server/test/fixtures/evolution/qrcode.json`:
```json
{
  "event": "qrcode.updated",
  "instance": "talk-test",
  "data": {
    "qrcode": {
      "instance": "talk-test",
      "pairingCode": null,
      "code": "2@FAKEQRCODE,FAKEKEY1,FAKEKEY2",
      "base64": "data:image/png;base64,iVBORw0KGgo="
    }
  },
  "date_time": "2025-10-14T11:06:40.000Z",
  "server_url": "http://evolution:8080",
  "apikey": "chave-falsa-da-instancia"
}
```

- [ ] **Step 2: Write the failing test**

`server/test/whatsapp/parse.test.ts`:
```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseEvolutionWebhook } from '../../src/whatsapp/parse.js';
import { lidFromJid } from '../../src/whatsapp/phone.js';
import type { InboundEvent } from '../../src/whatsapp/types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fixture = (name: string): any =>
  JSON.parse(readFileSync(new URL(`../fixtures/evolution/${name}.json`, import.meta.url), 'utf8'));

const INSTANCE = 'talk-test';
const PHONE = '5565999999999'; // fixtures carry the 12-digit JID 556599999999@s.whatsapp.net
const LID = lidFromJid('201234567890123@lid');
const T = new Date(1760440000 * 1000);

describe('parseEvolutionWebhook — content messages', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['text-in', {
      externalId: 'MSG-TEXT-IN', direction: 'in', phone: PHONE, lid: null, pushName: 'Maria Teste',
      kind: 'text', body: 'Olá, preciso de ajuda', hasMedia: false, mediaMime: null, mediaName: null,
      replyToExternalId: null, sentAt: T,
    }],
    ['text-reply-in', { externalId: 'MSG-REPLY-IN', kind: 'text', body: 'Sobre isso aqui', replyToExternalId: 'MSG-OUT-0001', sentAt: T }],
    ['ephemeral-text-in', { externalId: 'MSG-EPHEMERAL-IN', kind: 'text', body: 'Mensagem temporária', hasMedia: false }],
    ['image-in', { externalId: 'MSG-IMAGE-IN', kind: 'image', body: 'Foto do documento', hasMedia: true, mediaMime: 'image/jpeg', mediaName: null, sentAt: T }],
    ['audio-in', { externalId: 'MSG-AUDIO-IN', kind: 'audio', body: null, hasMedia: true, mediaMime: 'audio/ogg; codecs=opus' }],
    ['video-in', { externalId: 'MSG-VIDEO-IN', kind: 'video', body: null, hasMedia: true, mediaMime: 'video/mp4' }],
    ['document-in', { externalId: 'MSG-DOC-IN', kind: 'document', body: 'Segue o contrato', hasMedia: true, mediaMime: 'application/pdf', mediaName: 'contrato.pdf' }],
    ['sticker-in', { externalId: 'MSG-STICKER-IN', kind: 'sticker', body: null, hasMedia: true, mediaMime: 'image/webp' }],
    ['location-in', { externalId: 'MSG-LOCATION-IN', kind: 'unsupported', body: null, hasMedia: false, mediaMime: null }],
    ['from-phone-out', { externalId: 'MSG-PHONE-OUT', direction: 'out', phone: PHONE, pushName: null, kind: 'text', body: 'Respondi pelo celular' }],
    ['lid-alt-in', { externalId: 'MSG-LID-ALT-IN', direction: 'in', phone: PHONE, lid: LID, pushName: 'Maria Teste' }],
    ['lid-sender-pn-in', { externalId: 'MSG-LID-PN-IN', phone: PHONE, lid: LID }],
    ['lid-only-in', { externalId: 'MSG-LID-ONLY-IN', phone: null, lid: LID }],
    ['pn-lid-alt-in', { externalId: 'MSG-PN-LID-IN', phone: PHONE, lid: LID }],
  ];

  it.each(cases)('%s', (name, expected) => {
    const events = parseEvolutionWebhook(fixture(name));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'message', instance: INSTANCE, ...expected });
  });

  it('keeps { key, message } as raw for media download', () => {
    const body = fixture('image-in');
    const [event] = parseEvolutionWebhook(body);
    expect(event).toMatchObject({ type: 'message', raw: { key: body.data.key, message: body.data.message } });
  });

  it('uses now when messageTimestamp is missing', () => {
    const body = fixture('text-in');
    delete body.data.messageTimestamp;
    const [event] = parseEvolutionWebhook(body);
    if (event.type !== 'message') throw new Error('expected message');
    expect(Math.abs(event.sentAt.getTime() - Date.now())).toBeLessThan(5000);
  });

  it('parses every item when data is an array', () => {
    const a = fixture('text-in');
    const b = fixture('image-in');
    const events = parseEvolutionWebhook({ ...a, data: [a.data, b.data] });
    expect(events.map((e) => (e.type === 'message' ? e.externalId : e.type))).toEqual(['MSG-TEXT-IN', 'MSG-IMAGE-IN']);
  });
});

describe('parseEvolutionWebhook — reactions, statuses, connection, qrcode', () => {
  const cases: Array<[string, InboundEvent]> = [
    ['reaction', { type: 'reaction', instance: INSTANCE, targetExternalId: 'MSG-OUT-0001', emoji: '👍' }],
    ['reaction-removed', { type: 'reaction', instance: INSTANCE, targetExternalId: 'MSG-OUT-0001', emoji: null }],
    ['status-delivered', { type: 'status', instance: INSTANCE, externalId: 'MSG-OUT-0001', status: 'delivered' }],
    ['status-read', { type: 'status', instance: INSTANCE, externalId: 'MSG-OUT-0001', status: 'read' }],
    ['connection-open', { type: 'connection', instance: INSTANCE, status: 'connected' }],
    ['qrcode', { type: 'qrcode', instance: INSTANCE, qrBase64: 'data:image/png;base64,iVBORw0KGgo=' }],
  ];

  it.each(cases)('%s', (name, expected) => {
    expect(parseEvolutionWebhook(fixture(name))).toEqual([expected]);
  });

  it.each([
    ['SERVER_ACK', 'sent'],
    ['DELIVERY_ACK', 'delivered'],
    ['READ', 'read'],
    ['PLAYED', 'read'],
    ['ERROR', 'failed'],
  ])('maps status %s to %s', (raw, status) => {
    const body = fixture('status-delivered');
    body.data.status = raw;
    expect(parseEvolutionWebhook(body)).toEqual([{ type: 'status', instance: INSTANCE, externalId: 'MSG-OUT-0001', status }]);
  });

  it.each(['PENDING', 'DELETED', 'constructor'])('ignores status %s', (raw) => {
    const body = fixture('status-delivered');
    body.data.status = raw;
    expect(parseEvolutionWebhook(body)).toMatchObject([{ type: 'ignored' }]);
  });

  it.each([
    ['open', 'connected'],
    ['connecting', 'connecting'],
    ['close', 'disconnected'],
  ])('maps connection state %s to %s', (state, status) => {
    const body = fixture('connection-open');
    body.data.state = state;
    expect(parseEvolutionWebhook(body)).toEqual([{ type: 'connection', instance: INSTANCE, status }]);
  });

  it('ignores an unknown connection state', () => {
    const body = fixture('connection-open');
    body.data.state = 'refused';
    expect(parseEvolutionWebhook(body)).toMatchObject([{ type: 'ignored' }]);
  });
});

describe('parseEvolutionWebhook — ignored', () => {
  const cases: Array<[string, string]> = [
    ['group', 'group'],
    ['status-broadcast', 'broadcast'],
    ['protocol-revoke', 'protocol'],
    ['edited', 'edit'],
    ['unknown-event', 'event contacts.update'],
    ['status-inbound', 'status of inbound message'],
  ];

  it.each(cases)('%s', (name, reason) => {
    expect(parseEvolutionWebhook(fixture(name))).toEqual([{ type: 'ignored', reason }]);
  });

  it('ignores a reaction the office sent from the phone', () => {
    const body = fixture('reaction');
    body.data.key.fromMe = true;
    expect(parseEvolutionWebhook(body)).toEqual([{ type: 'ignored', reason: 'own reaction' }]);
  });

  it('ignores a message with only metadata (no content)', () => {
    const body = fixture('text-in');
    body.data.message = { messageContextInfo: { deviceListMetadataVersion: 2 } };
    expect(parseEvolutionWebhook(body)).toEqual([{ type: 'ignored', reason: 'empty message' }]);
  });

  it('ignores a JID that is neither phone nor LID', () => {
    const body = fixture('text-in');
    body.data.key.remoteJid = '120363000000000001@newsletter';
    expect(parseEvolutionWebhook(body)).toEqual([{ type: 'ignored', reason: 'no address' }]);
  });

  it.each([
    ['null', null],
    ['string', 'texto'],
    ['number', 42],
    ['empty object', {}],
    ['no instance', { event: 'messages.upsert', data: {} }],
    ['no data', { event: 'messages.upsert', instance: 'talk-test' }],
    ['key without id', { event: 'messages.upsert', instance: 'talk-test', data: { key: { remoteJid: '556599999999@s.whatsapp.net' }, message: { conversation: 'x' } } }],
  ])('never throws on malformed payload: %s', (_label, body) => {
    const events = parseEvolutionWebhook(body);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('ignored');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -w server -- test/whatsapp/parse.test.ts`
Expected: FAIL. Vitest cannot resolve `../../src/whatsapp/parse.js` because the module does not exist yet.

- [ ] **Step 4: Write the implementation**

`server/src/whatsapp/parse.ts`:
```ts
import { lidFromJid, phoneFromJid } from './phone.js';
import type { ChannelStatus, InboundEvent, MessageKind } from './types.js';

// Evolution payloads are untrusted JSON: read loosely, check every field we use, never throw.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const ignored = (reason: string): InboundEvent => ({ type: 'ignored', reason });

/** Containers Baileys wraps around the real content. */
const WRAPPERS = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'documentWithCaptionMessage'];
/** Keys that travel next to the content but are not content. */
const META = new Set(['messageContextInfo', 'senderKeyDistributionMessage', 'base64', 'mediaUrl']);
// Maps (not object literals) so untrusted keys like "constructor" never hit the prototype.
const MEDIA = new Map<string, MessageKind>([
  ['imageMessage', 'image'],
  ['videoMessage', 'video'],
  ['ptvMessage', 'video'],
  ['audioMessage', 'audio'],
  ['documentMessage', 'document'],
  ['stickerMessage', 'sticker'],
]);
const STATUS = new Map<string, 'sent' | 'delivered' | 'read' | 'failed'>([
  ['SERVER_ACK', 'sent'],
  ['DELIVERY_ACK', 'delivered'],
  ['READ', 'read'],
  ['PLAYED', 'read'],
  ['ERROR', 'failed'],
]);
const CONNECTION = new Map<string, ChannelStatus>([
  ['open', 'connected'],
  ['connecting', 'connecting'],
  ['close', 'disconnected'],
]);

export function parseEvolutionWebhook(body: unknown): InboundEvent[] {
  if (!isObj(body) || typeof body.event !== 'string') return [ignored('invalid payload')];
  const instance = str(body.instance);
  if (!instance) return [ignored('missing instance')];
  const event = body.event.toLowerCase().replace(/_/g, '.');
  const items: unknown[] = Array.isArray(body.data) ? body.data : [body.data];
  if (items.length === 0) return [ignored('empty data')];
  switch (event) {
    case 'messages.upsert':
      return items.map((d) => parseUpsert(instance, d));
    case 'messages.update':
      return items.map((d) => parseUpdate(instance, d));
    case 'connection.update':
      return [parseConnection(instance, body.data)];
    case 'qrcode.updated':
      return [parseQrCode(instance, body.data)];
    default:
      return [ignored(`event ${event}`)];
  }
}

function unwrap(m: unknown): Obj | null {
  if (!isObj(m)) return null;
  for (const w of WRAPPERS) if (isObj(m[w]?.message)) return unwrap(m[w].message);
  return m;
}

/** Baileys timestamps are seconds: number, numeric string or Long {low, high}. */
function toDate(ts: unknown): Date {
  const n = isObj(ts) ? Number(ts.high ?? 0) * 2 ** 32 + (Number(ts.low ?? 0) >>> 0) : Number(ts);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : new Date();
}

function parseUpsert(instance: string, data: unknown): InboundEvent {
  if (!isObj(data) || !isObj(data.key)) return ignored('invalid message');
  const key = data.key;
  const remoteJid = str(key.remoteJid) ?? '';
  if (remoteJid.endsWith('@g.us')) return ignored('group');
  if (remoteJid.endsWith('@broadcast')) return ignored('broadcast');
  const externalId = str(key.id);
  if (!externalId) return ignored('missing id');
  const fromMe = key.fromMe === true;

  const msg = unwrap(data.message);
  if (!msg || !Object.keys(msg).some((k) => !META.has(k))) return ignored('empty message');
  if (msg.protocolMessage) return ignored('protocol');
  if (msg.editedMessage) return ignored('edit');
  if (isObj(msg.reactionMessage)) {
    // The office reacting from the phone would overwrite the contact's reaction (one slot per message).
    if (fromMe) return ignored('own reaction');
    const target = str(msg.reactionMessage.key?.id);
    if (!target) return ignored('invalid reaction');
    return { type: 'reaction', instance, targetExternalId: target, emoji: str(msg.reactionMessage.text) };
  }

  let kind: MessageKind = 'unsupported';
  let part: Obj = {};
  let body: string | null = null;
  const mediaKey = [...MEDIA.keys()].find((k) => isObj(msg[k]));
  if (typeof msg.conversation === 'string') {
    kind = 'text';
    body = msg.conversation;
  } else if (isObj(msg.extendedTextMessage)) {
    kind = 'text';
    part = msg.extendedTextMessage;
    body = str(part.text);
  } else if (mediaKey) {
    kind = MEDIA.get(mediaKey) ?? 'unsupported';
    part = msg[mediaKey];
    body = str(part.caption);
  }
  const hasMedia = kind !== 'text' && kind !== 'unsupported';

  const jids = [remoteJid, key.remoteJidAlt, key.senderPn].filter((j): j is string => typeof j === 'string');
  const phone = jids.map((j) => phoneFromJid(j)).find((p) => p !== null) ?? null;
  const lid = jids.map((j) => lidFromJid(j)).find((l) => l !== null) ?? null;
  if (!phone && !lid) return ignored('no address');

  return {
    type: 'message',
    instance,
    externalId,
    direction: fromMe ? 'out' : 'in',
    phone,
    lid,
    // On fromMe, Evolution's pushName is the office's own name — never use it as the contact's name.
    pushName: fromMe ? null : str(data.pushName),
    kind,
    body,
    hasMedia,
    mediaMime: hasMedia ? str(part.mimetype) : null,
    mediaName: kind === 'document' ? str(part.fileName) : null,
    replyToExternalId: str(part.contextInfo?.stanzaId) ?? (isObj(data.contextInfo) ? str(data.contextInfo.stanzaId) : null),
    sentAt: toDate(data.messageTimestamp),
    raw: { key, message: data.message },
  };
}

function parseUpdate(instance: string, data: unknown): InboundEvent {
  if (!isObj(data)) return ignored('invalid update');
  const key = isObj(data.key) ? data.key : {};
  const remoteJid = str(data.remoteJid ?? key.remoteJid) ?? '';
  if (remoteJid.endsWith('@g.us') || remoteJid.endsWith('@broadcast')) return ignored('group status');
  // Statuses only matter for messages we sent; READ on an inbound message means the office read it on the phone.
  if ((data.fromMe ?? key.fromMe) === false) return ignored('status of inbound message');
  const externalId = str(data.keyId) ?? str(key.id);
  if (!externalId) return ignored('missing id');
  const status = STATUS.get(String(data.status));
  return status ? { type: 'status', instance, externalId, status } : ignored(`status ${String(data.status)}`);
}

function parseConnection(instance: string, data: unknown): InboundEvent {
  const status = isObj(data) ? CONNECTION.get(String(data.state)) : undefined;
  return status ? { type: 'connection', instance, status } : ignored('unknown connection state');
}

function parseQrCode(instance: string, data: unknown): InboundEvent {
  const qrBase64 = isObj(data) && isObj(data.qrcode) ? str(data.qrcode.base64) : null;
  return qrBase64 ? { type: 'qrcode', instance, qrBase64 } : ignored('qrcode without image');
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -w server -- test/whatsapp/parse.test.ts`
Expected: PASS. Every case in the three `describe` blocks is green.

- [ ] **Step 6: Typecheck**

Run: `npx tsc -p server/tsconfig.json --noEmit`
Expected: exits 0 with no errors. Vitest does not typecheck, and this step confirms the returned objects match the `InboundEvent` union.

- [ ] **Step 7: Commit**

```bash
git add server/src/whatsapp/parse.ts server/test/whatsapp/parse.test.ts server/test/fixtures/evolution
git commit -m "feat(whatsapp): parse Evolution v2.3.7 webhooks into inbound events

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


---

### Task 6: Authentication, sessions, origin check, users seed

Implements spec §6 "Senhas e sessão", "CSRF" and "Login": argon2id passwords, opaque session tokens stored as SHA-256 in `sessions`, 30-day sliding expiry, `sid` cookie, a global Origin check, a login limited to 5 tries/min per IP+email, and a CLI that creates the first admin. It also adds the HTTP test helpers (`makeTestApp`, `loginAs`) that every later server route task uses.

**Files:**
- Create: `server/src/auth/password.ts`
- Create: `server/src/auth/sessions.ts`
- Create: `server/src/auth/plugin.ts`
- Create: `server/src/auth/routes.ts`
- Create: `server/src/auth/seed-admin.ts`
- Create (or overwrite if Task 2 left a type-only stub): `server/src/inbox/visibility.ts` (Task 6 writes `AuthUser` + `loadAuthUser`; Task 7 appends `ChatVisibilityFields`, `canSee`, `visibleChatsWhere`)
- Modify: `server/src/app.ts` (register rate-limit, auth plugin, auth routes; cookie is already registered by Task 1)
- Modify: `server/test/helpers.ts` (real password hashes in `seedBasics`; add `TEST_ORIGIN`, `testPasswordHash`, `makeTestApp`, `loginAs`)
- Modify: `server/package.json` (dependencies + `seed:admin` script)
- Test: `server/test/auth/password.test.ts`
- Test: `server/test/auth/sessions.test.ts`
- Test: `server/test/auth/routes.test.ts`
- Test: `server/test/auth/seed-admin.test.ts`

**Interfaces:**
- Consumes:
  - `AppCtx` (`server/src/ctx.ts`): `{ db: Db; wa; hub; config: Config }`; uses `config.appOrigin`, `config.cookieSecure`, `config.sessionDays`.
  - `Db`, `Tx`, `createPgDb(url: string): Db` from `server/src/db/client.ts` (Task 2).
  - Schema tables `users` (`id, name, email, passwordHash, role, signature, active, createdAt`), `sessions` (`id` text = SHA-256 hex, `userId`, `expiresAt`, `createdAt`), `userSectors` (`userId, sectorId`) from `server/src/db/schema.ts` (Task 2).
  - `HttpError`, `forbidden`, `badRequest`, `conflict` from `server/src/lib/http-error.ts` (Task 1). `buildApp(ctx)` from `server/src/app.ts` (Task 1) with its error handler (`HttpError` → `{ error }` + status, zod → 400).
  - `makeTestCtx()`, `seedBasics(ctx)`, `TEST_PASSWORD` from `server/test/helpers.ts` (Task 2).
- Produces:
  - `server/src/auth/password.ts`: `hashPassword(plain: string): Promise<string>`; `verifyPassword(hash: string, plain: string): Promise<boolean>` (never throws; malformed hash → `false`).
  - `server/src/auth/sessions.ts`: `createSession(db: Db | Tx, userId: string, days = 30): Promise<string>` (returns the raw token); `getSessionUser(db: Db | Tx, rawToken: string, days = 30): Promise<AuthUser | null>` (null if unknown/expired/user inactive; on success pushes `expiresAt` to now + `days`); `deleteSession(db: Db | Tx, rawToken: string): Promise<void>`; `deleteUserSessions(db: Db | Tx, userId: string): Promise<void>`.
  - `server/src/inbox/visibility.ts`: `interface AuthUser { id; name; email; role: 'admin' | 'agent'; signature: string | null; sectorIds: string[] }`; `loadAuthUser(db: Db | Tx, userId: string): Promise<AuthUser | null>` (does not filter by `active`).
  - `server/src/auth/plugin.ts`: `SESSION_COOKIE = 'sid'`; `authPlugin` (Fastify plugin, options `{ ctx: AppCtx }`, not encapsulated) which decorates `request.user: AuthUser` (typed non-null: inside any `/api/*` handler other than login/health it is always set), loads the user from the `sid` cookie on every `/api/*` and `/ws` request, answers 401 **before the handler** to every `/api/*` request without a valid session except `POST /api/auth/login` and `GET /api/health` (`/ws` is left to Task 8, which answers 401 itself), and rejects with 403 every non-GET/HEAD `/api/*` request **and every `/ws` request** whose `Origin` header is not exactly `config.appOrigin`; `requireUser(req): Promise<void>` (401) and `requireAdmin(req): Promise<void>` (401/403) for `preHandler`; `authUser(req): AuthUser` (returns the non-null user or throws 401) for use inside handlers.
  - `server/src/auth/routes.ts`: `authRoutes` (Fastify plugin, options `{ ctx: AppCtx }`): `POST /api/auth/login` → `Me`, `POST /api/auth/logout` → 204, `GET /api/auth/me` → `Me`.
  - `server/src/auth/seed-admin.ts`: `seedAdmin(db: Db, input: { email: string; name: string; password: string }): Promise<AuthUser>`; CLI `npm run seed:admin -w server -- --email x --name y` (password from `SEED_ADMIN_PASSWORD` or a prompt).
  - `server/test/helpers.ts`: `TEST_ORIGIN = 'http://localhost:5173'`, `testPasswordHash(): Promise<string>`, `makeTestApp(ctx?: AppCtx): Promise<{ app: FastifyInstance; ctx: AppCtx }>`, `loginAs(app, email, password = TEST_PASSWORD): Promise<{ cookie: string; headers: Record<string, string> }>` (headers = `{ cookie, origin: TEST_ORIGIN }`).
  - Rule for later tasks: deactivating a user or resetting a password (Task 12) must call `deleteUserSessions(ctx.db, userId)` and then `ctx.hub.disconnectUser(userId)`. Route modules (Tasks 10, 12, 13, 14) get the 401 for anonymous `/api/*` from `authPlugin` itself and may read `req.user` directly (or via `authUser(req)`); `{ preHandler: requireUser }` is optional, `{ preHandler: requireAdmin }` is still needed for admin-only routes. Task 8's `/ws` route gets the Origin check and the session lookup from `authPlugin` for free, but on `/ws` `request.user` stays null at runtime when there is no session (despite the non-null type), so Task 8 must test `if (!req.user)` and answer 401 itself.
  - Emails are compared case-insensitively at login (`lower(email)`); writers (Task 12, seed-admin, importer) store them trimmed and lowercased.

---

- [ ] **Step 1: Install the auth dependencies (pinned)**

Run from the repo root (no-op if Task 1 already installed them):

```bash
npm install --save-exact -w server @node-rs/argon2@2.2.2 @fastify/cookie@11.1.3 @fastify/rate-limit@11.2.1
```

Expected: `server/package.json` lists the three packages with exact versions (no `^`).

- [ ] **Step 2: Write the failing password test**

Create `server/test/auth/password.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/auth/password.js';

describe('password', () => {
  it('hashes with argon2id and verifies the right password only', async () => {
    const hash = await hashPassword('segredo-forte-1');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash).not.toContain('segredo-forte-1');
    expect(await verifyPassword(hash, 'segredo-forte-1')).toBe(true);
    expect(await verifyPassword(hash, 'segredo-forte-2')).toBe(false);
  });

  it('produces a different hash each time (random salt)', async () => {
    expect(await hashPassword('igual')).not.toBe(await hashPassword('igual'));
  });

  it('returns false instead of throwing for a malformed hash', async () => {
    expect(await verifyPassword('not-a-hash', 'qualquer')).toBe(false);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm test -w server -- test/auth/password.test.ts`
Expected: FAIL with `Failed to load url ../../src/auth/password.js` (module does not exist).

- [ ] **Step 4: Implement password hashing**

Create `server/src/auth/password.ts`:

```ts
import { hash, verify } from '@node-rs/argon2';

// @node-rs/argon2 defaults to Argon2id (the test asserts the `$argon2id$` prefix).
export function hashPassword(plain: string): Promise<string> {
  return hash(plain);
}

export async function verifyPassword(passwordHash: string, plain: string): Promise<boolean> {
  try {
    return await verify(passwordHash, plain);
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npm test -w server -- test/auth/password.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add server/package.json package-lock.json server/src/auth/password.ts server/test/auth/password.test.ts
git commit -m "feat(auth): argon2id password hashing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Write the failing sessions test**

Create `server/test/auth/sessions.test.ts`:

```ts
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createSession, deleteSession, deleteUserSessions, getSessionUser } from '../../src/auth/sessions.js';
import { sessions, users } from '../../src/db/schema.js';
import { loadAuthUser } from '../../src/inbox/visibility.js';
import { makeTestCtx, seedBasics } from '../helpers.js';

const DAY = 86_400_000;

let ctx: Awaited<ReturnType<typeof makeTestCtx>>;
let seed: Awaited<ReturnType<typeof seedBasics>>;

beforeEach(async () => {
  ctx = await makeTestCtx();
  seed = await seedBasics(ctx);
});

describe('loadAuthUser', () => {
  it('loads the user with sector ids', async () => {
    const u = await loadAuthUser(ctx.db, seed.agentA.id);
    expect(u).toMatchObject({ id: seed.agentA.id, email: seed.agentA.email, role: 'agent', sectorIds: [seed.sectorA] });
  });

  it('returns null for an unknown id', async () => {
    expect(await loadAuthUser(ctx.db, randomUUID())).toBeNull();
  });
});

describe('sessions', () => {
  it('stores only the sha256 of the raw token', async () => {
    const token = await createSession(ctx.db, seed.agentA.id);
    const rows = await ctx.db.select().from(sessions);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).not.toBe(token);
    expect(rows[0].id).toBe(createHash('sha256').update(token).digest('hex'));
    expect(rows[0].expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * DAY);
  });

  it('getSessionUser returns the AuthUser for a valid token', async () => {
    const token = await createSession(ctx.db, seed.agentA.id);
    const u = await getSessionUser(ctx.db, token);
    expect(u).toMatchObject({ id: seed.agentA.id, role: 'agent', sectorIds: [seed.sectorA] });
  });

  it('returns null for an unknown or empty token', async () => {
    expect(await getSessionUser(ctx.db, 'nao-existe')).toBeNull();
    expect(await getSessionUser(ctx.db, '')).toBeNull();
  });

  it('slides the expiry forward on use', async () => {
    const token = await createSession(ctx.db, seed.agentA.id);
    await ctx.db.update(sessions).set({ expiresAt: new Date(Date.now() + DAY) });
    expect(await getSessionUser(ctx.db, token)).not.toBeNull();
    const [row] = await ctx.db.select().from(sessions);
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * DAY);
  });

  it('returns null for an expired session', async () => {
    const token = await createSession(ctx.db, seed.agentA.id);
    await ctx.db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) });
    expect(await getSessionUser(ctx.db, token)).toBeNull();
  });

  it('returns null when the user was deactivated', async () => {
    const token = await createSession(ctx.db, seed.agentA.id);
    await ctx.db.update(users).set({ active: false }).where(eq(users.id, seed.agentA.id));
    expect(await getSessionUser(ctx.db, token)).toBeNull();
  });

  it('deleteSession invalidates just that token', async () => {
    const t1 = await createSession(ctx.db, seed.agentA.id);
    const t2 = await createSession(ctx.db, seed.agentA.id);
    await deleteSession(ctx.db, t1);
    expect(await getSessionUser(ctx.db, t1)).toBeNull();
    expect(await getSessionUser(ctx.db, t2)).not.toBeNull();
  });

  it('deleteUserSessions invalidates every session of that user only', async () => {
    const a1 = await createSession(ctx.db, seed.agentA.id);
    const a2 = await createSession(ctx.db, seed.agentA.id);
    const b1 = await createSession(ctx.db, seed.agentB.id);
    await deleteUserSessions(ctx.db, seed.agentA.id);
    expect(await getSessionUser(ctx.db, a1)).toBeNull();
    expect(await getSessionUser(ctx.db, a2)).toBeNull();
    expect(await getSessionUser(ctx.db, b1)).not.toBeNull();
  });
});
```

- [ ] **Step 8: Run it to verify it fails**

Run: `npm test -w server -- test/auth/sessions.test.ts`
Expected: FAIL with `Failed to load url ../../src/auth/sessions.js` (and/or `loadAuthUser` not exported from `visibility.js`).

- [ ] **Step 9: Implement `AuthUser` + `loadAuthUser`**

Create `server/src/inbox/visibility.ts` (if Task 2 created it with only the `AuthUser` interface, replace the whole file with this; Task 7 appends `ChatVisibilityFields`, `canSee` and `visibleChatsWhere` below):

```ts
import { eq } from 'drizzle-orm';
import type { Db, Tx } from '../db/client.js';
import { userSectors, users } from '../db/schema.js';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'agent';
  signature: string | null;
  sectorIds: string[];
}

export async function loadAuthUser(db: Db | Tx, userId: string): Promise<AuthUser | null> {
  const [u] = await db
    .select({ id: users.id, name: users.name, email: users.email, role: users.role, signature: users.signature })
    .from(users)
    .where(eq(users.id, userId));
  if (!u) return null;
  const rows = await db.select({ sectorId: userSectors.sectorId }).from(userSectors).where(eq(userSectors.userId, userId));
  return { ...u, sectorIds: rows.map((r) => r.sectorId) };
}
```

- [ ] **Step 10: Implement sessions**

Create `server/src/auth/sessions.ts`:

```ts
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import type { Db, Tx } from '../db/client.js';
import { sessions, users } from '../db/schema.js';
import { loadAuthUser, type AuthUser } from '../inbox/visibility.js';

const DAY_MS = 86_400_000;

const tokenId = (rawToken: string) => createHash('sha256').update(rawToken).digest('hex');
const expiry = (days: number) => new Date(Date.now() + days * DAY_MS);

/** Returns the raw token (goes only into the cookie); the DB keeps its SHA-256. */
export async function createSession(db: Db | Tx, userId: string, days = 30): Promise<string> {
  const rawToken = randomBytes(32).toString('base64url');
  await db.insert(sessions).values({ id: tokenId(rawToken), userId, expiresAt: expiry(days) });
  return rawToken;
}

export async function getSessionUser(db: Db | Tx, rawToken: string, days = 30): Promise<AuthUser | null> {
  if (!rawToken) return null;
  const id = tokenId(rawToken);
  const [row] = await db
    .select({ userId: sessions.userId })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, id), gt(sessions.expiresAt, new Date()), eq(users.active, true)));
  if (!row) return null;
  // ponytail: one UPDATE per authenticated request; fine for 3–10 agents, throttle (e.g. only when >1h old) if it ever shows up in profiles.
  await db.update(sessions).set({ expiresAt: expiry(days) }).where(eq(sessions.id, id));
  return loadAuthUser(db, row.userId);
}

export async function deleteSession(db: Db | Tx, rawToken: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, tokenId(rawToken)));
}

export async function deleteUserSessions(db: Db | Tx, userId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}
```

- [ ] **Step 11: Run it to verify it passes**

Run: `npm test -w server -- test/auth/sessions.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 12: Commit**

```bash
git add server/src/inbox/visibility.ts server/src/auth/sessions.ts server/test/auth/sessions.test.ts
git commit -m "feat(auth): hashed sessions with sliding expiry and loadAuthUser

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 13: Extend the test helpers**

Edit `server/test/helpers.ts`:

1. Add these imports at the top (keep the existing ones; skip any already present):

```ts
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth/password.js';
```

2. If `TEST_PASSWORD` is not exported yet, add `export const TEST_PASSWORD = 'senha-teste-123';`. Then add below it:

```ts
export const TEST_ORIGIN = 'http://localhost:5173';

// Hashed once per test process: argon2 is deliberately slow.
let testHash: Promise<string> | undefined;
export function testPasswordHash(): Promise<string> {
  return (testHash ??= hashPassword(TEST_PASSWORD));
}
```

3. In `makeTestCtx`, the `config` object must contain `appOrigin: TEST_ORIGIN` and `cookieSecure: false` (change those two properties if Task 2 used other values; leave the rest as is).

4. In `seedBasics`, add `const passwordHash = await testPasswordHash();` as its first line and set `passwordHash` (instead of whatever placeholder string Task 2 used) on **every** row it inserts into `users` (admin, agentA, agentB).

5. Append at the end of the file:

```ts
export async function makeTestApp(ctx?: AppCtx): Promise<{ app: FastifyInstance; ctx: AppCtx }> {
  const c = ctx ?? (await makeTestCtx());
  const app = await buildApp(c);
  await app.ready();
  return { app, ctx: c };
}

export async function loginAs(
  app: FastifyInstance,
  email: string,
  password: string = TEST_PASSWORD,
): Promise<{ cookie: string; headers: Record<string, string> }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin: TEST_ORIGIN },
    payload: { email, password },
  });
  if (res.statusCode !== 200) throw new Error(`loginAs(${email}) falhou: ${res.statusCode} ${res.body}`);
  const sid = res.cookies.find((c) => c.name === 'sid');
  if (!sid) throw new Error('login não devolveu o cookie sid');
  const cookie = `sid=${sid.value}`;
  return { cookie, headers: { cookie, origin: TEST_ORIGIN } };
}
```

(`AppCtx` is already imported in `helpers.ts` by Task 2; if not, add `import type { AppCtx } from '../src/ctx.js';`.)

- [ ] **Step 14: Write the failing HTTP auth test**

Create `server/test/auth/routes.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { requireAdmin } from '../../src/auth/plugin.js';
import { deleteUserSessions } from '../../src/auth/sessions.js';
import { sessions, users } from '../../src/db/schema.js';
import type { AppCtx } from '../../src/ctx.js';
import { TEST_ORIGIN, TEST_PASSWORD, loginAs, makeTestApp, makeTestCtx, seedBasics } from '../helpers.js';

let app: FastifyInstance;
let ctx: AppCtx;
let seed: Awaited<ReturnType<typeof seedBasics>>;

const login = (email: string, password: string, origin: string | undefined = TEST_ORIGIN) =>
  app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: origin ? { origin } : {},
    payload: { email, password },
  });

beforeEach(async () => {
  ({ app, ctx } = await makeTestApp());
  seed = await seedBasics(ctx);
});

afterEach(async () => {
  await app.close();
});

describe('POST /api/auth/login', () => {
  it('returns Me and sets an HttpOnly SameSite=Lax sid cookie', async () => {
    const res = await login(seed.agentA.email, TEST_PASSWORD);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      id: seed.agentA.id,
      name: seed.agentA.name,
      email: seed.agentA.email,
      role: 'agent',
      signature: seed.agentA.signature,
      sectorIds: [seed.sectorA],
    });
    const sid = res.cookies.find((c) => c.name === 'sid');
    expect(sid?.value).toBeTruthy();
    expect(sid?.httpOnly).toBe(true);
    expect(sid?.sameSite).toBe('Lax');
    expect(sid?.path).toBe('/');
    expect(Boolean(sid?.secure)).toBe(ctx.config.cookieSecure);
  });

  it('accepts the email in any case and with spaces', async () => {
    const res = await login(`  ${seed.agentA.email.toUpperCase()} `, TEST_PASSWORD);
    expect(res.statusCode).toBe(200);
  });

  it('rejects a wrong password with 401 and creates no session', async () => {
    const res = await login(seed.agentA.email, 'errada');
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'E-mail ou senha inválidos' });
    expect(await ctx.db.select().from(sessions)).toHaveLength(0);
  });

  it('rejects an unknown email with the same 401', async () => {
    const res = await login('ninguem@example.com', TEST_PASSWORD);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'E-mail ou senha inválidos' });
  });

  it('rejects an inactive user with 403', async () => {
    await ctx.db.update(users).set({ active: false }).where(eq(users.id, seed.agentA.id));
    const res = await login(seed.agentA.email, TEST_PASSWORD);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'Usuário desativado' });
  });

  it('rate-limits to 5 attempts per minute per IP+email', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await login(seed.agentA.email, 'errada')).statusCode).toBe(401);
    }
    const blocked = await login(seed.agentA.email, TEST_PASSWORD);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toEqual({ error: 'Muitas tentativas. Aguarde um minuto e tente de novo.' });
    // another email from the same IP is a different key
    expect((await login(seed.agentB.email, TEST_PASSWORD)).statusCode).toBe(200);
  });
});

describe('GET /api/auth/me', () => {
  it('returns 401 without a cookie', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(res.statusCode).toBe(401);
  });

  it('returns Me with a valid cookie (GET needs no Origin)', async () => {
    const { cookie } = await loginAs(app, seed.admin.email);
    const res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: seed.admin.id, role: 'admin' });
  });

  it('returns 401 after deleteUserSessions (deactivate / password reset)', async () => {
    const { headers } = await loginAs(app, seed.agentB.email);
    await deleteUserSessions(ctx.db, seed.agentB.id);
    const res = await app.inject({ method: 'GET', url: '/api/auth/me', headers });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /api/auth/logout', () => {
  it('deletes the session so the cookie stops working', async () => {
    const { headers } = await loginAs(app, seed.agentA.email);
    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers });
    expect(out.statusCode).toBe(204);
    expect(await ctx.db.select().from(sessions).where(eq(sessions.userId, seed.agentA.id))).toHaveLength(0);
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers });
    expect(me.statusCode).toBe(401);
  });
});

describe('Origin check (CSRF)', () => {
  it('rejects a POST without Origin with 403', async () => {
    const res = await login(seed.agentA.email, TEST_PASSWORD, undefined);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'Origem não permitida' });
  });

  it('rejects a POST from another origin with 403, even with a valid cookie', async () => {
    const { cookie } = await loginAs(app, seed.agentA.email);
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie, origin: 'https://evil.example' },
    });
    expect(res.statusCode).toBe(403);
    expect(await ctx.db.select().from(sessions).where(eq(sessions.userId, seed.agentA.id))).toHaveLength(1);
  });
});

describe('session required on /api/*', () => {
  it('gives 401 to an anonymous /api route before the handler, but /api/health stays public', async () => {
    const c = await makeTestCtx();
    const s = await seedBasics(c);
    const a: FastifyInstance = await buildApp(c);
    let ran = false;
    a.get('/api/test-user', async (req) => {
      ran = true;
      return { id: req.user.id };
    });
    await a.ready();
    try {
      expect((await a.inject({ method: 'GET', url: '/api/test-user' })).statusCode).toBe(401);
      expect(ran).toBe(false);
      expect((await a.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
      const agent = await loginAs(a, s.agentA.email);
      const ok = await a.inject({ method: 'GET', url: '/api/test-user', headers: agent.headers });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ id: s.agentA.id });
    } finally {
      await a.close();
    }
  });
});

describe('requireAdmin', () => {
  it('gives 401 anonymous, 403 agent, 200 admin', async () => {
    const c = await makeTestCtx();
    const s = await seedBasics(c);
    const a: FastifyInstance = await buildApp(c);
    a.get('/api/test-admin', { preHandler: requireAdmin }, async () => ({ ok: true }));
    await a.ready();
    try {
      expect((await a.inject({ method: 'GET', url: '/api/test-admin' })).statusCode).toBe(401);
      const agent = await loginAs(a, s.agentA.email);
      expect((await a.inject({ method: 'GET', url: '/api/test-admin', headers: agent.headers })).statusCode).toBe(403);
      const admin = await loginAs(a, s.admin.email);
      expect((await a.inject({ method: 'GET', url: '/api/test-admin', headers: admin.headers })).statusCode).toBe(200);
    } finally {
      await a.close();
    }
  });
});
```

- [ ] **Step 15: Run it to verify it fails**

Run: `npm test -w server -- test/auth/routes.test.ts`
Expected: FAIL with `Failed to load url ../../src/auth/plugin.js` (module does not exist).

- [ ] **Step 16: Implement the auth plugin**

Create `server/src/auth/plugin.ts`:

```ts
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { AppCtx } from '../ctx.js';
import type { AuthUser } from '../inbox/visibility.js';
import { HttpError, forbidden } from '../lib/http-error.js';
import { getSessionUser } from './sessions.js';

declare module 'fastify' {
  interface FastifyRequest {
    // Non-null for handlers: the onRequest hook below rejects anonymous /api/* (except login/health).
    user: AuthUser;
  }
}

export const SESSION_COOKIE = 'sid';

const unauthorized = () => new HttpError(401, 'Não autenticado');

const authPluginImpl: FastifyPluginAsync<{ ctx: AppCtx }> = async (app, { ctx }) => {
  app.decorateRequest('user', null as unknown as AuthUser);

  app.addHook('onRequest', async (req) => {
    const path = req.url.split('?')[0];
    const isApi = path.startsWith('/api/');
    const isWs = path === '/ws';
    if (!isApi && !isWs) return;

    // §6 CSRF: every non-GET /api/* request and the /ws upgrade need Origin === APP_ORIGIN.
    const safeMethod = req.method === 'GET' || req.method === 'HEAD';
    if ((isWs || !safeMethod) && req.headers.origin !== ctx.config.appOrigin) {
      throw forbidden('Origem não permitida');
    }

    // §6: every request validates the session against the database.
    const sid = req.cookies[SESSION_COOKIE];
    if (sid) {
      const user = await getSessionUser(ctx.db, sid, ctx.config.sessionDays);
      if (user) req.user = user;
    }

    // §6: every /api route that reads or changes data requires a session. /ws answers 401 itself (Task 8).
    if (isApi && !req.user && path !== '/api/auth/login' && path !== '/api/health') throw unauthorized();
  });
};

// Not encapsulated (same effect as fastify-plugin): the decorator and hook apply to every route.
export const authPlugin = Object.assign(authPluginImpl, { [Symbol.for('skip-override')]: true });

export function authUser(req: FastifyRequest): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

export async function requireUser(req: FastifyRequest): Promise<void> {
  authUser(req);
}

export async function requireAdmin(req: FastifyRequest): Promise<void> {
  if (authUser(req).role !== 'admin') throw forbidden();
}
```

- [ ] **Step 17: Implement the auth routes**

Create `server/src/auth/routes.ts`:

```ts
import { sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppCtx } from '../ctx.js';
import { users } from '../db/schema.js';
import { loadAuthUser } from '../inbox/visibility.js';
import { HttpError, forbidden } from '../lib/http-error.js';
import { hashPassword, verifyPassword } from './password.js';
import { SESSION_COOKIE, authUser, requireUser } from './plugin.js';
import { createSession, deleteSession } from './sessions.js';

const LoginBody = z.object({
  email: z.string().trim().toLowerCase().min(1),
  password: z.string().min(1),
});

function loginEmail(body: unknown): string {
  const email = (body as { email?: unknown } | null)?.email;
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

// Verified when the email does not exist, so a wrong email costs the same time as a wrong password.
let dummyHash: Promise<string> | undefined;

export const authRoutes: FastifyPluginAsync<{ ctx: AppCtx }> = async (app, { ctx }) => {
  app.post(
    '/api/auth/login',
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 minute',
          hook: 'preHandler', // body must be parsed so the key can include the email
          keyGenerator: (req) => `${req.ip}|${loginEmail(req.body)}`,
          errorResponseBuilder: () => new HttpError(429, 'Muitas tentativas. Aguarde um minuto e tente de novo.'),
        },
      },
    },
    async (req, reply) => {
      const { email, password } = LoginBody.parse(req.body);
      const [user] = await ctx.db
        .select({ id: users.id, passwordHash: users.passwordHash, active: users.active })
        .from(users)
        .where(sql`lower(${users.email}) = ${email}`);
      const ok = await verifyPassword(user?.passwordHash ?? (await (dummyHash ??= hashPassword('dummy-password'))), password);
      if (!user || !ok) throw new HttpError(401, 'E-mail ou senha inválidos');
      if (!user.active) throw forbidden('Usuário desativado');

      const token = await createSession(ctx.db, user.id, ctx.config.sessionDays);
      reply.setCookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: ctx.config.cookieSecure,
        path: '/',
        // ponytail: browser max (400 days); the real 30-day-idle expiry is enforced server-side in getSessionUser.
        maxAge: 400 * 86_400,
      });
      return loadAuthUser(ctx.db, user.id);
    },
  );

  app.post('/api/auth/logout', { preHandler: requireUser }, async (req, reply) => {
    await deleteSession(ctx.db, req.cookies[SESSION_COOKIE] ?? '');
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.code(204).send();
  });

  app.get('/api/auth/me', { preHandler: requireUser }, async (req) => authUser(req));
};
```

- [ ] **Step 18: Wire auth into `buildApp`**

Edit `server/src/app.ts`. Add the imports at the top:

```ts
import rateLimit from '@fastify/rate-limit';
import { authPlugin } from './auth/plugin.js';
import { authRoutes } from './auth/routes.js';
```

Task 1 already imports and registers `@fastify/cookie` (`await app.register(cookie);`); do not import or register it again (a second registration throws `FST_ERR_DEC_ALREADY_PRESENT`). Inside `buildApp`, immediately after that existing `await app.register(cookie);` line and **before** any other `app.register(...)` / route definition, add (order matters: cookie parsing before the auth hook, rate-limit before the login route, auth hook before every route module added by later tasks):

```ts
  app.register(rateLimit, { global: false });
  app.register(authPlugin, { ctx });
  app.register(authRoutes, { ctx });
```

- [ ] **Step 19: Run the auth tests to verify they pass**

Run: `npm test -w server -- test/auth`
Expected: PASS (password 3, sessions 10, routes 14). Then run the whole server suite to make sure the new `seedBasics` hash and Origin hook broke nothing:

Run: `npm test -w server`
Expected: PASS (all files).

- [ ] **Step 20: Commit**

```bash
git add server/src/auth/plugin.ts server/src/auth/routes.ts server/src/app.ts server/test/helpers.ts server/test/auth/routes.test.ts
git commit -m "feat(auth): login/logout/me, sid cookie, origin check and login rate limit

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 21: Write the failing seed-admin test**

Create `server/test/auth/seed-admin.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { seedAdmin } from '../../src/auth/seed-admin.js';
import type { AppCtx } from '../../src/ctx.js';
import { loginAs, makeTestApp } from '../helpers.js';

let app: FastifyInstance;
let ctx: AppCtx;

beforeEach(async () => {
  ({ app, ctx } = await makeTestApp());
});

afterEach(async () => {
  await app.close();
});

describe('seedAdmin', () => {
  it('creates an active admin (email lowercased) who can log in', async () => {
    const admin = await seedAdmin(ctx.db, { email: ' Dono@JVO.adv.br ', name: 'Dono', password: 'senha-do-dono' });
    expect(admin).toMatchObject({ email: 'dono@jvo.adv.br', name: 'Dono', role: 'admin', signature: null, sectorIds: [] });
    const { headers } = await loginAs(app, 'dono@jvo.adv.br', 'senha-do-dono');
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers });
    expect(me.json()).toMatchObject({ id: admin.id, role: 'admin' });
  });

  it('refuses a duplicate email', async () => {
    await seedAdmin(ctx.db, { email: 'dono@jvo.adv.br', name: 'Dono', password: 'senha-do-dono' });
    await expect(seedAdmin(ctx.db, { email: 'DONO@jvo.adv.br', name: 'Outro', password: 'outra-senha' })).rejects.toMatchObject({
      status: 409,
    });
  });

  it('refuses a short password or missing name/email', async () => {
    await expect(seedAdmin(ctx.db, { email: 'a@b.c', name: 'A', password: '1234567' })).rejects.toMatchObject({ status: 400 });
    await expect(seedAdmin(ctx.db, { email: '', name: 'A', password: 'senha-longa' })).rejects.toMatchObject({ status: 400 });
    await expect(seedAdmin(ctx.db, { email: 'a@b.c', name: ' ', password: 'senha-longa' })).rejects.toMatchObject({ status: 400 });
  });
});
```

- [ ] **Step 22: Run it to verify it fails**

Run: `npm test -w server -- test/auth/seed-admin.test.ts`
Expected: FAIL with `Failed to load url ../../src/auth/seed-admin.js`.

- [ ] **Step 23: Implement seed-admin (function + CLI)**

Create `server/src/auth/seed-admin.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { sql } from 'drizzle-orm';
import { createPgDb, type Db } from '../db/client.js';
import { users } from '../db/schema.js';
import { loadAuthUser, type AuthUser } from '../inbox/visibility.js';
import { badRequest, conflict } from '../lib/http-error.js';
import { hashPassword } from './password.js';

export async function seedAdmin(db: Db, input: { email: string; name: string; password: string }): Promise<AuthUser> {
  const email = input.email.trim().toLowerCase();
  const name = input.name.trim();
  if (!email.includes('@') || !name) throw badRequest('Informe --email e --name');
  if (input.password.length < 8) throw badRequest('A senha precisa de pelo menos 8 caracteres');

  const [existing] = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email}`);
  if (existing) throw conflict('Já existe um usuário com este e-mail');

  const id = randomUUID();
  await db.insert(users).values({
    id,
    name,
    email,
    passwordHash: await hashPassword(input.password),
    role: 'admin',
    signature: null,
    active: true,
  });
  const admin = await loadAuthUser(db, id);
  if (!admin) throw new Error('Administrador não encontrado após a criação');
  return admin;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { email: { type: 'string' }, name: { type: 'string' } } });
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL não definido');

  let password = process.env.SEED_ADMIN_PASSWORD;
  if (!password) {
    // ponytail: the prompt echoes the typed password; set SEED_ADMIN_PASSWORD to avoid that.
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    password = await rl.question('Senha do administrador (mín. 8 caracteres): ');
    rl.close();
  }

  const admin = await seedAdmin(createPgDb(url), { email: values.email ?? '', name: values.name ?? '', password });
  console.log(`Administrador criado: ${admin.email}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    () => process.exit(0), // postgres.js keeps the pool open; exit explicitly
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
```

Edit `server/package.json`, adding this entry to `"scripts"`:

```json
"seed:admin": "tsx src/auth/seed-admin.ts"
```

- [ ] **Step 24: Run it to verify it passes**

Run: `npm test -w server -- test/auth/seed-admin.test.ts`
Expected: PASS (3 tests).

Run: `npm run typecheck -w server` (or `npx tsc --noEmit -p server` if Task 1 named the script differently)
Expected: no errors (validates the `FastifyRequest.user` augmentation and the rate-limit route config types).

- [ ] **Step 25: Commit**

```bash
git add server/src/auth/seed-admin.ts server/package.json server/test/auth/seed-admin.test.ts
git commit -m "feat(auth): seed:admin CLI to create the first administrator

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


---

### Task 7: Inbox core: visibility, events, chat actions

**Files:**
- Create: `server/src/realtime/hub.ts` (Step 0: `Hub` + `createRecordingHub()` only; Task 8 overwrites it with the full file)
- Modify: `server/src/ctx.ts` (Step 0: add `hub: Hub`)
- Modify: `server/test/helpers.ts` (Step 0: `makeTestCtx` returns `hub: createRecordingHub()`)
- Create (or overwrite, see Step 3): `server/src/inbox/visibility.ts`
- Create: `server/src/inbox/events.ts`
- Create: `server/src/inbox/chats.ts`
- Create: `server/test/inbox/fixtures.ts`
- Test: `server/test/inbox/visibility.test.ts`
- Test: `server/test/inbox/chats-open.test.ts`
- Test: `server/test/inbox/chats-actions.test.ts`
- Test: `server/test/inbox/chats-start.test.ts`

**Interfaces:**
- Consumes:
  - `server/src/ctx.ts`: `AppCtx { db; wa; hub; config }`.
  - `server/src/db/client.ts`: `type Db`, `type Tx` (`Parameters<Parameters<Db['transaction']>[0]>[0]`, exported from this file).
  - `server/src/db/schema.ts` (Task 2): `users`, `userSectors`, `sectors`, `channels`, `contacts`, `chats`, `chatPins`, `chatEvents`, `settings`, with camelCase columns from spec §4 (`chats.ownerId`, `chats.private`, `chats.triagePending`, `chats.closedAt`, `sectors.isDefault`, `users.active`, `settings.key`/`settings.value` jsonb, …).
  - `server/src/lib/http-error.ts`: `HttpError`, `badRequest`, `forbidden`, `notFound`, `conflict`.
  - `server/src/whatsapp/phone.ts` (Task 3): `normalizePhoneBR(raw: string): string`.
  - `server/src/realtime/hub.ts`: `Hub.publishChat(chatId: string): Promise<void>`; in tests `createRecordingHub()` through `makeTestCtx()`. The tests only check that some recorded event has `chatId === <id>`, not its `type` string. Task 8 owns the hub but runs after this task (its hub imports `canSee` from here), so Step 0 creates the `Hub` interface and `createRecordingHub()` early, verbatim from Task 8 Step 10, and wires `hub` into `AppCtx` and `makeTestCtx`.
  - `server/test/helpers.ts`: `makeTestCtx()`, `seedBasics(ctx)` → `{ admin, agentA, agentB, sectorA, sectorB, defaultSector, channelId, instance }`.
- Produces:
  - `server/src/inbox/visibility.ts`:
    - `interface AuthUser { id; name; email; role: 'admin' | 'agent'; signature: string | null; sectorIds: string[] }`
    - `interface ChatVisibilityFields { sectorId: string; ownerId: string | null; private: boolean }`
    - `canSee(user: AuthUser, chat: ChatVisibilityFields): boolean`
    - `visibleChatsWhere(user: AuthUser): SQL | undefined`. Use it as `.where(and(visibleChatsWhere(user), …))`. It returns `undefined` for admin, and Drizzle's `and()` skips `undefined`.
    - `loadAuthUser(db: Db | Tx, userId: string): Promise<AuthUser | null>`. Returns `null` for an unknown user or one with `active=false`.
  - `server/src/inbox/events.ts`:
    - `type ChatEventKind`
    - `addEvent(db: Db | Tx, chatId: string, kind: ChatEventKind, data: Record<string, unknown>, authorId: string | null): Promise<void>`
  - `server/src/inbox/chats.ts`: every signature in the contract. The one extension is to `closeChat`:
    ```ts
    export async function closeChat(ctx: AppCtx, user: AuthUser, chatId: string,
      opts: { sendClosingMessage: boolean; sendClosing?: (text: string) => Promise<void> }): Promise<ChatRow>;
    ```
    - `chats.ts` does not import `messages/send.ts`, because Task 10 comes later and a lazy import is not allowed.
    - When `sendClosingMessage` is true and `settings.closing_message` is a non-empty string, `closeChat` awaits `opts.sendClosing(text)` before it closes the chat.
    - If `opts.sendClosing` is missing in that case, `closeChat` throws a plain `Error`, which surfaces as a 500. This is a wiring bug, not a user error.
    - **Task 13's route must wire it exactly like this:**
      ```ts
      closeChat(ctx, req.user, id, {
        sendClosingMessage: body.sendClosingMessage,
        sendClosing: async (text) => { await sendAgentMessage(ctx, req.user, id, { text, signature: false }); },
      })
      ```
  - Event `data` shapes, for Task 13 and Task 17 (timeline rendering):

    | Event | `data` |
    |---|---|
    | `created` | `{ by: userId }` for a manual start; `{}` when the chat was created by an inbound message |
    | `assigned` | `{ ownerId, previousOwnerId }` |
    | `transferred` | `{ fromSectorId, toSectorId, fromOwnerId, toOwnerId }` |
    | `privacy_changed` | `{ private: boolean }` |
    | `closed` | `{ closingMessageSent: boolean }` |
    | `reopened` | `{}` |
  - Behaviour later tasks rely on:
    - **`findOrOpenChat`**
      - Writes the `created` event itself.
      - Does **not** publish to the hub; the caller publishes after its transaction commits.
      - Call it inside a transaction so the chat and its event stay atomic.
    - **`getChatForUser`** returns 404 when the id is malformed, the chat is missing, or `!canSee`.
    - **Mutations**
      - A stale expected state returns 409 with `'A conversa foi alterada por outra pessoa. Recarregue e tente de novo.'`.
      - `markChatRead` and `pinChat` write no event, because no event kind exists for them. They still publish.
    - **`startChat`**
      - Uses the oldest channel (`ORDER BY created_at LIMIT 1`).
      - Returns 409 when no channel exists.
      - Returns 409 when the contact already has an open chat that the user cannot see.
    - **`reopenChat`**
      - Returns 409 when another open chat for the same contact and channel exists but is invisible to the user.
      - When that other open chat is visible, returns it unchanged.

---

- [ ] **Step 0: Add the hub interface and the recording hub early**

`chats.ts` calls `ctx.hub.publishChat` and the tests read `ctx.hub.events`, but Task 8 (which owns the hub) runs after this task. Create the part of the hub that has no dependencies now.

(a) Create `server/src/realtime/hub.ts`. The `Socket` type, the `Hub` interface and `createRecordingHub()` are copied verbatim from Task 8 Step 10:

```ts
import type { AuthUser } from '../inbox/visibility.js';

// Task 7 stub: Task 8 Step 10 overwrites this file with the full version, which adds createHub.
type Socket = { send(data: string): void; close(): void };

export interface Hub {
  register(user: AuthUser, socket: Socket): () => void; // returns unregister
  disconnectUser(userId: string): void;
  publishChat(chatId: string): Promise<void>;
  publishMessage(chatId: string, type: 'message.created' | 'message.updated', messageId: string): Promise<void>;
  publishChannel(channelId: string): Promise<void>;
}

export function createRecordingHub(): Hub & {
  events: Array<{ type: string; chatId?: string; messageId?: string; channelId?: string; userId?: string }>;
} {
  const events: Array<{ type: string; chatId?: string; messageId?: string; channelId?: string; userId?: string }> = [];
  return {
    events,
    register: () => () => {},
    disconnectUser: (userId) => { events.push({ type: 'disconnect', userId }); },
    publishChat: async (chatId) => { events.push({ type: 'chat', chatId }); },
    publishMessage: async (chatId, type, messageId) => { events.push({ type, chatId, messageId }); },
    publishChannel: async (channelId) => { events.push({ type: 'channel', channelId }); },
  };
}
```

(b) In `server/src/ctx.ts`, add the import next to the other type imports and the field inside `AppCtx`, leaving the other fields as they are:

```ts
import type { Hub } from './realtime/hub.js';
```

```ts
  hub: Hub;
```

(c) In `server/test/helpers.ts`, add this import next to the other `../src/...` imports:

```ts
import { createRecordingHub } from '../src/realtime/hub.js';
```

Change the declared return type of `makeTestCtx` to exactly the contract signature:

```ts
export async function makeTestCtx(): Promise<AppCtx & { wa: ReturnType<typeof createFakeGateway>; hub: ReturnType<typeof createRecordingHub> }>
```

Inside `makeTestCtx`, add `hub: createRecordingHub()` to the returned object, replacing any `hub` placeholder an earlier task left there. Keep the existing `db`, `wa` and `config` properties as they are.

Task 8 then overwrites `hub.ts` with its full version (same `Hub` and `createRecordingHub`, plus `createHub`), and its Step 11 (the `helpers.ts` edit) is already done and becomes a no-op.

Run: `npx tsc -p server/tsconfig.json --noEmit`
Expected: exit code 0, no errors.

Run: `npm test -w server`
Expected: PASS. Earlier tasks' tests are unaffected by the extra `hub` property.

```bash
git add server/src/realtime/hub.ts server/src/ctx.ts server/test/helpers.ts
git commit -m "feat(server): Hub interface and recording hub for tests

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 1: Write the shared test fixtures**

Create `server/test/inbox/fixtures.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import type { AppCtx } from '../../src/ctx.js';
import { chatEvents, chats, contacts } from '../../src/db/schema.js';
import { HttpError } from '../../src/lib/http-error.js';

let seq = 0;

/** Inserts a contact with a unique canonical 13-digit phone (or the given one); returns its id. */
export async function newContact(ctx: AppCtx, opts: { phone?: string; name?: string } = {}): Promise<string> {
  seq += 1;
  const id = randomUUID();
  const now = new Date();
  await ctx.db.insert(contacts).values({
    id,
    name: opts.name ?? `Cliente ${seq}`,
    phone: opts.phone ?? `55659${String(seq).padStart(8, '0')}`,
    blocked: false,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

/** Inserts a chat row directly (no event, no hub); returns its id. */
export async function insertChat(
  ctx: AppCtx,
  f: { channelId: string; sectorId: string; contactId?: string; ownerId?: string | null; private?: boolean; state?: 'open' | 'closed'; unread?: number },
): Promise<string> {
  const id = randomUUID();
  const state = f.state ?? 'open';
  const contactId = f.contactId ?? (await newContact(ctx));
  await ctx.db.insert(chats).values({
    id,
    contactId,
    channelId: f.channelId,
    sectorId: f.sectorId,
    ownerId: f.ownerId ?? null,
    state,
    waiting: false,
    private: f.private ?? false,
    triagePending: false,
    unread: f.unread ?? 0,
    createdAt: new Date(),
    closedAt: state === 'closed' ? new Date() : null,
  });
  return id;
}

export async function eventsOf(ctx: AppCtx, chatId: string) {
  return ctx.db.select().from(chatEvents).where(eq(chatEvents.chatId, chatId)).orderBy(asc(chatEvents.createdAt));
}

/** Resolves to 200 on success, the HttpError status on HttpError; rethrows anything else. */
export function statusOf(p: Promise<unknown>): Promise<number> {
  return p.then(
    () => 200,
    (e: unknown) => {
      if (e instanceof HttpError) return e.status;
      throw e;
    },
  );
}
```

- [ ] **Step 2: Write the failing visibility test**

Create `server/test/inbox/visibility.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { chats, users } from '../../src/db/schema.js';
import { canSee, loadAuthUser, visibleChatsWhere, type AuthUser, type ChatVisibilityFields } from '../../src/inbox/visibility.js';
import { makeTestCtx, seedBasics } from '../helpers.js';
import { insertChat } from './fixtures.js';

const admin: AuthUser = { id: 'adm', name: 'Admin', email: 'a@x.com', role: 'admin', signature: null, sectorIds: [] };
const agent: AuthUser = { id: 'u1', name: 'Ana', email: 'u1@x.com', role: 'agent', signature: null, sectorIds: ['A'] };

const cases: Array<[string, AuthUser, ChatVisibilityFields, boolean]> = [
  ['admin sees a private chat owned by someone else', admin, { sectorId: 'B', ownerId: 'u2', private: true }, true],
  ['sector member sees an unowned chat of the sector', agent, { sectorId: 'A', ownerId: null, private: false }, true],
  ['sector member sees a colleague-owned chat of the sector', agent, { sectorId: 'A', ownerId: 'u2', private: false }, true],
  ['owner sees own chat outside his sectors', agent, { sectorId: 'B', ownerId: 'u1', private: false }, true],
  ['owner sees own private chat', agent, { sectorId: 'B', ownerId: 'u1', private: true }, true],
  ['agent does not see an unowned chat of another sector', agent, { sectorId: 'B', ownerId: null, private: false }, false],
  ['agent does not see a chat of another sector owned by someone else', agent, { sectorId: 'B', ownerId: 'u2', private: false }, false],
  ['sector member does not see a colleague private chat', agent, { sectorId: 'A', ownerId: 'u2', private: true }, false],
];

describe('canSee', () => {
  it.each(cases)('%s', (_name, user, chat, expected) => {
    expect(canSee(user, chat)).toBe(expected);
  });
});

describe('visibleChatsWhere / loadAuthUser (PGlite)', () => {
  let ctx: Awaited<ReturnType<typeof makeTestCtx>>;
  let s: Awaited<ReturnType<typeof seedBasics>>;

  beforeEach(async () => {
    ctx = await makeTestCtx();
    s = await seedBasics(ctx);
  });

  it('selects exactly the chats canSee allows, for every kind of user', async () => {
    for (const sectorId of [s.sectorA, s.sectorB, s.defaultSector]) {
      for (const ownerId of [null, s.agentA.id, s.agentB.id]) {
        for (const isPrivate of [false, true]) {
          await insertChat(ctx, { channelId: s.channelId, sectorId, ownerId, private: isPrivate });
        }
      }
    }
    const all = await ctx.db.select().from(chats);
    expect(all).toHaveLength(18);

    const noSectors: AuthUser = { ...s.agentA, sectorIds: [] };
    for (const user of [s.admin, s.agentA, s.agentB, noSectors]) {
      const viaSql = (await ctx.db.select({ id: chats.id }).from(chats).where(visibleChatsWhere(user)))
        .map((r) => r.id)
        .sort();
      const viaCanSee = all
        .filter((c) => canSee(user, c))
        .map((c) => c.id)
        .sort();
      expect(viaSql).toEqual(viaCanSee);
    }
    // sanity on the fixture: 18 for admin; agentA = 2 colleague/unowned in sector A + 6 owned
    expect(all.filter((c) => canSee(s.admin, c))).toHaveLength(18);
    expect(all.filter((c) => canSee(s.agentA, c))).toHaveLength(8);
    expect(all.filter((c) => canSee(noSectors, c))).toHaveLength(6);
  });

  it('loadAuthUser returns sectors, and null for inactive or unknown users', async () => {
    const a = await loadAuthUser(ctx.db, s.agentA.id);
    expect(a).toMatchObject({ id: s.agentA.id, role: 'agent', sectorIds: [s.sectorA] });
    await ctx.db.update(users).set({ active: false }).where(eq(users.id, s.agentB.id));
    expect(await loadAuthUser(ctx.db, s.agentB.id)).toBeNull();
    expect(await loadAuthUser(ctx.db, randomUUID())).toBeNull();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -w server -- test/inbox/visibility.test.ts`
Expected: FAIL. The message depends on whether Task 6 already created the file:
- If it did not: `Failed to resolve import "../../src/inbox/visibility.js"`.
- If it did, defining only `AuthUser` and `loadAuthUser`: `canSee is not a function` / `visibleChatsWhere is not a function`.

- [ ] **Step 4: Implement visibility**

Write `server/src/inbox/visibility.ts` with the complete content below.
- If Task 6 already created this file for its auth plugin, overwrite it.
- This version keeps `AuthUser` and `loadAuthUser` with the contract signatures, so Task 6's imports keep working.

```ts
import { and, eq, inArray, or, type SQL } from 'drizzle-orm';
import type { Db, Tx } from '../db/client.js';
import { chats, users, userSectors } from '../db/schema.js';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'agent';
  signature: string | null;
  sectorIds: string[];
}

export interface ChatVisibilityFields {
  sectorId: string;
  ownerId: string | null;
  private: boolean;
}

/** §6: admin sees everything; a private chat only its owner; otherwise sector member or owner. */
export function canSee(user: AuthUser, chat: ChatVisibilityFields): boolean {
  if (user.role === 'admin') return true;
  if (chat.ownerId === user.id) return true;
  return !chat.private && user.sectorIds.includes(chat.sectorId);
}

/**
 * Same rule as canSee, as a WHERE over `chats`. undefined for admin (no filter).
 * (private=false AND (sector IN mine OR owner=me)) OR (private=true AND owner=me)
 * simplifies to owner=me OR (private=false AND sector IN mine).
 */
export function visibleChatsWhere(user: AuthUser): SQL | undefined {
  if (user.role === 'admin') return undefined;
  const mine = eq(chats.ownerId, user.id);
  if (user.sectorIds.length === 0) return mine;
  return or(mine, and(eq(chats.private, false), inArray(chats.sectorId, user.sectorIds)));
}

export async function loadAuthUser(db: Db | Tx, userId: string): Promise<AuthUser | null> {
  const [u] = await db
    .select()
    .from(users)
    .where(and(eq(users.id, userId), eq(users.active, true)));
  if (!u) return null;
  const rows = await db
    .select({ sectorId: userSectors.sectorId })
    .from(userSectors)
    .where(eq(userSectors.userId, userId));
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    signature: u.signature,
    sectorIds: rows.map((r) => r.sectorId),
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -w server -- test/inbox/visibility.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 6: Commit**

```bash
git add server/src/inbox/visibility.ts server/test/inbox/fixtures.ts server/test/inbox/visibility.test.ts
git commit -m "feat(inbox): canSee and visibleChatsWhere visibility rule

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Write the failing test for opening and loading chats**

Create `server/test/inbox/chats-open.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { chats } from '../../src/db/schema.js';
import { findOrOpenChat, getChatForUser, getDefaultSectorId } from '../../src/inbox/chats.js';
import { makeTestCtx, seedBasics } from '../helpers.js';
import { eventsOf, insertChat, newContact, statusOf } from './fixtures.js';

let ctx: Awaited<ReturnType<typeof makeTestCtx>>;
let s: Awaited<ReturnType<typeof seedBasics>>;

beforeEach(async () => {
  ctx = await makeTestCtx();
  s = await seedBasics(ctx);
});

describe('getDefaultSectorId', () => {
  it('returns the sector flagged is_default', async () => {
    expect(await getDefaultSectorId(ctx.db)).toBe(s.defaultSector);
  });
});

describe('findOrOpenChat', () => {
  it('creates an open chat with the init fields and a created event with the author', async () => {
    const contactId = await newContact(ctx);
    const { chat, created } = await findOrOpenChat(ctx.db, {
      contactId,
      channelId: s.channelId,
      init: { sectorId: s.sectorA, ownerId: s.agentA.id, waiting: false, triagePending: false, createdBy: s.agentA.id },
    });
    expect(created).toBe(true);
    expect(chat).toMatchObject({
      contactId,
      channelId: s.channelId,
      sectorId: s.sectorA,
      ownerId: s.agentA.id,
      state: 'open',
      waiting: false,
      private: false,
      triagePending: false,
      unread: 0,
    });
    const events = await eventsOf(ctx, chat.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'created', data: { by: s.agentA.id }, authorId: s.agentA.id });
  });

  it('reuses the open chat instead of creating a second one (inbound init, no author)', async () => {
    const contactId = await newContact(ctx);
    const init = { sectorId: s.defaultSector, ownerId: null, waiting: true, triagePending: true, createdBy: null };
    const first = await findOrOpenChat(ctx.db, { contactId, channelId: s.channelId, init });
    const second = await findOrOpenChat(ctx.db, { contactId, channelId: s.channelId, init: { ...init, sectorId: s.sectorB } });

    expect(first.created).toBe(true);
    expect(first.chat).toMatchObject({ waiting: true, triagePending: true, ownerId: null });
    expect(second.created).toBe(false);
    expect(second.chat.id).toBe(first.chat.id);
    expect(second.chat.sectorId).toBe(s.defaultSector);
    expect(await ctx.db.select().from(chats).where(eq(chats.contactId, contactId))).toHaveLength(1);

    const events = await eventsOf(ctx, first.chat.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'created', data: {}, authorId: null });
  });

  it('opens a new chat when the previous one is closed', async () => {
    const contactId = await newContact(ctx);
    const oldId = await insertChat(ctx, { contactId, channelId: s.channelId, sectorId: s.sectorA, state: 'closed' });
    const { chat, created } = await findOrOpenChat(ctx.db, {
      contactId,
      channelId: s.channelId,
      init: { sectorId: s.defaultSector, ownerId: null, waiting: true, triagePending: false, createdBy: null },
    });
    expect(created).toBe(true);
    expect(chat.id).not.toBe(oldId);
  });
});

describe('getChatForUser', () => {
  it('returns a visible chat', async () => {
    const id = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA });
    expect((await getChatForUser(ctx, s.agentA, id)).id).toBe(id);
    expect((await getChatForUser(ctx, s.admin, id)).id).toBe(id);
  });

  it('404 for an invisible, unknown or malformed id', async () => {
    const id = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorB });
    expect(await statusOf(getChatForUser(ctx, s.agentA, id))).toBe(404);
    expect(await statusOf(getChatForUser(ctx, s.agentA, randomUUID()))).toBe(404);
    expect(await statusOf(getChatForUser(ctx, s.agentA, 'nao-e-uuid'))).toBe(404);
  });
});
```

- [ ] **Step 8: Run the test to verify it fails**

Run: `npm test -w server -- test/inbox/chats-open.test.ts`
Expected: FAIL with `Failed to resolve import "../../src/inbox/chats.js"`

- [ ] **Step 9: Implement events.ts**

Create `server/src/inbox/events.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { Db, Tx } from '../db/client.js';
import { chatEvents } from '../db/schema.js';

export type ChatEventKind = 'created' | 'assigned' | 'transferred' | 'closed' | 'reopened' | 'privacy_changed' | 'triage_routed';

export async function addEvent(
  db: Db | Tx,
  chatId: string,
  kind: ChatEventKind,
  data: Record<string, unknown>,
  authorId: string | null,
): Promise<void> {
  await db.insert(chatEvents).values({ id: randomUUID(), chatId, kind, data, authorId, createdAt: new Date() });
}
```

- [ ] **Step 10: Create chats.ts with the open/load functions**

Create `server/src/inbox/chats.ts`. The import block already covers the functions appended in Steps 15 and 20; do not change it later.

```ts
import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, isNull, type SQL } from 'drizzle-orm';
import type { AppCtx } from '../ctx.js';
import type { Db, Tx } from '../db/client.js';
import { channels, chatPins, chats, contacts, sectors, settings, users } from '../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/http-error.js';
import { normalizePhoneBR } from '../whatsapp/phone.js';
import { addEvent, type ChatEventKind } from './events.js';
import { canSee, visibleChatsWhere, type AuthUser } from './visibility.js';

export type ChatRow = typeof chats.$inferSelect;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STALE = 'A conversa foi alterada por outra pessoa. Recarregue e tente de novo.';
const BUSY_ELSEWHERE = 'Este contato já está em atendimento em outro setor.';

/**
 * Returns the open chat for (contact, channel), creating it if none exists.
 * INSERT … ON CONFLICT DO NOTHING hits the partial unique index (contact_id, channel_id) WHERE state='open';
 * when two webhooks race, the loser re-reads the winner's row.
 * Writes the `created` event. Does NOT publish: call inside the caller's transaction and publish after commit.
 */
export async function findOrOpenChat(
  db: Db | Tx,
  args: {
    contactId: string;
    channelId: string;
    init: { sectorId: string; ownerId: string | null; waiting: boolean; triagePending: boolean; createdBy: string | null };
  },
): Promise<{ chat: ChatRow; created: boolean }> {
  const { contactId, channelId, init } = args;
  const [inserted] = await db
    .insert(chats)
    .values({
      id: randomUUID(),
      contactId,
      channelId,
      sectorId: init.sectorId,
      ownerId: init.ownerId,
      state: 'open',
      waiting: init.waiting,
      private: false,
      triagePending: init.triagePending,
      unread: 0,
      createdAt: new Date(),
    })
    .onConflictDoNothing()
    .returning();
  if (inserted) {
    await addEvent(db, inserted.id, 'created', init.createdBy ? { by: init.createdBy } : {}, init.createdBy);
    return { chat: inserted, created: true };
  }
  const [existing] = await db
    .select()
    .from(chats)
    .where(and(eq(chats.contactId, contactId), eq(chats.channelId, channelId), eq(chats.state, 'open')));
  if (!existing) throw new Error('findOrOpenChat: insert conflicted but no open chat was found');
  return { chat: existing, created: false };
}

export async function getDefaultSectorId(db: Db | Tx): Promise<string> {
  const [row] = await db.select({ id: sectors.id }).from(sectors).where(eq(sectors.isDefault, true)).limit(1);
  if (!row) throw new Error('Nenhum setor padrão configurado');
  return row.id;
}

/** 404 when the id is malformed, the chat does not exist, or the user cannot see it (§6). */
export async function getChatForUser(ctx: AppCtx, user: AuthUser, chatId: string): Promise<ChatRow> {
  if (!UUID_RE.test(chatId)) throw notFound();
  const [chat] = await ctx.db.select().from(chats).where(eq(chats.id, chatId));
  if (!chat || !canSee(user, chat)) throw notFound();
  return chat;
}
```

- [ ] **Step 11: Run the test to verify it passes**

Run: `npm test -w server -- test/inbox/chats-open.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 12: Commit**

```bash
git add server/src/inbox/events.ts server/src/inbox/chats.ts server/test/inbox/chats-open.test.ts
git commit -m "feat(inbox): chat events, findOrOpenChat and getChatForUser

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 13: Write the failing test for assume, transfer, privacy, close and reopen**

Create `server/test/inbox/chats-actions.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chats, settings } from '../../src/db/schema.js';
import { assumeChat, closeChat, reopenChat, setChatPrivacy, transferChat } from '../../src/inbox/chats.js';
import { canSee } from '../../src/inbox/visibility.js';
import { makeTestCtx, seedBasics } from '../helpers.js';
import { eventsOf, insertChat, newContact, statusOf } from './fixtures.js';

let ctx: Awaited<ReturnType<typeof makeTestCtx>>;
let s: Awaited<ReturnType<typeof seedBasics>>;

beforeEach(async () => {
  ctx = await makeTestCtx();
  s = await seedBasics(ctx);
});

function published(chatId: string): boolean {
  return ctx.hub.events.some((e) => e.chatId === chatId);
}

describe('assumeChat', () => {
  it('makes me the owner, records assigned and publishes', async () => {
    const id = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA });
    ctx.hub.events.length = 0;
    const chat = await assumeChat(ctx, s.agentA, id);
    expect(chat.ownerId).toBe(s.agentA.id);
    const [ev] = await eventsOf(ctx, id);
    expect(ev).toMatchObject({ kind: 'assigned', authorId: s.agentA.id, data: { ownerId: s.agentA.id, previousOwnerId: null } });
    expect(published(id)).toBe(true);
  });

  it('404 for a chat of another sector, 409 for a closed chat', async () => {
    const other = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorB });
    const closed = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, state: 'closed' });
    expect(await statusOf(assumeChat(ctx, s.agentA, other))).toBe(404);
    expect(await statusOf(assumeChat(ctx, s.agentA, closed))).toBe(409);
  });
});

describe('transferChat', () => {
  it('moves to another sector, clears owner and privacy, and publishes so the old sector drops it', async () => {
    const id = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, ownerId: s.agentA.id, private: true });
    ctx.hub.events.length = 0;
    const chat = await transferChat(ctx, s.agentA, id, { sectorId: s.sectorB, ownerId: null });
    expect(chat).toMatchObject({ sectorId: s.sectorB, ownerId: null, private: false });
    const [ev] = await eventsOf(ctx, id);
    expect(ev).toMatchObject({
      kind: 'transferred',
      authorId: s.agentA.id,
      data: { fromSectorId: s.sectorA, toSectorId: s.sectorB, fromOwnerId: s.agentA.id, toOwnerId: null },
    });
    expect(published(id)).toBe(true);
    expect(canSee(s.agentA, chat)).toBe(false);
    expect(canSee(s.agentB, chat)).toBe(true);
    expect(await statusOf(transferChat(ctx, s.agentA, id, { sectorId: s.sectorA }))).toBe(404);
  });

  it('hands the chat to another agent and keeps the sector', async () => {
    const id = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, ownerId: s.agentA.id });
    const chat = await transferChat(ctx, s.agentA, id, { ownerId: s.agentB.id });
    expect(chat).toMatchObject({ sectorId: s.sectorA, ownerId: s.agentB.id });
  });

  it('400 for empty target, unknown sector or unknown agent; 409 for a closed chat', async () => {
    const id = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA });
    const closed = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, state: 'closed' });
    expect(await statusOf(transferChat(ctx, s.agentA, id, {}))).toBe(400);
    expect(await statusOf(transferChat(ctx, s.agentA, id, { sectorId: randomUUID() }))).toBe(400);
    expect(await statusOf(transferChat(ctx, s.agentA, id, { sectorId: 'x' }))).toBe(400);
    expect(await statusOf(transferChat(ctx, s.agentA, id, { ownerId: randomUUID() }))).toBe(400);
    expect(await statusOf(transferChat(ctx, s.agentA, closed, { sectorId: s.sectorB }))).toBe(409);
  });
});

describe('setChatPrivacy', () => {
  it('owner makes the chat private and back, recording privacy_changed', async () => {
    const id = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, ownerId: s.agentA.id });
    ctx.hub.events.length = 0;
    expect((await setChatPrivacy(ctx, s.agentA, id, true)).private).toBe(true);
    expect(published(id)).toBe(true);
    expect((await setChatPrivacy(ctx, s.agentA, id, false)).private).toBe(false);
    const evs = await eventsOf(ctx, id);
    expect(evs.map((e) => [e.kind, e.data])).toEqual([
      ['privacy_changed', { private: true }],
      ['privacy_changed', { private: false }],
    ]);
  });

  it('403 for a sector colleague who is not the owner; admin may', async () => {
    const id = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, ownerId: s.agentB.id });
    expect(await statusOf(setChatPrivacy(ctx, s.agentA, id, true))).toBe(403);
    expect((await setChatPrivacy(ctx, s.admin, id, true)).private).toBe(true);
  });

  it('400 when the chat has no owner', async () => {
    const id = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA });
    expect(await statusOf(setChatPrivacy(ctx, s.admin, id, true))).toBe(400);
  });
});

describe('private chats', () => {
  it('a sector colleague cannot transfer or close it (404); admin can close it', async () => {
    const id = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, ownerId: s.agentB.id, private: true });
    expect(await statusOf(transferChat(ctx, s.agentA, id, { sectorId: s.sectorB }))).toBe(404);
    expect(await statusOf(closeChat(ctx, s.agentA, id, { sendClosingMessage: false }))).toBe(404);
    expect((await closeChat(ctx, s.admin, id, { sendClosingMessage: false })).state).toBe('closed');
  });
});

describe('closeChat', () => {
  it('closes without sending when not asked', async () => {
    const id = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA });
    const sendClosing = vi.fn(async (_text: string) => {});
    ctx.hub.events.length = 0;
    const chat = await closeChat(ctx, s.agentA, id, { sendClosingMessage: false, sendClosing });
    expect(chat.state).toBe('closed');
    expect(chat.closedAt).toBeInstanceOf(Date);
    expect(chat.waiting).toBe(false);
    expect(sendClosing).not.toHaveBeenCalled();
    const [ev] = await eventsOf(ctx, id);
    expect(ev).toMatchObject({ kind: 'closed', authorId: s.agentA.id, data: { closingMessageSent: false } });
    expect(published(id)).toBe(true);
  });

  it('sends settings.closing_message while the chat is still open, then closes', async () => {
    const text = 'Obrigado pelo contato!';
    await ctx.db
      .insert(settings)
      .values({ key: 'closing_message', value: text })
      .onConflictDoUpdate({ target: settings.key, set: { value: text } });
    const id = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA });
    const seen: string[] = [];
    const sendClosing = async (t: string) => {
      const [c] = await ctx.db.select().from(chats).where(eq(chats.id, id));
      seen.push(`${c!.state}:${t}`);
    };
    const chat = await closeChat(ctx, s.agentA, id, { sendClosingMessage: true, sendClosing });
    expect(seen).toEqual(['open:Obrigado pelo contato!']);
    expect(chat.state).toBe('closed');
    const [ev] = await eventsOf(ctx, id);
    expect(ev?.data).toEqual({ closingMessageSent: true });
  });

  it('409 when already closed', async () => {
    const id = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, state: 'closed' });
    expect(await statusOf(closeChat(ctx, s.agentA, id, { sendClosingMessage: false }))).toBe(409);
  });
});

describe('reopenChat', () => {
  it('reopens a closed chat', async () => {
    const id = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, state: 'closed' });
    ctx.hub.events.length = 0;
    const chat = await reopenChat(ctx, s.agentA, id);
    expect(chat).toMatchObject({ id, state: 'open', closedAt: null });
    const [ev] = await eventsOf(ctx, id);
    expect(ev).toMatchObject({ kind: 'reopened', authorId: s.agentA.id });
    expect(published(id)).toBe(true);
  });

  it('returns the other open chat of the same contact instead of reopening', async () => {
    const contactId = await newContact(ctx);
    const closed = await insertChat(ctx, { contactId, channelId: s.channelId, sectorId: s.sectorA, state: 'closed' });
    const open = await insertChat(ctx, { contactId, channelId: s.channelId, sectorId: s.sectorA });
    const chat = await reopenChat(ctx, s.agentA, closed);
    expect(chat.id).toBe(open);
    const [old] = await ctx.db.select().from(chats).where(eq(chats.id, closed));
    expect(old!.state).toBe('closed');
  });

  it('409 when the other open chat is invisible to me', async () => {
    const contactId = await newContact(ctx);
    const closed = await insertChat(ctx, { contactId, channelId: s.channelId, sectorId: s.sectorA, state: 'closed' });
    await insertChat(ctx, { contactId, channelId: s.channelId, sectorId: s.sectorB });
    expect(await statusOf(reopenChat(ctx, s.agentA, closed))).toBe(409);
  });

  it('409 when the chat is already open', async () => {
    const id = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA });
    expect(await statusOf(reopenChat(ctx, s.agentA, id))).toBe(409);
  });
});
```

- [ ] **Step 14: Run the test to verify it fails**

Run: `npm test -w server -- test/inbox/chats-actions.test.ts`
Expected: FAIL. `assumeChat` (and the other actions) are not exported from `chats.ts`, so you see `assumeChat is not a function` or a SyntaxError about a missing export.

- [ ] **Step 15: Append the attendance actions to chats.ts**

Append to the end of `server/src/inbox/chats.ts`. Do not change the existing content.

```ts
// ponytail: canSee already limits a private chat to owner + admin, so "only owner/admin transfer or close a
// private chat" (§5.3) holds through getChatForUser's 404; no separate check.

/** `owner_id IS NOT DISTINCT FROM ownerId` */
function sameOwner(ownerId: string | null): SQL {
  return ownerId === null ? isNull(chats.ownerId) : eq(chats.ownerId, ownerId);
}

/** UPDATE … WHERE id AND expected (0 rows → 409) + event in one transaction; publishes after commit. */
async function updateChat(
  ctx: AppCtx,
  chatId: string,
  expected: SQL | undefined,
  set: Partial<typeof chats.$inferInsert>,
  event: { kind: ChatEventKind; data: Record<string, unknown>; authorId: string | null },
): Promise<ChatRow> {
  const row = await ctx.db.transaction(async (tx) => {
    const [updated] = await tx
      .update(chats)
      .set(set)
      .where(and(eq(chats.id, chatId), expected))
      .returning();
    if (!updated) throw conflict(STALE);
    await addEvent(tx, chatId, event.kind, event.data, event.authorId);
    return updated;
  });
  await ctx.hub.publishChat(chatId);
  return row;
}

async function sectorExists(db: Db | Tx, id: string): Promise<boolean> {
  if (!UUID_RE.test(id)) return false;
  const [row] = await db.select({ id: sectors.id }).from(sectors).where(eq(sectors.id, id));
  return !!row;
}

async function activeUserExists(db: Db | Tx, id: string): Promise<boolean> {
  if (!UUID_RE.test(id)) return false;
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, id), eq(users.active, true)));
  return !!row;
}

async function getClosingMessage(db: Db | Tx): Promise<string> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, 'closing_message'));
  return typeof row?.value === 'string' ? row.value.trim() : '';
}

export async function assumeChat(ctx: AppCtx, user: AuthUser, chatId: string): Promise<ChatRow> {
  const chat = await getChatForUser(ctx, user, chatId);
  if (chat.state !== 'open') throw conflict('Conversa finalizada.');
  if (chat.ownerId === user.id) return chat;
  return updateChat(
    ctx,
    chatId,
    and(eq(chats.state, 'open'), sameOwner(chat.ownerId)),
    { ownerId: user.id },
    { kind: 'assigned', data: { ownerId: user.id, previousOwnerId: chat.ownerId }, authorId: user.id },
  );
}

export async function transferChat(
  ctx: AppCtx,
  user: AuthUser,
  chatId: string,
  to: { sectorId?: string; ownerId?: string | null },
): Promise<ChatRow> {
  if (to.sectorId === undefined && to.ownerId === undefined) throw badRequest('Informe o setor ou o atendente.');
  const chat = await getChatForUser(ctx, user, chatId);
  if (chat.state !== 'open') throw conflict('Conversa finalizada.');
  if (to.sectorId !== undefined && !(await sectorExists(ctx.db, to.sectorId))) throw badRequest('Setor inválido.');
  if (to.ownerId && !(await activeUserExists(ctx.db, to.ownerId))) throw badRequest('Atendente inválido.');

  const sectorId = to.sectorId ?? chat.sectorId;
  const ownerId = to.ownerId === undefined ? chat.ownerId : to.ownerId;
  return updateChat(
    ctx,
    chatId,
    and(eq(chats.state, 'open'), eq(chats.sectorId, chat.sectorId), sameOwner(chat.ownerId)),
    ownerId === null ? { sectorId, ownerId, private: false } : { sectorId, ownerId },
    {
      kind: 'transferred',
      data: { fromSectorId: chat.sectorId, toSectorId: sectorId, fromOwnerId: chat.ownerId, toOwnerId: ownerId },
      authorId: user.id,
    },
  );
}

export async function setChatPrivacy(ctx: AppCtx, user: AuthUser, chatId: string, isPrivate: boolean): Promise<ChatRow> {
  const chat = await getChatForUser(ctx, user, chatId);
  if (user.role !== 'admin' && chat.ownerId !== user.id) {
    throw forbidden('Só o dono da conversa ou um administrador pode alterar a privacidade.');
  }
  if (chat.private === isPrivate) return chat;
  if (isPrivate && chat.ownerId === null) throw badRequest('Assuma a conversa antes de torná-la privada.');
  return updateChat(
    ctx,
    chatId,
    and(eq(chats.private, chat.private), sameOwner(chat.ownerId)),
    { private: isPrivate },
    { kind: 'privacy_changed', data: { private: isPrivate }, authorId: user.id },
  );
}

/**
 * opts.sendClosing is wired by the route (Task 13) to sendAgentMessage(ctx, user, chatId, { text, signature: false }).
 * It runs before the UPDATE so the message goes out while the chat is still open.
 */
export async function closeChat(
  ctx: AppCtx,
  user: AuthUser,
  chatId: string,
  opts: { sendClosingMessage: boolean; sendClosing?: (text: string) => Promise<void> },
): Promise<ChatRow> {
  const chat = await getChatForUser(ctx, user, chatId);
  if (chat.state !== 'open') throw conflict('A conversa já está finalizada.');
  let closingMessageSent = false;
  if (opts.sendClosingMessage) {
    const text = await getClosingMessage(ctx.db);
    if (text) {
      if (!opts.sendClosing) throw new Error('closeChat: sendClosing was not provided');
      await opts.sendClosing(text);
      closingMessageSent = true;
    }
  }
  // Only state is checked: sending the closing message may legitimately have set the owner (§5.2 step 2).
  return updateChat(
    ctx,
    chatId,
    eq(chats.state, 'open'),
    { state: 'closed', closedAt: new Date(), waiting: false, triagePending: false },
    { kind: 'closed', data: { closingMessageSent }, authorId: user.id },
  );
}

export async function reopenChat(ctx: AppCtx, user: AuthUser, chatId: string): Promise<ChatRow> {
  const chat = await getChatForUser(ctx, user, chatId);
  if (chat.state !== 'closed') throw conflict('A conversa já está aberta.');
  const [other] = await ctx.db
    .select()
    .from(chats)
    .where(and(eq(chats.contactId, chat.contactId), eq(chats.channelId, chat.channelId), eq(chats.state, 'open')));
  if (other) {
    if (!canSee(user, other)) throw conflict(BUSY_ELSEWHERE);
    return other;
  }
  // ponytail: a chat opened between this check and the UPDATE trips the partial unique index (500);
  // at 3–10 agents a retry from the UI is enough. Catch 23505 here if it ever shows up in logs.
  return updateChat(
    ctx,
    chatId,
    eq(chats.state, 'closed'),
    { state: 'open', closedAt: null },
    { kind: 'reopened', data: {}, authorId: user.id },
  );
}
```

- [ ] **Step 16: Run the test to verify it passes**

Run: `npm test -w server -- test/inbox/chats-actions.test.ts`
Expected: PASS (16 tests)

- [ ] **Step 17: Commit**

```bash
git add server/src/inbox/chats.ts server/test/inbox/chats-actions.test.ts
git commit -m "feat(inbox): assume, transfer, privacy, close and reopen chat actions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 18: Write the failing test for read, pins and startChat**

Create `server/test/inbox/chats-start.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { chats, contacts } from '../../src/db/schema.js';
import { markChatRead, pinChat, startChat, transferChat } from '../../src/inbox/chats.js';
import { makeTestCtx, seedBasics } from '../helpers.js';
import { eventsOf, insertChat, newContact, statusOf } from './fixtures.js';

let ctx: Awaited<ReturnType<typeof makeTestCtx>>;
let s: Awaited<ReturnType<typeof seedBasics>>;

beforeEach(async () => {
  ctx = await makeTestCtx();
  s = await seedBasics(ctx);
});

function published(chatId: string): boolean {
  return ctx.hub.events.some((e) => e.chatId === chatId);
}

describe('markChatRead', () => {
  it('zeroes unread and publishes only when something changed', async () => {
    const id = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, unread: 5 });
    ctx.hub.events.length = 0;
    await markChatRead(ctx, s.agentA, id);
    const [row] = await ctx.db.select().from(chats).where(eq(chats.id, id));
    expect(row!.unread).toBe(0);
    expect(published(id)).toBe(true);

    ctx.hub.events.length = 0;
    await markChatRead(ctx, s.agentA, id);
    expect(published(id)).toBe(false);
  });

  it('404 for an invisible chat', async () => {
    const id = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorB, unread: 2 });
    expect(await statusOf(markChatRead(ctx, s.agentA, id))).toBe(404);
  });
});

describe('pinChat', () => {
  it('allows 3 pins, rejects the 4th with 409, and unpinning frees a slot', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push(await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA }));
    for (const id of ids.slice(0, 3)) await pinChat(ctx, s.agentA, id, true);
    await pinChat(ctx, s.agentA, ids[0]!, true); // pinning again is a no-op, not a 4th pin
    expect(await statusOf(pinChat(ctx, s.agentA, ids[3]!, true))).toBe(409);

    ctx.hub.events.length = 0;
    await pinChat(ctx, s.agentA, ids[0]!, false);
    expect(published(ids[0]!)).toBe(true);
    await pinChat(ctx, s.agentA, ids[3]!, true);
  });

  it('pins of chats that left my view do not count toward the limit', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push(await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA }));
    for (const id of ids.slice(0, 3)) await pinChat(ctx, s.agentA, id, true);
    await transferChat(ctx, s.admin, ids[0]!, { sectorId: s.sectorB });
    await pinChat(ctx, s.agentA, ids[3]!, true);
  });

  it('pins are per user', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push(await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA }));
    for (const id of ids.slice(0, 3)) await pinChat(ctx, s.agentA, id, true);
    await pinChat(ctx, s.admin, ids[3]!, true);
  });

  it('404 for an invisible chat', async () => {
    const id = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorB });
    expect(await statusOf(pinChat(ctx, s.agentA, id, true))).toBe(404);
  });
});

describe('startChat', () => {
  it('opens a chat for an existing contact, owned by me, in the default sector, without waiting/triage', async () => {
    const contactId = await newContact(ctx);
    ctx.hub.events.length = 0;
    const chat = await startChat(ctx, s.agentA, { contactId });
    expect(chat).toMatchObject({
      contactId,
      channelId: s.channelId,
      sectorId: s.defaultSector,
      ownerId: s.agentA.id,
      state: 'open',
      waiting: false,
      triagePending: false,
    });
    const [ev] = await eventsOf(ctx, chat.id);
    expect(ev).toMatchObject({ kind: 'created', data: { by: s.agentA.id }, authorId: s.agentA.id });
    expect(published(chat.id)).toBe(true);
  });

  it('uses the requested sector', async () => {
    const contactId = await newContact(ctx);
    const chat = await startChat(ctx, s.agentA, { contactId, sectorId: s.sectorB });
    expect(chat.sectorId).toBe(s.sectorB);
  });

  it('creates the contact for a new phone, normalized to 13 digits', async () => {
    const chat = await startChat(ctx, s.agentA, { phone: '+55 65 9999-8888', name: 'Maria' });
    const [c] = await ctx.db.select().from(contacts).where(eq(contacts.id, chat.contactId));
    expect(c).toMatchObject({ phone: '5565999998888', name: 'Maria' });
  });

  it('a 12-digit phone reaches the contact stored with 13 digits', async () => {
    const contactId = await newContact(ctx, { phone: '5565999997777' });
    const chat = await startChat(ctx, s.agentA, { phone: '556599997777' });
    expect(chat.contactId).toBe(contactId);
    expect(await ctx.db.select().from(contacts).where(eq(contacts.phone, '5565999997777'))).toHaveLength(1);
  });

  it('returns the already open chat instead of opening another', async () => {
    const contactId = await newContact(ctx);
    const existing = await insertChat(ctx, { contactId, channelId: s.channelId, sectorId: s.sectorA, ownerId: s.agentB.id });
    const chat = await startChat(ctx, s.agentA, { contactId });
    expect(chat.id).toBe(existing);
    expect(chat.ownerId).toBe(s.agentB.id);
    expect(await ctx.db.select().from(chats).where(eq(chats.contactId, contactId))).toHaveLength(1);
  });

  it('409 when the open chat is in a sector I cannot see', async () => {
    const contactId = await newContact(ctx);
    await insertChat(ctx, { contactId, channelId: s.channelId, sectorId: s.sectorB });
    expect(await statusOf(startChat(ctx, s.agentA, { contactId }))).toBe(409);
  });

  it('validates the input', async () => {
    expect(await statusOf(startChat(ctx, s.agentA, {}))).toBe(400);
    expect(await statusOf(startChat(ctx, s.agentA, { phone: '123' }))).toBe(400);
    expect(await statusOf(startChat(ctx, s.agentA, { contactId: randomUUID() }))).toBe(404);
    expect(await statusOf(startChat(ctx, s.agentA, { contactId: 'x' }))).toBe(404);
    expect(await statusOf(startChat(ctx, s.agentA, { phone: '65999998888', sectorId: randomUUID() }))).toBe(400);
  });
});
```

- [ ] **Step 19: Run the test to verify it fails**

Run: `npm test -w server -- test/inbox/chats-start.test.ts`
Expected: FAIL. `markChatRead`, `pinChat` and `startChat` are not exported from `chats.ts` (`markChatRead is not a function`).

- [ ] **Step 20: Append read, pin and startChat to chats.ts**

Append to the end of `server/src/inbox/chats.ts`:

```ts
const MAX_PINS = 3;

export async function markChatRead(ctx: AppCtx, user: AuthUser, chatId: string): Promise<void> {
  await getChatForUser(ctx, user, chatId);
  const changed = await ctx.db
    .update(chats)
    .set({ unread: 0 })
    .where(and(eq(chats.id, chatId), gt(chats.unread, 0)))
    .returning({ id: chats.id });
  if (changed.length) await ctx.hub.publishChat(chatId);
}

export async function pinChat(ctx: AppCtx, user: AuthUser, chatId: string, pinned: boolean): Promise<void> {
  await getChatForUser(ctx, user, chatId);
  if (!pinned) {
    await ctx.db.delete(chatPins).where(and(eq(chatPins.userId, user.id), eq(chatPins.chatId, chatId)));
  } else {
    // Only pins of chats I still see count, so a chat transferred away never blocks a slot.
    const pins = await ctx.db
      .select({ chatId: chatPins.chatId })
      .from(chatPins)
      .innerJoin(chats, eq(chats.id, chatPins.chatId))
      .where(and(eq(chatPins.userId, user.id), visibleChatsWhere(user)));
    if (pins.some((p) => p.chatId === chatId)) return;
    // ponytail: count-then-insert can race to 4 pins with two tabs clicking at once; harmless.
    if (pins.length >= MAX_PINS) throw conflict('Você já fixou 3 conversas. Desafixe uma para fixar outra.');
    await ctx.db.insert(chatPins).values({ userId: user.id, chatId, createdAt: new Date() }).onConflictDoNothing();
  }
  await ctx.hub.publishChat(chatId);
}

async function resolveContactId(tx: Tx, input: { contactId?: string; phone?: string; name?: string }): Promise<string> {
  if (input.contactId) {
    if (!UUID_RE.test(input.contactId)) throw notFound('Contato não encontrado.');
    const [c] = await tx.select({ id: contacts.id }).from(contacts).where(eq(contacts.id, input.contactId));
    if (!c) throw notFound('Contato não encontrado.');
    return c.id;
  }
  if (!input.phone) throw badRequest('Informe o contato ou o telefone.');
  const phone = normalizePhoneBR(input.phone);
  if (!/^55\d{10,11}$/.test(phone)) throw badRequest('Telefone inválido.');
  const now = new Date();
  await tx
    .insert(contacts)
    .values({ id: randomUUID(), name: input.name?.trim() || null, phone, blocked: false, createdAt: now, updatedAt: now })
    .onConflictDoNothing();
  const [c] = await tx.select({ id: contacts.id }).from(contacts).where(eq(contacts.phone, phone));
  if (!c) throw new Error('startChat: contact insert conflicted but no contact was found');
  return c.id;
}

/** §5.3a. Owner = me, waiting=false, triage_pending=false, no triage; reuses the open (contact, channel) chat. */
export async function startChat(
  ctx: AppCtx,
  user: AuthUser,
  input: { contactId?: string; phone?: string; name?: string; sectorId?: string },
): Promise<ChatRow> {
  if (input.sectorId !== undefined && !(await sectorExists(ctx.db, input.sectorId))) throw badRequest('Setor inválido.');
  const sectorId = input.sectorId ?? (await getDefaultSectorId(ctx.db));
  // ponytail: one WhatsApp number today; take the oldest channel. Add channelId to the input when a second number exists.
  const [channel] = await ctx.db.select({ id: channels.id }).from(channels).orderBy(asc(channels.createdAt)).limit(1);
  if (!channel) throw conflict('Nenhum canal de WhatsApp cadastrado.');

  const { chat, created } = await ctx.db.transaction(async (tx) => {
    const contactId = await resolveContactId(tx, input);
    return findOrOpenChat(tx, {
      contactId,
      channelId: channel.id,
      init: { sectorId, ownerId: user.id, waiting: false, triagePending: false, createdBy: user.id },
    });
  });
  if (!created && !canSee(user, chat)) throw conflict(BUSY_ELSEWHERE);
  if (created) await ctx.hub.publishChat(chat.id);
  return chat;
}
```

- [ ] **Step 21: Run the test to verify it passes**

Run: `npm test -w server -- test/inbox/chats-start.test.ts`
Expected: PASS (13 tests)

- [ ] **Step 22: Run the whole inbox suite and the typecheck**

Run: `npm test -w server -- test/inbox`
Expected: PASS (4 files, 45 tests)

Run: `npx tsc -p server/tsconfig.json --noEmit`
Expected: exit code 0, no errors. Every import in `chats.ts` is now used.

- [ ] **Step 23: Commit**

```bash
git add server/src/inbox/chats.ts server/test/inbox/chats-start.test.ts
git commit -m "feat(inbox): mark read, per-user pins (max 3) and start chat

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


---

### Task 8: Realtime hub and /ws route

Implements §5.5 (realtime) and the `/ws` part of §6 (Origin check, session cookie, visibility via `canSee`). Also creates the two DTO mappers the hub needs, so later tasks reuse them instead of writing their own: `messages/dto.ts` `toMessageDto` (Task 10 consumes it) and `inbox/queries.ts` `toChatListItem` (Task 13 adds `listChats`/`getChatDetail`/`getTimeline` to the same file and keeps this signature).

**Files:**
- Create: `server/src/messages/dto.ts`
- Create: `server/src/inbox/queries.ts` (only `toChatListItem` for now; Task 13 extends the file)
- Create: `server/src/realtime/hub.ts`
- Create: `server/src/realtime/routes.ts`
- Modify: `server/src/app.ts` (register `realtimeRoutes(ctx)`)
- Modify: `server/test/helpers.ts` (`makeTestCtx` returns `hub: createRecordingHub()`)
- Modify: `server/package.json` (dependencies `@fastify/websocket`, `ws`, dev `@types/ws`)
- Test: `server/test/messages/dto.test.ts`
- Test: `server/test/realtime/hub.test.ts`
- Test: `server/test/realtime/ws.test.ts`

**Interfaces:**
- Consumes:
  - `AppCtx` (`server/src/ctx.ts`): `{ db: Db; wa: WhatsAppGateway; hub: Hub; config: Config }`; `config.appOrigin: string`.
  - `Db`, `Tx` from `server/src/db/client.ts`.
  - Schema tables from `server/src/db/schema.ts`: `users`, `sessions`, `channels`, `contacts`, `tags`, `contactTags`, `chats`, `chatPins`, `messages`.
  - `AuthUser`, `canSee(user: AuthUser, chat: ChatVisibilityFields): boolean`, `loadAuthUser(db: Db | Tx, userId: string): Promise<AuthUser | null>` from `server/src/inbox/visibility.ts` (Task 7).
  - `ChatRow` type from `server/src/inbox/chats.ts` (Task 7).
  - Session cookie `sid` set by `POST /api/auth/login` (Task 6); `sessions.id` = SHA-256 hex of the raw cookie token; `@fastify/cookie` registered on the root instance by Task 6 (`request.cookies`).
  - Test helpers (`server/test/helpers.ts`): `makeTestCtx()`, `seedBasics(ctx)`, `makeTestApp(ctx?)`, `loginAs(app, email, password?)`.
  - Shared types from the `shared` workspace (`@talk/shared`): `ChatListItem`, `MessageDto`, `ChannelDto`, `WsEvent`.
- Produces:
  - `server/src/messages/dto.ts`: `export async function toMessageDto(db: Db | Tx, row: typeof messages.$inferSelect): Promise<MessageDto>;` — `media.url` is `/api/media/<messageId>`; `mediaUnavailable` is true when a media kind has no stored file and `error` is set.
  - `server/src/inbox/queries.ts`: `export async function toChatListItem(db: Db | Tx, chat: ChatRow, userId: string): Promise<ChatListItem>;` — `pinned` is per `userId`; `tagIds` are the contact's tags.
  - `server/src/realtime/hub.ts`: `Hub`, `createHub(getDb: () => Db): Hub`, `createRecordingHub(): Hub & { events: Array<{ type: string; chatId?: string; messageId?: string; channelId?: string; userId?: string }> }`.
    Recording hub event shapes (other tasks assert on these exactly):
    - `publishChat(chatId)` → `{ type: 'chat', chatId }`
    - `publishMessage(chatId, type, messageId)` → `{ type: 'message.created' | 'message.updated', chatId, messageId }`
    - `publishChannel(channelId)` → `{ type: 'channel', channelId }`
    - `disconnectUser(userId)` → `{ type: 'disconnect', userId }`
  - `server/src/realtime/routes.ts`: `export function realtimeRoutes(ctx: AppCtx): FastifyPluginAsync;` — `GET /ws`: missing/different `Origin` → 403 `{ error: 'Origem não permitida' }`; missing/invalid/expired session or inactive user → 401 `{ error: 'Não autenticado' }`; otherwise upgrades, sends `WsEvent` JSON strings, pings every 30 s and terminates a socket that missed a pong.
  - `makeTestCtx()` now returns `hub: ReturnType<typeof createRecordingHub>`.

- [ ] **Step 1: Install the WebSocket dependencies**

Run from repo root:

```bash
npm install -w server --save-exact @fastify/websocket@11.3.4 ws@8.22.0
npm install -w server --save-dev --save-exact @types/ws@8.18.1
```

Expected: `server/package.json` lists `"@fastify/websocket": "11.3.4"` and `"ws": "8.22.0"` under `dependencies` and `"@types/ws": "8.18.1"` under `devDependencies` (if Task 1 already added them, npm reports "up to date").

- [ ] **Step 2: Write the failing test for `toMessageDto`**

Create `server/test/messages/dto.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { chats, contacts, messages } from '../../src/db/schema.js';
import { toMessageDto } from '../../src/messages/dto.js';
import { makeTestCtx, seedBasics } from '../helpers.js';

async function setup() {
  const ctx = await makeTestCtx();
  const s = await seedBasics(ctx);
  const contactId = randomUUID();
  await ctx.db.insert(contacts).values({ id: contactId, name: 'João Lima', phone: '5565999990001' });
  const chatId = randomUUID();
  await ctx.db.insert(chats).values({
    id: chatId, contactId, channelId: s.channelId, sectorId: s.sectorA, ownerId: s.agentA.id,
    state: 'open', waiting: false, private: false, triagePending: false, unread: 0,
  });
  return { ctx, s, chatId };
}

describe('toMessageDto', () => {
  it('maps a stored media message with author name and quoted reply', async () => {
    const { ctx, s, chatId } = await setup();
    const quotedId = randomUUID();
    await ctx.db.insert(messages).values({
      id: quotedId, chatId, channelId: s.channelId, direction: 'in', kind: 'text',
      body: 'Pode mandar o contrato?', externalId: 'ext-1', status: 'sent',
      sentAt: new Date('2026-10-14T12:00:00Z'),
    });
    const id = randomUUID();
    const [row] = await ctx.db.insert(messages).values({
      id, chatId, channelId: s.channelId, direction: 'out', kind: 'document', body: 'Segue',
      mediaPath: '2026/10/abc.pdf', mediaMime: 'application/pdf', mediaSize: 1234, mediaName: 'contrato.pdf',
      authorId: s.agentA.id, replyToId: quotedId, status: 'pending',
      sentAt: new Date('2026-10-14T12:05:00Z'),
    }).returning();

    expect(await toMessageDto(ctx.db, row)).toEqual({
      id, chatId, direction: 'out', kind: 'document', body: 'Segue',
      media: { url: `/api/media/${id}`, mime: 'application/pdf', name: 'contrato.pdf', size: 1234 },
      mediaUnavailable: false,
      authorId: s.agentA.id, authorName: s.agentA.name,
      replyTo: { id: quotedId, body: 'Pode mandar o contrato?', kind: 'text' },
      reaction: null, status: 'pending', error: null,
      sentAt: '2026-10-14T12:05:00.000Z',
    });
  });

  it('flags inbound media whose download failed as unavailable', async () => {
    const { ctx, s, chatId } = await setup();
    const [row] = await ctx.db.insert(messages).values({
      id: randomUUID(), chatId, channelId: s.channelId, direction: 'in', kind: 'image', body: null,
      externalId: 'ext-2', reaction: '👍', status: 'sent', error: 'mídia indisponível',
      sentAt: new Date('2026-10-14T12:10:00Z'),
    }).returning();

    const dto = await toMessageDto(ctx.db, row);

    expect(dto.media).toBeNull();
    expect(dto.mediaUnavailable).toBe(true);
    expect(dto.authorId).toBeNull();
    expect(dto.authorName).toBeNull();
    expect(dto.replyTo).toBeNull();
    expect(dto.reaction).toBe('👍');
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm test -w server -- test/messages/dto.test.ts`
Expected: FAIL — `Failed to load url ../../src/messages/dto.js` / `Cannot find module '../../src/messages/dto.js'`.

- [ ] **Step 4: Implement `toMessageDto`**

Create `server/src/messages/dto.ts`:

```ts
import { eq } from 'drizzle-orm';
import type { MessageDto } from '@talk/shared';
import type { Db, Tx } from '../db/client.js';
import { messages, users } from '../db/schema.js';

type MessageRow = typeof messages.$inferSelect;

const MEDIA_KINDS = new Set(['image', 'audio', 'video', 'document', 'sticker']);

export async function toMessageDto(db: Db | Tx, row: MessageRow): Promise<MessageDto> {
  const [author] = row.authorId
    ? await db.select({ name: users.name }).from(users).where(eq(users.id, row.authorId))
    : [];
  const [reply] = row.replyToId
    ? await db.select({ id: messages.id, body: messages.body, kind: messages.kind }).from(messages).where(eq(messages.id, row.replyToId))
    : [];

  return {
    id: row.id,
    chatId: row.chatId,
    direction: row.direction,
    kind: row.kind,
    body: row.body,
    media: row.mediaPath
      ? { url: `/api/media/${row.id}`, mime: row.mediaMime ?? 'application/octet-stream', name: row.mediaName, size: row.mediaSize }
      : null,
    // A media message without a file and with an error is a failed download (§5.1 step 6).
    // Without an error the download is still running; message.updated follows.
    mediaUnavailable: MEDIA_KINDS.has(row.kind) && !row.mediaPath && row.error !== null,
    authorId: row.authorId,
    authorName: author?.name ?? null,
    replyTo: reply ?? null,
    reaction: row.reaction,
    status: row.status,
    error: row.error,
    sentAt: row.sentAt.toISOString(),
  };
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npm test -w server -- test/messages/dto.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add server/package.json package-lock.json server/src/messages/dto.ts server/test/messages/dto.test.ts
git commit -m "feat(server): add MessageDto mapper and websocket dependencies" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Write the failing hub test**

Create `server/test/realtime/hub.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { WsEvent } from '@talk/shared';
import type { AppCtx } from '../../src/ctx.js';
import { channels, chatPins, chats, contactTags, contacts, messages, tags } from '../../src/db/schema.js';
import { createHub, createRecordingHub, type Hub } from '../../src/realtime/hub.js';
import { makeTestCtx, seedBasics } from '../helpers.js';

type Seed = Awaited<ReturnType<typeof seedBasics>>;

function fakeSocket() {
  const socket = {
    events: [] as WsEvent[],
    closed: false,
    send(data: string) { socket.events.push(JSON.parse(data) as WsEvent); },
    close() { socket.closed = true; },
  };
  return socket;
}

let phoneSeq = 0;
async function insertChat(ctx: AppCtx, channelId: string, init: { sectorId: string; ownerId?: string | null; private?: boolean }) {
  const contactId = randomUUID();
  const phone = `55659${String(++phoneSeq).padStart(8, '0')}`;
  await ctx.db.insert(contacts).values({ id: contactId, name: 'Maria Souza', phone });
  const [chat] = await ctx.db.insert(chats).values({
    id: randomUUID(), contactId, channelId, sectorId: init.sectorId, ownerId: init.ownerId ?? null,
    state: 'open', waiting: true, private: init.private ?? false, triagePending: false, unread: 1,
    lastMessageAt: new Date('2026-10-14T12:00:00Z'), lastMessagePreview: 'Olá',
  }).returning();
  return { chat, contactId, phone };
}

let ctx: AppCtx;
let s: Seed;
let hub: Hub;

beforeEach(async () => {
  const base = await makeTestCtx();
  s = await seedBasics(base);
  ctx = base;
  hub = createHub(() => base.db);
});

describe('createHub.publishChat', () => {
  it('sends chat.updated to users who can see the chat and chat.removed to the rest, recomputed after a transfer', async () => {
    const a = fakeSocket(); const b = fakeSocket(); const adm = fakeSocket();
    hub.register(s.agentA, a); hub.register(s.agentB, b); hub.register(s.admin, adm);
    const { chat } = await insertChat(ctx, s.channelId, { sectorId: s.sectorA });

    await hub.publishChat(chat.id);

    expect(a.events).toEqual([{ type: 'chat.updated', chat: expect.objectContaining({ id: chat.id, sectorId: s.sectorA }) }]);
    expect(adm.events).toEqual([{ type: 'chat.updated', chat: expect.objectContaining({ id: chat.id }) }]);
    expect(b.events).toEqual([{ type: 'chat.removed', chatId: chat.id }]);

    // Transfer to sector B (done directly in the DB; the hub must recompute visibility from the DB).
    await ctx.db.update(chats).set({ sectorId: s.sectorB }).where(eq(chats.id, chat.id));
    await hub.publishChat(chat.id);

    expect(a.events[1]).toEqual({ type: 'chat.removed', chatId: chat.id });
    expect(b.events[1]).toEqual({ type: 'chat.updated', chat: expect.objectContaining({ id: chat.id, sectorId: s.sectorB }) });
    expect(adm.events[1]).toEqual({ type: 'chat.updated', chat: expect.objectContaining({ id: chat.id, sectorId: s.sectorB }) });
  });

  it('sends the full ChatListItem with per-user pinned flag and contact tags', async () => {
    const a = fakeSocket(); const adm = fakeSocket();
    hub.register(s.agentA, a); hub.register(s.admin, adm);
    const { chat, contactId, phone } = await insertChat(ctx, s.channelId, { sectorId: s.sectorA });
    const tagId = randomUUID();
    await ctx.db.insert(tags).values({ id: tagId, name: 'Cliente', emoji: null, color: '#22c55e', position: 0 });
    await ctx.db.insert(contactTags).values({ contactId, tagId });
    await ctx.db.insert(chatPins).values({ userId: s.agentA.id, chatId: chat.id });

    await hub.publishChat(chat.id);

    const expected = {
      id: chat.id,
      contact: { id: contactId, name: 'Maria Souza', phone },
      channelId: s.channelId,
      sectorId: s.sectorA,
      ownerId: null,
      state: 'open',
      waiting: true,
      private: false,
      unread: 1,
      lastMessageAt: '2026-10-14T12:00:00.000Z',
      lastMessagePreview: 'Olá',
      pinned: true,
      tagIds: [tagId],
    };
    expect(a.events).toEqual([{ type: 'chat.updated', chat: expected }]);
    expect(adm.events).toEqual([{ type: 'chat.updated', chat: { ...expected, pinned: false } }]);
  });

  it('sends a private chat only to its owner and admins, even to members of its sector', async () => {
    const a = fakeSocket(); const b = fakeSocket(); const adm = fakeSocket();
    hub.register(s.agentA, a); hub.register(s.agentB, b); hub.register(s.admin, adm);
    // Chat in sector B (agentB's sector) but private to agentA.
    const { chat } = await insertChat(ctx, s.channelId, { sectorId: s.sectorB, ownerId: s.agentA.id, private: true });

    await hub.publishChat(chat.id);

    expect(a.events.map((e) => e.type)).toEqual(['chat.updated']);
    expect(adm.events.map((e) => e.type)).toEqual(['chat.updated']);
    expect(b.events).toEqual([{ type: 'chat.removed', chatId: chat.id }]);
  });
});

describe('createHub.publishMessage', () => {
  it('sends the MessageDto only to sockets whose user can see the chat', async () => {
    const a = fakeSocket(); const b = fakeSocket(); const adm = fakeSocket();
    hub.register(s.agentA, a); hub.register(s.agentB, b); hub.register(s.admin, adm);
    const { chat } = await insertChat(ctx, s.channelId, { sectorId: s.sectorA });
    const messageId = randomUUID();
    await ctx.db.insert(messages).values({
      id: messageId, chatId: chat.id, channelId: s.channelId, direction: 'out', kind: 'text', body: 'Bom dia',
      authorId: s.agentA.id, status: 'sent', sentAt: new Date('2026-10-14T12:01:00Z'),
    });

    await hub.publishMessage(chat.id, 'message.created', messageId);

    const message = {
      id: messageId, chatId: chat.id, direction: 'out', kind: 'text', body: 'Bom dia',
      media: null, mediaUnavailable: false, authorId: s.agentA.id, authorName: s.agentA.name,
      replyTo: null, reaction: null, status: 'sent', error: null, sentAt: '2026-10-14T12:01:00.000Z',
    };
    expect(a.events).toEqual([{ type: 'message.created', message }]);
    expect(adm.events).toEqual([{ type: 'message.created', message }]);
    expect(b.events).toEqual([]);

    await ctx.db.update(messages).set({ status: 'read' }).where(eq(messages.id, messageId));
    await hub.publishMessage(chat.id, 'message.updated', messageId);

    expect(a.events[1]).toEqual({ type: 'message.updated', message: { ...message, status: 'read' } });
    expect(b.events).toEqual([]);
  });
});

describe('createHub.publishChannel', () => {
  it('sends channel.status to every connected socket', async () => {
    const a = fakeSocket(); const b = fakeSocket();
    hub.register(s.agentA, a); hub.register(s.agentB, b);
    await ctx.db.update(channels).set({ status: 'connected', phone: '5565999990000' }).where(eq(channels.id, s.channelId));
    const [row] = await ctx.db.select().from(channels).where(eq(channels.id, s.channelId));

    await hub.publishChannel(s.channelId);

    const event = { type: 'channel.status', channel: { id: row.id, name: row.name, status: 'connected', phone: '5565999990000' } };
    expect(a.events).toEqual([event]);
    expect(b.events).toEqual([event]);
  });
});

describe('createHub.register / disconnectUser', () => {
  it('disconnectUser closes every socket of that user and stops delivery to them', async () => {
    const a1 = fakeSocket(); const a2 = fakeSocket(); const b = fakeSocket();
    hub.register(s.agentA, a1); hub.register(s.agentA, a2); hub.register(s.agentB, b);

    hub.disconnectUser(s.agentA.id);

    expect(a1.closed).toBe(true);
    expect(a2.closed).toBe(true);
    expect(b.closed).toBe(false);
    const { chat } = await insertChat(ctx, s.channelId, { sectorId: s.sectorA });
    await hub.publishChat(chat.id);
    expect(a1.events).toEqual([]);
    expect(a2.events).toEqual([]);
    expect(b.events).toEqual([{ type: 'chat.removed', chatId: chat.id }]);
  });

  it('the function returned by register stops delivery to that socket only', async () => {
    const a1 = fakeSocket(); const a2 = fakeSocket();
    const unregister = hub.register(s.agentA, a1);
    hub.register(s.agentA, a2);

    unregister();
    const { chat } = await insertChat(ctx, s.channelId, { sectorId: s.sectorA });
    await hub.publishChat(chat.id);

    expect(a1.events).toEqual([]);
    expect(a2.events.map((e) => e.type)).toEqual(['chat.updated']);
  });
});

describe('createRecordingHub', () => {
  it('records every call with the shapes other tasks assert on', async () => {
    const rec = createRecordingHub();
    await rec.publishChat('c1');
    await rec.publishMessage('c1', 'message.created', 'm1');
    await rec.publishMessage('c1', 'message.updated', 'm1');
    await rec.publishChannel('ch1');
    rec.disconnectUser('u1');
    rec.register(s.agentA, fakeSocket())();

    expect(rec.events).toEqual([
      { type: 'chat', chatId: 'c1' },
      { type: 'message.created', chatId: 'c1', messageId: 'm1' },
      { type: 'message.updated', chatId: 'c1', messageId: 'm1' },
      { type: 'channel', channelId: 'ch1' },
      { type: 'disconnect', userId: 'u1' },
    ]);
  });

  it('is the hub makeTestCtx provides', async () => {
    const t = await makeTestCtx();
    await t.hub.publishChat('x');
    expect(t.hub.events).toEqual([{ type: 'chat', chatId: 'x' }]);
  });
});
```

- [ ] **Step 8: Run it to verify it fails**

Run: `npm test -w server -- test/realtime/hub.test.ts`
Expected: FAIL — `Failed to load url ../../src/realtime/hub.js` / `Cannot find module '../../src/realtime/hub.js'`.

- [ ] **Step 9: Implement `toChatListItem`**

Create `server/src/inbox/queries.ts`:

```ts
import { and, eq } from 'drizzle-orm';
import type { ChatListItem } from '@talk/shared';
import type { Db, Tx } from '../db/client.js';
import { chatPins, contactTags, contacts } from '../db/schema.js';
import type { ChatRow } from './chats.js';

// Task 13 adds listChats, getChatDetail and getTimeline to this file. Keep this signature:
// the realtime hub (Task 8) calls it once per connected user on every chat change.
export async function toChatListItem(db: Db | Tx, chat: ChatRow, userId: string): Promise<ChatListItem> {
  const [contact] = await db
    .select({ id: contacts.id, name: contacts.name, phone: contacts.phone })
    .from(contacts)
    .where(eq(contacts.id, chat.contactId));
  const tagRows = await db
    .select({ tagId: contactTags.tagId })
    .from(contactTags)
    .where(eq(contactTags.contactId, chat.contactId));
  const pinRows = await db
    .select({ chatId: chatPins.chatId })
    .from(chatPins)
    .where(and(eq(chatPins.userId, userId), eq(chatPins.chatId, chat.id)));

  return {
    id: chat.id,
    contact: { id: contact.id, name: contact.name, phone: contact.phone },
    channelId: chat.channelId,
    sectorId: chat.sectorId,
    ownerId: chat.ownerId,
    state: chat.state,
    waiting: chat.waiting,
    private: chat.private,
    unread: chat.unread,
    lastMessageAt: chat.lastMessageAt ? chat.lastMessageAt.toISOString() : null,
    lastMessagePreview: chat.lastMessagePreview,
    pinned: pinRows.length > 0,
    tagIds: tagRows.map((r) => r.tagId),
  };
}
```

- [ ] **Step 10: Implement the hub**

Create `server/src/realtime/hub.ts`:

```ts
import { eq } from 'drizzle-orm';
import type { WsEvent } from '@talk/shared';
import type { Db } from '../db/client.js';
import { channels, chats, messages } from '../db/schema.js';
import { toChatListItem } from '../inbox/queries.js';
import { canSee, loadAuthUser, type AuthUser } from '../inbox/visibility.js';
import { toMessageDto } from '../messages/dto.js';

type Socket = { send(data: string): void; close(): void };

export interface Hub {
  register(user: AuthUser, socket: Socket): () => void; // returns unregister
  disconnectUser(userId: string): void;
  publishChat(chatId: string): Promise<void>;
  publishMessage(chatId: string, type: 'message.created' | 'message.updated', messageId: string): Promise<void>;
  publishChannel(channelId: string): Promise<void>;
}

function send(socket: Socket, event: WsEvent): void {
  try {
    socket.send(JSON.stringify(event));
  } catch {
    // Socket already closing; its close handler unregisters it.
  }
}

// Visibility is recomputed from the DB on every publish (§5.5): the user (with sectorIds) is loaded
// once per connected user per publish, never cached per socket, so a transfer or a sector change
// takes effect on the next event.
// ponytail: one loadAuthUser per connected user per publish; fine for an office of ~20 agents,
// batch the user/sector load into one query if the number of connected users grows.
export function createHub(getDb: () => Db): Hub {
  const byUser = new Map<string, Set<Socket>>();

  return {
    register(user, socket) {
      let set = byUser.get(user.id);
      if (!set) {
        set = new Set();
        byUser.set(user.id, set);
      }
      const own = set;
      own.add(socket);
      return () => {
        own.delete(socket);
        if (own.size === 0 && byUser.get(user.id) === own) byUser.delete(user.id);
      };
    },

    disconnectUser(userId) {
      const set = byUser.get(userId);
      if (!set) return;
      byUser.delete(userId);
      for (const socket of set) socket.close();
    },

    async publishChat(chatId) {
      if (byUser.size === 0) return;
      const db = getDb();
      const [chat] = await db.select().from(chats).where(eq(chats.id, chatId));
      if (!chat) return;
      for (const [userId, sockets] of [...byUser]) {
        const user = await loadAuthUser(db, userId);
        const event: WsEvent = user && canSee(user, chat)
          ? { type: 'chat.updated', chat: await toChatListItem(db, chat, userId) }
          : { type: 'chat.removed', chatId };
        for (const socket of [...sockets]) send(socket, event);
      }
    },

    async publishMessage(chatId, type, messageId) {
      if (byUser.size === 0) return;
      const db = getDb();
      const [chat] = await db.select().from(chats).where(eq(chats.id, chatId));
      const [row] = await db.select().from(messages).where(eq(messages.id, messageId));
      if (!chat || !row) return;
      const event: WsEvent = { type, message: await toMessageDto(db, row) };
      for (const [userId, sockets] of [...byUser]) {
        const user = await loadAuthUser(db, userId);
        if (user && canSee(user, chat)) for (const socket of [...sockets]) send(socket, event);
      }
    },

    async publishChannel(channelId) {
      if (byUser.size === 0) return;
      const [row] = await getDb().select().from(channels).where(eq(channels.id, channelId));
      if (!row) return;
      const event: WsEvent = {
        type: 'channel.status',
        channel: { id: row.id, name: row.name, status: row.status, phone: row.phone },
      };
      for (const sockets of [...byUser.values()]) for (const socket of [...sockets]) send(socket, event);
    },
  };
}

export function createRecordingHub(): Hub & {
  events: Array<{ type: string; chatId?: string; messageId?: string; channelId?: string; userId?: string }>;
} {
  const events: Array<{ type: string; chatId?: string; messageId?: string; channelId?: string; userId?: string }> = [];
  return {
    events,
    register: () => () => {},
    disconnectUser: (userId) => { events.push({ type: 'disconnect', userId }); },
    publishChat: async (chatId) => { events.push({ type: 'chat', chatId }); },
    publishMessage: async (chatId, type, messageId) => { events.push({ type, chatId, messageId }); },
    publishChannel: async (channelId) => { events.push({ type: 'channel', channelId }); },
  };
}
```

- [ ] **Step 11: Make `makeTestCtx` use the recording hub**

In `server/test/helpers.ts` add the import at the top:

```ts
import { createRecordingHub } from '../src/realtime/hub.js';
```

and, inside `makeTestCtx`, set the `hub` property of the returned context to a recording hub — replace whatever placeholder object Task 2 put there so the function body builds the context like this (keep Task 2's existing `db`, `wa` and `config` lines as they are):

```ts
  const hub = createRecordingHub();
  return { db, wa, hub, config };
```

The declared return type stays exactly as in the contract: `Promise<AppCtx & { wa: ReturnType<typeof createFakeGateway>; hub: ReturnType<typeof createRecordingHub> }>`.

- [ ] **Step 12: Run the hub tests to verify they pass**

Run: `npm test -w server -- test/realtime/hub.test.ts test/messages/dto.test.ts`
Expected: PASS (11 tests).

Then run the whole server suite to make sure the helper change did not break earlier tasks:
Run: `npm test -w server`
Expected: PASS.

- [ ] **Step 13: Commit**

```bash
git add server/src/inbox/queries.ts server/src/realtime/hub.ts server/test/helpers.ts server/test/realtime/hub.test.ts
git commit -m "feat(server): add realtime hub with per-user visibility fan-out" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 14: Write the failing /ws route test**

Create `server/test/realtime/ws.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { WsEvent } from '@talk/shared';
import type { AppCtx } from '../../src/ctx.js';
import { chats, contacts } from '../../src/db/schema.js';
import { createHub } from '../../src/realtime/hub.js';
import { loginAs, makeTestApp, makeTestCtx, seedBasics } from '../helpers.js';

let app: FastifyInstance;
let ctx: AppCtx;
let s: Awaited<ReturnType<typeof seedBasics>>;
let port: number;
let cookie: string;
const opened: WebSocket[] = [];

beforeAll(async () => {
  const base = await makeTestCtx();
  // The route test needs real fan-out, so swap the recording hub for the real one.
  ctx = { ...base, hub: createHub(() => base.db) };
  s = await seedBasics(ctx);
  ({ app } = await makeTestApp(ctx));
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as AddressInfo).port;
  ({ cookie } = await loginAs(app, s.agentA.email));
});

afterAll(async () => {
  for (const ws of opened) ws.terminate();
  await app.close();
});

function connect(opts: { origin?: string; cookie?: string }): WebSocket {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    origin: opts.origin,
    headers: opts.cookie ? { cookie: opts.cookie } : {},
  });
  opened.push(ws);
  return ws;
}

// Resolves 'open' on a successful upgrade, or ws's error message, e.g. 'Unexpected server response: 403'.
function outcome(ws: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    ws.once('open', () => resolve('open'));
    ws.once('error', (err) => resolve(err.message));
  });
}

function nextEvent(ws: WebSocket): Promise<WsEvent> {
  return new Promise((resolve) => {
    ws.once('message', (data) => resolve(JSON.parse(data.toString()) as WsEvent));
  });
}

describe('GET /ws', () => {
  it('rejects an upgrade from another origin with 403', async () => {
    const ws = connect({ origin: 'https://evil.example', cookie });
    expect(await outcome(ws)).toBe('Unexpected server response: 403');
  });

  it('rejects an upgrade without Origin header with 403', async () => {
    const ws = connect({ cookie });
    expect(await outcome(ws)).toBe('Unexpected server response: 403');
  });

  it('rejects an upgrade without session cookie with 401', async () => {
    const ws = connect({ origin: ctx.config.appOrigin });
    expect(await outcome(ws)).toBe('Unexpected server response: 401');
  });

  it('rejects an upgrade with an unknown session token with 401', async () => {
    const ws = connect({ origin: ctx.config.appOrigin, cookie: 'sid=token-que-nao-existe' });
    expect(await outcome(ws)).toBe('Unexpected server response: 401');
  });

  it('delivers chat.updated for a visible chat after a publish', async () => {
    const ws = connect({ origin: ctx.config.appOrigin, cookie });
    expect(await outcome(ws)).toBe('open');

    const contactId = randomUUID();
    await ctx.db.insert(contacts).values({ id: contactId, name: 'Ana Prado', phone: '5565999991234' });
    const chatId = randomUUID();
    await ctx.db.insert(chats).values({
      id: chatId, contactId, channelId: s.channelId, sectorId: s.sectorA, ownerId: null,
      state: 'open', waiting: true, private: false, triagePending: false, unread: 1,
    });

    const received = nextEvent(ws);
    await ctx.hub.publishChat(chatId);

    expect(await received).toEqual({
      type: 'chat.updated',
      chat: expect.objectContaining({ id: chatId, sectorId: s.sectorA, contact: { id: contactId, name: 'Ana Prado', phone: '5565999991234' } }),
    });
  });

  it('closes the socket when the user is disconnected', async () => {
    const ws = connect({ origin: ctx.config.appOrigin, cookie });
    expect(await outcome(ws)).toBe('open');

    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
    ctx.hub.disconnectUser(s.agentA.id);

    await closed;
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });
});
```

- [ ] **Step 15: Run it to verify it fails**

Run: `npm test -w server -- test/realtime/ws.test.ts`
Expected: FAIL — every test receives `Unexpected server response: 404` (no `/ws` route yet) instead of 403/401/`open`.

- [ ] **Step 16: Implement the /ws route**

Create `server/src/realtime/routes.ts`:

```ts
import { createHash } from 'node:crypto';
import websocket from '@fastify/websocket';
import { and, eq, gt } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { AppCtx } from '../ctx.js';
import { sessions, users } from '../db/schema.js';
import { loadAuthUser, type AuthUser } from '../inbox/visibility.js';

const PING_INTERVAL_MS = 30_000;

// Same rule as auth/sessions.ts (Task 6): the `sid` cookie holds the raw token and
// sessions.id stores its SHA-256 hex; expired sessions and inactive users are rejected.
async function userFromSessionCookie(ctx: AppCtx, token: string | undefined): Promise<AuthUser | null> {
  if (!token) return null;
  const id = createHash('sha256').update(token).digest('hex');
  const [row] = await ctx.db
    .select({ userId: sessions.userId })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, id), gt(sessions.expiresAt, new Date()), eq(users.active, true)));
  return row ? loadAuthUser(ctx.db, row.userId) : null;
}

export function realtimeRoutes(ctx: AppCtx): FastifyPluginAsync {
  return async (app) => {
    await app.register(websocket);

    const authed = new WeakMap<FastifyRequest, AuthUser>();

    app.get('/ws', {
      websocket: true,
      // Runs before the upgrade: replying here answers with plain HTTP and no socket is opened (§6).
      preValidation: async (request, reply) => {
        if (request.headers.origin !== ctx.config.appOrigin) {
          return reply.code(403).send({ error: 'Origem não permitida' });
        }
        const user = await userFromSessionCookie(ctx, request.cookies.sid);
        if (!user) return reply.code(401).send({ error: 'Não autenticado' });
        authed.set(request, user);
      },
    }, (socket, request) => {
      const user = authed.get(request);
      if (!user) {
        socket.close();
        return;
      }
      const unregister = ctx.hub.register(user, socket);

      // Keepalive: a socket that missed the previous pong is dead (sleeping laptop, dropped Wi-Fi).
      let alive = true;
      socket.on('pong', () => { alive = true; });
      const timer = setInterval(() => {
        if (!alive) {
          socket.terminate();
          return;
        }
        alive = false;
        socket.ping();
      }, PING_INTERVAL_MS);

      socket.on('close', () => {
        clearInterval(timer);
        unregister();
      });
      // Clients never send anything we act on; incoming frames are ignored.
    });
  };
}
```

- [ ] **Step 17: Register the route in `buildApp`**

In `server/src/app.ts` add the import next to the other route imports:

```ts
import { realtimeRoutes } from './realtime/routes.js';
```

and register it inside `buildApp(ctx)` after the `@fastify/cookie` / auth plugin registration from Task 6 (it reads `request.cookies`), next to the other route registrations:

```ts
  app.register(realtimeRoutes(ctx));
```

- [ ] **Step 18: Run the /ws tests to verify they pass**

Run: `npm test -w server -- test/realtime/ws.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 19: Typecheck and run the whole server suite**

Run: `npx tsc -p server --noEmit`
Expected: no errors.

Run: `npm test -w server`
Expected: PASS.

- [ ] **Step 20: Commit**

```bash
git add server/src/realtime/routes.ts server/src/app.ts server/test/realtime/ws.test.ts
git commit -m "feat(server): add /ws route with origin and session checks" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


---

### Task 9: Inbound ingest pipeline (webhook → DB)

Implements spec §5.1 end to end: `POST /webhooks/evolution/:secret` → `parseEvolutionWebhook` → `handleInbound` → database, media download, triage and realtime publish. This task owns Review Focus 1 (integration), 2 and 3.

**Files:**
- Create: `server/src/messages/media.ts` (only `saveMedia`; Task 10 appends `mediaResponseHeaders` to this same file)
- Create: `server/src/channels/service.ts` (only `getChannelByInstance` + `setChannelStatus`; Task 14 appends `createChannel`, `connectChannel`, `syncChannelStatuses` to this same file)
- Create: `server/src/messages/ingest.ts`
- Create: `server/src/webhooks/routes.ts`
- Modify: `server/src/app.ts` (register the webhook route inside `buildApp`)
- Create (only if missing): `server/src/triage/triage.ts` (no-op stub; Task 11 replaces it entirely)
- Test: `server/test/messages/media.test.ts`
- Test: `server/test/messages/ingest.test.ts`
- Test: `server/test/webhooks/routes.test.ts`

**Interfaces:**
- Consumes:
  - `AppCtx` (`server/src/ctx.ts`), `Db` (`server/src/db/client.ts`), tables `channels`, `contacts`, `chats`, `messages` (`server/src/db/schema.ts`, Task 2). The unique index on `messages (channel_id, external_id)` and the partial unique indexes on `contacts.phone` / `contacts.lid` are relied on for `ON CONFLICT DO NOTHING`.
  - `normalizePhoneBR(raw: string): string` (Task 3).
  - `InboundEvent`, `MessageKind`, `ChannelStatus`, `WhatsAppGateway.downloadMedia(instance: string, rawMessage: unknown): Promise<DownloadedMedia>` (Task 4), `createFakeGateway()` (Task 4, via `makeTestCtx`).
  - `parseEvolutionWebhook(body: unknown): InboundEvent[]` (Task 5). Tests feed it inline Evolution v2 `messages.upsert` payloads (no dependency on Task 5 fixture file names).
  - `findOrOpenChat(db: Db | Tx, args: { contactId; channelId; init: { sectorId; ownerId; waiting; triagePending; createdBy } }): Promise<{ chat: ChatRow; created: boolean }>`, `getDefaultSectorId(db: Db | Tx): Promise<string>`, `ChatRow` (Task 7). **Assumption:** `findOrOpenChat` writes the `created` chat event itself (that is what `init.createdBy` is for) and handles the open-chat unique-index race; ingest does not call `addEvent`.
  - `startTriage(ctx: AppCtx, chat: ChatRow): Promise<void>` and `handleTriageReply(ctx: AppCtx, chat: ChatRow, text: string | null): Promise<boolean>` from `server/src/triage/triage.ts` (Task 11). `ingest.ts` imports it statically for its default hooks. If Task 11 has not run yet, Step 0 creates a no-op stub of this module that Task 11 later replaces entirely. Task 9's tests pass stub hooks, so they do not depend on triage behaviour.
  - `Hub.publishChat(chatId)`, `Hub.publishMessage(chatId, type, messageId)`, `Hub.publishChannel(channelId)`, `createRecordingHub()` (Task 8). Tests assume the recording hub stores `publishMessage` as `{ type, chatId, messageId }`, `publishChat` as `{ type, chatId }` (no `messageId`) and `publishChannel` as `{ type, channelId }`.
  - `makeTestCtx()`, `seedBasics(ctx)`, `makeTestApp(ctx)` (`server/test/helpers.ts`, Tasks 2/6).
- Produces:
  - `handleInbound(ctx: AppCtx, events: InboundEvent[], hooks?: IngestHooks): Promise<void>`: the contract signature plus an optional third parameter (default = real triage).
  - `export interface IngestHooks { startTriage: typeof startTriage; handleTriageReply: typeof handleTriageReply }`
  - `export const MEDIA_UNAVAILABLE = 'mídia indisponível'`: the exact `messages.error` value for a failed media download. Task 10's `toMessageDto` should compute `mediaUnavailable` as `row.error === MEDIA_UNAVAILABLE`.
  - `saveMedia(mediaDir: string, data: Buffer, mime: string, originalName?: string | null): Promise<{ path: string; size: number }>` with `path` = `YYYY/MM/<uuid>.<ext>` relative to `mediaDir`, forward slashes. Task 10 reuses it for outgoing files.
  - `getChannelByInstance(db: Db | Tx, instance: string): Promise<typeof channels.$inferSelect | null>` and `setChannelStatus(ctx: AppCtx, instance: string, status: ChannelStatus): Promise<void>` (publishes `channel.status` only when the status actually changed). Task 14 keeps both and appends the rest of the channel service.
  - `registerWebhookRoutes(app: FastifyInstance, ctx: AppCtx): void` serving `POST /webhooks/evolution/:secret`: wrong secret → 401, anything parseable or not → 200.
  - Messages stored by ingest: `status = 'sent'` for both directions, `authorId = null`, `sentAt` = WhatsApp timestamp. `chats.last_message_preview` = body, or for media without caption one of `Imagem`, `Áudio`, `Vídeo`, `Documento`, `Figurinha`, `Mensagem não suportada`.

- [ ] **Step 0: Create the triage stub if Task 11 has not run yet**

Only if `server/src/triage/triage.ts` does not exist, create it with exactly this content (Task 11 overwrites the whole file; if the file already exists, skip this step and leave it untouched):

```ts
import type { AppCtx } from '../ctx.js';
import type { ChatRow } from '../inbox/chats.js';

// ponytail: no-op stub so ingest.ts compiles before Task 11; Task 11 replaces this whole file.
export async function startTriage(_ctx: AppCtx, _chat: ChatRow): Promise<void> {}

export async function handleTriageReply(_ctx: AppCtx, _chat: ChatRow, _text: string | null): Promise<boolean> {
  return false;
}
```

It is committed together with the ingest pipeline in Step 11.

- [ ] **Step 1: Write the failing test for `saveMedia`**

`server/test/messages/media.test.ts`:

```ts
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { saveMedia } from '../../src/messages/media.js';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

describe('saveMedia', () => {
  it('stores the bytes under YYYY/MM/<uuid>.<ext> using the mime type', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'talk-media-'));
    const r = await saveMedia(dir, Buffer.from('abc'), 'audio/ogg; codecs=opus', 'voz.opus');
    expect(r.size).toBe(3);
    expect(r.path).toMatch(new RegExp(`^\\d{4}/\\d{2}/${UUID}\\.ogg$`));
    expect(await readFile(join(dir, r.path), 'utf8')).toBe('abc');
  });

  it('falls back to the original extension, then to .bin', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'talk-media-'));
    const docx = await saveMedia(dir, Buffer.from('x'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Contrato.DOCX');
    expect(docx.path).toMatch(new RegExp(`^\\d{4}/\\d{2}/${UUID}\\.docx$`));
    const weird = await saveMedia(dir, Buffer.from('x'), 'application/x-unknown', 'arquivo.<script>');
    expect(weird.path).toMatch(new RegExp(`^\\d{4}/\\d{2}/${UUID}\\.bin$`));
    const none = await saveMedia(dir, Buffer.from('x'), 'application/x-unknown');
    expect(none.path).toMatch(new RegExp(`^\\d{4}/\\d{2}/${UUID}\\.bin$`));
  });

  it('never lets the original name pick the directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'talk-media-'));
    const r = await saveMedia(dir, Buffer.from('<h1>x</h1>'), 'text/html', '../../evil.html');
    expect(r.path).toMatch(new RegExp(`^\\d{4}/\\d{2}/${UUID}\\.html$`));
    expect(await readFile(join(dir, r.path), 'utf8')).toBe('<h1>x</h1>');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w server -- test/messages/media.test.ts`
Expected: FAIL. Vitest cannot resolve `../../src/messages/media.js` ("Failed to load url" / "Cannot find module").

- [ ] **Step 3: Implement `saveMedia`**

`server/src/messages/media.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'video/mp4': '.mp4',
  'application/pdf': '.pdf',
};

function extensionFor(mime: string, originalName?: string | null): string {
  const byMime = EXT_BY_MIME[mime.split(';')[0].trim().toLowerCase()];
  if (byMime) return byMime;
  const ext = extname(originalName ?? '').toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '.bin';
}

/** Writes media to `<mediaDir>/YYYY/MM/<uuid>.<ext>`; the original name never becomes part of the path. */
export async function saveMedia(
  mediaDir: string,
  data: Buffer,
  mime: string,
  originalName?: string | null,
): Promise<{ path: string; size: number }> {
  const now = new Date();
  const folder = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const path = `${folder}/${randomUUID()}${extensionFor(mime, originalName)}`;
  await mkdir(join(mediaDir, folder), { recursive: true });
  await writeFile(join(mediaDir, path), data);
  return { path, size: data.length };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test -w server -- test/messages/media.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/messages/media.ts server/test/messages/media.test.ts
git commit -m "feat(server): store media files under YYYY/MM with uuid names

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Write the failing ingest tests**

`server/test/messages/ingest.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { channels, chats, contacts, messages } from '../../src/db/schema.js';
import { handleInbound, MEDIA_UNAVAILABLE, type IngestHooks } from '../../src/messages/ingest.js';
import { parseEvolutionWebhook } from '../../src/whatsapp/parse.js';
import type { InboundEvent } from '../../src/whatsapp/types.js';
import { makeTestCtx, seedBasics } from '../helpers.js';

type Ctx = Awaited<ReturnType<typeof makeTestCtx>>;
type MessageEvent = Extract<InboundEvent, { type: 'message' }>;

const PHONE = '5565999999999';
let seq = 0;

function msg(over: Partial<MessageEvent> = {}): MessageEvent {
  seq += 1;
  return {
    type: 'message',
    instance: 'talk-test',
    externalId: `EXT${seq}`,
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
    sentAt: new Date(Date.UTC(2026, 9, 14, 12, 0, seq % 60)),
    raw: { key: { id: `EXT${seq}` } },
    ...over,
  };
}

/** Evolution v2 `messages.upsert` webhook body for a plain text message. */
function upsert(o: { id: string; remoteJid: string; fromMe: boolean; text: string; pushName?: string }) {
  return {
    event: 'messages.upsert',
    instance: 'talk-test',
    data: {
      key: { remoteJid: o.remoteJid, fromMe: o.fromMe, id: o.id },
      pushName: o.pushName ?? 'Maria Cliente',
      message: { conversation: o.text },
      messageType: 'conversation',
      messageTimestamp: 1792000000,
    },
  };
}

function stubHooks() {
  const calls: string[] = [];
  const hooks: IngestHooks = {
    startTriage: async (_ctx, chat) => {
      calls.push(`start:${chat.id}`);
    },
    handleTriageReply: async (_ctx, chat, text) => {
      calls.push(`reply:${chat.id}:${text}`);
      return true;
    },
  };
  return { calls, hooks };
}

let ctx: Ctx;
let seed: Awaited<ReturnType<typeof seedBasics>>;
let triage: ReturnType<typeof stubHooks>;

const ingest = (...events: InboundEvent[]) => handleInbound(ctx, events, triage.hooks);
const allChats = () => ctx.db.select().from(chats);
const allContacts = () => ctx.db.select().from(contacts);
const allMessages = () => ctx.db.select().from(messages);
const hubEvents = (type: string) => ctx.hub.events.filter((e) => e.type === type);
const chatPublishes = (chatId: string) => ctx.hub.events.filter((e) => e.chatId === chatId && !e.messageId);
const closeChat = (chatId: string) =>
  ctx.db.update(chats).set({ state: 'closed', closedAt: new Date(), waiting: false, unread: 0 }).where(eq(chats.id, chatId));

beforeEach(async () => {
  ctx = await makeTestCtx();
  seed = await seedBasics(ctx);
  ctx.config.mediaDir = await mkdtemp(join(tmpdir(), 'talk-media-'));
  triage = stubHooks();
});

describe('handleInbound: messages', () => {
  it('a 12-digit JID reaches the contact imported with 13 digits (Review Focus 1)', async () => {
    const [imported] = await ctx.db
      .insert(contacts)
      .values({ id: randomUUID(), phone: PHONE, name: 'Importado do Umbler' })
      .returning();

    await ingest(...parseEvolutionWebhook(upsert({ id: 'RF1A', remoteJid: '556599999999@s.whatsapp.net', fromMe: false, text: 'bom dia' })));

    const people = await allContacts();
    expect(people).toHaveLength(1);
    expect(people[0].name).toBe('Importado do Umbler');
    const [chat] = await allChats();
    expect(chat.contactId).toBe(imported.id);
    const [m] = await allMessages();
    expect(m).toMatchObject({ chatId: chat.id, direction: 'in', body: 'bom dia', externalId: 'RF1A', authorId: null });
  });

  it('a 12-digit landline does not gain a 9 (Review Focus 1)', async () => {
    await ingest(...parseEvolutionWebhook(upsert({ id: 'RF1B', remoteJid: '556532221111@s.whatsapp.net', fromMe: false, text: 'oi' })));
    const [c] = await allContacts();
    expect(c.phone).toBe('556532221111');
    expect(c.name).toBe('Maria Cliente');
  });

  it('a first inbound message opens a waiting chat in the default sector and starts triage', async () => {
    await ingest(msg({ body: 'Olá' }));
    const [chat] = await allChats();
    expect(chat).toMatchObject({
      sectorId: seed.defaultSector,
      channelId: seed.channelId,
      ownerId: null,
      state: 'open',
      waiting: true,
      unread: 1,
      lastMessagePreview: 'Olá',
    });
    const [m] = await allMessages();
    expect(m.status).toBe('sent');
    expect(hubEvents('message.created')).toEqual([expect.objectContaining({ chatId: chat.id, messageId: m.id })]);
    expect(chatPublishes(chat.id).length).toBeGreaterThanOrEqual(1);
    expect(triage.calls).toEqual([`start:${chat.id}`]);
  });

  it('the same upsert delivered twice is stored once (Review Focus 2)', async () => {
    const ev = msg();
    await ingest(ev);
    await ingest(ev, ev);
    expect(await allMessages()).toHaveLength(1);
    const [chat] = await allChats();
    expect(chat.unread).toBe(1);
    expect(hubEvents('message.created')).toHaveLength(1);
    expect(triage.calls).toHaveLength(1);
  });

  it('a status update for an unknown message is a no-op and the message still arrives later (Review Focus 2)', async () => {
    await expect(ingest({ type: 'status', instance: 'talk-test', externalId: 'LATE1', status: 'delivered' })).resolves.toBeUndefined();
    expect(await allMessages()).toHaveLength(0);
    expect(await allChats()).toHaveLength(0);

    await ingest(msg({ externalId: 'LATE1' }));
    expect(await allMessages()).toHaveLength(1);
  });

  it('a message typed on the office phone is out, clears waiting and triage, keeps unread (Review Focus 3)', async () => {
    await ingest(msg({ body: 'preciso de ajuda' }));
    const [open] = await allChats();
    await ctx.db.update(chats).set({ triagePending: true }).where(eq(chats.id, open.id));
    triage.calls.length = 0;

    await ingest(
      ...parseEvolutionWebhook(
        upsert({ id: 'RF3OUT', remoteJid: '556599999999@s.whatsapp.net', fromMe: true, text: 'Já te respondo', pushName: 'Escritório JVO' }),
      ),
    );

    const [chat] = await allChats();
    expect(chat).toMatchObject({ waiting: false, triagePending: false, unread: 1, lastMessagePreview: 'Já te respondo' });
    const out = (await allMessages()).find((m) => m.externalId === 'RF3OUT');
    expect(out).toMatchObject({ direction: 'out', authorId: null, chatId: chat.id });
    expect(triage.calls).toEqual([]);
    expect((await allContacts())[0].name).toBe('Maria Cliente');
  });

  it('a phone message with no open chat opens one without waiting, unread or triage (Review Focus 3)', async () => {
    await ingest(msg({ direction: 'out', pushName: 'Escritório JVO', body: 'Olá, aqui é do escritório' }));
    const [chat] = await allChats();
    expect(chat).toMatchObject({ state: 'open', waiting: false, triagePending: false, unread: 0 });
    expect(triage.calls).toEqual([]);
    const [contact] = await allContacts();
    expect(contact.phone).toBe(PHONE);
    expect(contact.name).toBeNull();
  });

  it('routes the next inbound message to triage while triage is pending', async () => {
    await ingest(msg({ body: 'oi' }));
    const [chat] = await allChats();
    await ctx.db.update(chats).set({ triagePending: true }).where(eq(chats.id, chat.id));
    await ingest(msg({ body: '2' }));
    expect(triage.calls).toEqual([`start:${chat.id}`, `reply:${chat.id}:2`]);
  });

  it('a new inbound message after the chat was closed opens a new chat', async () => {
    await ingest(msg());
    const [first] = await allChats();
    await closeChat(first.id);

    await ingest(msg({ body: 'voltei' }));

    const list = await allChats();
    expect(list).toHaveLength(2);
    const second = list.find((c) => c.id !== first.id)!;
    expect(second).toMatchObject({ state: 'open', waiting: true, unread: 1, lastMessagePreview: 'voltei' });
    expect(list.find((c) => c.id === first.id)).toMatchObject({ state: 'closed', unread: 0 });
    expect(triage.calls).toEqual([`start:${first.id}`, `start:${second.id}`]);
  });

  it('drops messages from a blocked contact', async () => {
    await ctx.db.insert(contacts).values({ id: randomUUID(), phone: PHONE, name: 'Bloqueado', blocked: true });
    await ingest(msg());
    expect(await allMessages()).toHaveLength(0);
    expect(await allChats()).toHaveLength(0);
    expect(hubEvents('message.created')).toHaveLength(0);
    expect(triage.calls).toEqual([]);
  });

  it('a lid-only message attaches to the contact found by lid', async () => {
    const [known] = await ctx.db
      .insert(contacts)
      .values({ id: randomUUID(), phone: PHONE, lid: '200001112223334', name: 'Cliente LID' })
      .returning();
    await ingest(msg({ phone: null, lid: '200001112223334' }));
    expect(await allContacts()).toHaveLength(1);
    const [chat] = await allChats();
    expect(chat.contactId).toBe(known.id);
  });

  it('fills the missing phone of a contact found by lid (normalizing it)', async () => {
    const [known] = await ctx.db.insert(contacts).values({ id: randomUUID(), lid: 'LID-77', name: null }).returning();
    await ingest(msg({ phone: '556599999999', lid: 'LID-77', pushName: 'Joana' }));
    const people = await allContacts();
    expect(people).toHaveLength(1);
    expect(people[0]).toMatchObject({ id: known.id, phone: PHONE, lid: 'LID-77', name: 'Joana' });
  });

  it('does not steal a lid that already belongs to another contact', async () => {
    const [byPhone] = await ctx.db.insert(contacts).values({ id: randomUUID(), phone: PHONE, name: 'Pelo telefone' }).returning();
    await ctx.db.insert(contacts).values({ id: randomUUID(), lid: 'LID-88', name: 'Pelo lid' });
    await ingest(msg({ phone: PHONE, lid: 'LID-88' }));
    const [chat] = await allChats();
    expect(chat.contactId).toBe(byPhone.id);
    const [after] = await ctx.db.select().from(contacts).where(eq(contacts.id, byPhone.id));
    expect(after.lid).toBeNull();
  });

  it('two concurrent first messages from a new contact create one contact and one chat', async () => {
    await Promise.all([ingest(msg()), ingest(msg())]);
    expect(await allContacts()).toHaveLength(1);
    const list = await allChats();
    expect(list).toHaveLength(1);
    expect(list[0].unread).toBe(2);
    expect(await allMessages()).toHaveLength(2);
    expect(triage.calls).toHaveLength(1);
  });

  it('resolves the quoted message, and leaves reply empty when the quote is unknown', async () => {
    const a = msg();
    await ingest(a);
    const b = msg({ replyToExternalId: a.externalId });
    const c = msg({ replyToExternalId: 'NAO-EXISTE' });
    await ingest(b, c);
    const rows = await allMessages();
    const ma = rows.find((m) => m.externalId === a.externalId)!;
    expect(rows.find((m) => m.externalId === b.externalId)!.replyToId).toBe(ma.id);
    expect(rows.find((m) => m.externalId === c.externalId)!.replyToId).toBeNull();
  });

  it('a late message does not move the chat back in time', async () => {
    await ingest(msg({ body: 'nova', sentAt: new Date('2026-10-14T15:00:00Z') }));
    await ingest(msg({ body: 'atrasada', sentAt: new Date('2026-10-14T09:00:00Z') }));
    const [chat] = await allChats();
    expect(chat.lastMessageAt?.toISOString()).toBe('2026-10-14T15:00:00.000Z');
    expect(chat.lastMessagePreview).toBe('nova');
    expect(chat.unread).toBe(2);
  });

  it('downloads media after commit and stores it under mediaDir', async () => {
    await ingest(msg({ kind: 'image', body: null, hasMedia: true, mediaMime: 'image/png' }));
    const [m] = await allMessages();
    expect(m.mediaPath).toMatch(/^\d{4}\/\d{2}\/[0-9a-f-]{36}\.png$/);
    expect(m.mediaMime).toBe('image/png');
    expect(m.error).toBeNull();
    const bytes = await readFile(join(ctx.config.mediaDir, m.mediaPath!));
    expect(bytes.length).toBe(m.mediaSize);
    const [chat] = await allChats();
    expect(chat.lastMessagePreview).toBe('Imagem');
    expect(hubEvents('message.updated')).toEqual([expect.objectContaining({ messageId: m.id })]);
  });

  it('keeps the message and marks the media unavailable when the download fails', async () => {
    ctx.wa.downloadMedia = async () => {
      throw new Error('Evolution fora do ar');
    };
    await ingest(msg({ kind: 'document', body: null, hasMedia: true, mediaMime: 'application/pdf', mediaName: 'contrato.pdf' }));
    const [m] = await allMessages();
    expect(m).toMatchObject({ kind: 'document', mediaPath: null, mediaName: 'contrato.pdf', error: MEDIA_UNAVAILABLE });
    expect(hubEvents('message.updated')).toEqual([expect.objectContaining({ messageId: m.id })]);
  });

  it('skips events for an unknown instance', async () => {
    await ingest(msg({ instance: 'talk-outro' }));
    expect(await allMessages()).toHaveLength(0);
    expect(await allChats()).toHaveLength(0);
  });
});

describe('handleInbound: reactions', () => {
  it('a reaction on a closed chat only sets the reaction (no new chat, no unread, no waiting)', async () => {
    const target = msg();
    await ingest(target);
    const [chat] = await allChats();
    await closeChat(chat.id);

    await ingest({ type: 'reaction', instance: 'talk-test', targetExternalId: target.externalId, emoji: '👍' });

    const list = await allChats();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ state: 'closed', unread: 0, waiting: false });
    const [m] = await allMessages();
    expect(m.reaction).toBe('👍');
    expect(hubEvents('message.updated')).toEqual([expect.objectContaining({ chatId: chat.id, messageId: m.id })]);

    await ingest({ type: 'reaction', instance: 'talk-test', targetExternalId: target.externalId, emoji: null });
    expect((await allMessages())[0].reaction).toBeNull();
  });

  it('ignores a reaction whose target is unknown', async () => {
    await expect(
      ingest({ type: 'reaction', instance: 'talk-test', targetExternalId: 'NAO-EXISTE', emoji: '👍' }),
    ).resolves.toBeUndefined();
    expect(await allChats()).toHaveLength(0);
    expect(hubEvents('message.updated')).toHaveLength(0);
  });
});

describe('handleInbound: status', () => {
  it('only moves status forward', async () => {
    const ev = msg({ direction: 'out', body: 'enviado pelo celular' });
    await ingest(ev);
    const st = (status: 'sent' | 'delivered' | 'read' | 'failed') =>
      ingest({ type: 'status', instance: 'talk-test', externalId: ev.externalId, status });

    await st('read');
    await st('delivered');
    await st('failed');

    const [m] = await allMessages();
    expect(m.status).toBe('read');
    expect(hubEvents('message.updated')).toHaveLength(1);
  });

  it('marks failed only from pending or sent', async () => {
    const ev = msg({ direction: 'out' });
    await ingest(ev);
    await ingest({ type: 'status', instance: 'talk-test', externalId: ev.externalId, status: 'failed' });
    const [m] = await allMessages();
    expect(m.status).toBe('failed');
  });
});

describe('handleInbound: channel events', () => {
  it('updates channel status and publishes only on change; qrcode stores nothing', async () => {
    await ctx.db.update(channels).set({ status: 'disconnected' }).where(eq(channels.id, seed.channelId));

    await ingest({ type: 'connection', instance: 'talk-test', status: 'connected' });
    await ingest({ type: 'connection', instance: 'talk-test', status: 'connected' });
    await ingest({ type: 'qrcode', instance: 'talk-test', qrBase64: 'data:image/png;base64,AAAA' });
    await ingest({ type: 'connection', instance: 'talk-desconhecida', status: 'connected' });

    const [ch] = await ctx.db.select().from(channels).where(eq(channels.id, seed.channelId));
    expect(ch.status).toBe('connected');
    expect(ctx.hub.events.filter((e) => e.channelId === seed.channelId)).toHaveLength(1);
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `npm test -w server -- test/messages/ingest.test.ts`
Expected: FAIL. Vitest cannot resolve `../../src/messages/ingest.js`.

- [ ] **Step 8: Implement the channel helpers**

`server/src/channels/service.ts` (Task 14 appends `createChannel`, `connectChannel` and `syncChannelStatuses` to this file and keeps these two functions unchanged):

```ts
import { and, eq, ne } from 'drizzle-orm';
import type { AppCtx } from '../ctx.js';
import type { Db } from '../db/client.js';
import { channels } from '../db/schema.js';
import type { ChannelStatus } from '../whatsapp/types.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export async function getChannelByInstance(db: Db | Tx, instance: string): Promise<typeof channels.$inferSelect | null> {
  const [row] = await db.select().from(channels).where(eq(channels.evolutionInstance, instance)).limit(1);
  return row ?? null;
}

/** Updates channels.status; publishes channel.status only when it actually changed. Unknown instance → no-op. */
export async function setChannelStatus(ctx: AppCtx, instance: string, status: ChannelStatus): Promise<void> {
  const [row] = await ctx.db
    .update(channels)
    .set({ status })
    .where(and(eq(channels.evolutionInstance, instance), ne(channels.status, status)))
    .returning({ id: channels.id });
  if (row) await ctx.hub.publishChannel(row.id);
}
```

- [ ] **Step 9: Implement the ingest pipeline**

`server/src/messages/ingest.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { getChannelByInstance, setChannelStatus } from '../channels/service.js';
import type { AppCtx } from '../ctx.js';
import type { Db } from '../db/client.js';
import { chats, contacts, messages } from '../db/schema.js';
import { findOrOpenChat, getDefaultSectorId, type ChatRow } from '../inbox/chats.js';
import { handleTriageReply, startTriage } from '../triage/triage.js';
import { normalizePhoneBR } from '../whatsapp/phone.js';
import type { InboundEvent, MessageKind } from '../whatsapp/types.js';
import { saveMedia } from './media.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type MessageEvent = Extract<InboundEvent, { type: 'message' }>;
type StatusEvent = Extract<InboundEvent, { type: 'status' }>;
type MessageStatus = (typeof messages.$inferSelect)['status'];
type Contact = typeof contacts.$inferSelect;

export interface IngestHooks {
  startTriage: typeof startTriage;
  handleTriageReply: typeof handleTriageReply;
}

const defaultHooks: IngestHooks = { startTriage, handleTriageReply };

export const MEDIA_UNAVAILABLE = 'mídia indisponível';

const PREVIEW: Record<MessageKind, string> = {
  text: '',
  image: 'Imagem',
  audio: 'Áudio',
  video: 'Vídeo',
  document: 'Documento',
  sticker: 'Figurinha',
  note: 'Nota',
  unsupported: 'Mensagem não suportada',
};

/** Statuses a message may be in for the incoming status to apply (pending < sent < delivered < read; failed only from pending/sent). */
const ADVANCES_FROM: Record<StatusEvent['status'], MessageStatus[]> = {
  sent: ['pending'],
  delivered: ['pending', 'sent'],
  read: ['pending', 'sent', 'delivered'],
  failed: ['pending', 'sent'],
};

/** Thrown inside the ingest transaction to roll it back and stop silently. */
class Skip extends Error {}

export async function handleInbound(ctx: AppCtx, events: InboundEvent[], hooks: IngestHooks = defaultHooks): Promise<void> {
  for (const ev of events) {
    if (ev.type === 'connection') {
      await setChannelStatus(ctx, ev.instance, ev.status);
      continue;
    }
    // ponytail: qrcode events are not stored; the QR shown to the admin comes from connectChannel (§5.6)
    if (ev.type === 'ignored' || ev.type === 'qrcode') continue;

    const channel = await getChannelByInstance(ctx.db, ev.instance);
    if (!channel) continue;

    if (ev.type === 'status') await applyStatus(ctx, channel.id, ev);
    else if (ev.type === 'reaction') await applyReaction(ctx, channel.id, ev.targetExternalId, ev.emoji);
    else await ingestMessage(ctx, channel.id, ev, hooks);
  }
}

async function applyStatus(ctx: AppCtx, channelId: string, ev: StatusEvent): Promise<void> {
  const [row] = await ctx.db
    .update(messages)
    .set({ status: ev.status })
    .where(
      and(
        eq(messages.channelId, channelId),
        eq(messages.externalId, ev.externalId),
        inArray(messages.status, ADVANCES_FROM[ev.status]),
      ),
    )
    .returning({ id: messages.id, chatId: messages.chatId });
  if (row) await ctx.hub.publishMessage(row.chatId, 'message.updated', row.id);
}

/** Reactions never create chats nor touch unread/waiting (§5.1). Unknown target → ignored. */
async function applyReaction(ctx: AppCtx, channelId: string, targetExternalId: string, emoji: string | null): Promise<void> {
  const [row] = await ctx.db
    .update(messages)
    .set({ reaction: emoji || null })
    .where(and(eq(messages.channelId, channelId), eq(messages.externalId, targetExternalId)))
    .returning({ id: messages.id, chatId: messages.chatId });
  if (row) await ctx.hub.publishMessage(row.chatId, 'message.updated', row.id);
}

async function ingestMessage(ctx: AppCtx, channelId: string, ev: MessageEvent, hooks: IngestHooks): Promise<void> {
  const inbound = ev.direction === 'in';
  let stored: { messageId: string; chat: ChatRow; created: boolean };
  try {
    // Inside this transaction only `tx` may be used: PGlite serializes transactions, so touching ctx.db here would deadlock.
    stored = await ctx.db.transaction(async (tx) => {
      const [dup] = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.channelId, channelId), eq(messages.externalId, ev.externalId)))
        .limit(1);
      if (dup) throw new Skip(); // duplicate webhook, or the echo of a message we sent ourselves

      const contact = await resolveContact(tx, ev);
      if (!contact || contact.blocked) throw new Skip();

      const { chat, created } = await findOrOpenChat(tx, {
        contactId: contact.id,
        channelId,
        init: { sectorId: await getDefaultSectorId(tx), ownerId: null, waiting: inbound, triagePending: false, createdBy: null },
      });

      let replyToId: string | null = null;
      if (ev.replyToExternalId) {
        const [quoted] = await tx
          .select({ id: messages.id })
          .from(messages)
          .where(and(eq(messages.channelId, channelId), eq(messages.externalId, ev.replyToExternalId)))
          .limit(1);
        replyToId = quoted?.id ?? null;
      }

      const [inserted] = await tx
        .insert(messages)
        .values({
          id: randomUUID(),
          chatId: chat.id,
          channelId,
          direction: ev.direction,
          kind: ev.kind,
          body: ev.body,
          mediaMime: ev.mediaMime,
          mediaName: ev.mediaName,
          authorId: null,
          replyToId,
          externalId: ev.externalId,
          status: 'sent',
          sentAt: ev.sentAt,
        })
        .onConflictDoNothing({ target: [messages.channelId, messages.externalId] })
        .returning({ id: messages.id });
      if (!inserted) throw new Skip(); // a concurrent copy of this webhook won the race

      const sentAt = ev.sentAt.toISOString();
      const preview = (ev.body ?? PREVIEW[ev.kind]).slice(0, 200);
      const isNewest = sql`(${chats.lastMessageAt} is null or ${chats.lastMessageAt} <= ${sentAt}::timestamptz)`;
      const [updated] = await tx
        .update(chats)
        .set({
          lastMessageAt: sql`greatest(${chats.lastMessageAt}, ${sentAt}::timestamptz)`,
          lastMessagePreview: sql`case when ${isNewest} then ${preview} else ${chats.lastMessagePreview} end`,
          ...(inbound
            ? { unread: sql`${chats.unread} + 1`, waiting: true }
            : { waiting: false, triagePending: false }),
        })
        .where(eq(chats.id, chat.id))
        .returning();

      return { messageId: inserted.id, chat: updated, created };
    });
  } catch (err) {
    if (err instanceof Skip) return;
    throw err;
  }

  await ctx.hub.publishMessage(stored.chat.id, 'message.created', stored.messageId);
  await ctx.hub.publishChat(stored.chat.id);

  if (ev.hasMedia) await fetchMedia(ctx, ev, stored.chat.id, stored.messageId);

  if (inbound) {
    if (stored.created) await hooks.startTriage(ctx, stored.chat);
    else if (stored.chat.triagePending) await hooks.handleTriageReply(ctx, stored.chat, ev.body);
  }
}

async function findContact(tx: Tx, where: SQL): Promise<Contact | undefined> {
  const [row] = await tx.select().from(contacts).where(where).limit(1);
  return row;
}

async function lookup(tx: Tx, phone: string | null, lid: string | null) {
  return {
    byPhone: phone ? await findContact(tx, eq(contacts.phone, phone)) : undefined,
    byLid: lid ? await findContact(tx, eq(contacts.lid, lid)) : undefined,
  };
}

/** Match by normalized phone, then by lid; fill what is missing; create on first contact (race-safe). */
async function resolveContact(tx: Tx, ev: MessageEvent): Promise<Contact | undefined> {
  const phone = ev.phone ? normalizePhoneBR(ev.phone) : null;
  const name = ev.direction === 'in' ? ev.pushName : null; // on fromMe messages pushName is the office's own name
  if (!phone && !ev.lid) return undefined;

  const { byPhone, byLid } = await lookup(tx, phone, ev.lid);
  // ponytail: when phone and lid point at two different contacts we use the phone one and do not merge
  const found = byPhone ?? byLid;

  if (!found) {
    await tx.insert(contacts).values({ id: randomUUID(), phone, lid: ev.lid, name }).onConflictDoNothing();
    const again = await lookup(tx, phone, ev.lid);
    return again.byPhone ?? again.byLid;
  }

  const patch: Partial<typeof contacts.$inferInsert> = {};
  if (!found.phone && phone && !byPhone) patch.phone = phone;
  if (!found.lid && ev.lid && !byLid) patch.lid = ev.lid;
  if (!found.name && name) patch.name = name;
  if (Object.keys(patch).length > 0) {
    await tx.update(contacts).set({ ...patch, updatedAt: new Date() }).where(eq(contacts.id, found.id));
  }
  return found;
}

/** Runs after commit; a failed download never loses the message (§5.1 step 6). */
async function fetchMedia(ctx: AppCtx, ev: MessageEvent, chatId: string, messageId: string): Promise<void> {
  let patch: Partial<typeof messages.$inferInsert>;
  try {
    const media = await ctx.wa.downloadMedia(ev.instance, ev.raw);
    const name = ev.mediaName ?? media.fileName ?? null;
    const saved = await saveMedia(ctx.config.mediaDir, Buffer.from(media.base64, 'base64'), media.mime, name);
    patch = { mediaPath: saved.path, mediaSize: saved.size, mediaMime: media.mime, mediaName: name };
  } catch {
    patch = { error: MEDIA_UNAVAILABLE };
  }
  await ctx.db.update(messages).set(patch).where(eq(messages.id, messageId));
  await ctx.hub.publishMessage(chatId, 'message.updated', messageId);
}
```

- [ ] **Step 10: Run the ingest tests to verify they pass**

Run: `npm test -w server -- test/messages/ingest.test.ts`
Expected: PASS (24 tests).

- [ ] **Step 11: Commit**

```bash
git add server/src/channels/service.ts server/src/messages/ingest.ts server/test/messages/ingest.test.ts server/src/triage/triage.ts
git commit -m "feat(server): ingest Evolution events into contacts, chats and messages

Idempotent by (channel_id, external_id); phone-originated messages do not
turn on waiting/unread/triage; reactions never open chats; status only
moves forward; media downloaded after commit.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 12: Write the failing webhook route test**

`server/test/webhooks/routes.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { messages } from '../../src/db/schema.js';
import { makeTestApp, makeTestCtx, seedBasics } from '../helpers.js';

const upsert = {
  event: 'messages.upsert',
  instance: 'talk-test',
  data: {
    key: { remoteJid: '556599999999@s.whatsapp.net', fromMe: false, id: 'WH1' },
    pushName: 'Maria Cliente',
    message: { conversation: 'oi, tudo bem?' },
    messageType: 'conversation',
    messageTimestamp: 1792000000,
  },
};

let app: FastifyInstance;
let ctx: Awaited<ReturnType<typeof makeTestCtx>>;

beforeEach(async () => {
  ctx = await makeTestCtx();
  await seedBasics(ctx);
  ({ app } = await makeTestApp(ctx));
});

afterEach(async () => {
  await app.close();
});

const stored = () => ctx.db.select().from(messages).where(eq(messages.externalId, 'WH1'));

describe('POST /webhooks/evolution/:secret', () => {
  it('rejects a wrong secret with 401 and stores nothing', async () => {
    const res = await app.inject({ method: 'POST', url: '/webhooks/evolution/segredo-errado', payload: upsert });
    expect(res.statusCode).toBe(401);
    expect(await stored()).toHaveLength(0);
  });

  it('stores an incoming message', async () => {
    const res = await app.inject({ method: 'POST', url: `/webhooks/evolution/${ctx.config.webhookSecret}`, payload: upsert });
    expect(res.statusCode).toBe(200);
    expect(await stored()).toHaveLength(1);
  });

  it('answers 200 to a payload it does not understand', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/webhooks/evolution/${ctx.config.webhookSecret}`,
      payload: { event: 'algo.novo', data: { qualquer: 1 } },
    });
    expect(res.statusCode).toBe(200);
  });
});
```

- [ ] **Step 13: Run it to verify it fails**

Run: `npm test -w server -- test/webhooks/routes.test.ts`
Expected: FAIL. All three tests get 404 because the route is not registered yet.

- [ ] **Step 14: Implement and register the route**

`server/src/webhooks/routes.ts`:

```ts
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AppCtx } from '../ctx.js';
import { handleInbound } from '../messages/ingest.js';
import { parseEvolutionWebhook } from '../whatsapp/parse.js';

function secretMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Evolution → app, internal Docker network only (Caddy does not proxy /webhooks/*). No session, no Origin check. */
export function registerWebhookRoutes(app: FastifyInstance, ctx: AppCtx): void {
  app.post<{ Params: { secret: string } }>('/webhooks/evolution/:secret', async (req, reply) => {
    if (!secretMatches(req.params.secret, ctx.config.webhookSecret)) {
      return reply.code(401).send({ error: 'Não autorizado' });
    }
    const events = parseEvolutionWebhook(req.body);
    for (const ev of events) {
      if (ev.type === 'ignored') req.log.warn({ reason: ev.reason }, 'evolution webhook ignorado'); // reason only, never the body
    }
    await handleInbound(ctx, events);
    return reply.code(200).send({ ok: true });
  });
}
```

In `server/src/app.ts`, add the import next to the other route imports:

```ts
import { registerWebhookRoutes } from './webhooks/routes.js';
```

and, inside `buildApp(ctx)`, call it right after the other route registrations (before the static SPA fallback):

```ts
  registerWebhookRoutes(app, ctx);
```

- [ ] **Step 15: Run the route test and the whole server suite**

Run: `npm test -w server -- test/webhooks/routes.test.ts`
Expected: PASS (3 tests).

Run: `npm test -w server`
Expected: PASS (all server tests, including the media and ingest tests from this task).

- [ ] **Step 16: Commit**

```bash
git add server/src/webhooks/routes.ts server/src/app.ts server/test/webhooks/routes.test.ts
git commit -m "feat(server): add Evolution webhook route with secret check

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


---

### Task 10: Sending messages, notes, media storage and media route

Implements spec §5.2 (agent send, signature, quoted reply, failure and resend), notes, §4 media storage and the `/api/media/:messageId` route with the §4 header rules (Review Focus 5). The chat REST routes that call these services (`POST /api/chats/:id/messages`, `/notes`, `POST /api/messages/:id/resend`) are wired in Task 13. Quick-answer attachments are served in Task 12.

**Files:**
- Create: `server/src/messages/signature.ts`
- Modify: `server/src/messages/media.ts` (Task 9 created it with `saveMedia`; this task extends the MIME map and appends `baseMime` and `mediaResponseHeaders`)
- Create: `server/src/messages/send.ts`
- Create: `server/src/media/routes.ts`
- Modify: `server/src/app.ts` (register `mediaRoutes` with the other route modules)
- Test: `server/test/messages/signature.test.ts`
- Modify: `server/test/messages/media.test.ts` (Task 9's 3 `saveMedia` tests stay; this task appends cases)
- Test: `server/test/messages/send.test.ts`
- Test: `server/test/media/routes.test.ts`

**Interfaces:**
- Consumes:
  - `AppCtx` (`server/src/ctx.ts`): `{ db, wa, hub, config }`; `config.mediaDir: string`.
  - `Db` (`server/src/db/client.ts`); `Tx = Parameters<Parameters<Db['transaction']>[0]>[0]`.
  - Schema (`server/src/db/schema.ts`, Task 2): `messages`, `chats`, `contacts`, `channels`, `sectors`, `chatEvents`. Columns used: `messages.{id, chatId, channelId, direction, kind, body, mediaPath, mediaMime, mediaSize, mediaName, authorId, replyToId, externalId, status, error, sentAt}`, `chats.{id, contactId, channelId, sectorId, ownerId, state, waiting, private, triagePending, unread, lastMessageAt, lastMessagePreview, closedAt}`, `contacts.{id, name, phone}`, `channels.{id, evolutionInstance}`, `sectors.{id, name}`, `chatEvents.{chatId, kind, data}`.
  - `HttpError`, `badRequest`, `conflict`, `notFound` (`server/src/lib/http-error.ts`).
  - `AuthUser` (`server/src/inbox/visibility.ts`).
  - `getChatForUser(ctx: AppCtx, user: AuthUser, chatId: string): Promise<ChatRow>` (404 if missing or `!canSee`), `findOrOpenChat(db, args)`, `ChatRow` (`server/src/inbox/chats.ts`, Task 7).
  - `addEvent(db: Db | Tx, chatId: string, kind: ChatEventKind, data: Record<string, unknown>, authorId: string | null): Promise<void>` (`server/src/inbox/events.ts`, Task 7).
  - `toMessageDto(db: Db | Tx, row: typeof messages.$inferSelect): Promise<MessageDto>` (`server/src/messages/dto.ts`, Task 8; used unchanged).
  - `WhatsAppGateway.sendText(instance, phone, text, quoted?)`, `sendMedia(instance, phone, media: OutgoingMedia, quoted?)`, `sendAudio(instance, phone, base64)`, `QuotedRef` (`server/src/whatsapp/types.ts`); fake gateway `failNext(err?)`, `sent` (`server/src/whatsapp/fake.ts`, Task 4).
  - `Hub.publishMessage(chatId, 'message.created' | 'message.updated', messageId)`, `Hub.publishChat(chatId)`; recording hub `events` (Task 8).
  - Auth (Task 6): the auth plugin sets `request.user` (an `AuthUser`, or null/undefined when not logged in) for `/api/*` requests.
  - Test helpers (`server/test/helpers.ts`): `makeTestCtx`, `seedBasics`, `makeTestApp`, `loginAs`.
  - `saveMedia(mediaDir: string, data: Buffer, mime: string, originalName?: string | null): Promise<{ path: string; size: number }>` (`server/src/messages/media.ts`, Task 9). `path` is relative to `mediaDir`, POSIX `YYYY/MM/<uuid>.<ext>` (UTC date). Signature unchanged here; only its MIME map grows.
  - `handleInbound(ctx: AppCtx, events: InboundEvent[], hooks?: IngestHooks): Promise<void>` (`server/src/messages/ingest.ts`, Task 9); used only by the echo-race test.
- Produces:
  - `formatSignature(text: string, signatureLabel: string): string` → `` `*${label}:*\n${text}` ``
  - `signatureLabel(user: AuthUser, sectorName: string): string` → `user.signature?.trim() || \`${sectorName} - ${user.name}\``
  - `baseMime(mime: string): string` (lower-cased type without parameters) in `server/src/messages/media.ts`.
  - `mediaResponseHeaders(mime: string, fileName: string): Record<string, string>`
  - `interface SendInput { text?: string; file?: { buffer: Buffer; mime: string; name: string }; asVoice?: boolean; signature: boolean; replyToId?: string }`
  - `sendAgentMessage(ctx: AppCtx, user: AuthUser, chatId: string, input: SendInput): Promise<MessageDto>`. Errors: 404 if not visible (this also covers private chats for anyone other than the owner or an admin), 409 if the chat is closed, 400 for an empty message, `asVoice` with a non-audio file, or a `replyToId` that is not in this chat.
  - `resendMessage(ctx: AppCtx, user: AuthUser, messageId: string): Promise<MessageDto>`. Errors: 404 if the message is missing or not visible, 409 if it is not a failed outgoing message or the chat is closed.
  - `addNote(ctx: AppCtx, user: AuthUser, chatId: string, text: string): Promise<MessageDto>`. The note gets `kind='note'`, `direction='out'`, `status='sent'`, is never sent to the gateway, and does not change chat flags.
  - `mediaRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void>` registers `GET /api/media/:messageId`.
  - Stored-message conventions that later tasks rely on: an outgoing `body` is the exact text the contact receives (including the signature); voice messages are `kind='audio'` with `body=null`; image files other than jpeg/png, audio sent without `asVoice`, and every other file are stored as `kind='document'`; `chats.lastMessagePreview` holds the unsigned text, or `📷 Imagem` / `🎤 Áudio` / `🎥 Vídeo` / `📄 Documento`; the `assigned` event data is `{ ownerId }`.
  - Echo guard: when the gateway call succeeds, the same transaction that stores `externalId`/`status='sent'` first deletes any other row with that `(channelId, externalId)` and `authorId IS NULL` (the webhook echo ingested before the gateway returned), then publishes `chat.updated` if one was dropped. Task 11's `sendSystemText` needs the same guard, and there it must also put `triage_pending` back to `true` for the welcome menu.

---

- [ ] **Step 1: Write the failing tests for signature and media helpers**

`server/test/messages/signature.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formatSignature, signatureLabel } from '../../src/messages/signature.js';
import type { AuthUser } from '../../src/inbox/visibility.js';

const ana: AuthUser = { id: 'u1', name: 'Ana Lima', email: 'ana@x.com', role: 'agent', signature: null, sectorIds: [] };

describe('signature', () => {
  it('uses "{Setor} - {Nome}" when the user has no signature (Umbler format)', () => {
    expect(signatureLabel(ana, 'Financeiro')).toBe('Financeiro - Ana Lima');
  });

  it('uses the user signature when filled, trimmed', () => {
    expect(signatureLabel({ ...ana, signature: '  Dra. Ana  ' }, 'Financeiro')).toBe('Dra. Ana');
  });

  it('falls back to the sector format when the signature is only whitespace', () => {
    expect(signatureLabel({ ...ana, signature: '   ' }, 'Jurídico')).toBe('Jurídico - Ana Lima');
  });

  it('formats as bold label, colon, newline, text', () => {
    expect(formatSignature('Bom dia!\nSegue o boleto.', 'Financeiro - Ana Lima')).toBe(
      '*Financeiro - Ana Lima:*\nBom dia!\nSegue o boleto.',
    );
  });
});
```

`server/test/messages/media.test.ts` already exists (Task 9: imports plus a `describe('saveMedia', …)` block with 3 tests). Keep all of it. Change its media import line from

```ts
import { saveMedia } from '../../src/messages/media.js';
```

to

```ts
import { mediaResponseHeaders, saveMedia } from '../../src/messages/media.js';
```

and append these two blocks at the end of the file (the other imports they use, `mkdtemp`, `readFile`, `tmpdir`, `join`, `describe`, `expect`, `it`, are already at the top of Task 9's file):

```ts
describe('mediaResponseHeaders', () => {
  const inlineCases: Array<[string, string]> = [
    ['image/jpeg', 'image/jpeg'],
    ['image/png', 'image/png'],
    ['image/webp', 'image/webp'],
    ['image/gif', 'image/gif'],
    ['IMAGE/PNG', 'image/png'],
    ['audio/ogg; codecs=opus', 'audio/ogg'],
    ['audio/mpeg', 'audio/mpeg'],
    ['video/mp4', 'video/mp4'],
  ];

  it.each(inlineCases)('%s → inline as %s, nosniff, CSP sandbox', (mime, type) => {
    const h = mediaResponseHeaders(mime, 'arquivo');
    expect(h['Content-Type']).toBe(type);
    expect(h['Content-Disposition']).toMatch(/^inline;/);
    expect(h['X-Content-Type-Options']).toBe('nosniff');
    expect(h['Content-Security-Policy']).toBe('sandbox');
  });

  it('application/pdf → inline, nosniff, and NO CSP sandbox (browser viewer needs scripts)', () => {
    const h = mediaResponseHeaders('application/pdf', 'contrato.pdf');
    expect(h['Content-Type']).toBe('application/pdf');
    expect(h['Content-Disposition']).toMatch(/^inline;/);
    expect(h['X-Content-Type-Options']).toBe('nosniff');
    expect(h['Content-Security-Policy']).toBeUndefined();
  });

  // Review Focus 5: malicious media must never render inline.
  const attachmentCases = ['text/html', 'image/svg+xml', 'application/xhtml+xml', 'text/javascript', 'video/quicktime', 'application/octet-stream', ''];

  it.each(attachmentCases)('%s → attachment as application/octet-stream with CSP sandbox', (mime) => {
    const h = mediaResponseHeaders(mime, 'x.html');
    expect(h['Content-Type']).toBe('application/octet-stream');
    expect(h['Content-Disposition']).toMatch(/^attachment;/);
    expect(h['X-Content-Type-Options']).toBe('nosniff');
    expect(h['Content-Security-Policy']).toBe('sandbox');
  });

  it('encodes the filename per RFC 5987 with a safe ASCII fallback', () => {
    const h = mediaResponseHeaders('application/pdf', 'Petição "final".pdf');
    expect(h['Content-Disposition']).toBe(
      `inline; filename="Peti__o _final_.pdf"; filename*=UTF-8''Peti%C3%A7%C3%A3o%20%22final%22.pdf`,
    );
  });

  it('never lets CR/LF from a filename reach the header', () => {
    const h = mediaResponseHeaders('text/plain', 'a\r\nSet-Cookie: x=1.txt');
    expect(h['Content-Disposition']).not.toMatch(/[\r\n]/);
  });
});

describe('saveMedia: outgoing files (Task 10)', () => {
  it('saves under the current UTC YYYY/MM with the mapped extension', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'talk-media-'));
    const data = Buffer.from('jpeg-bytes');
    const saved = await saveMedia(dir, data, 'image/jpeg', 'foto.JPG');
    const now = new Date();
    const prefix = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/`;
    expect(saved.path.startsWith(prefix)).toBe(true);
    expect(saved.path).toMatch(/^\d{4}\/\d{2}\/[0-9a-f-]{36}\.jpg$/);
    expect(saved.size).toBe(data.length);
    expect(await readFile(join(dir, saved.path))).toEqual(data);
  });

  it.each([
    ['video/quicktime', 'mov'],
    ['video/3gpp', '3gp'],
    ['audio/aac', 'aac'],
    ['audio/amr', 'amr'],
    ['application/msword', 'doc'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
    ['application/vnd.ms-excel', 'xls'],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
    ['text/plain', 'txt'],
    ['application/zip', 'zip'],
  ])('maps %s to .%s without needing an original name', async (mime, ext) => {
    const dir = await mkdtemp(join(tmpdir(), 'talk-media-'));
    expect((await saveMedia(dir, Buffer.from('a'), mime)).path).toMatch(new RegExp(`\\.${ext}$`));
  });

  it('unknown mime with an unsafe original extension falls back to .bin', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'talk-media-'));
    expect((await saveMedia(dir, Buffer.from('a'), 'application/x-foo', 'x.tar.g$z')).path).toMatch(/\.bin$/);
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npm test -w server -- test/messages/signature.test.ts test/messages/media.test.ts`
Expected: FAIL. `signature.test.ts` fails with `Failed to resolve import "../../src/messages/signature.js"`. In `media.test.ts`, Task 9's 3 `saveMedia` tests still pass, every `mediaResponseHeaders` case fails with `TypeError: mediaResponseHeaders is not a function`, and the new MIME-map cases fail because, with no original name, Task 9's map yields a `.bin` path. The `x.tar.g$z` case already passes.

- [ ] **Step 3: Implement `signature.ts` and extend `media.ts`**

`server/src/messages/signature.ts`:

```ts
import type { AuthUser } from '../inbox/visibility.js';

export function signatureLabel(user: AuthUser, sectorName: string): string {
  return user.signature?.trim() || `${sectorName} - ${user.name}`;
}

export function formatSignature(text: string, signatureLabel: string): string {
  return `*${signatureLabel}:*\n${text}`;
}
```

`server/src/messages/media.ts` (full file after this step; `saveMedia` keeps Task 9's signature and behavior, the MIME map gains the entries from `audio/aac` down, `extensionFor` now uses `baseMime`, and `INLINE`, `baseMime` and `mediaResponseHeaders` are new):

```ts
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'video/mp4': '.mp4',
  'application/pdf': '.pdf',
  'audio/aac': '.aac',
  'audio/amr': '.amr',
  'video/3gpp': '.3gp',
  'video/quicktime': '.mov',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'text/plain': '.txt',
  'application/zip': '.zip',
};

// Spec §4: only these (plus audio/*) may render inline in the browser.
const INLINE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'application/pdf']);

export function baseMime(mime: string): string {
  return (mime.split(';')[0] ?? '').trim().toLowerCase();
}

function extensionFor(mime: string, originalName?: string | null): string {
  const byMime = EXT_BY_MIME[baseMime(mime)];
  if (byMime) return byMime;
  const ext = extname(originalName ?? '').toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '.bin';
}

/** Writes media to `<mediaDir>/YYYY/MM/<uuid>.<ext>`; the original name never becomes part of the path. */
export async function saveMedia(
  mediaDir: string,
  data: Buffer,
  mime: string,
  originalName?: string | null,
): Promise<{ path: string; size: number }> {
  const now = new Date();
  const folder = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const path = `${folder}/${randomUUID()}${extensionFor(mime, originalName)}`;
  await mkdir(join(mediaDir, folder), { recursive: true });
  await writeFile(join(mediaDir, path), data);
  return { path, size: data.length };
}

export function mediaResponseHeaders(mime: string, fileName: string): Record<string, string> {
  const type = baseMime(mime);
  const inline = INLINE.has(type) || type.startsWith('audio/');
  const ascii = fileName.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  const headers: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'Content-Type': inline ? type : 'application/octet-stream',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`,
  };
  if (type !== 'application/pdf') headers['Content-Security-Policy'] = 'sandbox';
  return headers;
}
```

- [ ] **Step 4: Run them and confirm they pass**

Run: `npm test -w server -- test/messages/signature.test.ts test/messages/media.test.ts`
Expected: PASS. All signature tests, all `mediaResponseHeaders` cases, Task 9's 3 `saveMedia` tests and the new `saveMedia` cases are green.

- [ ] **Step 5: Commit**

```bash
git add server/src/messages/signature.ts server/src/messages/media.ts server/test/messages/signature.test.ts server/test/messages/media.test.ts
git commit -m "feat(messages): signature format, wider media mime map and safe media headers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Write the failing tests for sending, resending and notes**

`server/test/messages/send.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { makeTestCtx, seedBasics } from '../helpers.js';
import { chatEvents, chats, contacts, messages } from '../../src/db/schema.js';
import { findOrOpenChat } from '../../src/inbox/chats.js';
import { addNote, resendMessage, sendAgentMessage } from '../../src/messages/send.js';
import { handleInbound } from '../../src/messages/ingest.js';
import type { AuthUser } from '../../src/inbox/visibility.js';

const PHONE = '5565999990001';

let ctx: Awaited<ReturnType<typeof makeTestCtx>>;
let seed: Awaited<ReturnType<typeof seedBasics>>;
let agentA: AuthUser;

beforeEach(async () => {
  ctx = await makeTestCtx();
  ctx.config.mediaDir = await mkdtemp(join(tmpdir(), 'talk-media-'));
  seed = await seedBasics(ctx);
  agentA = { ...seed.agentA, signature: null };
});

async function openChat(opts: { sectorId?: string; ownerId?: string | null; private?: boolean } = {}): Promise<string> {
  const contactId = randomUUID();
  await ctx.db.insert(contacts).values({ id: contactId, name: 'Maria Souza', phone: PHONE });
  const { chat } = await findOrOpenChat(ctx.db, {
    contactId,
    channelId: seed.channelId,
    init: { sectorId: opts.sectorId ?? seed.sectorA, ownerId: opts.ownerId ?? null, waiting: true, triagePending: true, createdBy: null },
  });
  await ctx.db.update(chats).set({ unread: 3, private: opts.private ?? false }).where(eq(chats.id, chat.id));
  return chat.id;
}

async function getChat(chatId: string) {
  const [row] = await ctx.db.select().from(chats).where(eq(chats.id, chatId));
  return row!;
}

describe('sendAgentMessage — text', () => {
  it('sends with signature, assigns the owner, clears waiting/unread/triage and publishes', async () => {
    const chatId = await openChat();
    const sendText = vi.spyOn(ctx.wa, 'sendText');

    const dto = await sendAgentMessage(ctx, agentA, chatId, { text: '  Olá, tudo bem?  ', signature: true });

    const expected = `*Financeiro - ${agentA.name}:*\nOlá, tudo bem?`;
    expect(sendText).toHaveBeenCalledWith('talk-test', PHONE, expected, undefined);
    expect(dto).toMatchObject({ chatId, direction: 'out', kind: 'text', body: expected, status: 'sent', error: null, authorId: agentA.id });

    const [row] = await ctx.db.select().from(messages).where(eq(messages.id, dto.id));
    expect(row!.externalId).toMatch(/^fake-/);

    const chat = await getChat(chatId);
    expect(chat).toMatchObject({ ownerId: agentA.id, waiting: false, unread: 0, triagePending: false, lastMessagePreview: 'Olá, tudo bem?' });
    expect(chat.lastMessageAt).not.toBeNull();

    const events = await ctx.db.select().from(chatEvents).where(and(eq(chatEvents.chatId, chatId), eq(chatEvents.kind, 'assigned')));
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toEqual({ ownerId: agentA.id });

    const published = ctx.hub.events.filter((e) => e.messageId === dto.id).map((e) => e.type);
    expect(published).toEqual(['message.created', 'message.updated']);
  });

  it('sends plain text when signature is off and keeps an existing owner', async () => {
    const chatId = await openChat({ ownerId: seed.admin.id });
    const dto = await sendAgentMessage(ctx, agentA, chatId, { text: 'Oi', signature: false });
    expect(dto.body).toBe('Oi');
    expect((await getChat(chatId)).ownerId).toBe(seed.admin.id);
    const events = await ctx.db.select().from(chatEvents).where(and(eq(chatEvents.chatId, chatId), eq(chatEvents.kind, 'assigned')));
    expect(events).toHaveLength(0);
  });

  it('marks the message failed with the error when the gateway throws, then resend succeeds', async () => {
    const chatId = await openChat();
    const sendText = vi.spyOn(ctx.wa, 'sendText');
    ctx.wa.failNext(new Error('Evolution fora do ar'));

    const failed = await sendAgentMessage(ctx, agentA, chatId, { text: 'Oi', signature: false });
    expect(failed).toMatchObject({ status: 'failed', error: 'Evolution fora do ar' });

    const resent = await resendMessage(ctx, agentA, failed.id);
    expect(resent).toMatchObject({ id: failed.id, status: 'sent', error: null, body: 'Oi' });
    expect(sendText).toHaveBeenCalledTimes(2);

    await expect(resendMessage(ctx, agentA, failed.id)).rejects.toMatchObject({ status: 409 });
  });

  it('resend is 404 for a user who cannot see the chat', async () => {
    const chatId = await openChat();
    ctx.wa.failNext();
    const failed = await sendAgentMessage(ctx, agentA, chatId, { text: 'Oi', signature: false });
    await expect(resendMessage(ctx, seed.agentB, failed.id)).rejects.toMatchObject({ status: 404 });
  });

  it('rejects an empty message (400) and a closed chat (409)', async () => {
    const chatId = await openChat();
    await expect(sendAgentMessage(ctx, agentA, chatId, { text: '   ', signature: true })).rejects.toMatchObject({ status: 400 });
    await ctx.db.update(chats).set({ state: 'closed', closedAt: new Date() }).where(eq(chats.id, chatId));
    await expect(sendAgentMessage(ctx, agentA, chatId, { text: 'Oi', signature: true })).rejects.toMatchObject({ status: 409 });
    expect(ctx.wa.sent).toHaveLength(0);
  });
});

describe('sendAgentMessage — webhook echo arriving before the gateway returns', () => {
  it('keeps one message (ours, sent) and drops the phone-typed echo copy', async () => {
    const chatId = await openChat();
    const realSendText = ctx.wa.sendText.bind(ctx.wa);
    vi.spyOn(ctx.wa, 'sendText').mockImplementation(async (instance, phone, text, quoted) => {
      const res = await realSendText(instance, phone, text, quoted);
      // Evolution's messages.upsert echo (fromMe) is ingested while our call is still pending.
      await handleInbound(ctx, [
        {
          type: 'message', instance, externalId: res.externalId, direction: 'out', phone, lid: null,
          pushName: 'Escritório JVO', kind: 'text', body: text, hasMedia: false, mediaMime: null,
          mediaName: null, replyToExternalId: null, sentAt: new Date(), raw: {},
        },
      ]);
      return res;
    });

    const dto = await sendAgentMessage(ctx, agentA, chatId, { text: 'Oi', signature: false });

    expect(dto).toMatchObject({ status: 'sent', error: null, authorId: agentA.id });
    const rows = await ctx.db.select().from(messages).where(eq(messages.chatId, chatId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: dto.id, authorId: agentA.id, status: 'sent' });
    expect(rows[0]!.externalId).toMatch(/^fake-/);
    expect(await getChat(chatId)).toMatchObject({ waiting: false, triagePending: false, unread: 0 });
  });
});

describe('sendAgentMessage — visibility and privacy', () => {
  it('agent of another sector gets 404', async () => {
    const chatId = await openChat();
    await expect(sendAgentMessage(ctx, seed.agentB, chatId, { text: 'Oi', signature: false })).rejects.toMatchObject({ status: 404 });
  });

  it('private chat: sector member who is not the owner gets 404; owner and admin can send', async () => {
    const chatId = await openChat({ ownerId: seed.agentA.id, private: true });
    const otherInSectorA: AuthUser = { ...seed.agentB, id: randomUUID(), sectorIds: [seed.sectorA] };
    await expect(sendAgentMessage(ctx, otherInSectorA, chatId, { text: 'Oi', signature: false })).rejects.toMatchObject({ status: 404 });

    expect((await sendAgentMessage(ctx, agentA, chatId, { text: 'Oi', signature: false })).status).toBe('sent');
    expect((await sendAgentMessage(ctx, seed.admin, chatId, { text: 'Oi', signature: false })).status).toBe('sent');
    expect(ctx.wa.sent).toHaveLength(2);
  });
});

describe('sendAgentMessage — files', () => {
  it('image: stores the file and sends it with the signed caption', async () => {
    const chatId = await openChat();
    const sendMedia = vi.spyOn(ctx.wa, 'sendMedia');
    const buffer = Buffer.from('fake-png-bytes');

    const dto = await sendAgentMessage(ctx, agentA, chatId, {
      text: 'veja',
      signature: true,
      file: { buffer, mime: 'image/png', name: 'foto.png' },
    });

    expect(sendMedia).toHaveBeenCalledWith(
      'talk-test',
      PHONE,
      { kind: 'image', base64: buffer.toString('base64'), mime: 'image/png', fileName: 'foto.png', caption: `*Financeiro - ${agentA.name}:*\nveja` },
      undefined,
    );
    expect(dto).toMatchObject({ kind: 'image', status: 'sent' });

    const [row] = await ctx.db.select().from(messages).where(eq(messages.id, dto.id));
    expect(row).toMatchObject({ mediaMime: 'image/png', mediaName: 'foto.png', mediaSize: buffer.length });
    expect(await readFile(join(ctx.config.mediaDir, row!.mediaPath!))).toEqual(buffer);
    expect((await getChat(chatId)).lastMessagePreview).toBe('veja');
  });

  it('pdf without text: document with no caption, preview "📄 Documento"', async () => {
    const chatId = await openChat();
    const sendMedia = vi.spyOn(ctx.wa, 'sendMedia');
    const buffer = Buffer.from('%PDF-1.4');

    const dto = await sendAgentMessage(ctx, agentA, chatId, { signature: true, file: { buffer, mime: 'application/pdf', name: 'contrato.pdf' } });

    expect(sendMedia).toHaveBeenCalledWith(
      'talk-test',
      PHONE,
      { kind: 'document', base64: buffer.toString('base64'), mime: 'application/pdf', fileName: 'contrato.pdf' },
      undefined,
    );
    expect(dto).toMatchObject({ kind: 'document', body: null });
    expect((await getChat(chatId)).lastMessagePreview).toBe('📄 Documento');
  });

  it('voice: asVoice sends through sendAudio, ignores text, kind audio', async () => {
    const chatId = await openChat();
    const sendAudio = vi.spyOn(ctx.wa, 'sendAudio');
    const buffer = Buffer.from('ogg-opus-bytes');

    const dto = await sendAgentMessage(ctx, agentA, chatId, {
      text: 'ignorado',
      signature: true,
      asVoice: true,
      file: { buffer, mime: 'audio/ogg; codecs=opus', name: 'gravacao.ogg' },
    });

    expect(sendAudio).toHaveBeenCalledWith('talk-test', PHONE, buffer.toString('base64'));
    expect(dto).toMatchObject({ kind: 'audio', body: null, status: 'sent' });
    expect((await getChat(chatId)).lastMessagePreview).toBe('🎤 Áudio');
  });

  it('asVoice with a non-audio file is 400', async () => {
    const chatId = await openChat();
    await expect(
      sendAgentMessage(ctx, agentA, chatId, { signature: false, asVoice: true, file: { buffer: Buffer.from('x'), mime: 'image/png', name: 'a.png' } }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('resending a failed image re-reads the stored file', async () => {
    const chatId = await openChat();
    const sendMedia = vi.spyOn(ctx.wa, 'sendMedia');
    const buffer = Buffer.from('jpeg');
    ctx.wa.failNext();
    const failed = await sendAgentMessage(ctx, agentA, chatId, { signature: false, file: { buffer, mime: 'image/jpeg', name: 'a.jpg' } });
    expect(failed.status).toBe('failed');

    const resent = await resendMessage(ctx, agentA, failed.id);
    expect(resent.status).toBe('sent');
    expect(sendMedia).toHaveBeenLastCalledWith(
      'talk-test',
      PHONE,
      { kind: 'image', base64: buffer.toString('base64'), mime: 'image/jpeg', fileName: 'a.jpg' },
      undefined,
    );
  });
});

describe('sendAgentMessage — reply', () => {
  it('sends the quoted key of the original message', async () => {
    const chatId = await openChat();
    const inboundId = randomUUID();
    await ctx.db.insert(messages).values({
      id: inboundId, chatId, channelId: seed.channelId, direction: 'in', kind: 'text',
      body: 'Qual o prazo?', externalId: 'EXT-1', status: 'sent', sentAt: new Date(),
    });
    const sendText = vi.spyOn(ctx.wa, 'sendText');

    const dto = await sendAgentMessage(ctx, agentA, chatId, { text: 'Amanhã.', signature: false, replyToId: inboundId });

    expect(sendText).toHaveBeenCalledWith('talk-test', PHONE, 'Amanhã.', { externalId: 'EXT-1', body: 'Qual o prazo?', fromMe: false });
    expect(dto.replyTo?.id).toBe(inboundId);
  });

  it('replyToId from another chat is 400', async () => {
    const chatId = await openChat();
    const otherContact = randomUUID();
    await ctx.db.insert(contacts).values({ id: otherContact, name: 'João', phone: '5565988880000' });
    const { chat: other } = await findOrOpenChat(ctx.db, {
      contactId: otherContact, channelId: seed.channelId,
      init: { sectorId: seed.sectorA, ownerId: null, waiting: false, triagePending: false, createdBy: null },
    });
    const foreignId = randomUUID();
    await ctx.db.insert(messages).values({
      id: foreignId, chatId: other.id, channelId: seed.channelId, direction: 'in', kind: 'text',
      body: 'x', externalId: 'EXT-9', status: 'sent', sentAt: new Date(),
    });
    await expect(sendAgentMessage(ctx, agentA, chatId, { text: 'Oi', signature: false, replyToId: foreignId })).rejects.toMatchObject({ status: 400 });
  });
});

describe('addNote', () => {
  it('stores a note, never calls the gateway, leaves chat flags untouched', async () => {
    const chatId = await openChat();
    const dto = await addNote(ctx, agentA, chatId, '  Cliente pediu retorno amanhã  ');

    expect(dto).toMatchObject({ chatId, kind: 'note', direction: 'out', body: 'Cliente pediu retorno amanhã', authorId: agentA.id });
    expect(ctx.wa.sent).toHaveLength(0);
    expect(await getChat(chatId)).toMatchObject({ waiting: true, unread: 3, triagePending: true, ownerId: null });
    expect(ctx.hub.events.some((e) => e.type === 'message.created' && e.messageId === dto.id)).toBe(true);
  });

  it('empty note is 400; other sector is 404', async () => {
    const chatId = await openChat();
    await expect(addNote(ctx, agentA, chatId, '  ')).rejects.toMatchObject({ status: 400 });
    await expect(addNote(ctx, seed.agentB, chatId, 'x')).rejects.toMatchObject({ status: 404 });
  });

  it('a note cannot be resent', async () => {
    const chatId = await openChat();
    const note = await addNote(ctx, agentA, chatId, 'nota');
    await expect(resendMessage(ctx, agentA, note.id)).rejects.toMatchObject({ status: 409 });
  });
});
```

- [ ] **Step 7: Run it and confirm it fails**

Run: `npm test -w server -- test/messages/send.test.ts`
Expected: FAIL. Vitest reports `Failed to resolve import "../../src/messages/send.js"`.

- [ ] **Step 8: Implement `send.ts`**

`server/src/messages/send.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import type { AppCtx } from '../ctx.js';
import type { Db } from '../db/client.js';
import { channels, chats, contacts, messages, sectors } from '../db/schema.js';
import { getChatForUser, type ChatRow } from '../inbox/chats.js';
import { addEvent } from '../inbox/events.js';
import type { AuthUser } from '../inbox/visibility.js';
import { badRequest, conflict, notFound } from '../lib/http-error.js';
import type { QuotedRef, SendResult } from '../whatsapp/types.js';
import { toMessageDto } from './dto.js';
import { baseMime, saveMedia } from './media.js';
import { formatSignature, signatureLabel } from './signature.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type MessageRow = typeof messages.$inferSelect;
type MessageDto = Awaited<ReturnType<typeof toMessageDto>>;
type OutKind = 'text' | 'image' | 'video' | 'audio' | 'document';

export interface SendInput {
  text?: string;
  file?: { buffer: Buffer; mime: string; name: string };
  asVoice?: boolean;
  signature: boolean;
  replyToId?: string;
}

const PREVIEW: Record<Exclude<OutKind, 'text'>, string> = {
  image: '📷 Imagem',
  audio: '🎤 Áudio',
  video: '🎥 Vídeo',
  document: '📄 Documento',
};

function fileKind(mime: string, asVoice: boolean): Exclude<OutKind, 'text'> {
  const type = baseMime(mime);
  if (asVoice) return 'audio';
  if (type === 'image/jpeg' || type === 'image/png') return 'image';
  if (type === 'video/mp4') return 'video';
  return 'document';
}

/** Spec §5.2 steps 2 and 5: first sender becomes owner; agent activity clears waiting/unread/triage. */
async function touchChat(tx: Tx, user: AuthUser, chat: ChatRow, last?: { at: Date; preview: string }): Promise<void> {
  if (chat.ownerId === null) {
    const won = await tx
      .update(chats)
      .set({ ownerId: user.id })
      .where(and(eq(chats.id, chat.id), isNull(chats.ownerId)))
      .returning({ id: chats.id });
    if (won.length > 0) await addEvent(tx, chat.id, 'assigned', { ownerId: user.id }, user.id);
  }
  await tx
    .update(chats)
    .set({
      waiting: false,
      unread: 0,
      triagePending: false,
      ...(last
        ? {
            lastMessageAt: sql`greatest(${chats.lastMessageAt}, ${last.at.toISOString()}::timestamptz)`,
            lastMessagePreview: last.preview,
          }
        : {}),
    })
    .where(eq(chats.id, chat.id));
}

async function quotedRef(db: Db, replyToId: string | null): Promise<QuotedRef | undefined> {
  if (!replyToId) return undefined;
  const [orig] = await db.select().from(messages).where(eq(messages.id, replyToId));
  if (!orig?.externalId) return undefined; // ponytail: replying to a note/failed message sends without quote
  return { externalId: orig.externalId, body: orig.body, fromMe: orig.direction === 'out' };
}

async function callGateway(ctx: AppCtx, msg: MessageRow): Promise<SendResult> {
  const [target] = await ctx.db
    .select({ phone: contacts.phone, instance: channels.evolutionInstance })
    .from(chats)
    .innerJoin(contacts, eq(contacts.id, chats.contactId))
    .innerJoin(channels, eq(channels.id, chats.channelId))
    .where(eq(chats.id, msg.chatId));
  if (!target?.phone) throw new Error('Contato sem telefone');
  const quoted = await quotedRef(ctx.db, msg.replyToId);

  if (msg.kind === 'text') return ctx.wa.sendText(target.instance, target.phone, msg.body ?? '', quoted);

  if (!msg.mediaPath) throw new Error('Arquivo não encontrado');
  const base64 = (await readFile(join(ctx.config.mediaDir, msg.mediaPath))).toString('base64');
  if (msg.kind === 'audio') return ctx.wa.sendAudio(target.instance, target.phone, base64);
  return ctx.wa.sendMedia(
    target.instance,
    target.phone,
    {
      kind: msg.kind as 'image' | 'video' | 'document',
      base64,
      mime: msg.mediaMime ?? 'application/octet-stream',
      fileName: msg.mediaName ?? 'arquivo',
      ...(msg.body ? { caption: msg.body } : {}),
    },
    quoted,
  );
}

/** Spec §5.2 step 4: call Evolution; success → external_id + sent, failure → failed + error. */
async function deliver(ctx: AppCtx, msg: MessageRow): Promise<MessageDto> {
  let result: SendResult | null = null;
  let error: string | null = null;
  try {
    result = await callGateway(ctx, msg);
  } catch (err) {
    error = err instanceof Error && err.message ? err.message.slice(0, 200) : 'Falha ao enviar';
  }
  const { updated, echoDropped } = await ctx.db.transaction(async (tx) => {
    let echoDropped = false;
    if (result) {
      // Evolution's messages.upsert echo of this send can beat the gateway response; ingest then stored it
      // as an author-less "sent from the phone" copy with our external_id. Drop it so ours keeps the id
      // (otherwise the update below hits messages_channel_external_unique).
      const gone = await tx
        .delete(messages)
        .where(
          and(
            eq(messages.channelId, msg.channelId),
            eq(messages.externalId, result.externalId),
            isNull(messages.authorId),
            ne(messages.id, msg.id),
          ),
        )
        .returning({ id: messages.id });
      echoDropped = gone.length > 0;
    }
    const [row] = await tx
      .update(messages)
      .set(result ? { externalId: result.externalId, status: 'sent', error: null } : { status: 'failed', error })
      .where(eq(messages.id, msg.id))
      .returning();
    return { updated: row!, echoDropped };
  });
  await ctx.hub.publishMessage(msg.chatId, 'message.updated', msg.id);
  // ponytail: triage_pending needs no restore here: touchChat already set it (and waiting) false before the
  // gateway call, the same values the echo wrote. The echo's own message.created bubble stays on open clients
  // until the timeline is refetched; the contract has no message.removed event. Add one if that shows up in use.
  if (echoDropped) await ctx.hub.publishChat(msg.chatId);
  return toMessageDto(ctx.db, updated);
}

export async function sendAgentMessage(ctx: AppCtx, user: AuthUser, chatId: string, input: SendInput): Promise<MessageDto> {
  const chat = await getChatForUser(ctx, user, chatId); // 404 also covers private chats of someone else
  if (chat.state !== 'open') throw conflict('Conversa finalizada');

  const file = input.file ?? null;
  const asVoice = !!input.asVoice && file !== null;
  if (file && asVoice && !baseMime(file.mime).startsWith('audio/')) throw badRequest('Áudio inválido');
  const text = asVoice ? null : input.text?.trim() || null;
  if (!text && !file) throw badRequest('Mensagem vazia');

  let replyToId: string | null = null;
  if (input.replyToId) {
    const [orig] = await ctx.db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.id, input.replyToId), eq(messages.chatId, chatId)));
    if (!orig) throw badRequest('Mensagem citada não encontrada');
    replyToId = orig.id;
  }

  let body = text;
  if (text && input.signature) {
    const [sector] = await ctx.db.select({ name: sectors.name }).from(sectors).where(eq(sectors.id, chat.sectorId));
    body = formatSignature(text, signatureLabel(user, sector?.name ?? ''));
  }

  const kind: OutKind = file ? fileKind(file.mime, asVoice) : 'text';
  const media = file ? await saveMedia(ctx.config.mediaDir, file.buffer, file.mime, file.name) : null;
  const now = new Date();

  const row = await ctx.db.transaction(async (tx) => {
    await touchChat(tx, user, chat, { at: now, preview: (text ?? PREVIEW[kind as Exclude<OutKind, 'text'>]).slice(0, 100) });
    const [inserted] = await tx
      .insert(messages)
      .values({
        id: randomUUID(),
        chatId,
        channelId: chat.channelId,
        direction: 'out',
        kind,
        body,
        mediaPath: media?.path ?? null,
        mediaMime: file?.mime ?? null,
        mediaSize: media?.size ?? null,
        mediaName: file?.name ?? null,
        authorId: user.id,
        replyToId,
        status: 'pending',
        sentAt: now,
      })
      .returning();
    return inserted!;
  });

  await ctx.hub.publishMessage(chatId, 'message.created', row.id);
  await ctx.hub.publishChat(chatId);
  return deliver(ctx, row);
}

export async function resendMessage(ctx: AppCtx, user: AuthUser, messageId: string): Promise<MessageDto> {
  const [msg] = await ctx.db.select().from(messages).where(eq(messages.id, messageId));
  if (!msg) throw notFound();
  const chat = await getChatForUser(ctx, user, msg.chatId);
  if (msg.direction !== 'out' || msg.kind === 'note' || msg.status !== 'failed') {
    throw conflict('Só mensagens com falha podem ser reenviadas');
  }
  if (chat.state !== 'open') throw conflict('Conversa finalizada');

  const row = await ctx.db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(messages)
      .set({ status: 'pending', error: null })
      .where(and(eq(messages.id, messageId), eq(messages.status, 'failed')))
      .returning();
    if (!claimed) throw conflict('Só mensagens com falha podem ser reenviadas');
    await touchChat(tx, user, chat);
    return claimed;
  });

  await ctx.hub.publishMessage(row.chatId, 'message.updated', row.id);
  await ctx.hub.publishChat(row.chatId);
  return deliver(ctx, row);
}

export async function addNote(ctx: AppCtx, user: AuthUser, chatId: string, text: string): Promise<MessageDto> {
  const chat = await getChatForUser(ctx, user, chatId);
  const body = text.trim();
  if (!body) throw badRequest('Nota vazia');
  const [row] = await ctx.db
    .insert(messages)
    .values({
      id: randomUUID(),
      chatId,
      channelId: chat.channelId,
      direction: 'out',
      kind: 'note',
      body,
      authorId: user.id,
      status: 'sent', // ponytail: notes never reach WhatsApp; 'sent' is just a non-pending value, UI hides ticks for notes
      sentAt: new Date(),
    })
    .returning();
  await ctx.hub.publishMessage(chatId, 'message.created', row!.id);
  return toMessageDto(ctx.db, row!);
}
```

- [ ] **Step 9: Run it and confirm it passes**

Run: `npm test -w server -- test/messages/send.test.ts`
Expected: PASS. All `sendAgentMessage`, `resendMessage` and `addNote` cases are green, including the echo-race case (one row, ours, `sent`).

- [ ] **Step 10: Commit**

```bash
git add server/src/messages/send.ts server/test/messages/send.test.ts
git commit -m "feat(messages): send text/media/voice with signature and quote, resend, notes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 11: Write the failing test for the media route**

`server/test/media/routes.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { loginAs, makeTestApp, makeTestCtx, seedBasics } from '../helpers.js';
import { contacts, messages } from '../../src/db/schema.js';
import { findOrOpenChat } from '../../src/inbox/chats.js';
import { saveMedia } from '../../src/messages/media.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function setup() {
  const ctx = await makeTestCtx();
  ctx.config.mediaDir = await mkdtemp(join(tmpdir(), 'talk-media-'));
  const seed = await seedBasics(ctx);
  const built = await makeTestApp(ctx);
  app = built.app;

  const contactId = randomUUID();
  await ctx.db.insert(contacts).values({ id: contactId, name: 'Maria', phone: '5565999990001' });
  const { chat } = await findOrOpenChat(ctx.db, {
    contactId,
    channelId: seed.channelId,
    init: { sectorId: seed.sectorA, ownerId: null, waiting: true, triagePending: false, createdBy: null },
  });

  const html = '<html><script>alert(document.cookie)</script></html>';
  const saved = await saveMedia(ctx.config.mediaDir, Buffer.from(html), 'text/html', 'x.html');
  const mediaId = randomUUID();
  await ctx.db.insert(messages).values({
    id: mediaId, chatId: chat.id, channelId: seed.channelId, direction: 'in', kind: 'document', body: null,
    mediaPath: saved.path, mediaMime: 'text/html', mediaSize: saved.size, mediaName: 'x.html',
    externalId: 'EXT-HTML', status: 'sent', sentAt: new Date(),
  });
  const textId = randomUUID();
  await ctx.db.insert(messages).values({
    id: textId, chatId: chat.id, channelId: seed.channelId, direction: 'in', kind: 'text', body: 'oi',
    externalId: 'EXT-TXT', status: 'sent', sentAt: new Date(),
  });
  return { ctx, seed, app: built.app, html, mediaId, textId, savedPath: saved.path };
}

describe('GET /api/media/:messageId', () => {
  it('serves a visible file as a sandboxed attachment (Review Focus 5)', async () => {
    const { seed, app, html, mediaId } = await setup();
    const a = await loginAs(app, seed.agentA.email);
    const res = await app.inject({ method: 'GET', url: `/api/media/${mediaId}`, headers: a.headers });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(html);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="x\.html"/);
    expect(res.headers['content-security-policy']).toBe('sandbox');
    expect(res.headers['x-content-type-options']).toBe('nosniff');

    const admin = await loginAs(app, seed.admin.email);
    expect((await app.inject({ method: 'GET', url: `/api/media/${mediaId}`, headers: admin.headers })).statusCode).toBe(200);
  });

  it('is 404 for an agent of another sector (Review Focus 4)', async () => {
    const { seed, app, mediaId } = await setup();
    const b = await loginAs(app, seed.agentB.email);
    const res = await app.inject({ method: 'GET', url: `/api/media/${mediaId}`, headers: b.headers });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Não encontrado' });
  });

  it('is 404 for a message without media, a non-uuid id, an unknown id and a missing file', async () => {
    const { ctx, seed, app, textId, mediaId, savedPath } = await setup();
    const a = await loginAs(app, seed.agentA.email);
    for (const id of [textId, 'nao-e-uuid', randomUUID()]) {
      expect((await app.inject({ method: 'GET', url: `/api/media/${id}`, headers: a.headers })).statusCode).toBe(404);
    }
    await rm(join(ctx.config.mediaDir, savedPath));
    expect((await app.inject({ method: 'GET', url: `/api/media/${mediaId}`, headers: a.headers })).statusCode).toBe(404);
  });

  it('is 401 without a session', async () => {
    const { app, mediaId } = await setup();
    const res = await app.inject({ method: 'GET', url: `/api/media/${mediaId}` });
    expect(res.statusCode).toBe(401);
  });
});
```

- [ ] **Step 12: Run it and confirm it fails**

Run: `npm test -w server -- test/media/routes.test.ts`
Expected: FAIL. The tests that expect 200 get 404 (`Route GET:/api/media/... not found`) because the route is not registered yet.

- [ ] **Step 13: Implement the route and register it**

`server/src/media/routes.ts`:

```ts
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppCtx } from '../ctx.js';
import { messages } from '../db/schema.js';
import { getChatForUser } from '../inbox/chats.js';
import type { AuthUser } from '../inbox/visibility.js';
import { HttpError, notFound } from '../lib/http-error.js';
import { mediaResponseHeaders } from '../messages/media.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function mediaRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  app.get<{ Params: { messageId: string } }>('/api/media/:messageId', async (req, reply) => {
    const user = (req as unknown as { user?: AuthUser | null }).user; // set by auth plugin (Task 6)
    if (!user) throw new HttpError(401, 'Não autenticado');
    if (!UUID.test(req.params.messageId)) throw notFound(); // a bad uuid would be a 500 from Postgres

    const [msg] = await ctx.db.select().from(messages).where(eq(messages.id, req.params.messageId));
    if (!msg?.mediaPath) throw notFound();
    await getChatForUser(ctx, user, msg.chatId); // 404 when !canSee

    const root = resolve(ctx.config.mediaDir);
    const file = resolve(root, msg.mediaPath);
    if (!file.startsWith(root + sep)) throw notFound();
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) throw notFound();

    return reply
      .headers({
        ...mediaResponseHeaders(msg.mediaMime ?? 'application/octet-stream', msg.mediaName ?? basename(file)),
        'Content-Length': String(info.size),
      })
      .send(createReadStream(file));
  });
}
```

`server/src/app.ts`: add the import next to the other route-module imports:

```ts
import { mediaRoutes } from './media/routes.js';
```

and add this call in `buildApp`, after the auth plugin is registered and next to the other route registrations:

```ts
  await mediaRoutes(app, ctx);
```

- [ ] **Step 14: Run the route test and the whole task's tests**

Run: `npm test -w server -- test/media/routes.test.ts test/messages/signature.test.ts test/messages/media.test.ts test/messages/send.test.ts`
Expected: PASS. All four files are green.

Run: `npm test -w server`
Expected: PASS. No regressions in earlier tasks.

- [ ] **Step 15: Commit**

```bash
git add server/src/media/routes.ts server/src/app.ts server/test/media/routes.test.ts
git commit -m "feat(media): GET /api/media/:messageId with canSee and safe headers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


---

### Task 11: Triage menu

Implements spec §5.4: when a chat is created by an `in` message and `settings.triage_menu.enabled`, the system sends the welcome text plus numbered options, marks `triage_pending=true`, and the contact's next `in` message either routes the chat to the chosen sector (event `triage_routed`) or gets `invalid_text` once and stays in the default sector. The caller (Task 9 ingest) decides *when* to call `startTriage` / `handleTriageReply`; this task only provides them.

**Files:**
- Create: `server/src/triage/triage.ts`
- Test: `server/test/triage/triage.test.ts`

**Interfaces:**
- Consumes:
  - `AppCtx` from `server/src/ctx.ts` (`db`, `wa`, `hub`).
  - `Db` from `server/src/db/client.ts`; transaction type defined locally as `type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]` (same definition as the contract).
  - Schema tables from `server/src/db/schema.ts`: `chats`, `contacts`, `channels`, `messages`, `sectors`, `settings`, `chatEvents` (columns camelCase per spec §4: `chats.triagePending`, `chats.sectorId`, `chats.state`, `chats.lastMessageAt`, `chats.lastMessagePreview`, `channels.evolutionInstance`, `messages.externalId`, `messages.sentAt`, `settings.key`, `settings.value`, …).
  - `addEvent(db: Db | Tx, chatId: string, kind: ChatEventKind, data: Record<string, unknown>, authorId: string | null): Promise<void>` from `server/src/inbox/events.ts`.
  - `ChatRow` and `findOrOpenChat(db, { contactId, channelId, init: { sectorId, ownerId, waiting, triagePending, createdBy } })` from `server/src/inbox/chats.ts` (tests only use `findOrOpenChat`).
  - `ctx.wa.sendText(instance: string, phone: string, text: string): Promise<SendResult>`.
  - `ctx.hub.publishMessage(chatId, 'message.created' | 'message.updated', messageId)`, `ctx.hub.publishChat(chatId)`.
  - Test helpers `makeTestCtx()`, `seedBasics(ctx)` from `server/test/helpers.ts` (fake gateway `sent` / `failNext`, recording hub `events`).
- Produces (exact contract signatures, `server/src/triage/triage.ts`):
  ```ts
  export interface TriageOption { key: string; label: string; sectorId: string }
  export interface TriageMenu { enabled: boolean; welcomeText: string; invalidText: string; options: TriageOption[] }
  export async function getTriageMenu(db: Db | Tx): Promise<TriageMenu>;
  export function matchTriageOption(text: string, menu: TriageMenu, sectorNames: Map<string, string>): TriageOption | null;
  export async function startTriage(ctx: AppCtx, chat: ChatRow): Promise<void>;
  export async function handleTriageReply(ctx: AppCtx, chat: ChatRow, text: string | null): Promise<boolean>;
  ```
  Behavior later tasks rely on:
  - `settings` row `key='triage_menu'` stores **snake_case** jsonb exactly as spec §4: `{ enabled, welcome_text, invalid_text, options: [{ key, label, sector_id }] }`. `getTriageMenu` maps it to camelCase `TriageMenu`; a missing or malformed row returns `{ enabled: false, welcomeText: '', invalidText: '', options: [] }`. Task 12 (`catalog/settings.ts`) must write this snake_case shape and may call `getTriageMenu` to build `SettingsDto.triageMenu`.
  - `matchTriageOption` ignores options whose `sectorId` is not a key of `sectorNames` (deleted sector).
  - Menu text sent to the contact: `${welcomeText}\n\n${key} - ${label}` lines (one per option with an existing sector).
  - System messages (menu and invalid text) are rows with `direction='out'`, `kind='text'`, `authorId=null`, `status` `pending` → `sent` (with `externalId`) or `failed` (with `error`); they update `last_message_at/preview` but never `waiting`, `unread`, `ownerId` or `sectorId`.
  - `handleTriageReply` returns `false` when the chat has no pending triage (caller continues normally) and `true` when the message was taken as a triage answer (routed, or invalid text sent). The inbound message itself is stored by ingest either way.
  - The flag is flipped with `UPDATE … WHERE triage_pending = true`, so two concurrent replies route/answer only once.

---

- [ ] **Step 1: Write the failing tests for `getTriageMenu` and `matchTriageOption`**

Create `server/test/triage/triage.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeTestCtx } from '../helpers.js';
import { settings } from '../../src/db/schema.js';
import { getTriageMenu, matchTriageOption, type TriageMenu } from '../../src/triage/triage.js';

const sectorNames = new Map<string, string>([
  ['s-fin', 'Financeiro'],
  ['s-jur', 'Jurídico'],
]);

const menu: TriageMenu = {
  enabled: true,
  welcomeText: 'Olá! Escolha uma opção:',
  invalidText: 'Opção inválida.',
  options: [
    { key: '1', label: 'Financeiro e boletos', sectorId: 's-fin' },
    { key: '2', label: 'Processos', sectorId: 's-jur' },
    { key: '3', label: 'Setor apagado', sectorId: 's-gone' },
  ],
};

describe('matchTriageOption', () => {
  it.each([
    ['1', '1'],
    [' 2 ', '2'],
    ['1.', '1'],
    ['(2)', '2'],
    ['2)', '2'],
    ['financeiro', '1'],
    ['FINANCEIRO!', '1'],
    ['Financeiro e boletos', '1'],
    ['financeiro   e  boletos', '1'],
    ['Jurídico', '2'],
    ['juridico', '2'],
    ['JURIDICO.', '2'],
    ['processos', '2'],
    ['"Processos"', '2'],
  ])('%j matches option %s', (text, key) => {
    expect(matchTriageOption(text, menu, sectorNames)?.key).toBe(key);
  });

  it.each([
    ['3'], // option whose sector no longer exists
    ['setor apagado'],
    ['12'],
    [''],
    ['   '],
    ['...'],
    ['oi, quero falar com o financeiro'],
  ])('%j matches nothing', (text) => {
    expect(matchTriageOption(text, menu, sectorNames)).toBeNull();
  });
});

describe('getTriageMenu', () => {
  it('returns a disabled empty menu when the setting is missing', async () => {
    const ctx = await makeTestCtx();
    await ctx.db.delete(settings).where(eq(settings.key, 'triage_menu'));
    expect(await getTriageMenu(ctx.db)).toEqual({ enabled: false, welcomeText: '', invalidText: '', options: [] });
  });

  it('returns a disabled empty menu when the stored value is malformed', async () => {
    const ctx = await makeTestCtx();
    await ctx.db
      .insert(settings)
      .values({ key: 'triage_menu', value: { enabled: 'sim' } })
      .onConflictDoUpdate({ target: settings.key, set: { value: { enabled: 'sim' } } });
    expect(await getTriageMenu(ctx.db)).toEqual({ enabled: false, welcomeText: '', invalidText: '', options: [] });
  });

  it('maps the snake_case jsonb to TriageMenu', async () => {
    const ctx = await makeTestCtx();
    const value = {
      enabled: true,
      welcome_text: 'Olá!',
      invalid_text: 'Não entendi.',
      options: [{ key: '1', label: 'Financeiro', sector_id: 's-fin' }],
    };
    await ctx.db
      .insert(settings)
      .values({ key: 'triage_menu', value })
      .onConflictDoUpdate({ target: settings.key, set: { value } });
    expect(await getTriageMenu(ctx.db)).toEqual({
      enabled: true,
      welcomeText: 'Olá!',
      invalidText: 'Não entendi.',
      options: [{ key: '1', label: 'Financeiro', sectorId: 's-fin' }],
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w server -- test/triage/triage.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/triage/triage.js"` (the module does not exist yet).

- [ ] **Step 3: Implement `getTriageMenu` and `matchTriageOption`**

Create `server/src/triage/triage.ts`:

```ts
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { settings } from '../db/schema.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface TriageOption { key: string; label: string; sectorId: string }
export interface TriageMenu { enabled: boolean; welcomeText: string; invalidText: string; options: TriageOption[] }

// Stored shape is snake_case, exactly as spec §4.
const storedMenu = z.object({
  enabled: z.boolean(),
  welcome_text: z.string(),
  invalid_text: z.string(),
  options: z.array(z.object({ key: z.string(), label: z.string(), sector_id: z.string() })),
});

export async function getTriageMenu(db: Db | Tx): Promise<TriageMenu> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, 'triage_menu'));
  const parsed = storedMenu.safeParse(row?.value);
  if (!parsed.success) return { enabled: false, welcomeText: '', invalidText: '', options: [] };
  const v = parsed.data;
  return {
    enabled: v.enabled,
    welcomeText: v.welcome_text,
    invalidText: v.invalid_text,
    options: v.options.map((o) => ({ key: o.key, label: o.label, sectorId: o.sector_id })),
  };
}

// Lowercase, strip accents, trim, drop surrounding punctuation, collapse inner spaces.
function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .replace(/\s+/g, ' ');
}

export function matchTriageOption(text: string, menu: TriageMenu, sectorNames: Map<string, string>): TriageOption | null {
  const t = normalize(text);
  if (!t) return null;
  return (
    menu.options.find((o) => {
      const sectorName = sectorNames.get(o.sectorId);
      if (sectorName === undefined) return false; // sector was deleted
      return [o.key, o.label, sectorName].some((candidate) => normalize(candidate) === t);
    }) ?? null
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w server -- test/triage/triage.test.ts`
Expected: PASS (all `matchTriageOption` and `getTriageMenu` cases).

- [ ] **Step 5: Commit**

```bash
git add server/src/triage/triage.ts server/test/triage/triage.test.ts
git commit -m "feat(triage): read triage menu setting and match replies

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Write the failing tests for `startTriage` and `handleTriageReply`**

In `server/test/triage/triage.test.ts`, keep everything from Step 1 but replace the import block at the top of the file with exactly:

```ts
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { makeTestCtx, seedBasics } from '../helpers.js';
import { chatEvents, chats, contacts, messages, settings } from '../../src/db/schema.js';
import { findOrOpenChat } from '../../src/inbox/chats.js';
import {
  getTriageMenu,
  handleTriageReply,
  matchTriageOption,
  startTriage,
  type TriageMenu,
} from '../../src/triage/triage.js';
```

Then append at the end of the file:

```ts
const PHONE = '5565999990000';
const WELCOME = 'Olá! Escolha uma opção:';
const INVALID = 'Não entendi. Um atendente vai te responder.';

async function setup(enabled = true) {
  const ctx = await makeTestCtx();
  const seed = await seedBasics(ctx);
  const value = {
    enabled,
    welcome_text: WELCOME,
    invalid_text: INVALID,
    options: [
      { key: '1', label: 'Boletos', sector_id: seed.sectorA },
      { key: '2', label: 'Processos', sector_id: seed.sectorB },
      { key: '3', label: 'Setor apagado', sector_id: crypto.randomUUID() },
    ],
  };
  await ctx.db
    .insert(settings)
    .values({ key: 'triage_menu', value })
    .onConflictDoUpdate({ target: settings.key, set: { value } });
  const contactId = crypto.randomUUID();
  const now = new Date();
  await ctx.db.insert(contacts).values({ id: contactId, name: 'Maria', phone: PHONE, createdAt: now, updatedAt: now });
  const { chat } = await findOrOpenChat(ctx.db, {
    contactId,
    channelId: seed.channelId,
    init: { sectorId: seed.defaultSector, ownerId: null, waiting: true, triagePending: false, createdBy: null },
  });
  return { ctx, seed, chat };
}

async function reload(ctx: Awaited<ReturnType<typeof makeTestCtx>>, chatId: string) {
  const [row] = await ctx.db.select().from(chats).where(eq(chats.id, chatId));
  return row;
}

async function chatMessages(ctx: Awaited<ReturnType<typeof makeTestCtx>>, chatId: string) {
  return ctx.db.select().from(messages).where(eq(messages.chatId, chatId)).orderBy(messages.createdAt);
}

describe('startTriage', () => {
  it('sends the welcome text with numbered options and sets triage_pending', async () => {
    const { ctx, seed, chat } = await setup();

    await startTriage(ctx, chat);

    expect(ctx.wa.sent).toHaveLength(1);
    expect(ctx.wa.sent[0]).toMatchObject({ method: 'sendText', instance: seed.instance, phone: PHONE });
    const expectedText = `${WELCOME}\n\n1 - Boletos\n2 - Processos`; // option 3 points to a deleted sector
    expect(JSON.stringify(ctx.wa.sent[0].payload)).toContain(JSON.stringify(expectedText).slice(1, -1));

    const [msg] = await chatMessages(ctx, chat.id);
    expect(msg).toMatchObject({
      direction: 'out',
      kind: 'text',
      body: expectedText,
      authorId: null,
      status: 'sent',
      error: null,
    });
    expect(msg.externalId).toMatch(/^fake-/);

    const after = await reload(ctx, chat.id);
    expect(after.triagePending).toBe(true);
    expect(after.waiting).toBe(true); // system message does not clear "Esperando"
    expect(after.sectorId).toBe(seed.defaultSector);
    expect(after.ownerId).toBeNull();
    expect(after.lastMessagePreview).toBe(expectedText.slice(0, 100));

    const msgEvents = ctx.hub.events.filter((e) => e.messageId === msg.id).map((e) => e.type);
    expect(msgEvents).toEqual(['message.created', 'message.updated']);
    expect(ctx.hub.events.some((e) => e.chatId === chat.id && e.messageId === undefined)).toBe(true);
  });

  it('does nothing when the menu is disabled', async () => {
    const { ctx, chat } = await setup(false);

    await startTriage(ctx, chat);

    expect(ctx.wa.sent).toHaveLength(0);
    expect(await chatMessages(ctx, chat.id)).toHaveLength(0);
    expect((await reload(ctx, chat.id)).triagePending).toBe(false);
  });

  it('marks the menu message failed and leaves triage off when sending fails', async () => {
    const { ctx, chat } = await setup();
    ctx.wa.failNext(new Error('Evolution fora do ar'));

    await startTriage(ctx, chat);

    const [msg] = await chatMessages(ctx, chat.id);
    expect(msg.status).toBe('failed');
    expect(msg.error).toBe('Evolution fora do ar');
    expect((await reload(ctx, chat.id)).triagePending).toBe(false);
  });
});

describe('handleTriageReply', () => {
  it('routes to the chosen sector on a valid reply', async () => {
    const { ctx, seed, chat } = await setup();
    await startTriage(ctx, chat);
    const pending = await reload(ctx, chat.id);
    ctx.hub.events.length = 0;

    expect(await handleTriageReply(ctx, pending, ' Jurídico! ')).toBe(true);

    const after = await reload(ctx, chat.id);
    expect(after.sectorId).toBe(seed.sectorB);
    expect(after.triagePending).toBe(false);
    expect(after.ownerId).toBeNull();
    expect(ctx.wa.sent).toHaveLength(1); // only the menu, no extra message

    const routed = await ctx.db
      .select()
      .from(chatEvents)
      .where(and(eq(chatEvents.chatId, chat.id), eq(chatEvents.kind, 'triage_routed')));
    expect(routed).toHaveLength(1);
    expect(routed[0].data).toEqual({ sectorId: seed.sectorB, option: '2' });
    expect(routed[0].authorId).toBeNull();
    expect(ctx.hub.events.some((e) => e.chatId === chat.id && e.messageId === undefined)).toBe(true);
  });

  it('routes by option number', async () => {
    const { ctx, seed, chat } = await setup();
    await startTriage(ctx, chat);

    expect(await handleTriageReply(ctx, await reload(ctx, chat.id), '1')).toBe(true);
    expect((await reload(ctx, chat.id)).sectorId).toBe(seed.sectorA);
  });

  it('sends the invalid text once and keeps the default sector', async () => {
    const { ctx, seed, chat } = await setup();
    await startTriage(ctx, chat);

    expect(await handleTriageReply(ctx, await reload(ctx, chat.id), 'quero falar com alguém')).toBe(true);

    let after = await reload(ctx, chat.id);
    expect(after.sectorId).toBe(seed.defaultSector);
    expect(after.triagePending).toBe(false);
    expect(ctx.wa.sent).toHaveLength(2);
    const msgs = await chatMessages(ctx, chat.id);
    expect(msgs[1]).toMatchObject({ direction: 'out', authorId: null, body: INVALID, status: 'sent' });

    // A second unmatched message is no longer a triage answer: no second invalid text.
    expect(await handleTriageReply(ctx, after, 'alô?')).toBe(false);
    after = await reload(ctx, chat.id);
    expect(after.sectorId).toBe(seed.defaultSector);
    expect(ctx.wa.sent).toHaveLength(2);
  });

  it('treats a media message (null text) as an invalid reply', async () => {
    const { ctx, seed, chat } = await setup();
    await startTriage(ctx, chat);

    expect(await handleTriageReply(ctx, await reload(ctx, chat.id), null)).toBe(true);
    expect((await reload(ctx, chat.id)).sectorId).toBe(seed.defaultSector);
    expect(ctx.wa.sent).toHaveLength(2);
  });

  it('answers only once when the same pending chat row is handled twice', async () => {
    const { ctx, seed, chat } = await setup();
    await startTriage(ctx, chat);
    const pending = await reload(ctx, chat.id);

    const results = await Promise.all([
      handleTriageReply(ctx, pending, '2'),
      handleTriageReply(ctx, pending, '1'),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    const routed = await ctx.db
      .select()
      .from(chatEvents)
      .where(and(eq(chatEvents.chatId, chat.id), eq(chatEvents.kind, 'triage_routed')));
    expect(routed).toHaveLength(1);
    expect([seed.sectorA, seed.sectorB]).toContain((await reload(ctx, chat.id)).sectorId);
  });

  it('returns false and does nothing when no triage is pending', async () => {
    const { ctx, seed, chat } = await setup();

    expect(await handleTriageReply(ctx, chat, '1')).toBe(false);
    expect((await reload(ctx, chat.id)).sectorId).toBe(seed.defaultSector);
    expect(ctx.wa.sent).toHaveLength(0);
  });

  it('clears the flag without sending anything when the menu was disabled meanwhile', async () => {
    const { ctx, seed, chat } = await setup();
    await startTriage(ctx, chat);
    await ctx.db
      .update(settings)
      .set({ value: { enabled: false, welcome_text: '', invalid_text: INVALID, options: [] } })
      .where(eq(settings.key, 'triage_menu'));

    expect(await handleTriageReply(ctx, await reload(ctx, chat.id), 'qualquer coisa')).toBe(true);
    const after = await reload(ctx, chat.id);
    expect(after.triagePending).toBe(false);
    expect(after.sectorId).toBe(seed.defaultSector);
    expect(ctx.wa.sent).toHaveLength(1);
  });
});
```

- [ ] **Step 7: Run the tests to verify the new ones fail**

Run: `npm test -w server -- test/triage/triage.test.ts`
Expected: FAIL — `SyntaxError: The requested module '../../src/triage/triage.js' does not provide an export named 'handleTriageReply'` (Step 1 tests would pass, but the file fails to import).

- [ ] **Step 8: Implement `startTriage`, `handleTriageReply` and the internal `sendSystemText`**

Replace `server/src/triage/triage.ts` with the complete file:

```ts
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AppCtx } from '../ctx.js';
import type { Db } from '../db/client.js';
import { channels, chats, contacts, messages, sectors, settings } from '../db/schema.js';
import type { ChatRow } from '../inbox/chats.js';
import { addEvent } from '../inbox/events.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface TriageOption { key: string; label: string; sectorId: string }
export interface TriageMenu { enabled: boolean; welcomeText: string; invalidText: string; options: TriageOption[] }

// Stored shape is snake_case, exactly as spec §4.
const storedMenu = z.object({
  enabled: z.boolean(),
  welcome_text: z.string(),
  invalid_text: z.string(),
  options: z.array(z.object({ key: z.string(), label: z.string(), sector_id: z.string() })),
});

export async function getTriageMenu(db: Db | Tx): Promise<TriageMenu> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, 'triage_menu'));
  const parsed = storedMenu.safeParse(row?.value);
  if (!parsed.success) return { enabled: false, welcomeText: '', invalidText: '', options: [] };
  const v = parsed.data;
  return {
    enabled: v.enabled,
    welcomeText: v.welcome_text,
    invalidText: v.invalid_text,
    options: v.options.map((o) => ({ key: o.key, label: o.label, sectorId: o.sector_id })),
  };
}

// Lowercase, strip accents, trim, drop surrounding punctuation, collapse inner spaces.
function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .replace(/\s+/g, ' ');
}

export function matchTriageOption(text: string, menu: TriageMenu, sectorNames: Map<string, string>): TriageOption | null {
  const t = normalize(text);
  if (!t) return null;
  return (
    menu.options.find((o) => {
      const sectorName = sectorNames.get(o.sectorId);
      if (sectorName === undefined) return false; // sector was deleted
      return [o.key, o.label, sectorName].some((candidate) => normalize(candidate) === t);
    }) ?? null
  );
}

async function loadSectorNames(db: Db | Tx): Promise<Map<string, string>> {
  const rows = await db.select({ id: sectors.id, name: sectors.name }).from(sectors);
  return new Map(rows.map((r) => [r.id, r.name]));
}

// System (bot) text: stored as an `out` message without author, signature or owner change.
// Does not touch waiting/unread/triage_pending; the caller publishes chat.updated.
// Returns true when the gateway accepted the message.
async function sendSystemText(ctx: AppCtx, chat: ChatRow, text: string): Promise<boolean> {
  const [contact] = await ctx.db.select({ phone: contacts.phone }).from(contacts).where(eq(contacts.id, chat.contactId));
  const [channel] = await ctx.db
    .select({ instance: channels.evolutionInstance })
    .from(channels)
    .where(eq(channels.id, chat.channelId));
  // ponytail: contacts known only by LID get no automatic text; the gateway sends by phone.
  if (!contact?.phone || !channel) return false;

  const now = new Date();
  const id = crypto.randomUUID();
  await ctx.db.transaction(async (tx) => {
    await tx.insert(messages).values({
      id,
      chatId: chat.id,
      channelId: chat.channelId,
      direction: 'out',
      kind: 'text',
      body: text,
      authorId: null,
      status: 'pending',
      sentAt: now,
      createdAt: now,
    });
    await tx
      .update(chats)
      .set({
        lastMessageAt: sql`greatest(${chats.lastMessageAt}, ${now.toISOString()}::timestamptz)`,
        lastMessagePreview: text.slice(0, 100),
      })
      .where(eq(chats.id, chat.id));
  });
  await ctx.hub.publishMessage(chat.id, 'message.created', id);

  let ok = true;
  try {
    const result = await ctx.wa.sendText(channel.instance, contact.phone, text);
    await ctx.db.update(messages).set({ externalId: result.externalId, status: 'sent' }).where(eq(messages.id, id));
  } catch (err) {
    ok = false;
    const error = err instanceof Error ? err.message : String(err);
    await ctx.db.update(messages).set({ status: 'failed', error }).where(eq(messages.id, id));
  }
  await ctx.hub.publishMessage(chat.id, 'message.updated', id);
  return ok;
}

export async function startTriage(ctx: AppCtx, chat: ChatRow): Promise<void> {
  const menu = await getTriageMenu(ctx.db);
  if (!menu.enabled) return;
  const sectorNames = await loadSectorNames(ctx.db);
  const options = menu.options.filter((o) => sectorNames.has(o.sectorId));
  if (options.length === 0) return;

  // Flag first: a reply racing the send must already be read as a triage answer.
  const [armed] = await ctx.db
    .update(chats)
    .set({ triagePending: true })
    .where(and(eq(chats.id, chat.id), eq(chats.state, 'open')))
    .returning({ id: chats.id });
  if (!armed) return;

  const lines = options.map((o) => `${o.key} - ${o.label}`).join('\n');
  const welcome = menu.welcomeText.trim();
  const text = welcome ? `${welcome}\n\n${lines}` : lines;

  const sent = await sendSystemText(ctx, chat, text);
  // The contact never saw the options, so do not interpret their next message as an answer.
  if (!sent) await ctx.db.update(chats).set({ triagePending: false }).where(eq(chats.id, chat.id));
  await ctx.hub.publishChat(chat.id);
}

export async function handleTriageReply(ctx: AppCtx, chat: ChatRow, text: string | null): Promise<boolean> {
  if (!chat.triagePending) return false;
  const menu = await getTriageMenu(ctx.db);
  const sectorNames = await loadSectorNames(ctx.db);
  const option = menu.enabled && text !== null ? matchTriageOption(text, menu, sectorNames) : null;

  // `WHERE triage_pending = true` makes only one concurrent reply win.
  const consumed = await ctx.db.transaction(async (tx) => {
    const [row] = await tx
      .update(chats)
      .set(option ? { sectorId: option.sectorId, triagePending: false } : { triagePending: false })
      .where(and(eq(chats.id, chat.id), eq(chats.triagePending, true)))
      .returning({ id: chats.id });
    if (!row) return false;
    if (option) await addEvent(tx, chat.id, 'triage_routed', { sectorId: option.sectorId, option: option.key }, null);
    return true;
  });
  if (!consumed) return false;

  if (!option && menu.enabled && menu.invalidText.trim()) await sendSystemText(ctx, chat, menu.invalidText.trim());
  await ctx.hub.publishChat(chat.id);
  return true;
}
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npm test -w server -- test/triage/triage.test.ts`
Expected: PASS (matching table, `getTriageMenu`, `startTriage` ×3, `handleTriageReply` ×7).

- [ ] **Step 10: Typecheck the server workspace**

Run: `npx tsc -p server/tsconfig.json --noEmit`
Expected: exits 0 with no errors.

- [ ] **Step 11: Commit**

```bash
git add server/src/triage/triage.ts server/test/triage/triage.test.ts
git commit -m "feat(triage): send welcome menu and route replies to sectors

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


---

### Task 12: Contacts and catalog API (sectors, tags, custom fields, users, quick answers, settings)

This task covers the CRUD side of spec §3 items 5–6, plus the quick-answer variables from §5.7. It delivers the contact list, the contact card, notes, tags, custom fields, blocking and the contact history (only chats the user can see, §6). It also delivers the admin catalogs: sectors, tags, custom fields, users, quick answers with optional attachment, and settings (closing message and triage menu). Routes stay thin. Contact rules live in `contacts/service.ts`. The variable engine lives in `messages/quick-answers.ts`, which this task owns.

**Files:**
- Create: `server/src/messages/quick-answers.ts`
- Create: `server/src/catalog/sectors.ts`
- Create: `server/src/catalog/tags.ts`
- Create: `server/src/catalog/custom-fields.ts`
- Create: `server/src/contacts/service.ts`
- Create: `server/src/contacts/routes.ts`
- Create: `server/src/catalog/users.ts`
- Create: `server/src/catalog/quick-answers.ts`
- Create: `server/src/catalog/settings.ts`
- Modify: `server/src/app.ts` (add imports and one `register…Routes(app, ctx)` call per module, immediately before the final `return app;` of `buildApp`)
- Test: `server/test/messages/quick-answers.test.ts`
- Test: `server/test/catalog/catalog.test.ts`
- Test: `server/test/contacts/contacts.test.ts`
- Test: `server/test/catalog/users.test.ts`
- Test: `server/test/catalog/quick-answers.test.ts`
- Test: `server/test/catalog/settings.test.ts`

**Interfaces:**
- Consumes:
  - `AppCtx` (`db`, `hub`, `config.mediaDir`) from `server/src/ctx.ts`. `Db` comes from `server/src/db/client.ts`. `Tx` is defined locally as `type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]`.
  - Schema tables from `server/src/db/schema.ts` (Task 2, camelCase per spec §4): `users`, `sectors`, `userSectors`, `contacts`, `customFields`, `contactFieldValues`, `contactNotes`, `tags`, `contactTags`, `chats`, `quickAnswers`, `settings`.
  - `badRequest`, `forbidden`, `notFound`, `conflict` from `server/src/lib/http-error.ts`. The error handler in `buildApp` turns a `ZodError` into a 400 response.
  - **Task 6 (`auth/plugin.ts`)**: every authenticated `/api/*` request has `request.user: AuthUser` (a FastifyRequest augmentation). A request without a session gets 401 before the handler runs. A mutating request with a wrong `Origin` gets 403 before the handler runs.
  - **Task 6**: `hashPassword(plain: string): Promise<string>` from `server/src/auth/password.ts`.
  - **Task 6**: `deleteUserSessions(db: Db | Tx, userId: string): Promise<void>` from `server/src/auth/sessions.ts`.
  - `normalizePhoneBR(raw: string): string` from `server/src/whatsapp/phone.ts` (Task 3).
  - `AuthUser`, `visibleChatsWhere(user): SQL | undefined` from `server/src/inbox/visibility.ts` (Task 7).
  - `findOrOpenChat` (tests only) and `getChatForUser(ctx, user, chatId): Promise<ChatRow>` (404 when the chat is missing or invisible) from `server/src/inbox/chats.ts` (Task 7).
  - `toChatListItem(db, chat, userId): Promise<ChatListItem>` from `server/src/inbox/queries.ts` (Task 13). If Task 13 is implemented after this task, write `toChatListItem` from the contract first. Only the contact-history test needs it.
  - `saveMedia(mediaDir, data, mime, originalName?): Promise<{ path; size }>` and `mediaResponseHeaders(mime, fileName): Record<string, string>` from `server/src/messages/media.ts` (Task 10). The headers include `Content-Type`, `Content-Disposition`, `X-Content-Type-Options` and the CSP. The saved file name keeps the extension (for example `<uuid>.png`).
  - `@fastify/multipart@10.1.3`, installed by Task 1. Task 12 (Step 23) registers it at the root of `buildApp` with `{ limits: { fileSize: 64 * 1024 * 1024, files: 1 } }` and no `attachFieldsToBody`. It provides `request.isMultipart()` and `request.parts()`. Because it is registered at the root, Task 13's `if (!r.hasContentTypeParser('multipart/form-data'))` guard skips its own registration.
  - `getTriageMenu(db: Db | Tx): Promise<TriageMenu>` from `server/src/triage/triage.ts` (Task 11). The setting `triage_menu` is stored as snake_case jsonb.
  - `ctx.hub.publishChat(chatId)` and `ctx.hub.disconnectUser(userId)`.
  - DTO types `ContactDto`, `ContactNoteDto`, `ChatListItem`, `SectorDto`, `TagDto`, `CustomFieldDto`, `UserDto`, `QuickAnswerDto`, `SettingsDto` from the shared workspace package, imported as `@talk/shared`. Use whatever package name Task 1 gave `shared/package.json`.
  - Test helpers `makeTestCtx`, `makeTestApp`, `seedBasics`, `loginAs`, `TEST_ORIGIN` from `server/test/helpers.ts`.
- Produces:
  - `server/src/messages/quick-answers.ts` (contract signatures):
    ```ts
    export interface QuickAnswerVars { atendente: { nome: string; primeiro_nome: string; email: string }; contato: { nome: string; primeiro_nome: string; telefone: string; email: string }; campo: Record<string, string> }
    export function renderQuickAnswer(body: string, vars: QuickAnswerVars): string;
    export function convertUmblerVariables(body: string, variables: Array<{ defaultValue: string }>): { body: string; unmapped: string[] };
    ```
    `renderQuickAnswer` compares names case-, accent- and space-insensitively. `{{campo.CPF}}`, `{{campo.cpf}}` and `{{campo.Número do processo}}` / `{{campo.numero_do_processo}}` all hit the field by name. A known group with no value becomes `''`. An unknown group (for example `{{Contexto.x}}`) and positional `{{1}}` are left untouched. `convertUmblerVariables` turns `{{n}}` into a named variable when `variables[n-1].defaultValue` looks like `Contato.PrimeiroNome`, `Atendente.Email`, `{{Contact.FirstName}}` or `CampoPersonalizado.<nome>` (which becomes `{{campo.<nome>}}`). Anything else is written as the defaultValue text and listed once in `unmapped`. A missing or empty variable keeps `{{n}}` and lists `{{n}}`. **Task 20 (importer)** uses it.
  - `server/src/contacts/service.ts`:
    ```ts
    export interface ContactInput { name?: string | null; phone?: string; email?: string | null; landline?: string | null; address?: Record<string, string> | null }
    export interface ContactListQuery { q?: string; tagId?: string; cursor?: string; limit?: number }
    export async function toContactDtos(db: Db | Tx, rows: Array<typeof contacts.$inferSelect>): Promise<ContactDto[]>;
    export async function getContact(db: Db | Tx, id: string): Promise<ContactDto>;                      // 404
    export async function listContacts(db: Db, f: ContactListQuery): Promise<{ items: ContactDto[]; nextCursor: string | null }>;
    export async function createContact(ctx: AppCtx, input: ContactInput & { phone: string }): Promise<ContactDto>; // 409 duplicate phone, 400 invalid phone
    export async function updateContact(ctx: AppCtx, id: string, patch: ContactInput): Promise<ContactDto>;
    export async function setContactBlocked(ctx: AppCtx, id: string, blocked: boolean): Promise<ContactDto>;
    export async function setContactTags(ctx: AppCtx, id: string, tagIds: string[]): Promise<ContactDto>;
    export async function setContactFields(ctx: AppCtx, id: string, values: Record<string, string>): Promise<ContactDto>; // '' deletes
    export async function listContactChats(ctx: AppCtx, user: AuthUser, id: string): Promise<ChatListItem[]>;
    export async function listContactNotes(db: Db | Tx, contactId: string): Promise<ContactNoteDto[]>;  // pinned first, newest first
    export async function createContactNote(ctx: AppCtx, user: AuthUser, contactId: string, body: string): Promise<ContactNoteDto>;
    export async function updateContactNote(ctx: AppCtx, contactId: string, noteId: string, patch: { body?: string; pinned?: boolean }): Promise<ContactNoteDto>;
    export async function deleteContactNote(ctx: AppCtx, contactId: string, noteId: string): Promise<void>;
    ```
    Contact search: `q` matches `name ILIKE %q%`, or the phone contains the digits of `q` (with 3 or more digits). From 10 digits up, the digits are first normalized with `normalizePhoneBR`. The list is ordered by `updated_at desc, id desc`. `nextCursor` is opaque (base64url). A change to the name, phone or tags republishes the contact's open chats through `hub.publishChat`, because `ChatListItem` embeds the contact name and `tagIds`.
  - Route registrars, all `(app: FastifyInstance, ctx: AppCtx) => void`: `registerContactRoutes` (`contacts/routes.ts`), `registerSectorRoutes`, `registerTagRoutes`, `registerCustomFieldRoutes`, `registerUserRoutes`, `registerQuickAnswerRoutes`, `registerSettingsRoutes` (`catalog/*.ts`).
  - REST behavior that the web tasks (16, 18, 19) rely on:
    - Every success returns 200 with the DTO, except a hard DELETE, which returns 204 with no body.
    - `DELETE /api/users/:id` **deactivates** the user (soft delete) and returns 200 with the `UserDto` (`active: false`). Resetting a password is `PATCH /api/users/:id {password}`. Both delete the user's sessions and call `hub.disconnectUser`. A change of role or sectors also calls `disconnectUser`, so the client reconnects with fresh visibility.
    - An admin cannot deactivate or demote themselves (400).
    - `PATCH /api/sectors/:id` accepts `isDefault: true` only. Setting another sector as default unsets the previous one in the same transaction.
    - `DELETE /api/sectors/:id` returns 409 for the default sector, a sector with any chat, or a sector used in the triage menu.
    - `GET /api/users` lists every user, inactive ones included, ordered by name. The web hides inactive users where it needs to.
    - Quick answers:
      - **Fields:** POST and PATCH accept JSON or multipart (`name`, `body`, `visibility`, `file`, and on PATCH `removeAttachment`). `visibility` defaults to `owner`; only an admin may set `all` (403 otherwise). `ownerId` is always the creator.
      - **Reading:** the list holds the answers with visibility `all` plus the user's own. Any answer the user cannot see returns 404 on every route.
      - **Editing:** an answer can be edited or deleted by its owner, or by an admin when its visibility is `all`.
      - **Attachment:** the attachment route serves the file through `mediaResponseHeaders`.
    - `PUT /api/settings` validates the triage menu:
      - every `sectorId` must exist (400 otherwise);
      - an enabled menu needs at least one option;
      - option keys must be unique.

      It stores `closing_message` as a jsonb string and `triage_menu` as snake_case jsonb.

---

- [ ] **Step 1: Write the failing table tests for the quick-answer variables**

Create `server/test/messages/quick-answers.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { convertUmblerVariables, renderQuickAnswer, type QuickAnswerVars } from '../../src/messages/quick-answers.js';

const vars: QuickAnswerVars = {
  atendente: { nome: 'Ana Paula Lima', primeiro_nome: 'Ana', email: 'ana@jvo.adv.br' },
  contato: { nome: 'Maria Souza', primeiro_nome: 'Maria', telefone: '5565999991111', email: '' },
  campo: { 'Número do processo': '0001234-56.2026.8.11.0041', CPF: '123.456.789-00' },
};

describe('renderQuickAnswer', () => {
  it.each([
    ['Olá {{contato.primeiro_nome}}!', 'Olá Maria!'],
    ['{{ contato.nome }} / {{contato.telefone}}', 'Maria Souza / 5565999991111'],
    ['Sou {{atendente.nome}} ({{atendente.email}}), {{atendente.primeiro_nome}}', 'Sou Ana Paula Lima (ana@jvo.adv.br), Ana'],
    ['E-mail: [{{contato.email}}]', 'E-mail: []'],
    ['Processo {{campo.Número do processo}}', 'Processo 0001234-56.2026.8.11.0041'],
    ['Processo {{campo.numero_do_processo}}', 'Processo 0001234-56.2026.8.11.0041'],
    ['CPF {{campo.cpf}} / {{ Campo.CPF }}', 'CPF 123.456.789-00 / 123.456.789-00'],
    ['Sem valor: [{{campo.Inexistente}}]', 'Sem valor: []'],
    ['{{Contato.Primeiro_Nome}}', 'Maria'],
    ['CEP: [{{contato.cep}}]', 'CEP: []'],
    ['Literal {{Contexto.x}} e {{1}}', 'Literal {{Contexto.x}} e {{1}}'],
    ['Sem variáveis', 'Sem variáveis'],
  ])('%j renders %j', (body, expected) => {
    expect(renderQuickAnswer(body, vars)).toBe(expected);
  });
});

describe('convertUmblerVariables', () => {
  it.each([
    ['Contato.PrimeiroNome', '{{contato.primeiro_nome}}'],
    ['Contato.NomeCompleto', '{{contato.nome}}'],
    ['Contato.Numero', '{{contato.telefone}}'],
    ['Contato.Email', '{{contato.email}}'],
    ['Atendente.PrimeiroNome', '{{atendente.primeiro_nome}}'],
    ['Atendente.NomeCompleto', '{{atendente.nome}}'],
    ['Atendente.Email', '{{atendente.email}}'],
    ['{{Contact.FirstName}}', '{{contato.primeiro_nome}}'],
    [' contato . primeiro nome ', '{{contato.primeiro_nome}}'],
    ['Campo Personalizado.Número do processo', '{{campo.Número do processo}}'],
  ])('%j becomes %s', (defaultValue, expected) => {
    expect(convertUmblerVariables('Olá {{1}}!', [{ defaultValue }])).toEqual({ body: `Olá ${expected}!`, unmapped: [] });
  });

  it.each([['Contato.CEP'], ['Atendente.Id'], ['Atendente.Numero'], ['Contato.constructor'], ['Texto livre']])(
    '%j has no match: written as text and reported',
    (defaultValue) => {
      expect(convertUmblerVariables('Olá {{1}}!', [{ defaultValue }])).toEqual({
        body: `Olá ${defaultValue}!`,
        unmapped: [defaultValue],
      });
    },
  );

  it('converts several placeholders, reports each unmatched value once and keeps missing ones', () => {
    const variables = [{ defaultValue: 'Contato.PrimeiroNome' }, { defaultValue: 'Contato.CEP' }, { defaultValue: '' }];
    expect(convertUmblerVariables('{{1}}, CEP {{2}} / {{2}} {{3}} {{4}}', variables)).toEqual({
      body: '{{contato.primeiro_nome}}, CEP Contato.CEP / Contato.CEP {{3}} {{4}}',
      unmapped: ['Contato.CEP', '{{3}}', '{{4}}'],
    });
  });

  it('produces bodies that renderQuickAnswer fills', () => {
    const { body } = convertUmblerVariables('Oi {{1}}, sou {{2}}. Processo {{3}}', [
      { defaultValue: 'Contato.PrimeiroNome' },
      { defaultValue: 'Atendente.PrimeiroNome' },
      { defaultValue: 'CampoPersonalizado.Número do processo' },
    ]);
    expect(renderQuickAnswer(body, vars)).toBe('Oi Maria, sou Ana. Processo 0001234-56.2026.8.11.0041');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w server -- test/messages/quick-answers.test.ts`
Expected: FAIL with `Failed to resolve import "../../src/messages/quick-answers.js"`.

- [ ] **Step 3: Implement the variable engine**

Create `server/src/messages/quick-answers.ts`:

```ts
// Spec §5.7: named variables in quick answers, plus conversion of Umbler's positional {{n}}.
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

export function renderQuickAnswer(body: string, vars: QuickAnswerVars): string {
  const groups = new Map<string, Map<string, string>>([
    ['atendente', new Map(Object.entries(vars.atendente))],
    ['contato', new Map(Object.entries(vars.contato))],
    ['campo', new Map(Object.entries(vars.campo).map(([k, v]) => [slug(k), v]))],
  ]);
  return body.replace(NAMED_VAR, (match, group: string, name: string) => {
    const values = groups.get(slug(group));
    // Not one of our groups (e.g. text that merely looks like a variable): leave it.
    return values ? (values.get(slug(name)) ?? '') : match;
  });
}

const ENTITY = new Map([
  ['atendente', 'atendente'],
  ['agente', 'atendente'],
  ['agent', 'atendente'],
  ['member', 'atendente'],
  ['organizationmember', 'atendente'],
  ['contato', 'contato'],
  ['contact', 'contato'],
]);
const ATTR = new Map([
  ['nomecompleto', 'nome'],
  ['nome', 'nome'],
  ['name', 'nome'],
  ['fullname', 'nome'],
  ['primeironome', 'primeiro_nome'],
  ['firstname', 'primeiro_nome'],
  ['email', 'email'],
  ['numero', 'telefone'],
  ['telefone', 'telefone'],
  ['celular', 'telefone'],
  ['phone', 'telefone'],
  ['phonenumber', 'telefone'],
]);
const FIELD_PREFIX = new Set(['campo', 'campos', 'campopersonalizado', 'campospersonalizados', 'customfield', 'customfields']);
const compact = (s: string) => slug(s).replace(/_/g, '');

// ponytail: matches the defaultValue shapes seen in Umbler's UI ("Contato.PrimeiroNome") and API
// ("{{Contact.FirstName}}"). Task 20's report lists anything else, so add shapes when it shows them.
function umblerToNamed(defaultValue: string): string | null {
  const v = defaultValue.trim().replace(/^\{\{\s*|\s*\}\}$/g, '');
  const dot = v.indexOf('.');
  if (dot <= 0) return null;
  const prefix = compact(v.slice(0, dot));
  const rest = v.slice(dot + 1).trim();
  if (!rest) return null;
  if (FIELD_PREFIX.has(prefix)) return `campo.${rest}`;
  const entity = ENTITY.get(prefix);
  const attr = ATTR.get(compact(rest));
  if (!entity || !attr || (attr === 'telefone' && entity !== 'contato')) return null;
  return `${entity}.${attr}`;
}

export function convertUmblerVariables(
  body: string,
  variables: Array<{ defaultValue: string }>,
): { body: string; unmapped: string[] } {
  const unmapped = new Set<string>();
  const out = body.replace(/\{\{\s*(\d+)\s*\}\}/g, (match, n: string) => {
    const dv = variables[Number(n) - 1]?.defaultValue?.trim();
    if (!dv) {
      unmapped.add(match);
      return match;
    }
    const named = umblerToNamed(dv);
    if (named) return `{{${named}}}`;
    unmapped.add(dv);
    return dv;
  });
  return { body: out, unmapped: [...unmapped] };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w server -- test/messages/quick-answers.test.ts`
Expected: PASS (12 render cases, 10 conversion cases, 5 unmatched cases, 2 combined tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/messages/quick-answers.ts server/test/messages/quick-answers.test.ts
git commit -m "feat(messages): named quick-answer variables and Umbler {{n}} conversion

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Write the failing API tests for sectors, tags and custom fields**

Create `server/test/catalog/catalog.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { contacts } from '../../src/db/schema.js';
import { findOrOpenChat } from '../../src/inbox/chats.js';
import { loginAs, makeTestApp, makeTestCtx, seedBasics } from '../helpers.js';

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

let app: FastifyInstance;
let ctx: Awaited<ReturnType<typeof makeTestCtx>>;
let seed: Awaited<ReturnType<typeof seedBasics>>;
let admin: Record<string, string>;
let agent: Record<string, string>;

beforeEach(async () => {
  ctx = await makeTestCtx();
  seed = await seedBasics(ctx);
  ({ app } = await makeTestApp(ctx));
  admin = (await loginAs(app, seed.admin.email)).headers;
  agent = (await loginAs(app, seed.agentA.email)).headers;
});

afterEach(async () => {
  await app.close();
});

function call(method: Method, url: string, headers: Record<string, string>, payload?: object) {
  return app.inject({ method, url, headers, payload });
}

it('rejects catalog writes from agents with 403', async () => {
  const missing = crypto.randomUUID();
  const attempts: Array<[Method, string, object?]> = [
    ['POST', '/api/sectors', { name: 'X' }],
    ['PATCH', `/api/sectors/${seed.sectorA}`, { name: 'X' }],
    ['DELETE', `/api/sectors/${seed.sectorA}`],
    ['POST', '/api/tags', { name: 'X', color: '#000000' }],
    ['PATCH', `/api/tags/${missing}`, { name: 'X' }],
    ['DELETE', `/api/tags/${missing}`],
    ['POST', '/api/custom-fields', { name: 'X', kind: 'text' }],
    ['PATCH', `/api/custom-fields/${missing}`, { name: 'X' }],
    ['DELETE', `/api/custom-fields/${missing}`],
  ];
  for (const [method, url, payload] of attempts) {
    expect((await call(method, url, agent, payload)).statusCode, `${method} ${url}`).toBe(403);
  }
});

describe('sectors', () => {
  it('making a sector the default unsets the previous one', async () => {
    const res = await call('POST', '/api/sectors', admin, { name: 'Recepção', isDefault: true });
    expect(res.statusCode).toBe(200);
    const created = res.json();
    expect(created).toMatchObject({ name: 'Recepção', isDefault: true });

    const defaults = async () =>
      (await call('GET', '/api/sectors', agent))
        .json()
        .filter((s: { isDefault: boolean }) => s.isDefault)
        .map((s: { id: string }) => s.id);
    expect(await defaults()).toEqual([created.id]);

    expect((await call('PATCH', `/api/sectors/${seed.defaultSector}`, admin, { isDefault: true })).statusCode).toBe(200);
    expect(await defaults()).toEqual([seed.defaultSector]);

    expect((await call('PATCH', `/api/sectors/${seed.defaultSector}`, admin, { isDefault: false })).statusCode).toBe(400);
    expect((await call('PATCH', `/api/sectors/${crypto.randomUUID()}`, admin, { isDefault: true })).statusCode).toBe(404);
    expect(await defaults()).toEqual([seed.defaultSector]); // the 404 rolled back the unset

    const renamed = await call('PATCH', `/api/sectors/${seed.sectorA}`, admin, { name: 'Financeiro 2' });
    expect(renamed.json()).toMatchObject({ id: seed.sectorA, name: 'Financeiro 2', isDefault: false });
  });

  it('deletes a sector only when it is not the default and has no chats', async () => {
    const contactId = crypto.randomUUID();
    const now = new Date();
    await ctx.db.insert(contacts).values({ id: contactId, name: 'Maria', phone: '5565999995555', createdAt: now, updatedAt: now });
    await findOrOpenChat(ctx.db, {
      contactId,
      channelId: seed.channelId,
      init: { sectorId: seed.sectorA, ownerId: null, waiting: false, triagePending: false, createdBy: null },
    });

    expect((await call('DELETE', `/api/sectors/${seed.sectorA}`, admin)).statusCode).toBe(409);
    expect((await call('DELETE', `/api/sectors/${seed.defaultSector}`, admin)).statusCode).toBe(409);

    const empty = (await call('POST', '/api/sectors', admin, { name: 'Temporário' })).json();
    expect((await call('DELETE', `/api/sectors/${empty.id}`, admin)).statusCode).toBe(204);
    const ids = (await call('GET', '/api/sectors', admin)).json().map((s: { id: string }) => s.id);
    expect(ids).not.toContain(empty.id);
    expect(ids).toContain(seed.sectorA);
  });
});

describe('tags', () => {
  it('validates name and color, rejects duplicates, updates and deletes', async () => {
    expect((await call('POST', '/api/tags', admin, { name: 'x'.repeat(31), color: '#ff0000' })).statusCode).toBe(400);
    expect((await call('POST', '/api/tags', admin, { name: 'VIP', color: 'red' })).statusCode).toBe(400);

    const res = await call('POST', '/api/tags', admin, { name: 'VIP', emoji: '⭐', color: '#FF0000' });
    expect(res.statusCode).toBe(200);
    const tag = res.json();
    expect(tag).toMatchObject({ name: 'VIP', emoji: '⭐', color: '#ff0000' });
    expect(typeof tag.position).toBe('number');

    expect((await call('POST', '/api/tags', admin, { name: 'VIP', color: '#00ff00' })).statusCode).toBe(409);
    const other = (await call('POST', '/api/tags', admin, { name: 'Novo', color: '#00ff00' })).json();
    expect((await call('PATCH', `/api/tags/${other.id}`, admin, { name: 'VIP' })).statusCode).toBe(409);

    const patched = await call('PATCH', `/api/tags/${tag.id}`, admin, { name: 'VIP Ouro', emoji: null });
    expect(patched.json()).toMatchObject({ id: tag.id, name: 'VIP Ouro', emoji: null, color: '#ff0000' });

    const list = (await call('GET', '/api/tags', agent)).json().map((t: { id: string }) => t.id);
    expect(list).toContain(tag.id);

    expect((await call('DELETE', `/api/tags/${tag.id}`, admin)).statusCode).toBe(204);
    expect((await call('DELETE', `/api/tags/${tag.id}`, admin)).statusCode).toBe(404);
  });
});

describe('custom fields', () => {
  it('creates, lists, renames and deletes fields', async () => {
    const res = await call('POST', '/api/custom-fields', admin, { name: 'CPF', kind: 'cpf' });
    expect(res.statusCode).toBe(200);
    const field = res.json();
    expect(field).toMatchObject({ name: 'CPF', kind: 'cpf' });

    expect((await call('POST', '/api/custom-fields', admin, { name: 'CPF', kind: 'text' })).statusCode).toBe(409);
    expect((await call('POST', '/api/custom-fields', admin, { name: 'E-mail 2', kind: 'email' })).statusCode).toBe(400);

    const renamed = await call('PATCH', `/api/custom-fields/${field.id}`, admin, { name: 'CPF do cliente' });
    expect(renamed.json()).toMatchObject({ id: field.id, name: 'CPF do cliente', kind: 'cpf' });

    const list = (await call('GET', '/api/custom-fields', agent)).json().map((f: { id: string }) => f.id);
    expect(list).toEqual([field.id]);

    expect((await call('DELETE', `/api/custom-fields/${field.id}`, admin)).statusCode).toBe(204);
    expect((await call('GET', '/api/custom-fields', agent)).json()).toEqual([]);
  });
});
```

- [ ] **Step 7: Run the tests to verify they fail**

Run: `npm test -w server -- test/catalog/catalog.test.ts`
Expected: FAIL. The routes are not registered, so requests return 404 (for example `expected 404 to be 403` and `expected 404 to be 200`).

- [ ] **Step 8: Implement sectors, tags and custom-fields routes**

Create `server/src/catalog/sectors.ts`:

```ts
import { and, asc, eq, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SectorDto } from '@talk/shared';
import type { AppCtx } from '../ctx.js';
import { chats, sectors, userSectors } from '../db/schema.js';
import { conflict, forbidden, notFound } from '../lib/http-error.js';
import { getTriageMenu } from '../triage/triage.js';

const IdParams = z.object({ id: z.uuid() });
const name = z.string().trim().min(1).max(60);
const Create = z.object({ name, isDefault: z.boolean().optional() });
// isDefault only accepts true: a sector stops being the default when another one becomes it.
const Patch = z
  .object({ name: name.optional(), position: z.number().int().min(0).optional(), isDefault: z.literal(true).optional() })
  .refine((b) => Object.keys(b).length > 0, { error: 'Nada para alterar' });

const toDto = (s: typeof sectors.$inferSelect): SectorDto => ({
  id: s.id,
  name: s.name,
  position: s.position,
  isDefault: s.isDefault,
});

export function registerSectorRoutes(app: FastifyInstance, ctx: AppCtx): void {
  app.get('/api/sectors', async () => {
    const rows = await ctx.db.select().from(sectors).orderBy(asc(sectors.position), asc(sectors.name));
    return rows.map(toDto);
  });

  app.post('/api/sectors', async (req) => {
    if (req.user.role !== 'admin') throw forbidden();
    const b = Create.parse(req.body);
    const row = await ctx.db.transaction(async (tx) => {
      // Unset first: the partial unique index allows a single is_default = true.
      if (b.isDefault) await tx.update(sectors).set({ isDefault: false }).where(eq(sectors.isDefault, true));
      const [created] = await tx
        .insert(sectors)
        .values({ id: crypto.randomUUID(), name: b.name, position: await tx.$count(sectors), isDefault: b.isDefault ?? false })
        .returning();
      return created;
    });
    return toDto(row);
  });

  app.patch('/api/sectors/:id', async (req) => {
    if (req.user.role !== 'admin') throw forbidden();
    const { id } = IdParams.parse(req.params);
    const b = Patch.parse(req.body);
    const row = await ctx.db.transaction(async (tx) => {
      if (b.isDefault) {
        await tx.update(sectors).set({ isDefault: false }).where(and(eq(sectors.isDefault, true), ne(sectors.id, id)));
      }
      const [updated] = await tx.update(sectors).set(b).where(eq(sectors.id, id)).returning();
      if (!updated) throw notFound('Setor não encontrado'); // also rolls back the unset above
      return updated;
    });
    return toDto(row);
  });

  app.delete('/api/sectors/:id', async (req, reply) => {
    if (req.user.role !== 'admin') throw forbidden();
    const { id } = IdParams.parse(req.params);
    await ctx.db.transaction(async (tx) => {
      const [s] = await tx.select().from(sectors).where(eq(sectors.id, id));
      if (!s) throw notFound('Setor não encontrado');
      if (s.isDefault) throw conflict('O setor padrão não pode ser excluído');
      if (await tx.$count(chats, eq(chats.sectorId, id))) throw conflict('Este setor tem conversas e não pode ser excluído');
      if ((await getTriageMenu(tx)).options.some((o) => o.sectorId === id)) {
        throw conflict('Este setor está no menu de triagem');
      }
      await tx.delete(userSectors).where(eq(userSectors.sectorId, id));
      await tx.delete(sectors).where(eq(sectors.id, id));
    });
    return reply.code(204).send();
  });
}
```

Create `server/src/catalog/tags.ts`:

```ts
import { and, asc, eq, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { TagDto } from '@talk/shared';
import type { AppCtx } from '../ctx.js';
import { contactTags, tags } from '../db/schema.js';
import { conflict, forbidden, notFound } from '../lib/http-error.js';

const IdParams = z.object({ id: z.uuid() });
const fields = {
  name: z.string().trim().min(1).max(30),
  emoji: z.string().trim().max(16).nullable().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, { error: 'Cor inválida' }),
  position: z.number().int().min(0).optional(),
};
const Create = z.object(fields);
const Patch = z
  .object(fields)
  .partial()
  .refine((b) => Object.keys(b).length > 0, { error: 'Nada para alterar' });

const toDto = (t: typeof tags.$inferSelect): TagDto => ({
  id: t.id,
  name: t.name,
  emoji: t.emoji,
  color: t.color,
  position: t.position,
});

export function registerTagRoutes(app: FastifyInstance, ctx: AppCtx): void {
  app.get('/api/tags', async () => {
    const rows = await ctx.db.select().from(tags).orderBy(asc(tags.position), asc(tags.name));
    return rows.map(toDto);
  });

  app.post('/api/tags', async (req) => {
    if (req.user.role !== 'admin') throw forbidden();
    const b = Create.parse(req.body);
    const [row] = await ctx.db
      .insert(tags)
      .values({
        id: crypto.randomUUID(),
        name: b.name,
        emoji: b.emoji || null,
        color: b.color.toLowerCase(),
        position: b.position ?? (await ctx.db.$count(tags)),
      })
      .onConflictDoNothing()
      .returning();
    if (!row) throw conflict('Já existe uma etiqueta com este nome');
    return toDto(row);
  });

  app.patch('/api/tags/:id', async (req) => {
    if (req.user.role !== 'admin') throw forbidden();
    const { id } = IdParams.parse(req.params);
    const b = Patch.parse(req.body);
    if (b.name && (await ctx.db.$count(tags, and(eq(tags.name, b.name), ne(tags.id, id))))) {
      throw conflict('Já existe uma etiqueta com este nome');
    }
    const [row] = await ctx.db
      .update(tags)
      .set({
        name: b.name,
        emoji: b.emoji === undefined ? undefined : b.emoji || null,
        color: b.color?.toLowerCase(),
        position: b.position,
      })
      .where(eq(tags.id, id))
      .returning();
    if (!row) throw notFound('Etiqueta não encontrada');
    return toDto(row);
  });

  app.delete('/api/tags/:id', async (req, reply) => {
    if (req.user.role !== 'admin') throw forbidden();
    const { id } = IdParams.parse(req.params);
    const deleted = await ctx.db.transaction(async (tx) => {
      await tx.delete(contactTags).where(eq(contactTags.tagId, id));
      return tx.delete(tags).where(eq(tags.id, id)).returning({ id: tags.id });
    });
    if (deleted.length === 0) throw notFound('Etiqueta não encontrada');
    return reply.code(204).send();
  });
}
```

Create `server/src/catalog/custom-fields.ts`:

```ts
import { and, asc, eq, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CustomFieldDto } from '@talk/shared';
import type { AppCtx } from '../ctx.js';
import { contactFieldValues, customFields } from '../db/schema.js';
import { conflict, forbidden, notFound } from '../lib/http-error.js';

const IdParams = z.object({ id: z.uuid() });
const fields = {
  name: z.string().trim().min(1).max(60),
  kind: z.enum(['text', 'number', 'date', 'cpf', 'cnpj']),
  position: z.number().int().min(0).optional(),
};
const Create = z.object(fields);
const Patch = z
  .object(fields)
  .partial()
  .refine((b) => Object.keys(b).length > 0, { error: 'Nada para alterar' });

const toDto = (f: typeof customFields.$inferSelect): CustomFieldDto => ({
  id: f.id,
  name: f.name,
  kind: f.kind,
  position: f.position,
});

export function registerCustomFieldRoutes(app: FastifyInstance, ctx: AppCtx): void {
  app.get('/api/custom-fields', async () => {
    const rows = await ctx.db.select().from(customFields).orderBy(asc(customFields.position), asc(customFields.name));
    return rows.map(toDto);
  });

  app.post('/api/custom-fields', async (req) => {
    if (req.user.role !== 'admin') throw forbidden();
    const b = Create.parse(req.body);
    const [row] = await ctx.db
      .insert(customFields)
      .values({ id: crypto.randomUUID(), name: b.name, kind: b.kind, position: b.position ?? (await ctx.db.$count(customFields)) })
      .onConflictDoNothing()
      .returning();
    if (!row) throw conflict('Já existe um campo com este nome');
    return toDto(row);
  });

  app.patch('/api/custom-fields/:id', async (req) => {
    if (req.user.role !== 'admin') throw forbidden();
    const { id } = IdParams.parse(req.params);
    const b = Patch.parse(req.body);
    if (b.name && (await ctx.db.$count(customFields, and(eq(customFields.name, b.name), ne(customFields.id, id))))) {
      throw conflict('Já existe um campo com este nome');
    }
    // ponytail: renaming a field breaks {{campo.<old name>}} in quick answers; the render just yields ''.
    const [row] = await ctx.db.update(customFields).set(b).where(eq(customFields.id, id)).returning();
    if (!row) throw notFound('Campo não encontrado');
    return toDto(row);
  });

  app.delete('/api/custom-fields/:id', async (req, reply) => {
    if (req.user.role !== 'admin') throw forbidden();
    const { id } = IdParams.parse(req.params);
    const deleted = await ctx.db.transaction(async (tx) => {
      await tx.delete(contactFieldValues).where(eq(contactFieldValues.fieldId, id));
      return tx.delete(customFields).where(eq(customFields.id, id)).returning({ id: customFields.id });
    });
    if (deleted.length === 0) throw notFound('Campo não encontrado');
    return reply.code(204).send();
  });
}
```

Modify `server/src/app.ts`. Add these imports next to the other route imports:

```ts
import { registerCustomFieldRoutes } from './catalog/custom-fields.js';
import { registerSectorRoutes } from './catalog/sectors.js';
import { registerTagRoutes } from './catalog/tags.js';
```

Inside `buildApp`, add these calls immediately before the final `return app;`, after the auth plugin and the other routes are registered:

```ts
  registerSectorRoutes(app, ctx);
  registerTagRoutes(app, ctx);
  registerCustomFieldRoutes(app, ctx);
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npm test -w server -- test/catalog/catalog.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 10: Commit**

```bash
git add server/src/catalog/sectors.ts server/src/catalog/tags.ts server/src/catalog/custom-fields.ts server/src/app.ts server/test/catalog/catalog.test.ts
git commit -m "feat(catalog): sectors, tags and custom fields API

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 11: Write the failing contacts API tests**

Create `server/test/contacts/contacts.test.ts`:

```ts
import { afterEach, beforeEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { chats, contacts } from '../../src/db/schema.js';
import { findOrOpenChat } from '../../src/inbox/chats.js';
import { loginAs, makeTestApp, makeTestCtx, seedBasics } from '../helpers.js';

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

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

async function createContact(payload: object) {
  const res = await call('POST', '/api/contacts', agentA, payload);
  expect(res.statusCode).toBe(200);
  return res.json();
}

const ids = (items: Array<{ id: string }>) => items.map((i) => i.id);

it('creates a contact with a normalized phone and rejects duplicates and invalid phones', async () => {
  const c = await createContact({ name: 'Maria Souza', phone: '556599991111' }); // 12 digits, gains the 9
  expect(c).toMatchObject({ name: 'Maria Souza', phone: '5565999991111', blocked: false, tagIds: [], fields: {} });

  expect((await call('POST', '/api/contacts', agentA, { phone: '+55 (65) 99999-1111' })).statusCode).toBe(409);
  expect((await call('POST', '/api/contacts', agentA, { phone: 'abc' })).statusCode).toBe(400);

  const got = await call('GET', `/api/contacts/${c.id}`, agentB);
  expect(got.json()).toEqual(c);
  expect((await call('GET', `/api/contacts/${crypto.randomUUID()}`, agentA)).statusCode).toBe(404);

  const other = await createContact({ name: 'Outro', phone: '5565999992222' });
  expect((await call('PATCH', `/api/contacts/${other.id}`, agentA, { phone: '65 99999-1111' })).statusCode).toBe(409);
  const patched = await call('PATCH', `/api/contacts/${c.id}`, agentA, {
    email: 'maria@example.com',
    landline: '6532221111',
    address: { cidade: 'Cuiabá', uf: 'MT' },
  });
  expect(patched.json()).toMatchObject({
    phone: '5565999991111',
    email: 'maria@example.com',
    landline: '6532221111',
    address: { cidade: 'Cuiabá', uf: 'MT' },
  });
});

it('searches by name or phone, filters by tag and paginates by most recently updated', async () => {
  const a = await createContact({ name: 'Ana Lima', phone: '5565999990001' });
  const b = await createContact({ name: 'Bruno Lima', phone: '5565999990002' });
  const c = await createContact({ name: 'Carla Dias', phone: '556532221111' });
  const tag = (await call('POST', '/api/tags', admin, { name: 'Cliente', color: '#22c55e' })).json();
  for (const x of [a, b, c]) {
    expect((await call('PUT', `/api/contacts/${x.id}/tags`, agentA, { tagIds: [tag.id] })).statusCode).toBe(200);
  }
  // Deterministic order: a (newest), c, b (oldest).
  const at = (id: string, iso: string) => ctx.db.update(contacts).set({ updatedAt: new Date(iso) }).where(eq(contacts.id, id));
  await at(b.id, '2026-01-01T00:00:01.000Z');
  await at(c.id, '2026-01-01T00:00:02.000Z');
  await at(a.id, '2026-01-01T00:00:03.000Z');

  expect(ids((await call('GET', '/api/contacts?q=lima', agentA)).json().items)).toEqual([a.id, b.id]);
  const byPhone = await call('GET', `/api/contacts?q=${encodeURIComponent('(65) 99999-0002')}`, agentA);
  expect(ids(byPhone.json().items)).toEqual([b.id]);
  expect(ids((await call('GET', '/api/contacts?q=3222', agentA)).json().items)).toEqual([c.id]);

  const page1 = (await call('GET', `/api/contacts?tagId=${tag.id}&limit=2`, agentA)).json();
  expect(ids(page1.items)).toEqual([a.id, c.id]);
  expect(page1.nextCursor).toEqual(expect.any(String));
  const page2 = (await call('GET', `/api/contacts?tagId=${tag.id}&limit=2&cursor=${page1.nextCursor}`, agentA)).json();
  expect(ids(page2.items)).toEqual([b.id]);
  expect(page2.nextCursor).toBeNull();

  expect((await call('GET', '/api/contacts?cursor=lixo', agentA)).statusCode).toBe(400);
});

it('sets tags, custom fields and the blocked flag', async () => {
  const c = await createContact({ name: 'João', phone: '5565999993333' });
  const field = (await call('POST', '/api/custom-fields', admin, { name: 'CPF', kind: 'cpf' })).json();
  const tag = (await call('POST', '/api/tags', admin, { name: 'VIP', color: '#ff0000' })).json();

  expect((await call('PUT', `/api/contacts/${c.id}/tags`, agentA, { tagIds: [tag.id] })).json().tagIds).toEqual([tag.id]);
  expect((await call('PUT', `/api/contacts/${c.id}/tags`, agentA, { tagIds: [crypto.randomUUID()] })).statusCode).toBe(400);

  const withField = await call('PUT', `/api/contacts/${c.id}/fields`, agentA, { [field.id]: '123.456.789-00' });
  expect(withField.json().fields).toEqual({ [field.id]: '123.456.789-00' });
  const cleared = await call('PUT', `/api/contacts/${c.id}/fields`, agentA, { [field.id]: '' });
  expect(cleared.json().fields).toEqual({});
  expect((await call('PUT', `/api/contacts/${c.id}/fields`, agentA, { [crypto.randomUUID()]: 'x' })).statusCode).toBe(400);

  expect((await call('POST', `/api/contacts/${c.id}/block`, agentA, { blocked: true })).json().blocked).toBe(true);
  expect((await call('POST', `/api/contacts/${c.id}/block`, agentA, { blocked: false })).json().blocked).toBe(false);
});

it('creates, pins, edits and deletes notes', async () => {
  const c = await createContact({ name: 'Rita', phone: '5565999994444' });
  const n1 = (await call('POST', `/api/contacts/${c.id}/notes`, agentA, { body: 'Primeira' })).json();
  expect(n1).toMatchObject({ body: 'Primeira', pinned: false, authorName: seed.agentA.name });
  const n2 = (await call('POST', `/api/contacts/${c.id}/notes`, agentB, { body: 'Segunda' })).json();

  expect((await call('PATCH', `/api/contacts/${c.id}/notes/${n1.id}`, agentA, { pinned: true })).json().pinned).toBe(true);
  expect(ids((await call('GET', `/api/contacts/${c.id}/notes`, agentA)).json())).toEqual([n1.id, n2.id]);

  const edited = await call('PATCH', `/api/contacts/${c.id}/notes/${n2.id}`, agentA, { body: 'Editada' });
  expect(edited.json()).toMatchObject({ id: n2.id, body: 'Editada', authorName: seed.agentB.name });
  expect((await call('PATCH', `/api/contacts/${c.id}/notes/${n2.id}`, agentA, {})).statusCode).toBe(400);

  expect((await call('DELETE', `/api/contacts/${c.id}/notes/${n1.id}`, agentA)).statusCode).toBe(204);
  expect(ids((await call('GET', `/api/contacts/${c.id}/notes`, agentA)).json())).toEqual([n2.id]);
  expect((await call('DELETE', `/api/contacts/${c.id}/notes/${n1.id}`, agentA)).statusCode).toBe(404);
});

it('contact history lists only the chats the user can see', async () => {
  const c = await createContact({ name: 'Paulo', phone: '5565999995555' });
  const init = (sectorId: string) => ({ sectorId, ownerId: null, waiting: false, triagePending: false, createdBy: null });
  const { chat: inB } = await findOrOpenChat(ctx.db, { contactId: c.id, channelId: seed.channelId, init: init(seed.sectorB) });
  await ctx.db.update(chats).set({ state: 'closed', closedAt: new Date() }).where(eq(chats.id, inB.id));
  const { chat: inA } = await findOrOpenChat(ctx.db, { contactId: c.id, channelId: seed.channelId, init: init(seed.sectorA) });

  const history = async (headers: Record<string, string>) => {
    const res = await call('GET', `/api/contacts/${c.id}/chats`, headers);
    expect(res.statusCode).toBe(200);
    return ids(res.json()).sort();
  };
  expect(await history(agentA)).toEqual([inA.id]);
  expect(await history(agentB)).toEqual([inB.id]);
  expect(await history(admin)).toEqual([inA.id, inB.id].sort());
  expect((await call('GET', `/api/contacts/${crypto.randomUUID()}/chats`, agentA)).statusCode).toBe(404);
});
```

- [ ] **Step 12: Run the tests to verify they fail**

Run: `npm test -w server -- test/contacts/contacts.test.ts`
Expected: FAIL. `/api/contacts` is not registered, so the first assertion fails with `expected 404 to be 200`.

- [ ] **Step 13: Implement the contacts service and routes**

Create `server/src/contacts/service.ts`:

```ts
import { and, desc, eq, ilike, inArray, like, ne, or, sql, type SQL } from 'drizzle-orm';
import type { ChatListItem, ContactDto, ContactNoteDto } from '@talk/shared';
import type { AppCtx } from '../ctx.js';
import type { Db } from '../db/client.js';
import { chats, contactFieldValues, contactNotes, contactTags, contacts, customFields, tags, users } from '../db/schema.js';
import { toChatListItem } from '../inbox/queries.js';
import { visibleChatsWhere, type AuthUser } from '../inbox/visibility.js';
import { badRequest, conflict, notFound } from '../lib/http-error.js';
import { normalizePhoneBR } from '../whatsapp/phone.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type ContactRow = typeof contacts.$inferSelect;

export interface ContactInput {
  name?: string | null;
  phone?: string;
  email?: string | null;
  landline?: string | null;
  address?: Record<string, string> | null;
}
export interface ContactListQuery { q?: string; tagId?: string; cursor?: string; limit?: number }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanPhone(raw: string): string {
  const phone = normalizePhoneBR(raw);
  if (!/^\d{10,15}$/.test(phone)) throw badRequest('Telefone inválido');
  return phone;
}

export async function toContactDtos(db: Db | Tx, rows: ContactRow[]): Promise<ContactDto[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const tagRows = await db.select().from(contactTags).where(inArray(contactTags.contactId, ids));
  const fieldRows = await db.select().from(contactFieldValues).where(inArray(contactFieldValues.contactId, ids));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    phone: r.phone,
    lid: r.lid,
    email: r.email,
    landline: r.landline,
    address: (r.address as Record<string, string> | null) ?? null,
    blocked: r.blocked,
    tagIds: tagRows.filter((t) => t.contactId === r.id).map((t) => t.tagId),
    fields: Object.fromEntries(fieldRows.filter((f) => f.contactId === r.id).map((f) => [f.fieldId, f.value])),
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function getContact(db: Db | Tx, id: string): Promise<ContactDto> {
  const [row] = await db.select().from(contacts).where(eq(contacts.id, id));
  if (!row) throw notFound('Contato não encontrado');
  const [dto] = await toContactDtos(db, [row]);
  return dto;
}

// Postgres keeps microseconds but the cursor carries a JS Date (milliseconds): order and
// compare on the truncated value so pages never skip or repeat rows.
const updatedMs = sql`date_trunc('milliseconds', ${contacts.updatedAt})`;

export async function listContacts(db: Db, f: ContactListQuery): Promise<{ items: ContactDto[]; nextCursor: string | null }> {
  const limit = f.limit ?? 50;
  const where: Array<SQL | undefined> = [];
  const q = f.q?.trim();
  if (q) {
    const byName = ilike(contacts.name, `%${q.replace(/[\\%_]/g, '\\$&')}%`);
    const digits = q.replace(/\D/g, '');
    // ponytail: "contains" on the normalized number covers prefix search and partial typing like "99999-0002".
    const phone = digits.length >= 10 ? normalizePhoneBR(digits) : digits;
    where.push(digits.length >= 3 ? or(byName, like(contacts.phone, `%${phone}%`)) : byName);
  }
  if (f.tagId) {
    where.push(
      inArray(contacts.id, db.select({ id: contactTags.contactId }).from(contactTags).where(eq(contactTags.tagId, f.tagId))),
    );
  }
  if (f.cursor) {
    const [iso, id] = Buffer.from(f.cursor, 'base64url').toString().split('|');
    if (!iso || !id || !UUID.test(id) || Number.isNaN(Date.parse(iso))) throw badRequest('Cursor inválido');
    where.push(sql`(${updatedMs}, ${contacts.id}) < (${iso}::timestamptz, ${id}::uuid)`);
  }
  const rows = await db
    .select()
    .from(contacts)
    .where(and(...where))
    .orderBy(desc(updatedMs), desc(contacts.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: await toContactDtos(db, page),
    nextCursor:
      rows.length > limit && last ? Buffer.from(`${last.updatedAt.toISOString()}|${last.id}`).toString('base64url') : null,
  };
}

// Bumps updated_at (list order) and applies `extra`; 404 when the contact does not exist.
async function touch(db: Db | Tx, id: string, extra: Partial<typeof contacts.$inferInsert> = {}): Promise<void> {
  const [row] = await db
    .update(contacts)
    .set({ ...extra, updatedAt: new Date() })
    .where(eq(contacts.id, id))
    .returning({ id: contacts.id });
  if (!row) throw notFound('Contato não encontrado');
}

// ChatListItem embeds the contact name and tagIds, so open chats are re-sent to the inboxes.
async function publishOpenChats(ctx: AppCtx, contactId: string): Promise<void> {
  const open = await ctx.db
    .select({ id: chats.id })
    .from(chats)
    .where(and(eq(chats.contactId, contactId), eq(chats.state, 'open')));
  for (const c of open) await ctx.hub.publishChat(c.id);
}

export async function createContact(ctx: AppCtx, input: ContactInput & { phone: string }): Promise<ContactDto> {
  const now = new Date();
  const [row] = await ctx.db
    .insert(contacts)
    .values({
      id: crypto.randomUUID(),
      name: input.name ?? null,
      phone: cleanPhone(input.phone),
      email: input.email ?? null,
      landline: input.landline ?? null,
      address: input.address ?? null,
      blocked: false,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) throw conflict('Já existe um contato com este telefone');
  const [dto] = await toContactDtos(ctx.db, [row]);
  return dto;
}

export async function updateContact(ctx: AppCtx, id: string, p: ContactInput): Promise<ContactDto> {
  const phone = p.phone === undefined ? undefined : cleanPhone(p.phone);
  if (phone && (await ctx.db.$count(contacts, and(eq(contacts.phone, phone), ne(contacts.id, id))))) {
    throw conflict('Já existe um contato com este telefone');
  }
  await touch(ctx.db, id, { name: p.name, phone, email: p.email, landline: p.landline, address: p.address });
  await publishOpenChats(ctx, id);
  return getContact(ctx.db, id);
}

export async function setContactBlocked(ctx: AppCtx, id: string, blocked: boolean): Promise<ContactDto> {
  await touch(ctx.db, id, { blocked });
  return getContact(ctx.db, id);
}

export async function setContactTags(ctx: AppCtx, id: string, tagIds: string[]): Promise<ContactDto> {
  const unique = [...new Set(tagIds)];
  await ctx.db.transaction(async (tx) => {
    await touch(tx, id);
    if (unique.length && (await tx.$count(tags, inArray(tags.id, unique))) !== unique.length) {
      throw badRequest('Etiqueta inexistente');
    }
    await tx.delete(contactTags).where(eq(contactTags.contactId, id));
    if (unique.length) await tx.insert(contactTags).values(unique.map((tagId) => ({ contactId: id, tagId })));
  });
  await publishOpenChats(ctx, id);
  return getContact(ctx.db, id);
}

// Merge semantics: only the given fields change; an empty value removes the field.
// ponytail: values are free text; kind-specific validation (cpf/cnpj/date) is left to the UI mask.
export async function setContactFields(ctx: AppCtx, id: string, values: Record<string, string>): Promise<ContactDto> {
  const fieldIds = Object.keys(values);
  await ctx.db.transaction(async (tx) => {
    await touch(tx, id);
    if (fieldIds.length && (await tx.$count(customFields, inArray(customFields.id, fieldIds))) !== fieldIds.length) {
      throw badRequest('Campo inexistente');
    }
    for (const [fieldId, raw] of Object.entries(values)) {
      const value = raw.trim();
      if (!value) {
        await tx
          .delete(contactFieldValues)
          .where(and(eq(contactFieldValues.contactId, id), eq(contactFieldValues.fieldId, fieldId)));
      } else {
        await tx
          .insert(contactFieldValues)
          .values({ contactId: id, fieldId, value })
          .onConflictDoUpdate({ target: [contactFieldValues.contactId, contactFieldValues.fieldId], set: { value } });
      }
    }
  });
  return getContact(ctx.db, id);
}

export async function listContactChats(ctx: AppCtx, user: AuthUser, id: string): Promise<ChatListItem[]> {
  if (!(await ctx.db.$count(contacts, eq(contacts.id, id)))) throw notFound('Contato não encontrado');
  // Spec §6: the history hides chats the user cannot see (same rule as the inbox).
  const rows = await ctx.db
    .select()
    .from(chats)
    .where(and(eq(chats.contactId, id), visibleChatsWhere(user)))
    .orderBy(desc(chats.createdAt));
  return Promise.all(rows.map((chat) => toChatListItem(ctx.db, chat, user.id)));
}

const noteColumns = {
  id: contactNotes.id,
  body: contactNotes.body,
  pinned: contactNotes.pinned,
  authorName: users.name,
  createdAt: contactNotes.createdAt,
};

function noteQuery(db: Db | Tx, where: SQL | undefined) {
  return db
    .select(noteColumns)
    .from(contactNotes)
    .leftJoin(users, eq(users.id, contactNotes.authorId))
    .where(where)
    .orderBy(desc(contactNotes.pinned), desc(contactNotes.createdAt));
}

const toNoteDto = (r: { id: string; body: string; pinned: boolean; authorName: string | null; createdAt: Date }): ContactNoteDto => ({
  ...r,
  createdAt: r.createdAt.toISOString(),
});

export async function listContactNotes(db: Db | Tx, contactId: string): Promise<ContactNoteDto[]> {
  return (await noteQuery(db, eq(contactNotes.contactId, contactId))).map(toNoteDto);
}

async function getNote(db: Db | Tx, contactId: string, noteId: string): Promise<ContactNoteDto> {
  const [row] = await noteQuery(db, and(eq(contactNotes.contactId, contactId), eq(contactNotes.id, noteId)));
  if (!row) throw notFound('Observação não encontrada');
  return toNoteDto(row);
}

export async function createContactNote(ctx: AppCtx, user: AuthUser, contactId: string, body: string): Promise<ContactNoteDto> {
  if (!(await ctx.db.$count(contacts, eq(contacts.id, contactId)))) throw notFound('Contato não encontrado');
  const id = crypto.randomUUID();
  await ctx.db.insert(contactNotes).values({ id, contactId, authorId: user.id, body, pinned: false, createdAt: new Date() });
  return getNote(ctx.db, contactId, id);
}

// ponytail: any user may edit/pin/delete any note (spec has no note ownership rule); add an author check if asked.
export async function updateContactNote(
  ctx: AppCtx,
  contactId: string,
  noteId: string,
  patch: { body?: string; pinned?: boolean },
): Promise<ContactNoteDto> {
  const [row] = await ctx.db
    .update(contactNotes)
    .set(patch)
    .where(and(eq(contactNotes.id, noteId), eq(contactNotes.contactId, contactId)))
    .returning({ id: contactNotes.id });
  if (!row) throw notFound('Observação não encontrada');
  return getNote(ctx.db, contactId, noteId);
}

export async function deleteContactNote(ctx: AppCtx, contactId: string, noteId: string): Promise<void> {
  const deleted = await ctx.db
    .delete(contactNotes)
    .where(and(eq(contactNotes.id, noteId), eq(contactNotes.contactId, contactId)))
    .returning({ id: contactNotes.id });
  if (deleted.length === 0) throw notFound('Observação não encontrada');
}
```

Create `server/src/contacts/routes.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppCtx } from '../ctx.js';
import {
  createContact,
  createContactNote,
  deleteContactNote,
  getContact,
  listContactChats,
  listContactNotes,
  listContacts,
  setContactBlocked,
  setContactFields,
  setContactTags,
  updateContact,
  updateContactNote,
} from './service.js';

const IdParams = z.object({ id: z.uuid() });
const NoteParams = z.object({ id: z.uuid(), noteId: z.uuid() });

// Absent stays undefined (PATCH leaves it alone); '' becomes null (clears it).
const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === undefined ? undefined : v || null));

const contactFields = {
  name: optText(120),
  email: optText(200),
  landline: optText(30),
  address: z.record(z.string(), z.string().max(200)).nullable().optional(),
};
const CreateBody = z.object({ ...contactFields, phone: z.string().min(1).max(40) });
const PatchBody = z.object({ ...contactFields, phone: z.string().min(1).max(40).optional() });
const ListQuery = z.object({
  q: z.string().max(100).optional(),
  tagId: z.uuid().optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
const BlockBody = z.object({ blocked: z.boolean() });
const TagsBody = z.object({ tagIds: z.array(z.uuid()).max(50) });
const FieldsBody = z.record(z.uuid(), z.string().max(500));
const NoteBody = z.object({ body: z.string().trim().min(1).max(5000) });
const NotePatch = z
  .object({ body: z.string().trim().min(1).max(5000).optional(), pinned: z.boolean().optional() })
  .refine((p) => p.body !== undefined || p.pinned !== undefined, { error: 'Nada para alterar' });

export function registerContactRoutes(app: FastifyInstance, ctx: AppCtx): void {
  app.get('/api/contacts', async (req) => listContacts(ctx.db, ListQuery.parse(req.query)));

  app.post('/api/contacts', async (req) => createContact(ctx, CreateBody.parse(req.body)));

  app.get('/api/contacts/:id', async (req) => getContact(ctx.db, IdParams.parse(req.params).id));

  app.patch('/api/contacts/:id', async (req) => updateContact(ctx, IdParams.parse(req.params).id, PatchBody.parse(req.body)));

  app.post('/api/contacts/:id/block', async (req) =>
    setContactBlocked(ctx, IdParams.parse(req.params).id, BlockBody.parse(req.body).blocked),
  );

  app.put('/api/contacts/:id/tags', async (req) =>
    setContactTags(ctx, IdParams.parse(req.params).id, TagsBody.parse(req.body).tagIds),
  );

  app.put('/api/contacts/:id/fields', async (req) =>
    setContactFields(ctx, IdParams.parse(req.params).id, FieldsBody.parse(req.body)),
  );

  app.get('/api/contacts/:id/chats', async (req) => listContactChats(ctx, req.user, IdParams.parse(req.params).id));

  app.get('/api/contacts/:id/notes', async (req) => listContactNotes(ctx.db, IdParams.parse(req.params).id));

  app.post('/api/contacts/:id/notes', async (req) =>
    createContactNote(ctx, req.user, IdParams.parse(req.params).id, NoteBody.parse(req.body).body),
  );

  app.patch('/api/contacts/:id/notes/:noteId', async (req) => {
    const { id, noteId } = NoteParams.parse(req.params);
    return updateContactNote(ctx, id, noteId, NotePatch.parse(req.body));
  });

  app.delete('/api/contacts/:id/notes/:noteId', async (req, reply) => {
    const { id, noteId } = NoteParams.parse(req.params);
    await deleteContactNote(ctx, id, noteId);
    return reply.code(204).send();
  });
}
```

Modify `server/src/app.ts`. Add this import:

```ts
import { registerContactRoutes } from './contacts/routes.js';
```

Add this call after `registerCustomFieldRoutes(app, ctx);`:

```ts
  registerContactRoutes(app, ctx);
```

- [ ] **Step 14: Run the tests to verify they pass**

Run: `npm test -w server -- test/contacts/contacts.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 15: Commit**

```bash
git add server/src/contacts/service.ts server/src/contacts/routes.ts server/src/app.ts server/test/contacts/contacts.test.ts
git commit -m "feat(contacts): contacts API with search, tags, fields, notes and visible history

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 16: Write the failing users API tests**

Create `server/test/catalog/users.test.ts`:

```ts
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loginAs, makeTestApp, makeTestCtx, seedBasics, TEST_ORIGIN } from '../helpers.js';

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

let app: FastifyInstance;
let ctx: Awaited<ReturnType<typeof makeTestCtx>>;
let seed: Awaited<ReturnType<typeof seedBasics>>;
let admin: Record<string, string>;
let agent: Record<string, string>;

beforeEach(async () => {
  ctx = await makeTestCtx();
  seed = await seedBasics(ctx);
  ({ app } = await makeTestApp(ctx));
  admin = (await loginAs(app, seed.admin.email)).headers;
  agent = (await loginAs(app, seed.agentA.email)).headers;
});

afterEach(async () => {
  await app.close();
});

function call(method: Method, url: string, headers: Record<string, string>, payload?: object) {
  return app.inject({ method, url, headers, payload });
}

function login(email: string, password: string) {
  return app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: TEST_ORIGIN }, payload: { email, password } });
}

it('lets any user list users but only admins change them', async () => {
  const list = await call('GET', '/api/users', agent);
  expect(list.statusCode).toBe(200);
  expect(list.json().map((u: { id: string }) => u.id)).toContain(seed.agentB.id);
  expect(list.json()[0]).not.toHaveProperty('passwordHash');

  const attempts: Array<[Method, string, object?]> = [
    ['POST', '/api/users', { name: 'X', email: 'x@example.com', password: 'senha-forte-1' }],
    ['PATCH', `/api/users/${seed.agentB.id}`, { name: 'X' }],
    ['DELETE', `/api/users/${seed.agentB.id}`],
  ];
  for (const [method, url, payload] of attempts) {
    expect((await call(method, url, agent, payload)).statusCode, `${method} ${url}`).toBe(403);
  }
});

it('creates a user who can log in, with sectors', async () => {
  const res = await call('POST', '/api/users', admin, {
    name: 'Carlos Pereira',
    email: ' Carlos@Example.com ',
    password: 'nova-senha-123',
    sectorIds: [seed.sectorA],
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({
    name: 'Carlos Pereira',
    email: 'carlos@example.com',
    role: 'agent',
    signature: null,
    active: true,
    sectorIds: [seed.sectorA],
  });
  expect(res.json()).not.toHaveProperty('passwordHash');
  expect((await login('carlos@example.com', 'nova-senha-123')).statusCode).toBe(200);

  const dup = await call('POST', '/api/users', admin, { name: 'Outro', email: 'carlos@example.com', password: 'outra-senha-1' });
  expect(dup.statusCode).toBe(409);
  const badSector = await call('POST', '/api/users', admin, {
    name: 'Outro',
    email: 'outro@example.com',
    password: 'outra-senha-1',
    sectorIds: [crypto.randomUUID()],
  });
  expect(badSector.statusCode).toBe(400);
  expect((await call('POST', '/api/users', admin, { name: 'Curta', email: 'c@example.com', password: '123' })).statusCode).toBe(400);
});

it('updates sectors and signature and drops live sockets on visibility changes', async () => {
  const spy = vi.spyOn(ctx.hub, 'disconnectUser');
  const res = await call('PATCH', `/api/users/${seed.agentA.id}`, admin, { sectorIds: [seed.sectorB], signature: 'Dra. Ana' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ sectorIds: [seed.sectorB], signature: 'Dra. Ana' });
  expect(spy).toHaveBeenCalledWith(seed.agentA.id);
  // Sessions survive a sector change.
  expect((await call('GET', '/api/auth/me', agent)).statusCode).toBe(200);
});

it('deactivating a user kills their sessions and live sockets', async () => {
  const spy = vi.spyOn(ctx.hub, 'disconnectUser');
  expect((await call('GET', '/api/auth/me', agent)).statusCode).toBe(200);

  const res = await call('DELETE', `/api/users/${seed.agentA.id}`, admin);
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ id: seed.agentA.id, active: false });

  expect((await call('GET', '/api/auth/me', agent)).statusCode).toBe(401);
  expect(spy).toHaveBeenCalledWith(seed.agentA.id);
  expect((await login(seed.agentA.email, 'senha-teste-123')).statusCode).not.toBe(200);
});

it('resetting a password kills the sessions and the new password works', async () => {
  const spy = vi.spyOn(ctx.hub, 'disconnectUser');
  const res = await call('PATCH', `/api/users/${seed.agentA.id}`, admin, { password: 'outra-senha-456' });
  expect(res.statusCode).toBe(200);
  expect((await call('GET', '/api/auth/me', agent)).statusCode).toBe(401);
  expect(spy).toHaveBeenCalledWith(seed.agentA.id);
  expect((await login(seed.agentA.email, 'outra-senha-456')).statusCode).toBe(200);
});

it('an admin cannot deactivate or demote themselves', async () => {
  expect((await call('DELETE', `/api/users/${seed.admin.id}`, admin)).statusCode).toBe(400);
  expect((await call('PATCH', `/api/users/${seed.admin.id}`, admin, { role: 'agent' })).statusCode).toBe(400);
  expect((await call('PATCH', `/api/users/${crypto.randomUUID()}`, admin, { name: 'X' })).statusCode).toBe(404);
});
```

- [ ] **Step 17: Run the tests to verify they fail**

Run: `npm test -w server -- test/catalog/users.test.ts`
Expected: FAIL. `/api/users` is not registered (`expected 404 to be 200`).

- [ ] **Step 18: Implement the users routes**

Create `server/src/catalog/users.ts`:

```ts
import { and, asc, eq, inArray, ne, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { UserDto } from '@talk/shared';
import { hashPassword } from '../auth/password.js';
import { deleteUserSessions } from '../auth/sessions.js';
import type { AppCtx } from '../ctx.js';
import type { Db } from '../db/client.js';
import { sectors, userSectors, users } from '../db/schema.js';
import type { AuthUser } from '../inbox/visibility.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/http-error.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const IdParams = z.object({ id: z.uuid() });
const fields = {
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().pipe(z.email()),
  password: z.string().min(8).max(200),
  role: z.enum(['admin', 'agent']),
  signature: z.string().trim().max(120).nullable().optional(),
  sectorIds: z.array(z.uuid()).max(50),
};
const Create = z.object({ ...fields, role: fields.role.default('agent'), sectorIds: fields.sectorIds.default([]) });
const Patch = z
  .object({ ...fields, active: z.boolean() })
  .partial()
  .refine((b) => Object.keys(b).length > 0, { error: 'Nada para alterar' });
type UserPatch = z.infer<typeof Patch>;

async function listUserDtos(db: Db, where?: SQL): Promise<UserDto[]> {
  const rows = await db.select().from(users).where(where).orderBy(asc(users.name));
  const links = rows.length
    ? await db.select().from(userSectors).where(inArray(userSectors.userId, rows.map((u) => u.id)))
    : [];
  return rows.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    signature: u.signature,
    active: u.active,
    sectorIds: links.filter((l) => l.userId === u.id).map((l) => l.sectorId),
  }));
}

async function getUserDto(db: Db, id: string): Promise<UserDto> {
  const [u] = await listUserDtos(db, eq(users.id, id));
  if (!u) throw notFound('Usuário não encontrado');
  return u;
}

async function setSectors(tx: Tx, userId: string, sectorIds: string[]): Promise<void> {
  const ids = [...new Set(sectorIds)];
  if (ids.length && (await tx.$count(sectors, inArray(sectors.id, ids))) !== ids.length) throw badRequest('Setor inexistente');
  await tx.delete(userSectors).where(eq(userSectors.userId, userId));
  if (ids.length) await tx.insert(userSectors).values(ids.map((sectorId) => ({ userId, sectorId })));
}

// Spec §6: deactivating a user or resetting the password deletes all their sessions and
// disconnects their sockets.
async function updateUser(ctx: AppCtx, actor: AuthUser, id: string, p: UserPatch): Promise<UserDto> {
  if (id === actor.id && (p.active === false || p.role === 'agent')) {
    throw badRequest('Você não pode desativar nem rebaixar o próprio usuário');
  }
  const passwordHash = p.password ? await hashPassword(p.password) : undefined;
  const set = {
    name: p.name,
    email: p.email,
    role: p.role,
    active: p.active,
    passwordHash,
    signature: p.signature === undefined ? undefined : p.signature || null,
  };
  const killSessions = p.active === false || passwordHash !== undefined;
  await ctx.db.transaction(async (tx) => {
    if (!(await tx.$count(users, eq(users.id, id)))) throw notFound('Usuário não encontrado');
    if (p.email && (await tx.$count(users, and(eq(users.email, p.email), ne(users.id, id))))) {
      throw conflict('E-mail já cadastrado');
    }
    if (Object.values(set).some((v) => v !== undefined)) await tx.update(users).set(set).where(eq(users.id, id));
    if (p.sectorIds) await setSectors(tx, id, p.sectorIds);
    if (killSessions) await deleteUserSessions(tx, id);
  });
  // A live socket keeps the role/sectors it had at connect time: drop it so the client reconnects fresh.
  if (killSessions || p.role !== undefined || p.sectorIds !== undefined) ctx.hub.disconnectUser(id);
  return getUserDto(ctx.db, id);
}

export function registerUserRoutes(app: FastifyInstance, ctx: AppCtx): void {
  app.get('/api/users', async () => listUserDtos(ctx.db));

  app.post('/api/users', async (req) => {
    if (req.user.role !== 'admin') throw forbidden();
    const b = Create.parse(req.body);
    const id = crypto.randomUUID();
    const passwordHash = await hashPassword(b.password);
    await ctx.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(users)
        .values({
          id,
          name: b.name,
          email: b.email,
          passwordHash,
          role: b.role,
          signature: b.signature || null,
          active: true,
          createdAt: new Date(),
        })
        .onConflictDoNothing()
        .returning({ id: users.id });
      if (!row) throw conflict('E-mail já cadastrado');
      await setSectors(tx, id, b.sectorIds);
    });
    return getUserDto(ctx.db, id);
  });

  app.patch('/api/users/:id', async (req) => {
    if (req.user.role !== 'admin') throw forbidden();
    const { id } = IdParams.parse(req.params);
    return updateUser(ctx, req.user, id, Patch.parse(req.body));
  });

  // Soft delete: users stay referenced by messages, notes and events.
  app.delete('/api/users/:id', async (req) => {
    if (req.user.role !== 'admin') throw forbidden();
    const { id } = IdParams.parse(req.params);
    return updateUser(ctx, req.user, id, { active: false });
  });
}
```

Modify `server/src/app.ts`. Add this import:

```ts
import { registerUserRoutes } from './catalog/users.js';
```

Add this call after `registerContactRoutes(app, ctx);`:

```ts
  registerUserRoutes(app, ctx);
```

- [ ] **Step 19: Run the tests to verify they pass**

Run: `npm test -w server -- test/catalog/users.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 20: Commit**

```bash
git add server/src/catalog/users.ts server/src/app.ts server/test/catalog/users.test.ts
git commit -m "feat(catalog): users API; deactivate and password reset kill sessions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 21: Write the failing quick-answers API tests**

Create `server/test/catalog/quick-answers.test.ts`:

```ts
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { findOrOpenChat } from '../../src/inbox/chats.js';
import { loginAs, makeTestApp, makeTestCtx, seedBasics } from '../helpers.js';

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

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

const names = (items: Array<{ name: string }>) => items.map((q) => q.name).sort();

it('scopes visibility and editing: "all" is admin-made, "owner" is personal', async () => {
  expect((await call('POST', '/api/quick-answers', agentA, { name: 'Geral', body: 'Olá', visibility: 'all' })).statusCode).toBe(403);

  const mine = (await call('POST', '/api/quick-answers', agentA, { name: 'Minha', body: 'Oi' })).json();
  expect(mine).toMatchObject({ name: 'Minha', body: 'Oi', visibility: 'owner', ownerId: seed.agentA.id, hasAttachment: false });
  const shared = (await call('POST', '/api/quick-answers', admin, { name: 'Geral', body: 'Bom dia', visibility: 'all' })).json();

  expect(names((await call('GET', '/api/quick-answers', agentA)).json())).toEqual(['Geral', 'Minha']);
  expect(names((await call('GET', '/api/quick-answers', agentB)).json())).toEqual(['Geral']);

  expect((await call('PATCH', `/api/quick-answers/${mine.id}`, agentB, { body: 'x' })).statusCode).toBe(404);
  expect((await call('DELETE', `/api/quick-answers/${mine.id}`, agentB)).statusCode).toBe(404);
  expect((await call('PATCH', `/api/quick-answers/${shared.id}`, agentA, { body: 'x' })).statusCode).toBe(403);
  expect((await call('PATCH', `/api/quick-answers/${mine.id}`, agentA, { visibility: 'all' })).statusCode).toBe(403);

  expect((await call('PATCH', `/api/quick-answers/${mine.id}`, agentA, { body: 'Oi!' })).json().body).toBe('Oi!');
  expect((await call('PATCH', `/api/quick-answers/${shared.id}`, admin, { name: 'Geral 2' })).json().name).toBe('Geral 2');
  expect((await call('DELETE', `/api/quick-answers/${mine.id}`, agentA)).statusCode).toBe(204);
  expect(names((await call('GET', '/api/quick-answers', agentA)).json())).toEqual(['Geral 2']);
});

it('renders variables from the chat contact, its fields and the current user', async () => {
  const field = (await call('POST', '/api/custom-fields', admin, { name: 'CPF', kind: 'cpf' })).json();
  const contact = (await call('POST', '/api/contacts', agentA, { name: 'Maria Souza', phone: '5565999994444' })).json();
  await call('PUT', `/api/contacts/${contact.id}/fields`, agentA, { [field.id]: '123.456.789-00' });
  const { chat } = await findOrOpenChat(ctx.db, {
    contactId: contact.id,
    channelId: seed.channelId,
    init: { sectorId: seed.sectorA, ownerId: null, waiting: false, triagePending: false, createdBy: null },
  });

  const qa = (
    await call('POST', '/api/quick-answers', admin, {
      name: 'Boas-vindas',
      body: 'Olá {{contato.primeiro_nome}}, sou {{atendente.primeiro_nome}}. CPF: {{campo.cpf}}. E-mail: [{{contato.email}}]',
      visibility: 'all',
    })
  ).json();

  const res = await call('POST', `/api/quick-answers/${qa.id}/render`, agentA, { chatId: chat.id });
  expect(res.statusCode).toBe(200);
  const first = seed.agentA.name.trim().split(/\s+/)[0];
  expect(res.json()).toEqual({ text: `Olá Maria, sou ${first}. CPF: 123.456.789-00. E-mail: []` });

  // agentB cannot see a sector A chat: same 404 as every other chat route.
  expect((await call('POST', `/api/quick-answers/${qa.id}/render`, agentB, { chatId: chat.id })).statusCode).toBe(404);
  expect((await call('POST', `/api/quick-answers/${qa.id}/render`, agentA, { chatId: crypto.randomUUID() })).statusCode).toBe(404);
});

it('stores an optional multipart attachment and serves it only to who can see the answer', async () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );
  const boundary = '----talk-test-boundary';
  const field = (name: string, value: string) =>
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  const payload = Buffer.concat([
    field('name', 'Com anexo'),
    field('body', 'Segue o arquivo'),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="logo.png"\r\nContent-Type: image/png\r\n\r\n`),
    png,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const created = await app.inject({
    method: 'POST',
    url: '/api/quick-answers',
    headers: { ...agentA, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  });
  expect(created.statusCode).toBe(200);
  const qa = created.json();
  expect(qa).toMatchObject({ name: 'Com anexo', body: 'Segue o arquivo', visibility: 'owner', hasAttachment: true });

  const file = await call('GET', `/api/quick-answers/${qa.id}/attachment`, agentA);
  expect(file.statusCode).toBe(200);
  expect(file.headers['content-type']).toBe('image/png');
  expect(file.headers['x-content-type-options']).toBe('nosniff');
  expect(file.rawPayload.equals(png)).toBe(true);

  expect((await call('GET', `/api/quick-answers/${qa.id}/attachment`, agentB)).statusCode).toBe(404);

  const removed = await call('PATCH', `/api/quick-answers/${qa.id}`, agentA, { removeAttachment: true });
  expect(removed.json().hasAttachment).toBe(false);
  expect((await call('GET', `/api/quick-answers/${qa.id}/attachment`, agentA)).statusCode).toBe(404);
});
```

- [ ] **Step 22: Run the tests to verify they fail**

Run: `npm test -w server -- test/catalog/quick-answers.test.ts`
Expected: FAIL. `/api/quick-answers` is not registered (`expected 404 to be 403`).

- [ ] **Step 23: Implement the quick-answers routes**

Create `server/src/catalog/quick-answers.ts`:

```ts
import { createReadStream } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { asc, eq, or } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { QuickAnswerDto } from '@talk/shared';
import type { AppCtx } from '../ctx.js';
import { contactFieldValues, contacts, customFields, quickAnswers } from '../db/schema.js';
import { getChatForUser } from '../inbox/chats.js';
import type { AuthUser } from '../inbox/visibility.js';
import { forbidden, notFound } from '../lib/http-error.js';
import { mediaResponseHeaders, saveMedia } from '../messages/media.js';
import { renderQuickAnswer } from '../messages/quick-answers.js';

type QaRow = typeof quickAnswers.$inferSelect;
type Upload = { buffer: Buffer; mime: string; name: string };

const IdParams = z.object({ id: z.uuid() });
const qaFields = {
  name: z.string().trim().min(1).max(160),
  body: z.string().trim().min(1).max(2000),
  visibility: z.enum(['all', 'owner']),
};
const Create = z.object({ ...qaFields, visibility: qaFields.visibility.default('owner') });
// Multipart fields arrive as strings, JSON as booleans.
const Patch = z
  .object({
    ...qaFields,
    removeAttachment: z.union([z.boolean(), z.enum(['true', 'false'])]).transform((v) => v === true || v === 'true'),
  })
  .partial();
const RenderBody = z.object({ chatId: z.uuid() });

// saveMedia keeps the extension; only inline-safe types need their real mime,
// mediaResponseHeaders turns everything else into an octet-stream download anyway.
const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
};

const toDto = (q: QaRow): QuickAnswerDto => ({
  id: q.id,
  name: q.name,
  body: q.body,
  hasAttachment: q.attachmentPath !== null,
  visibility: q.visibility,
  ownerId: q.ownerId,
});
const canView = (u: AuthUser, q: QaRow) => q.visibility === 'all' || q.ownerId === u.id;
const canEdit = (u: AuthUser, q: QaRow) => q.ownerId === u.id || (u.role === 'admin' && q.visibility === 'all');
const firstName = (s: string) => s.trim().split(/\s+/)[0] ?? '';

async function readInput(req: FastifyRequest): Promise<{ fields: Record<string, unknown>; file: Upload | null }> {
  if (!req.isMultipart()) return { fields: (req.body ?? {}) as Record<string, unknown>, file: null };
  const fields: Record<string, unknown> = {};
  let file: Upload | null = null;
  for await (const part of req.parts()) {
    if (part.type === 'file') file = { buffer: await part.toBuffer(), mime: part.mimetype, name: part.filename };
    else fields[part.fieldname] = part.value;
  }
  return { fields, file };
}

async function load(ctx: AppCtx, user: AuthUser, id: string): Promise<QaRow> {
  const [row] = await ctx.db.select().from(quickAnswers).where(eq(quickAnswers.id, id));
  if (!row || !canView(user, row)) throw notFound('Resposta rápida não encontrada');
  return row;
}

async function store(ctx: AppCtx, file: Upload | null): Promise<string | null> {
  return file ? (await saveMedia(ctx.config.mediaDir, file.buffer, file.mime, file.name)).path : null;
}

function assertCanSetVisibility(user: AuthUser, visibility: 'all' | 'owner' | undefined): void {
  if (visibility === 'all' && user.role !== 'admin') throw forbidden('Só administradores criam respostas para todos');
}

export function registerQuickAnswerRoutes(app: FastifyInstance, ctx: AppCtx): void {
  app.get('/api/quick-answers', async (req) => {
    const rows = await ctx.db
      .select()
      .from(quickAnswers)
      .where(or(eq(quickAnswers.visibility, 'all'), eq(quickAnswers.ownerId, req.user.id)))
      .orderBy(asc(quickAnswers.name));
    return rows.map(toDto);
  });

  app.post('/api/quick-answers', async (req) => {
    const { fields, file } = await readInput(req);
    const b = Create.parse(fields);
    assertCanSetVisibility(req.user, b.visibility);
    const [row] = await ctx.db
      .insert(quickAnswers)
      .values({
        id: crypto.randomUUID(),
        name: b.name,
        body: b.body,
        visibility: b.visibility,
        ownerId: req.user.id,
        attachmentPath: await store(ctx, file),
        createdAt: new Date(),
      })
      .returning();
    return toDto(row);
  });

  app.patch('/api/quick-answers/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const { fields, file } = await readInput(req);
    const qa = await load(ctx, req.user, id);
    if (!canEdit(req.user, qa)) throw forbidden();
    const b = Patch.parse(fields);
    assertCanSetVisibility(req.user, b.visibility);
    // ponytail: a replaced/removed attachment file stays on disk; add cleanup if /data/media grows.
    const attachmentPath = file ? await store(ctx, file) : b.removeAttachment ? null : undefined;
    const set = { name: b.name, body: b.body, visibility: b.visibility, attachmentPath };
    if (Object.values(set).every((v) => v === undefined)) return toDto(qa);
    const [row] = await ctx.db.update(quickAnswers).set(set).where(eq(quickAnswers.id, id)).returning();
    return toDto(row);
  });

  app.delete('/api/quick-answers/:id', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const qa = await load(ctx, req.user, id);
    if (!canEdit(req.user, qa)) throw forbidden();
    await ctx.db.delete(quickAnswers).where(eq(quickAnswers.id, id));
    return reply.code(204).send();
  });

  // Fills the variables for the composer; never sends anything (spec §5.7).
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

  // Spec §4: an attachment of an owner-only answer is served to its owner only (load() → 404).
  app.get('/api/quick-answers/:id/attachment', async (req, reply) => {
    const qa = await load(ctx, req.user, IdParams.parse(req.params).id);
    if (!qa.attachmentPath) throw notFound('Esta resposta não tem anexo');
    const fileName = basename(qa.attachmentPath);
    const mime = MIME_BY_EXT[extname(fileName).toLowerCase()] ?? 'application/octet-stream';
    return reply
      .headers(mediaResponseHeaders(mime, fileName))
      .send(createReadStream(join(ctx.config.mediaDir, qa.attachmentPath)));
  });
}
```

Modify `server/src/app.ts`. Add these imports (`@fastify/multipart` was installed by Task 1 but no earlier task registers it; importing it also brings in the `isMultipart()`/`parts()` type augmentation for `tsc`):

```ts
import multipart from '@fastify/multipart';
import { registerQuickAnswerRoutes } from './catalog/quick-answers.js';
```

Add these lines after `registerUserRoutes(app, ctx);`:

```ts
  // Root-level so every route module (quick answers here, chats in Task 13) can read multipart bodies.
  await app.register(multipart, { limits: { fileSize: 64 * 1024 * 1024, files: 1 } });
  registerQuickAnswerRoutes(app, ctx);
```

- [ ] **Step 24: Run the tests to verify they pass**

Run: `npm test -w server -- test/catalog/quick-answers.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 25: Commit**

```bash
git add server/src/catalog/quick-answers.ts server/src/app.ts server/test/catalog/quick-answers.test.ts
git commit -m "feat(catalog): quick answers API with attachment and variable rendering

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 26: Write the failing settings API tests**

Create `server/test/catalog/settings.test.ts`:

```ts
import { afterEach, beforeEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { settings } from '../../src/db/schema.js';
import { loginAs, makeTestApp, makeTestCtx, seedBasics } from '../helpers.js';

let app: FastifyInstance;
let ctx: Awaited<ReturnType<typeof makeTestCtx>>;
let seed: Awaited<ReturnType<typeof seedBasics>>;
let admin: Record<string, string>;
let agent: Record<string, string>;

beforeEach(async () => {
  ctx = await makeTestCtx();
  seed = await seedBasics(ctx);
  ({ app } = await makeTestApp(ctx));
  admin = (await loginAs(app, seed.admin.email)).headers;
  agent = (await loginAs(app, seed.agentA.email)).headers;
});

afterEach(async () => {
  await app.close();
});

function put(headers: Record<string, string>, payload: object) {
  return app.inject({ method: 'PUT', url: '/api/settings', headers, payload });
}

it('saves the closing message and triage menu (admin only) and validates the menu', async () => {
  const body = {
    closingMessage: 'Atendimento finalizado. Obrigado!',
    triageMenu: {
      enabled: true,
      welcomeText: 'Olá! Escolha uma opção:',
      invalidText: 'Não entendi.',
      options: [
        { key: '1', label: 'Financeiro', sectorId: seed.sectorA },
        { key: '2', label: 'Processos', sectorId: seed.sectorB },
      ],
    },
  };
  const withOptions = (options: object[], enabled = true) => ({ ...body, triageMenu: { ...body.triageMenu, enabled, options } });

  expect((await put(agent, body)).statusCode).toBe(403);
  expect((await put(admin, withOptions([{ key: '1', label: 'X', sectorId: crypto.randomUUID() }]))).statusCode).toBe(400);
  expect((await put(admin, withOptions([]))).statusCode).toBe(400);
  expect(
    (
      await put(
        admin,
        withOptions([
          { key: '1', label: 'A', sectorId: seed.sectorA },
          { key: '1', label: 'B', sectorId: seed.sectorB },
        ]),
      )
    ).statusCode,
  ).toBe(400);
  expect((await put(admin, withOptions([], false))).statusCode).toBe(200); // a disabled menu may be empty

  const saved = await put(admin, body);
  expect(saved.statusCode).toBe(200);
  expect(saved.json()).toEqual(body);

  const got = await app.inject({ method: 'GET', url: '/api/settings', headers: agent });
  expect(got.statusCode).toBe(200);
  expect(got.json()).toEqual(body);

  // Stored as spec §4 snake_case, which triage/getTriageMenu reads.
  const [row] = await ctx.db.select().from(settings).where(eq(settings.key, 'triage_menu'));
  expect(row.value).toEqual({
    enabled: true,
    welcome_text: 'Olá! Escolha uma opção:',
    invalid_text: 'Não entendi.',
    options: [
      { key: '1', label: 'Financeiro', sector_id: seed.sectorA },
      { key: '2', label: 'Processos', sector_id: seed.sectorB },
    ],
  });
  const [closing] = await ctx.db.select().from(settings).where(eq(settings.key, 'closing_message'));
  expect(closing.value).toBe('Atendimento finalizado. Obrigado!');
});
```

- [ ] **Step 27: Run the tests to verify they fail**

Run: `npm test -w server -- test/catalog/settings.test.ts`
Expected: FAIL. `/api/settings` is not registered (`expected 404 to be 403`).

- [ ] **Step 28: Implement the settings routes**

Create `server/src/catalog/settings.ts`:

```ts
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SettingsDto } from '@talk/shared';
import type { AppCtx } from '../ctx.js';
import type { Db } from '../db/client.js';
import { sectors, settings } from '../db/schema.js';
import { badRequest, forbidden } from '../lib/http-error.js';
import { getTriageMenu } from '../triage/triage.js';

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
});

async function readSettings(db: Db): Promise<SettingsDto> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, 'closing_message'));
  return { closingMessage: typeof row?.value === 'string' ? row.value : '', triageMenu: await getTriageMenu(db) };
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
    });
    return readSettings(ctx.db);
  });
}
```

Modify `server/src/app.ts`. Add this import:

```ts
import { registerSettingsRoutes } from './catalog/settings.js';
```

Add this call after `registerQuickAnswerRoutes(app, ctx);`:

```ts
  registerSettingsRoutes(app, ctx);
```

- [ ] **Step 29: Run the tests to verify they pass**

Run: `npm test -w server -- test/catalog/settings.test.ts`
Expected: PASS (1 test).

- [ ] **Step 30: Run the whole server suite and the typecheck**

Run: `npm test -w server`
Expected: PASS. All suites pass, including those from earlier tasks.

Run: `npx tsc -p server/tsconfig.json --noEmit`
Expected: exits 0 with no errors.

- [ ] **Step 31: Commit**

```bash
git add server/src/catalog/settings.ts server/src/app.ts server/test/catalog/settings.test.ts
git commit -m "feat(catalog): settings API for closing message and triage menu

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


---

### Task 13: Chats API routes and queries

Every `/api/chats*` route from the REST table, plus `POST /api/messages/:id/resend`, and the read side of the inbox: the chat list with tabs, filters, per-user pins and keyset pagination, chat detail, and the merged timeline. Routes stay thin. They validate with zod and call the Task 7 and Task 10 services. Visibility always goes through `visibleChatsWhere` / `getChatForUser`. This task owns the REST part of Review Focus 4: an agent of sector A gets 404 for sector B's chat, timeline, media and actions.

**Files:**
- Modify (replace the whole file): `server/src/inbox/queries.ts`. Task 8 created it with `toChatListItem`; the signature does not change.
- Create: `server/src/chats/routes.ts`
- Modify: `server/src/app.ts` (register `chatRoutes`)
- Modify: `server/package.json` (add `@fastify/multipart` if no earlier task added it)
- Create: `server/test/chats/seed.ts` (direct-insert helpers for chats, messages and events)
- Test: `server/test/chats/list-and-timeline.test.ts`
- Test: `server/test/chats/actions.test.ts`

**Interfaces:**
- Consumes:
  - Task 2: tables `chats`, `contacts`, `contactTags`, `tags`, `chatPins`, `messages`, `chatEvents`, `users`, `settings` from `server/src/db/schema.ts`; `Db` from `server/src/db/client.ts`.
  - Task 3: `normalizePhoneBR(raw: string): string` from `server/src/whatsapp/phone.ts`.
  - Task 6: `auth/plugin.ts` sets `request.user: AuthUser` on every authenticated `/api/*` request. It answers 401 with no valid session and 403 on a bad `Origin` for non-GET requests. Test helpers: `makeTestCtx`, `makeTestApp`, `seedBasics`, `loginAs`.
  - Task 7: `visibleChatsWhere(user): SQL | undefined`, `AuthUser`, `ChatRow`, `getChatForUser`, `assumeChat`, `transferChat`, `setChatPrivacy`, `closeChat`, `reopenChat`, `markChatRead`, `pinChat`, `startChat` (signatures as in the contract). `closeChat` opts are `{ sendClosingMessage: boolean; sendClosing?: (text: string) => Promise<unknown> }`. Task 7 cannot import Task 10, so `closeChat` reads `settings.closing_message`, runs its own visibility and state checks, and then calls `opts.sendClosing(text)` before closing. This task wires `sendClosing` to `sendAgentMessage`.
  - Task 10: `sendAgentMessage(ctx, user, chatId, input: SendInput): Promise<MessageDto>`, `addNote(ctx, user, chatId, text): Promise<MessageDto>`, `resendMessage(ctx, user, messageId): Promise<MessageDto>`, `SendInput`, `toMessageDto(db, row): Promise<MessageDto>`, route `GET /api/media/:messageId`.
  - Shared DTO types `ChatListFilters`, `ChatListItem`, `ChatDetail`, `ChatEventDto`, `TimelineItem` from the `shared` workspace package, imported as `@talk/shared`.
- Produces:
  - `listChats(ctx: AppCtx, user: AuthUser, f: ChatListFilters): Promise<{ items: ChatListItem[]; nextCursor: string | null }>`
    - Tabs: `inbox` = every open chat; `waiting` = open and `waiting=true`; `closed` = `state='closed'`.
    - Filters: `sectorId`; `ownerId` (`"none"` = no owner); `tagId` (matched through the contact's tags); `from`/`to` (inclusive, ISO datetimes, compared with `chats.created_at`); `q` (contact name with ILIKE; if `q` has at least 4 digits, the phone runs through `normalizePhoneBR` and is matched as a substring).
    - Order: the user's pinned chats first, and only on the first page. Then `coalesce(last_message_at, created_at) desc, id desc`.
    - Paging: `limit` defaults to 50, maximum 100. `nextCursor` is opaque base64url.
  - `getChatDetail(ctx, user, chatId): Promise<ChatDetail>`. Returns 404 if the chat is missing or not visible to the user.
  - `getTimeline(ctx, user, chatId, q: { before?: string; limit?: number }): Promise<TimelineItem[]>`
    - Returns the newest `limit` items older than `before`, in ascending order. `limit` defaults to 50, maximum 100.
    - **`before` is the `id` of the oldest timeline item the client already has** (a message id or an event id). Unknown id → 400.
  - `toChatListItem(db: Db | Tx, chat: ChatRow, userId: string): Promise<ChatListItem>`. The contract signature, now filling `contact`, `pinned` for `userId` and `tagIds` (the contact's tags, ordered by `tags.position`).
  - **New:** `toChatDetail(db: Db | Tx, chat: ChatRow, userId: string): Promise<ChatDetail>`. It runs no visibility check. Action routes use it because, after a transfer, the caller may no longer see the chat and still gets 200 with the new state.
  - `chatRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void>` in `server/src/chats/routes.ts`. It registers its routes in an encapsulated scope and adds `@fastify/multipart` there only if no parser exists yet.
  - Web contract (Tasks 16 and 17):
    - `GET /api/chats?tab=&q=&sectorId=&ownerId=<uuid|none>&tagId=&from=<ISO>&to=<ISO>&cursor=&limit=`. The web sends `from` and `to` as full ISO datetimes for the local day boundaries.
    - `GET /api/chats/:id/timeline?before=<oldest item id>&limit=`
    - `POST /api/chats/:id/messages`: JSON `{ text, signature, replyToId? }`, or multipart with fields `text?`, `signature` (`"true"`/`"false"`), `asVoice?`, `replyToId?` and a single part named `file` (64 MB maximum; larger → 413).

- [ ] **Step 1: Write the seed helpers used by both test files**

`server/test/chats/seed.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { AppCtx } from '../../src/ctx.js';
import { chatEvents, chats, contacts, messages } from '../../src/db/schema.js';
import type { ChatEventKind } from '../../src/inbox/events.js';

export interface SeedChatOpts {
  channelId: string;
  sectorId: string;
  ownerId?: string | null;
  contactId?: string;
  name?: string | null;
  phone?: string | null;
  state?: 'open' | 'closed';
  waiting?: boolean;
  private?: boolean;
  unread?: number;
  at?: Date;
}

export async function seedChat(ctx: AppCtx, o: SeedChatOpts): Promise<{ chatId: string; contactId: string }> {
  const at = o.at ?? new Date();
  let contactId = o.contactId;
  if (!contactId) {
    contactId = randomUUID();
    await ctx.db.insert(contacts).values({
      id: contactId, name: o.name ?? 'Contato', phone: o.phone ?? null, blocked: false, createdAt: at, updatedAt: at,
    });
  }
  const chatId = randomUUID();
  const state = o.state ?? 'open';
  await ctx.db.insert(chats).values({
    id: chatId, contactId, channelId: o.channelId, sectorId: o.sectorId, ownerId: o.ownerId ?? null,
    state, waiting: o.waiting ?? false, private: o.private ?? false, triagePending: false,
    unread: o.unread ?? 0, lastMessageAt: at, lastMessagePreview: 'oi', createdAt: at,
    closedAt: state === 'closed' ? at : null,
  });
  return { chatId, contactId };
}

export async function seedMessage(
  ctx: AppCtx, chatId: string, channelId: string, at: Date,
  extra: Partial<typeof messages.$inferInsert> = {},
): Promise<string> {
  const id = randomUUID();
  await ctx.db.insert(messages).values({
    id, chatId, channelId, direction: 'in', kind: 'text', body: 'msg', status: 'delivered',
    sentAt: at, createdAt: at, ...extra,
  });
  return id;
}

export async function seedEvent(ctx: AppCtx, chatId: string, kind: ChatEventKind, at: Date): Promise<string> {
  const id = randomUUID();
  await ctx.db.insert(chatEvents).values({ id, chatId, kind, data: {}, authorId: null, createdAt: at });
  return id;
}
```

- [ ] **Step 2: Write the failing list/detail/timeline tests**

`server/test/chats/list-and-timeline.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatListItem, TimelineItem } from '@talk/shared';
import { chatPins, contactTags, tags } from '../../src/db/schema.js';
import { loginAs, makeTestApp, makeTestCtx, seedBasics } from '../helpers.js';
import { seedChat, seedEvent, seedMessage } from './seed.js';

let app: FastifyInstance;
let ctx: Awaited<ReturnType<typeof makeTestCtx>>;
let s: Awaited<ReturnType<typeof seedBasics>>;

beforeEach(async () => {
  ctx = await makeTestCtx();
  s = await seedBasics(ctx);
  ({ app } = await makeTestApp(ctx));
});
afterEach(async () => {
  await app.close();
});

const t = (min: number) => new Date(Date.UTC(2026, 9, 14, 12, min));

async function list(headers: Record<string, string>, query = '') {
  const res = await app.inject({ method: 'GET', url: `/api/chats${query}`, headers });
  expect(res.statusCode).toBe(200);
  return res.json() as { items: ChatListItem[]; nextCursor: string | null };
}
const ids = (r: { items: ChatListItem[] }) => r.items.map((i) => i.id);

describe('GET /api/chats', () => {
  it('requires a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/chats' });
    expect(res.statusCode).toBe(401);
  });

  it('tabs: inbox = all open, waiting = open and waiting, closed = closed', async () => {
    const a = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, waiting: true });
    const b = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, waiting: false });
    const c = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, state: 'closed' });
    const { headers } = await loginAs(app, s.admin.email);

    expect(ids(await list(headers)).sort()).toEqual([a.chatId, b.chatId].sort());
    expect(ids(await list(headers, '?tab=inbox')).sort()).toEqual([a.chatId, b.chatId].sort());
    expect(ids(await list(headers, '?tab=waiting'))).toEqual([a.chatId]);
    expect(ids(await list(headers, '?tab=closed'))).toEqual([c.chatId]);
  });

  it('filters by sector, owner, unassigned, contact tag, period, name and phone', async () => {
    const c1 = await seedChat(ctx, {
      channelId: s.channelId, sectorId: s.sectorA, ownerId: s.agentA.id,
      name: 'Maria Souza', phone: '5565999990001', at: t(1),
    });
    const c2 = await seedChat(ctx, {
      channelId: s.channelId, sectorId: s.sectorB, ownerId: null,
      name: 'João Lima', phone: '5511988887777', at: t(30),
    });
    const tagId = randomUUID();
    await ctx.db.insert(tags).values({ id: tagId, name: 'VIP', emoji: null, color: '#e11d48', position: 0 });
    await ctx.db.insert(contactTags).values({ contactId: c1.contactId, tagId });
    const { headers } = await loginAs(app, s.admin.email);
    const iso = (d: Date) => encodeURIComponent(d.toISOString());

    expect(ids(await list(headers, `?sectorId=${s.sectorA}`))).toEqual([c1.chatId]);
    expect(ids(await list(headers, '?ownerId=none'))).toEqual([c2.chatId]);
    expect(ids(await list(headers, `?ownerId=${s.agentA.id}`))).toEqual([c1.chatId]);
    const byTag = await list(headers, `?tagId=${tagId}`);
    expect(ids(byTag)).toEqual([c1.chatId]);
    expect(byTag.items[0].tagIds).toEqual([tagId]);
    expect(ids(await list(headers, `?from=${iso(t(10))}`))).toEqual([c2.chatId]);
    expect(ids(await list(headers, `?to=${iso(t(10))}`))).toEqual([c1.chatId]);
    expect(ids(await list(headers, '?q=maria'))).toEqual([c1.chatId]);
    // 12-digit WhatsApp form (no 9) must find the canonical 13-digit phone
    expect(ids(await list(headers, '?q=556599990001'))).toEqual([c1.chatId]);
    expect(ids(await list(headers, '?q=8888'))).toEqual([c2.chatId]);
    expect((await list(headers, '?q=maria')).items[0].contact).toEqual({
      id: c1.contactId, name: 'Maria Souza', phone: '5565999990001',
    });
  });

  it('pinned chats come first, only for the user who pinned them', async () => {
    const old = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, at: t(1) });
    const mid = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, at: t(2) });
    const neu = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, at: t(3) });
    await ctx.db.insert(chatPins).values({ userId: s.agentA.id, chatId: old.chatId, createdAt: new Date() });

    const agent = await loginAs(app, s.agentA.email);
    const mine = await list(agent.headers);
    expect(ids(mine)).toEqual([old.chatId, neu.chatId, mid.chatId]);
    expect(mine.items.map((i) => i.pinned)).toEqual([true, false, false]);

    const admin = await loginAs(app, s.admin.email);
    const theirs = await list(admin.headers);
    expect(ids(theirs)).toEqual([neu.chatId, mid.chatId, old.chatId]);
    expect(theirs.items.every((i) => !i.pinned)).toBe(true);
  });

  it('cursor pagination walks every chat once, newest first', async () => {
    const created: string[] = [];
    for (let i = 1; i <= 5; i++) {
      created.push((await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, at: t(i) })).chatId);
    }
    const { headers } = await loginAs(app, s.admin.email);

    const p1 = await list(headers, '?limit=2');
    expect(ids(p1)).toEqual([created[4], created[3]]);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await list(headers, `?limit=2&cursor=${p1.nextCursor}`);
    expect(ids(p2)).toEqual([created[2], created[1]]);
    const p3 = await list(headers, `?limit=2&cursor=${p2.nextCursor}`);
    expect(ids(p3)).toEqual([created[0]]);
    expect(p3.nextCursor).toBeNull();

    expect((await app.inject({ method: 'GET', url: '/api/chats?cursor=xyz', headers })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/chats?limit=101', headers })).statusCode).toBe(400);
  });
});

describe('visibility (Review Focus 4, REST)', () => {
  it('an agent of sector A never sees a sector B or private chat via list, detail, timeline, media or actions', async () => {
    const own = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, name: 'Cliente A' });
    const other = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorB });
    const priv = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, ownerId: s.agentB.id, private: true });
    const mediaId = await seedMessage(ctx, other.chatId, s.channelId, t(1), {
      kind: 'image', mediaPath: '2026/10/x.png', mediaMime: 'image/png', mediaSize: 10, mediaName: 'x.png',
    });
    const { headers } = await loginAs(app, s.agentA.email);

    expect(ids(await list(headers))).toEqual([own.chatId]);
    const detail = await app.inject({ method: 'GET', url: `/api/chats/${own.chatId}`, headers });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().contact.name).toBe('Cliente A');

    for (const url of [
      `/api/chats/${other.chatId}`,
      `/api/chats/${other.chatId}/timeline`,
      `/api/media/${mediaId}`,
      `/api/chats/${priv.chatId}`,
      `/api/chats/${priv.chatId}/timeline`,
    ]) {
      expect((await app.inject({ method: 'GET', url, headers })).statusCode, url).toBe(404);
    }

    const admin = await loginAs(app, s.admin.email);
    expect(ids(await list(admin.headers)).sort()).toEqual([own.chatId, other.chatId, priv.chatId].sort());
  });
});

describe('GET /api/chats/:id/timeline', () => {
  it('merges messages and events by time and pages backwards with before=<oldest id>', async () => {
    const chat = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA });
    const e1 = await seedEvent(ctx, chat.chatId, 'created', t(0));
    const m1 = await seedMessage(ctx, chat.chatId, s.channelId, t(1));
    const e2 = await seedEvent(ctx, chat.chatId, 'assigned', t(2));
    const m2 = await seedMessage(ctx, chat.chatId, s.channelId, t(3));
    const { headers } = await loginAs(app, s.agentA.email);
    const get = async (q: string) => {
      const res = await app.inject({ method: 'GET', url: `/api/chats/${chat.chatId}/timeline${q}`, headers });
      expect(res.statusCode).toBe(200);
      return res.json() as TimelineItem[];
    };

    const all = await get('');
    expect(all.map((i) => i.id)).toEqual([e1, m1, e2, m2]);
    expect(all.map((i) => i.type)).toEqual(['event', 'message', 'event', 'message']);
    const firstEvent = all[0];
    expect(firstEvent.type === 'event' && firstEvent.kind).toBe('created');

    expect((await get('?limit=2')).map((i) => i.id)).toEqual([e2, m2]);
    expect((await get(`?limit=2&before=${e2}`)).map((i) => i.id)).toEqual([e1, m1]);
    expect(await get(`?before=${e1}`)).toEqual([]);

    const bad = await app.inject({ method: 'GET', url: `/api/chats/${chat.chatId}/timeline?before=${randomUUID()}`, headers });
    expect(bad.statusCode).toBe(400);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -w server -- test/chats/list-and-timeline.test.ts`
Expected: FAIL. `GET /api/chats` and the other chat routes are not registered yet, so assertions report `expected 404 to be 200`. The visibility test may pass by accident on the 404 lines but fails on the list call.

- [ ] **Step 4: Write `server/src/inbox/queries.ts` (replace the whole file)**

```ts
import { and, asc, desc, eq, gte, ilike, inArray, isNull, like, lte, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { ChatDetail, ChatListFilters, ChatListItem, TimelineItem } from '@talk/shared';
import type { AppCtx } from '../ctx.js';
import type { Db } from '../db/client.js';
import { chatEvents, chatPins, chats, contacts, contactTags, messages, tags, users } from '../db/schema.js';
import { badRequest } from '../lib/http-error.js';
import { toMessageDto } from '../messages/dto.js';
import { normalizePhoneBR } from '../whatsapp/phone.js';
import { getChatForUser, type ChatRow } from './chats.js';
import { visibleChatsWhere, type AuthUser } from './visibility.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const clampLimit = (n: number | undefined) => Math.min(Math.max(n ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

// A chat with no message yet (started by an agent) sorts by its creation time.
const sortKey = sql`coalesce(${chats.lastMessageAt}, ${chats.createdAt})`;

// The cursor carries the timestamptz as Postgres text, so microseconds survive the round trip.
const cursorSchema = z.tuple([
  z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}(:\d{2})?$/),
  z.uuid(),
]);
const encodeCursor = (key: string, id: string) => Buffer.from(JSON.stringify([key, id])).toString('base64url');
function decodeCursor(cursor: string): [string, string] {
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
  } catch {
    throw badRequest('Cursor inválido');
  }
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export async function toChatListItem(db: Db | Tx, chat: ChatRow, userId: string): Promise<ChatListItem> {
  const [contact] = await db
    .select({ id: contacts.id, name: contacts.name, phone: contacts.phone })
    .from(contacts)
    .where(eq(contacts.id, chat.contactId));
  const pin = await db
    .select({ chatId: chatPins.chatId })
    .from(chatPins)
    .where(and(eq(chatPins.chatId, chat.id), eq(chatPins.userId, userId)))
    .limit(1);
  const tagRows = await db
    .select({ id: contactTags.tagId })
    .from(contactTags)
    .innerJoin(tags, eq(tags.id, contactTags.tagId))
    .where(eq(contactTags.contactId, chat.contactId))
    .orderBy(asc(tags.position));
  return {
    id: chat.id,
    contact: contact ?? { id: chat.contactId, name: null, phone: null },
    channelId: chat.channelId,
    sectorId: chat.sectorId,
    ownerId: chat.ownerId,
    state: chat.state,
    waiting: chat.waiting,
    private: chat.private,
    unread: chat.unread,
    lastMessageAt: chat.lastMessageAt ? chat.lastMessageAt.toISOString() : null,
    lastMessagePreview: chat.lastMessagePreview,
    pinned: pin.length > 0,
    tagIds: tagRows.map((r) => r.id),
  };
}

// No visibility check: callers have already authorized (or just acted on) this chat.
export async function toChatDetail(db: Db | Tx, chat: ChatRow, userId: string): Promise<ChatDetail> {
  return {
    ...(await toChatListItem(db, chat, userId)),
    triagePending: chat.triagePending,
    createdAt: chat.createdAt.toISOString(),
    closedAt: chat.closedAt ? chat.closedAt.toISOString() : null,
  };
}

export async function listChats(
  ctx: AppCtx,
  user: AuthUser,
  f: ChatListFilters,
): Promise<{ items: ChatListItem[]; nextCursor: string | null }> {
  const db = ctx.db;
  const limit = clampLimit(f.limit);
  const conds: Array<SQL | undefined> = [visibleChatsWhere(user)];

  conds.push(eq(chats.state, f.tab === 'closed' ? 'closed' : 'open'));
  if (f.tab === 'waiting') conds.push(eq(chats.waiting, true));
  if (f.sectorId) conds.push(eq(chats.sectorId, f.sectorId));
  if (f.ownerId === 'none') conds.push(isNull(chats.ownerId));
  else if (f.ownerId) conds.push(eq(chats.ownerId, f.ownerId));
  if (f.tagId) {
    conds.push(
      inArray(
        chats.contactId,
        db.select({ id: contactTags.contactId }).from(contactTags).where(eq(contactTags.tagId, f.tagId)),
      ),
    );
  }
  if (f.from) conds.push(gte(chats.createdAt, new Date(f.from)));
  if (f.to) conds.push(lte(chats.createdAt, new Date(f.to)));
  const q = f.q?.trim();
  if (q) {
    const digits = q.replace(/\D/g, '');
    conds.push(
      or(
        ilike(contacts.name, `%${escapeLike(q)}%`),
        digits.length >= 4 ? like(contacts.phone, `%${normalizePhoneBR(digits)}%`) : undefined,
      ),
    );
  }

  const myPins = () => db.select({ id: chatPins.chatId }).from(chatPins).where(eq(chatPins.userId, user.id));
  const base = () =>
    db
      .select({ chat: chats, key: sql<string>`${sortKey}::text` })
      .from(chats)
      .innerJoin(contacts, eq(contacts.id, chats.contactId));

  // Pins (max 3 per user) are prepended to the first page only, so the keyset cursor covers unpinned chats alone.
  const pinned = f.cursor
    ? []
    : await base()
        .where(and(...conds, inArray(chats.id, myPins())))
        .orderBy(desc(sortKey), desc(chats.id));

  const after = f.cursor ? decodeCursor(f.cursor) : null;
  const rows = await base()
    .where(
      and(
        ...conds,
        notInArray(chats.id, myPins()),
        after ? sql`(${sortKey}, ${chats.id}) < (${after[0]}::timestamptz, ${after[1]}::uuid)` : undefined,
      ),
    )
    .orderBy(desc(sortKey), desc(chats.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const nextCursor = rows.length > limit && last ? encodeCursor(last.key, last.chat.id) : null;

  // ponytail: 3 small queries per chat (contact, pin, tags); batch them if listing 100 chats gets slow.
  const items: ChatListItem[] = [];
  for (const r of [...pinned, ...page]) items.push(await toChatListItem(db, r.chat, user.id));
  return { items, nextCursor };
}

export async function getChatDetail(ctx: AppCtx, user: AuthUser, chatId: string): Promise<ChatDetail> {
  const chat = await getChatForUser(ctx, user, chatId);
  return toChatDetail(ctx.db, chat, user.id);
}

export async function getTimeline(
  ctx: AppCtx,
  user: AuthUser,
  chatId: string,
  q: { before?: string; limit?: number },
): Promise<TimelineItem[]> {
  await getChatForUser(ctx, user, chatId);
  const db = ctx.db;
  const limit = clampLimit(q.limit);

  let msgBefore: SQL | undefined;
  let evBefore: SQL | undefined;
  if (q.before) {
    const [m] = await db
      .select({ t: sql<string>`${messages.sentAt}::text` })
      .from(messages)
      .where(and(eq(messages.id, q.before), eq(messages.chatId, chatId)));
    const [e] = m
      ? []
      : await db
          .select({ t: sql<string>`${chatEvents.createdAt}::text` })
          .from(chatEvents)
          .where(and(eq(chatEvents.id, q.before), eq(chatEvents.chatId, chatId)));
    const at = m?.t ?? e?.t;
    if (!at) throw badRequest('Cursor inválido');
    msgBefore = sql`(${messages.sentAt}, ${messages.id}) < (${at}::timestamptz, ${q.before}::uuid)`;
    evBefore = sql`(${chatEvents.createdAt}, ${chatEvents.id}) < (${at}::timestamptz, ${q.before}::uuid)`;
  }

  const msgRows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.chatId, chatId), msgBefore))
    .orderBy(desc(messages.sentAt), desc(messages.id))
    .limit(limit);
  const evRows = await db
    .select({ ev: chatEvents, authorName: users.name })
    .from(chatEvents)
    .leftJoin(users, eq(users.id, chatEvents.authorId))
    .where(and(eq(chatEvents.chatId, chatId), evBefore))
    .orderBy(desc(chatEvents.createdAt), desc(chatEvents.id))
    .limit(limit);

  type Entry = { t: number; id: string; build: () => Promise<TimelineItem> };
  const entries: Entry[] = [
    ...msgRows.map((row) => ({
      t: row.sentAt.getTime(),
      id: row.id,
      build: async (): Promise<TimelineItem> => ({ type: 'message', ...(await toMessageDto(db, row)) }),
    })),
    ...evRows.map(({ ev, authorName }) => ({
      t: ev.createdAt.getTime(),
      id: ev.id,
      build: async (): Promise<TimelineItem> => ({
        type: 'event',
        id: ev.id,
        chatId: ev.chatId,
        kind: ev.kind,
        data: (ev.data ?? {}) as Record<string, unknown>,
        authorName: authorName ?? null,
        createdAt: ev.createdAt.toISOString(),
      }),
    })),
  ];
  // Same (time, id) order as the SQL cursor: newest first, keep the page, then flip to ascending.
  entries.sort((a, b) => b.t - a.t || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const pageEntries = entries.slice(0, limit).reverse();
  return Promise.all(pageEntries.map((e) => e.build()));
}
```

- [ ] **Step 5: Write `server/src/chats/routes.ts` with the read routes**

```ts
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppCtx } from '../ctx.js';
import { getChatDetail, getTimeline, listChats } from '../inbox/queries.js';
import type { AuthUser } from '../inbox/visibility.js';

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

const me = (req: FastifyRequest) => req.user as AuthUser;

export async function chatRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  await app.register(async (r) => {
    r.get('/api/chats', async (req) => listChats(ctx, me(req), listQuery.parse(req.query)));

    r.get('/api/chats/:id', async (req) => getChatDetail(ctx, me(req), idParams.parse(req.params).id));

    r.get('/api/chats/:id/timeline', async (req) => {
      const { id } = idParams.parse(req.params);
      return getTimeline(ctx, me(req), id, timelineQuery.parse(req.query));
    });
  });
}
```

- [ ] **Step 6: Register the routes in `server/src/app.ts`**

Add the import next to the other route imports:

```ts
import { chatRoutes } from './chats/routes.js';
```

Inside `buildApp`, add this line **after** the auth plugin is registered (so `request.user` and the Origin check are inherited by the encapsulated scope) and **before** the SPA static fallback:

```ts
  await chatRoutes(app, ctx);
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test -w server -- test/chats/list-and-timeline.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 8: Commit**

```bash
git add server/src/inbox/queries.ts server/src/chats/routes.ts server/src/app.ts server/test/chats/seed.ts server/test/chats/list-and-timeline.test.ts
git commit -m "feat(chats): chat list, detail and timeline API with visibility, pins and cursors

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 9: Write the failing action/start/send tests**

`server/test/chats/actions.test.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { settings } from '../../src/db/schema.js';
import { loginAs, makeTestApp, makeTestCtx, seedBasics } from '../helpers.js';
import { seedChat } from './seed.js';

let app: FastifyInstance;
let ctx: Awaited<ReturnType<typeof makeTestCtx>>;
let s: Awaited<ReturnType<typeof seedBasics>>;

beforeEach(async () => {
  ctx = await makeTestCtx();
  s = await seedBasics(ctx);
  ({ app } = await makeTestApp(ctx));
});
afterEach(async () => {
  await app.close();
});

function multipart(fields: Record<string, string>, file?: { name: string; mime: string; data: Buffer }) {
  const boundary = '----talktestboundary';
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  if (file) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.mime}\r\n\r\n`,
      ),
      file.data,
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

describe('chat action routes', () => {
  it('assume, read, privacy and close answer with ChatDetail; closing twice is 409', async () => {
    const { chatId } = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, waiting: true, unread: 3 });
    const { headers } = await loginAs(app, s.agentA.email);
    const post = (path: string, payload?: object) =>
      app.inject({ method: 'POST', url: `/api/chats/${chatId}/${path}`, headers, ...(payload ? { payload } : {}) });

    const assumed = await post('assume');
    expect(assumed.statusCode).toBe(200);
    expect(assumed.json().ownerId).toBe(s.agentA.id);

    expect((await post('read')).statusCode).toBe(204);
    const detail = await app.inject({ method: 'GET', url: `/api/chats/${chatId}`, headers });
    expect(detail.json().unread).toBe(0);

    const priv = await post('privacy', { private: true });
    expect(priv.statusCode).toBe(200);
    expect(priv.json().private).toBe(true);
    expect((await post('privacy', { private: 'sim' })).statusCode).toBe(400);

    const closed = await post('close', { sendClosingMessage: false });
    expect(closed.statusCode).toBe(200);
    expect(closed.json().state).toBe('closed');
    expect(closed.json().closedAt).not.toBeNull();
    expect((await post('close', { sendClosingMessage: false })).statusCode).toBe(409);

    const reopened = await post('reopen');
    expect(reopened.statusCode).toBe(200);
    expect(reopened.json().state).toBe('open');
  });

  it('transfer answers with the new detail and then hides the chat from the agent', async () => {
    const { chatId } = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA });
    const { headers } = await loginAs(app, s.agentA.email);

    const bad = await app.inject({ method: 'POST', url: `/api/chats/${chatId}/transfer`, headers, payload: {} });
    expect(bad.statusCode).toBe(400);

    const res = await app.inject({
      method: 'POST', url: `/api/chats/${chatId}/transfer`, headers, payload: { sectorId: s.sectorB },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sectorId).toBe(s.sectorB);
    expect((await app.inject({ method: 'GET', url: `/api/chats/${chatId}`, headers })).statusCode).toBe(404);
  });

  it('close with sendClosingMessage sends settings.closing_message to the contact', async () => {
    await ctx.db
      .insert(settings)
      .values({ key: 'closing_message', value: 'Obrigado pelo contato!' })
      .onConflictDoUpdate({ target: settings.key, set: { value: 'Obrigado pelo contato!' } });
    const { chatId } = await seedChat(ctx, {
      channelId: s.channelId, sectorId: s.sectorA, ownerId: s.agentA.id, phone: '5565999990001',
    });
    const { headers } = await loginAs(app, s.agentA.email);

    const res = await app.inject({
      method: 'POST', url: `/api/chats/${chatId}/close`, headers, payload: { sendClosingMessage: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBe('closed');
    const sent = ctx.wa.sent.find((x) => x.method === 'sendText');
    expect(sent?.phone).toBe('5565999990001');
    expect(JSON.stringify(sent?.payload)).toContain('Obrigado pelo contato!');
  });

  it('pin and unpin answer 204; a fourth pin is 409', async () => {
    const chatIds: string[] = [];
    for (let i = 0; i < 4; i++) {
      chatIds.push((await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA })).chatId);
    }
    const { headers } = await loginAs(app, s.agentA.email);
    const pin = (id: string, method: 'PUT' | 'DELETE') => app.inject({ method, url: `/api/chats/${id}/pin`, headers });

    for (const id of chatIds.slice(0, 3)) expect((await pin(id, 'PUT')).statusCode).toBe(204);
    expect((await pin(chatIds[3], 'PUT')).statusCode).toBe(409);
    expect((await pin(chatIds[0], 'DELETE')).statusCode).toBe(204);
    expect((await pin(chatIds[3], 'PUT')).statusCode).toBe(204);

    const list = (await app.inject({ method: 'GET', url: '/api/chats', headers })).json();
    const pinnedIds = list.items.filter((i: { pinned: boolean }) => i.pinned).map((i: { id: string }) => i.id);
    expect(pinnedIds.sort()).toEqual(chatIds.slice(1).sort());
  });

  it('every action on a chat of another sector is 404 and nothing is sent', async () => {
    const { chatId } = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorB, phone: '5511988887777' });
    const { headers } = await loginAs(app, s.agentA.email);
    const calls: Array<{ method: 'POST' | 'PUT'; path: string; payload?: object }> = [
      { method: 'POST', path: 'assume' },
      { method: 'POST', path: 'reopen' },
      { method: 'POST', path: 'read' },
      { method: 'POST', path: 'close', payload: { sendClosingMessage: false } },
      { method: 'POST', path: 'privacy', payload: { private: true } },
      { method: 'POST', path: 'transfer', payload: { sectorId: s.sectorA } },
      { method: 'PUT', path: 'pin' },
      { method: 'POST', path: 'notes', payload: { text: 'x' } },
      { method: 'POST', path: 'messages', payload: { text: 'x', signature: false } },
    ];
    for (const c of calls) {
      const res = await app.inject({
        method: c.method, url: `/api/chats/${chatId}/${c.path}`, headers, ...(c.payload ? { payload: c.payload } : {}),
      });
      expect(res.statusCode, c.path).toBe(404);
    }
    expect(ctx.wa.sent).toHaveLength(0);
  });
});

describe('POST /api/chats (start a conversation)', () => {
  it('creates contact and chat for a new phone, then reuses the open chat', async () => {
    const { headers } = await loginAs(app, s.agentA.email);
    const start = (payload: object) => app.inject({ method: 'POST', url: '/api/chats', headers, payload });

    const first = await start({ phone: '(65) 9999-0002', name: 'Novo Cliente' });
    expect(first.statusCode).toBe(200);
    const chat = first.json();
    expect(chat.contact.phone).toBe('5565999990002');
    expect(chat.contact.name).toBe('Novo Cliente');
    expect(chat.ownerId).toBe(s.agentA.id);
    expect(chat.sectorId).toBe(s.defaultSector);
    expect(chat.state).toBe('open');
    expect(chat.waiting).toBe(false);
    expect(chat.triagePending).toBe(false);

    const again = await start({ phone: '5565999990002' });
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(chat.id);

    expect((await start({})).statusCode).toBe(400);
  });
});

describe('POST /api/chats/:id/messages, notes and resend', () => {
  it('sends JSON text through the gateway', async () => {
    const { chatId } = await seedChat(ctx, {
      channelId: s.channelId, sectorId: s.sectorA, ownerId: s.agentA.id, phone: '5565999990001',
    });
    const { headers } = await loginAs(app, s.agentA.email);

    const res = await app.inject({
      method: 'POST', url: `/api/chats/${chatId}/messages`, headers, payload: { text: 'Bom dia', signature: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ chatId, direction: 'out', kind: 'text', body: 'Bom dia' });
    expect(ctx.wa.sent.at(-1)).toMatchObject({ method: 'sendText', phone: '5565999990001' });

    const empty = await app.inject({
      method: 'POST', url: `/api/chats/${chatId}/messages`, headers, payload: { text: '   ', signature: false },
    });
    expect(empty.statusCode).toBe(400);
  });

  it('sends a multipart file as media and rejects multipart without a file', async () => {
    const { chatId } = await seedChat(ctx, {
      channelId: s.channelId, sectorId: s.sectorA, ownerId: s.agentA.id, phone: '5565999990001',
    });
    const { headers } = await loginAs(app, s.agentA.email);

    const body = multipart(
      { text: 'Segue o contrato', signature: 'false' },
      { name: 'contrato.pdf', mime: 'application/pdf', data: Buffer.from('%PDF-1.4 teste') },
    );
    const res = await app.inject({
      method: 'POST', url: `/api/chats/${chatId}/messages`,
      headers: { ...headers, 'content-type': body.contentType }, payload: body.payload,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().kind).toBe('document');
    expect(res.json().media).not.toBeNull();
    expect(ctx.wa.sent.at(-1)).toMatchObject({ method: 'sendMedia', phone: '5565999990001' });

    const noFile = multipart({ text: 'sem arquivo', signature: 'false' });
    const bad = await app.inject({
      method: 'POST', url: `/api/chats/${chatId}/messages`,
      headers: { ...headers, 'content-type': noFile.contentType }, payload: noFile.payload,
    });
    expect(bad.statusCode).toBe(400);
  });

  it('adds an internal note without sending anything, and resends a failed message', async () => {
    const { chatId } = await seedChat(ctx, {
      channelId: s.channelId, sectorId: s.sectorA, ownerId: s.agentA.id, phone: '5565999990001',
    });
    const { headers } = await loginAs(app, s.agentA.email);

    const note = await app.inject({
      method: 'POST', url: `/api/chats/${chatId}/notes`, headers, payload: { text: 'Cliente pediu retorno' },
    });
    expect(note.statusCode).toBe(200);
    expect(note.json()).toMatchObject({ kind: 'note', body: 'Cliente pediu retorno' });
    expect(ctx.wa.sent).toHaveLength(0);

    ctx.wa.failNext();
    const failed = await app.inject({
      method: 'POST', url: `/api/chats/${chatId}/messages`, headers, payload: { text: 'Olá', signature: false },
    });
    expect(failed.statusCode).toBe(200);
    expect(failed.json().status).toBe('failed');

    const resent = await app.inject({ method: 'POST', url: `/api/messages/${failed.json().id}/resend`, headers });
    expect(resent.statusCode).toBe(200);
    expect(resent.json().status).not.toBe('failed');
  });
});
```

- [ ] **Step 10: Run the tests to verify they fail**

Run: `npm test -w server -- test/chats/actions.test.ts`
Expected: FAIL. The action, start, messages, notes, pin and resend routes do not exist yet, so assertions report `expected 404 to be 200` (or `to be 204`). The "another sector is 404" test may pass by accident because the routes are missing; it guards against regressions after Step 12.

- [ ] **Step 11: Install `@fastify/multipart`**

Run: `npm install --save-exact -w server @fastify/multipart@10.1.3`
Expected: `server/package.json` lists `"@fastify/multipart": "10.1.3"`. If an earlier task already added it, nothing changes.

- [ ] **Step 12: Write the final `server/src/chats/routes.ts` (replace the whole file)**

```ts
import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppCtx } from '../ctx.js';
import {
  assumeChat, closeChat, markChatRead, pinChat, reopenChat, setChatPrivacy, startChat, transferChat,
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
const transferBody = z
  .object({ sectorId: z.uuid().optional(), ownerId: z.uuid().nullable().optional() })
  .refine((b) => b.sectorId !== undefined || b.ownerId !== undefined, 'Informe o setor ou o atendente');
const privacyBody = z.object({ private: z.boolean() });
const closeBody = z.object({ sendClosingMessage: z.boolean().default(false) });
const textBody = z.object({
  text: z.string().trim().min(1).max(4096),
  signature: z.boolean().default(true),
  replyToId: z.uuid().optional(),
});
const multipartFields = z.object({
  text: z.string().trim().max(4096).optional(),
  signature: z.stringbool().default(true),
  asVoice: z.stringbool().default(false),
  replyToId: z.uuid().optional(),
});
const noteBody = z.object({ text: z.string().trim().min(1).max(4096) });

const me = (req: FastifyRequest) => req.user as AuthUser;

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
    // @fastify/multipart limit errors carry statusCode 413; the global handler would turn them into 500.
    if ((err as { statusCode?: number }).statusCode === 413) {
      throw new HttpError(413, 'Envie um único arquivo de até 64 MB');
    }
    throw err;
  }
  if (!file) throw badRequest('Arquivo ausente');
  const f = multipartFields.parse(fields);
  return { file, text: f.text || undefined, signature: f.signature, asVoice: f.asVoice, replyToId: f.replyToId };
}

export async function chatRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  await app.register(async (r) => {
    // Scoped so another route file can register multipart too without a decorator clash.
    if (!r.hasContentTypeParser('multipart/form-data')) await r.register(multipart);

    r.get('/api/chats', async (req) => listChats(ctx, me(req), listQuery.parse(req.query)));

    r.post('/api/chats', async (req) => {
      const user = me(req);
      const chat = await startChat(ctx, user, startBody.parse(req.body));
      return toChatDetail(ctx.db, chat, user.id);
    });

    r.get('/api/chats/:id', async (req) => getChatDetail(ctx, me(req), idParams.parse(req.params).id));

    r.get('/api/chats/:id/timeline', async (req) => {
      const { id } = idParams.parse(req.params);
      return getTimeline(ctx, me(req), id, timelineQuery.parse(req.query));
    });

    // The detail is built from the row the service returned, without a second visibility check:
    // after a transfer the caller may no longer see the chat but still gets its new state.
    const action = (path: string, run: (user: AuthUser, id: string, body: unknown) => Promise<ChatRow>) =>
      r.post(`/api/chats/:id/${path}`, async (req) => {
        const user = me(req);
        const { id } = idParams.parse(req.params);
        return toChatDetail(ctx.db, await run(user, id, req.body), user.id);
      });

    action('assume', (user, id) => assumeChat(ctx, user, id));
    action('reopen', (user, id) => reopenChat(ctx, user, id));
    action('transfer', (user, id, body) => transferChat(ctx, user, id, transferBody.parse(body)));
    action('privacy', (user, id, body) => setChatPrivacy(ctx, user, id, privacyBody.parse(body).private));
    action('close', (user, id, body) =>
      closeChat(ctx, user, id, {
        sendClosingMessage: closeBody.parse(body ?? {}).sendClosingMessage,
        // Closing text is the office's canned message, so it goes without the agent signature.
        sendClosing: async (text: string) => {
          await sendAgentMessage(ctx, user, id, { text, signature: false });
        },
      }),
    );

    r.post('/api/chats/:id/read', async (req, reply) => {
      await markChatRead(ctx, me(req), idParams.parse(req.params).id);
      return reply.code(204).send();
    });

    r.put('/api/chats/:id/pin', async (req, reply) => {
      await pinChat(ctx, me(req), idParams.parse(req.params).id, true);
      return reply.code(204).send();
    });

    r.delete('/api/chats/:id/pin', async (req, reply) => {
      await pinChat(ctx, me(req), idParams.parse(req.params).id, false);
      return reply.code(204).send();
    });

    r.post('/api/chats/:id/messages', async (req) => {
      const { id } = idParams.parse(req.params);
      const input: SendInput = req.isMultipart() ? await readMultipart(req) : textBody.parse(req.body);
      return sendAgentMessage(ctx, me(req), id, input);
    });

    r.post('/api/chats/:id/notes', async (req) => {
      const { id } = idParams.parse(req.params);
      return addNote(ctx, me(req), id, noteBody.parse(req.body).text);
    });

    r.post('/api/messages/:id/resend', async (req) =>
      resendMessage(ctx, me(req), idParams.parse(req.params).id),
    );
  });
}
```

- [ ] **Step 13: Run both chat test files and the typecheck**

Run: `npm test -w server -- test/chats/`
Expected: PASS (7 tests in `list-and-timeline.test.ts`, 9 in `actions.test.ts`).

Run: `npx tsc -p server --noEmit`
Expected: no errors.

- [ ] **Step 14: Run the whole server suite**

Run: `npm test -w server`
Expected: PASS. The realtime tests from Task 8 still pass with the new `toChatListItem`, which now returns `contact`, `pinned` and `tagIds`.

- [ ] **Step 15: Commit**

```bash
git add server/src/chats/routes.ts server/package.json package-lock.json server/test/chats/actions.test.ts
git commit -m "feat(chats): chat actions, start chat, send text/file, notes and resend routes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


---

### Task 14: Channels service, routes and startup sync

**Files:**
- Create (or replace, if Task 9 already created it with only `setChannelStatus` / `getChannelByInstance`): `server/src/channels/service.ts`
- Create: `server/src/channels/routes.ts`
- Replace (Task 9 created it): `server/src/webhooks/routes.ts`
- Modify: `server/src/app.ts` (register `registerChannelRoutes` inside `buildApp`; add the SPA static serving + JSON 404 as the last block. Task 9's `registerWebhookRoutes` import and call stay untouched)
- Modify: `server/src/messages/ingest.ts` (import `setChannelStatus` / `getChannelByInstance` from `channels/service.ts`, drop any local copy, so there is ONE implementation)
- Create: `server/src/index.ts` (production entry; Task 1 left it to a later task)
- Test: `server/test/channels/service.test.ts`
- Test: `server/test/channels/routes.test.ts`
- Replace (Task 9 created it): `server/test/webhooks/routes.test.ts`
- Test: `server/test/spa.test.ts`

**Interfaces:**
- Consumes:
  - `AppCtx { db: Db; wa: WhatsAppGateway; hub: Hub; config: Config }` from `server/src/ctx.ts`
  - `Db`, `Tx`, `createPgDb(url: string): Db` from `server/src/db/client.ts`; `runMigrations(db)` from `server/src/db/migrate.ts`
  - `channels` table (`id`, `name`, `kind`, `evolutionInstance`, `status`, `phone`, `createdAt`) and `messages`, `contacts` from `server/src/db/schema.ts`
  - `WhatsAppGateway.createInstance(instance, webhookUrl): Promise<void>`, `.connect(instance): Promise<{ qrBase64: string | null }>`, `.connectionState(instance): Promise<ChannelStatus>`; `ChannelStatus`, `InboundEvent` from `server/src/whatsapp/types.ts`
  - `createEvolutionGateway(cfg: { url: string; apiKey: string }): WhatsAppGateway` (Task 4)
  - `parseEvolutionWebhook(body: unknown): InboundEvent[]` (Task 5)
  - `handleInbound(ctx: AppCtx, events: InboundEvent[]): Promise<void>` (Task 9)
  - `Hub.publishChannel(channelId: string): Promise<void>`, `createHub(getDb: () => Db): Hub` (Task 8)
  - `requireUser(request: FastifyRequest): AuthUser | Promise<AuthUser>` (throws `HttpError` 401) and `requireAdmin(request: FastifyRequest): AuthUser | Promise<AuthUser>` (throws 401/403) from `server/src/auth/plugin.ts` (Task 6)
  - `HttpError`, `notFound()` from `server/src/lib/http-error.ts`; `loadConfig(env)` from `server/src/config.ts`; `buildApp(ctx)` from `server/src/app.ts`
  - `ChannelDto` from the shared workspace package (`@talk/shared`, the name Task 1 gave `shared/package.json`; use that exact name if it differs)
  - Test helpers: `makeTestCtx()`, `makeTestApp(ctx?)`, `seedBasics(ctx)` (channel instance `'talk-test'`), `loginAs(app, email)` from `server/test/helpers.ts`
- Produces:
  - `server/src/channels/service.ts`:
    ```ts
    export function toChannelDto(row: typeof channels.$inferSelect): ChannelDto;
    export async function listChannels(db: Db | Tx): Promise<ChannelDto[]>;
    export async function getChannelByInstance(db: Db | Tx, instance: string): Promise<typeof channels.$inferSelect | null>;
    export async function createChannel(ctx: AppCtx, name: string): Promise<ChannelDto>;
    export async function connectChannel(ctx: AppCtx, channelId: string): Promise<{ qrBase64: string | null }>;
    export async function syncChannelStatuses(ctx: AppCtx): Promise<void>;
    export async function setChannelStatus(ctx: AppCtx, instance: string, status: ChannelStatus): Promise<void>; // publishes channel.status only when the stored value changes
    ```
  - `server/src/channels/routes.ts`: `export function registerChannelRoutes(app: FastifyInstance, ctx: AppCtx): void` — `GET /api/channels` (user) → `ChannelDto[]`; `POST /api/channels` `{name}` (admin) → `ChannelDto`; `POST /api/channels/:id/connect` (admin) → `{ qrBase64: string | null }`.
  - `server/src/app.ts` (`buildApp`, last block): when `config.webDistDir` holds an `index.html`, `@fastify/static` serves the build and any other `GET` outside `/api/`, `/ws` and `/webhooks/` falls back to `index.html` (client-side routes); everything else that matches no route → 404 `{ error: 'Não encontrado' }`.
  - `server/src/webhooks/routes.ts` (same signature as Task 9, body replaced): `export function registerWebhookRoutes(app: FastifyInstance, ctx: AppCtx): void` — `POST /webhooks/evolution/:secret`. Status codes: wrong secret → 401 (Evolution does not retry 4xx); unparseable/unknown payload → 200 + log line with only the event name; `handleInbound` failure (DB down) → 500 so Evolution retries (safe: ingest is idempotent on `(channel_id, external_id)`); success → 200 `{ ok: true }`.
  - `server/src/index.ts`: production entry (no exports).

---

- [ ] **Step 1: Write the failing service test**

Create `server/test/channels/service.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { channels } from '../../src/db/schema.js';
import {
  connectChannel,
  createChannel,
  getChannelByInstance,
  setChannelStatus,
  syncChannelStatuses,
} from '../../src/channels/service.js';
import { makeTestCtx, seedBasics } from '../helpers.js';

type Ctx = Awaited<ReturnType<typeof makeTestCtx>>;
type Seed = Awaited<ReturnType<typeof seedBasics>>;

let ctx: Ctx;
let seed: Seed;

beforeEach(async () => {
  ctx = await makeTestCtx();
  seed = await seedBasics(ctx);
  await ctx.db.update(channels).set({ status: 'disconnected' }).where(eq(channels.id, seed.channelId));
});

async function statusOf(id: string) {
  const [row] = await ctx.db.select().from(channels).where(eq(channels.id, id));
  return row!.status;
}

const channelEvents = (id: string) => ctx.hub.events.filter((e) => e.channelId === id).length;

describe('createChannel', () => {
  it('stores a disconnected channel and creates the Evolution instance pointing at the internal webhook', async () => {
    const spy = vi.spyOn(ctx.wa, 'createInstance').mockResolvedValue(undefined);

    const dto = await createChannel(ctx, 'Escritório');

    expect(dto).toEqual({ id: expect.any(String), name: 'Escritório', status: 'disconnected', phone: null });
    const instance = `talk-${dto.id.slice(0, 8)}`;
    expect(spy).toHaveBeenCalledWith(
      instance,
      `${ctx.config.webhookBaseUrl}/webhooks/evolution/${ctx.config.webhookSecret}`,
    );
    expect((await getChannelByInstance(ctx.db, instance))?.id).toBe(dto.id);
  });

  it('removes the row when Evolution refuses the instance', async () => {
    vi.spyOn(ctx.wa, 'createInstance').mockRejectedValue(new Error('evolution fora do ar'));

    await expect(createChannel(ctx, 'Falhou')).rejects.toThrow('evolution fora do ar');

    const rows = await ctx.db.select().from(channels).where(eq(channels.name, 'Falhou'));
    expect(rows).toHaveLength(0);
  });
});

describe('connectChannel', () => {
  it('returns the QR, marks the channel connecting and publishes channel.status', async () => {
    vi.spyOn(ctx.wa, 'connect').mockResolvedValue({ qrBase64: 'data:image/png;base64,QRTESTE' });

    await expect(connectChannel(ctx, seed.channelId)).resolves.toEqual({ qrBase64: 'data:image/png;base64,QRTESTE' });

    expect(await statusOf(seed.channelId)).toBe('connecting');
    expect(channelEvents(seed.channelId)).toBe(1);
  });

  it('without a QR asks Evolution for the real state instead of guessing', async () => {
    vi.spyOn(ctx.wa, 'connect').mockResolvedValue({ qrBase64: null });
    vi.spyOn(ctx.wa, 'connectionState').mockResolvedValue('connected');

    await expect(connectChannel(ctx, seed.channelId)).resolves.toEqual({ qrBase64: null });

    expect(await statusOf(seed.channelId)).toBe('connected');
  });

  it('rejects an unknown channel with 404', async () => {
    await expect(connectChannel(ctx, crypto.randomUUID())).rejects.toMatchObject({ status: 404 });
  });
});

describe('setChannelStatus / syncChannelStatuses', () => {
  it('sync corrects a stale status and publishes only when it changes', async () => {
    vi.spyOn(ctx.wa, 'connectionState').mockResolvedValue('connected');

    await syncChannelStatuses(ctx);
    expect(await statusOf(seed.channelId)).toBe('connected');
    expect(channelEvents(seed.channelId)).toBe(1);

    await syncChannelStatuses(ctx);
    expect(channelEvents(seed.channelId)).toBe(1);
  });

  it('setChannelStatus ignores an unknown instance', async () => {
    await setChannelStatus(ctx, 'talk-naoexiste', 'connected');
    expect(ctx.hub.events.filter((e) => e.channelId)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w server -- test/channels/service.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/channels/service.js"` (or, if Task 9 already created the file, `createChannel is not a function` / missing export errors).

- [ ] **Step 3: Write the service**

Create (or fully replace) `server/src/channels/service.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { and, asc, eq, ne } from 'drizzle-orm';
import type { ChannelDto } from '@talk/shared';
import type { AppCtx } from '../ctx.js';
import type { Db, Tx } from '../db/client.js';
import { channels } from '../db/schema.js';
import { notFound } from '../lib/http-error.js';
import type { ChannelStatus } from '../whatsapp/types.js';

type ChannelRow = typeof channels.$inferSelect;

export function toChannelDto(row: ChannelRow): ChannelDto {
  return { id: row.id, name: row.name, status: row.status, phone: row.phone };
}

export async function listChannels(db: Db | Tx): Promise<ChannelDto[]> {
  const rows = await db.select().from(channels).orderBy(asc(channels.createdAt));
  return rows.map(toChannelDto);
}

export async function getChannelByInstance(db: Db | Tx, instance: string): Promise<ChannelRow | null> {
  const [row] = await db.select().from(channels).where(eq(channels.evolutionInstance, instance)).limit(1);
  return row ?? null;
}

export async function createChannel(ctx: AppCtx, name: string): Promise<ChannelDto> {
  const id = randomUUID();
  const instance = `talk-${id.slice(0, 8)}`;
  const [row] = await ctx.db
    .insert(channels)
    .values({ id, name, kind: 'whatsapp_qr', evolutionInstance: instance, status: 'disconnected' })
    .returning();
  try {
    await ctx.wa.createInstance(instance, `${ctx.config.webhookBaseUrl}/webhooks/evolution/${ctx.config.webhookSecret}`);
  } catch (err) {
    // no orphan channel the admin can never connect
    await ctx.db.delete(channels).where(eq(channels.id, id));
    throw err;
  }
  return toChannelDto(row!);
}

export async function connectChannel(ctx: AppCtx, channelId: string): Promise<{ qrBase64: string | null }> {
  const [row] = await ctx.db.select().from(channels).where(eq(channels.id, channelId)).limit(1);
  if (!row) throw notFound();
  const { qrBase64 } = await ctx.wa.connect(row.evolutionInstance);
  // no QR means Evolution already holds an open session: ask instead of assuming "connecting"
  const status = qrBase64 ? 'connecting' : await ctx.wa.connectionState(row.evolutionInstance);
  await setChannelStatus(ctx, row.evolutionInstance, status);
  return { qrBase64 };
}

// Single implementation, also used by messages/ingest.ts for connection.update webhooks.
export async function setChannelStatus(ctx: AppCtx, instance: string, status: ChannelStatus): Promise<void> {
  const changed = await ctx.db
    .update(channels)
    .set({ status })
    .where(and(eq(channels.evolutionInstance, instance), ne(channels.status, status)))
    .returning({ id: channels.id });
  for (const { id } of changed) await ctx.hub.publishChannel(id);
}

// ponytail: sequential, first Evolution failure aborts the rest; fine for one number, use Promise.allSettled when there are many channels
export async function syncChannelStatuses(ctx: AppCtx): Promise<void> {
  const rows = await ctx.db.select({ instance: channels.evolutionInstance }).from(channels);
  for (const { instance } of rows) {
    await setChannelStatus(ctx, instance, await ctx.wa.connectionState(instance));
  }
}
```

- [ ] **Step 4: Make the service the only implementation**

Run: `grep -rn "function setChannelStatus\|function getChannelByInstance" server/src`
Expected: exactly two lines, both in `server/src/channels/service.ts`.

If another file is listed (Task 9 may have defined them inside `server/src/messages/ingest.ts`), delete that function body from that file and add to that file's imports:

```ts
import { getChannelByInstance, setChannelStatus } from '../channels/service.js';
```

(keep only the names that file actually uses). Re-run the grep until it shows only `server/src/channels/service.ts`.

- [ ] **Step 5: Run the service test and the ingest tests**

Run: `npm test -w server -- test/channels/service.test.ts test/messages`
Expected: PASS (all service tests green; Task 9 ingest tests still green after the import change).

- [ ] **Step 6: Commit**

```bash
git add server/src/channels/service.ts server/src/messages/ingest.ts server/test/channels/service.test.ts
git commit -m "feat(channels): channel service with create, connect, status sync

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Write the failing channel routes test**

Create `server/test/channels/routes.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loginAs, makeTestApp, makeTestCtx, seedBasics } from '../helpers.js';

type Ctx = Awaited<ReturnType<typeof makeTestCtx>>;
type Seed = Awaited<ReturnType<typeof seedBasics>>;

let ctx: Ctx;
let seed: Seed;
let app: FastifyInstance;

beforeEach(async () => {
  ctx = await makeTestCtx();
  seed = await seedBasics(ctx);
  ({ app } = await makeTestApp(ctx));
});

afterEach(async () => {
  await app.close();
});

describe('channel routes', () => {
  it('GET /api/channels lists channels for any logged user', async () => {
    const agent = await loginAs(app, seed.agentA.email);
    const res = await app.inject({ method: 'GET', url: '/api/channels', headers: agent.headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toContainEqual({
      id: seed.channelId,
      name: expect.any(String),
      status: expect.stringMatching(/^(disconnected|connecting|connected)$/),
      phone: null,
    });
  });

  it('GET /api/channels without session is 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/channels' });
    expect(res.statusCode).toBe(401);
  });

  it('POST /api/channels is admin only', async () => {
    const agent = await loginAs(app, seed.agentA.email);
    const res = await app.inject({ method: 'POST', url: '/api/channels', headers: agent.headers, payload: { name: 'Outro' } });
    expect(res.statusCode).toBe(403);
  });

  it('POST /api/channels creates the channel and the Evolution instance', async () => {
    const spy = vi.spyOn(ctx.wa, 'createInstance').mockResolvedValue(undefined);
    const admin = await loginAs(app, seed.admin.email);

    const res = await app.inject({ method: 'POST', url: '/api/channels', headers: admin.headers, payload: { name: '  Escritório  ' } });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({ id: expect.any(String), name: 'Escritório', status: 'disconnected', phone: null });
    expect(spy).toHaveBeenCalledWith(`talk-${body.id.slice(0, 8)}`, expect.stringContaining('/webhooks/evolution/'));
  });

  it('POST /api/channels rejects an empty name with 400', async () => {
    const admin = await loginAs(app, seed.admin.email);
    const res = await app.inject({ method: 'POST', url: '/api/channels', headers: admin.headers, payload: { name: '   ' } });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/channels/:id/connect returns the QR for admins', async () => {
    vi.spyOn(ctx.wa, 'connect').mockResolvedValue({ qrBase64: 'data:image/png;base64,QRTESTE' });
    const admin = await loginAs(app, seed.admin.email);

    const res = await app.inject({ method: 'POST', url: `/api/channels/${seed.channelId}/connect`, headers: admin.headers });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ qrBase64: 'data:image/png;base64,QRTESTE' });
  });

  it('POST /api/channels/:id/connect with an unknown id is 404', async () => {
    const admin = await loginAs(app, seed.admin.email);
    const res = await app.inject({ method: 'POST', url: `/api/channels/${crypto.randomUUID()}/connect`, headers: admin.headers });
    expect(res.statusCode).toBe(404);
  });
});
```

(The seeded channel has no phone, per the contract's `seedBasics`; if Task 2's `seedBasics` stores one, use `phone: expect.any(String)`.)

- [ ] **Step 8: Run it to verify it fails**

Run: `npm test -w server -- test/channels/routes.test.ts`
Expected: FAIL — `GET /api/channels` returns 404 (`Route GET:/api/channels not found`), so `expected 404 to be 200`.

- [ ] **Step 9: Write the channel routes and register them**

Create `server/src/channels/routes.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppCtx } from '../ctx.js';
import { requireAdmin, requireUser } from '../auth/plugin.js';
import { connectChannel, createChannel, listChannels } from './service.js';

const createBody = z.object({ name: z.string().trim().min(1).max(60) });
const idParams = z.object({ id: z.uuid() });

export function registerChannelRoutes(app: FastifyInstance, ctx: AppCtx): void {
  app.get('/api/channels', async (request) => {
    await requireUser(request);
    return listChannels(ctx.db);
  });

  app.post('/api/channels', async (request) => {
    await requireAdmin(request);
    const { name } = createBody.parse(request.body);
    return createChannel(ctx, name);
  });

  app.post('/api/channels/:id/connect', async (request) => {
    await requireAdmin(request);
    const { id } = idParams.parse(request.params);
    return connectChannel(ctx, id);
  });
}
```

In `server/src/app.ts`, add the import at the top:

```ts
import { registerChannelRoutes } from './channels/routes.js';
```

and, inside `buildApp`, right after the existing route registrations (the SPA block added in Step 19 goes after it, as the last block), add:

```ts
  registerChannelRoutes(app, ctx);
```

- [ ] **Step 10: Run it to verify it passes**

Run: `npm test -w server -- test/channels/routes.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 11: Commit**

```bash
git add server/src/channels/routes.ts server/src/app.ts server/test/channels/routes.test.ts
git commit -m "feat(channels): list, create and connect channel routes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 12: Write the failing webhook route test**

Replace the whole content of `server/test/webhooks/routes.test.ts` (created by Task 9; this version keeps its cases and adds dedup, `connection.update` and the 500-on-failure case):

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { channels, contacts, messages } from '../../src/db/schema.js';
import { makeTestApp, makeTestCtx, seedBasics } from '../helpers.js';

type Ctx = Awaited<ReturnType<typeof makeTestCtx>>;
type Seed = Awaited<ReturnType<typeof seedBasics>>;

let ctx: Ctx;
let seed: Seed;
let app: FastifyInstance;

beforeEach(async () => {
  ctx = await makeTestCtx();
  seed = await seedBasics(ctx);
  ({ app } = await makeTestApp(ctx));
});

afterEach(async () => {
  await app.close();
});

// Synthetic Evolution v2 messages.upsert (no real data). 12-digit JID: DDD 65 mobile without the 9.
function upsert(externalId: string) {
  return {
    event: 'messages.upsert',
    instance: seed.instance,
    data: {
      key: { remoteJid: '556599990001@s.whatsapp.net', fromMe: false, id: externalId },
      pushName: 'Cliente Webhook',
      message: { conversation: 'Olá, preciso falar com o escritório' },
      messageType: 'conversation',
      messageTimestamp: 1760450000,
      source: 'android',
    },
    date_time: '2026-10-14T12:00:00.000Z',
    sender: '556500000000@s.whatsapp.net',
    server_url: 'http://evolution:8080',
  };
}

const post = (secret: string, payload: unknown) =>
  app.inject({ method: 'POST', url: `/webhooks/evolution/${secret}`, payload: payload as object });

describe('POST /webhooks/evolution/:secret', () => {
  it('rejects a wrong secret with 401 and stores nothing', async () => {
    const res = await post('segredo-errado', upsert('3EB0WEBHOOK00001'));
    expect(res.statusCode).toBe(401);
    expect(await ctx.db.select().from(messages).where(eq(messages.externalId, '3EB0WEBHOOK00001'))).toHaveLength(0);
  });

  it('stores an incoming message end-to-end, once, even when delivered twice', async () => {
    const first = await post(ctx.config.webhookSecret, upsert('3EB0WEBHOOK00002'));
    const second = await post(ctx.config.webhookSecret, upsert('3EB0WEBHOOK00002'));

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const rows = await ctx.db.select().from(messages).where(eq(messages.externalId, '3EB0WEBHOOK00002'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.direction).toBe('in');
    expect(rows[0]!.body).toBe('Olá, preciso falar com o escritório');
    expect(await ctx.db.select().from(contacts).where(eq(contacts.phone, '5565999990001'))).toHaveLength(1);
  });

  it('applies connection.update to the channel status through the shared setChannelStatus', async () => {
    await ctx.db.update(channels).set({ status: 'disconnected' }).where(eq(channels.id, seed.channelId));

    const res = await post(ctx.config.webhookSecret, {
      event: 'connection.update',
      instance: seed.instance,
      data: { instance: seed.instance, state: 'open', statusReason: 200 },
    });

    expect(res.statusCode).toBe(200);
    const [row] = await ctx.db.select().from(channels).where(eq(channels.id, seed.channelId));
    expect(row!.status).toBe('connected');
    expect(ctx.hub.events).toContainEqual(expect.objectContaining({ channelId: seed.channelId }));
  });

  it('answers 200 to an unknown payload', async () => {
    expect((await post(ctx.config.webhookSecret, { event: 'algo.novo', foo: 1 })).statusCode).toBe(200);
    expect((await post(ctx.config.webhookSecret, [1, 2, 3])).statusCode).toBe(200);
  });

  it('answers 500 when the database fails, so Evolution retries', async () => {
    // handleInbound stores messages inside ctx.db.transaction (Task 9)
    vi.spyOn(ctx.db, 'transaction').mockRejectedValue(Object.assign(new Error('banco fora do ar'), { code: '57P01' }));

    const res = await post(ctx.config.webhookSecret, upsert('3EB0WEBHOOK00003'));

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'Ocorreu um erro' });
  });
});
```

- [ ] **Step 13: Run it to verify it fails**

Run: `npm test -w server -- test/webhooks/routes.test.ts`
Expected: FAIL in `answers 500 when the database fails` only. Task 9's route lets the error reach the global error handler, so the body is `{ error, correlationId }` and `toEqual({ error: 'Ocorreu um erro' })` fails. The other cases already pass on Task 9's route (if the `[1, 2, 3]` case also fails there, the replacement below fixes it too).

- [ ] **Step 14: Replace the webhook route**

Replace the whole content of `server/src/webhooks/routes.ts` (created by Task 9). Do NOT touch `server/src/app.ts`: Task 9's `import { registerWebhookRoutes } from './webhooks/routes.js';` and its `registerWebhookRoutes(app, ctx);` call stay as they are. A second import is a SyntaxError and a second registration throws `FST_ERR_DUPLICATED_ROUTE`.

```ts
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AppCtx } from '../ctx.js';
import { HttpError } from '../lib/http-error.js';
import { handleInbound } from '../messages/ingest.js';
import { parseEvolutionWebhook } from '../whatsapp/parse.js';
import type { InboundEvent } from '../whatsapp/types.js';

const sha256 = (value: string) => createHash('sha256').update(value).digest();

const eventName = (body: unknown) =>
  body && typeof body === 'object' && 'event' in body ? String((body as { event: unknown }).event) : null;

export function registerWebhookRoutes(app: FastifyInstance, ctx: AppCtx): void {
  const expected = sha256(ctx.config.webhookSecret);

  app.post<{ Params: { secret: string } }>(
    '/webhooks/evolution/:secret',
    { bodyLimit: 16 * 1024 * 1024 },
    async (request, reply) => {
      // hashing both sides makes the lengths equal, so the compare is constant-time and never throws
      if (!timingSafeEqual(sha256(request.params.secret), expected)) throw new HttpError(401, 'Não autorizado');

      let events: InboundEvent[];
      try {
        events = parseEvolutionWebhook(request.body);
      } catch {
        // §7: unknown payload → 200 + warning, never crash; log only the event name, never the body
        request.log.warn({ event: eventName(request.body) }, 'webhook: payload não reconhecido');
        return { ok: true };
      }
      for (const e of events) {
        if (e.type === 'ignored') request.log.info({ reason: e.reason }, 'webhook: evento ignorado');
      }

      try {
        await handleInbound(ctx, events);
      } catch (err) {
        // 500 makes Evolution retry (it does not retry 4xx); ingest is idempotent on (channel_id, external_id).
        // Log only the error code: driver/Drizzle messages may carry query params, i.e. message bodies.
        const e = err as { code?: unknown; cause?: { code?: unknown } };
        request.log.error({ code: e.code ?? e.cause?.code ?? null, event: eventName(request.body) }, 'webhook: falha ao gravar');
        return reply.code(500).send({ error: 'Ocorreu um erro' });
      }
      return { ok: true };
    },
  );
}
```

The route lives outside `/api/*`, so the session and Origin checks from Task 6 do not apply; the secret is its only authentication (and Caddy never forwards `/webhooks/*`, §6).

- [ ] **Step 15: Run it to verify it passes**

Run: `npm test -w server -- test/webhooks/routes.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 16: Commit**

```bash
git add server/src/webhooks/routes.ts server/test/webhooks/routes.test.ts
git commit -m "feat(webhooks): 500 on ingest failure, safe logging, hashed secret compare

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 17: Write the failing SPA test**

No earlier task serves the compiled front (spec §2: React build at `/`). Create `server/test/spa.test.ts`:

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { makeTestCtx } from './helpers.js';

let app: FastifyInstance;

afterEach(async () => {
  await app.close();
});

async function appWithDist(webDistDir: string | null) {
  const ctx = await makeTestCtx();
  app = await buildApp({ ...ctx, config: { ...ctx.config, webDistDir } });
  return app;
}

function fakeBuild(): string {
  const dir = mkdtempSync(join(tmpdir(), 'talk-web-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><div id="root"></div><script type="module" src="/assets/app.js"></script>');
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log("talk")');
  return dir;
}

describe('SPA static serving', () => {
  it('serves index.html at / and on client-side routes', async () => {
    await appWithDist(fakeBuild());
    for (const url of ['/', '/conversas/abc']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-type'], url).toMatch(/^text\/html/);
      expect(res.body, url).toContain('<script type="module"');
    }
  });

  it('serves the built assets', async () => {
    await appWithDist(fakeBuild());
    const res = await app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('console.log("talk")');
  });

  it('keeps unknown /api and /webhooks paths and non-GET requests as JSON 404', async () => {
    await appWithDist(fakeBuild());
    for (const [method, url] of [['GET', '/api/nope'], ['GET', '/webhooks/nope'], ['POST', '/conversas']] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode, url).toBe(404);
      expect(res.json(), url).toEqual({ error: 'Não encontrado' });
    }
  });

  it('without a build, every unknown path is JSON 404', async () => {
    await appWithDist(null);
    const res = await app.inject({ method: 'GET', url: '/conversas' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Não encontrado' });
  });
});
```

- [ ] **Step 18: Run it to verify it fails**

Run: `npm test -w server -- test/spa.test.ts`
Expected: FAIL. `GET /` returns Fastify's default 404 (`expected 404 to be 200`), and the 404 cases fail because the default body is `{ message, error: 'Not Found', statusCode }`, not `{ error: 'Não encontrado' }`.

- [ ] **Step 19: Serve the SPA from `buildApp`**

In `server/src/app.ts`, add to the imports:

```ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
```

and, inside `buildApp`, as the LAST block right before `return app;` (after every route registration; later tasks add their routes above it):

```ts
  // Spec §2: the compiled React front is served at /. Any other GET outside /api, /ws and /webhooks is a
  // client-side route, so it gets index.html. Keep this block last in buildApp.
  const dist = ctx.config.webDistDir;
  const spa = dist !== null && existsSync(join(dist, 'index.html'));
  if (spa) await app.register(fastifyStatic, { root: dist, wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    const clientRoute =
      req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/ws') && !req.url.startsWith('/webhooks/');
    if (spa && clientRoute) return reply.type('text/html').sendFile('index.html');
    return reply.code(404).send({ error: 'Não encontrado' });
  });
```

`wildcard: false` registers one route per file found in the build at startup (the build never changes while the container runs), so the not-found handler only sees paths that are not files.

- [ ] **Step 20: Run it to verify it passes**

Run: `npm test -w server -- test/spa.test.ts test/app.test.ts`
Expected: PASS (4 SPA tests; Task 1's app tests still green).

- [ ] **Step 21: Commit**

```bash
git add server/src/app.ts server/test/spa.test.ts
git commit -m "feat(server): serve the compiled SPA with index.html fallback and JSON 404

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 22: Write the production entry**

Create `server/src/index.ts` with the complete file below (Task 1 left it to a later task). If a previous task already created it with other startup calls (for example an admin seed), keep them between `runMigrations(db)` and `buildApp(...)`.

```ts
import { loadConfig } from './config.js';
import { createPgDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { createEvolutionGateway } from './whatsapp/evolution.js';
import { createHub } from './realtime/hub.js';
import { buildApp } from './app.js';
import { syncChannelStatuses } from './channels/service.js';
import type { AppCtx } from './ctx.js';

const config = loadConfig(process.env);
const db = createPgDb(config.databaseUrl);
await runMigrations(db);

const ctx: AppCtx = {
  db,
  wa: createEvolutionGateway(config.evolution),
  hub: createHub(() => db),
  config,
};
const app = await buildApp(ctx, {
  trustProxy: 1, // only Caddy is in front (§6): req.ip is the client's, so the login limit is per client IP
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

// Node as PID 1 in Docker ignores SIGTERM unless handled; close cleanly so `docker compose stop` is fast
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
```

- [ ] **Step 23: Typecheck and run the whole server suite**

Run: `npx tsc -p server/tsconfig.json --noEmit`
Expected: no output, exit code 0.

Run: `npm test -w server`
Expected: PASS (all server test files, including Task 9's ingest tests).

- [ ] **Step 24: Commit**

```bash
git add server/src/index.ts
git commit -m "feat(server): production entry with migrations, Evolution gateway, hub and channel status sync

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


---

### Task 15: Web foundation: API client, auth, WebSocket, layout, login

**Files:**
- Create or replace (Task 1 may have left a stub): `web/package.json`, `web/tsconfig.json`
- Create: `web/vite.config.ts`, `web/index.html`
- Create: `web/src/main.tsx`, `web/src/App.tsx`, `web/src/index.css`
- Create: `web/src/lib/format.ts`, `web/src/lib/api.ts`, `web/src/lib/ws.ts`, `web/src/lib/auth.tsx`
- Create: `web/src/components/layout/AppLayout.tsx`
- Create: `web/src/pages/Login.tsx`
- Test: `web/src/lib/format.test.ts`, `web/src/lib/api.test.ts`, `web/src/lib/ws.test.ts`, `web/src/pages/Login.test.tsx`

**Interfaces:**
- Consumes:
  - `shared/src/index.ts` types (contract): `Me`, `ChatListFilters`, `ChatListItem`, `ChatDetail`, `TimelineItem`, `MessageDto`, `ChannelDto`, `ContactDto`, `ContactNoteDto`, `SectorDto`, `TagDto`, `CustomFieldDto`, `UserDto`, `QuickAnswerDto`, `SettingsDto`, `WsEvent`. The web imports them as `import type { … } from '@talk/shared'`. `web/tsconfig.json` maps that name to `../shared/src/index.ts` through `paths`, so the web does not depend on the npm name Task 1 gave the shared workspace. **Every import from `@talk/shared` must be `import type`.** Type imports are erased at build, so Vite never resolves the alias at runtime.
  - The REST table and `GET /ws` from the contract. Error bodies are `{ error }`, and a 500 is `{ error, correlationId }`. `@fastify/rate-limit` answers a 429 with its own body.
  - The server checks Origin (Task 6). In dev, Vite proxies `/api` and `/ws` to `http://localhost:3000` and keeps the browser's `Origin: http://localhost:5173`, so the dev `.env` needs `APP_ORIGIN=http://localhost:5173` (the same as `TEST_ORIGIN`).
- Produces (later web tasks rely on these exact names):
  - `web/src/lib/api.ts`:
    - `class ApiError extends Error { status: number; correlationId?: string }`. `status` is `0` for a network failure.
    - `request<T>(method: string, path: string, body?: unknown): Promise<T>`. It sends JSON, or `FormData` as-is, always with `credentials: 'include'`, and returns `undefined` on 204.
    - `interface Page<T> { items: T[]; nextCursor: string | null }`, `type ChatPage = Page<ChatListItem>`.
    - `type ChatListData = InfiniteData<ChatPage, string | undefined>`. **Chat lists are `useInfiniteQuery` under `qk.chatList(filters)`, with `pageParam` = cursor.**
    - `type TimelineData = InfiniteData<TimelineItem[], string | undefined>`. **The timeline is `useInfiniteQuery` under `qk.timeline(chatId)`. `pages[0]` is the NEWEST page, items inside a page are in ascending order, and `fetchNextPage` loads OLDER pages (`pageParam` = `before`).**
    - `qk` query keys: `me`, `chats` (prefix), `chatLists` (prefix), `chatList(f)`, `chat(id)`, `timeline(id)`, `contacts` (prefix), `contactList(q)`, `contact(id)`, `contactChats(id)`, `contactNotes(id)`, `sectors`, `tags`, `customFields`, `users`, `quickAnswers`, `settings`, `channels`.
    - `api` is callable: `api<T = unknown>(path: string, init?: { method?: string; body?: unknown }): Promise<T>` (method defaults to `GET`; same `request` semantics, so errors are `ApiError` with `.status` and the server message). It also carries these namespaces:
      - `api.auth.{login, logout, me}`
      - `api.chats.{list, start, get, timeline, assume, reopen, markRead, transfer, setPrivacy, close, pin, sendText, sendFile, addNote}`
      - `api.messages.{resend, mediaUrl}`
      - `api.contacts.{list, create, get, update, block, setTags, setFields, chats, notes, addNote, updateNote, deleteNote}`
      - `api.sectors | api.tags | api.customFields | api.users | api.quickAnswers` each have `.{list, create, update, remove}`, and `api.quickAnswers` adds `.{render, attachmentUrl}`
      - `api.settings.{get, put}`
      - `api.channels.{list, create, connect}`
    - Input types: `StartChatInput`, `SendTextInput`, `SendFileInput`, `ContactInput`, `ContactListQuery`, `SectorInput`, `TagInput`, `CustomFieldInput`, `UserInput`, `QuickAnswerInput`.
  - `web/src/lib/auth.tsx`:
    - `createQueryClient(): QueryClient`. Any 401 sets `qk.me` to `null`, and 4xx errors are not retried.
    - `useMe()` returns `Me | null`.
    - `useCurrentUser(): Me`, only valid inside `RequireAuth`.
    - `useLogin()`, `useLogout()`.
    - `RequireAuth({ children })`.
  - `web/src/lib/ws.ts`: `applyWsEvent(qc: QueryClient, event: WsEvent): void`, `connectWs(qc: QueryClient, url?: string): () => void`, `onWsEvent(fn: (ev: WsEvent) => void): () => void` (returns unsubscribe; called with every parsed event after the cache is updated) and `useWsEvent(fn: (ev: WsEvent) => void): void` (hook form of `onWsEvent`, always calls the latest `fn`).
  - `web/src/lib/format.ts`: `relativeTime(iso: string, now?: Date): string`, `formatPhone(phone: string | null | undefined): string`, `initials(name: string | null | undefined): string`.
  - `web/src/App.tsx`: `export const routes: RouteObject[]`.
    - The authenticated layout route is `path: '/'` with `children`. Tasks 16, 18 and 19 add `chats`, `contacts` and `configuracoes/:section?` to those `children`, before the `*` catch-all.
    - The channel banner links admins to `/configuracoes/canais`, which Task 19 must serve.
  - `web/src/components/layout/AppLayout.tsx`: default export `AppLayout`. It holds the sidebar, the channel banner and an `<Outlet/>` that fills the remaining height (`min-h-0 flex-1`), and it opens the WebSocket.
  - CSS theme tokens (Tailwind utilities): `bg-sidebar`, `bg-sidebar-hover`, `bg-sidebar-active`, `bg-surface`, `bg-panel`, `border-border`, `text-fg`, `text-muted`, `bg-primary`, `bg-primary-hover`, `bg-danger`/`text-danger`, `bg-success`.

---

- [ ] **Step 1: Write the web workspace config files**

`web/package.json`:

```json
{
  "name": "web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@phosphor-icons/react": "2.1.10",
    "@tanstack/react-query": "5.104.2",
    "react": "19.3.1",
    "react-dom": "19.3.1",
    "react-router": "8.4.0"
  },
  "devDependencies": {
    "@tailwindcss/vite": "4.3.3",
    "@testing-library/react": "16.3.3",
    "@vitejs/plugin-react": "6.1.2",
    "jsdom": "30.1.2",
    "tailwindcss": "4.3.3",
    "typescript": "5.9.3",
    "vite": "8.3.4",
    "vitest": "5.0.4"
  }
}
```

`web/tsconfig.json`. It stands alone and does not extend `tsconfig.base.json`, because the web needs bundler resolution and JSX while the server uses NodeNext.

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "types": ["vite/client"],
    "paths": { "@talk/shared": ["../shared/src/index.ts"] }
  },
  "include": ["src", "vite.config.ts"]
}
```

`web/vite.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // changeOrigin stays false: the server's Origin check must see http://localhost:5173 (APP_ORIGIN in dev).
    proxy: {
      '/api': { target: 'http://localhost:3000' },
      '/ws': { target: 'http://localhost:3000', ws: true },
    },
  },
  test: {
    environment: 'jsdom',
  },
});
```

`web/index.html`:

```html
<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="dark" />
    <title>Atendimento</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: Install dependencies**

Run from the repo root:

```bash
npm install
npm install -w web --save-exact -D @types/react@19 @types/react-dom@19 @testing-library/dom@10
```

Expected: both commands exit 0. `web/package.json` now also lists `@types/react`, `@types/react-dom` and `@testing-library/dom` with exact versions. `@testing-library/dom` is a required peer of `@testing-library/react` 16, and the `@types/*` packages are needed by `tsc`. The contract does not pin any of the three, so the second command pins whatever is current.

- [ ] **Step 3: Write the failing test for `format.ts`**

`web/src/lib/format.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formatPhone, initials, relativeTime } from './format';

describe('relativeTime', () => {
  const now = new Date('2026-10-14T12:00:00.000Z');
  it.each([
    ['2026-10-14T11:59:30.000Z', 'agora'],
    ['2026-10-14T12:05:00.000Z', 'agora'], // future timestamp (clock skew)
    ['2026-10-14T11:55:00.000Z', 'há 5 minutos'],
    ['2026-10-14T11:00:00.000Z', 'há 1 hora'],
    ['2026-10-13T12:00:00.000Z', 'há 1 dia'],
    ['2026-05-14T12:00:00.000Z', 'há 5 meses'],
    ['2024-10-14T12:00:00.000Z', 'há 2 anos'],
  ])('%s → %s', (iso, expected) => {
    expect(relativeTime(iso, now)).toBe(expected);
  });
});

describe('formatPhone', () => {
  it('formats a 13-digit mobile', () => {
    expect(formatPhone('5565999999999')).toBe('+55 65 99999-9999');
  });
  it('formats a 12-digit landline', () => {
    expect(formatPhone('556532221111')).toBe('+55 65 3222-1111');
  });
  it('returns non-Brazilian numbers unchanged and empty for null', () => {
    expect(formatPhone('14155550100')).toBe('14155550100');
    expect(formatPhone(null)).toBe('');
  });
});

describe('initials', () => {
  it('uses first and last name', () => {
    expect(initials('Ana Maria Souza')).toBe('AS');
    expect(initials('joão')).toBe('J');
  });
  it('falls back to ?', () => {
    expect(initials('   ')).toBe('?');
    expect(initials(null)).toBe('?');
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npm test -w web -- src/lib/format.test.ts`
Expected: FAIL with `Failed to resolve import "./format"`.

- [ ] **Step 5: Implement `format.ts`**

`web/src/lib/format.ts`:

```ts
const rtf = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'always' });
const STEPS = [
  ['minute', 60],
  ['hour', 24],
  ['day', 30],
  ['month', 12],
] as const;

/** "agora", "há 5 minutos", "há 1 hora", "há 5 meses", "há 2 anos". */
export function relativeTime(iso: string, now: Date = new Date()): string {
  let value = (now.getTime() - new Date(iso).getTime()) / 60_000; // minutes
  if (value < 1) return 'agora';
  for (const [unit, size] of STEPS) {
    if (value < size) return rtf.format(-Math.floor(value), unit);
    value /= size;
  }
  return rtf.format(-Math.floor(value), 'year');
}

/** Canonical 55DDD… → "+55 65 99999-9999" (mobile) / "+55 65 3222-1111" (landline); anything else as-is. */
export function formatPhone(phone: string | null | undefined): string {
  if (!phone) return '';
  const m = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(phone);
  return m ? `+55 ${m[1]} ${m[2]}-${m[3]}` : phone;
}

/** Avatar letters: first + last word initial. */
export function initials(name: string | null | undefined): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0]![0]!;
  const last = words.length > 1 ? words[words.length - 1]![0]! : '';
  return (first + last).toUpperCase();
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm test -w web -- src/lib/format.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 7: Write the failing test for `api.ts`**

`web/src/lib/api.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, request } from './api';

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

afterEach(() => vi.unstubAllGlobals());

describe('request', () => {
  it('sends JSON with credentials and returns the parsed body', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json(200, { id: 'u1' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(request('POST', '/api/x', { a: 1 })).resolves.toEqual({ id: 'u1' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/x');
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('include');
    expect(init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(init?.body).toBe('{"a":1}');
  });

  it('returns undefined on 204', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(null, { status: 204 })));
    await expect(request('POST', '/api/auth/logout')).resolves.toBeUndefined();
  });

  it('maps { error } to ApiError with the server message', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => json(404, { error: 'Não encontrado' })));
    const err = await request('GET', '/api/chats/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 404, message: 'Não encontrado' });
  });

  it('appends the correlation id of a 500', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () => json(500, { error: 'Ocorreu um erro', correlationId: 'req-7' })),
    );
    const err = await request('GET', '/api/chats').catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 500, message: 'Ocorreu um erro (req-7)', correlationId: 'req-7' });
  });

  it('translates the rate limiter 429', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () =>
        json(429, { statusCode: 429, error: 'Too Many Requests', message: 'Rate limit exceeded, retry in 1 minute' }),
      ),
    );
    const err = await request('POST', '/api/auth/login', {}).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 429, message: 'Muitas tentativas. Aguarde um minuto e tente de novo.' });
  });

  it('handles a non-JSON error body', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response('<h1>Bad Gateway</h1>', { status: 502 })));
    const err = await request('GET', '/api/chats').catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 502, message: 'Erro 502' });
  });

  it('maps a network failure to status 0', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => { throw new TypeError('Failed to fetch'); }));
    const err = await request('GET', '/api/chats').catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 0, message: 'Sem conexão com o servidor' });
  });
});

describe('api helpers', () => {
  it('is callable as api<T>(path, { method, body })', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api<{ ok: boolean }>('/api/x', { method: 'POST', body: { a: 1 } })).resolves.toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/x');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{"a":1}');
    await api('/api/y');
    expect(fetchMock.mock.calls[1]![1]?.method).toBe('GET');
  });

  it('builds the chat list query string without empty values', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json(200, { items: [], nextCursor: null }));
    vi.stubGlobal('fetch', fetchMock);
    await api.chats.list({ tab: 'waiting', q: 'ana', sectorId: undefined, ownerId: '', limit: 30 });
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/chats?tab=waiting&q=ana&limit=30');
  });

  it('sends files as multipart with text fields before the file and no JSON header', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json(200, { id: 'm1' }));
    vi.stubGlobal('fetch', fetchMock);
    const file = new File(['%PDF'], 'contrato.pdf', { type: 'application/pdf' });
    await api.chats.sendFile('c1', { file, text: 'segue', signature: true });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/chats/c1/messages');
    expect(init?.headers).toEqual({});
    const form = init?.body as FormData;
    expect([...form.keys()]).toEqual(['text', 'signature', 'file']);
    expect(form.get('signature')).toBe('true');
  });

  it('pins with PUT and unpins with DELETE', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    await api.chats.pin('c1', true);
    await api.chats.pin('c1', false);
    expect(fetchMock.mock.calls.map(([u, i]) => `${i?.method} ${String(u)}`)).toEqual([
      'PUT /api/chats/c1/pin',
      'DELETE /api/chats/c1/pin',
    ]);
  });
});
```

- [ ] **Step 8: Run the test to verify it fails**

Run: `npm test -w web -- src/lib/api.test.ts`
Expected: FAIL with `Failed to resolve import "./api"`.

- [ ] **Step 9: Implement `api.ts`**

`web/src/lib/api.ts`:

```ts
import type { InfiniteData } from '@tanstack/react-query';
import type {
  ChannelDto,
  ChatDetail,
  ChatListFilters,
  ChatListItem,
  ContactDto,
  ContactNoteDto,
  CustomFieldDto,
  Me,
  MessageDto,
  QuickAnswerDto,
  SectorDto,
  SettingsDto,
  TagDto,
  TimelineItem,
  UserDto,
} from '@talk/shared';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public correlationId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
export type ChatPage = Page<ChatListItem>;
/** Chat lists are infinite queries under qk.chatList(filters); pageParam = cursor. */
export type ChatListData = InfiniteData<ChatPage, string | undefined>;
/** Timeline infinite query: pages[0] = newest page; each page ascending; next pages are older (pageParam = before). */
export type TimelineData = InfiniteData<TimelineItem[], string | undefined>;

export interface StartChatInput { contactId?: string; phone?: string; name?: string; sectorId?: string }
export interface SendTextInput { text: string; signature: boolean; replyToId?: string }
export interface SendFileInput { file: Blob; fileName?: string; text?: string; signature: boolean; replyToId?: string; asVoice?: boolean }
export type ContactInput = Partial<Pick<ContactDto, 'name' | 'phone' | 'email' | 'landline' | 'address'>>;
export interface ContactListQuery { q?: string; tagId?: string; cursor?: string; limit?: number }
export type SectorInput = Partial<Pick<SectorDto, 'name' | 'position' | 'isDefault'>>;
export type TagInput = Partial<Pick<TagDto, 'name' | 'emoji' | 'color' | 'position'>>;
export type CustomFieldInput = Partial<Pick<CustomFieldDto, 'name' | 'kind' | 'position'>>;
export type UserInput = Partial<Pick<UserDto, 'name' | 'email' | 'role' | 'signature' | 'active' | 'sectorIds'>> & { password?: string };
export type QuickAnswerInput = Partial<Pick<QuickAnswerDto, 'name' | 'body' | 'visibility'>>;

const RATE_LIMITED = 'Muitas tentativas. Aguarde um minuto e tente de novo.';

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: 'include', headers: {} };
  if (body instanceof FormData) {
    init.body = body; // browser sets the multipart boundary
  } else if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, 'Sem conexão com o servidor');
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    if (res.status === 429) throw new ApiError(429, RATE_LIMITED);
    const obj = (data ?? {}) as { error?: unknown; correlationId?: unknown };
    const msg = typeof obj.error === 'string' ? obj.error : `Erro ${res.status}`;
    const cid = typeof obj.correlationId === 'string' ? obj.correlationId : undefined;
    throw new ApiError(res.status, cid ? `${msg} (${cid})` : msg, cid);
  }
  return data as T;
}

function qs(params: object): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params) as Array<[string, unknown]>) {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

const enc = encodeURIComponent;

function crud<T, I>(base: string) {
  return {
    list: () => request<T[]>('GET', base),
    create: (input: I) => request<T>('POST', base, input),
    update: (id: string, input: I) => request<T>('PATCH', `${base}/${enc(id)}`, input),
    remove: (id: string) => request<void>('DELETE', `${base}/${enc(id)}`),
  };
}

/** Generic form used by Tasks 16, 18 and 19: `api<T>('/api/x', { method, body })`. */
function call<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  return request<T>(init.method ?? 'GET', path, init.body);
}

/** Callable (`api<T>(path, init)`) and namespaced (`api.chats.list(...)`, used by Task 17). */
export const api = Object.assign(call, {
  auth: {
    login: (email: string, password: string) => request<Me>('POST', '/api/auth/login', { email, password }),
    logout: () => request<void>('POST', '/api/auth/logout'),
    me: () => request<Me>('GET', '/api/auth/me'),
  },
  chats: {
    list: (f: ChatListFilters) => request<ChatPage>('GET', `/api/chats${qs(f)}`),
    start: (input: StartChatInput) => request<ChatDetail>('POST', '/api/chats', input),
    get: (id: string) => request<ChatDetail>('GET', `/api/chats/${enc(id)}`),
    timeline: (id: string, q: { before?: string; limit?: number } = {}) =>
      request<TimelineItem[]>('GET', `/api/chats/${enc(id)}/timeline${qs(q)}`),
    assume: (id: string) => request<ChatDetail>('POST', `/api/chats/${enc(id)}/assume`),
    reopen: (id: string) => request<ChatDetail>('POST', `/api/chats/${enc(id)}/reopen`),
    markRead: (id: string) => request<void>('POST', `/api/chats/${enc(id)}/read`),
    transfer: (id: string, to: { sectorId?: string; ownerId?: string | null }) =>
      request<ChatDetail>('POST', `/api/chats/${enc(id)}/transfer`, to),
    setPrivacy: (id: string, isPrivate: boolean) =>
      request<ChatDetail>('POST', `/api/chats/${enc(id)}/privacy`, { private: isPrivate }),
    close: (id: string, sendClosingMessage: boolean) =>
      request<ChatDetail>('POST', `/api/chats/${enc(id)}/close`, { sendClosingMessage }),
    pin: (id: string, pinned: boolean) => request<void>(pinned ? 'PUT' : 'DELETE', `/api/chats/${enc(id)}/pin`),
    sendText: (id: string, input: SendTextInput) => request<MessageDto>('POST', `/api/chats/${enc(id)}/messages`, input),
    sendFile: (id: string, input: SendFileInput) => {
      // @fastify/multipart only exposes fields that come BEFORE the file part — keep the file last.
      const form = new FormData();
      if (input.text) form.append('text', input.text);
      form.append('signature', String(input.signature));
      if (input.replyToId) form.append('replyToId', input.replyToId);
      if (input.asVoice) form.append('asVoice', 'true');
      form.append('file', input.file, input.fileName ?? (input.file instanceof File ? input.file.name : 'arquivo'));
      return request<MessageDto>('POST', `/api/chats/${enc(id)}/messages`, form);
    },
    addNote: (id: string, text: string) => request<MessageDto>('POST', `/api/chats/${enc(id)}/notes`, { text }),
  },
  messages: {
    resend: (messageId: string) => request<MessageDto>('POST', `/api/messages/${enc(messageId)}/resend`),
    mediaUrl: (messageId: string) => `/api/media/${enc(messageId)}`,
  },
  contacts: {
    list: (q: ContactListQuery = {}) => request<Page<ContactDto>>('GET', `/api/contacts${qs(q)}`),
    create: (input: ContactInput) => request<ContactDto>('POST', '/api/contacts', input),
    get: (id: string) => request<ContactDto>('GET', `/api/contacts/${enc(id)}`),
    update: (id: string, input: ContactInput) => request<ContactDto>('PATCH', `/api/contacts/${enc(id)}`, input),
    block: (id: string, blocked: boolean) => request<ContactDto>('POST', `/api/contacts/${enc(id)}/block`, { blocked }),
    setTags: (id: string, tagIds: string[]) => request<ContactDto>('PUT', `/api/contacts/${enc(id)}/tags`, { tagIds }),
    setFields: (id: string, fields: Record<string, string>) =>
      request<ContactDto>('PUT', `/api/contacts/${enc(id)}/fields`, fields),
    chats: (id: string) => request<ChatListItem[]>('GET', `/api/contacts/${enc(id)}/chats`),
    notes: (id: string) => request<ContactNoteDto[]>('GET', `/api/contacts/${enc(id)}/notes`),
    addNote: (id: string, body: string) => request<ContactNoteDto>('POST', `/api/contacts/${enc(id)}/notes`, { body }),
    updateNote: (id: string, noteId: string, patch: { body?: string; pinned?: boolean }) =>
      request<ContactNoteDto>('PATCH', `/api/contacts/${enc(id)}/notes/${enc(noteId)}`, patch),
    deleteNote: (id: string, noteId: string) => request<void>('DELETE', `/api/contacts/${enc(id)}/notes/${enc(noteId)}`),
  },
  sectors: crud<SectorDto, SectorInput>('/api/sectors'),
  tags: crud<TagDto, TagInput>('/api/tags'),
  customFields: crud<CustomFieldDto, CustomFieldInput>('/api/custom-fields'),
  users: crud<UserDto, UserInput>('/api/users'),
  quickAnswers: {
    ...crud<QuickAnswerDto, QuickAnswerInput | FormData>('/api/quick-answers'),
    render: (id: string, chatId: string) =>
      request<{ text: string }>('POST', `/api/quick-answers/${enc(id)}/render`, { chatId }),
    attachmentUrl: (id: string) => `/api/quick-answers/${enc(id)}/attachment`,
  },
  settings: {
    get: () => request<SettingsDto>('GET', '/api/settings'),
    put: (s: SettingsDto) => request<SettingsDto>('PUT', '/api/settings', s),
  },
  channels: {
    list: () => request<ChannelDto[]>('GET', '/api/channels'),
    create: (name: string) => request<ChannelDto>('POST', '/api/channels', { name }),
    connect: (id: string) => request<{ qrBase64: string | null }>('POST', `/api/channels/${enc(id)}/connect`),
  },
});

/** React Query keys. Everything chat-related lives under ['chats'] so one invalidation refreshes it all. */
export const qk = {
  me: ['me'] as const,
  chats: ['chats'] as const,
  chatLists: ['chats', 'list'] as const,
  chatList: (f: ChatListFilters) => ['chats', 'list', f] as const,
  chat: (id: string) => ['chats', 'detail', id] as const,
  timeline: (id: string) => ['chats', 'timeline', id] as const,
  contacts: ['contacts'] as const,
  contactList: (q: ContactListQuery) => ['contacts', 'list', q] as const,
  contact: (id: string) => ['contacts', 'detail', id] as const,
  contactChats: (id: string) => ['contacts', 'chats', id] as const,
  contactNotes: (id: string) => ['contacts', 'notes', id] as const,
  sectors: ['sectors'] as const,
  tags: ['tags'] as const,
  customFields: ['custom-fields'] as const,
  users: ['users'] as const,
  quickAnswers: ['quick-answers'] as const,
  settings: ['settings'] as const,
  channels: ['channels'] as const,
};
```

- [ ] **Step 10: Run the test to verify it passes**

Run: `npm test -w web -- src/lib/api.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 11: Write the failing test for `ws.ts`**

`web/src/lib/ws.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { ChannelDto, ChatDetail, ChatListItem, MessageDto, TimelineItem } from '@talk/shared';
import { qk, type ChatListData, type TimelineData } from './api';
import { applyWsEvent, connectWs, onWsEvent } from './ws';

const chat = (id: string, over: Partial<ChatListItem> = {}): ChatListItem => ({
  id,
  contact: { id: `ct-${id}`, name: `Contato ${id}`, phone: '5565999990000' },
  channelId: 'ch1',
  sectorId: 's1',
  ownerId: null,
  state: 'open',
  waiting: true,
  private: false,
  unread: 1,
  lastMessageAt: '2026-10-14T10:00:00.000Z',
  lastMessagePreview: 'oi',
  pinned: false,
  tagIds: [],
  ...over,
});

const msg = (id: string, sentAt: string, over: Partial<MessageDto> = {}): MessageDto => ({
  id,
  chatId: 'c1',
  direction: 'in',
  kind: 'text',
  body: 'oi',
  media: null,
  mediaUnavailable: false,
  authorId: null,
  authorName: null,
  replyTo: null,
  reaction: null,
  status: 'sent',
  error: null,
  sentAt,
  ...over,
});

const item = (m: MessageDto): TimelineItem => ({ type: 'message', ...m });

function seedList(qc: QueryClient, items: ChatListItem[]) {
  const key = qk.chatList({ tab: 'inbox' });
  qc.setQueryData<ChatListData>(key, { pages: [{ items, nextCursor: null }], pageParams: [undefined] });
  return key;
}

describe('applyWsEvent', () => {
  it('chat.updated replaces the item in place and marks lists stale for the server to re-order', () => {
    const qc = new QueryClient();
    const key = seedList(qc, [chat('a'), chat('b')]);
    applyWsEvent(qc, { type: 'chat.updated', chat: chat('b', { unread: 5 }) });
    expect(qc.getQueryData<ChatListData>(key)!.pages[0]!.items.map((c) => c.unread)).toEqual([1, 5]);
    expect(qc.getQueryState(key)!.isInvalidated).toBe(true);
  });

  it('chat.updated merges into the detail and refetches it only when the state changed', () => {
    const qc = new QueryClient();
    const detail: ChatDetail = { ...chat('a'), triagePending: true, createdAt: '2026-10-14T09:00:00.000Z', closedAt: null };
    qc.setQueryData(qk.chat('a'), detail);
    applyWsEvent(qc, { type: 'chat.updated', chat: chat('a', { ownerId: 'u1' }) });
    const after = qc.getQueryData<ChatDetail>(qk.chat('a'))!;
    expect(after.ownerId).toBe('u1');
    expect(after.triagePending).toBe(true);
    expect(qc.getQueryState(qk.chat('a'))!.isInvalidated).toBe(false);
    applyWsEvent(qc, { type: 'chat.updated', chat: chat('a', { state: 'closed' }) });
    expect(qc.getQueryState(qk.chat('a'))!.isInvalidated).toBe(true);
  });

  it('chat.removed drops the chat from lists, detail and timeline', () => {
    const qc = new QueryClient();
    const key = seedList(qc, [chat('a'), chat('b')]);
    qc.setQueryData(qk.chat('b'), { ...chat('b'), triagePending: false, createdAt: '2026-10-14T09:00:00.000Z', closedAt: null });
    qc.setQueryData<TimelineData>(qk.timeline('b'), { pages: [[]], pageParams: [undefined] });
    applyWsEvent(qc, { type: 'chat.removed', chatId: 'b' });
    expect(qc.getQueryData<ChatListData>(key)!.pages[0]!.items.map((c) => c.id)).toEqual(['a']);
    expect(qc.getQueryData(qk.chat('b'))).toBeUndefined();
    expect(qc.getQueryData(qk.timeline('b'))).toBeUndefined();
  });

  it('chat.removed for an unknown chat is a no-op', () => {
    const qc = new QueryClient();
    const key = seedList(qc, [chat('a')]);
    applyWsEvent(qc, { type: 'chat.removed', chatId: 'zzz' });
    expect(qc.getQueryData<ChatListData>(key)!.pages[0]!.items).toHaveLength(1);
  });

  it('message events upsert the cached timeline in time order without duplicates', () => {
    const qc = new QueryClient();
    const event: TimelineItem = {
      type: 'event', id: 'e1', chatId: 'c1', kind: 'created', data: {}, authorName: null, createdAt: '2026-10-14T09:00:00.000Z',
    };
    const newest = [event, item(msg('m1', '2026-10-14T10:00:00.000Z'))];
    const older = [item(msg('m0', '2026-10-14T08:00:00.000Z'))];
    qc.setQueryData<TimelineData>(qk.timeline('c1'), { pages: [newest, older], pageParams: [undefined, 'm1'] });

    // late-arriving message lands between the event and m1
    applyWsEvent(qc, { type: 'message.created', message: msg('m2', '2026-10-14T09:30:00.000Z') });
    // the same message delivered twice (POST response + WS) is not duplicated
    applyWsEvent(qc, { type: 'message.created', message: msg('m2', '2026-10-14T09:30:00.000Z', { status: 'delivered' }) });
    let data = qc.getQueryData<TimelineData>(qk.timeline('c1'))!;
    expect(data.pages[0]!.map((i) => i.id)).toEqual(['e1', 'm2', 'm1']);
    expect((data.pages[0]![1] as TimelineItem & { status: string }).status).toBe('delivered');

    // update on an older page (reaction)
    applyWsEvent(qc, { type: 'message.updated', message: msg('m0', '2026-10-14T08:00:00.000Z', { reaction: '👍' }) });
    data = qc.getQueryData<TimelineData>(qk.timeline('c1'))!;
    expect((data.pages[1]![0] as TimelineItem & { reaction: string | null }).reaction).toBe('👍');

    // update for a message not loaded is ignored
    applyWsEvent(qc, { type: 'message.updated', message: msg('zzz', '2026-10-01T08:00:00.000Z') });
    expect(qc.getQueryData<TimelineData>(qk.timeline('c1'))!.pages.flat()).toHaveLength(4);
  });

  it('message.created for a timeline that is not cached does nothing', () => {
    const qc = new QueryClient();
    applyWsEvent(qc, { type: 'message.created', message: msg('m1', '2026-10-14T10:00:00.000Z', { chatId: 'other' }) });
    expect(qc.getQueryData(qk.timeline('other'))).toBeUndefined();
  });

  it('channel.status replaces by id and appends new channels', () => {
    const qc = new QueryClient();
    const ch = (id: string, status: ChannelDto['status']): ChannelDto => ({ id, name: `Canal ${id}`, status, phone: null });
    qc.setQueryData<ChannelDto[]>(qk.channels, [ch('1', 'connected')]);
    applyWsEvent(qc, { type: 'channel.status', channel: ch('1', 'disconnected') });
    applyWsEvent(qc, { type: 'channel.status', channel: ch('2', 'connecting') });
    expect(qc.getQueryData<ChannelDto[]>(qk.channels)!.map((c) => `${c.id}:${c.status}`)).toEqual([
      '1:disconnected',
      '2:connecting',
    ]);
  });
});

describe('connectWs', () => {
  class FakeWs {
    static instances: FakeWs[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    closed = false;
    constructor(public url: string) {
      FakeWs.instances.push(this);
    }
    close() {
      this.closed = true;
    }
  }

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    FakeWs.instances = [];
  });

  it('reconnects with 1s→2s→… backoff, resets on open, applies events, stops on cleanup', () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWs);
    const qc = new QueryClient();
    const key = seedList(qc, [chat('a'), chat('b')]);
    const stop = connectWs(qc, 'ws://test/ws');
    expect(FakeWs.instances).toHaveLength(1);
    expect(FakeWs.instances[0]!.url).toBe('ws://test/ws');

    FakeWs.instances[0]!.onclose!();
    vi.advanceTimersByTime(999);
    expect(FakeWs.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWs.instances).toHaveLength(2);

    FakeWs.instances[1]!.onclose!();
    vi.advanceTimersByTime(1999);
    expect(FakeWs.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeWs.instances).toHaveLength(3);

    // open resets the delay and invalidates every chat query (reload, no replay)
    FakeWs.instances[2]!.onopen!();
    expect(qc.getQueryState(key)!.isInvalidated).toBe(true);
    FakeWs.instances[2]!.onmessage!({ data: JSON.stringify({ type: 'chat.removed', chatId: 'b' }) });
    FakeWs.instances[2]!.onmessage!({ data: 'not json' }); // ignored, no throw
    expect(qc.getQueryData<ChatListData>(key)!.pages[0]!.items.map((c) => c.id)).toEqual(['a']);
    FakeWs.instances[2]!.onclose!();
    vi.advanceTimersByTime(1000);
    expect(FakeWs.instances).toHaveLength(4);

    stop();
    expect(FakeWs.instances[3]!.closed).toBe(true);
    FakeWs.instances[3]!.onclose!();
    vi.advanceTimersByTime(60_000);
    expect(FakeWs.instances).toHaveLength(4);
  });

  it('delivers parsed events to onWsEvent listeners until unsubscribed', () => {
    vi.stubGlobal('WebSocket', FakeWs);
    const qc = new QueryClient();
    const seen: unknown[] = [];
    const off = onWsEvent((ev) => seen.push(ev));
    const stop = connectWs(qc, 'ws://test/ws');
    FakeWs.instances[0]!.onmessage!({ data: JSON.stringify({ type: 'chat.removed', chatId: 'b' }) });
    FakeWs.instances[0]!.onmessage!({ data: 'not json' });
    expect(seen).toEqual([{ type: 'chat.removed', chatId: 'b' }]);
    off();
    FakeWs.instances[0]!.onmessage!({ data: JSON.stringify({ type: 'chat.removed', chatId: 'c' }) });
    expect(seen).toHaveLength(1);
    stop();
  });
});
```

- [ ] **Step 12: Run the test to verify it fails**

Run: `npm test -w web -- src/lib/ws.test.ts`
Expected: FAIL with `Failed to resolve import "./ws"`.

- [ ] **Step 13: Implement `ws.ts`**

`web/src/lib/ws.ts`:

```ts
import { useEffect, useRef } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type { ChannelDto, ChatDetail, ChatListItem, TimelineItem, WsEvent } from '@talk/shared';
import { qk, type ChatListData, type TimelineData } from './api';

const listeners = new Set<(ev: WsEvent) => void>();

/** Subscribe to every server event (after the cache is updated). Returns the unsubscribe function. */
export function onWsEvent(fn: (ev: WsEvent) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Hook form of onWsEvent; always calls the latest `fn` without resubscribing. */
export function useWsEvent(fn: (ev: WsEvent) => void): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => onWsEvent((e) => ref.current(e)), []);
}

function mapChatLists(qc: QueryClient, fn: (items: ChatListItem[]) => ChatListItem[]): void {
  qc.setQueriesData<ChatListData>({ queryKey: qk.chatLists }, (d) =>
    d && { ...d, pages: d.pages.map((p) => ({ ...p, items: fn(p.items) })) },
  );
}

const at = (i: TimelineItem) => Date.parse(i.type === 'message' ? i.sentAt : i.createdAt);
const byTime = (a: TimelineItem, b: TimelineItem) => at(a) - at(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function upsertTimeline(d: TimelineData, next: TimelineItem, insert: boolean): TimelineData {
  let found = false;
  const pages = d.pages.map((p) =>
    p.map((i) => {
      if (i.type === 'message' && i.id === next.id) {
        found = true;
        return next;
      }
      return i;
    }),
  );
  if (found) return { ...d, pages };
  if (!insert) return d;
  pages[0] = [...(pages[0] ?? []), next].sort(byTime); // pages[0] is the newest page
  return { ...d, pages };
}

/** Pure cache reducer for one server event. Exported for tests and for tasks that need to apply a DTO the same way. */
export function applyWsEvent(qc: QueryClient, ev: WsEvent): void {
  switch (ev.type) {
    case 'chat.updated': {
      const chat = ev.chat;
      mapChatLists(qc, (items) => items.map((c) => (c.id === chat.id ? chat : c)));
      // ponytail: tab/filter membership and order stay server-side — lists refetch (active ones only).
      // Client-side insert/sort if refetch load ever matters (3–10 agents today).
      void qc.invalidateQueries({ queryKey: qk.chatLists });
      const prev = qc.getQueryData<ChatDetail>(qk.chat(chat.id));
      if (prev) {
        qc.setQueryData<ChatDetail>(qk.chat(chat.id), { ...prev, ...chat });
        // closedAt / triagePending are not in ChatListItem: refetch when the state flips
        if (prev.state !== chat.state) void qc.invalidateQueries({ queryKey: qk.chat(chat.id), exact: true });
      }
      return;
    }
    case 'chat.removed':
      mapChatLists(qc, (items) => items.filter((c) => c.id !== ev.chatId));
      qc.removeQueries({ queryKey: qk.chat(ev.chatId), exact: true });
      qc.removeQueries({ queryKey: qk.timeline(ev.chatId), exact: true });
      return;
    case 'message.created':
    case 'message.updated': {
      const item: TimelineItem = { type: 'message', ...ev.message };
      qc.setQueryData<TimelineData>(qk.timeline(ev.message.chatId), (d) =>
        d && upsertTimeline(d, item, ev.type === 'message.created'),
      );
      return;
    }
    case 'channel.status': {
      const ch = ev.channel;
      qc.setQueryData<ChannelDto[]>(qk.channels, (list) =>
        list && (list.some((c) => c.id === ch.id) ? list.map((c) => (c.id === ch.id ? ch : c)) : [...list, ch]),
      );
      return;
    }
  }
}

function defaultWsUrl(): string {
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;
}

/** Opens /ws, reconnects with 1s→30s backoff, returns a stop function. */
export function connectWs(qc: QueryClient, url: string = defaultWsUrl()): () => void {
  let ws: WebSocket | null = null;
  let delay = 1000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const open = () => {
    ws = new WebSocket(url);
    ws.onopen = () => {
      delay = 1000;
      // no replay on the server: reload everything chat-related and the channel banner
      void qc.invalidateQueries({ queryKey: qk.chats });
      void qc.invalidateQueries({ queryKey: qk.channels });
    };
    ws.onmessage = (e: MessageEvent) => {
      let ev: WsEvent;
      try {
        ev = JSON.parse(String(e.data)) as WsEvent;
      } catch {
        return;
      }
      applyWsEvent(qc, ev);
      listeners.forEach((l) => l(ev));
    };
    ws.onclose = () => {
      if (stopped) return;
      // a deactivated user is disconnected by the server: re-check the session so RequireAuth can redirect
      void qc.invalidateQueries({ queryKey: qk.me });
      timer = setTimeout(open, delay);
      delay = Math.min(delay * 2, 30_000);
    };
  };

  open();
  return () => {
    stopped = true;
    clearTimeout(timer);
    ws?.close();
  };
}
```

- [ ] **Step 14: Run the test to verify it passes**

Run: `npm test -w web -- src/lib/ws.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 15: Write the failing Login test**

`web/src/pages/Login.test.tsx`:

```tsx
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import Login from './Login';
import { createQueryClient } from '../lib/auth';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const ME = { id: 'u1', name: 'Ana Souza', email: 'ana@jvo.adv.br', role: 'agent', signature: null, sectorIds: [] };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderLogin() {
  const router = createMemoryRouter(
    [
      { path: '/login', element: <Login /> },
      { path: '/chats', element: <p>Caixa de entrada</p> },
    ],
    { initialEntries: ['/login'] },
  );
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

async function fillAndSubmit() {
  fireEvent.change(await screen.findByLabelText('E-mail'), { target: { value: 'ana@jvo.adv.br' } });
  fireEvent.change(screen.getByLabelText('Senha'), { target: { value: 'segredo-123' } });
  fireEvent.click(screen.getByRole('button', { name: 'Entrar' }));
}

it('logs in and goes to the inbox', async () => {
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    if (input === '/api/auth/me') return json(401, { error: 'Não autenticado' });
    if (input === '/api/auth/login' && init?.method === 'POST') return json(200, ME);
    return json(404, { error: 'Não encontrado' });
  });
  vi.stubGlobal('fetch', fetchMock);
  renderLogin();
  await fillAndSubmit();
  expect(await screen.findByText('Caixa de entrada')).toBeTruthy();
  const loginCall = fetchMock.mock.calls.find(([u]) => u === '/api/auth/login')!;
  expect(JSON.parse(loginCall[1]!.body as string)).toEqual({ email: 'ana@jvo.adv.br', password: 'segredo-123' });
});

it('shows the server error message on wrong credentials', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input) =>
      input === '/api/auth/me' ? json(401, { error: 'Não autenticado' }) : json(401, { error: 'E-mail ou senha inválidos' }),
    ),
  );
  renderLogin();
  await fillAndSubmit();
  expect((await screen.findByRole('alert')).textContent).toBe('E-mail ou senha inválidos');
  expect(screen.queryByText('Caixa de entrada')).toBeNull();
});

it('skips the form when already logged in', async () => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => json(200, ME)));
  renderLogin();
  expect(await screen.findByText('Caixa de entrada')).toBeTruthy();
});
```

- [ ] **Step 16: Run the test to verify it fails**

Run: `npm test -w web -- src/pages/Login.test.tsx`
Expected: FAIL with `Failed to resolve import "./Login"`.

- [ ] **Step 17: Implement `auth.tsx`**

`web/src/lib/auth.tsx`:

```tsx
import { MutationCache, QueryCache, QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import type { Me } from '@talk/shared';
import { api, ApiError, qk } from './api';

/** One QueryClient for the app: any 401 logs the user out locally; client errors are not retried. */
export function createQueryClient(): QueryClient {
  const onError = (err: Error) => {
    if (err instanceof ApiError && err.status === 401) qc.setQueryData(qk.me, null);
  };
  const qc: QueryClient = new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        retry: (count, err) => count < 2 && !(err instanceof ApiError && err.status >= 400 && err.status < 500),
      },
      mutations: { retry: false },
    },
  });
  return qc;
}

/** Current user; `null` = not logged in, `undefined` = still loading or server unreachable. */
export function useMe() {
  return useQuery<Me | null>({
    queryKey: qk.me,
    queryFn: async () => {
      try {
        return await api.auth.me();
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: Infinity,
  });
}

/** Only valid below <RequireAuth>. */
export function useCurrentUser(): Me {
  const { data } = useMe();
  if (!data) throw new Error('useCurrentUser usado fora de RequireAuth');
  return data;
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { email: string; password: string }) => api.auth.login(v.email, v.password),
    onSuccess: (me) => qc.setQueryData(qk.me, me),
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.auth.logout(),
    onSettled: () => {
      qc.setQueryData(qk.me, null);
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
    },
  });
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const me = useMe();
  const location = useLocation();
  if (me.data) return children;
  if (me.data === null) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  if (me.isPending) {
    return <div className="flex h-dvh items-center justify-center text-muted">Carregando…</div>;
  }
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-3 text-muted">
      <p>Não foi possível conectar ao servidor.</p>
      <button
        type="button"
        onClick={() => void me.refetch()}
        className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover"
      >
        Tentar novamente
      </button>
    </div>
  );
}
```

- [ ] **Step 18: Implement `Login.tsx`**

`web/src/pages/Login.tsx`:

```tsx
import type { FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router';
import { ChatsCircleIcon } from '@phosphor-icons/react';
import { useLogin, useMe } from '../lib/auth';

const inputClass =
  'w-full rounded-lg border border-border bg-surface px-3 py-2.5 text-fg outline-none placeholder:text-muted focus:border-primary focus:ring-2 focus:ring-primary/30';

export default function Login() {
  const me = useMe();
  const login = useLogin();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/chats';

  if (me.data) return <Navigate to={from} replace />;
  if (me.isPending) return null;

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    login.mutate({ email: String(form.get('email')).trim(), password: String(form.get('password')) });
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-sidebar px-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm space-y-5 rounded-2xl border border-border bg-panel p-8 shadow-2xl"
      >
        <div className="flex flex-col items-center gap-2 text-center">
          <ChatsCircleIcon size={44} weight="fill" className="text-primary" />
          <h1 className="text-xl font-semibold">Atendimento</h1>
          <p className="text-sm text-muted">Entre com seu e-mail e senha.</p>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="login-email" className="block text-sm font-medium">
            E-mail
          </label>
          <input id="login-email" name="email" type="email" required autoComplete="username" autoFocus className={inputClass} />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="login-password" className="block text-sm font-medium">
            Senha
          </label>
          <input
            id="login-password"
            name="password"
            type="password"
            required
            autoComplete="current-password"
            className={inputClass}
          />
        </div>
        {login.error && (
          <p role="alert" className="rounded-lg bg-danger/15 px-3 py-2 text-sm text-danger">
            {login.error.message}
          </p>
        )}
        <button
          type="submit"
          disabled={login.isPending}
          className="w-full rounded-lg bg-primary py-2.5 font-medium text-white transition-colors hover:bg-primary-hover disabled:opacity-60"
        >
          {login.isPending ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    </main>
  );
}
```

- [ ] **Step 19: Run the test to verify it passes**

Run: `npm test -w web -- src/pages/Login.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 20: Write the theme, layout, routes and entry point**

`web/src/index.css`:

```css
@import "tailwindcss";

/* Dark theme modelled on Umbler Talk: near-black icon sidebar, blue primary. */
@theme {
  --color-sidebar: #14161b;
  --color-sidebar-hover: #22252d;
  --color-sidebar-active: #2b3040;
  --color-surface: #1b1e25;
  --color-panel: #23262f;
  --color-border: #313543;
  --color-fg: #e7e9ef;
  --color-muted: #9aa1b1;
  --color-primary: #4a6cf7;
  --color-primary-hover: #3b5ce6;
  --color-danger: #e5484d;
  --color-success: #30a46c;
  --font-sans: ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif;
}

:root {
  color-scheme: dark;
}

html,
body,
#root {
  height: 100%;
}

body {
  margin: 0;
  background-color: var(--color-surface);
  color: var(--color-fg);
  font-family: var(--font-sans);
  -webkit-font-smoothing: antialiased;
}
```

`web/src/components/layout/AppLayout.tsx`:

```tsx
import { useEffect } from 'react';
import { Link, NavLink, Outlet } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AddressBookIcon,
  ChatCircleDotsIcon,
  ChatsCircleIcon,
  GearSixIcon,
  SignOutIcon,
  WarningCircleIcon,
  type Icon,
} from '@phosphor-icons/react';
import { api, qk } from '../../lib/api';
import { useCurrentUser, useLogout } from '../../lib/auth';
import { initials } from '../../lib/format';
import { connectWs } from '../../lib/ws';

function NavItem({ to, label, icon: IconCmp }: { to: string; label: string; icon: Icon }) {
  return (
    <NavLink
      to={to}
      title={label}
      aria-label={label}
      className={({ isActive }) =>
        `relative flex size-11 items-center justify-center rounded-xl transition-colors ${
          isActive
            ? 'bg-sidebar-active text-white before:absolute before:-left-2.5 before:h-6 before:w-1 before:rounded-r before:bg-primary'
            : 'text-muted hover:bg-sidebar-hover hover:text-fg'
        }`
      }
    >
      {({ isActive }) => <IconCmp size={24} weight={isActive ? 'fill' : 'regular'} />}
    </NavLink>
  );
}

function UserMenu() {
  const me = useCurrentUser();
  const logout = useLogout();
  return (
    <>
      <button
        type="button"
        popoverTarget="user-menu"
        title={me.name}
        aria-label="Menu do usuário"
        className="flex size-10 items-center justify-center rounded-full bg-primary text-sm font-semibold text-white hover:ring-2 hover:ring-primary/40"
      >
        {initials(me.name)}
      </button>
      <div
        id="user-menu"
        popover="auto"
        className="inset-auto bottom-3 left-18 m-0 w-60 rounded-xl border border-border bg-panel p-2 text-fg shadow-2xl"
      >
        <div className="px-3 py-2">
          <p className="truncate text-sm font-medium">{me.name}</p>
          <p className="truncate text-xs text-muted">{me.email}</p>
        </div>
        <button
          type="button"
          onClick={() => logout.mutate()}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-sidebar-hover"
        >
          <SignOutIcon size={18} /> Sair
        </button>
      </div>
    </>
  );
}

function ChannelBanner() {
  const me = useCurrentUser();
  const { data } = useQuery({ queryKey: qk.channels, queryFn: api.channels.list });
  const down = (data ?? []).filter((c) => c.status !== 'connected');
  if (down.length === 0) return null;
  return (
    <div role="alert" className="flex items-center gap-2 bg-danger px-4 py-2 text-sm font-medium text-white">
      <WarningCircleIcon size={18} weight="fill" />
      <span>WhatsApp desconectado: {down.map((c) => c.name).join(', ')}.</span>
      {me.role === 'admin' && (
        <Link to="/configuracoes/canais" className="underline underline-offset-2">
          Reconectar
        </Link>
      )}
    </div>
  );
}

export default function AppLayout() {
  const qc = useQueryClient();
  useEffect(() => connectWs(qc), [qc]);

  return (
    <div className="flex h-dvh bg-surface text-fg">
      <nav className="flex w-16 shrink-0 flex-col items-center gap-1 bg-sidebar py-3" aria-label="Menu principal">
        <ChatsCircleIcon size={32} weight="fill" className="mb-4 text-primary" aria-hidden />
        <NavItem to="/chats" label="Conversas" icon={ChatCircleDotsIcon} />
        <NavItem to="/contacts" label="Contatos" icon={AddressBookIcon} />
        <NavItem to="/configuracoes" label="Configurações" icon={GearSixIcon} />
        <div className="flex-1" />
        <UserMenu />
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <ChannelBanner />
        <main className="min-h-0 flex-1">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
```

`web/src/App.tsx`:

```tsx
import { Navigate, type RouteObject } from 'react-router';
import AppLayout from './components/layout/AppLayout';
import { RequireAuth } from './lib/auth';
import Login from './pages/Login';

function NotFound() {
  return <div className="flex h-full items-center justify-center text-muted">Página não encontrada.</div>;
}

export const routes: RouteObject[] = [
  { path: '/login', element: <Login /> },
  {
    path: '/',
    element: (
      <RequireAuth>
        <AppLayout />
      </RequireAuth>
    ),
    children: [
      { index: true, element: <Navigate to="/chats" replace /> },
      // Tasks 16, 18 and 19 insert `chats`, `contacts` and `configuracoes/:section?` here, above the catch-all.
      { path: '*', element: <NotFound /> },
    ],
  },
];
```

`web/src/main.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { routes } from './App';
import { createQueryClient } from './lib/auth';
import './index.css';

const queryClient = createQueryClient();
const router = createBrowserRouter(routes);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
```

- [ ] **Step 21: Typecheck and build**

Run: `npm run build -w web`
Expected: `tsc --noEmit` reports no errors, and `vite build` ends with `✓ built in …`, writing `web/dist/index.html` and `web/dist/assets/*`. The layout and entry point are presentational and are verified by this step, not by unit tests.

If `tsc` reports `popover`/`popoverTarget` as unknown props, the installed `@types/react` is older than 19.1. Re-run `npm install -w web --save-exact -D @types/react@19 @types/react-dom@19`.

- [ ] **Step 22: Run the whole web suite**

Run: `npm test -w web`
Expected: PASS. There are 4 files and 35 tests: format 12, api 11, ws 9, Login 3.

- [ ] **Step 23: Manual smoke check (dev)**

With the server running on :3000 (`APP_ORIGIN=http://localhost:5173`) and an admin seeded, run `npm run dev -w web` and open `http://localhost:5173`.

Expected:
- `/` redirects to `/login`.
- A wrong password shows the red server message.
- A correct login lands on `/chats`, which shows "Página não encontrada." until Task 16.
- The left icon sidebar is visible.
- Clicking the avatar opens the menu, and **Sair** returns to `/login`.
- DevTools → Network → WS shows `/ws` with status 101.
- If the channel is not `connected`, the red "WhatsApp desconectado" banner is visible.

- [ ] **Step 24: Commit**

```bash
git add package-lock.json web/package.json web/tsconfig.json web/vite.config.ts web/index.html \
  web/src/main.tsx web/src/App.tsx web/src/index.css \
  web/src/lib/format.ts web/src/lib/format.test.ts web/src/lib/api.ts web/src/lib/api.test.ts \
  web/src/lib/ws.ts web/src/lib/ws.test.ts web/src/lib/auth.tsx \
  web/src/components/layout/AppLayout.tsx web/src/pages/Login.tsx web/src/pages/Login.test.tsx
git commit -m "feat(web): API client, auth, realtime cache sync, layout and login

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


---

### Task 16: Web inbox: chat list, tabs, filters, search, pins, new conversation

Left column of `/chats` mirroring Umbler (MAPA §3): tabs **Entrada / Esperando / Finalizados** with unread badges, debounced search, filter panel (setor, atendente incl. "Sem dono", etiqueta, período), infinite list, pin/unpin from the item menu, **+ Nova conversa** dialog, and browser notification + sound for incoming messages while the tab is hidden. The right pane is an `<Outlet />`; Task 17 replaces the `:id` placeholder with the conversation view.

**Files:**
- Modify: `web/src/lib/format.ts` (append `contactLabel`, `listTime`)
- Create: `web/src/components/inbox/chat-query.ts`
- Create: `web/src/components/inbox/ChatListItem.tsx`
- Create: `web/src/components/inbox/FilterPanel.tsx`
- Create: `web/src/components/inbox/NewChatDialog.tsx`
- Create: `web/src/pages/Inbox.tsx`
- Create: `web/src/lib/notify.tsx`
- Modify: `web/src/App.tsx` (the `chats` routes)
- Modify: `web/src/components/layout/AppLayout.tsx` (Task 15's authenticated shell: user menu + notification hook)
- Test: `web/src/lib/format-inbox.test.ts`
- Test: `web/src/components/inbox/chat-query.test.ts`
- Test: `web/src/components/inbox/NewChatDialog.test.tsx`
- Test: `web/src/pages/Inbox.test.tsx`

**Interfaces:**
- Consumes (shared contract, package `@talk/shared` from Task 1): `ChatTab`, `ChatListItem`, `ChatDetail`, `ContactDto`, `SectorDto`, `TagDto`, `UserDto`, `WsEvent`.
- Consumes (REST, Task 13/12): `GET /api/chats?tab&q&sectorId&ownerId&tagId&from&to&cursor&limit` → `{ items: ChatListItem[]; nextCursor: string | null }`; `POST /api/chats {contactId? | phone?, name?, sectorId?}` → `ChatDetail`; `PUT|DELETE /api/chats/:id/pin` → 204 (409 when the user already has 3 pins); `GET /api/contacts?q&limit` → `{ items: ContactDto[]; nextCursor }`; `GET /api/sectors` → `SectorDto[]`; `GET /api/users` → `UserDto[]`; `GET /api/tags` → `TagDto[]`.
  - `ownerId=none` means "sem dono" (`owner_id IS NULL`). Task 13 must accept this sentinel.
  - `from`/`to` are ISO timestamps, inclusive bounds on the chat's creation time ("Período de criação" in Umbler).
  - `limit=50` is used. Task 13 must allow at least 50.
  - The server returns pinned chats first, then by `lastMessageAt` desc. The client renders in server order.
- Consumes (Task 15):
  - `web/src/lib/api.ts`: `api.chats.list(f: ChatListFilters): Promise<ChatPage>`, `api.chats.start(input: StartChatInput): Promise<ChatDetail>`, `api.chats.pin(id: string, pinned: boolean): Promise<void>`, `api.contacts.list(q?: ContactListQuery): Promise<Page<ContactDto>>`, `api.sectors.list()`, `api.users.list()`, `api.tags.list()`; `class ApiError extends Error { status: number }`; `qk.chats`, `qk.chatList(f: ChatListFilters)`, `qk.contactList(q: ContactListQuery)`, `qk.sectors`, `qk.users`, `qk.tags`. Chat lists are `useInfiniteQuery` under `qk.chatList(filters)` with `pageParam` = cursor (`ChatListData`).
  - `web/src/lib/ws.ts`: `applyWsEvent(qc, event)`, `connectWs(qc, url?)` and `onWsEvent(fn: (ev: WsEvent) => void): () => void` (called with every parsed event after the cache is updated; returns unsubscribe). `applyWsEvent` already patches and invalidates every `qk.chatLists` query on `chat.updated` / `chat.removed`, and `connectWs` invalidates `qk.chats` on (re)connect, so the inbox adds no WebSocket handling of its own.
  - `web/src/lib/format.ts`: `initials(name: string | null | undefined): string` (`'?'` when empty) and `formatPhone`. This task does not redeclare `initials` or `relativeTime`.
  - `web/src/components/layout/AppLayout.tsx`: default export `AppLayout`, with the `UserMenu` popover holding the "Sair" button.
  - `web/src/App.tsx`: `export const routes: RouteObject[]`. The authenticated layout route `path: '/'` has `children` ending in `{ path: '*' }`, its index redirects to `/chats`, and the sidebar "Conversas" item links to `/chats`.
  - `QueryClientProvider` mounted in `main.tsx`.
  - The web workspace has `"test": "vitest run"` and `"build"` scripts, plus `@testing-library/react` and `jsdom` installed.
- Produces:
  - `web/src/lib/format.ts`: `contactLabel(c: { name: string | null; phone: string | null }): string`, `listTime(iso: string, now?: Date): string` (list "horário": HH:MM today, "Ontem", dd/mm, dd/mm/yy).
  - `web/src/components/inbox/chat-query.ts`: `type Period = 'any' | 'today' | '7d' | '30d' | 'range'`, `interface InboxFilters { sectorId: string; ownerId: string; tagId: string; period: Period; rangeFrom: string; rangeTo: string }`, `EMPTY_FILTERS`, `NO_OWNER = 'none'`, `PAGE_SIZE = 50`, `buildChatQuery(tab: ChatTab, q: string, f: InboxFilters, now?: Date): ChatListFilters` (no `cursor`; the infinite query adds it per page).
  - `web/src/components/inbox/ChatListItem.tsx`: `ChatListItem(props: { chat: ChatListItem; sectorName: string | null; ownerName: string | null; active: boolean; onOpen(): void; onTogglePin(): void })`.
  - `web/src/components/inbox/NewChatDialog.tsx`: `NewChatDialog(props: { sectors: SectorDto[]; onClose(): void })`. Task 17 and Task 18 call `api.chats.start({ contactId })` directly and do not need it.
  - `web/src/pages/Inbox.tsx`: `Inbox()`. It renders the left column plus `<Outlet />` for the right pane.
  - React Query keys: `qk.chatList(buildChatQuery(…))` for both the list and the tab badges (the unfiltered list and its badge share one cache entry), `qk.sectors`, `qk.users`, `qk.tags`, `qk.contactList({ q, limit: 8 })`.
  - Routes: `/chats` (index: "Selecione uma conversa") and `/chats/:id` (placeholder element that Task 17 replaces).
  - `web/src/lib/notify.tsx`: `useMessageNotifications(): void`, `NotificationPermissionButton()`.

- [ ] **Step 1: Make sure the DOM testing peer is installed**

`@testing-library/react@16` needs `@testing-library/dom` as a peer.

Run: `npm ls -w web @testing-library/dom`
If it prints `(empty)`, run: `npm install -w web -D --save-exact @testing-library/dom@10.4.0`
Expected: `npm ls -w web @testing-library/dom` lists `@testing-library/dom@10.4.0` (or the version Task 15 already installed).

- [ ] **Step 2: Write the failing test for the display helpers**

`web/src/lib/format-inbox.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { contactLabel, listTime } from './format';

describe('contactLabel', () => {
  it('prefers the trimmed name', () => {
    expect(contactLabel({ name: '  Ana  ', phone: '5565999990000' })).toBe('Ana');
  });
  it('formats canonical mobile and landline phones', () => {
    expect(contactLabel({ name: null, phone: '5565999990000' })).toBe('(65) 99999-0000');
    expect(contactLabel({ name: '', phone: '556532221111' })).toBe('(65) 3222-1111');
  });
  it('handles missing data', () => {
    expect(contactLabel({ name: null, phone: '123' })).toBe('123');
    expect(contactLabel({ name: null, phone: null })).toBe('Sem nome');
  });
});

describe('listTime', () => {
  const now = new Date(2026, 9, 14, 15, 30);
  it('shows HH:MM for today', () => {
    expect(listTime(new Date(2026, 9, 14, 9, 5).toISOString(), now)).toBe('09:05');
  });
  it('shows Ontem for yesterday', () => {
    expect(listTime(new Date(2026, 9, 13, 23, 59).toISOString(), now)).toBe('Ontem');
  });
  it('shows dd/mm this year and dd/mm/yy before', () => {
    expect(listTime(new Date(2026, 9, 1, 10, 0).toISOString(), now)).toBe('01/10');
    expect(listTime(new Date(2025, 11, 31, 10, 0).toISOString(), now)).toBe('31/12/25');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -w web -- src/lib/format-inbox.test.ts`
Expected: FAIL. `contactLabel` and `listTime` are not exported by `./format`.

- [ ] **Step 4: Append the helpers to `web/src/lib/format.ts`**

Add at the end of the file and keep Task 15's existing exports (`relativeTime`, `formatPhone`, `initials`) unchanged. Do not redeclare them: Task 15's `relativeTime` ("há 5 minutos") stays for other screens, and the list uses `listTime` for the Umbler "horário" column.
```ts
/** Contact display name: name, else canonical phone formatted as (DD) 99999-9999 / (DD) 3222-1111. */
export function contactLabel(c: { name: string | null; phone: string | null }): string {
  const name = c.name?.trim();
  if (name) return name;
  const phone = c.phone ?? '';
  const m = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(phone);
  if (m) return `(${m[1]}) ${m[2]}-${m[3]}`;
  return phone || 'Sem nome';
}

/** Chat list time: HH:MM today, "Ontem", dd/mm this year, dd/mm/yy older. */
export function listTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Ontem';
  return d.toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    ...(d.getFullYear() !== now.getFullYear() ? { year: '2-digit' as const } : {}),
  });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -w web -- src/lib/format-inbox.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Write the failing test for `buildChatQuery`**

`web/src/components/inbox/chat-query.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { buildChatQuery, EMPTY_FILTERS, NO_OWNER, type InboxFilters } from './chat-query';

const now = new Date(2026, 9, 14, 15, 30); // 14/10/2026 15:30 local time

describe('buildChatQuery', () => {
  it('sends only tab and limit when nothing is filtered', () => {
    expect(buildChatQuery('inbox', '', EMPTY_FILTERS, now)).toEqual({ tab: 'inbox', limit: 50 });
    expect(buildChatQuery('closed', '   ', EMPTY_FILTERS, now)).toEqual({ tab: 'closed', limit: 50 });
  });

  it('maps search, sector, "sem dono" and tag', () => {
    const f: InboxFilters = { ...EMPTY_FILTERS, sectorId: 's1', ownerId: NO_OWNER, tagId: 't1' };
    expect(buildChatQuery('waiting', '  Ana Souza ', f, now)).toEqual({
      tab: 'waiting',
      limit: 50,
      q: 'Ana Souza',
      sectorId: 's1',
      ownerId: 'none',
      tagId: 't1',
    });
  });

  it('maps Hoje / 7 dias / 30 dias to a start-of-day "from"', () => {
    const at = (period: InboxFilters['period']) => buildChatQuery('inbox', '', { ...EMPTY_FILTERS, period }, now);
    expect(at('today').from).toBe(new Date(2026, 9, 14).toISOString());
    expect(at('7d').from).toBe(new Date(2026, 9, 8).toISOString());
    expect(at('30d').from).toBe(new Date(2026, 8, 15).toISOString());
    expect(at('today').to).toBeUndefined();
  });

  it('maps Intervalo to start of first day and end of last day', () => {
    const f: InboxFilters = { ...EMPTY_FILTERS, period: 'range', rangeFrom: '2026-10-01', rangeTo: '2026-10-10' };
    const out = buildChatQuery('closed', '', f, now);
    expect(out.from).toBe(new Date(2026, 9, 1).toISOString());
    expect(out.to).toBe(new Date(2026, 9, 10, 23, 59, 59, 999).toISOString());
  });

  it('ignores empty range fields and range fields when period is not Intervalo', () => {
    expect(buildChatQuery('inbox', '', { ...EMPTY_FILTERS, period: 'range' }, now)).toEqual({ tab: 'inbox', limit: 50 });
    expect(
      buildChatQuery('inbox', '', { ...EMPTY_FILTERS, rangeFrom: '2026-10-01', rangeTo: '2026-10-10' }, now),
    ).toEqual({ tab: 'inbox', limit: 50 });
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npm test -w web -- src/components/inbox/chat-query.test.ts`
Expected: FAIL. Vitest reports that it cannot resolve `./chat-query`.

- [ ] **Step 8: Implement `chat-query.ts`**

`web/src/components/inbox/chat-query.ts`
```ts
import type { ChatListFilters, ChatTab } from '@talk/shared';

export type Period = 'any' | 'today' | '7d' | '30d' | 'range';

/** UI filter state; '' means "todos". rangeFrom/rangeTo are <input type="date"> values (YYYY-MM-DD). */
export interface InboxFilters {
  sectorId: string;
  ownerId: string;
  tagId: string;
  period: Period;
  rangeFrom: string;
  rangeTo: string;
}

export const EMPTY_FILTERS: InboxFilters = { sectorId: '', ownerId: '', tagId: '', period: 'any', rangeFrom: '', rangeTo: '' };
/** ownerId sentinel for "Sem dono" (server: owner_id IS NULL). */
export const NO_OWNER = 'none';
export const PAGE_SIZE = 50;

function startOfDaysAgo(now: Date, days: number): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - days);
}

function parseDay(value: string, endOfDay: boolean): Date {
  const [y, m, d] = value.split('-').map(Number);
  return endOfDay ? new Date(y, m - 1, d, 23, 59, 59, 999) : new Date(y, m - 1, d);
}

/**
 * Maps tab + search + filters to the ChatListFilters passed to api.chats.list and qk.chatList.
 * No cursor: the infinite query adds it per page. Only set fields appear, so equal filters give equal query keys.
 */
export function buildChatQuery(tab: ChatTab, q: string, f: InboxFilters, now: Date = new Date()): ChatListFilters {
  const out: ChatListFilters = { tab, limit: PAGE_SIZE };
  const term = q.trim();
  if (term) out.q = term;
  if (f.sectorId) out.sectorId = f.sectorId;
  if (f.ownerId) out.ownerId = f.ownerId;
  if (f.tagId) out.tagId = f.tagId;
  if (f.period === 'today') out.from = startOfDaysAgo(now, 0).toISOString();
  if (f.period === '7d') out.from = startOfDaysAgo(now, 6).toISOString();
  if (f.period === '30d') out.from = startOfDaysAgo(now, 29).toISOString();
  if (f.period === 'range') {
    if (f.rangeFrom) out.from = parseDay(f.rangeFrom, false).toISOString();
    if (f.rangeTo) out.to = parseDay(f.rangeTo, true).toISOString();
  }
  return out;
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `npm test -w web -- src/components/inbox/chat-query.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 10: Commit**

```bash
git add web/package.json package-lock.json web/src/lib/format.ts web/src/lib/format-inbox.test.ts web/src/components/inbox/chat-query.ts web/src/components/inbox/chat-query.test.ts
git commit -m "feat(web): chat list query mapping and display helpers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 11: Write the failing test for `NewChatDialog`**

`web/src/components/inbox/NewChatDialog.test.tsx`
```tsx
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { ContactDto } from '@talk/shared';
import { NewChatDialog } from './NewChatDialog';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

const ana: ContactDto = {
  id: 'ct-ana', name: 'Ana Souza', phone: '5565999991111', lid: null, email: null, landline: null,
  address: null, blocked: false, tagIds: [], fields: {}, createdAt: '2026-10-01T10:00:00.000Z',
};

const calls: Array<{ method: string; path: string; body: unknown }> = [];

function stubApi() {
  calls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    calls.push({ method, path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.pathname === '/api/contacts') {
      return json({ items: url.searchParams.get('q') === 'Ana' ? [ana] : [], nextCursor: null });
    }
    if (url.pathname === '/api/chats' && method === 'POST') return json({ id: 'chat-1' });
    return json({ error: 'inesperado' }, 500);
  }));
}

function renderDialog(onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/chats']}>
        <Routes>
          <Route
            path="/chats"
            element={<NewChatDialog sectors={[{ id: 's1', name: 'Financeiro', position: 1, isDefault: false }]} onClose={onClose} />}
          />
          <Route path="/chats/:id" element={<p>conversa aberta</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return onClose;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('submits a typed phone with name and sector, then opens the new chat', async () => {
  stubApi();
  const onClose = renderDialog();
  fireEvent.change(screen.getByLabelText('Contato ou telefone'), { target: { value: '(65) 99999-9999' } });
  fireEvent.change(screen.getByLabelText('Nome (opcional)'), { target: { value: ' Ana Souza ' } });
  fireEvent.change(screen.getByLabelText('Setor'), { target: { value: 's1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Iniciar conversa' }));

  await screen.findByText('conversa aberta');
  const post = calls.find((c) => c.method === 'POST' && c.path === '/api/chats');
  expect(post?.body).toEqual({ phone: '(65) 99999-9999', name: 'Ana Souza', sectorId: 's1' });
  expect(onClose).toHaveBeenCalled();
});

it('starts a chat with an existing contact picked from the search', async () => {
  stubApi();
  renderDialog();
  fireEvent.change(screen.getByLabelText('Contato ou telefone'), { target: { value: 'Ana' } });
  fireEvent.click(await screen.findByRole('button', { name: /Ana Souza/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Iniciar conversa' }));

  await screen.findByText('conversa aberta');
  const post = calls.find((c) => c.method === 'POST' && c.path === '/api/chats');
  expect(post?.body).toEqual({ contactId: 'ct-ana' });
});

it('rejects a phone without DDD and does not call the API', async () => {
  stubApi();
  renderDialog();
  fireEvent.change(screen.getByLabelText('Contato ou telefone'), { target: { value: '9999-0000' } });
  fireEvent.click(screen.getByRole('button', { name: 'Iniciar conversa' }));

  expect((await screen.findByRole('alert')).textContent).toBe('Escolha um contato ou digite um telefone com DDD.');
  await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(false));
});
```

- [ ] **Step 12: Run test to verify it fails**

Run: `npm test -w web -- src/components/inbox/NewChatDialog.test.tsx`
Expected: FAIL. Vitest reports that it cannot resolve `./NewChatDialog`.

- [ ] **Step 13: Implement `NewChatDialog`**

`web/src/components/inbox/NewChatDialog.tsx`
```tsx
import { useId, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { ContactDto, SectorDto } from '@talk/shared';
import { api, qk, type StartChatInput } from '../../lib/api';
import { contactLabel } from '../../lib/format';

interface Props {
  sectors: SectorDto[];
  onClose(): void;
}

/** "+ Nova conversa": pick an existing contact or type a phone (+ optional name), choose sector, POST /api/chats. */
export function NewChatDialog({ sectors, onClose }: Props) {
  const navigate = useNavigate();
  const ids = { text: useId(), name: useId(), sector: useId(), title: useId() };
  const [text, setText] = useState('');
  const [contact, setContact] = useState<ContactDto | null>(null);
  const [name, setName] = useState('');
  const [sectorId, setSectorId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const term = text.trim();

  // ponytail: one request per keystroke (cached per term); debounce if contact search gets slow
  const search = { q: term, limit: 8 };
  const results = useQuery({
    queryKey: qk.contactList(search),
    queryFn: () => api.contacts.list(search),
    enabled: !contact && term.length >= 2,
  });

  const start = useMutation({
    mutationFn: () => {
      const target: StartChatInput = contact
        ? { contactId: contact.id }
        : { phone: term, ...(name.trim() ? { name: name.trim() } : {}) };
      return api.chats.start({ ...target, ...(sectorId ? { sectorId } : {}) });
    },
    onSuccess: (chat) => {
      onClose();
      navigate(`/chats/${chat.id}`);
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Ocorreu um erro'),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!contact && term.replace(/\D/g, '').length < 10) {
      setError('Escolha um contato ou digite um telefone com DDD.');
      return;
    }
    start.mutate();
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') onClose();
  }

  const input = 'mt-1 w-full rounded bg-zinc-800 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-600';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby={ids.title}
        onSubmit={submit}
        onKeyDown={onKeyDown}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md space-y-3 rounded-lg bg-zinc-900 p-4 text-zinc-100 shadow-xl"
      >
        <h2 id={ids.title} className="text-lg font-semibold">Nova conversa</h2>

        {contact ? (
          <div className="flex items-center gap-2 rounded bg-zinc-800 px-3 py-2 text-sm">
            <span className="flex-1 truncate">{contactLabel(contact)}</span>
            <button type="button" onClick={() => setContact(null)} className="text-emerald-400 underline">Trocar</button>
          </div>
        ) : (
          <>
            <div>
              <label htmlFor={ids.text} className="text-sm text-zinc-300">Contato ou telefone</label>
              <input
                id={ids.text}
                autoFocus
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Nome ou (65) 99999-9999"
                className={input}
              />
            </div>
            {results.data && results.data.items.length > 0 && (
              <ul className="max-h-48 overflow-y-auto rounded border border-zinc-800">
                {results.data.items.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => setContact(c)}
                      className="w-full px-3 py-2 text-left text-sm hover:bg-zinc-800"
                    >
                      {contactLabel(c)}
                      {c.name && c.phone ? ` · ${contactLabel({ name: null, phone: c.phone })}` : ''}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div>
              <label htmlFor={ids.name} className="text-sm text-zinc-300">Nome (opcional)</label>
              <input id={ids.name} value={name} onChange={(e) => setName(e.target.value)} className={input} />
            </div>
          </>
        )}

        <div>
          <label htmlFor={ids.sector} className="text-sm text-zinc-300">Setor</label>
          <select id={ids.sector} value={sectorId} onChange={(e) => setSectorId(e.target.value)} className={input}>
            <option value="">Setor padrão</option>
            {sectors.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </div>

        {error && <p role="alert" className="text-sm text-red-400">{error}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="rounded px-3 py-2 text-sm hover:bg-zinc-800">Cancelar</button>
          <button
            type="submit"
            disabled={start.isPending}
            className="rounded bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            Iniciar conversa
          </button>
        </div>
      </form>
    </div>
  );
}
```

- [ ] **Step 14: Run test to verify it passes**

Run: `npm test -w web -- src/components/inbox/NewChatDialog.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 15: Write the failing test for the inbox page**

`web/src/pages/Inbox.test.tsx`
```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { ChatListItem } from '@talk/shared';
import { Inbox } from './Inbox';

const chatA: ChatListItem = {
  id: 'a',
  contact: { id: 'ct1', name: 'Ana Souza', phone: '5565999991111' },
  channelId: 'ch1',
  sectorId: 's1',
  ownerId: 'u1',
  state: 'open',
  waiting: true,
  private: true,
  unread: 3,
  lastMessageAt: '2026-10-14T12:00:00.000Z',
  lastMessagePreview: 'Bom dia',
  pinned: true,
  tagIds: [],
};
const chatB: ChatListItem = {
  ...chatA,
  id: 'b',
  contact: { id: 'ct2', name: null, phone: '5565999990000' },
  ownerId: null,
  private: false,
  unread: 1,
  lastMessagePreview: 'Oi',
  pinned: false,
};

const calls: Array<{ method: string; url: URL }> = [];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    calls.push({ method, url });
    if (url.pathname === '/api/sectors') return json([{ id: 's1', name: 'Financeiro', position: 1, isDefault: false }]);
    if (url.pathname === '/api/users') {
      return json([{ id: 'u1', name: 'Maria Lima', email: 'maria@exemplo.com.br', role: 'agent', signature: null, active: true, sectorIds: ['s1'] }]);
    }
    if (url.pathname === '/api/tags') return json([]);
    if (url.pathname === '/api/chats/a/pin') return new Response(null, { status: 204 });
    if (url.pathname === '/api/chats') {
      return json({ items: url.searchParams.get('tab') === 'inbox' ? [chatA, chatB] : [], nextCursor: null });
    }
    return json({ error: 'inesperado' }, 500);
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderInbox() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/chats']}>
        <Routes>
          <Route path="/chats" element={<Inbox />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

it('renders chat items with preview, unread, owner, sector, lock and pin', async () => {
  renderInbox();
  expect(await screen.findByText('Ana Souza')).toBeTruthy();
  expect(screen.getByText('(65) 99999-0000')).toBeTruthy();
  expect(screen.getByText('Bom dia')).toBeTruthy();
  expect(screen.getByLabelText('Não lidas: 3')).toBeTruthy();
  expect(screen.getByLabelText('Conversa privada')).toBeTruthy();
  expect(screen.getByLabelText('Fixada')).toBeTruthy();
  expect((await screen.findByTitle('Maria Lima')).textContent).toBe('ML');
  expect((await screen.findAllByText('Financeiro')).length).toBe(2);
});

it('shows the unread badge on Entrada and switches to Esperando', async () => {
  renderInbox();
  expect(await screen.findByLabelText('Conversas não lidas: 2')).toBeTruthy();
  fireEvent.click(screen.getByRole('tab', { name: /Esperando/ }));
  expect(await screen.findByText('Nenhuma conversa')).toBeTruthy();
  expect(screen.getByRole('tab', { name: /Esperando/ }).getAttribute('aria-selected')).toBe('true');
});

it('sends the debounced search term as q', async () => {
  renderInbox();
  await screen.findByText('Ana Souza');
  fireEvent.change(screen.getByLabelText('Buscar conversas'), { target: { value: 'ana' } });
  await waitFor(() =>
    expect(calls.some((c) => c.url.pathname === '/api/chats' && c.url.searchParams.get('q') === 'ana')).toBe(true),
  );
});

it('unpins a chat from the item menu', async () => {
  renderInbox();
  await screen.findByText('Ana Souza');
  fireEvent.click(screen.getAllByLabelText('Opções da conversa')[0]);
  fireEvent.click(screen.getByText('Desafixar'));
  await waitFor(() =>
    expect(calls.some((c) => c.method === 'DELETE' && c.url.pathname === '/api/chats/a/pin')).toBe(true),
  );
});
```

- [ ] **Step 16: Run test to verify it fails**

Run: `npm test -w web -- src/pages/Inbox.test.tsx`
Expected: FAIL. Vitest reports that it cannot resolve `./Inbox`.

- [ ] **Step 17: Implement `ChatListItem`**

`web/src/components/inbox/ChatListItem.tsx`
```tsx
import { DotsThreeVertical, LockSimple, PushPin } from '@phosphor-icons/react';
import type { ChatListItem as ChatItem } from '@talk/shared';
import { contactLabel, initials, listTime } from '../../lib/format';

interface Props {
  chat: ChatItem;
  sectorName: string | null;
  ownerName: string | null;
  active: boolean;
  onOpen(): void;
  onTogglePin(): void;
}

export function ChatListItem({ chat, sectorName, ownerName, active, onOpen, onTogglePin }: Props) {
  const title = contactLabel(chat.contact);
  return (
    <li className={`flex items-stretch border-b border-zinc-800 ${active ? 'bg-zinc-800' : 'hover:bg-zinc-900'}`}>
      <button
        type="button"
        onClick={onOpen}
        aria-current={active ? 'true' : undefined}
        className="flex min-w-0 flex-1 gap-3 px-3 py-2 text-left"
      >
        <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-full bg-zinc-700 text-sm font-semibold">
          {/* ponytail: Task 15's initials; phone-only contacts show '?' */}
          {initials(chat.contact.name)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1">
            <span className="truncate font-medium">{title}</span>
            {chat.private && <LockSimple aria-label="Conversa privada" className="shrink-0 text-amber-400" />}
            {chat.pinned && <PushPin aria-label="Fixada" weight="fill" className="shrink-0 text-zinc-400" />}
            <span className="ml-auto shrink-0 text-xs text-zinc-500">
              {chat.lastMessageAt ? listTime(chat.lastMessageAt) : ''}
            </span>
          </span>
          <span className="flex items-center gap-2">
            <span className="truncate text-sm text-zinc-400">{chat.lastMessagePreview ?? ''}</span>
            {chat.unread > 0 && (
              <span
                aria-label={`Não lidas: ${chat.unread}`}
                className="ml-auto shrink-0 rounded-full bg-emerald-600 px-1.5 text-xs font-semibold text-white"
              >
                {chat.unread}
              </span>
            )}
          </span>
          <span className="mt-1 flex items-center gap-1">
            {sectorName && <span className="rounded bg-zinc-800 px-1.5 text-xs text-zinc-300">{sectorName}</span>}
            {ownerName && (
              <span
                title={ownerName}
                className="grid size-5 place-items-center rounded-full bg-sky-700 text-[10px] font-semibold text-white"
              >
                {initials(ownerName)}
              </span>
            )}
          </span>
        </span>
      </button>
      <details className="relative">
        <summary aria-label="Opções da conversa" className="cursor-pointer list-none px-1 py-3 text-zinc-400 hover:text-zinc-100">
          <DotsThreeVertical size={18} />
        </summary>
        <div className="absolute right-1 z-10 mt-1 rounded bg-zinc-800 py-1 shadow-lg">
          <button
            type="button"
            onClick={(e) => {
              e.currentTarget.closest('details')?.removeAttribute('open');
              onTogglePin();
            }}
            className="block w-full whitespace-nowrap px-3 py-1.5 text-left text-sm hover:bg-zinc-700"
          >
            {chat.pinned ? 'Desafixar' : 'Fixar'}
          </button>
        </div>
      </details>
    </li>
  );
}
```

- [ ] **Step 18: Implement `FilterPanel`**

`web/src/components/inbox/FilterPanel.tsx`
```tsx
import { useId } from 'react';
import type { SectorDto, TagDto, UserDto } from '@talk/shared';
import { EMPTY_FILTERS, NO_OWNER, type InboxFilters, type Period } from './chat-query';

const PERIODS: Array<[Period, string]> = [
  ['any', 'Qualquer'],
  ['today', 'Hoje'],
  ['7d', '7 dias'],
  ['30d', '30 dias'],
  ['range', 'Intervalo'],
];

interface Props {
  value: InboxFilters;
  onChange(next: InboxFilters): void;
  sectors: SectorDto[];
  users: UserDto[];
  tags: TagDto[];
}

export function FilterPanel({ value, onChange, sectors, users, tags }: Props) {
  const ids = { sector: useId(), owner: useId(), tag: useId(), from: useId(), to: useId() };
  const set = (patch: Partial<InboxFilters>) => onChange({ ...value, ...patch });
  const field = 'mt-1 w-full rounded bg-zinc-800 px-2 py-1.5 text-sm outline-none';

  return (
    <div className="space-y-2 border-b border-zinc-800 p-3 text-sm">
      <div>
        <label htmlFor={ids.sector} className="text-zinc-400">Setor</label>
        <select id={ids.sector} value={value.sectorId} onChange={(e) => set({ sectorId: e.target.value })} className={field}>
          <option value="">Todos</option>
          {sectors.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor={ids.owner} className="text-zinc-400">Atendente</label>
        <select id={ids.owner} value={value.ownerId} onChange={(e) => set({ ownerId: e.target.value })} className={field}>
          <option value="">Todos</option>
          <option value={NO_OWNER}>Sem dono</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>{u.name}</option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor={ids.tag} className="text-zinc-400">Etiqueta</label>
        <select id={ids.tag} value={value.tagId} onChange={(e) => set({ tagId: e.target.value })} className={field}>
          <option value="">Todas</option>
          {tags.map((t) => (
            <option key={t.id} value={t.id}>{`${t.emoji ? `${t.emoji} ` : ''}${t.name}`}</option>
          ))}
        </select>
      </div>
      <fieldset>
        <legend className="text-zinc-400">Período de criação</legend>
        <div className="mt-1 flex flex-wrap gap-1">
          {PERIODS.map(([p, label]) => (
            <button
              key={p}
              type="button"
              aria-pressed={value.period === p}
              onClick={() => set({ period: p })}
              className={`rounded px-2 py-1 ${value.period === p ? 'bg-emerald-700 text-white' : 'bg-zinc-800 hover:bg-zinc-700'}`}
            >
              {label}
            </button>
          ))}
        </div>
        {value.period === 'range' && (
          <div className="mt-2 flex gap-2">
            <div className="flex-1">
              <label htmlFor={ids.from} className="text-zinc-400">De</label>
              <input id={ids.from} type="date" value={value.rangeFrom} onChange={(e) => set({ rangeFrom: e.target.value })} className={field} />
            </div>
            <div className="flex-1">
              <label htmlFor={ids.to} className="text-zinc-400">Até</label>
              <input id={ids.to} type="date" value={value.rangeTo} onChange={(e) => set({ rangeTo: e.target.value })} className={field} />
            </div>
          </div>
        )}
      </fieldset>
      <button type="button" onClick={() => onChange(EMPTY_FILTERS)} className="text-emerald-400 underline">
        Limpar filtros
      </button>
    </div>
  );
}
```

- [ ] **Step 19: Implement the `Inbox` page**

`web/src/pages/Inbox.tsx`
```tsx
import { useEffect, useState, type UIEvent } from 'react';
import { Outlet, useNavigate, useParams } from 'react-router';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Funnel, MagnifyingGlass, Plus } from '@phosphor-icons/react';
import type { ChatListFilters, ChatListItem as ChatItem, ChatTab } from '@talk/shared';
import { api, ApiError, qk } from '../lib/api';
import { ChatListItem } from '../components/inbox/ChatListItem';
import { FilterPanel } from '../components/inbox/FilterPanel';
import { NewChatDialog } from '../components/inbox/NewChatDialog';
import { buildChatQuery, EMPTY_FILTERS, type InboxFilters } from '../components/inbox/chat-query';

const TABS: Array<{ tab: ChatTab; label: string }> = [
  { tab: 'inbox', label: 'Entrada' },
  { tab: 'waiting', label: 'Esperando' },
  { tab: 'closed', label: 'Finalizados' },
];

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

/** Infinite chat list under qk.chatList(f), pageParam = cursor. applyWsEvent (Task 15) keeps it fresh. */
function useChatList(f: ChatListFilters) {
  return useInfiniteQuery({
    queryKey: qk.chatList(f),
    queryFn: ({ pageParam }) => api.chats.list({ ...f, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

function useUnreadChats(tab: ChatTab): number {
  // ponytail: counts unread chats among the loaded pages (first 50) of the unfiltered tab; add a counts endpoint if a tab ever holds more
  const { data } = useChatList(buildChatQuery(tab, '', EMPTY_FILTERS));
  return data?.pages.flatMap((p) => p.items).filter((c) => c.unread > 0).length ?? 0;
}

export function Inbox() {
  const { id: activeId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [tab, setTab] = useState<ChatTab>('inbox');
  const [search, setSearch] = useState('');
  const q = useDebounced(search, 300);
  const [filters, setFilters] = useState<InboxFilters>(EMPTY_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);

  const sectors = useQuery({ queryKey: qk.sectors, queryFn: api.sectors.list });
  const users = useQuery({ queryKey: qk.users, queryFn: api.users.list });
  const tags = useQuery({ queryKey: qk.tags, queryFn: api.tags.list });
  const sectorName = new Map((sectors.data ?? []).map((s) => [s.id, s.name]));
  const userName = new Map((users.data ?? []).map((u) => [u.id, u.name]));
  const badges: Record<ChatTab, number> = { inbox: useUnreadChats('inbox'), waiting: useUnreadChats('waiting'), closed: 0 };

  const list = useChatList(buildChatQuery(tab, q, filters));
  const chats = list.data?.pages.flatMap((p) => p.items) ?? [];

  const pin = useMutation({
    mutationFn: (chat: ChatItem) => api.chats.pin(chat.id, !chat.pinned),
    onSuccess: () => {
      setPinError(null);
      // pins are per user: refetch this user's lists (pinned chats sort first)
      return qc.invalidateQueries({ queryKey: qk.chatLists });
    },
    onError: (err) =>
      setPinError(
        err instanceof ApiError && err.status === 409
          ? 'Você já fixou 3 conversas. Desafixe uma para fixar outra.'
          : err instanceof Error
            ? err.message
            : 'Ocorreu um erro',
      ),
  });

  function onScroll(e: UIEvent<HTMLUListElement>) {
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 200 && list.hasNextPage && !list.isFetchingNextPage) {
      void list.fetchNextPage();
    }
  }

  const activeFilters = [filters.sectorId, filters.ownerId, filters.tagId].filter(Boolean).length + (filters.period === 'any' ? 0 : 1);

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-96 shrink-0 flex-col border-r border-zinc-800">
        <div className="flex items-center gap-2 px-3 pt-3">
          <h1 className="text-lg font-semibold">Conversas</h1>
          <button
            type="button"
            aria-label="Nova conversa"
            title="Nova conversa"
            onClick={() => setShowNew(true)}
            className="ml-auto rounded p-1.5 hover:bg-zinc-800"
          >
            <Plus size={20} />
          </button>
        </div>

        <div role="tablist" className="mt-2 flex border-b border-zinc-800">
          {TABS.map(({ tab: t, label }) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`flex flex-1 items-center justify-center gap-1 py-2 text-sm ${
                tab === t ? 'border-b-2 border-emerald-500 font-medium text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {label}
              {badges[t] > 0 && (
                <span
                  aria-label={`Conversas não lidas: ${badges[t]}`}
                  className="rounded-full bg-emerald-600 px-1.5 text-xs font-semibold text-white"
                >
                  {badges[t]}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 p-3">
          <label className="flex flex-1 items-center gap-2 rounded bg-zinc-900 px-2">
            <MagnifyingGlass aria-hidden="true" className="text-zinc-500" />
            <input
              type="search"
              aria-label="Buscar conversas"
              placeholder="Buscar por nome ou telefone"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full bg-transparent py-1.5 text-sm outline-none"
            />
          </label>
          <button
            type="button"
            aria-label="Filtrar conversas"
            aria-expanded={showFilters}
            onClick={() => setShowFilters((v) => !v)}
            className={`relative rounded p-1.5 hover:bg-zinc-800 ${activeFilters ? 'text-emerald-400' : 'text-zinc-400'}`}
          >
            <Funnel size={20} weight={activeFilters ? 'fill' : 'regular'} />
          </button>
        </div>

        {showFilters && (
          <FilterPanel
            value={filters}
            onChange={setFilters}
            sectors={sectors.data ?? []}
            users={users.data ?? []}
            tags={tags.data ?? []}
          />
        )}
        {pinError && (
          <p role="alert" className="mx-3 mb-2 rounded bg-red-950 px-3 py-2 text-sm text-red-300">
            {pinError}
          </p>
        )}

        <ul className="min-h-0 flex-1 overflow-y-auto" onScroll={onScroll}>
          {chats.map((c) => (
            <ChatListItem
              key={c.id}
              chat={c}
              active={c.id === activeId}
              sectorName={sectorName.get(c.sectorId) ?? null}
              ownerName={c.ownerId ? (userName.get(c.ownerId) ?? null) : null}
              onOpen={() => navigate(`/chats/${c.id}`)}
              onTogglePin={() => pin.mutate(c)}
            />
          ))}
          {list.isPending && <li className="p-4 text-sm text-zinc-500">Carregando…</li>}
          {list.isError && <li className="p-4 text-sm text-red-400">Não foi possível carregar as conversas.</li>}
          {list.isSuccess && chats.length === 0 && <li className="p-4 text-sm text-zinc-500">Nenhuma conversa</li>}
          {list.isFetchingNextPage && <li className="p-4 text-sm text-zinc-500">Carregando…</li>}
        </ul>
      </aside>

      <section className="min-w-0 flex-1">
        <Outlet />
      </section>

      {showNew && <NewChatDialog sectors={sectors.data ?? []} onClose={() => setShowNew(false)} />}
    </div>
  );
}
```

- [ ] **Step 20: Run the inbox tests to verify they pass**

Run: `npm test -w web -- src/pages/Inbox.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 21: Commit**

```bash
git add web/src/components/inbox/ChatListItem.tsx web/src/components/inbox/FilterPanel.tsx web/src/components/inbox/NewChatDialog.tsx web/src/components/inbox/NewChatDialog.test.tsx web/src/pages/Inbox.tsx web/src/pages/Inbox.test.tsx
git commit -m "feat(web): inbox chat list with tabs, filters, search, pins and new conversation dialog

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 22: Implement browser notifications + sound**

The hook is a thin glue layer over `onWsEvent`, and its only branch is "incoming message while the tab is hidden". The typecheck and build in Step 25 verify it.

`web/src/lib/notify.tsx`
```tsx
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { onWsEvent } from './ws';

function beep(): void {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.value = 0.1;
    osc.connect(gain).connect(ctx.destination);
    osc.onended = () => void ctx.close();
    osc.start();
    osc.stop(ctx.currentTime + 0.15);
  } catch {
    // navegador bloqueou o áudio (sem interação prévia); a notificação ainda aparece
  }
}

/** Sound + browser notification for incoming WhatsApp messages while this tab is hidden. Mount once in the layout. */
export function useMessageNotifications(): void {
  const navigate = useNavigate();
  useEffect(
    () =>
      onWsEvent((e) => {
        if (e.type !== 'message.created' || e.message.direction !== 'in' || !document.hidden) return;
        beep();
        if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
        const { chatId, body } = e.message;
        const n = new Notification('Nova mensagem', { body: body ? body.slice(0, 120) : 'Mídia recebida', tag: chatId });
        n.onclick = () => {
          window.focus();
          navigate(`/chats/${chatId}`);
          n.close();
        };
      }),
    [navigate],
  );
}

/** Avatar-menu item that asks the browser for notification permission. */
export function NotificationPermissionButton() {
  const supported = typeof Notification !== 'undefined';
  const [permission, setPermission] = useState<NotificationPermission>(supported ? Notification.permission : 'denied');
  if (!supported) return null;
  if (permission === 'granted') return <p className="px-3 py-2 text-sm text-zinc-400">Notificações ativadas</p>;
  if (permission === 'denied') return <p className="px-3 py-2 text-sm text-zinc-400">Notificações bloqueadas no navegador</p>;
  return (
    <button
      type="button"
      onClick={async () => setPermission(await Notification.requestPermission())}
      className="block w-full px-3 py-2 text-left text-sm hover:bg-zinc-800"
    >
      Ativar notificações
    </button>
  );
}
```

- [ ] **Step 23: Wire notifications into the layout**

In `web/src/components/layout/AppLayout.tsx` (Task 15), add the import below the existing `../../lib/ws` import:
```tsx
import { NotificationPermissionButton, useMessageNotifications } from '../../lib/notify';
```
In `export default function AppLayout()`, add this call directly after `useEffect(() => connectWs(qc), [qc]);`, so it runs on every page and not only `/chats`:
```tsx
  useMessageNotifications();
```
In `UserMenu`, render this element inside the `#user-menu` popover, directly above the "Sair" `<button>`:
```tsx
        <NotificationPermissionButton />
```

- [ ] **Step 24: Register the routes**

In `web/src/App.tsx` (Task 15), add the import:
```tsx
import { Inbox } from './pages/Inbox';
```
In `routes`, inside the `children` of the `path: '/'` route, replace the comment line `// Tasks 16, 18 and 19 insert …` with the following. Keep it directly above `{ path: '*', element: <NotFound /> }`:
```tsx
      {
        path: 'chats',
        element: <Inbox />,
        children: [
          { index: true, element: <p className="grid h-full place-items-center text-sm text-zinc-500">Selecione uma conversa</p> },
          // Task 17 replaces this element with the conversation view
          { path: ':id', element: <p className="grid h-full place-items-center text-sm text-zinc-500">Carregando conversa…</p> },
        ],
      },
      // Tasks 18 and 19 insert `contacts` and `configuracoes/:section?` here, above the catch-all.
```

- [ ] **Step 25: Typecheck, build and run the whole web suite**

Run: `npx tsc --noEmit -p web`
Expected: exits 0 with no errors.

Run: `npm run build -w web`
Expected: Vite prints `✓ built in …` and writes `web/dist/index.html`.

Run: `npm test -w web`
Expected: PASS. This includes `format-inbox`, `chat-query`, `NewChatDialog` and `Inbox`, plus Task 15's tests.

- [ ] **Step 26: Manual check in the dev server**

Run: `npm run dev -w web` (with the server from Tasks 1–14 running), log in. You land on `/chats`.
Expected:
- The three tabs show, and Entrada carries a green badge when there are unread chats.
- Typing in the search refreshes the list after about 0.3 s.
- The funnel opens the filter panel. "Intervalo" shows two date inputs.
- "⋮ → Fixar" pins a chat. A 4th pin shows "Você já fixou 3 conversas…".
- "+" opens "Nova conversa". Submitting a new phone navigates to `/chats/<id>` with the placeholder.
- In the user menu (avatar at the bottom of the sidebar), "Ativar notificações" asks for permission. With another browser tab focused, an incoming WhatsApp message plays a beep and shows a "Nova mensagem" notification. Clicking it opens the chat.

- [ ] **Step 27: Commit**

```bash
git add web/src/lib/notify.tsx web/src/components/layout/AppLayout.tsx web/src/App.tsx
git commit -m "feat(web): /chats routes and incoming-message notifications

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


---

### Task 17: Web conversation view and composer

The right pane of the inbox (spec §3 item 3–4, MAPA §11e). It has three parts:
- **Header:** contact, sector chip, owner, and the actions Assumir, Contato, Transferir, Privar/Liberar, Finalizar and Reabrir.
- **Timeline:** infinite scroll toward older items, date separators, bubbles, notes, system events, media, quoted replies, reactions and status ticks with "Reenviar".
- **Composer:** Mensagem/Notas, Enter sends, `/` quick answers, file and drag-and-drop, voice recording, emoji grid, signature toggle and reply chip.

A closed chat shows the footer "Conversa finalizada — Nova conversa" instead of the composer. Opening a chat with unread messages marks it read.

Realtime is already handled globally by Task 15's `applyWsEvent`, which upserts the timeline and merges `chat.updated` into the detail. This task never opens its own socket. It reuses `applyWsEvent` to put its own POST responses into the cache, so the POST response and the WS echo can never show the same message twice.

**Files:**
- Create: `web/src/components/conversation/model.ts` (pure helpers: page merge, date rows, labels)
- Create: `web/src/components/conversation/QuickAnswerPicker.tsx`
- Create: `web/src/components/conversation/useAudioRecorder.ts`
- Create: `web/src/components/conversation/Composer.tsx`
- Create: `web/src/components/conversation/MessageBubble.tsx`
- Create: `web/src/components/conversation/Timeline.tsx`
- Create: `web/src/components/conversation/ChatDialogs.tsx` (transfer + finalize dialogs)
- Create: `web/src/components/conversation/ConversationHeader.tsx`
- Create: `web/src/components/conversation/ConversationView.tsx`
- Create: `web/src/pages/Conversation.tsx`
- Modify: `web/src/App.tsx` (the inbox's `:id` child route)
- Test: `web/src/components/conversation/model.test.ts`
- Test: `web/src/components/conversation/Composer.test.tsx`

**Interfaces:**
- Consumes (contract, `import type … from '@talk/shared'`): `ChatDetail`, `ChatEventDto`, `MessageDto`, `QuickAnswerDto`, `SectorDto`, `UserDto`, `SettingsDto`, `TimelineItem`.
- Consumes (Task 15):
  - `web/src/lib/api.ts`:
    - `api.chats.{get, timeline, assume, reopen, markRead, transfer, setPrivacy, close, start, sendText, sendFile, addNote}`
    - `api.messages.resend`
    - `api.quickAnswers.{list, render, attachmentUrl}`
    - `api.sectors.list`, `api.users.list`, `api.settings.get`
    - `class ApiError { status }`
    - `type TimelineData = InfiniteData<TimelineItem[], string | undefined>`: `pages[0]` is the newest page, each page is ascending, and the `pageParam` of an older page is `before`.
    - `qk.{chat(id), timeline(id), sectors, users, quickAnswers, settings}`
  - `web/src/lib/ws.ts`: `applyWsEvent(qc: QueryClient, event: WsEvent): void`.
  - `web/src/lib/auth.tsx`: `useCurrentUser(): Me`.
  - `web/src/lib/format.ts`: `formatPhone(phone: string | null | undefined): string`.
  - CSS tokens: `bg-surface`, `bg-panel`, `border-border`, `text-fg`, `text-muted`, `bg-primary`, `hover:bg-primary-hover`, `text-danger`, `bg-danger`.
- Consumes (Task 13 REST):
  - `GET /api/chats/:id/timeline?before=<id of the oldest item already loaded>&limit=` returns the newest `limit` items older than `before`, in ascending order. `limit` is at most 100. This task uses 50.
  - Multipart `POST /api/chats/:id/messages` takes `signature` as `"true"`/`"false"` and `asVoice`. Task 15's `api.chats.sendFile` builds that form.
- Consumes (Task 7 event `data` shapes):
  - `created {by?}`
  - `assigned {ownerId, previousOwnerId}`
  - `transferred {fromSectorId, toSectorId, fromOwnerId, toOwnerId}`
  - `privacy_changed {private}`
  - `closed {closingMessageSent}`
  - `reopened {}`
  - `triage_routed {sectorId, option}` (Task 11)
- Consumes (Task 16): the inbox route renders `<Outlet />` in its right pane and has an `:id` child route for the open chat.
- Produces:
  - `web/src/components/conversation/ConversationView.tsx`: `ConversationView(props: ConversationViewProps)`, with `interface ConversationViewProps { chatId: string; contactPanelOpen: boolean; onToggleContactPanel: () => void; onOpenChat: (chatId: string) => void }`.
  - `web/src/pages/Conversation.tsx`: default export `ConversationPage()`. It reads `:id` and owns `contactPanelOpen`. **Task 18 mounts the contact panel here**, next to `<ConversationView>`, when `contactPanelOpen` is true. Task 18 reads the contact id from `useQuery({ queryKey: qk.chat(id), queryFn: () => api.chats.get(id) })`, which hits the same cache as this task.
  - `web/src/components/conversation/model.ts`:
    - `TIMELINE_PAGE_SIZE = 50`
    - `type TimelineRow = { kind: 'date'; key: string; label: string } | { kind: 'item'; key: string; item: TimelineItem }`
    - `mergeTimelinePages(pages: TimelineItem[][]): TimelineItem[]`
    - `dayLabel(iso: string, now: Date): string` returns `'Hoje' | 'Ontem' | 'dd/mm/aaaa'`
    - `buildTimelineRows(items: TimelineItem[], now: Date): TimelineRow[]`
    - `timeOfDay(iso: string): string`
    - `previewText(body: string | null, kind: string): string`
    - `eventText(e: ChatEventDto, names: Map<string, string>): string`
    - `errorMessage(e: unknown): string`
    - `isConflict(e: unknown): boolean`
  - `web/src/components/conversation/Composer.tsx`: `Composer(props: { chatId: string; replyTo: MessageDto | null; onClearReply: () => void })` and `SIGNATURE_KEY = 'talk.composer.signature'`. The `localStorage` value is `'0'` or `'1'`. A missing value means on.
  - `web/src/components/conversation/QuickAnswerPicker.tsx`: `filterQuickAnswers(all: QuickAnswerDto[], query: string): QuickAnswerDto[]` (accent- and case-insensitive match on `name`) and `QuickAnswerPicker(props: { answers: QuickAnswerDto[]; highlight: number; onPick: (qa: QuickAnswerDto) => void })`.
  - `web/src/components/conversation/useAudioRecorder.ts`: `useAudioRecorder(): { recording: boolean; seconds: number; start(): Promise<void>; stop(): Promise<File | null>; discard(): void }`.

---

- [ ] **Step 1: Write the failing test for the timeline model**

`web/src/components/conversation/model.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import type { ChatEventDto, MessageDto, TimelineItem } from '@talk/shared';
import { ApiError } from '../../lib/api';
import { buildTimelineRows, dayLabel, errorMessage, eventText, isConflict, mergeTimelinePages, previewText } from './model';

// local wall-clock times, so the day boundaries match the browser's time zone
const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi).toISOString();
const NOW = new Date(2026, 9, 14, 15, 0); // 14/10/2026 15:00 local

function msg(id: string, sentAt: string, over: Partial<MessageDto> = {}): TimelineItem {
  return {
    type: 'message', id, chatId: 'c1', direction: 'in', kind: 'text', body: id, media: null, mediaUnavailable: false,
    authorId: null, authorName: null, replyTo: null, reaction: null, status: 'read', error: null, sentAt, ...over,
  };
}

function ev(id: string, createdAt: string, over: Partial<ChatEventDto> = {}): TimelineItem {
  return { type: 'event', id, chatId: 'c1', kind: 'created', data: {}, authorName: null, createdAt, ...over };
}

function event(over: Partial<ChatEventDto>): ChatEventDto {
  return { id: 'e', chatId: 'c1', kind: 'created', data: {}, authorName: null, createdAt: at(2026, 10, 14, 9), ...over };
}

describe('dayLabel', () => {
  it('says Hoje, Ontem, or dd/mm/aaaa', () => {
    expect(dayLabel(at(2026, 10, 14, 0, 1), NOW)).toBe('Hoje');
    expect(dayLabel(at(2026, 10, 13, 23, 59), NOW)).toBe('Ontem');
    expect(dayLabel(at(2026, 3, 5, 10), NOW)).toBe('05/03/2026');
  });

  it('handles the year boundary', () => {
    expect(dayLabel(at(2026, 12, 31, 22), new Date(2027, 0, 1, 8))).toBe('Ontem');
    expect(dayLabel(at(2026, 12, 30, 22), new Date(2027, 0, 1, 8))).toBe('30/12/2026');
  });
});

describe('buildTimelineRows', () => {
  it('inserts one date separator before the first item of each local day', () => {
    const items = [
      msg('a', at(2026, 10, 12, 9)),
      msg('b', at(2026, 10, 13, 10)),
      ev('e1', at(2026, 10, 14, 8)),
      msg('c', at(2026, 10, 14, 9)),
    ];
    const rows = buildTimelineRows(items, NOW);
    expect(rows.map((r) => (r.kind === 'date' ? `[${r.label}]` : r.item.id))).toEqual([
      '[12/10/2026]', 'a', '[Ontem]', 'b', '[Hoje]', 'e1', 'c',
    ]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length); // keys are unique React keys
  });

  it('returns no rows for an empty timeline', () => {
    expect(buildTimelineRows([], NOW)).toEqual([]);
  });
});

describe('mergeTimelinePages', () => {
  it('flattens newest-first pages into one ascending list without duplicates', () => {
    const newest = [msg('c', at(2026, 10, 14, 9), { body: 'versão nova' }), msg('d', at(2026, 10, 14, 10))];
    const older = [msg('a', at(2026, 10, 12, 9)), ev('b', at(2026, 10, 13, 9)), msg('c', at(2026, 10, 14, 9), { body: 'versão velha' })];
    const merged = mergeTimelinePages([newest, older]);
    expect(merged.map((i) => i.id)).toEqual(['a', 'b', 'c', 'd']);
    expect((merged[2] as MessageDto).body).toBe('versão nova'); // the newest page wins
  });

  it('orders items with the same timestamp by id, like the server (sent_at, id)', () => {
    const t = at(2026, 10, 14, 9);
    expect(mergeTimelinePages([[msg('m2', t), msg('m1', t)]]).map((i) => i.id)).toEqual(['m1', 'm2']);
  });

  it('keeps a message and an event that share an id apart', () => {
    expect(mergeTimelinePages([[msg('x', at(2026, 10, 14, 9)), ev('x', at(2026, 10, 14, 8))]])).toHaveLength(2);
  });
});

describe('eventText', () => {
  const names = new Map([['s-fin', 'Financeiro'], ['u-ana', 'Ana']]);

  it('describes each kind in Portuguese', () => {
    expect(eventText(event({ kind: 'created' }), names)).toBe('Conversa iniciada pelo contato');
    expect(eventText(event({ kind: 'created', data: { by: 'u-bia' }, authorName: 'Bia' }), names)).toBe('Conversa iniciada por Bia');
    expect(eventText(event({ kind: 'assigned', authorName: 'Bia' }), names)).toBe('Bia assumiu a conversa');
    expect(
      eventText(event({ kind: 'transferred', authorName: 'Bia', data: { toSectorId: 's-fin', toOwnerId: 'u-ana' } }), names),
    ).toBe('Conversa transferida por Bia para Financeiro / Ana');
    expect(eventText(event({ kind: 'privacy_changed', authorName: 'Bia', data: { private: true } }), names)).toBe(
      'Conversa tornada privada por Bia',
    );
    expect(eventText(event({ kind: 'privacy_changed', authorName: 'Bia', data: { private: false } }), names)).toBe(
      'Conversa tornada pública por Bia',
    );
    expect(eventText(event({ kind: 'closed', authorName: 'Bia' }), names)).toBe('Conversa finalizada por Bia');
    expect(eventText(event({ kind: 'reopened', authorName: 'Bia' }), names)).toBe('Conversa reaberta por Bia');
    expect(eventText(event({ kind: 'triage_routed', data: { sectorId: 's-fin' } }), names)).toBe(
      'Triagem: encaminhada para Financeiro',
    );
  });
});

describe('small helpers', () => {
  it('previewText falls back to a label per media kind', () => {
    expect(previewText('  oi  ', 'text')).toBe('oi');
    expect(previewText(null, 'image')).toBe('📷 Imagem');
    expect(previewText('', 'audio')).toBe('🎤 Áudio');
    expect(previewText(null, 'whatever')).toBe('Mensagem');
  });

  it('errorMessage and isConflict read ApiError', () => {
    expect(isConflict(new ApiError(409, 'Conflito'))).toBe(true);
    expect(isConflict(new ApiError(404, 'Não encontrado'))).toBe(false);
    expect(errorMessage(new ApiError(404, 'Não encontrado'))).toBe('Não encontrado');
    expect(errorMessage('boom')).toBe('Ocorreu um erro');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w web -- src/components/conversation/model.test.ts`
Expected: FAIL with `Failed to resolve import "./model"`.

- [ ] **Step 3: Implement the model**

`web/src/components/conversation/model.ts`
```ts
import type { ChatEventDto, TimelineItem } from '@talk/shared';
import { ApiError } from '../../lib/api';

export const TIMELINE_PAGE_SIZE = 50;

export type TimelineRow =
  | { kind: 'date'; key: string; label: string }
  | { kind: 'item'; key: string; item: TimelineItem };

const pad = (n: number) => String(n).padStart(2, '0');
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const itemKey = (it: TimelineItem) => `${it.type}:${it.id}`;
const itemTime = (it: TimelineItem) => (it.type === 'message' ? it.sentAt : it.createdAt);

/** Infinite-query pages (pages[0] = newest) → one ascending list, ordered like the server: (time, id). */
export function mergeTimelinePages(pages: TimelineItem[][]): TimelineItem[] {
  const byKey = new Map<string, TimelineItem>();
  for (const page of pages) {
    for (const it of page) if (!byKey.has(itemKey(it))) byKey.set(itemKey(it), it); // newest page wins
  }
  return [...byKey.values()].sort(
    (a, b) => Date.parse(itemTime(a)) - Date.parse(itemTime(b)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

export function dayLabel(iso: string, now: Date): string {
  const d = new Date(iso);
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (localDay(d) === localDay(now)) return 'Hoje';
  if (localDay(d) === localDay(yesterday)) return 'Ontem';
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

export function buildTimelineRows(items: TimelineItem[], now: Date): TimelineRow[] {
  const rows: TimelineRow[] = [];
  let lastDay = '';
  for (const item of items) {
    const day = localDay(new Date(itemTime(item)));
    if (day !== lastDay) {
      rows.push({ kind: 'date', key: `day:${day}`, label: dayLabel(itemTime(item), now) });
      lastDay = day;
    }
    rows.push({ kind: 'item', key: itemKey(item), item });
  }
  return rows;
}

export function timeOfDay(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const KIND_PREVIEW: Record<string, string> = {
  image: '📷 Imagem',
  audio: '🎤 Áudio',
  video: '🎬 Vídeo',
  document: '📄 Documento',
  sticker: 'Figurinha',
  unsupported: 'Mensagem não suportada',
};

export function previewText(body: string | null, kind: string): string {
  return body?.trim() || KIND_PREVIEW[kind] || 'Mensagem';
}

/** `names` maps sector and user ids to names (UUIDs never collide across tables). */
export function eventText(e: ChatEventDto, names: Map<string, string>): string {
  const name = (v: unknown) => (typeof v === 'string' ? names.get(v) : undefined);
  const by = e.authorName ? ` por ${e.authorName}` : '';
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
      return `Conversa tornada ${e.data.private === true ? 'privada' : 'pública'}${by}`;
    case 'closed':
      return `Conversa finalizada${by}`;
    case 'reopened':
      return `Conversa reaberta${by}`;
    case 'triage_routed':
      return `Triagem: encaminhada para ${name(e.data.sectorId) ?? 'outro setor'}`;
  }
}

export function errorMessage(e: unknown): string {
  return e instanceof Error && e.message ? e.message : 'Ocorreu um erro';
}

/** §7: 409 = the chat changed under us (another agent acted first). */
export function isConflict(e: unknown): boolean {
  return e instanceof ApiError && e.status === 409;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w web -- src/components/conversation/model.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/components/conversation/model.ts web/src/components/conversation/model.test.ts
git commit -m "feat(web): timeline model (page merge, date separators, event labels)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Write the failing composer test**

The test stubs `fetch` and runs the real Task 15 `api` client, so it checks the exact HTTP calls.

`web/src/components/conversation/Composer.test.tsx`
```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MessageDto, QuickAnswerDto } from '@talk/shared';
import { qk, type TimelineData } from '../../lib/api';
import { Composer, SIGNATURE_KEY } from './Composer';

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

function message(over: Partial<MessageDto> = {}): MessageDto {
  return {
    id: 'm-new', chatId: 'c1', direction: 'out', kind: 'text', body: 'x', media: null, mediaUnavailable: false,
    authorId: 'u1', authorName: 'Ana', replyTo: null, reaction: null, status: 'pending', error: null,
    sentAt: '2026-10-14T12:00:00.000Z', ...over,
  };
}

const qa = (id: string, name: string, body: string): QuickAnswerDto => ({
  id, name, body, hasAttachment: false, visibility: 'all', ownerId: null,
});

const ANSWERS = [qa('qa1', 'Boas-vindas', 'Seja bem-vinda, {{contato.primeiro_nome}}!'), qa('qa2', 'Documentos pendentes', 'Faltam papéis.')];

function renderComposer(replyTo: MessageDto | null = null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData<TimelineData>(qk.timeline('c1'), { pages: [[]], pageParams: [undefined] });
  const onClearReply = vi.fn();
  const view = render(
    <QueryClientProvider client={qc}>
      <Composer chatId="c1" replyTo={replyTo} onClearReply={onClearReply} />
    </QueryClientProvider>,
  );
  return { ...view, qc, onClearReply };
}

const box = () => screen.getByRole('textbox') as HTMLTextAreaElement;
const posts = (path: string) => calls.filter((c) => c.method === 'POST' && c.path === path);

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Composer', () => {
  it('Enter sends the text with the signature on by default, clears the box and adds the message to the timeline', async () => {
    stubFetch({ 'POST /api/chats/c1/messages': message() });
    const { qc } = renderComposer();
    fireEvent.change(box(), { target: { value: 'Olá, tudo bem?' } });
    expect(fireEvent.keyDown(box(), { key: 'Enter' })).toBe(false); // default (newline) prevented

    await waitFor(() => expect(box().value).toBe(''));
    expect(posts('/api/chats/c1/messages').map((c) => c.body)).toEqual([{ text: 'Olá, tudo bem?', signature: true }]);
    expect(qc.getQueryData<TimelineData>(qk.timeline('c1'))!.pages[0]!.map((i) => i.id)).toEqual(['m-new']);
  });

  it('Shift+Enter keeps the newline and sends nothing', () => {
    stubFetch({});
    renderComposer();
    fireEvent.change(box(), { target: { value: 'linha 1' } });
    expect(fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true })).toBe(true); // not prevented → browser inserts \n
    expect(calls).toEqual([]);
  });

  it('sends replyToId and clears the reply chip', async () => {
    stubFetch({ 'POST /api/chats/c1/messages': message() });
    const { onClearReply } = renderComposer(message({ id: 'm9', direction: 'in', body: 'Pergunta do cliente', status: 'read' }));
    expect(screen.getByText(/Pergunta do cliente/)).toBeTruthy();
    fireEvent.change(box(), { target: { value: 'Resposta' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(onClearReply).toHaveBeenCalled());
    expect(posts('/api/chats/c1/messages')[0]!.body).toEqual({ text: 'Resposta', signature: true, replyToId: 'm9' });
  });

  it('"/" opens the quick answer picker, filters by name and inserts the rendered text without sending', async () => {
    stubFetch({
      'GET /api/quick-answers': ANSWERS,
      'POST /api/quick-answers/qa2/render': { text: 'Olá Maria, faltam os documentos.' },
    });
    renderComposer();
    fireEvent.change(box(), { target: { value: '/' } });
    expect(await screen.findByRole('option', { name: /Boas-vindas/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /Documentos pendentes/ })).toBeTruthy();

    fireEvent.change(box(), { target: { value: '/DOCU' } }); // case-insensitive
    await waitFor(() => expect(screen.queryByRole('option', { name: /Boas-vindas/ })).toBeNull());
    fireEvent.click(screen.getByRole('option', { name: /Documentos pendentes/ }));

    await waitFor(() => expect(box().value).toBe('Olá Maria, faltam os documentos.'));
    expect(posts('/api/quick-answers/qa2/render').map((c) => c.body)).toEqual([{ chatId: 'c1' }]);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(posts('/api/chats/c1/messages')).toEqual([]); // §5.7: never sent automatically
  });

  it('Enter inside the picker picks the highlighted answer instead of sending', async () => {
    stubFetch({
      'GET /api/quick-answers': ANSWERS,
      'POST /api/quick-answers/qa1/render': { text: 'Seja bem-vinda, Maria!' },
    });
    renderComposer();
    fireEvent.change(box(), { target: { value: '/boas' } });
    await screen.findByRole('option', { name: /Boas-vindas/ });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(box().value).toBe('Seja bem-vinda, Maria!'));
    expect(posts('/api/chats/c1/messages')).toEqual([]);
  });

  it('notes mode posts to /notes and hides the signature toggle', async () => {
    stubFetch({ 'POST /api/chats/c1/notes': message({ kind: 'note' }) });
    renderComposer();
    fireEvent.click(screen.getByRole('button', { name: 'Notas' }));
    expect(box().placeholder).toMatch(/nota interna/i);
    expect(screen.queryByRole('checkbox', { name: 'Assinatura' })).toBeNull();
    fireEvent.change(box(), { target: { value: 'Cliente pediu retorno amanhã' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(posts('/api/chats/c1/notes').map((c) => c.body)).toEqual([{ text: 'Cliente pediu retorno amanhã' }]));
    expect(posts('/api/chats/c1/messages')).toEqual([]);
  });

  it('persists the signature toggle in localStorage and sends with it', async () => {
    stubFetch({ 'POST /api/chats/c1/messages': message() });
    const first = renderComposer();
    const toggle = screen.getByRole('checkbox', { name: 'Assinatura' }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    expect(localStorage.getItem(SIGNATURE_KEY)).toBe('0');
    first.unmount();

    renderComposer();
    expect((screen.getByRole('checkbox', { name: 'Assinatura' }) as HTMLInputElement).checked).toBe(false);
    fireEvent.change(box(), { target: { value: 'Sem assinatura' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(posts('/api/chats/c1/messages').map((c) => c.body)).toEqual([{ text: 'Sem assinatura', signature: false }]));
  });
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `npm test -w web -- src/components/conversation/Composer.test.tsx`
Expected: FAIL with `Failed to resolve import "./Composer"`.

- [ ] **Step 8: Implement the quick answer picker**

`web/src/components/conversation/QuickAnswerPicker.tsx`
```tsx
import { Paperclip } from '@phosphor-icons/react';
import type { QuickAnswerDto } from '@talk/shared';

const fold = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

export function filterQuickAnswers(all: QuickAnswerDto[], query: string): QuickAnswerDto[] {
  const q = fold(query);
  return all.filter((a) => fold(a.name).includes(q));
}

export function QuickAnswerPicker({
  answers,
  highlight,
  onPick,
}: {
  answers: QuickAnswerDto[];
  highlight: number;
  onPick: (qa: QuickAnswerDto) => void;
}) {
  return (
    <div
      role="listbox"
      aria-label="Respostas rápidas"
      className="absolute bottom-full left-0 right-0 z-10 mb-1 max-h-64 overflow-y-auto rounded-md border border-border bg-panel shadow-lg"
    >
      {answers.length === 0 && <p className="px-3 py-2 text-sm text-muted">Nenhuma resposta rápida encontrada</p>}
      {answers.map((a, i) => (
        <button
          key={a.id}
          type="button"
          role="option"
          aria-selected={i === highlight}
          onMouseDown={(e) => e.preventDefault()} // keep focus in the textarea
          onClick={() => onPick(a)}
          className={`block w-full px-3 py-2 text-left text-sm ${i === highlight ? 'bg-surface' : 'hover:bg-surface'}`}
        >
          <span className="font-medium text-fg">/{a.name}</span>
          {a.hasAttachment && <Paperclip size={14} className="ml-1 inline text-muted" aria-label="com anexo" />}
          <span className="block truncate text-xs text-muted">{a.body}</span>
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 9: Implement the audio recorder hook**

jsdom has no `MediaRecorder`, so this hook is covered by the typecheck in Step 17 and the manual check in Step 19.

`web/src/components/conversation/useAudioRecorder.ts`
```ts
import { useEffect, useRef, useState } from 'react';

// WhatsApp voice notes are ogg/opus. Firefox records ogg natively; Chromium only webm/opus,
// which Evolution's sendWhatsAppAudio converts.
const AUDIO_TYPES = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/webm'];

export function useAudioRecorder() {
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (!recording) return;
    setSeconds(0);
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [recording]);

  function release(): void {
    recorder.current?.stream.getTracks().forEach((t) => t.stop()); // turns the browser's mic indicator off
    recorder.current = null;
    setRecording(false);
  }

  /** Throws when there is no microphone, permission is denied or MediaRecorder does not exist. */
  async function start(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = AUDIO_TYPES.find((t) => MediaRecorder.isTypeSupported(t));
    const r = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    chunks.current = [];
    r.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.current.push(e.data);
    };
    r.start();
    recorder.current = r;
    setRecording(true);
  }

  /** Stops and returns the recording, or null if nothing was captured. */
  function stop(): Promise<File | null> {
    const r = recorder.current;
    if (!r) return Promise.resolve(null);
    return new Promise((resolve) => {
      r.onstop = () => {
        const type = (r.mimeType || 'audio/webm').split(';')[0];
        const blob = new Blob(chunks.current, { type });
        release();
        resolve(blob.size > 0 ? new File([blob], `audio.${type === 'audio/ogg' ? 'ogg' : 'webm'}`, { type }) : null);
      };
      r.stop();
    });
  }

  function discard(): void {
    const r = recorder.current;
    if (r) {
      r.ondataavailable = null;
      r.onstop = null;
      if (r.state !== 'inactive') r.stop();
    }
    release();
  }

  // switching chats mid-recording frees the microphone
  useEffect(() => discard, []);

  return { recording, seconds, start, stop, discard };
}
```

- [ ] **Step 10: Implement the composer**

`web/src/components/conversation/Composer.tsx`
```tsx
import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowBendUpLeft, Lightning, Microphone, Paperclip, PaperPlaneRight, Smiley, Trash, X } from '@phosphor-icons/react';
import type { MessageDto, QuickAnswerDto } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { applyWsEvent } from '../../lib/ws';
import { errorMessage, previewText } from './model';
import { QuickAnswerPicker, filterQuickAnswers } from './QuickAnswerPicker';
import { useAudioRecorder } from './useAudioRecorder';

export const SIGNATURE_KEY = 'talk.composer.signature';

// ponytail: fixed grid of common emojis; add a searchable picker only if the team misses one.
const EMOJIS = [
  '😀', '😂', '😊', '🙂', '😉', '😍', '😢', '😅', '🤔', '😐', '🙏', '👍', '👎', '👏', '🙌', '💪',
  '🤝', '👋', '✅', '❌', '⚠️', '❗', '📌', '📎', '📄', '📅', '⏰', '📞', '💰', '⚖️', '❤️', '🎉',
];

function readSignaturePref(): boolean {
  try {
    return localStorage.getItem(SIGNATURE_KEY) !== '0';
  } catch {
    return true;
  }
}

function writeSignaturePref(on: boolean): void {
  try {
    localStorage.setItem(SIGNATURE_KEY, on ? '1' : '0');
  } catch {
    // storage blocked (private window): the choice lasts until the page reloads
  }
}

async function fetchQuickAnswerFile(qa: QuickAnswerDto): Promise<File> {
  const res = await fetch(api.quickAnswers.attachmentUrl(qa.id), { credentials: 'include' });
  if (!res.ok) throw new Error('Não foi possível baixar o anexo da resposta rápida');
  const disposition = res.headers.get('content-disposition') ?? '';
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  const plain = /filename="([^"]+)"/i.exec(disposition)?.[1];
  const blob = await res.blob();
  return new File([blob], encoded ? decodeURIComponent(encoded) : (plain ?? qa.name), { type: blob.type });
}

const duration = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

function ToolButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="rounded p-1.5 text-muted hover:bg-panel hover:text-fg"
    >
      {children}
    </button>
  );
}

export interface ComposerProps {
  chatId: string;
  replyTo: MessageDto | null;
  onClearReply: () => void;
}

export function Composer({ chatId, replyTo, onClearReply }: ComposerProps) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<'message' | 'note'>('message');
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [signature, setSignature] = useState(readSignaturePref);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [pickerDismissed, setPickerDismissed] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recorder = useAudioRecorder();
  const isNote = mode === 'note';

  // "/" followed by an optional filter (no spaces) opens the quick answer picker
  const slash = /^\/(\S*)$/.exec(text);
  const pickerQuery = slash && !pickerDismissed ? slash[1] : null;
  const answers = useQuery({ queryKey: qk.quickAnswers, queryFn: api.quickAnswers.list, enabled: pickerQuery !== null });
  const matches = pickerQuery === null ? [] : filterQuickAnswers(answers.data ?? [], pickerQuery);

  useEffect(() => {
    setHighlight(0);
  }, [pickerQuery]);

  function changeText(value: string) {
    setText(value);
    setPickerDismissed(false);
  }

  function switchMode(next: 'message' | 'note') {
    setMode(next);
    if (next === 'note') setFile(null); // notes are text only
    textareaRef.current?.focus();
  }

  function toggleSignature(on: boolean) {
    setSignature(on);
    writeSignaturePref(on);
  }

  function insertAtCursor(snippet: string) {
    const el = textareaRef.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    changeText(text.slice(0, start) + snippet + text.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + snippet.length, start + snippet.length);
    });
  }

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

  async function send() {
    const value = text.trim();
    if (sending || (!value && !file)) return;
    const replyToId = isNote ? undefined : replyTo?.id;
    const ok = await submit(() =>
      isNote
        ? api.chats.addNote(chatId, value)
        : file
          ? api.chats.sendFile(chatId, { file, text: value || undefined, signature, replyToId })
          : api.chats.sendText(chatId, { text: value, signature, replyToId }),
    );
    if (!ok) return;
    setText('');
    setFile(null);
    if (!isNote) onClearReply();
  }

  async function toggleRecording() {
    if (!recorder.recording) {
      try {
        await recorder.start();
      } catch {
        setError('Não foi possível acessar o microfone');
      }
      return;
    }
    const audio = await recorder.stop();
    if (!audio) return;
    const ok = await submit(() =>
      api.chats.sendFile(chatId, { file: audio, signature: false, asVoice: true, replyToId: replyTo?.id }),
    );
    if (ok) onClearReply();
  }

  async function pickAnswer(qa: QuickAnswerDto) {
    setError(null);
    try {
      const { text: rendered } = await api.quickAnswers.render(qa.id, chatId);
      changeText(rendered); // §5.7: goes to the box for editing, never sent automatically
      if (qa.hasAttachment && !isNote) setFile(await fetchQuickAnswerFile(qa));
      textareaRef.current?.focus();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (pickerQuery !== null) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setPickerDismissed(true);
        return;
      }
      if (matches.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setHighlight((h) => (h + 1) % matches.length);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setHighlight((h) => (h - 1 + matches.length) % matches.length);
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          void pickAnswer(matches[Math.min(highlight, matches.length - 1)]);
          return;
        }
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    const dropped = e.dataTransfer.files[0];
    if (dropped && !isNote) setFile(dropped);
  }

  const canSend = text.trim() !== '' || file !== null;

  return (
    <div
      className="border-t border-border bg-surface px-3 py-2"
      onDragOver={(e) => {
        if (!isNote) e.preventDefault(); // allows the drop
      }}
      onDrop={onDrop}
    >
      <div className="mb-2 flex gap-1 text-sm">
        {(['message', 'note'] as const).map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={mode === m}
            onClick={() => switchMode(m)}
            className={`rounded px-3 py-1 ${
              mode === m ? (m === 'note' ? 'bg-yellow-200 text-zinc-900' : 'bg-primary text-white') : 'text-muted hover:bg-panel'
            }`}
          >
            {m === 'message' ? 'Mensagem' : 'Notas'}
          </button>
        ))}
      </div>

      {replyTo && !isNote && (
        <div className="mb-2 flex items-center gap-2 rounded border-l-4 border-primary bg-panel px-2 py-1 text-sm text-fg">
          <ArrowBendUpLeft size={16} className="shrink-0 text-muted" />
          <span className="min-w-0 flex-1 truncate">Respondendo: {previewText(replyTo.body, replyTo.kind)}</span>
          <button type="button" aria-label="Cancelar resposta" onClick={onClearReply} className="text-muted hover:text-fg">
            <X size={16} />
          </button>
        </div>
      )}

      {file && (
        <div className="mb-2 flex items-center gap-2 rounded bg-panel px-2 py-1 text-sm text-fg">
          <Paperclip size={16} className="shrink-0 text-muted" />
          <span className="min-w-0 flex-1 truncate">{file.name}</span>
          <button type="button" aria-label="Remover arquivo" onClick={() => setFile(null)} className="text-muted hover:text-fg">
            <X size={16} />
          </button>
        </div>
      )}

      {error && (
        <p role="alert" className="mb-1 text-sm text-danger">
          {error}
        </p>
      )}

      {recorder.recording ? (
        <div className="flex items-center gap-3 py-2 text-fg">
          <span className="size-2 animate-pulse rounded-full bg-danger" />
          <span className="flex-1 text-sm tabular-nums">Gravando {duration(recorder.seconds)}</span>
          <ToolButton label="Descartar áudio" onClick={recorder.discard}>
            <Trash size={20} />
          </ToolButton>
          <button
            type="button"
            disabled={sending}
            onClick={() => void toggleRecording()}
            className="flex items-center gap-1 rounded bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50"
          >
            Enviar áudio <PaperPlaneRight size={16} />
          </button>
        </div>
      ) : (
        <>
          <div className="relative">
            {pickerQuery !== null && <QuickAnswerPicker answers={matches} highlight={highlight} onPick={(a) => void pickAnswer(a)} />}
            <textarea
              ref={textareaRef}
              aria-label={isNote ? 'Nota interna' : 'Mensagem'}
              value={text}
              onChange={(e) => changeText(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={
                isNote
                  ? 'Digite sua nota interna, visível só para a equipe…'
                  : 'Digite sua mensagem ou arraste um arquivo… ("/" para respostas rápidas)'
              }
              className={`field-sizing-content block max-h-48 min-h-10 w-full resize-none rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 ${
                isNote
                  ? 'border-yellow-300 bg-yellow-100 text-zinc-900 placeholder:text-zinc-500 focus:ring-yellow-300'
                  : 'border-border bg-panel text-fg placeholder:text-muted focus:ring-primary'
              }`}
            />
          </div>

          <div className="mt-1 flex items-center gap-1">
            {!isNote && (
              <>
                <ToolButton label="Arquivo" onClick={() => fileInputRef.current?.click()}>
                  <Paperclip size={20} />
                </ToolButton>
                <input
                  ref={fileInputRef}
                  type="file"
                  hidden
                  onChange={(e) => {
                    setFile(e.target.files?.[0] ?? null);
                    e.target.value = ''; // picking the same file again still fires onChange
                  }}
                />
              </>
            )}
            <ToolButton
              label="Respostas rápidas"
              onClick={() => {
                changeText('/');
                textareaRef.current?.focus();
              }}
            >
              <Lightning size={20} />
            </ToolButton>
            <div className="relative">
              <ToolButton label="Emoji" onClick={() => setEmojiOpen((o) => !o)}>
                <Smiley size={20} />
              </ToolButton>
              {emojiOpen && (
                <div className="absolute bottom-full left-0 z-10 mb-1 grid w-72 grid-cols-8 gap-1 rounded-md border border-border bg-panel p-2 shadow-lg">
                  {EMOJIS.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      aria-label={emoji}
                      className="rounded text-lg hover:bg-surface"
                      onClick={() => {
                        insertAtCursor(emoji);
                        setEmojiOpen(false);
                      }}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {!isNote && (
              <label className="ml-2 flex items-center gap-1 text-xs text-muted">
                <input type="checkbox" checked={signature} onChange={(e) => toggleSignature(e.target.checked)} />
                Assinatura
              </label>
            )}
            <div className="ml-auto">
              {!isNote && !canSend ? (
                <ToolButton label="Gravar áudio" onClick={() => void toggleRecording()}>
                  <Microphone size={20} />
                </ToolButton>
              ) : (
                <button
                  type="button"
                  onClick={() => void send()}
                  disabled={sending || !canSend}
                  className="flex items-center gap-1 rounded bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50"
                >
                  {isNote ? 'Salvar nota' : 'Enviar'} <PaperPlaneRight size={16} />
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 11: Run the test to verify it passes**

Run: `npm test -w web -- src/components/conversation/Composer.test.tsx`
Expected: PASS (7 tests).

- [ ] **Step 12: Commit**

```bash
git add web/src/components/conversation/QuickAnswerPicker.tsx web/src/components/conversation/useAudioRecorder.ts web/src/components/conversation/Composer.tsx web/src/components/conversation/Composer.test.tsx
git commit -m "feat(web): message composer (notes, quick answers, files, voice, emoji, signature)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 13: Implement the message bubble**

The bubble, timeline, header, dialogs and view are mostly markup over the tested model. The typecheck and build in Step 17 and the manual check in Step 19 verify them.

`web/src/components/conversation/MessageBubble.tsx`
```tsx
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowBendUpLeft, Check, Checks, Clock, FileText, ImageBroken, WarningCircle } from '@phosphor-icons/react';
import type { MessageDto } from '@talk/shared';
import { api } from '../../lib/api';
import { applyWsEvent } from '../../lib/ws';
import { errorMessage, previewText, timeOfDay } from './model';

const MEDIA_KINDS = new Set(['image', 'audio', 'video', 'document', 'sticker']);

function formatSize(bytes: number | null): string {
  if (bytes == null) return '';
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function StatusTick({ status }: { status: MessageDto['status'] }) {
  switch (status) {
    case 'pending':
      return <Clock size={14} aria-label="Enviando" />;
    case 'sent':
      return <Check size={14} aria-label="Enviada" />;
    case 'delivered':
      return <Checks size={14} aria-label="Entregue" />;
    case 'read':
      return <Checks size={14} weight="bold" className="text-sky-400" aria-label="Lida" />;
    case 'failed':
      return <WarningCircle size={14} weight="fill" className="text-danger" aria-label="Falhou" />;
  }
}

function MediaView({ m }: { m: MessageDto }) {
  if (m.mediaUnavailable) {
    return (
      <p className="flex items-center gap-1 text-sm italic text-muted">
        <ImageBroken size={16} /> mídia indisponível
      </p>
    );
  }
  // inbound media is downloaded after the message is stored (§5.1 step 6); message.updated fills it in
  if (!m.media) return MEDIA_KINDS.has(m.kind) ? <p className="text-sm italic text-muted">Carregando mídia…</p> : null;
  const { url, name, size } = m.media;
  switch (m.kind) {
    case 'image':
    case 'sticker':
      return (
        <a href={url} target="_blank" rel="noopener noreferrer">
          <img
            src={url}
            alt={name ?? 'Imagem'}
            loading="lazy"
            className={m.kind === 'sticker' ? 'size-32 object-contain' : 'max-h-72 max-w-full rounded'}
          />
        </a>
      );
    case 'audio':
      return <audio controls preload="none" src={url} className="max-w-full" />;
    case 'video':
      return <video controls preload="metadata" src={url} className="max-h-72 max-w-full rounded" />;
    default:
      return (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 rounded bg-black/20 px-2 py-1.5 text-sm hover:bg-black/30"
        >
          <FileText size={24} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">{name ?? 'Documento'}</span>
          <span className="text-xs opacity-70">{formatSize(size)}</span>
        </a>
      );
  }
}

export function MessageBubble({ m, onReply }: { m: MessageDto; onReply: (m: MessageDto) => void }) {
  const qc = useQueryClient();
  const [resending, setResending] = useState(false);
  const [resendError, setResendError] = useState<string | null>(null);
  const isNote = m.kind === 'note';
  const right = isNote || m.direction === 'out';
  const showStatus = m.direction === 'out' && !isNote;
  // quoting needs the WhatsApp id, which pending/failed sends do not have yet
  const canReply = !isNote && !(m.direction === 'out' && (m.status === 'pending' || m.status === 'failed'));
  const label = isNote
    ? `Nota interna · ${m.authorName ?? 'Atendente'}`
    : m.direction === 'out'
      ? (m.authorName ?? 'Celular ou sistema') // authorId null = sent from the phone or by the triage bot
      : null;
  const tone = isNote ? 'bg-yellow-200 text-zinc-900' : m.direction === 'out' ? 'bg-primary/25 text-fg' : 'bg-panel text-fg';

  async function resend() {
    setResending(true);
    setResendError(null);
    try {
      applyWsEvent(qc, { type: 'message.updated', message: await api.messages.resend(m.id) });
    } catch (e) {
      setResendError(errorMessage(e));
    } finally {
      setResending(false);
    }
  }

  const replyButton = canReply && (
    <button
      type="button"
      aria-label="Responder"
      title="Responder"
      onClick={() => onReply(m)}
      className="self-center p-1 text-muted opacity-0 hover:text-fg focus:opacity-100 group-hover:opacity-100"
    >
      <ArrowBendUpLeft size={16} />
    </button>
  );

  return (
    <div className={`group flex px-4 py-1 ${right ? 'justify-end' : 'justify-start'}`}>
      {right && replyButton}
      <div className={`relative max-w-[75%] rounded-lg px-3 py-2 shadow-sm ${tone} ${m.reaction ? 'mb-3' : ''}`}>
        {label && <p className="mb-1 text-xs font-semibold opacity-75">{label}</p>}
        {m.replyTo && (
          <div className="mb-1 line-clamp-3 rounded border-l-4 border-primary bg-black/15 px-2 py-1 text-xs opacity-80">
            {previewText(m.replyTo.body, m.replyTo.kind)}
          </div>
        )}
        <MediaView m={m} />
        {m.kind === 'unsupported' ? (
          <p className="text-sm italic opacity-70">Mensagem não suportada</p>
        ) : (
          m.body && <p className="whitespace-pre-wrap break-words text-sm">{m.body}</p>
        )}
        <div className="mt-1 flex items-center justify-end gap-1 text-[11px] opacity-70">
          <time dateTime={m.sentAt}>{timeOfDay(m.sentAt)}</time>
          {showStatus && <StatusTick status={m.status} />}
        </div>
        {showStatus && m.status === 'failed' && (
          <div className="mt-1 flex items-center gap-2 text-xs text-danger">
            <span className="flex-1">{resendError ?? m.error ?? 'Falha no envio'}</span>
            <button type="button" onClick={() => void resend()} disabled={resending} className="font-semibold underline">
              Reenviar
            </button>
          </div>
        )}
        {m.reaction && (
          <span
            aria-label={`Reação ${m.reaction}`}
            className={`absolute -bottom-3 ${right ? 'left-2' : 'right-2'} rounded-full border border-border bg-surface px-1.5 text-sm shadow-sm`}
          >
            {m.reaction}
          </span>
        )}
      </div>
      {!right && replyButton}
    </div>
  );
}
```

- [ ] **Step 14: Implement the timeline**

`web/src/components/conversation/Timeline.tsx`
```tsx
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Info } from '@phosphor-icons/react';
import type { MessageDto } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { MessageBubble } from './MessageBubble';
import { TIMELINE_PAGE_SIZE, buildTimelineRows, eventText, mergeTimelinePages, timeOfDay } from './model';

const EDGE_PX = 80;

export function Timeline({ chatId, onReply }: { chatId: string; onReply: (m: MessageDto) => void }) {
  const timeline = useInfiniteQuery({
    queryKey: qk.timeline(chatId),
    queryFn: ({ pageParam }) => api.chats.timeline(chatId, { before: pageParam, limit: TIMELINE_PAGE_SIZE }),
    initialPageParam: undefined as string | undefined,
    // next = older: `before` is the id of the oldest item already loaded (Task 13)
    getNextPageParam: (last) => (last.length < TIMELINE_PAGE_SIZE ? undefined : last[0]?.id),
  });
  const sectors = useQuery({ queryKey: qk.sectors, queryFn: api.sectors.list });
  const users = useQuery({ queryKey: qk.users, queryFn: api.users.list });

  const names = useMemo(
    () => new Map([...(sectors.data ?? []), ...(users.data ?? [])].map((x) => [x.id, x.name] as [string, string])),
    [sectors.data, users.data],
  );
  const rows = useMemo(
    () => buildTimelineRows(mergeTimelinePages(timeline.data?.pages ?? []), new Date()),
    [timeline.data],
  );

  const ref = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const loadingOlder = useRef(false);
  const prevHeight = useRef(0);

  // Opening, new messages while at the bottom → scroll to the end.
  // Older page prepended → keep the same message under the user's eyes.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (loadingOlder.current) {
      el.scrollTop += el.scrollHeight - prevHeight.current;
      loadingOlder.current = false;
    } else if (stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
    prevHeight.current = el.scrollHeight;
  }, [rows]);

  // images/videos that finish loading grow the list; stay pinned to the bottom if we were there
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onLoad = () => {
      if (stickToBottom.current) el.scrollTop = el.scrollHeight;
    };
    el.addEventListener('load', onLoad, true); // load does not bubble; capture sees it
    return () => el.removeEventListener('load', onLoad, true);
  }, []);

  function onScroll() {
    const el = ref.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < EDGE_PX;
    if (el.scrollTop < EDGE_PX && timeline.hasNextPage && !timeline.isFetchingNextPage) {
      loadingOlder.current = true;
      prevHeight.current = el.scrollHeight;
      void timeline.fetchNextPage();
    }
  }

  return (
    <div ref={ref} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto bg-sidebar py-3">
      {timeline.isFetchingNextPage && <p className="py-2 text-center text-xs text-muted">Carregando mensagens anteriores…</p>}
      {timeline.isPending && <p className="py-6 text-center text-sm text-muted">Carregando…</p>}
      {timeline.isError && <p className="py-6 text-center text-sm text-danger">Não foi possível carregar a conversa.</p>}
      {rows.map((row) => {
        if (row.kind === 'date') {
          return (
            <div key={row.key} className="my-3 flex justify-center">
              <span className="rounded-full bg-panel px-3 py-0.5 text-xs text-muted shadow-sm">{row.label}</span>
            </div>
          );
        }
        const item = row.item;
        if (item.type === 'event') {
          return (
            <p key={row.key} className="my-2 flex items-center justify-center gap-1 px-4 text-center text-xs text-muted">
              <Info size={14} className="shrink-0" />
              {eventText(item, names)} · {timeOfDay(item.createdAt)}
            </p>
          );
        }
        return <MessageBubble key={row.key} m={item} onReply={onReply} />;
      })}
    </div>
  );
}
```

- [ ] **Step 15: Implement the transfer and finalize dialogs**

`web/src/components/conversation/ChatDialogs.tsx`
```tsx
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ChatDetail, SectorDto, UserDto } from '@talk/shared';
import { api, qk } from '../../lib/api';

// Native <dialog>: showModal() gives focus trapping, Esc and the backdrop for free.
function Modal({ title, onCancel, children }: { title: string; onCancel: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault(); // Esc: let React unmount it
        onCancel();
      }}
      className="m-auto w-[min(28rem,calc(100%-2rem))] rounded-lg bg-panel p-5 text-fg shadow-xl backdrop:bg-black/50"
    >
      <h3 className="mb-4 text-base font-semibold">{title}</h3>
      {children}
    </dialog>
  );
}

function Actions(props: { busy: boolean; error: string | null; confirmLabel: string; onCancel: () => void; onConfirm: () => void }) {
  return (
    <>
      {props.error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {props.error}
        </p>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" onClick={props.onCancel} className="rounded px-3 py-2 text-sm hover:bg-surface">
          Cancelar
        </button>
        <button
          type="button"
          disabled={props.busy}
          onClick={props.onConfirm}
          className="rounded bg-primary px-3 py-2 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50"
        >
          {props.confirmLabel}
        </button>
      </div>
    </>
  );
}

const field = 'mt-1 block w-full rounded border border-border bg-surface px-2 py-1.5 text-sm text-fg';

export function TransferDialog(props: {
  chat: ChatDetail;
  sectors: SectorDto[];
  users: UserDto[];
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (to: { sectorId: string; ownerId: string | null }) => void;
}) {
  const [sectorId, setSectorId] = useState(props.chat.sectorId);
  const [ownerId, setOwnerId] = useState('');
  const agents = props.users.filter((u) => u.active && u.sectorIds.includes(sectorId));
  return (
    <Modal title="Transferir conversa" onCancel={props.onCancel}>
      <label className="mb-3 block text-sm">
        Setor
        <select
          value={sectorId}
          onChange={(e) => {
            setSectorId(e.target.value);
            setOwnerId(''); // the agent list depends on the sector
          }}
          className={field}
        >
          {props.sectors.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-sm">
        Atendente
        <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)} className={field}>
          <option value="">Ninguém (fila do setor)</option>
          {agents.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
      </label>
      <Actions
        busy={props.busy}
        error={props.error}
        confirmLabel="Transferir"
        onCancel={props.onCancel}
        onConfirm={() => props.onConfirm({ sectorId, ownerId: ownerId || null })}
      />
    </Modal>
  );
}

export function CloseDialog(props: {
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (sendClosingMessage: boolean) => void;
}) {
  const settings = useQuery({ queryKey: qk.settings, queryFn: api.settings.get });
  const closing = settings.data?.closingMessage.trim() ?? '';
  const [choice, setChoice] = useState<boolean | null>(null); // null = untouched → default on when configured
  const send = closing !== '' && (choice ?? true);
  return (
    <Modal title="Finalizar conversa" onCancel={props.onCancel}>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={send}
          disabled={!closing}
          onChange={(e) => setChoice(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          Enviar mensagem de encerramento
          {!closing && settings.isSuccess && (
            <span className="block text-xs text-muted">Nenhuma mensagem de encerramento configurada.</span>
          )}
        </span>
      </label>
      {closing && <p className="mt-2 whitespace-pre-wrap rounded bg-surface p-2 text-xs text-muted">{closing}</p>}
      <Actions
        busy={props.busy || settings.isPending}
        error={props.error}
        confirmLabel="Finalizar"
        onCancel={props.onCancel}
        onConfirm={() => props.onConfirm(send)}
      />
    </Modal>
  );
}
```

- [ ] **Step 16: Implement the header, the view and the page, and register the route**

`web/src/components/conversation/ConversationHeader.tsx`
```tsx
import { useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowBendUpRight, ArrowCounterClockwise, Check, LockSimple, LockSimpleOpen, User, UserPlus } from '@phosphor-icons/react';
import type { ChatDetail } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { useCurrentUser } from '../../lib/auth';
import { formatPhone } from '../../lib/format';
import { CloseDialog, TransferDialog } from './ChatDialogs';
import { errorMessage, isConflict } from './model';

function HeaderButton(props: { label: string; onClick: () => void; disabled?: boolean; pressed?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      aria-pressed={props.pressed}
      disabled={props.disabled}
      onClick={props.onClick}
      className={`rounded p-2 hover:bg-panel disabled:cursor-not-allowed disabled:opacity-40 ${
        props.pressed ? 'bg-panel text-fg' : 'text-muted'
      }`}
    >
      {props.children}
    </button>
  );
}

type Action =
  | { kind: 'assume' }
  | { kind: 'reopen' }
  | { kind: 'transfer'; to: { sectorId: string; ownerId: string | null } }
  | { kind: 'privacy'; private: boolean }
  | { kind: 'close'; sendClosingMessage: boolean };

function runAction(chatId: string, a: Action): Promise<ChatDetail> {
  switch (a.kind) {
    case 'assume':
      return api.chats.assume(chatId);
    case 'reopen':
      return api.chats.reopen(chatId);
    case 'transfer':
      return api.chats.transfer(chatId, a.to);
    case 'privacy':
      return api.chats.setPrivacy(chatId, a.private);
    case 'close':
      return api.chats.close(chatId, a.sendClosingMessage);
  }
}

export interface ConversationHeaderProps {
  chat: ChatDetail;
  contactPanelOpen: boolean;
  onToggleContactPanel: () => void;
  onOpenChat: (chatId: string) => void;
}

export function ConversationHeader({ chat, contactPanelOpen, onToggleContactPanel, onOpenChat }: ConversationHeaderProps) {
  const qc = useQueryClient();
  const me = useCurrentUser();
  const sectors = useQuery({ queryKey: qk.sectors, queryFn: api.sectors.list }).data ?? [];
  const users = useQuery({ queryKey: qk.users, queryFn: api.users.list }).data ?? [];
  const [dialog, setDialog] = useState<'transfer' | 'close' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = chat.state === 'open';
  const ownerOrAdmin = me.role === 'admin' || chat.ownerId === me.id;
  const lockedByPrivacy = chat.private && !ownerOrAdmin; // §5.3: private → only owner/admin transfer or close
  const sectorName = sectors.find((s) => s.id === chat.sectorId)?.name ?? '—';
  const ownerName = chat.ownerId ? (users.find((u) => u.id === chat.ownerId)?.name ?? 'Atendente') : 'Sem dono';

  async function act(a: Action) {
    setBusy(true);
    setError(null);
    try {
      const detail = await runAction(chat.id, a);
      setDialog(null);
      // reopen may answer with another chat already open for this contact (§5.3)
      if (detail.id !== chat.id) onOpenChat(detail.id);
      else qc.setQueryData(qk.chat(chat.id), detail);
    } catch (e) {
      if (isConflict(e)) {
        setDialog(null);
        setError('A conversa foi alterada por outra pessoa e foi recarregada.');
      } else {
        setError(errorMessage(e));
      }
      void qc.invalidateQueries({ queryKey: qk.chat(chat.id), exact: true });
    } finally {
      setBusy(false);
    }
  }

  function closeDialog() {
    setDialog(null);
    setError(null);
  }

  const pill = 'flex items-center gap-1 rounded px-3 py-1.5 text-sm font-medium disabled:opacity-50';

  return (
    <>
      <header className="flex items-center gap-1 border-b border-border bg-surface px-4 py-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-semibold text-fg">{chat.contact.name ?? formatPhone(chat.contact.phone)}</h2>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <span className="rounded bg-panel px-1.5 text-fg">{sectorName}</span>
            <span>{ownerName}</span>
            {chat.private && (
              <span className="flex items-center gap-0.5 text-amber-400">
                <LockSimple size={12} /> Privada
              </span>
            )}
            {!open && <span>Finalizada</span>}
          </div>
        </div>

        {open && !chat.ownerId && (
          <button type="button" disabled={busy} onClick={() => void act({ kind: 'assume' })} className={`${pill} bg-primary text-white hover:bg-primary-hover`}>
            <UserPlus size={16} /> Assumir
          </button>
        )}
        {!open && (
          <button type="button" disabled={busy} onClick={() => void act({ kind: 'reopen' })} className={`${pill} bg-panel text-fg hover:bg-sidebar-hover`}>
            <ArrowCounterClockwise size={16} /> Reabrir
          </button>
        )}

        <HeaderButton label="Contato" pressed={contactPanelOpen} onClick={onToggleContactPanel}>
          <User size={20} />
        </HeaderButton>
        {open && (
          <>
            <HeaderButton label="Transferir" disabled={busy || lockedByPrivacy} onClick={() => setDialog('transfer')}>
              <ArrowBendUpRight size={20} />
            </HeaderButton>
            <HeaderButton
              label={chat.private ? 'Liberar conversa' : 'Privar conversa'}
              disabled={busy || !ownerOrAdmin}
              onClick={() => void act({ kind: 'privacy', private: !chat.private })}
            >
              {chat.private ? <LockSimpleOpen size={20} /> : <LockSimple size={20} />}
            </HeaderButton>
            <HeaderButton label="Finalizar" disabled={busy || lockedByPrivacy} onClick={() => setDialog('close')}>
              <Check size={20} />
            </HeaderButton>
          </>
        )}
      </header>

      {error && !dialog && (
        <p role="alert" className="border-b border-border bg-danger/15 px-4 py-1.5 text-sm text-danger">
          {error}
        </p>
      )}
      {dialog === 'transfer' && (
        <TransferDialog
          chat={chat}
          sectors={sectors}
          users={users}
          busy={busy}
          error={error}
          onCancel={closeDialog}
          onConfirm={(to) => void act({ kind: 'transfer', to })}
        />
      )}
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

`web/src/components/conversation/ConversationView.tsx`
```tsx
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ChatDetail, MessageDto } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { Composer } from './Composer';
import { ConversationHeader } from './ConversationHeader';
import { errorMessage } from './model';
import { Timeline } from './Timeline';

export interface ConversationViewProps {
  chatId: string;
  contactPanelOpen: boolean;
  onToggleContactPanel: () => void;
  onOpenChat: (chatId: string) => void;
}

export function ConversationView(props: ConversationViewProps) {
  // key: another chat starts with a fresh reply chip, scroll position and composer draft
  return <ConversationPane key={props.chatId} {...props} />;
}

function ClosedFooter({ chat, onOpenChat }: { chat: ChatDetail; onOpenChat: (chatId: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function startNew() {
    setBusy(true);
    setError(null);
    try {
      // §5.3a: returns the already-open chat for this contact if there is one
      const next = await api.chats.start({ contactId: chat.contact.id, sectorId: chat.sectorId });
      onOpenChat(next.id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-t border-border bg-surface px-4 py-3 text-center text-sm text-muted">
      Conversa finalizada —{' '}
      <button type="button" disabled={busy} onClick={() => void startNew()} className="font-medium text-fg underline disabled:opacity-50">
        Nova conversa
      </button>
      {error && (
        <p role="alert" className="mt-1 text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function ConversationPane({ chatId, contactPanelOpen, onToggleContactPanel, onOpenChat }: ConversationViewProps) {
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: qk.chat(chatId), queryFn: () => api.chats.get(chatId) });
  const [replyTo, setReplyTo] = useState<MessageDto | null>(null);
  const chat = detail.data;
  const unread = chat?.unread ?? 0;

  // mark read on open and whenever a new inbound message arrives while the chat is on screen
  useEffect(() => {
    if (unread > 0) api.chats.markRead(chatId).catch(() => undefined); // best effort; the next open retries
  }, [chatId, unread]);

  // Assume, transfer, privacy, close and reopen record a chat event. That is true whether this user
  // or someone else (via chat.updated) did it. Reload the timeline when one of those fields changes.
  const eventFields = chat ? `${chat.state}|${chat.sectorId}|${chat.ownerId}|${chat.private}` : '';
  const lastEventFields = useRef(eventFields);
  useEffect(() => {
    if (lastEventFields.current && eventFields && lastEventFields.current !== eventFields) {
      void qc.invalidateQueries({ queryKey: qk.timeline(chatId), exact: true });
    }
    lastEventFields.current = eventFields;
  }, [eventFields, chatId, qc]);

  if (detail.isError) {
    return <p className="grid h-full place-items-center text-sm text-muted">Esta conversa não está disponível para você.</p>;
  }
  if (!chat) {
    return <p className="grid h-full place-items-center text-sm text-muted">Carregando conversa…</p>;
  }

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col">
      <ConversationHeader
        chat={chat}
        contactPanelOpen={contactPanelOpen}
        onToggleContactPanel={onToggleContactPanel}
        onOpenChat={onOpenChat}
      />
      <Timeline chatId={chatId} onReply={setReplyTo} />
      {chat.state === 'open' ? (
        <Composer chatId={chatId} replyTo={replyTo} onClearReply={() => setReplyTo(null)} />
      ) : (
        <ClosedFooter chat={chat} onOpenChat={onOpenChat} />
      )}
    </section>
  );
}
```

`web/src/pages/Conversation.tsx`
```tsx
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { ConversationView } from '../components/conversation/ConversationView';

export default function ConversationPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [contactPanelOpen, setContactPanelOpen] = useState(false); // survives switching chats
  if (!id) return null;
  return (
    <div className="flex h-full min-w-0">
      <ConversationView
        chatId={id}
        contactPanelOpen={contactPanelOpen}
        onToggleContactPanel={() => setContactPanelOpen((o) => !o)}
        // sibling route, relative to the inbox path (works whatever prefix Task 16 registered)
        onOpenChat={(chatId) => navigate(`../${chatId}`, { relative: 'path' })}
      />
    </div>
  );
}
```

In `web/src/App.tsx`, add the import:
```tsx
import ConversationPage from './pages/Conversation';
```
Find the inbox route that Task 16 registered and its `:id` child, which currently renders the "Carregando conversa…" placeholder. Set that child's element to `<ConversationPage />` and leave the parent and index routes unchanged.
- If `App.tsx` uses route objects (Task 15's `routes: RouteObject[]`), the child becomes:
  ```tsx
  { path: ':id', element: <ConversationPage /> },
  ```
- If it uses JSX routes, the child becomes:
  ```tsx
  <Route path=":id" element={<ConversationPage />} />
  ```

- [ ] **Step 17: Typecheck and build**

Run: `npm run typecheck -w web`
Expected: exits 0 with no errors.

Run: `npm run build -w web`
Expected: `tsc --noEmit` passes, then Vite prints `✓ built in …` and writes `web/dist/index.html`.

- [ ] **Step 18: Run the whole web suite**

Run: `npm test -w web`
Expected: PASS. This includes `model.test.ts` (10) and `Composer.test.tsx` (7), plus the Task 15 and 16 suites.

- [ ] **Step 19: Manual check in the dev server**

Start the dev server with `npm run dev -w web`, with the server from Tasks 1–14 running and a channel connected. Log in and open a chat from the inbox.

Header and timeline:
- The header shows the contact, the sector chip and "Sem dono" with **Assumir**. Clicking Assumir shows your name and adds the event "… assumiu a conversa" to the timeline.
- Scrolling to the top loads older messages without jumping. Date separators read "Hoje", "Ontem" and dd/mm/aaaa.

Sending:
- Typing and pressing Enter sends. The bubble first shows a clock, then ✓, then ✓✓, and a blue ✓✓ once the phone reads it.
- Shift+Enter inserts a line break.
- With the signature on, the phone receives `*Setor - Nome:*` and then the text. Turning it off and reloading keeps it off.
- Typing `/` lists the quick answers. Picking one fills the box with the variables replaced and does not send it.
- Dropping a PDF on the composer attaches it. Sending it shows a document link that opens the file.
- Clicking the microphone, speaking and then clicking "Enviar áudio" makes the phone receive a voice note.

Incoming and replies:
- An image, an audio, a video and a document sent from the phone render as a thumbnail, a player, a player and a link.
- A 👍 reaction from the phone appears as a badge on the target bubble.
- Hovering an incoming message and clicking **Responder** shows the reply chip. The sent message arrives on the phone as a quote.

Notes, failures and closing:
- In **Notas**, the box turns yellow and saving adds a yellow bubble that never reaches the phone.
- With Evolution stopped, a sent message turns red with **Reenviar**. Starting Evolution again and clicking Reenviar delivers it.
- **Transferir** lists only the agents of the chosen sector.
- **Finalizar** with "Enviar mensagem de encerramento" checked sends the configured text and then shows "Conversa finalizada — Nova conversa". **Nova conversa** opens a fresh chat for the same contact.

- [ ] **Step 20: Commit**

```bash
git add web/src/components/conversation/MessageBubble.tsx web/src/components/conversation/Timeline.tsx web/src/components/conversation/ChatDialogs.tsx web/src/components/conversation/ConversationHeader.tsx web/src/components/conversation/ConversationView.tsx web/src/pages/Conversation.tsx web/src/App.tsx
git commit -m "feat(web): conversation view (header actions, timeline, closed footer)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


---

### Task 18: Web contacts: list, contact panel and contact page

Mirrors Umbler's `/contacts` table, the **Contato** side drawer (tabs **Contato** / **Detalhes da conversa**) and the **Novo contato** page (spec §3 item 5, §5.3a; `docs/MAPA-UMBLER-TALK.md` §3 and §4). The contact panel is one component, used from the contact list and from the conversation page.

**Files:**
- Create: `web/src/components/contacts/phone.ts`: display formatting and the input mask for BR phones
- Create: `web/src/components/contacts/ContactForm.tsx`: create/edit form; exports `Field`, `inputClass`, `ADDRESS_FIELDS`, `FIELD_INPUT_TYPE`
- Create: `web/src/components/contacts/TagsEditor.tsx`
- Create: `web/src/components/contacts/NotesList.tsx`
- Create: `web/src/components/contacts/CustomFieldsEditor.tsx`
- Create: `web/src/components/contacts/ContactPanel.tsx`: drawer, tabs, contact data, block, "Nova conversa", the contact's chats and the chat details tab; exports `ContactPanel` and `Avatar`
- Create: `web/src/pages/Contacts.tsx`
- Create: `web/src/pages/ContactNew.tsx`
- Modify: `web/src/App.tsx` (add two child routes to the `'/'` layout route)
- Modify: `web/src/pages/Conversation.tsx` (Task 17: mount `ContactPanel` when `contactPanelOpen` is true)
- Test: `web/src/components/contacts/phone.test.ts`, `web/src/components/contacts/ContactForm.test.tsx`, `web/src/components/contacts/TagsEditor.test.tsx`, `web/src/components/contacts/NotesList.test.tsx`

**Interfaces:**
- Consumes:
  - Task 15, `web/src/lib/api.ts`:
    - `api.contacts.{list, create, get, update, block, setTags, setFields, chats, notes, addNote, updateNote, deleteNote}`, `api.tags.list()`, `api.customFields.list()`, `api.sectors.list()`, `api.users.list()`, `api.channels.list()`, `api.chats.start({ contactId })`, `api.chats.get(id)`. Errors are `ApiError extends Error` whose `message` is the server's `{ error }` text.
    - Types `ContactInput`, `ContactListQuery`, `Page<T>`.
    - Query keys `qk.contacts` (prefix), `qk.contactList(q)`, `qk.contact(id)`, `qk.contactChats(id)`, `qk.contactNotes(id)`, `qk.tags`, `qk.customFields`, `qk.sectors`, `qk.users`, `qk.channels`, `qk.chats` (prefix), `qk.chat(id)`.
    - Tests keep the real module (for `qk`) and replace only `api`: `vi.mock('../../lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../lib/api')>()), api: m }))`, with `m` built by `vi.hoisted`.
  - Task 15, `web/src/App.tsx`: `export const routes: RouteObject[]`. The authenticated layout route is `path: '/'` with `children`, ending in the `*` catch-all. The sidebar links to `/contatos`.
  - Task 16/17: the conversation route is `/conversas/:id`. `web/src/pages/Conversation.tsx` (default export `ConversationPage`) owns `contactPanelOpen`. The header's **Contato** button toggles it through `onToggleContactPanel`.
  - `@talk/shared`: `ContactDto`, `ContactNoteDto`, `TagDto`, `CustomFieldDto`, `ChatListItem`, `ChatDetail`.
  - Task 12 REST: `GET/POST /api/contacts`, `GET/PATCH /api/contacts/:id`, `POST /api/contacts/:id/block {blocked}`, `PUT /api/contacts/:id/tags {tagIds}`, `PUT /api/contacts/:id/fields {[fieldId]: value}`, `GET /api/contacts/:id/chats`, `GET/POST /api/contacts/:id/notes`, `PATCH/DELETE /api/contacts/:id/notes/:noteId`, `GET /api/tags|custom-fields|sectors|users|channels`. Task 13: `POST /api/chats {contactId}`, `GET /api/chats/:id`.
- Produces:
  - `ContactPanel(props: { contactId: string; chatId?: string; onClose: () => void }): JSX.Element`. With `chatId`, it also shows the **Detalhes da conversa** tab.
  - `Avatar(props: { name: string | null }): JSX.Element`
  - `ContactForm(props: { contact?: ContactDto; onSaved: (contact: ContactDto) => void; onCancel: () => void }): JSX.Element`
  - `ContactsPage(): JSX.Element` at route `/contatos`, and `ContactNewPage(): JSX.Element` at route `/contatos/novo`
  - `localDigits(raw: string): string`, `maskPhone(raw: string): string`, `formatPhone(phone: string | null): string`
  - Cache behaviour: a saved contact is written to `qk.contact(id)` and every contact list is invalidated with `qk.contactList({})` (an empty filter object partially matches every list key). A tag change also invalidates `qk.chats`, because `ChatListItem.tagIds` comes from the contact's tags. The chat details tab and the conversation page read `qk.chat(id)`, the same entry Task 17 and the WS handler update.
- Conventions this task fixes:
  - `ContactDto.address` uses Umbler's `AddressModel` keys: `addressLine1` (Endereço), `addressLine2` (Complemento), `city`, `state`, `zipCode` (CEP), `country` (País). The Task 20 importer can copy them as they are.
  - `ContactDto.fields` is keyed by custom-field **id**, which is also the key of `PUT /fields`. The client always sends the full map, so the request is correct whether the server replaces or merges.
  - The form sends `phone` and `landline` as `'55' + local digits`, and the server's `normalizePhoneBR` adds the 9.

- [ ] **Step 1: Write the failing phone-format test**

`web/src/components/contacts/phone.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { formatPhone, localDigits, maskPhone } from './phone';

describe('localDigits', () => {
  it('strips the 55 country code only from full numbers', () => {
    expect(localDigits('+55 (65) 99999-1234')).toBe('65999991234');
    expect(localDigits('55999991234')).toBe('55999991234'); // DDD 55 (RS), 11 digits: kept
    expect(localDigits('659999912345678')).toBe('65999991234');
  });
});

describe('maskPhone', () => {
  it('masks a mobile number', () => {
    expect(maskPhone('65999991234')).toBe('(65) 99999-1234');
  });
  it('masks a landline', () => {
    expect(maskPhone('6532221111')).toBe('(65) 3222-1111');
  });
  it('masks a canonical 13-digit number', () => {
    expect(maskPhone('5565999991234')).toBe('(65) 99999-1234');
  });
  it('masks partial input while typing', () => {
    expect(maskPhone('')).toBe('');
    expect(maskPhone('6')).toBe('(6');
    expect(maskPhone('659')).toBe('(65) 9');
    expect(maskPhone('659999')).toBe('(65) 9999');
    expect(maskPhone('6599999')).toBe('(65) 9999-9');
    expect(maskPhone('65999991')).toBe('(65) 9999-91');
  });
});

describe('formatPhone', () => {
  it('formats canonical numbers for display', () => {
    expect(formatPhone('5565999991234')).toBe('+55 (65) 99999-1234');
    expect(formatPhone('556532221111')).toBe('+55 (65) 3222-1111');
  });
  it('handles missing and foreign numbers', () => {
    expect(formatPhone(null)).toBe('—');
    expect(formatPhone('14155550123')).toBe('+14155550123');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w web -- src/components/contacts/phone.test.ts`
Expected: FAIL with `Failed to resolve import "./phone"`.

- [ ] **Step 3: Implement `phone.ts`**

`web/src/components/contacts/phone.ts`
```ts
// ponytail: BR-only display/mask. The server's normalizePhoneBR is the source of truth for storage.

/** Digits without the 55 country code, capped at 11 (DDD + 9 digits). */
export function localDigits(raw: string): string {
  let d = raw.replace(/\D/g, '');
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
  return d.slice(0, 11);
}

/** "(65) 99999-1234" / "(65) 3222-1111", progressively while typing. */
export function maskPhone(raw: string): string {
  const d = localDigits(raw);
  if (d.length === 0) return '';
  if (d.length <= 2) return `(${d}`;
  const ddd = d.slice(0, 2);
  const rest = d.slice(2);
  const split = rest.length > 8 ? 5 : 4;
  if (rest.length <= split) return `(${ddd}) ${rest}`;
  return `(${ddd}) ${rest.slice(0, split)}-${rest.slice(split)}`;
}

/** Display form of a stored phone ("5565999991234" -> "+55 (65) 99999-1234"). */
export function formatPhone(phone: string | null): string {
  if (!phone) return '—';
  const d = phone.replace(/\D/g, '');
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) return `+55 ${maskPhone(d)}`;
  return `+${d}`;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test -w web -- src/components/contacts/phone.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Write the failing contact-form test**

`web/src/components/contacts/ContactForm.test.tsx`
```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ContactDto } from '@talk/shared';
import { ContactForm } from './ContactForm';

const m = vi.hoisted(() => ({
  contacts: { create: vi.fn(), update: vi.fn(), setFields: vi.fn() },
  customFields: { list: vi.fn() },
}));
vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  api: m,
}));

const contact: ContactDto = {
  id: 'c1', name: 'Maria Souza', phone: '5565999991234', lid: null, email: null, landline: null,
  address: null, blocked: false, tagIds: [], fields: {}, createdAt: '2026-10-01T12:00:00.000Z',
};

function renderForm(existing?: ContactDto) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onSaved = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <ContactForm contact={existing} onSaved={onSaved} onCancel={vi.fn()} />
    </QueryClientProvider>,
  );
  return { onSaved };
}

const celular = () => screen.getByLabelText(/Celular/) as HTMLInputElement;

beforeEach(() => {
  vi.resetAllMocks();
  m.customFields.list.mockResolvedValue([]);
  m.contacts.create.mockImplementation(async (input: object) => ({ ...contact, ...input }));
  m.contacts.update.mockImplementation(async (_id: string, input: object) => ({ ...contact, ...input }));
});
afterEach(cleanup);

describe('ContactForm', () => {
  it('requires the celular', async () => {
    renderForm();
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Maria' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Informe o celular.');
    expect(m.contacts.create).not.toHaveBeenCalled();
  });

  it('rejects a celular without DDD', async () => {
    renderForm();
    fireEvent.change(celular(), { target: { value: '99991234' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Celular inválido: informe DDD e número.');
  });

  it('shows the stored phone formatted', () => {
    renderForm(contact);
    expect(celular().value).toBe('(65) 99999-1234');
  });

  it('masks while typing and posts 55 + digits', async () => {
    const { onSaved } = renderForm();
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: ' Maria ' } });
    fireEvent.change(celular(), { target: { value: '65 99999 1234' } });
    expect(celular().value).toBe('(65) 99999-1234');
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(m.contacts.create).toHaveBeenCalledWith({
      name: 'Maria', phone: '5565999991234', email: null, landline: null, address: null,
    });
    expect(m.contacts.setFields).not.toHaveBeenCalled();
  });

  it('patches an existing contact with address fields', async () => {
    const { onSaved } = renderForm(contact);
    fireEvent.change(screen.getByLabelText('Cidade'), { target: { value: 'Cuiabá' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(m.contacts.update).toHaveBeenCalledWith('c1', {
      name: 'Maria Souza', phone: '5565999991234', email: null, landline: null, address: { city: 'Cuiabá' },
    });
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npm test -w web -- src/components/contacts/ContactForm.test.tsx`
Expected: FAIL with `Failed to resolve import "./ContactForm"`.

- [ ] **Step 7: Implement `ContactForm.tsx`**

`web/src/components/contacts/ContactForm.tsx`
```tsx
import { useState, type FormEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ContactDto, CustomFieldDto } from '@talk/shared';
import { api, qk, type ContactInput } from '../../lib/api';
import { localDigits, maskPhone } from './phone';

// Keys follow Umbler's AddressModel so the importer can copy them unchanged.
export const ADDRESS_FIELDS = [
  ['addressLine1', 'Endereço'],
  ['addressLine2', 'Complemento'],
  ['city', 'Cidade'],
  ['state', 'Estado'],
  ['zipCode', 'CEP'],
  ['country', 'País'],
] as const;

export const FIELD_INPUT_TYPE: Record<CustomFieldDto['kind'], string> = {
  text: 'text', number: 'number', date: 'date', cpf: 'text', cnpj: 'text',
};

export const inputClass =
  'w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none';

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium text-slate-700">{label}</span>
      {children}
    </label>
  );
}

interface Props {
  contact?: ContactDto;
  onSaved: (contact: ContactDto) => void;
  onCancel: () => void;
}

export function ContactForm({ contact, onSaved, onCancel }: Props) {
  const [name, setName] = useState(contact?.name ?? '');
  const [phone, setPhone] = useState(maskPhone(contact?.phone ?? ''));
  const [landline, setLandline] = useState(maskPhone(contact?.landline ?? ''));
  const [email, setEmail] = useState(contact?.email ?? '');
  const [address, setAddress] = useState<Record<string, string>>(contact?.address ?? {});
  const [fields, setFields] = useState<Record<string, string>>(contact?.fields ?? {});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const customFields = useQuery({ queryKey: qk.customFields, queryFn: () => api.customFields.list() });

  async function submit(e: FormEvent) {
    e.preventDefault();
    const digits = localDigits(phone);
    if (!digits) return setError('Informe o celular.');
    if (digits.length < 10) return setError('Celular inválido: informe DDD e número.');
    const landlineDigits = localDigits(landline);
    const addr: Record<string, string> = Object.fromEntries(
      Object.entries(address).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v),
    );
    const body: ContactInput = {
      name: name.trim() || null,
      phone: '55' + digits,
      email: email.trim() || null,
      landline: landlineDigits ? '55' + landlineDigits : null,
      address: Object.keys(addr).length ? addr : null,
    };
    setSaving(true);
    setError(null);
    try {
      let saved = contact ? await api.contacts.update(contact.id, body) : await api.contacts.create(body);
      if (Object.keys(fields).length) saved = await api.contacts.setFields(saved.id, fields);
      onSaved(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ocorreu um erro');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-6">
      <fieldset className="space-y-3">
        <legend className="mb-2 text-sm font-semibold text-slate-900">Informações básicas</legend>
        <Field label="Nome">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Celular *">
          <input
            className={inputClass}
            inputMode="tel"
            aria-required="true"
            placeholder="(65) 99999-9999"
            value={phone}
            onChange={(e) => setPhone(maskPhone(e.target.value))}
          />
        </Field>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="mb-2 text-sm font-semibold text-slate-900">Dados complementares</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Telefone fixo">
            <input
              className={inputClass}
              inputMode="tel"
              placeholder="(65) 3222-1111"
              value={landline}
              onChange={(e) => setLandline(maskPhone(e.target.value))}
            />
          </Field>
          <Field label="E-mail">
            <input className={inputClass} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          {ADDRESS_FIELDS.map(([key, label]) => (
            <Field key={key} label={label}>
              <input
                className={inputClass}
                value={address[key] ?? ''}
                onChange={(e) => setAddress({ ...address, [key]: e.target.value })}
              />
            </Field>
          ))}
        </div>
      </fieldset>

      {!!customFields.data?.length && (
        <fieldset className="space-y-3">
          <legend className="mb-2 text-sm font-semibold text-slate-900">Campos personalizados</legend>
          {customFields.data.map((f) => (
            <Field key={f.id} label={f.name}>
              <input
                className={inputClass}
                type={FIELD_INPUT_TYPE[f.kind]}
                value={fields[f.id] ?? ''}
                onChange={(e) => setFields({ ...fields, [f.id]: e.target.value })}
              />
            </Field>
          ))}
        </fieldset>
      )}

      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}

      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-md px-4 py-2 text-sm hover:bg-slate-100">
          Cancelar
        </button>
        <button
          type="submit"
          disabled={saving}
          className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          Salvar
        </button>
      </div>
    </form>
  );
}
```

- [ ] **Step 8: Run it to verify it passes**

Run: `npm test -w web -- src/components/contacts/ContactForm.test.tsx src/components/contacts/phone.test.ts`
Expected: PASS (5 + 7 tests).

- [ ] **Step 9: Commit**

```bash
git add web/src/components/contacts/phone.ts web/src/components/contacts/phone.test.ts web/src/components/contacts/ContactForm.tsx web/src/components/contacts/ContactForm.test.tsx
git commit -m "feat(web): contact form with BR phone mask and validation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 10: Write the failing tags-editor and notes tests**

`web/src/components/contacts/TagsEditor.test.tsx`
```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ContactDto, TagDto } from '@talk/shared';
import { qk } from '../../lib/api';
import { TagsEditor } from './TagsEditor';

const m = vi.hoisted(() => ({
  contacts: { setTags: vi.fn() },
  tags: { list: vi.fn() },
}));
vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  api: m,
}));

const contact: ContactDto = {
  id: 'c1', name: 'Maria', phone: '5565999991234', lid: null, email: null, landline: null,
  address: null, blocked: false, tagIds: ['t1'], fields: {}, createdAt: '2026-10-01T12:00:00.000Z',
};
const tags: TagDto[] = [
  { id: 't1', name: 'Cliente', emoji: null, color: '#2563eb', position: 0 },
  { id: 't2', name: 'Urgente', emoji: '🔥', color: '#dc2626', position: 1 },
];

function renderEditor() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <TagsEditor contact={contact} />
    </QueryClientProvider>,
  );
  return qc;
}

beforeEach(() => {
  vi.resetAllMocks();
  m.tags.list.mockResolvedValue(tags);
  m.contacts.setTags.mockImplementation(async (_id: string, tagIds: string[]) => ({ ...contact, tagIds }));
});
afterEach(cleanup);

describe('TagsEditor', () => {
  it('marks the contact tags as pressed', async () => {
    renderEditor();
    expect((await screen.findByRole('button', { name: /Cliente/ })).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: /Urgente/ }).getAttribute('aria-pressed')).toBe('false');
  });

  it('adds a tag with setTags and caches the returned contact', async () => {
    const qc = renderEditor();
    fireEvent.click(await screen.findByRole('button', { name: /Urgente/ }));
    await waitFor(() => expect(m.contacts.setTags).toHaveBeenCalledWith('c1', ['t1', 't2']));
    await waitFor(() => expect(qc.getQueryData<ContactDto>(qk.contact('c1'))?.tagIds).toEqual(['t1', 't2']));
  });

  it('removes a tag with setTags', async () => {
    renderEditor();
    fireEvent.click(await screen.findByRole('button', { name: /Cliente/ }));
    await waitFor(() => expect(m.contacts.setTags).toHaveBeenCalledWith('c1', []));
  });
});
```

`web/src/components/contacts/NotesList.test.tsx`
```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ContactNoteDto } from '@talk/shared';
import { NotesList } from './NotesList';

const m = vi.hoisted(() => ({
  contacts: { notes: vi.fn(), addNote: vi.fn(), updateNote: vi.fn(), deleteNote: vi.fn() },
}));
vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  api: m,
}));

let notes: ContactNoteDto[];

function renderNotes() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <NotesList contactId="c1" />
    </QueryClientProvider>,
  );
}

const textarea = () => screen.getByLabelText('Nova observação') as HTMLTextAreaElement;
const addButton = () => screen.getByRole('button', { name: 'Adicionar' }) as HTMLButtonElement;

beforeEach(() => {
  vi.resetAllMocks();
  notes = [{ id: 'n1', body: 'Cliente prefere WhatsApp', pinned: false, authorName: 'Ana', createdAt: '2026-10-14T12:00:00.000Z' }];
  m.contacts.notes.mockImplementation(async () => notes);
  m.contacts.addNote.mockImplementation(async (_id: string, body: string) => {
    const note: ContactNoteDto = { id: 'n2', body, pinned: false, authorName: 'Ana', createdAt: '2026-10-14T13:00:00.000Z' };
    notes = [...notes, note];
    return note;
  });
  m.contacts.updateNote.mockImplementation(async (_id: string, noteId: string, patch: Partial<ContactNoteDto>) => {
    notes = notes.map((n) => (n.id === noteId ? { ...n, ...patch } : n));
    return notes.find((n) => n.id === noteId);
  });
});
afterEach(cleanup);

describe('NotesList', () => {
  it('lists notes and disables Adicionar while empty', async () => {
    renderNotes();
    await screen.findByText('Cliente prefere WhatsApp');
    expect(addButton().disabled).toBe(true);
  });

  it('adds a note, clears the box and shows it', async () => {
    renderNotes();
    await screen.findByText('Cliente prefere WhatsApp');
    fireEvent.change(textarea(), { target: { value: '  Ligar amanhã  ' } });
    fireEvent.click(addButton());
    await waitFor(() => expect(m.contacts.addNote).toHaveBeenCalledWith('c1', 'Ligar amanhã'));
    await screen.findByText('Ligar amanhã');
    expect(textarea().value).toBe('');
  });

  it('pins a note with updateNote', async () => {
    renderNotes();
    fireEvent.click(await screen.findByRole('button', { name: 'Fixar observação' }));
    await waitFor(() => expect(m.contacts.updateNote).toHaveBeenCalledWith('c1', 'n1', { pinned: true }));
    await screen.findByRole('button', { name: 'Desafixar observação' });
  });
});
```

- [ ] **Step 11: Run them to verify they fail**

Run: `npm test -w web -- src/components/contacts/TagsEditor.test.tsx src/components/contacts/NotesList.test.tsx`
Expected: FAIL with `Failed to resolve import "./TagsEditor"` and `Failed to resolve import "./NotesList"`.

- [ ] **Step 12: Implement `TagsEditor.tsx`, `NotesList.tsx` and `CustomFieldsEditor.tsx`**

`web/src/components/contacts/TagsEditor.tsx`
```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ContactDto } from '@talk/shared';
import { api, qk } from '../../lib/api';

// ponytail: every tag is a toggle chip; add a search popover if the office passes ~40 tags.
export function TagsEditor({ contact }: { contact: ContactDto }) {
  const qc = useQueryClient();
  const tags = useQuery({ queryKey: qk.tags, queryFn: () => api.tags.list() });
  const save = useMutation({
    mutationFn: (tagIds: string[]) => api.contacts.setTags(contact.id, tagIds),
    onSuccess: (dto) => {
      qc.setQueryData(qk.contact(dto.id), dto);
      void qc.invalidateQueries({ queryKey: qk.contactList({}) }); // {} partially matches every list filter
      void qc.invalidateQueries({ queryKey: qk.chats }); // ChatListItem.tagIds come from the contact
    },
  });

  const selected = new Set(contact.tagIds);
  function toggle(id: string) {
    save.mutate(selected.has(id) ? contact.tagIds.filter((t) => t !== id) : [...contact.tagIds, id]);
  }

  if (!tags.data?.length) return <p className="text-sm text-slate-500">Nenhuma etiqueta cadastrada.</p>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {tags.data.map((t) => {
        const on = selected.has(t.id);
        return (
          <button
            key={t.id}
            type="button"
            aria-pressed={on}
            disabled={save.isPending}
            onClick={() => toggle(t.id)}
            className="rounded-full border px-2.5 py-0.5 text-xs font-medium disabled:opacity-60"
            style={on ? { backgroundColor: t.color, borderColor: t.color, color: '#fff' } : { borderColor: t.color, color: t.color }}
          >
            {t.emoji ? `${t.emoji} ` : ''}
            {t.name}
          </button>
        );
      })}
      {save.error && <p role="alert" className="w-full text-xs text-red-600">{save.error.message}</p>}
    </div>
  );
}
```

`web/src/components/contacts/NotesList.tsx`
```tsx
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PushPin, Trash } from '@phosphor-icons/react';
import type { ContactNoteDto } from '@talk/shared';
import { api, qk } from '../../lib/api';

export function NotesList({ contactId }: { contactId: string }) {
  const qc = useQueryClient();
  const key = qk.contactNotes(contactId);
  const [text, setText] = useState('');
  const notes = useQuery({ queryKey: key, queryFn: () => api.contacts.notes(contactId) });
  const refresh = () => qc.invalidateQueries({ queryKey: key });
  const add = useMutation({
    mutationFn: (body: string) => api.contacts.addNote(contactId, body),
    onSuccess: () => {
      setText('');
      return refresh();
    },
  });
  const pin = useMutation({
    mutationFn: (n: ContactNoteDto) => api.contacts.updateNote(contactId, n.id, { pinned: !n.pinned }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (noteId: string) => api.contacts.deleteNote(contactId, noteId),
    onSuccess: refresh,
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (text.trim()) add.mutate(text.trim());
  }

  const sorted = [...(notes.data ?? [])].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt.localeCompare(a.createdAt),
  );

  return (
    <div className="space-y-3">
      <form onSubmit={submit} className="space-y-2">
        <textarea
          aria-label="Nova observação"
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Escreva uma observação"
          className="w-full resize-y rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none"
        />
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={!text.trim() || add.isPending}
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            Adicionar
          </button>
        </div>
      </form>
      {(add.error || pin.error || remove.error) && (
        <p role="alert" className="text-xs text-red-600">{(add.error ?? pin.error ?? remove.error)?.message}</p>
      )}
      <ul className="space-y-2">
        {sorted.map((n) => (
          <li key={n.id} className={`rounded-md border p-3 text-sm ${n.pinned ? 'border-amber-300 bg-amber-50' : 'border-slate-200'}`}>
            <p className="whitespace-pre-wrap break-words">{n.body}</p>
            <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
              <span className="flex-1">
                {n.authorName ?? 'Sistema'} · {new Date(n.createdAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
              </span>
              <button
                type="button"
                aria-label={n.pinned ? 'Desafixar observação' : 'Fixar observação'}
                aria-pressed={n.pinned}
                onClick={() => pin.mutate(n)}
                className="rounded p-1 hover:bg-slate-100"
              >
                <PushPin size={14} weight={n.pinned ? 'fill' : 'regular'} />
              </button>
              <button
                type="button"
                aria-label="Excluir observação"
                onClick={() => window.confirm('Excluir esta observação?') && remove.mutate(n.id)}
                className="rounded p-1 hover:bg-slate-100"
              >
                <Trash size={14} />
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

`web/src/components/contacts/CustomFieldsEditor.tsx`
```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ContactDto } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { FIELD_INPUT_TYPE, Field, inputClass } from './ContactForm';

/** Inline edit: each input saves on blur when its value changed. Always sends the full map. */
export function CustomFieldsEditor({ contact }: { contact: ContactDto }) {
  const qc = useQueryClient();
  const defs = useQuery({ queryKey: qk.customFields, queryFn: () => api.customFields.list() });
  const save = useMutation({
    mutationFn: (fields: Record<string, string>) => api.contacts.setFields(contact.id, fields),
    onSuccess: (dto) => qc.setQueryData(qk.contact(dto.id), dto),
  });

  if (!defs.data?.length) return <p className="text-sm text-slate-500">Nenhum campo personalizado.</p>;
  return (
    <div className="space-y-3">
      {defs.data.map((f) => {
        const current = contact.fields[f.id] ?? '';
        return (
          <Field key={f.id} label={f.name}>
            <input
              key={current}
              defaultValue={current}
              type={FIELD_INPUT_TYPE[f.kind]}
              className={inputClass}
              onBlur={(e) => {
                const value = e.target.value.trim();
                if (value !== current) save.mutate({ ...contact.fields, [f.id]: value });
              }}
            />
          </Field>
        );
      })}
      {save.error && <p role="alert" className="text-xs text-red-600">{save.error.message}</p>}
    </div>
  );
}
```

- [ ] **Step 13: Run them to verify they pass**

Run: `npm test -w web -- src/components/contacts`
Expected: PASS (all 4 files: phone 7, ContactForm 5, TagsEditor 3, NotesList 3).

- [ ] **Step 14: Commit**

```bash
git add web/src/components/contacts/TagsEditor.tsx web/src/components/contacts/TagsEditor.test.tsx web/src/components/contacts/NotesList.tsx web/src/components/contacts/NotesList.test.tsx web/src/components/contacts/CustomFieldsEditor.tsx
git commit -m "feat(web): contact tags editor, notes and inline custom fields

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 15: Implement `ContactPanel.tsx`**

`web/src/components/contacts/ContactPanel.tsx`
```tsx
import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChatCircle, PencilSimple, Prohibit, X } from '@phosphor-icons/react';
import type { ContactDto } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { ADDRESS_FIELDS, ContactForm } from './ContactForm';
import { CustomFieldsEditor } from './CustomFieldsEditor';
import { NotesList } from './NotesList';
import { TagsEditor } from './TagsEditor';
import { formatPhone } from './phone';

const dateTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—';

export function Avatar({ name }: { name: string | null }) {
  const initials =
    (name ?? '').trim().split(/\s+/).slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join('') || '?';
  return (
    <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-sm font-semibold text-emerald-800">
      {initials}
    </span>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h3>
      {children}
    </section>
  );
}

function Rows({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
      {rows.map(([k, v]) => (
        <Fragment key={k}>
          <dt className="text-slate-500">{k}</dt>
          <dd className="break-words">{v}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`border-b-2 px-3 py-3 text-sm font-medium ${active ? 'border-emerald-600 text-emerald-700' : 'border-transparent text-slate-500 hover:text-slate-800'}`}
    >
      {children}
    </button>
  );
}

interface Props {
  contactId: string;
  chatId?: string;
  onClose: () => void;
}

export function ContactPanel({ contactId, chatId, onClose }: Props) {
  const [tab, setTab] = useState<'contact' | 'chat'>('contact');
  const contact = useQuery({ queryKey: qk.contact(contactId), queryFn: () => api.contacts.get(contactId) });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/30" aria-hidden onClick={onClose} />
      <aside role="dialog" aria-modal="true" aria-label="Contato" className="relative flex h-full w-full max-w-md flex-col bg-white shadow-xl">
        <header role="tablist" className="flex items-center border-b border-slate-200 px-2">
          <TabButton active={tab === 'contact'} onClick={() => setTab('contact')}>Contato</TabButton>
          {chatId && (
            <TabButton active={tab === 'chat'} onClick={() => setTab('chat')}>Detalhes da conversa</TabButton>
          )}
          <button type="button" aria-label="Fechar" onClick={onClose} className="ml-auto rounded p-2 hover:bg-slate-100">
            <X size={18} />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto p-4">
          {tab === 'chat' && chatId ? (
            <ChatDetailsTab chatId={chatId} />
          ) : contact.data ? (
            <ContactTab contact={contact.data} onClose={onClose} />
          ) : (
            <p className="text-sm text-slate-500">{contact.isError ? 'Contato não encontrado.' : 'Carregando…'}</p>
          )}
        </div>
      </aside>
    </div>
  );
}

function ContactTab({ contact, onClose }: { contact: ContactDto; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const setContact = (dto: ContactDto) => {
    qc.setQueryData(qk.contact(dto.id), dto);
    void qc.invalidateQueries({ queryKey: qk.contactList({}) }); // {} partially matches every list filter
  };
  const block = useMutation({
    mutationFn: (blocked: boolean) => api.contacts.block(contact.id, blocked),
    onSuccess: setContact,
  });
  const start = useMutation({
    mutationFn: () => api.chats.start({ contactId: contact.id }),
    onSuccess: (chat) => {
      onClose();
      navigate(`/conversas/${chat.id}`);
    },
  });

  if (editing) {
    return (
      <ContactForm
        contact={contact}
        onCancel={() => setEditing(false)}
        onSaved={(dto) => {
          setContact(dto);
          setEditing(false);
        }}
      />
    );
  }

  function toggleBlock() {
    const question = contact.blocked
      ? 'Desbloquear este contato? As mensagens dele voltarão a ser recebidas.'
      : 'Bloquear este contato? As mensagens dele deixarão de ser recebidas.';
    if (window.confirm(question)) block.mutate(!contact.blocked);
  }

  const address = ADDRESS_FIELDS.map(([key]) => contact.address?.[key]).filter(Boolean).join(', ');
  const error = start.error ?? block.error;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Avatar name={contact.name} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{contact.name || formatPhone(contact.phone)}</p>
          <p className="text-sm text-slate-500">{formatPhone(contact.phone)}</p>
          {contact.blocked && <span className="text-xs font-medium text-red-600">Bloqueado</span>}
        </div>
        <button type="button" aria-label="Editar contato" onClick={() => setEditing(true)} className="rounded p-2 hover:bg-slate-100">
          <PencilSimple size={18} />
        </button>
      </div>

      <button
        type="button"
        disabled={contact.blocked || start.isPending}
        onClick={() => start.mutate()}
        className="flex w-full items-center justify-center gap-2 rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
      >
        <ChatCircle size={16} /> Nova conversa
      </button>
      {error && <p role="alert" className="text-sm text-red-600">{error.message}</p>}

      <Section title="Etiquetas">
        <TagsEditor contact={contact} />
      </Section>

      <Section title="Observações">
        <NotesList contactId={contact.id} />
      </Section>

      <Section title="Dados do contato">
        <Rows
          rows={[
            ['Celular', formatPhone(contact.phone)],
            ['Telefone fixo', formatPhone(contact.landline)],
            ['E-mail', contact.email ?? '—'],
            ['Endereço', address || '—'],
            ['LID', contact.lid ?? '—'],
            ['Criado em', dateTime(contact.createdAt)],
          ]}
        />
      </Section>

      <Section title="Campos personalizados">
        <CustomFieldsEditor contact={contact} />
      </Section>

      <Section title="Todas as conversas deste contato">
        <ContactChats contactId={contact.id} onNavigate={onClose} />
      </Section>

      <button
        type="button"
        onClick={toggleBlock}
        disabled={block.isPending}
        className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
      >
        <Prohibit size={16} /> {contact.blocked ? 'Desbloquear contato' : 'Bloquear contato'}
      </button>
    </div>
  );
}

function ContactChats({ contactId, onNavigate }: { contactId: string; onNavigate: () => void }) {
  const chats = useQuery({ queryKey: qk.contactChats(contactId), queryFn: () => api.contacts.chats(contactId) });
  const sectors = useQuery({ queryKey: qk.sectors, queryFn: () => api.sectors.list() }).data ?? [];
  if (!chats.data?.length) return <p className="text-sm text-slate-500">Nenhuma conversa visível.</p>;
  return (
    <ul className="divide-y divide-slate-100">
      {chats.data.map((c) => (
        <li key={c.id}>
          <Link to={`/conversas/${c.id}`} onClick={onNavigate} className="block rounded px-1 py-2 hover:bg-slate-50">
            <div className="flex justify-between text-sm">
              <span className="font-medium">{sectors.find((s) => s.id === c.sectorId)?.name ?? '—'}</span>
              <span className={c.state === 'open' ? 'text-emerald-700' : 'text-slate-500'}>
                {c.state === 'open' ? 'Aberta' : 'Finalizada'}
              </span>
            </div>
            <p className="truncate text-xs text-slate-500">
              {dateTime(c.lastMessageAt)}
              {c.lastMessagePreview ? ` · ${c.lastMessagePreview}` : ''}
            </p>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function ChatDetailsTab({ chatId }: { chatId: string }) {
  // Same cache entry as Task 17 and the WS handler, so the tab follows live updates.
  const chat = useQuery({ queryKey: qk.chat(chatId), queryFn: () => api.chats.get(chatId) });
  const sectors = useQuery({ queryKey: qk.sectors, queryFn: () => api.sectors.list() }).data ?? [];
  const users = useQuery({ queryKey: qk.users, queryFn: () => api.users.list() }).data ?? [];
  const channels = useQuery({ queryKey: qk.channels, queryFn: () => api.channels.list() }).data ?? [];
  if (!chat.data) return <p className="text-sm text-slate-500">{chat.isError ? 'Conversa não encontrada.' : 'Carregando…'}</p>;
  const c = chat.data;
  const rows: Array<[string, string]> = [
    ['Canal', channels.find((x) => x.id === c.channelId)?.name ?? '—'],
    ['Setor', sectors.find((x) => x.id === c.sectorId)?.name ?? '—'],
    ['Atendente', c.ownerId ? (users.find((u) => u.id === c.ownerId)?.name ?? '—') : 'Sem atendente'],
    ['Status', c.state === 'open' ? (c.waiting ? 'Aberta · esperando resposta' : 'Aberta') : 'Finalizada'],
    ['Visibilidade', c.private ? 'Privada' : 'Pública'],
    ['Iniciada em', dateTime(c.createdAt)],
    ['Última mensagem', dateTime(c.lastMessageAt)],
  ];
  if (c.closedAt) rows.push(['Finalizada em', dateTime(c.closedAt)]);
  return <Rows rows={rows} />;
}
```

- [ ] **Step 16: Implement the pages**

`web/src/pages/Contacts.tsx`
```tsx
import { useDeferredValue, useState } from 'react';
import { useNavigate } from 'react-router';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { MagnifyingGlass, Plus } from '@phosphor-icons/react';
import { api, qk } from '../lib/api';
import { Avatar, ContactPanel } from '../components/contacts/ContactPanel';
import { formatPhone } from '../components/contacts/phone';

export function ContactsPage() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [tagId, setTagId] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const search = useDeferredValue(q.trim());
  const tags = useQuery({ queryKey: qk.tags, queryFn: () => api.tags.list() });
  const list = useInfiniteQuery({
    queryKey: qk.contactList({ q: search, tagId }),
    initialPageParam: '',
    // api's qs() drops empty strings, so '' means "no filter" / "first page".
    queryFn: ({ pageParam }) => api.contacts.list({ q: search, tagId, cursor: pageParam, limit: 50 }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const contacts = list.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="flex h-full flex-col p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-xl font-semibold">Contatos</h1>
        <button
          type="button"
          onClick={() => navigate('/contatos/novo')}
          className="flex items-center gap-2 rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
        >
          <Plus size={16} /> Adicionar contato
        </button>
      </div>

      <div className="mb-4 flex flex-wrap gap-3">
        <label className="relative min-w-60 flex-1">
          <span className="sr-only">Buscar por nome ou telefone</span>
          <MagnifyingGlass size={16} className="absolute top-1/2 left-3 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar por nome ou telefone"
            className="w-full rounded-md border border-slate-300 py-2 pr-3 pl-9 text-sm focus:border-emerald-600 focus:outline-none"
          />
        </label>
        <label>
          <span className="sr-only">Filtrar por etiqueta</span>
          <select
            value={tagId}
            onChange={(e) => setTagId(e.target.value)}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm"
          >
            <option value="">Todas as etiquetas</option>
            {tags.data?.map((t) => (
              <option key={t.id} value={t.id}>
                {t.emoji ? `${t.emoji} ` : ''}
                {t.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex-1 overflow-auto rounded-md border border-slate-200">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="sticky top-0 bg-slate-50 text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-2 font-medium">Contato</th>
              <th className="px-4 py-2 font-medium">Telefone</th>
              <th className="px-4 py-2 font-medium">E-mail</th>
              <th className="px-4 py-2 font-medium">Criado em</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {contacts.map((c) => (
              <tr key={c.id} onClick={() => setOpenId(c.id)} className="cursor-pointer hover:bg-slate-50">
                <td className="px-4 py-2">
                  <button type="button" className="flex items-center gap-3 text-left" onClick={() => setOpenId(c.id)}>
                    <Avatar name={c.name} />
                    <span className="font-medium">{c.name || 'Sem nome'}</span>
                    {c.blocked && <span className="text-xs text-red-600">Bloqueado</span>}
                  </button>
                </td>
                <td className="px-4 py-2 whitespace-nowrap">{formatPhone(c.phone)}</td>
                <td className="px-4 py-2">{c.email ?? '—'}</td>
                <td className="px-4 py-2 whitespace-nowrap">{new Date(c.createdAt).toLocaleDateString('pt-BR')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.isSuccess && contacts.length === 0 && (
          <p className="p-6 text-center text-sm text-slate-500">Nenhum contato encontrado.</p>
        )}
        {list.isError && <p className="p-6 text-center text-sm text-red-600">{list.error.message}</p>}
        {list.hasNextPage && (
          <div className="p-3 text-center">
            <button
              type="button"
              disabled={list.isFetchingNextPage}
              onClick={() => list.fetchNextPage()}
              className="rounded-md px-4 py-2 text-sm text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
            >
              Carregar mais
            </button>
          </div>
        )}
      </div>

      {openId && <ContactPanel contactId={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}
```

`web/src/pages/ContactNew.tsx`
```tsx
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { qk } from '../lib/api';
import { ContactForm } from '../components/contacts/ContactForm';

export function ContactNewPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  return (
    <div className="mx-auto max-w-2xl p-4 sm:p-6">
      <h1 className="mb-6 text-xl font-semibold">Novo contato</h1>
      <ContactForm
        onCancel={() => navigate('/contatos')}
        onSaved={() => {
          void qc.invalidateQueries({ queryKey: qk.contactList({}) });
          navigate('/contatos');
        }}
      />
    </div>
  );
}
```

- [ ] **Step 17: Register the routes and mount the panel on the conversation page**

(a) In `web/src/App.tsx` (Task 15's `routes: RouteObject[]`), add the imports:
```tsx
import { ContactsPage } from './pages/Contacts';
import { ContactNewPage } from './pages/ContactNew';
```
Then add these two entries to the `'/'` layout route's `children`, after the `conversas` routes and above the `{ path: '*', element: <NotFound /> }` catch-all. If a placeholder `contatos` entry exists, replace it.
```tsx
      { path: 'contatos', element: <ContactsPage /> },
      { path: 'contatos/novo', element: <ContactNewPage /> },
```

(b) Replace `web/src/pages/Conversation.tsx` (Task 17) with the version below. It keeps Task 17's behaviour and adds the panel next to `<ConversationView>`. The header component is not touched: Task 17's **Contato** button already toggles `contactPanelOpen` through `onToggleContactPanel`. The `useQuery` call reads `qk.chat(id)`, the same cache entry that `ConversationView` already filled, so it sends no extra request. It sits before the early return so that hook order stays stable.
```tsx
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ConversationView } from '../components/conversation/ConversationView';
import { ContactPanel } from '../components/contacts/ContactPanel';
import { api, qk } from '../lib/api';

export default function ConversationPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [contactPanelOpen, setContactPanelOpen] = useState(false); // survives switching chats
  const chat = useQuery({ queryKey: qk.chat(id), queryFn: () => api.chats.get(id), enabled: !!id });
  if (!id) return null;
  return (
    <div className="flex h-full min-w-0">
      <ConversationView
        chatId={id}
        contactPanelOpen={contactPanelOpen}
        onToggleContactPanel={() => setContactPanelOpen((o) => !o)}
        // sibling route, relative to the inbox path (works whatever prefix Task 16 registered)
        onOpenChat={(chatId) => navigate(`../${chatId}`, { relative: 'path' })}
      />
      {contactPanelOpen && chat.data && (
        <ContactPanel contactId={chat.data.contact.id} chatId={id} onClose={() => setContactPanelOpen(false)} />
      )}
    </div>
  );
}
```

- [ ] **Step 18: Verify the build and the full web test suite**

Run: `npm run build -w web`
Expected: exits 0, and `tsc` reports no type errors.

Run: `npm test -w web`
Expected: PASS, including the 18 contact tests.

Manual check (`npm run dev`):
1. Open `/contatos` from the sidebar. Search by name and by phone. Filter by tag.
2. Click **Adicionar contato** (goes to `/contatos/novo`), save without a celular and see "Informe o celular.", then save with one. It returns to `/contatos` and the new contact is listed.
3. Click a row: the drawer opens. Toggle a tag, add and pin a note, and edit a custom field (it saves on blur).
4. Block the contact (confirm), then unblock it.
5. Click **Nova conversa**: it navigates to `/conversas/:id`.
6. In a conversation, the header's **Contato** button opens the drawer, which now has the **Detalhes da conversa** tab. Assume the chat in the header: the tab's **Atendente** row updates without reopening.

- [ ] **Step 19: Commit**

```bash
git add web/src/components/contacts/ContactPanel.tsx web/src/pages/Contacts.tsx web/src/pages/ContactNew.tsx web/src/pages/Conversation.tsx web/src/App.tsx
git commit -m "feat(web): contacts list, contact drawer and new-contact page

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


---

### Task 19: Web settings: sectors, tags, users, quick answers, custom fields, triage, closing message, channel QR

Settings area at `/configuracoes/:section?` with a left menu like Umbler (§3 item 6, §5.6, §5.7, MAPA §10). Admins see every item; agents see only **Perfil** and **Respostas rápidas** (the other items are hidden, and typing their URL redirects to Perfil; the server still enforces 403 on its own).

Known limitation (deliberate, no cross-task edit): the REST table has no self-service profile route. An **admin** edits their own name, signature and password through `PATCH /api/users/:id`. An **agent** sees their profile read-only, with the message "Para alterar nome, assinatura ou senha, peça a um administrador.".

**Files:**
- Create: `web/src/lib/tag-colors.ts`
- Create: `web/src/components/settings/common.tsx`
- Create: `web/src/components/settings/TagForm.tsx`
- Create: `web/src/components/settings/TriageOptionsEditor.tsx`
- Create: `web/src/components/settings/QuickAnswerForm.tsx`
- Create: `web/src/pages/settings/SettingsPage.tsx`
- Create: `web/src/pages/settings/ProfileSettings.tsx`
- Create: `web/src/pages/settings/ChannelsSettings.tsx`
- Create: `web/src/pages/settings/UsersSettings.tsx`
- Create: `web/src/pages/settings/SectorsSettings.tsx`
- Create: `web/src/pages/settings/TagsSettings.tsx`
- Create: `web/src/pages/settings/CustomFieldsSettings.tsx`
- Create: `web/src/pages/settings/QuickAnswersSettings.tsx`
- Create: `web/src/pages/settings/TriageSettings.tsx`
- Create: `web/src/pages/settings/ChatSettings.tsx`
- Modify: `web/src/App.tsx` (one route)
- Test: `web/src/components/settings/TagForm.test.tsx`
- Test: `web/src/components/settings/TriageOptionsEditor.test.tsx`
- Test: `web/src/components/settings/QuickAnswerForm.test.tsx`

**Interfaces:**
- Consumes:
  - From `@talk/shared` (contract): `Me`, `Role`, `SectorDto`, `TagDto`, `UserDto`, `ChannelDto`, `CustomFieldDto`, `QuickAnswerDto`, `TriageMenuDto`, `SettingsDto`.
  - From Task 15. These are the only names this task uses:
    - `web/src/lib/api.ts`: `request<T>(method: string, path: string, body?: unknown): Promise<T>`. A `FormData` body is sent as-is and any other body as JSON. A 204 response resolves to `undefined`. A non-2xx response throws `ApiError extends Error` whose `message` is the server's `{ error }`.
    - `web/src/lib/api.ts`: `api` (namespace object; this task uses `api.sectors.list`, `api.tags.list`, `api.customFields.list`, `api.users.list`, `api.quickAnswers.list`, `api.settings.get`, `api.channels.list`) and `qk` (`qk.me`, `qk.sectors`, `qk.tags`, `qk.customFields`, `qk.users`, `qk.quickAnswers`, `qk.settings`, `qk.channels`).
    - `web/src/lib/auth.tsx`: `useCurrentUser(): Me`, only valid inside `RequireAuth` (the settings page is a child of the authenticated layout route).
    - `web/src/lib/ws.ts`: nothing imported. Task 15's global `applyWsEvent` writes `channel.status` into the `qk.channels` cache, so the Canais page stays live by reading that same key.
    - `web/src/App.tsx`: `export const routes: RouteObject[]`, whose `path: '/'` layout route has `children` with a `*` catch-all. The sidebar already links to `/configuracoes` (Task 15). `QueryClientProvider` is mounted in `main.tsx`.
    - The web workspace runs Vitest with `npm test -w web` and has `@testing-library/react` and `jsdom` installed.
  - REST endpoints (contract table):
    - `GET /api/sectors|tags|custom-fields|users|channels|quick-answers|settings`
    - `POST/PATCH/DELETE /api/sectors[/:id]`, plus `PATCH {position}` and `PATCH {isDefault: true}`. The server clears the previous default.
    - `POST/PATCH/DELETE /api/tags[/:id]` with `{name, emoji, color}`.
    - `POST/PATCH/DELETE /api/custom-fields[/:id]` with `{name, kind}`, or `{name}` on PATCH.
    - `POST /api/users` with `{name, email, role, signature, password, sectorIds}`. `PATCH /api/users/:id` with any subset of those fields plus `active`.
    - `POST/PATCH/DELETE /api/quick-answers[/:id]` as JSON `{name, body, visibility}`, or as multipart with the same text fields followed by `file`.
    - `GET /api/quick-answers/:id/attachment`
    - `PUT /api/settings` with the full `SettingsDto`
    - `POST /api/channels` with `{name}`
    - `POST /api/channels/:id/connect` → `{qrBase64}`. Task 14 tests return a `data:image/png;base64,…` URL. This page also accepts raw base64.
- Produces:
  - Route `/configuracoes/:section?` with these sections: `perfil`, `canais`, `atendentes`, `setores`, `etiquetas`, `campos`, `respostas-rapidas`, `triagem`, `conversas`.
  - `web/src/lib/tag-colors.ts`:
    - `TAG_COLORS: ReadonlyArray<{ name: string; label: string; hex: string }>`: the 20 colors of Umbler's `TagColor` enum. `name` is the Umbler enum value, `label` is pt-BR and `hex` is lowercase `#rrggbb`.
    - `tagColorHex(color: string): string`: accepts a stored hex value or an Umbler name, such as `'Tomato'`. It falls back to gray.
    - **Tasks 16 and 18 should render tag chips with `tagColorHex(tag.color)`.**
  - `web/src/components/settings/common.tsx`:
    - `send<T>(path, method, body?)`, a thin wrapper over Task 15's `request`
    - `useSend(...refreshKeys: QueryKey[])`, a mutation whose argument is a thunk; on success it invalidates the given `qk.*` keys
    - Reads use `useQuery({ queryKey: qk.x, queryFn: api.x.list })` directly, so settings share the cache with the rest of the app.
    - `Section`, `Loading`, `ErrorText`, and the class strings `btn`, `btnPrimary` and `field`
  - `TagForm` with `TagInput { name: string; emoji: string | null; color: string }` and `TAG_NAME_MAX = 30`.
  - `TriageOptionsEditor` with `TriageOptionInput = TriageMenuDto['options'][number]`.
  - `QuickAnswerForm` with `QuickAnswerInput { name; body; visibility: 'all' | 'owner'; file: File | null }`, plus `insertAtCursor(text, start, end, snippet): { text; caret }` and `FIXED_VARIABLES`.
  - Data conventions:
    - `tags.color` is sent as lowercase hex. The importer (Task 20) may store either an Umbler color name or hex; `tagColorHex` renders both.
    - Custom-field variables are inserted as `{{campo.<field name exactly as stored>}}`, spaces included. Task 10's `renderQuickAnswer` must look fields up by that exact name.

---

- [ ] **Step 1: Write the failing TagForm test**

Create `web/src/components/settings/TagForm.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TagForm } from './TagForm';
import { TAG_COLORS, tagColorHex } from '../../lib/tag-colors';

afterEach(cleanup);

const nameInput = () => screen.getByLabelText('Nome') as HTMLInputElement;

describe('tag colors', () => {
  it('has the 20 Umbler colors with unique hex values', () => {
    expect(TAG_COLORS).toHaveLength(20);
    expect(new Set(TAG_COLORS.map((c) => c.hex)).size).toBe(20);
  });

  it('resolves Umbler names, keeps hex and falls back to gray', () => {
    expect(tagColorHex('Tomato')).toBe('#ef4444');
    expect(tagColorHex('tomato')).toBe('#ef4444');
    expect(tagColorHex('#ABCDEF')).toBe('#abcdef');
    expect(tagColorHex('roxo-inexistente')).toBe('#6b7280');
  });
});

describe('TagForm', () => {
  it('shows the 20-color palette with the first color selected', () => {
    render(<TagForm onSubmit={vi.fn()} onCancel={vi.fn()} />);
    const swatches = screen.getAllByRole('radio');
    expect(swatches).toHaveLength(20);
    expect(swatches[0]!.getAttribute('aria-checked')).toBe('true');
    expect(swatches.filter((s) => s.getAttribute('aria-checked') === 'true')).toHaveLength(1);
  });

  it('limits the name to 30 characters and shows the counter', () => {
    render(<TagForm onSubmit={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(nameInput(), { target: { value: 'a'.repeat(35) } });
    expect(nameInput().value).toBe('a'.repeat(30));
    expect(nameInput().maxLength).toBe(30);
    screen.getByText('30/30');
  });

  it('previews the chip and submits trimmed name, emoji and the chosen color as hex', () => {
    const onSubmit = vi.fn();
    render(<TagForm onSubmit={onSubmit} onCancel={vi.fn()} />);
    fireEvent.change(nameInput(), { target: { value: '  Cliente VIP ' } });
    fireEvent.change(screen.getByLabelText('Emoji'), { target: { value: '⭐' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Verde' }));

    expect(screen.getByRole('radio', { name: 'Verde' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('tag-preview').textContent).toBe('⭐ Cliente VIP');

    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(onSubmit).toHaveBeenCalledWith({ name: 'Cliente VIP', emoji: '⭐', color: '#16a34a' });
  });

  it('sends a null emoji when the emoji field is empty', () => {
    const onSubmit = vi.fn();
    render(<TagForm onSubmit={onSubmit} onCancel={vi.fn()} />);
    fireEvent.change(nameInput(), { target: { value: 'Urgente' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(onSubmit).toHaveBeenCalledWith({ name: 'Urgente', emoji: null, color: TAG_COLORS[0]!.hex });
  });

  it('cannot save a blank name', () => {
    render(<TagForm onSubmit={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(nameInput(), { target: { value: '   ' } });
    expect((screen.getByRole('button', { name: 'Salvar' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('editing an imported tag selects its Umbler color', () => {
    render(
      <TagForm
        initial={{ id: 't1', name: 'Antigo', emoji: null, color: 'Tomato', position: 0 }}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(nameInput().value).toBe('Antigo');
    expect(screen.getByRole('radio', { name: 'Tomate' }).getAttribute('aria-checked')).toBe('true');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w web -- src/components/settings/TagForm.test.tsx`
Expected: FAIL — `Failed to resolve import "./TagForm"` (and `../../lib/tag-colors`).

- [ ] **Step 3: Write the palette and the form**

Create `web/src/lib/tag-colors.ts`:

```ts
// The 20 colors of Umbler's tag palette (TagColor enum in utalk-openapi-v1.json), in Umbler's order.
// tags.color stores the hex; tagColorHex also accepts the Umbler name so imported tags render either way.
export const TAG_COLORS = [
  { name: 'Blue', label: 'Azul', hex: '#2563eb' },
  { name: 'Skyblue', label: 'Azul-céu', hex: '#0ea5e9' },
  { name: 'Cyan', label: 'Ciano', hex: '#06b6d4' },
  { name: 'Aquamarine', label: 'Água-marinha', hex: '#14b8a6' },
  { name: 'Green', label: 'Verde', hex: '#16a34a' },
  { name: 'Kiwi', label: 'Kiwi', hex: '#65a30d' },
  { name: 'Gold', label: 'Dourado', hex: '#ca8a04' },
  { name: 'Amber', label: 'Âmbar', hex: '#d97706' },
  { name: 'Tangerine', label: 'Tangerina', hex: '#ea580c' },
  { name: 'Chocolate', label: 'Chocolate', hex: '#92400e' },
  { name: 'Salmon', label: 'Salmão', hex: '#f87171' },
  { name: 'Tomato', label: 'Tomate', hex: '#ef4444' },
  { name: 'Rose', label: 'Rosa', hex: '#e11d48' },
  { name: 'Pink', label: 'Rosa-claro', hex: '#ec4899' },
  { name: 'Magenta', label: 'Magenta', hex: '#c026d3' },
  { name: 'Violet', label: 'Violeta', hex: '#8b5cf6' },
  { name: 'Grape', label: 'Uva', hex: '#6d28d9' },
  { name: 'Gray', label: 'Cinza', hex: '#6b7280' },
  { name: 'Silver', label: 'Prata', hex: '#94a3b8' },
  { name: 'Umblerito', label: 'Azul-marinho', hex: '#1e3a8a' },
] as const;

const GRAY = '#6b7280';

export function tagColorHex(color: string): string {
  const byName = TAG_COLORS.find((c) => c.name.toLowerCase() === color.toLowerCase());
  if (byName) return byName.hex;
  return /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : GRAY;
}
```

Create `web/src/components/settings/TagForm.tsx`:

```tsx
import { useId, useState, type FormEvent } from 'react';
import type { TagDto } from '@talk/shared';
import { TAG_COLORS, tagColorHex } from '../../lib/tag-colors';

export interface TagInput {
  name: string;
  emoji: string | null;
  color: string;
}

export const TAG_NAME_MAX = 30;

export function TagForm({
  initial,
  onSubmit,
  onCancel,
  pending = false,
  error = null,
}: {
  initial?: TagDto;
  onSubmit(value: TagInput): void;
  onCancel(): void;
  pending?: boolean;
  error?: string | null;
}) {
  const id = useId();
  const [name, setName] = useState(initial?.name ?? '');
  const [emoji, setEmoji] = useState(initial?.emoji ?? '');
  const [color, setColor] = useState<string>(initial ? tagColorHex(initial.color) : TAG_COLORS[0].hex);
  const cleanName = name.trim();
  const cleanEmoji = emoji.trim();

  function submit(e: FormEvent) {
    e.preventDefault();
    if (cleanName) onSubmit({ name: cleanName, emoji: cleanEmoji || null, color });
  }

  return (
    <form onSubmit={submit} className="mb-6 space-y-4 rounded border p-4">
      <div className="flex gap-3">
        <div className="w-20">
          <label htmlFor={`${id}-emoji`} className="block text-sm font-medium">
            Emoji
          </label>
          {/* ponytail: native input, the OS emoji picker (Win + . / Ctrl+Cmd+Space) fills it; no picker library */}
          <input
            id={`${id}-emoji`}
            value={emoji}
            onChange={(e) => setEmoji(e.target.value)}
            placeholder="⭐"
            className="mt-1 w-full rounded border px-2 py-1.5 text-center"
          />
        </div>
        <div className="flex-1">
          <label htmlFor={`${id}-name`} className="block text-sm font-medium">
            Nome
          </label>
          <input
            id={`${id}-name`}
            value={name}
            maxLength={TAG_NAME_MAX}
            onChange={(e) => setName(e.target.value.slice(0, TAG_NAME_MAX))}
            className="mt-1 w-full rounded border px-2 py-1.5 text-sm"
          />
          <p className="mt-1 text-right text-xs text-gray-500">{`${name.length}/${TAG_NAME_MAX}`}</p>
        </div>
      </div>

      <div>
        <span id={`${id}-colors`} className="block text-sm font-medium">
          Cor de fundo
        </span>
        <div role="radiogroup" aria-labelledby={`${id}-colors`} className="mt-2 grid w-fit grid-cols-10 gap-2">
          {TAG_COLORS.map((c) => (
            <button
              key={c.name}
              type="button"
              role="radio"
              aria-checked={color === c.hex}
              aria-label={c.label}
              title={c.label}
              onClick={() => setColor(c.hex)}
              className={`h-7 w-7 rounded-full ${color === c.hex ? 'ring-2 ring-gray-900 ring-offset-2' : ''}`}
              style={{ backgroundColor: c.hex }}
            />
          ))}
        </div>
      </div>

      <div>
        <span className="block text-sm font-medium">Pré-visualização</span>
        <span
          data-testid="tag-preview"
          className="mt-2 inline-block rounded-full px-3 py-1 text-sm font-medium text-white"
          style={{ backgroundColor: color }}
        >
          {`${cleanEmoji ? `${cleanEmoji} ` : ''}${cleanName || 'Nome da etiqueta'}`}
        </span>
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded border px-3 py-1.5 text-sm hover:bg-gray-50">
          Cancelar
        </button>
        <button
          type="submit"
          disabled={!cleanName || pending}
          className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
        >
          Salvar
        </button>
      </div>
    </form>
  );
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test -w web -- src/components/settings/TagForm.test.tsx`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/tag-colors.ts web/src/components/settings/TagForm.tsx web/src/components/settings/TagForm.test.tsx
git commit -m "feat(web): tag form with Umbler 20-color palette, emoji and 30-char name

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Write the failing triage options editor test**

Create `web/src/components/settings/TriageOptionsEditor.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import type { SectorDto } from '@talk/shared';
import { TriageOptionsEditor, type TriageOptionInput } from './TriageOptionsEditor';

const sectors: SectorDto[] = [
  { id: 's-fin', name: 'Financeiro', position: 0, isDefault: false },
  { id: 's-jur', name: 'Jurídico', position: 1, isDefault: false },
];

let last: TriageOptionInput[] = [];

function Harness({ initial }: { initial: TriageOptionInput[] }) {
  const [options, setOptions] = useState(initial);
  return (
    <TriageOptionsEditor
      options={options}
      sectors={sectors}
      onChange={(next) => {
        last = next;
        setOptions(next);
      }}
    />
  );
}

afterEach(() => {
  cleanup();
  last = [];
});

describe('TriageOptionsEditor', () => {
  it('starts empty and adds options numbered 1, 2, … with no sector chosen', () => {
    render(<Harness initial={[]} />);
    screen.getByText('Nenhuma opção. Clique em “Adicionar opção”.');

    fireEvent.click(screen.getByRole('button', { name: 'Adicionar opção' }));
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar opção' }));

    expect(last).toEqual([
      { key: '1', label: '', sectorId: '' },
      { key: '2', label: '', sectorId: '' },
    ]);
  });

  it('numbers a new option after the highest existing number', () => {
    render(<Harness initial={[{ key: '5', label: 'Outros', sectorId: 's-fin' }]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar opção' }));
    expect(last.map((o) => o.key)).toEqual(['5', '6']);
  });

  it('removes only the chosen row', () => {
    render(
      <Harness
        initial={[
          { key: '1', label: 'Boletos', sectorId: 's-fin' },
          { key: '2', label: 'Processos', sectorId: 's-jur' },
          { key: '3', label: 'Outros', sectorId: 's-fin' },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remover opção 2' }));

    expect(last.map((o) => o.label)).toEqual(['Boletos', 'Outros']);
    expect(screen.getAllByRole('button', { name: /^Remover opção/ })).toHaveLength(2);
  });

  it('choosing a sector fills an empty label with the sector name but keeps a typed one', () => {
    render(
      <Harness
        initial={[
          { key: '1', label: '', sectorId: '' },
          { key: '2', label: 'Andamento do processo', sectorId: '' },
        ]}
      />,
    );
    fireEvent.change(screen.getByLabelText('Setor da opção 1'), { target: { value: 's-jur' } });
    fireEvent.change(screen.getByLabelText('Setor da opção 2'), { target: { value: 's-jur' } });

    expect(last).toEqual([
      { key: '1', label: 'Jurídico', sectorId: 's-jur' },
      { key: '2', label: 'Andamento do processo', sectorId: 's-jur' },
    ]);
  });

  it('edits number and text of a row', () => {
    render(<Harness initial={[{ key: '1', label: 'Boletos', sectorId: 's-fin' }]} />);
    fireEvent.change(screen.getByLabelText('Número da opção 1'), { target: { value: ' 9 ' } });
    fireEvent.change(screen.getByLabelText('Texto da opção 1'), { target: { value: '2ª via de boleto' } });
    expect(last).toEqual([{ key: '9', label: '2ª via de boleto', sectorId: 's-fin' }]);
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `npm test -w web -- src/components/settings/TriageOptionsEditor.test.tsx`
Expected: FAIL — `Failed to resolve import "./TriageOptionsEditor"`.

- [ ] **Step 8: Write the editor**

Create `web/src/components/settings/TriageOptionsEditor.tsx`:

```tsx
import { TrashIcon } from '@phosphor-icons/react';
import type { SectorDto, TriageMenuDto } from '@talk/shared';

export type TriageOptionInput = TriageMenuDto['options'][number];

const cell = 'w-full rounded border px-2 py-1 text-sm';

export function TriageOptionsEditor({
  options,
  sectors,
  onChange,
}: {
  options: TriageOptionInput[];
  sectors: SectorDto[];
  onChange(next: TriageOptionInput[]): void;
}) {
  const update = (i: number, patch: Partial<TriageOptionInput>) =>
    onChange(options.map((o, j) => (j === i ? { ...o, ...patch } : o)));

  function add() {
    const next = Math.max(0, ...options.map((o) => Number.parseInt(o.key, 10) || 0)) + 1;
    // no sector preselected: the admin must choose, so a contact is never routed to a sector by accident
    onChange([...options, { key: String(next), label: '', sectorId: '' }]);
  }

  function pickSector(i: number, sectorId: string) {
    const current = options[i]!;
    const sectorName = sectors.find((s) => s.id === sectorId)?.name ?? '';
    update(i, { sectorId, label: current.label.trim() ? current.label : sectorName });
  }

  return (
    <div>
      {options.length === 0 ? (
        <p className="text-sm text-gray-500">Nenhuma opção. Clique em “Adicionar opção”.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500">
              <th className="w-16 pb-1 font-medium">Nº</th>
              <th className="pb-1 font-medium">Texto da opção</th>
              <th className="w-48 pb-1 font-medium">Setor</th>
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {options.map((o, i) => (
              <tr key={i}>
                <td className="py-1 pr-2">
                  <input
                    aria-label={`Número da opção ${i + 1}`}
                    value={o.key}
                    maxLength={3}
                    onChange={(e) => update(i, { key: e.target.value.trim() })}
                    className={cell}
                  />
                </td>
                <td className="py-1 pr-2">
                  <input
                    aria-label={`Texto da opção ${i + 1}`}
                    value={o.label}
                    maxLength={60}
                    onChange={(e) => update(i, { label: e.target.value })}
                    className={cell}
                  />
                </td>
                <td className="py-1 pr-2">
                  <select
                    aria-label={`Setor da opção ${i + 1}`}
                    value={o.sectorId}
                    onChange={(e) => pickSector(i, e.target.value)}
                    className={cell}
                  >
                    <option value="" disabled>
                      Escolha o setor…
                    </option>
                    {sectors.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="py-1">
                  <button
                    type="button"
                    aria-label={`Remover opção ${i + 1}`}
                    title="Remover"
                    onClick={() => onChange(options.filter((_, j) => j !== i))}
                    className="rounded p-1 text-gray-500 hover:bg-red-50 hover:text-red-600"
                  >
                    <TrashIcon size={16} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <button type="button" onClick={add} className="mt-2 rounded border px-3 py-1.5 text-sm hover:bg-gray-50">
        Adicionar opção
      </button>
    </div>
  );
}
```

- [ ] **Step 9: Run it to verify it passes**

Run: `npm test -w web -- src/components/settings/TriageOptionsEditor.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 10: Commit**

```bash
git add web/src/components/settings/TriageOptionsEditor.tsx web/src/components/settings/TriageOptionsEditor.test.tsx
git commit -m "feat(web): triage options editor (number, text, sector; add/remove)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 11: Write the failing quick answer form test**

Create `web/src/components/settings/QuickAnswerForm.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { CustomFieldDto } from '@talk/shared';
import { FIXED_VARIABLES, QuickAnswerForm, insertAtCursor } from './QuickAnswerForm';

afterEach(cleanup);

const fields: CustomFieldDto[] = [
  { id: 'f1', name: 'CPF', kind: 'cpf', position: 0 },
  { id: 'f2', name: 'Número do processo', kind: 'text', position: 1 },
];

const bodyBox = () => screen.getByLabelText('Mensagem') as HTMLTextAreaElement;

describe('insertAtCursor', () => {
  it('inserts at a collapsed cursor and moves the caret after the snippet', () => {
    expect(insertAtCursor('Olá , tudo bem?', 4, 4, '{{contato.nome}}')).toEqual({
      text: 'Olá {{contato.nome}}, tudo bem?',
      caret: 20,
    });
  });

  it('replaces the selected range', () => {
    expect(insertAtCursor('Prezado XXX', 8, 11, '{{contato.nome}}')).toEqual({
      text: 'Prezado {{contato.nome}}',
      caret: 24,
    });
  });
});

describe('QuickAnswerForm', () => {
  it('offers the 7 named variables of §5.7 plus one per custom field', () => {
    render(<QuickAnswerForm isAdmin fields={fields} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(FIXED_VARIABLES.map(([v]) => v)).toEqual([
      'atendente.nome',
      'atendente.primeiro_nome',
      'atendente.email',
      'contato.nome',
      'contato.primeiro_nome',
      'contato.telefone',
      'contato.email',
    ]);
    for (const [, label] of FIXED_VARIABLES) screen.getByRole('button', { name: label });
    screen.getByRole('button', { name: 'Campo: CPF' });
    screen.getByRole('button', { name: 'Campo: Número do processo' });
  });

  it('inserts the variable at the cursor and keeps typing position for the next one', () => {
    render(<QuickAnswerForm isAdmin fields={fields} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(bodyBox(), { target: { value: 'Olá , tudo bem?' } });
    bodyBox().setSelectionRange(4, 4);

    fireEvent.click(screen.getByRole('button', { name: 'Nome do contato' }));
    expect(bodyBox().value).toBe('Olá {{contato.nome}}, tudo bem?');
    expect(bodyBox().selectionStart).toBe(20);

    fireEvent.click(screen.getByRole('button', { name: 'Primeiro nome do atendente' }));
    expect(bodyBox().value).toBe('Olá {{contato.nome}}{{atendente.primeiro_nome}}, tudo bem?');
  });

  it('replaces a selection with a custom field variable', () => {
    render(<QuickAnswerForm isAdmin fields={fields} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(bodyBox(), { target: { value: 'Seu processo: XXX' } });
    bodyBox().setSelectionRange(14, 17);
    fireEvent.click(screen.getByRole('button', { name: 'Campo: Número do processo' }));
    expect(bodyBox().value).toBe('Seu processo: {{campo.Número do processo}}');
  });

  it('agents cannot choose "Para todos" and submit with owner visibility', () => {
    const onSubmit = vi.fn();
    render(<QuickAnswerForm isAdmin={false} fields={[]} onSubmit={onSubmit} onCancel={vi.fn()} />);
    expect(screen.queryByRole('radio', { name: 'Para todos' })).toBeNull();

    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: ' Boas-vindas ' } });
    fireEvent.change(bodyBox(), { target: { value: 'Olá {{contato.primeiro_nome}}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

    expect(onSubmit).toHaveBeenCalledWith({
      name: 'Boas-vindas',
      body: 'Olá {{contato.primeiro_nome}}',
      visibility: 'owner',
      file: null,
    });
  });

  it('admins default to "Para todos" and can switch to "Apenas para mim"', () => {
    const onSubmit = vi.fn();
    render(<QuickAnswerForm isAdmin fields={[]} onSubmit={onSubmit} onCancel={vi.fn()} />);
    expect((screen.getByRole('radio', { name: 'Para todos' }) as HTMLInputElement).checked).toBe(true);

    fireEvent.click(screen.getByRole('radio', { name: 'Apenas para mim' }));
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Pix' } });
    fireEvent.change(bodyBox(), { target: { value: 'Chave Pix: …' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ visibility: 'owner' }));
  });

  it('cannot save without name and message', () => {
    render(<QuickAnswerForm isAdmin fields={[]} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Só nome' } });
    expect((screen.getByRole('button', { name: 'Salvar' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
```

- [ ] **Step 12: Run it to verify it fails**

Run: `npm test -w web -- src/components/settings/QuickAnswerForm.test.tsx`
Expected: FAIL — `Failed to resolve import "./QuickAnswerForm"`.

- [ ] **Step 13: Write the form**

Create `web/src/components/settings/QuickAnswerForm.tsx`:

```tsx
import { useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import type { CustomFieldDto, QuickAnswerDto } from '@talk/shared';

export interface QuickAnswerInput {
  name: string;
  body: string;
  visibility: 'all' | 'owner';
  file: File | null;
}

// Named variables of spec §5.7, in the order they appear as buttons.
export const FIXED_VARIABLES = [
  ['atendente.nome', 'Nome do atendente'],
  ['atendente.primeiro_nome', 'Primeiro nome do atendente'],
  ['atendente.email', 'E-mail do atendente'],
  ['contato.nome', 'Nome do contato'],
  ['contato.primeiro_nome', 'Primeiro nome do contato'],
  ['contato.telefone', 'Telefone do contato'],
  ['contato.email', 'E-mail do contato'],
] as const;

export function insertAtCursor(text: string, start: number, end: number, snippet: string): { text: string; caret: number } {
  return { text: text.slice(0, start) + snippet + text.slice(end), caret: start + snippet.length };
}

const field = 'mt-1 w-full rounded border px-2 py-1.5 text-sm';

export function QuickAnswerForm({
  initial,
  isAdmin,
  fields,
  onSubmit,
  onCancel,
  pending = false,
  error = null,
}: {
  initial?: QuickAnswerDto;
  isAdmin: boolean;
  fields: CustomFieldDto[];
  onSubmit(value: QuickAnswerInput): void;
  onCancel(): void;
  pending?: boolean;
  error?: string | null;
}) {
  const id = useId();
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const caret = useRef<number | null>(null);
  const [name, setName] = useState(initial?.name ?? '');
  const [body, setBody] = useState(initial?.body ?? '');
  // only admins may publish to everyone (contract: "user (own) / admin (visibility all)")
  const [visibility, setVisibility] = useState<'all' | 'owner'>(isAdmin ? (initial?.visibility ?? 'all') : 'owner');
  const [file, setFile] = useState<File | null>(null);

  // after inserting a variable, put the caret right after it so typing continues there
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (caret.current === null || !el) return;
    el.focus();
    el.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  });

  function insert(variable: string) {
    const el = bodyRef.current;
    if (!el) return;
    const result = insertAtCursor(el.value, el.selectionStart, el.selectionEnd, `{{${variable}}}`);
    caret.current = result.caret;
    setBody(result.text);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || !body.trim()) return;
    onSubmit({ name: name.trim(), body: body.trim(), visibility, file });
  }

  const variables: Array<readonly [string, string]> = [
    ...FIXED_VARIABLES,
    ...fields.map((f) => [`campo.${f.name}`, `Campo: ${f.name}`] as const),
  ];

  return (
    <form onSubmit={submit} className="mb-6 space-y-4 rounded border p-4">
      <div>
        <label htmlFor={`${id}-name`} className="block text-sm font-medium">
          Nome
        </label>
        <input id={`${id}-name`} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} className={field} />
      </div>

      {isAdmin && (
        <fieldset>
          <legend className="text-sm font-medium">Visibilidade</legend>
          <div className="mt-1 flex gap-4 text-sm">
            <label className="flex items-center gap-1">
              <input type="radio" name={`${id}-vis`} checked={visibility === 'all'} onChange={() => setVisibility('all')} />
              Para todos
            </label>
            <label className="flex items-center gap-1">
              <input type="radio" name={`${id}-vis`} checked={visibility === 'owner'} onChange={() => setVisibility('owner')} />
              Apenas para mim
            </label>
          </div>
        </fieldset>
      )}

      <div>
        <label htmlFor={`${id}-body`} className="block text-sm font-medium">
          Mensagem
        </label>
        <textarea
          id={`${id}-body`}
          ref={bodyRef}
          rows={6}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          className={field}
        />
        <div className="mt-2">
          <p className="text-xs text-gray-500">
            Inserir variável (trocada pelos dados do atendente e do contato quando a resposta é escolhida com / na conversa):
          </p>
          <div className="mt-1 flex flex-wrap gap-1">
            {variables.map(([variable, label]) => (
              <button
                key={variable}
                type="button"
                title={`{{${variable}}}`}
                // keep the textarea focused so its selection is not lost
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => insert(variable)}
                className="rounded-full border px-2 py-0.5 text-xs hover:bg-gray-50"
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div>
        <label htmlFor={`${id}-file`} className="block text-sm font-medium">
          Anexo (opcional)
        </label>
        {initial?.hasAttachment && (
          <p className="text-xs text-gray-500">
            Esta resposta já tem um anexo:{' '}
            <a href={`/api/quick-answers/${initial.id}/attachment`} target="_blank" rel="noreferrer" className="text-blue-600 underline">
              abrir
            </a>
            . Escolha outro arquivo para substituir.
          </p>
        )}
        <input id={`${id}-file`} type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="mt-1 text-sm" />
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded border px-3 py-1.5 text-sm hover:bg-gray-50">
          Cancelar
        </button>
        <button
          type="submit"
          disabled={!name.trim() || !body.trim() || pending}
          className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
        >
          Salvar
        </button>
      </div>
    </form>
  );
}
```

- [ ] **Step 14: Run it to verify it passes**

Run: `npm test -w web -- src/components/settings/QuickAnswerForm.test.tsx`
Expected: PASS (8 tests).

- [ ] **Step 15: Commit**

```bash
git add web/src/components/settings/QuickAnswerForm.tsx web/src/components/settings/QuickAnswerForm.test.tsx
git commit -m "feat(web): quick answer form with named variable insertion at cursor

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 16: Write the shared settings helpers**

Create `web/src/components/settings/common.tsx`:

```tsx
import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { request } from '../../lib/api';

export type Method = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

// Task 15's request() with the path first, which reads better in the settings screens.
export function send<T = unknown>(path: string, method: Method, body?: unknown): Promise<T> {
  return request<T>(method, path, body);
}

// Runs the given thunk (one or several requests) and then refetches the listed qk.* keys.
export function useSend(...refresh: QueryKey[]) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onSuccess: () => Promise.all(refresh.map((queryKey) => qc.invalidateQueries({ queryKey }))),
  });
}

export const btn = 'rounded border px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-50';
export const btnPrimary = 'rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50';
export const field = 'mt-1 w-full rounded border px-2 py-1.5 text-sm';

export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="max-w-3xl">
      <header className="mb-4 flex items-center justify-between gap-4">
        <h1 className="text-xl font-semibold">{title}</h1>
        {action}
      </header>
      {children}
    </section>
  );
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p role="alert" className="my-2 text-sm text-red-600">
      {error instanceof Error ? error.message : 'Ocorreu um erro'}
    </p>
  );
}

export function Loading({ error }: { error: unknown }) {
  return error ? <ErrorText error={error} /> : <p className="text-sm text-gray-500">Carregando…</p>;
}
```

- [ ] **Step 17: Write the settings layout and the Perfil page**

Create `web/src/pages/settings/SettingsPage.tsx`:

```tsx
import type { ComponentType } from 'react';
import { NavLink, Navigate, useParams } from 'react-router';
import { useCurrentUser } from '../../lib/auth';
import { ProfileSettings } from './ProfileSettings';
import { ChannelsSettings } from './ChannelsSettings';
import { UsersSettings } from './UsersSettings';
import { SectorsSettings } from './SectorsSettings';
import { TagsSettings } from './TagsSettings';
import { CustomFieldsSettings } from './CustomFieldsSettings';
import { QuickAnswersSettings } from './QuickAnswersSettings';
import { TriageSettings } from './TriageSettings';
import { ChatSettings } from './ChatSettings';

const SECTIONS: Array<{ path: string; label: string; adminOnly: boolean; page: ComponentType }> = [
  { path: 'perfil', label: 'Perfil', adminOnly: false, page: ProfileSettings },
  { path: 'canais', label: 'Canais', adminOnly: true, page: ChannelsSettings },
  { path: 'atendentes', label: 'Atendentes', adminOnly: true, page: UsersSettings },
  { path: 'setores', label: 'Setores', adminOnly: true, page: SectorsSettings },
  { path: 'etiquetas', label: 'Etiquetas', adminOnly: true, page: TagsSettings },
  { path: 'campos', label: 'Campos personalizados', adminOnly: true, page: CustomFieldsSettings },
  { path: 'respostas-rapidas', label: 'Respostas rápidas', adminOnly: false, page: QuickAnswersSettings },
  { path: 'triagem', label: 'Triagem', adminOnly: true, page: TriageSettings },
  { path: 'conversas', label: 'Conversas', adminOnly: true, page: ChatSettings },
];

export function SettingsPage() {
  const me = useCurrentUser();
  const { section } = useParams();
  const visible = SECTIONS.filter((s) => !s.adminOnly || me.role === 'admin');
  const current = visible.find((s) => s.path === section);
  // unknown section, or an admin-only section opened by an agent → Perfil (the server answers 403 anyway)
  if (!current) return <Navigate to="/configuracoes/perfil" replace />;
  const Page = current.page;

  return (
    <div className="flex h-full min-h-0">
      <nav aria-label="Configurações" className="w-56 shrink-0 overflow-y-auto border-r p-3">
        <h2 className="mb-2 px-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Configurações</h2>
        <ul className="space-y-1">
          {visible.map((s) => (
            <li key={s.path}>
              <NavLink
                to={`/configuracoes/${s.path}`}
                className={({ isActive }) =>
                  `block rounded px-2 py-1.5 text-sm ${isActive ? 'bg-blue-50 font-medium text-blue-700' : 'hover:bg-gray-50'}`
                }
              >
                {s.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <main className="min-w-0 flex-1 overflow-y-auto p-6">
        <Page />
      </main>
    </div>
  );
}
```

Create `web/src/pages/settings/ProfileSettings.tsx`:

```tsx
import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Me } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { useCurrentUser } from '../../lib/auth';
import { ErrorText, Section, btnPrimary, field, send, useSend } from '../../components/settings/common';

export function ProfileSettings() {
  const me = useCurrentUser();
  const sectors = useQuery({ queryKey: qk.sectors, queryFn: api.sectors.list });
  const sectorNames =
    (sectors.data ?? [])
      .filter((s) => me.sectorIds.includes(s.id))
      .map((s) => s.name)
      .join(', ') || '—';

  return (
    <Section title="Perfil">
      <dl className="mb-6 grid grid-cols-[10rem_1fr] gap-y-2 text-sm">
        <dt className="text-gray-500">E-mail</dt>
        <dd>{me.email}</dd>
        <dt className="text-gray-500">Papel</dt>
        <dd>{me.role === 'admin' ? 'Administrador' : 'Atendente'}</dd>
        <dt className="text-gray-500">Setores</dt>
        <dd>{sectorNames}</dd>
        {me.role !== 'admin' && (
          <>
            <dt className="text-gray-500">Nome</dt>
            <dd>{me.name}</dd>
            <dt className="text-gray-500">Assinatura</dt>
            <dd>{me.signature || `Setor da conversa - ${me.name}`}</dd>
          </>
        )}
      </dl>
      {me.role === 'admin' ? (
        <ProfileForm me={me} />
      ) : (
        // ponytail: no self-service route in the REST contract; agents ask an admin (known limitation)
        <p className="text-sm text-gray-500">Para alterar nome, assinatura ou senha, peça a um administrador.</p>
      )}
    </Section>
  );
}

function ProfileForm({ me }: { me: Me }) {
  const save = useSend(qk.users, qk.me);
  const [name, setName] = useState(me.name);
  const [signature, setSignature] = useState(me.signature ?? '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const mismatch = password !== confirm;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (mismatch || !name.trim()) return;
    const body = { name: name.trim(), signature: signature.trim() || null, ...(password ? { password } : {}) };
    save.mutate(() => send(`/api/users/${me.id}`, 'PATCH', body), {
      // a new password ends every session of the user (§6), this one included
      onSuccess: () => {
        if (password) window.location.assign('/login');
      },
    });
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <label className="block text-sm font-medium">
        Nome
        <input value={name} onChange={(e) => setName(e.target.value)} className={field} />
      </label>
      <label className="block text-sm font-medium">
        Assinatura
        <input value={signature} maxLength={60} onChange={(e) => setSignature(e.target.value)} className={field} />
        <span className="mt-1 block text-xs font-normal text-gray-500">
          Prévia no WhatsApp: <b>*{signature.trim() || `Setor da conversa - ${name.trim()}`}:*</b>. Se ficar vazia, usa “Setor - Nome”.
        </span>
      </label>
      <fieldset className="space-y-2 rounded border p-3">
        <legend className="px-1 text-sm font-medium">Trocar senha (opcional)</legend>
        <label className="block text-sm">
          Nova senha
          <input type="password" autoComplete="new-password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} className={field} />
        </label>
        <label className="block text-sm">
          Repita a nova senha
          <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className={field} />
        </label>
        {password && mismatch && <p className="text-sm text-red-600">As senhas não conferem.</p>}
        <p className="text-xs text-gray-500">Ao trocar a senha, você sai de todos os aparelhos e entra de novo.</p>
      </fieldset>
      <ErrorText error={save.error} />
      {save.isSuccess && !password && <p className="text-sm text-green-700">Perfil salvo.</p>}
      <button type="submit" disabled={save.isPending || mismatch || !name.trim()} className={btnPrimary}>
        Salvar
      </button>
    </form>
  );
}
```

- [ ] **Step 18: Write the Canais page**

Create `web/src/pages/settings/ChannelsSettings.tsx`:

```tsx
import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { ChannelDto } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { ErrorText, Loading, Section, btn, btnPrimary, send, useSend } from '../../components/settings/common';

const STATUS: Record<ChannelDto['status'], { label: string; className: string }> = {
  connected: { label: 'Conectado', className: 'bg-green-100 text-green-800' },
  connecting: { label: 'Conectando', className: 'bg-amber-100 text-amber-800' },
  disconnected: { label: 'Desconectado', className: 'bg-red-100 text-red-800' },
};

const asImageSrc = (qr: string) => (qr.startsWith('data:') ? qr : `data:image/png;base64,${qr}`);

function withQr(current: Record<string, string>, channelId: string, qr: string | null) {
  const next = { ...current };
  if (qr) next[channelId] = qr;
  else delete next[channelId];
  return next;
}

export function ChannelsSettings() {
  // Task 15's applyWsEvent writes every channel.status into qk.channels, so this list (and the pill) is live
  const channels = useQuery({ queryKey: qk.channels, queryFn: api.channels.list });
  const create = useSend(qk.channels);
  const [name, setName] = useState('');
  const [qr, setQr] = useState<Record<string, string>>({});
  const connect = useMutation({
    mutationFn: (channelId: string) => api.channels.connect(channelId),
    // null QR = Evolution already has a session; the status arrives through channel.status
    onSuccess: ({ qrBase64 }, channelId) => setQr((cur) => withQr(cur, channelId, qrBase64)),
  });

  // channels showing a QR that are not connected yet (a stable string, so the interval is not reset on every render)
  const waiting = Object.keys(qr)
    .filter((id) => channels.data?.find((c) => c.id === id)?.status !== 'connected')
    .join(',');
  const { mutate: refreshQr } = connect;

  // ponytail: refreshes the QR by re-calling connect every 20s; push qrcode.updated over WS if this ever feels slow
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => waiting.split(',').forEach((id) => refreshQr(id)), 20_000);
    return () => clearInterval(t);
  }, [waiting, refreshQr]);

  if (!channels.data) return <Loading error={channels.error} />;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    create.mutate(() => send('/api/channels', 'POST', { name: name.trim() }), { onSuccess: () => setName('') });
  }

  return (
    <Section title="Canais">
      <form onSubmit={submit} className="mb-6 flex gap-2">
        <input
          aria-label="Nome do novo canal"
          placeholder="Nome do canal (ex.: WhatsApp do escritório)"
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          className="flex-1 rounded border px-2 py-1.5 text-sm"
        />
        <button type="submit" disabled={!name.trim() || create.isPending} className={btnPrimary}>
          Novo canal
        </button>
      </form>
      <ErrorText error={create.error} />
      <ErrorText error={connect.error} />

      {channels.data.length === 0 && <p className="text-sm text-gray-500">Nenhum canal cadastrado.</p>}
      <ul className="space-y-3">
        {channels.data.map((c) => {
          const code = qr[c.id];
          return (
            <li key={c.id} className="rounded border p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="font-medium">{c.name}</p>
                  <p className="text-sm text-gray-500">{c.phone ? `+${c.phone}` : 'Nenhum número conectado'}</p>
                </div>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS[c.status].className}`}>
                  {STATUS[c.status].label}
                </span>
              </div>
              {c.status !== 'connected' && (
                <button
                  type="button"
                  disabled={connect.isPending}
                  onClick={() => connect.mutate(c.id)}
                  className={`${btn} mt-3`}
                >
                  Gerar novo QR / Reconectar
                </button>
              )}
              {code && c.status !== 'connected' && (
                <div className="mt-4 flex flex-wrap gap-4">
                  <img src={asImageSrc(code)} alt={`QR Code do canal ${c.name}`} className="h-64 w-64 rounded border bg-white p-2" />
                  <ol className="max-w-xs list-decimal space-y-1 pl-5 text-sm">
                    <li>Abra o WhatsApp no celular do escritório.</li>
                    <li>Toque em Mais opções › Aparelhos conectados › Conectar um aparelho.</li>
                    <li>Aponte a câmera para este código.</li>
                    <li>O código se renova sozinho a cada 20 segundos. Mantenha esta tela aberta até aparecer “Conectado”.</li>
                  </ol>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
```

- [ ] **Step 19: Write the Atendentes page**

Create `web/src/pages/settings/UsersSettings.tsx`:

```tsx
import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Role, SectorDto, UserDto } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { useCurrentUser } from '../../lib/auth';
import { ErrorText, Loading, Section, btn, btnPrimary, field, send, useSend } from '../../components/settings/common';

interface UserInput {
  name: string;
  email: string;
  role: Role;
  signature: string;
  password: string;
  sectorIds: string[];
}

export function UsersSettings() {
  const me = useCurrentUser();
  const users = useQuery({ queryKey: qk.users, queryFn: api.users.list });
  const sectors = useQuery({ queryKey: qk.sectors, queryFn: api.sectors.list });
  const save = useSend(qk.users);
  const [editing, setEditing] = useState<UserDto | 'new' | null>(null);

  if (!users.data || !sectors.data) return <Loading error={users.error ?? sectors.error} />;
  const sectorList = [...sectors.data].sort((a, b) => a.position - b.position);
  const sectorName = new Map(sectorList.map((s) => [s.id, s.name]));
  const target = editing;

  function open(value: UserDto | 'new') {
    save.reset();
    setEditing(value);
  }

  function submit(v: UserInput) {
    const body = {
      name: v.name.trim(),
      email: v.email.trim().toLowerCase(),
      role: v.role,
      signature: v.signature.trim() || null,
      sectorIds: v.sectorIds,
      ...(v.password ? { password: v.password } : {}),
    };
    save.mutate(
      () => (target && target !== 'new' ? send(`/api/users/${target.id}`, 'PATCH', body) : send('/api/users', 'POST', body)),
      { onSuccess: () => setEditing(null) },
    );
  }

  function toggleActive(u: UserDto) {
    if (u.active && !window.confirm(`Desativar ${u.name}? A pessoa perde o acesso na hora.`)) return;
    save.mutate(() => send(`/api/users/${u.id}`, 'PATCH', { active: !u.active }));
  }

  return (
    <Section
      title="Atendentes"
      action={
        <button type="button" onClick={() => open('new')} className={btnPrimary}>
          Novo atendente
        </button>
      }
    >
      {target && (
        <UserForm
          key={target === 'new' ? 'new' : target.id}
          initial={target === 'new' ? undefined : target}
          sectors={sectorList}
          pending={save.isPending}
          error={save.error}
          onSubmit={submit}
          onCancel={() => setEditing(null)}
        />
      )}
      {!target && <ErrorText error={save.error} />}

      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-gray-500">
            <th className="py-2 font-medium">Nome</th>
            <th className="py-2 font-medium">E-mail</th>
            <th className="py-2 font-medium">Papel</th>
            <th className="py-2 font-medium">Setores</th>
            <th className="py-2 font-medium">Situação</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {users.data.map((u) => (
            <tr key={u.id} className={`border-b ${u.active ? '' : 'text-gray-400'}`}>
              <td className="py-2">{u.name}</td>
              <td className="py-2">{u.email}</td>
              <td className="py-2">{u.role === 'admin' ? 'Administrador' : 'Atendente'}</td>
              <td className="py-2">{u.sectorIds.map((id) => sectorName.get(id)).filter(Boolean).join(', ') || '—'}</td>
              <td className="py-2">{u.active ? 'Ativo' : 'Desativado'}</td>
              <td className="space-x-2 py-2 text-right whitespace-nowrap">
                <button type="button" onClick={() => open(u)} className={btn}>
                  Editar
                </button>
                {u.id !== me.id && (
                  <button type="button" onClick={() => toggleActive(u)} disabled={save.isPending} className={btn}>
                    {u.active ? 'Desativar' : 'Reativar'}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

function UserForm({
  initial,
  sectors,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  initial?: UserDto;
  sectors: SectorDto[];
  pending: boolean;
  error: unknown;
  onSubmit(v: UserInput): void;
  onCancel(): void;
}) {
  const [v, setV] = useState<UserInput>({
    name: initial?.name ?? '',
    email: initial?.email ?? '',
    role: initial?.role ?? 'agent',
    signature: initial?.signature ?? '',
    password: '',
    sectorIds: initial?.sectorIds ?? [],
  });
  const set = (patch: Partial<UserInput>) => setV((cur) => ({ ...cur, ...patch }));
  const toggleSector = (id: string) =>
    set({ sectorIds: v.sectorIds.includes(id) ? v.sectorIds.filter((x) => x !== id) : [...v.sectorIds, id] });

  function submit(e: FormEvent) {
    e.preventDefault();
    onSubmit(v);
  }

  return (
    <form onSubmit={submit} className="mb-6 grid grid-cols-2 gap-4 rounded border p-4">
      <label className="block text-sm font-medium">
        Nome
        <input required value={v.name} onChange={(e) => set({ name: e.target.value })} className={field} />
      </label>
      <label className="block text-sm font-medium">
        E-mail
        <input required type="email" value={v.email} onChange={(e) => set({ email: e.target.value })} className={field} />
      </label>
      <label className="block text-sm font-medium">
        Papel
        <select value={v.role} onChange={(e) => set({ role: e.target.value as Role })} className={field}>
          <option value="agent">Atendente</option>
          <option value="admin">Administrador</option>
        </select>
      </label>
      <label className="block text-sm font-medium">
        {initial ? 'Nova senha (deixe em branco para manter)' : 'Senha'}
        <input
          type="password"
          autoComplete="new-password"
          required={!initial}
          minLength={8}
          value={v.password}
          onChange={(e) => set({ password: e.target.value })}
          className={field}
        />
      </label>
      <label className="col-span-2 block text-sm font-medium">
        Assinatura (opcional)
        <input value={v.signature} maxLength={60} onChange={(e) => set({ signature: e.target.value })} className={field} />
        <span className="mt-1 block text-xs font-normal text-gray-500">Se ficar vazia, as mensagens saem como “Setor - Nome”.</span>
      </label>
      <fieldset className="col-span-2">
        <legend className="text-sm font-medium">Setores</legend>
        <div className="mt-1 flex flex-wrap gap-4 text-sm">
          {sectors.map((s) => (
            <label key={s.id} className="flex items-center gap-1">
              <input type="checkbox" checked={v.sectorIds.includes(s.id)} onChange={() => toggleSector(s.id)} />
              {s.name}
            </label>
          ))}
        </div>
        <p className="mt-1 text-xs text-gray-500">
          Administradores veem todas as conversas. Atendentes veem as dos seus setores e as que são deles.
        </p>
      </fieldset>
      <div className="col-span-2">
        <ErrorText error={error} />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} className={btn}>
            Cancelar
          </button>
          <button type="submit" disabled={pending} className={btnPrimary}>
            Salvar
          </button>
        </div>
      </div>
    </form>
  );
}
```

- [ ] **Step 20: Write the Setores, Etiquetas and Campos personalizados pages**

Create `web/src/pages/settings/SectorsSettings.tsx`:

```tsx
import { useState, type FormEvent } from 'react';
import { ArrowDownIcon, ArrowUpIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import type { SectorDto } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { ErrorText, Loading, Section, btn, btnPrimary, send, useSend } from '../../components/settings/common';

export function SectorsSettings() {
  const list = useQuery({ queryKey: qk.sectors, queryFn: api.sectors.list });
  const save = useSend(qk.sectors);
  const [name, setName] = useState('');

  if (!list.data) return <Loading error={list.error} />;
  const sorted = [...list.data].sort((a, b) => a.position - b.position);

  function create(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    save.mutate(() => send('/api/sectors', 'POST', { name: name.trim() }), { onSuccess: () => setName('') });
  }

  // ponytail: renumbers every row whose position changed (one PATCH each); fine for a handful of sectors
  function move(i: number, dir: -1 | 1) {
    const next = [...sorted];
    [next[i], next[i + dir]] = [next[i + dir]!, next[i]!];
    save.mutate(() =>
      Promise.all(next.map((s, pos) => (s.position === pos ? null : send(`/api/sectors/${s.id}`, 'PATCH', { position: pos })))),
    );
  }

  function rename(s: SectorDto) {
    // ponytail: native prompt for a one-field rename
    const next = window.prompt('Novo nome do setor', s.name)?.trim();
    if (next && next !== s.name) save.mutate(() => send(`/api/sectors/${s.id}`, 'PATCH', { name: next }));
  }

  function remove(s: SectorDto) {
    if (window.confirm(`Excluir o setor "${s.name}"?`)) save.mutate(() => send(`/api/sectors/${s.id}`, 'DELETE'));
  }

  return (
    <Section title="Setores">
      <form onSubmit={create} className="mb-4 flex gap-2">
        <input
          aria-label="Nome do novo setor"
          placeholder="Nome do setor"
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          className="flex-1 rounded border px-2 py-1.5 text-sm"
        />
        <button type="submit" disabled={!name.trim() || save.isPending} className={btnPrimary}>
          Adicionar setor
        </button>
      </form>
      <ErrorText error={save.error} />
      <p className="mb-2 text-xs text-gray-500">
        O setor padrão recebe as conversas novas. A ordem é a usada nas listas e filtros.
      </p>
      <ul className="divide-y rounded border">
        {sorted.map((s, i) => (
          <li key={s.id} className="flex items-center gap-2 px-3 py-2 text-sm">
            <span className="flex-1">
              {s.name}
              {s.isDefault && <span className="ml-2 rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-800">Padrão</span>}
            </span>
            <button type="button" aria-label={`Subir ${s.name}`} disabled={i === 0 || save.isPending} onClick={() => move(i, -1)} className={btn}>
              <ArrowUpIcon size={14} />
            </button>
            <button
              type="button"
              aria-label={`Descer ${s.name}`}
              disabled={i === sorted.length - 1 || save.isPending}
              onClick={() => move(i, 1)}
              className={btn}
            >
              <ArrowDownIcon size={14} />
            </button>
            {!s.isDefault && (
              <button
                type="button"
                onClick={() => save.mutate(() => send(`/api/sectors/${s.id}`, 'PATCH', { isDefault: true }))}
                className={btn}
              >
                Definir como padrão
              </button>
            )}
            <button type="button" onClick={() => rename(s)} className={btn}>
              Renomear
            </button>
            <button type="button" disabled={s.isDefault} title={s.isDefault ? 'O setor padrão não pode ser excluído' : undefined} onClick={() => remove(s)} className={btn}>
              Excluir
            </button>
          </li>
        ))}
      </ul>
    </Section>
  );
}
```

Create `web/src/pages/settings/TagsSettings.tsx`:

```tsx
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { TagDto } from '@talk/shared';
import { TagForm, type TagInput } from '../../components/settings/TagForm';
import { ErrorText, Loading, Section, btn, btnPrimary, send, useSend } from '../../components/settings/common';
import { api, qk } from '../../lib/api';
import { tagColorHex } from '../../lib/tag-colors';

export function TagsSettings() {
  const tags = useQuery({ queryKey: qk.tags, queryFn: api.tags.list });
  const save = useSend(qk.tags);
  const [editing, setEditing] = useState<TagDto | 'new' | null>(null);

  if (!tags.data) return <Loading error={tags.error} />;
  const sorted = [...tags.data].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name, 'pt-BR'));
  const target = editing;

  function open(value: TagDto | 'new') {
    save.reset();
    setEditing(value);
  }

  function submit(v: TagInput) {
    save.mutate(
      () => (target && target !== 'new' ? send(`/api/tags/${target.id}`, 'PATCH', v) : send('/api/tags', 'POST', v)),
      { onSuccess: () => setEditing(null) },
    );
  }

  function remove(t: TagDto) {
    if (window.confirm(`Excluir a etiqueta "${t.name}"? Ela sai de todos os contatos.`)) {
      save.mutate(() => send(`/api/tags/${t.id}`, 'DELETE'));
    }
  }

  return (
    <Section
      title="Etiquetas"
      action={
        <button type="button" onClick={() => open('new')} className={btnPrimary}>
          Nova etiqueta
        </button>
      }
    >
      {target && (
        <TagForm
          key={target === 'new' ? 'new' : target.id}
          initial={target === 'new' ? undefined : target}
          pending={save.isPending}
          error={save.error?.message ?? null}
          onSubmit={submit}
          onCancel={() => setEditing(null)}
        />
      )}
      {!target && <ErrorText error={save.error} />}
      {sorted.length === 0 && <p className="text-sm text-gray-500">Nenhuma etiqueta.</p>}
      <ul className="divide-y rounded border">
        {sorted.map((t) => (
          <li key={t.id} className="flex items-center gap-2 px-3 py-2">
            <span className="flex-1">
              <span className="inline-block rounded-full px-3 py-0.5 text-sm font-medium text-white" style={{ backgroundColor: tagColorHex(t.color) }}>
                {t.emoji ? `${t.emoji} ${t.name}` : t.name}
              </span>
            </span>
            <button type="button" onClick={() => open(t)} className={btn}>
              Editar
            </button>
            <button type="button" onClick={() => remove(t)} className={btn}>
              Excluir
            </button>
          </li>
        ))}
      </ul>
    </Section>
  );
}
```

Create `web/src/pages/settings/CustomFieldsSettings.tsx`:

```tsx
import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { CustomFieldDto } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { ErrorText, Loading, Section, btn, btnPrimary, send, useSend } from '../../components/settings/common';

const KINDS: Record<CustomFieldDto['kind'], string> = {
  text: 'Texto',
  number: 'Número',
  date: 'Data',
  cpf: 'CPF',
  cnpj: 'CNPJ',
};

export function CustomFieldsSettings() {
  const list = useQuery({ queryKey: qk.customFields, queryFn: api.customFields.list });
  const save = useSend(qk.customFields);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<CustomFieldDto['kind']>('text');

  if (!list.data) return <Loading error={list.error} />;
  const sorted = [...list.data].sort((a, b) => a.position - b.position);

  function create(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    save.mutate(() => send('/api/custom-fields', 'POST', { name: name.trim(), kind }), { onSuccess: () => setName('') });
  }

  function rename(f: CustomFieldDto) {
    // ponytail: native prompt for a one-field rename
    const next = window.prompt(
      `Novo nome do campo. Respostas rápidas que usam {{campo.${f.name}}} precisam ser ajustadas.`,
      f.name,
    )?.trim();
    if (next && next !== f.name) save.mutate(() => send(`/api/custom-fields/${f.id}`, 'PATCH', { name: next }));
  }

  function remove(f: CustomFieldDto) {
    if (window.confirm(`Excluir o campo "${f.name}"? Os valores preenchidos nos contatos serão apagados.`)) {
      save.mutate(() => send(`/api/custom-fields/${f.id}`, 'DELETE'));
    }
  }

  return (
    <Section title="Campos personalizados">
      <form onSubmit={create} className="mb-4 flex gap-2">
        <input
          aria-label="Nome do novo campo"
          placeholder="Nome do campo (ex.: CPF, Número do processo)"
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          className="flex-1 rounded border px-2 py-1.5 text-sm"
        />
        <select aria-label="Tipo do novo campo" value={kind} onChange={(e) => setKind(e.target.value as CustomFieldDto['kind'])} className="rounded border px-2 py-1.5 text-sm">
          {Object.entries(KINDS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <button type="submit" disabled={!name.trim() || save.isPending} className={btnPrimary}>
          Criar campo
        </button>
      </form>
      <ErrorText error={save.error} />
      {sorted.length === 0 && <p className="text-sm text-gray-500">Nenhum campo personalizado.</p>}
      <ul className="divide-y rounded border">
        {sorted.map((f) => (
          <li key={f.id} className="flex items-center gap-2 px-3 py-2 text-sm">
            <span className="flex-1">{f.name}</span>
            <span className="w-20 text-gray-500">{KINDS[f.kind]}</span>
            <button type="button" onClick={() => rename(f)} className={btn}>
              Renomear
            </button>
            <button type="button" onClick={() => remove(f)} className={btn}>
              Excluir
            </button>
          </li>
        ))}
      </ul>
    </Section>
  );
}
```

- [ ] **Step 21: Write the Respostas rápidas, Triagem and Conversas pages**

Create `web/src/pages/settings/QuickAnswersSettings.tsx`:

```tsx
import { useState } from 'react';
import { PaperclipIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import type { QuickAnswerDto } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { useCurrentUser } from '../../lib/auth';
import { QuickAnswerForm, type QuickAnswerInput } from '../../components/settings/QuickAnswerForm';
import { ErrorText, Loading, Section, btn, btnPrimary, send, useSend } from '../../components/settings/common';

export function QuickAnswersSettings() {
  const me = useCurrentUser();
  const answers = useQuery({ queryKey: qk.quickAnswers, queryFn: api.quickAnswers.list });
  const fields = useQuery({ queryKey: qk.customFields, queryFn: api.customFields.list });
  const save = useSend(qk.quickAnswers);
  const [editing, setEditing] = useState<QuickAnswerDto | 'new' | null>(null);

  if (!answers.data || !fields.data) return <Loading error={answers.error ?? fields.error} />;
  const isAdmin = me.role === 'admin';
  const canEdit = (a: QuickAnswerDto) => isAdmin || a.ownerId === me.id;
  const sorted = [...answers.data].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  const target = editing;

  function open(value: QuickAnswerDto | 'new') {
    save.reset();
    setEditing(value);
  }

  function submit(v: QuickAnswerInput) {
    let body: unknown = { name: v.name, body: v.body, visibility: v.visibility };
    if (v.file) {
      // text fields before the file so the server's multipart parser has them when it reaches the file
      const form = new FormData();
      form.append('name', v.name);
      form.append('body', v.body);
      form.append('visibility', v.visibility);
      form.append('file', v.file);
      body = form;
    }
    save.mutate(
      () =>
        target && target !== 'new'
          ? send(`/api/quick-answers/${target.id}`, 'PATCH', body)
          : send('/api/quick-answers', 'POST', body),
      { onSuccess: () => setEditing(null) },
    );
  }

  function remove(a: QuickAnswerDto) {
    if (window.confirm(`Excluir a resposta rápida "${a.name}"?`)) save.mutate(() => send(`/api/quick-answers/${a.id}`, 'DELETE'));
  }

  return (
    <Section
      title="Respostas rápidas"
      action={
        <button type="button" onClick={() => open('new')} className={btnPrimary}>
          Nova resposta rápida
        </button>
      }
    >
      {target && (
        <QuickAnswerForm
          key={target === 'new' ? 'new' : target.id}
          initial={target === 'new' ? undefined : target}
          isAdmin={isAdmin}
          fields={[...fields.data].sort((a, b) => a.position - b.position)}
          pending={save.isPending}
          error={save.error?.message ?? null}
          onSubmit={submit}
          onCancel={() => setEditing(null)}
        />
      )}
      {!target && <ErrorText error={save.error} />}
      {sorted.length === 0 && <p className="text-sm text-gray-500">Nenhuma resposta rápida.</p>}
      <ul className="divide-y rounded border">
        {sorted.map((a) => (
          <li key={a.id} className="flex items-start gap-2 px-3 py-2 text-sm">
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 font-medium">
                /{a.name}
                {a.hasAttachment && <PaperclipIcon size={14} aria-label="Com anexo" />}
                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-normal text-gray-600">
                  {a.visibility === 'all' ? 'Para todos' : a.ownerId === me.id ? 'Apenas para mim' : 'Particular de outro atendente'}
                </span>
              </p>
              <p className="line-clamp-2 whitespace-pre-line text-gray-500">{a.body}</p>
            </div>
            {canEdit(a) && (
              <>
                <button type="button" onClick={() => open(a)} className={btn}>
                  Editar
                </button>
                <button type="button" onClick={() => remove(a)} className={btn}>
                  Excluir
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}
```

Create `web/src/pages/settings/TriageSettings.tsx`:

```tsx
import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { SectorDto, SettingsDto, TriageMenuDto } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { TriageOptionsEditor } from '../../components/settings/TriageOptionsEditor';
import { ErrorText, Loading, Section, btnPrimary, field, send, useSend } from '../../components/settings/common';

export function TriageSettings() {
  const settings = useQuery({ queryKey: qk.settings, queryFn: api.settings.get });
  const sectors = useQuery({ queryKey: qk.sectors, queryFn: api.sectors.list });
  if (!settings.data || !sectors.data) return <Loading error={settings.error ?? sectors.error} />;
  return <TriageForm settings={settings.data} sectors={[...sectors.data].sort((a, b) => a.position - b.position)} />;
}

function problem(menu: TriageMenuDto): string | null {
  if (menu.options.some((o) => !o.key || !o.label.trim() || !o.sectorId)) return 'Preencha número, texto e setor de cada opção.';
  if (new Set(menu.options.map((o) => o.key)).size !== menu.options.length) return 'Os números das opções não podem se repetir.';
  if (menu.enabled && !menu.welcomeText.trim()) return 'Escreva a mensagem de boas-vindas.';
  if (menu.enabled && menu.options.length === 0) return 'Adicione ao menos uma opção.';
  return null;
}

function TriageForm({ settings, sectors }: { settings: SettingsDto; sectors: SectorDto[] }) {
  const [menu, setMenu] = useState<TriageMenuDto>(settings.triageMenu);
  const save = useSend(qk.settings);
  const issue = problem(menu);
  const set = (patch: Partial<TriageMenuDto>) => setMenu((cur) => ({ ...cur, ...patch }));
  // same layout Task 11 sends to the contact
  const preview = [menu.welcomeText.trim(), menu.options.map((o) => `${o.key} - ${o.label}`).join('\n')]
    .filter(Boolean)
    .join('\n\n');

  function submit(e: FormEvent) {
    e.preventDefault();
    if (issue) return;
    const triageMenu = { ...menu, options: menu.options.map((o) => ({ ...o, label: o.label.trim() })) };
    save.mutate(() => send('/api/settings', 'PUT', { ...settings, triageMenu }));
  }

  return (
    <Section title="Triagem">
      <form onSubmit={submit} className="space-y-4">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={menu.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
          Enviar menu de triagem quando um contato começa uma conversa
        </label>
        <label className="block text-sm font-medium">
          Mensagem de boas-vindas
          <textarea rows={3} value={menu.welcomeText} onChange={(e) => set({ welcomeText: e.target.value })} className={field} />
        </label>
        <div>
          <span className="block text-sm font-medium">Opções</span>
          <p className="mb-2 text-xs text-gray-500">O contato responde com o número ou com o nome do setor.</p>
          <TriageOptionsEditor options={menu.options} sectors={sectors} onChange={(options) => set({ options })} />
        </div>
        <label className="block text-sm font-medium">
          Mensagem para resposta inválida
          <textarea rows={2} value={menu.invalidText} onChange={(e) => set({ invalidText: e.target.value })} className={field} />
          <span className="mt-1 block text-xs font-normal text-gray-500">
            Enviada uma única vez. Depois disso, a conversa fica no setor padrão.
          </span>
        </label>
        {preview && (
          <div>
            <span className="block text-sm font-medium">Como o contato recebe</span>
            <pre className="mt-1 whitespace-pre-wrap rounded bg-gray-50 p-3 font-sans text-sm">{preview}</pre>
          </div>
        )}
        {issue && <p className="text-sm text-amber-700">{issue}</p>}
        <ErrorText error={save.error} />
        {save.isSuccess && <p className="text-sm text-green-700">Triagem salva.</p>}
        <button type="submit" disabled={!!issue || save.isPending} className={btnPrimary}>
          Salvar
        </button>
      </form>
    </Section>
  );
}
```

Create `web/src/pages/settings/ChatSettings.tsx`:

```tsx
import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { SettingsDto } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { ErrorText, Loading, Section, btnPrimary, field, send, useSend } from '../../components/settings/common';

export function ChatSettings() {
  const settings = useQuery({ queryKey: qk.settings, queryFn: api.settings.get });
  if (!settings.data) return <Loading error={settings.error} />;
  return <ClosingMessageForm settings={settings.data} />;
}

function ClosingMessageForm({ settings }: { settings: SettingsDto }) {
  const [text, setText] = useState(settings.closingMessage);
  const save = useSend(qk.settings);

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate(() => send('/api/settings', 'PUT', { ...settings, closingMessage: text.trim() }));
  }

  return (
    <Section title="Conversas">
      <form onSubmit={submit} className="space-y-4">
        <label className="block text-sm font-medium">
          Mensagem de encerramento
          <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} className={field} />
          <span className="mt-1 block text-xs font-normal text-gray-500">
            Enviada ao contato quando o atendente finaliza a conversa com a opção “Enviar mensagem de encerramento” marcada.
            Deixe em branco para não usar.
          </span>
        </label>
        <ErrorText error={save.error} />
        {save.isSuccess && <p className="text-sm text-green-700">Mensagem salva.</p>}
        <button type="submit" disabled={save.isPending} className={btnPrimary}>
          Salvar
        </button>
      </form>
    </Section>
  );
}
```

- [ ] **Step 22: Register the route**

In `web/src/App.tsx`, add the import:

```tsx
import { SettingsPage } from './pages/settings/SettingsPage';
```

In the `routes` array, add this RouteObject to the `children` of the `path: '/'` layout route, above the `{ path: '*', element: <NotFound /> }` catch-all:

```tsx
      { path: 'configuracoes/:section?', element: <SettingsPage /> },
```

Then check that the route and the links are in place:

Run: `grep -rn "/configuracoes" web/src --include=*.tsx`
Expected: the `SettingsPage.tsx` links, plus Task 15's sidebar item (`NavItem to="/configuracoes"`) and channel banner link (`/configuracoes/canais`).

- [ ] **Step 23: Typecheck, build and run the web tests**

Run: `npx tsc -p web/tsconfig.json --noEmit`
Expected: no output, exit code 0.

Run: `npm run build -w web`
Expected: Vite prints `✓ built in …` with no errors.

Run: `npm test -w web`
Expected: PASS (all web test files, including the 3 from this task: 8 + 5 + 8 tests).

- [ ] **Step 24: Manual smoke check**

Run: `npm run dev -w web`, with the server running against a seeded database. Do the following in the browser:

1. As admin, open `/configuracoes`. It redirects to `/configuracoes/perfil`, and the menu shows all 9 items.
2. Under **Etiquetas**, create "⭐ Cliente VIP" in Verde. The chip shows in the list. Edit it to Tomate and save.
3. Under **Setores**, add one, move it up and down, set it as default, then rename it.
4. Under **Respostas rápidas**, create one, click "Nome do contato" in the middle of the text, and attach a PDF. The 📎 icon appears in the list.
5. Under **Triagem**, enable the menu, add two options with sectors and save. Reload the page; the options are still there.
6. Under **Canais**, click "Gerar novo QR / Reconectar". The QR image appears and is replaced by a fresh one every 20 seconds. After you scan it, the pill turns "Conectado" and the QR disappears without reloading the page.
7. Log in as an agent. The menu shows only Perfil and Respostas rápidas. Opening `/configuracoes/canais` redirects to Perfil.

- [ ] **Step 25: Commit**

```bash
git add web/src/components/settings/common.tsx web/src/pages/settings web/src/App.tsx
git commit -m "feat(web): settings area (perfil, canais/QR, atendentes, setores, etiquetas, campos, respostas rápidas, triagem, conversas)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


---

### Task 20: Umbler Talk importer

A one-off script for go-live (spec §3 item 9, §5.7, §8 "Virada"). It reads the office's registry data from the Umbler Talk public API: sectors, tags, custom fields, contacts with their tags and field values, and quick answers with their variables and attachment. It writes that data into our database. Message history stays in Umbler (spec §1). The script is idempotent: running it twice creates nothing new.

Rules this task fixes:
- **Phase 1 fetches** everything from Umbler, with no DB access. **Phase 2 writes** inside one transaction. `--dry-run` runs the same phase 2 and then rolls it back. The counts are therefore exact, and nothing is committed, downloaded or written to disk.
- **Upsert by name** for sectors, tags, custom fields and quick answers. **Upsert by normalized phone** for contacts, then by LID, in the same order as the webhook (§5.1 step 4).
  - Existing rows are never overwritten. A matched contact only gets its **empty** columns filled, plus any missing tags and field values (`ON CONFLICT DO NOTHING`).
  - Two Umbler contacts whose phones normalize to the same number (`556599998888` and `5565999998888`) merge into one contact.
- **Rate limit:** at least 50 ms between API calls, which is the documented 100 req / 5 s. A `429` waits 5 s and is retried up to 3 times.
- **The Umbler token is sent only to `app-utalk.umbler.com`.** Attachment URLs are storage links and are downloaded with no `Authorization` header.

**Files:**
- Create: `server/src/importer/umbler.ts`
- Create: `server/src/importer/cli.ts`
- Modify: `server/package.json` (add script `import:umbler`)
- Test: `server/test/importer/umbler.test.ts`

**Interfaces:**
- Consumes:
  - `Db`, `Tx` (`server/src/db/client.ts`, Task 2); `createPgDb(url: string): Db`.
  - Tables (`server/src/db/schema.ts`, Task 2), with the columns they use:
    - `sectors.{id,name,position,isDefault}`
    - `tags.{id,name(varchar 30),emoji,color(text, not null),position}`
    - `customFields.{id,name(unique),kind,position}`
    - `contacts.{id,name,phone,lid,email,landline,address,blocked}`
    - `contactTags.{contactId,tagId}`
    - `contactFieldValues.{contactId,fieldId,value}`
    - `quickAnswers.{id,name,body,attachmentPath,visibility,ownerId}`
  - `normalizePhoneBR(raw: string): string` and `lidFromJid(jid: string): string | null` (`server/src/whatsapp/phone.ts`, Task 3).
  - `saveMedia(mediaDir: string, data: Buffer, mime: string, originalName?: string | null): Promise<{ path: string; size: number }>` (`server/src/messages/media.ts`, Task 10).
  - `convertUmblerVariables(body: string, variables: Array<{ defaultValue: string }>): { body: string; unmapped: string[] }` (`server/src/messages/quick-answers.ts`, contract). This task assumes it maps Umbler's `Contato.PrimeiroNome` to `{{contato.primeiro_nome}}`. Per spec §5.7, a `defaultValue` it cannot map is written as plain text and returned in `unmapped`.
  - Test helpers (`server/test/helpers.ts`): `makeTestDb(): Promise<Db>`, `seedBasics(ctx: { db }): Promise<Seeded>` (sectors `Atendimento` (default), `Financeiro`, `Jurídico`).
- Produces:
  - `importUmbler(deps: ImportDeps): Promise<ImportReport>`, with `UMBLER_API = 'https://app-utalk.umbler.com/api'`:
    ```ts
    interface ImportDeps { db: Db; mediaDir: string; token: string; dryRun: boolean; fetchImpl?: typeof fetch; baseUrl?: string; sleep?: (ms: number) => Promise<unknown> }
    interface ImportCounts { created: number; existing: number }
    interface ImportReport {
      dryRun: boolean; organization: string;
      sectors: ImportCounts; tags: ImportCounts;
      customFields: ImportCounts & { unsupported: string[] };
      contacts: ImportCounts & { skippedInvalidPhone: Array<{ umblerId: string; name: string | null; phone: string | null }> };
      quickAnswers: ImportCounts & { attachments: number; attachmentErrors: string[] };
      unmappedVariables: Array<{ quickAnswer: string; variables: string[] }>;
    }
    ```
  - The CLI `npm run import:umbler -w server -- --token <UMBLER_TOKEN> [--dry-run]`. The token may also come from env `UMBLER_TOKEN`. The CLI reads env `DATABASE_URL` and `MEDIA_DIR` (default `/data/media`). It prints the report JSON to stdout. Unless `--dry-run` is set, it also writes the report to `<dirname(MEDIA_DIR)>/import-report.json`, which is `/data/import-report.json` in production. Task 21's runbook calls it as `docker compose exec app npm run import:umbler -w server -- --token … --dry-run`, then again without `--dry-run`.
  - Mapping decisions that the web/settings tasks should know about:
    - Umbler `TagColor` names become hex (`Gold` → `#eab308`, etc.).
    - Contact `address` keeps Umbler's keys (`addressLine1`, `addressLine2`, `city`, `state`, `zipCode`, `country`) and drops empty values.
    - Date field values are stored as `YYYY-MM-DD`. Number, decimal and currency values are stored as decimal strings.
    - Imported quick answers are `visibility: 'all'`, `ownerId: null`.
    - A sector is imported as default only when our DB has no default sector yet.

- [ ] **Step 1: Write the failing test**

Create `server/test/importer/umbler.test.ts`. All fixtures are synthetic, and the fake `fetch` serves them. No real network is used.

```ts
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import {
  contactFieldValues,
  contactTags,
  contacts,
  customFields,
  quickAnswers,
  sectors,
  tags,
} from '../../src/db/schema.js';
import { importUmbler, type ImportDeps, type ImportReport } from '../../src/importer/umbler.js';
import { convertUmblerVariables } from '../../src/messages/quick-answers.js';
import { makeTestDb, seedBasics } from '../helpers.js';

// ---------- synthetic Umbler fixtures (shapes from docs/utalk-openapi-v1.json) ----------
const ORG = 'ORG_TESTE_00001';
const ATTACHMENT_URL = 'https://files.example.test/procuracao.pdf';
const PDF = new TextEncoder().encode('%PDF-1.4 anexo sintetico');
const MAX_TAKE = 2; // the fake caps page size so pagination is exercised

const ME = {
  _t: 'HumanOrganizationAgentModel',
  id: 'MEMBER_1',
  organizations: [{ _t: 'OrganizationReferenceForHumanAgentModel', id: ORG, name: 'Escritório Teste', active: true }],
};

const SECTORS = [
  { _t: 'SectorReferenceModel', id: 'SEC1', name: 'Atendimento', default: true, order: 0, groupIds: [] },
  { _t: 'SectorReferenceModel', id: 'SEC2', name: 'Financeiro', default: false, order: 1, groupIds: [] },
  { _t: 'SectorReferenceModel', id: 'SEC3', name: 'Trabalhista', default: false, order: 2, groupIds: [] },
];

const TAGS = [
  { _t: 'TagModel', id: 'TAG1', name: 'Cliente', emoji: '⭐', color: 'Gold', order: 0, groupIds: [] },
  { _t: 'TagModel', id: 'TAG2', name: 'Prospecção', emoji: null, color: 'Blue', order: 1, groupIds: [] },
];

const FIELD_DEFS = [
  { _t: 'CPFCustomFieldDefinitionModel', id: 'CF1', name: 'CPF', description: null },
  { _t: 'DateCustomFieldDefinitionModel', id: 'CF2', name: 'Nascimento', description: null },
  { _t: 'LogicCustomFieldDefinitionModel', id: 'CF3', name: 'Aceitou termos', description: null },
];

const tagRef = (id: string, name: string) => ({ _t: 'SimpleTagReferenceModel', id, name });

const CONTACTS = [
  {
    _t: 'SimpleContactModel',
    id: 'C1',
    name: 'Maria Teste',
    phoneNumber: '+55 65 9999-8888', // 12 digits once stripped: must gain the 9
    lid: null,
    email: 'maria@example.test',
    landline: null,
    address: { addressLine1: 'Rua das Flores, 100', addressLine2: null, city: 'Cuiabá', state: 'MT', zipCode: null, country: null },
    isBlocked: false,
    tags: [tagRef('TAG1', 'Cliente')],
    customFields: [
      { _t: 'ContactCPFCustomFieldModel', id: 'V1', customFieldDefinitionId: 'CF1', value: '000.000.000-00' },
      { _t: 'ContactDateCustomFieldModel', id: 'V2', customFieldDefinitionId: 'CF2', value: '1990-05-17T00:00:00Z' },
      { _t: 'ContactLogicCustomFieldModel', id: 'V3', customFieldDefinitionId: 'CF3', value: true },
    ],
  },
  {
    _t: 'SimpleContactModel',
    id: 'C2',
    name: 'João Teste',
    phoneNumber: '5565988887777',
    isBlocked: true,
    tags: [tagRef('TAG1', 'Cliente'), tagRef('TAG2', 'Prospecção')],
    customFields: [],
  },
  { _t: 'SimpleContactModel', id: 'C3', name: 'Fixo Teste', phoneNumber: '556532221111', isBlocked: false, tags: [], customFields: [] },
  { _t: 'SimpleContactModel', id: 'C4', name: 'Sem Número', phoneNumber: '123', isBlocked: false, tags: [], customFields: [] },
  { _t: 'SimpleContactModel', id: 'C5', name: null, phoneNumber: null, isBlocked: false, tags: [], customFields: [] },
  {
    _t: 'SimpleContactModel',
    id: 'C6',
    name: 'Maria Duplicada',
    phoneNumber: '5565999998888', // same number as C1 in 13-digit form: merges into C1
    isBlocked: false,
    tags: [tagRef('TAG2', 'Prospecção')],
    customFields: [],
  },
];

const QA_VARIABLES = [
  { name: 'nome', defaultValue: 'Contato.PrimeiroNome' },
  { name: 'assinatura', defaultValue: 'Valor fixo qualquer' },
];
const QUICK_ANSWERS = [
  {
    _t: 'QuickAnswerModel',
    id: 'QA1',
    name: 'Boas-vindas',
    content: 'Olá {{1}}, aqui é {{2}}.',
    groupIds: [],
    variables: QA_VARIABLES,
    attachment: null,
  },
  {
    _t: 'QuickAnswerModel',
    id: 'QA2',
    name: 'Procuração',
    content: 'Segue a procuração.',
    groupIds: [],
    variables: [],
    attachment: { fileId: 'F1', fileType: 'File', url: ATTACHMENT_URL, originalName: 'procuracao.pdf', thumbnail: null },
  },
];

// ---------- fake Umbler API ----------
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fakeUmbler(opts: { rateLimitOnce?: string } = {}) {
  const calls: Array<{ url: URL; auth: string | null }> = [];
  let limited = false;
  const page = (url: URL, items: unknown[]) => {
    const skip = Number(url.searchParams.get('Skip') ?? '0');
    const take = Math.min(Number(url.searchParams.get('Take') ?? '50'), MAX_TAKE);
    const slice = items.slice(skip, skip + take);
    return json({ page: { skipped: skip, took: slice.length, maxTake: MAX_TAKE }, items: slice });
  };
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push({ url, auth: new Headers(init?.headers).get('authorization') });
    if (url.href === ATTACHMENT_URL) return new Response(PDF, { headers: { 'content-type': 'application/pdf' } });
    if (url.pathname === opts.rateLimitOnce && !limited) {
      limited = true;
      return json({ error: 'Too Many Requests' }, 429);
    }
    const p = url.pathname;
    if (p === '/api/v1/members/me/') return json(ME);
    if (p === '/api/v1/sectors/') return json(SECTORS);
    if (p === '/api/v1/tags/') return page(url, TAGS);
    if (p === '/api/v1/custom-field-definitions/') return json(FIELD_DEFS);
    if (p === '/api/v1/contacts/') return page(url, CONTACTS);
    if (p === '/api/v1/quick-answers/') return page(url, QUICK_ANSWERS);
    const detail = /^\/api\/v1\/quick-answers\/([^/]+)\/$/.exec(p);
    const qa = detail && QUICK_ANSWERS.find((q) => q.id === detail[1]);
    if (qa) return json(qa);
    return json({ error: 'not found' }, 404);
  };
  return { fetchImpl: fetchImpl as typeof fetch, calls };
}

const FIRST_RUN: Omit<ImportReport, 'unmappedVariables'> = {
  dryRun: false,
  organization: 'Escritório Teste',
  sectors: { created: 1, existing: 2 },
  tags: { created: 2, existing: 0 },
  customFields: { created: 2, existing: 0, unsupported: ['Aceitou termos'] },
  contacts: {
    created: 3,
    existing: 1,
    skippedInvalidPhone: [
      { umblerId: 'C4', name: 'Sem Número', phone: '123' },
      { umblerId: 'C5', name: null, phone: null },
    ],
  },
  quickAnswers: { created: 2, existing: 0, attachments: 1, attachmentErrors: [] },
};

describe('importUmbler', () => {
  let db: Db;
  let mediaDir: string;
  let sleeps: number[];

  const deps = (fake: ReturnType<typeof fakeUmbler>, dryRun = false): ImportDeps => ({
    db,
    mediaDir,
    token: 'tok-teste',
    dryRun,
    fetchImpl: fake.fetchImpl,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  });

  const sizes = async () => ({
    sectors: await db.$count(sectors),
    tags: await db.$count(tags),
    customFields: await db.$count(customFields),
    contacts: await db.$count(contacts),
    contactTags: await db.$count(contactTags),
    contactFieldValues: await db.$count(contactFieldValues),
    quickAnswers: await db.$count(quickAnswers),
  });

  const pdfFiles = async () => (await readdir(mediaDir, { recursive: true })).filter((f) => f.endsWith('.pdf'));

  const tagNamesOf = async (contactId: string) =>
    (
      await db
        .select({ name: tags.name })
        .from(contactTags)
        .innerJoin(tags, eq(tags.id, contactTags.tagId))
        .where(eq(contactTags.contactId, contactId))
    )
      .map((t) => t.name)
      .sort();

  beforeEach(async () => {
    db = await makeTestDb();
    await seedBasics({ db });
    mediaDir = await mkdtemp(join(tmpdir(), 'talk-import-'));
    sleeps = [];
  });

  afterEach(async () => {
    await rm(mediaDir, { recursive: true, force: true });
  });

  it('maps sectors, tags, custom fields and contacts (12→13 digits, landline kept, invalid phones skipped)', async () => {
    const report = await importUmbler(deps(fakeUmbler()));
    expect(report).toMatchObject(FIRST_RUN);

    const sectorRows = await db.select().from(sectors);
    expect(sectorRows.map((s) => s.name).sort()).toEqual(['Atendimento', 'Financeiro', 'Jurídico', 'Trabalhista']);
    expect(sectorRows.filter((s) => s.isDefault).map((s) => s.name)).toEqual(['Atendimento']);

    const tagRows = await db.select().from(tags).orderBy(tags.position);
    expect(tagRows.map(({ name, emoji, color }) => ({ name, emoji, color }))).toEqual([
      { name: 'Cliente', emoji: '⭐', color: '#eab308' },
      { name: 'Prospecção', emoji: null, color: '#3b82f6' },
    ]);

    const fieldRows = await db.select().from(customFields).orderBy(customFields.position);
    expect(fieldRows.map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: 'CPF', kind: 'cpf' },
      { name: 'Nascimento', kind: 'date' },
    ]);

    const contactRows = await db.select().from(contacts).orderBy(contacts.phone);
    expect(contactRows.map((c) => c.phone)).toEqual(['556532221111', '5565988887777', '5565999998888']);

    const maria = contactRows.find((c) => c.phone === '5565999998888')!;
    expect(maria).toMatchObject({ name: 'Maria Teste', email: 'maria@example.test', blocked: false });
    expect(maria.address).toEqual({ addressLine1: 'Rua das Flores, 100', city: 'Cuiabá', state: 'MT' });
    expect(await tagNamesOf(maria.id)).toEqual(['Cliente', 'Prospecção']); // C6 merged into C1

    const values = await db
      .select({ name: customFields.name, value: contactFieldValues.value })
      .from(contactFieldValues)
      .innerJoin(customFields, eq(customFields.id, contactFieldValues.fieldId))
      .where(eq(contactFieldValues.contactId, maria.id))
      .orderBy(customFields.name);
    expect(values).toEqual([
      { name: 'CPF', value: '000.000.000-00' },
      { name: 'Nascimento', value: '1990-05-17' },
    ]);

    const joao = contactRows.find((c) => c.phone === '5565988887777')!;
    expect(joao).toMatchObject({ name: 'João Teste', blocked: true });
    expect(await tagNamesOf(joao.id)).toEqual(['Cliente', 'Prospecção']);
  });

  it('sends the Bearer token and organizationId to the Umbler API only, and paginates', async () => {
    const fake = fakeUmbler();
    await importUmbler(deps(fake));

    const api = fake.calls.filter((c) => c.url.hostname === 'app-utalk.umbler.com');
    expect(api.length).toBeGreaterThan(0);
    for (const c of api) expect(c.auth).toBe('Bearer tok-teste');
    for (const c of api.filter((c) => c.url.pathname !== '/api/v1/members/me/')) {
      expect(c.url.searchParams.get('organizationId')).toBe(ORG);
    }

    const contactCalls = api.filter((c) => c.url.pathname === '/api/v1/contacts/');
    expect(contactCalls.map((c) => c.url.searchParams.get('Skip'))).toEqual(['0', '2', '4', '6']);
    expect(contactCalls[0].url.searchParams.getAll('includeCustomFields')).toEqual(['CF1', 'CF2', 'CF3']);

    const downloads = fake.calls.filter((c) => c.url.href === ATTACHMENT_URL);
    expect(downloads).toHaveLength(1);
    expect(downloads[0].auth).toBeNull(); // the Umbler token never leaves app-utalk.umbler.com
  });

  it('converts quick-answer variables, reports the unmapped ones and saves the attachment', async () => {
    const report = await importUmbler(deps(fakeUmbler()));
    const expected = convertUmblerVariables(QUICK_ANSWERS[0].content, QA_VARIABLES);

    const [welcome] = await db.select().from(quickAnswers).where(eq(quickAnswers.name, 'Boas-vindas'));
    expect(welcome.body).toBe(expected.body);
    expect(welcome.body).toContain('{{contato.primeiro_nome}}');
    expect(welcome.body).not.toMatch(/\{\{\d+\}\}/);
    expect(welcome).toMatchObject({ visibility: 'all', ownerId: null, attachmentPath: null });

    expect(expected.unmapped).toHaveLength(1);
    expect(report.unmappedVariables).toEqual([{ quickAnswer: 'Boas-vindas', variables: expected.unmapped }]);

    const [proxy] = await db.select().from(quickAnswers).where(eq(quickAnswers.name, 'Procuração'));
    expect(proxy.body).toBe('Segue a procuração.');
    expect(proxy.attachmentPath).toMatch(/^\d{4}\/\d{2}\/[0-9a-f-]{36}\.pdf$/);
    expect(await readFile(join(mediaDir, proxy.attachmentPath!))).toEqual(Buffer.from(PDF));
  });

  it('is idempotent: a second run creates nothing and downloads nothing', async () => {
    await importUmbler(deps(fakeUmbler()));
    const before = await sizes();

    const fake = fakeUmbler();
    const second = await importUmbler(deps(fake));

    expect(second).toMatchObject({
      sectors: { created: 0, existing: 3 },
      tags: { created: 0, existing: 2 },
      customFields: { created: 0, existing: 2 },
      contacts: { created: 0, existing: 4 },
      quickAnswers: { created: 0, existing: 2, attachments: 0 },
      unmappedVariables: [],
    });
    expect(await sizes()).toEqual(before);
    expect(before).toMatchObject({ contacts: 3, tags: 2, customFields: 2, quickAnswers: 2, contactTags: 4, contactFieldValues: 2 });
    expect(fake.calls.filter((c) => c.url.href === ATTACHMENT_URL)).toHaveLength(0);
    expect(await pdfFiles()).toHaveLength(1);
  });

  it('fills only the empty fields of contacts that already exist', async () => {
    await db.insert(contacts).values([
      { phone: '5565999998888', name: null }, // e.g. created by a webhook before the import
      { phone: '5565988887777', name: 'Nome Editado' },
    ]);

    const report = await importUmbler(deps(fakeUmbler()));
    expect(report.contacts).toMatchObject({ created: 1, existing: 3 });

    const [maria] = await db.select().from(contacts).where(eq(contacts.phone, '5565999998888'));
    expect(maria).toMatchObject({ name: 'Maria Teste', email: 'maria@example.test' });
    const [joao] = await db.select().from(contacts).where(eq(contacts.phone, '5565988887777'));
    expect(joao).toMatchObject({ name: 'Nome Editado', blocked: false });
    expect(await tagNamesOf(joao.id)).toEqual(['Cliente', 'Prospecção']);
  });

  it('dry-run reports the same counts and writes nothing', async () => {
    const fake = fakeUmbler();
    const report = await importUmbler(deps(fake, true));

    expect(report).toMatchObject({ ...FIRST_RUN, dryRun: true });
    expect(report.unmappedVariables).toHaveLength(1);
    expect(await sizes()).toEqual({
      sectors: 3,
      tags: 0,
      customFields: 0,
      contacts: 0,
      contactTags: 0,
      contactFieldValues: 0,
      quickAnswers: 0,
    });
    expect(fake.calls.filter((c) => c.url.href === ATTACHMENT_URL)).toHaveLength(0);
    expect(await readdir(mediaDir)).toEqual([]);
  });

  it('waits and retries when Umbler answers 429', async () => {
    const fake = fakeUmbler({ rateLimitOnce: '/api/v1/sectors/' });
    const report = await importUmbler(deps(fake));

    expect(report.sectors.created).toBe(1);
    expect(sleeps).toContain(5000);
    expect(fake.calls.filter((c) => c.url.pathname === '/api/v1/sectors/')).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w server -- test/importer/umbler.test.ts`
Expected: FAIL with `Failed to load url ../../src/importer/umbler.js` (or "Cannot find module"), because the importer does not exist yet.

- [ ] **Step 3: Write the importer core**

Create `server/src/importer/umbler.ts`:

```ts
import { setTimeout as delay } from 'node:timers/promises';
import { eq, TransactionRollbackError } from 'drizzle-orm';
import type { Db, Tx } from '../db/client.js';
import {
  contactFieldValues,
  contactTags,
  contacts,
  customFields,
  quickAnswers,
  sectors,
  tags,
} from '../db/schema.js';
import { saveMedia } from '../messages/media.js';
import { convertUmblerVariables } from '../messages/quick-answers.js';
import { lidFromJid, normalizePhoneBR } from '../whatsapp/phone.js';

export const UMBLER_API = 'https://app-utalk.umbler.com/api';
// ponytail: fixed spacing = the documented 100 req / 5 s; a token bucket only if imports get too slow.
const MIN_GAP_MS = 50;
const RETRY_AFTER_MS = 5_000;
const MAX_ATTEMPTS = 4;
const PAGE_SIZE = 50;

type FieldKind = 'text' | 'number' | 'date' | 'cpf' | 'cnpj';

// Umbler definition `_t` → our kind. Anything else (logic, lists, options, members, references,
// files, dictionaries) is listed in report.customFields.unsupported and its values are skipped.
const FIELD_KINDS: Record<string, FieldKind> = {
  TextCustomFieldDefinitionModel: 'text',
  LinkCustomFieldDefinitionModel: 'text',
  NumberCustomFieldDefinitionModel: 'number',
  DecimalCustomFieldDefinitionModel: 'number',
  CurrencyCustomFieldDefinitionModel: 'number',
  DateCustomFieldDefinitionModel: 'date',
  CPFCustomFieldDefinitionModel: 'cpf',
  CNPJCustomFieldDefinitionModel: 'cnpj',
};

// Umbler TagColor enum → hex stored in tags.color.
const TAG_COLORS: Record<string, string> = {
  Blue: '#3b82f6',
  Skyblue: '#38bdf8',
  Cyan: '#06b6d4',
  Aquamarine: '#2dd4bf',
  Green: '#22c55e',
  Kiwi: '#84cc16',
  Gold: '#eab308',
  Amber: '#f59e0b',
  Tangerine: '#f97316',
  Chocolate: '#92400e',
  Salmon: '#fa8072',
  Tomato: '#ef4444',
  Rose: '#f43f5e',
  Pink: '#ec4899',
  Magenta: '#d946ef',
  Violet: '#8b5cf6',
  Grape: '#7c3aed',
  Gray: '#6b7280',
  Silver: '#9ca3af',
  Umblerito: '#2563eb',
};
const DEFAULT_TAG_COLOR = '#6b7280';

// Only the fields we read from the Umbler public API (docs/utalk-openapi-v1.json).
interface UmblerMe { organizations?: Array<{ id: string; name: string }> }
interface UmblerSector { id: string; name: string; default: boolean; order: number }
interface UmblerTag { id: string; name: string; emoji?: string | null; color?: string | null; order: number }
interface UmblerFieldDef { _t: string; id: string; name: string }
interface UmblerContact {
  id: string;
  name?: string | null;
  phoneNumber?: string | null;
  lid?: string | null;
  email?: string | null;
  landline?: string | null;
  address?: Record<string, string | null> | null;
  isBlocked?: boolean;
  tags?: Array<{ id: string }>;
  customFields?: Array<{ customFieldDefinitionId: string; value?: unknown }>;
}
interface UmblerQuickAnswer {
  id: string;
  name: string;
  content?: string | null;
  variables?: Array<{ defaultValue?: string | null }>;
  attachment?: { url?: string | null; originalName?: string | null } | null;
}

export interface ImportDeps {
  db: Db;
  mediaDir: string;
  token: string;
  dryRun: boolean;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  sleep?: (ms: number) => Promise<unknown>;
}

export interface ImportCounts { created: number; existing: number }

export interface ImportReport {
  dryRun: boolean;
  organization: string;
  sectors: ImportCounts;
  tags: ImportCounts;
  customFields: ImportCounts & { unsupported: string[] };
  contacts: ImportCounts & { skippedInvalidPhone: Array<{ umblerId: string; name: string | null; phone: string | null }> };
  quickAnswers: ImportCounts & { attachments: number; attachmentErrors: string[] };
  unmappedVariables: Array<{ quickAnswer: string; variables: string[] }>;
}

type Query = Record<string, string | number | boolean | string[]>;
type UmblerGet = <T>(path: string, query: Query) => Promise<T>;

function umblerClient(deps: ImportDeps): UmblerGet {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? delay;
  const base = deps.baseUrl ?? UMBLER_API;
  let last = 0;
  return async <T>(path: string, query: Query): Promise<T> => {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(query)) for (const x of [v].flat()) url.searchParams.append(k, String(x));
    for (let attempt = 1; ; attempt++) {
      const wait = last + MIN_GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${deps.token}`, Accept: 'application/json' } });
      if (res.status === 429 && attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_AFTER_MS);
        continue;
      }
      if (!res.ok) throw new Error(`Umbler respondeu ${res.status} em GET ${path}`);
      return (await res.json()) as T;
    }
  };
}

// Skip/Take pagination; stops at the first empty page (does not trust maxTake/totalItems).
async function getAll<T>(get: UmblerGet, path: string, query: Query): Promise<T[]> {
  const items: T[] = [];
  for (;;) {
    const page = await get<{ items?: T[] }>(path, { ...query, Skip: items.length, Take: PAGE_SIZE });
    if (!page.items?.length) return items;
    items.push(...page.items);
  }
}

async function fetchUmbler(deps: ImportDeps) {
  const get = umblerClient(deps);
  const me = await get<UmblerMe>('/v1/members/me/', {});
  // ponytail: first organization of the token; the office has exactly one.
  const org = me.organizations?.[0];
  if (!org) throw new Error('O token do Umbler não pertence a nenhuma organização');
  const q: Query = { organizationId: org.id };

  const sectorList = await get<UmblerSector[]>('/v1/sectors/', q);
  const tagList = await getAll<UmblerTag>(get, '/v1/tags/', q);
  const fieldDefs = await get<UmblerFieldDef[]>('/v1/custom-field-definitions/', q);
  const contactList = await getAll<UmblerContact>(get, '/v1/contacts/', {
    ...q,
    includeGroups: false,
    includeCustomFields: fieldDefs.map((d) => d.id),
  });
  const qaList = await getAll<{ id: string }>(get, '/v1/quick-answers/', { ...q, viewFrom: 'Everyone' });
  const qaDetails: UmblerQuickAnswer[] = [];
  for (const { id } of qaList) qaDetails.push(await get<UmblerQuickAnswer>(`/v1/quick-answers/${encodeURIComponent(id)}/`, q));

  return { org, sectorList, tagList, fieldDefs, contactList, qaDetails };
}

const str = (v: string | null | undefined): string | null => v?.trim() || null;
const byOrder = <T extends { order: number }>(list: T[]): T[] => [...list].sort((a, b) => a.order - b.order);

function toAddress(a: Record<string, string | null> | null | undefined): Record<string, string> | null {
  const entries = Object.entries(a ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].trim() !== '');
  return entries.length ? Object.fromEntries(entries) : null;
}

function fieldValue(v: unknown, kind: FieldKind): string | null {
  if (typeof v === 'number') return String(v);
  if (typeof v !== 'string' || !v.trim()) return null;
  return kind === 'date' ? v.trim().slice(0, 10) : v.trim();
}

async function importSectors(tx: Tx, list: UmblerSector[], r: ImportReport): Promise<void> {
  const rows = await tx.select().from(sectors);
  const names = new Set(rows.map((s) => s.name));
  let hasDefault = rows.some((s) => s.isDefault);
  for (const [i, s] of byOrder(list).entries()) {
    const name = s.name.trim();
    if (names.has(name)) {
      r.sectors.existing++;
      continue;
    }
    await tx.insert(sectors).values({ name, position: i, isDefault: s.default && !hasDefault });
    hasDefault ||= s.default;
    names.add(name);
    r.sectors.created++;
  }
}

// Returns Umbler tag id → our tag id.
async function importTags(tx: Tx, list: UmblerTag[], r: ImportReport): Promise<Map<string, string>> {
  const idByName = new Map((await tx.select({ id: tags.id, name: tags.name }).from(tags)).map((t) => [t.name, t.id]));
  const map = new Map<string, string>();
  for (const [i, t] of byOrder(list).entries()) {
    const name = t.name.trim().slice(0, 30); // tags.name is varchar(30)
    let id = idByName.get(name);
    if (id) {
      r.tags.existing++;
    } else {
      const color = TAG_COLORS[t.color ?? ''] ?? DEFAULT_TAG_COLOR;
      id = (await tx.insert(tags).values({ name, emoji: str(t.emoji), color, position: i }).returning({ id: tags.id }))[0].id;
      idByName.set(name, id);
      r.tags.created++;
    }
    map.set(t.id, id);
  }
  return map;
}

// Returns Umbler definition id → our field.
async function importFields(
  tx: Tx,
  list: UmblerFieldDef[],
  r: ImportReport,
): Promise<Map<string, { id: string; kind: FieldKind }>> {
  const rows = await tx.select({ id: customFields.id, name: customFields.name, kind: customFields.kind }).from(customFields);
  const byName = new Map(rows.map((f) => [f.name, { id: f.id, kind: f.kind }]));
  const map = new Map<string, { id: string; kind: FieldKind }>();
  for (const [i, d] of list.entries()) {
    const name = d.name.trim();
    const kind = FIELD_KINDS[d._t];
    if (!kind) {
      r.customFields.unsupported.push(name);
      continue;
    }
    let field = byName.get(name);
    if (field) {
      r.customFields.existing++;
    } else {
      field = (
        await tx
          .insert(customFields)
          .values({ name, kind, position: i })
          .returning({ id: customFields.id, kind: customFields.kind })
      )[0];
      byName.set(name, field);
      r.customFields.created++;
    }
    map.set(d.id, field);
  }
  return map;
}

async function importContacts(
  tx: Tx,
  list: UmblerContact[],
  tagIds: Map<string, string>,
  fields: Map<string, { id: string; kind: FieldKind }>,
  r: ImportReport,
): Promise<void> {
  for (const c of list) {
    const phone = normalizePhoneBR(c.phoneNumber ?? '');
    if (!/^\d{10,15}$/.test(phone)) {
      r.contacts.skippedInvalidPhone.push({ umblerId: c.id, name: c.name ?? null, phone: c.phoneNumber ?? null });
      continue;
    }
    const lid = c.lid ? (lidFromJid(c.lid) ?? (/^\d+$/.test(c.lid) ? c.lid : null)) : null;

    // Same matching order as the webhook (spec §5.1 step 4): phone first, then LID.
    const [byPhone] = await tx.select().from(contacts).where(eq(contacts.phone, phone));
    const [byLid] = lid ? await tx.select().from(contacts).where(eq(contacts.lid, lid)) : [];
    const found = byPhone ?? byLid;

    let contactId: string;
    if (found) {
      // Fill only what is empty: never overwrite data already edited in the new system.
      await tx
        .update(contacts)
        .set({
          name: found.name ?? str(c.name),
          phone: found.phone ?? phone,
          lid: found.lid ?? (byLid ? null : lid), // a LID owned by another contact is never copied
          email: found.email ?? str(c.email),
          landline: found.landline ?? str(c.landline),
          address: found.address ?? toAddress(c.address),
        })
        .where(eq(contacts.id, found.id));
      contactId = found.id;
      r.contacts.existing++;
    } else {
      const [row] = await tx
        .insert(contacts)
        .values({
          name: str(c.name),
          phone,
          lid,
          email: str(c.email),
          landline: str(c.landline),
          address: toAddress(c.address),
          blocked: c.isBlocked ?? false,
        })
        .returning({ id: contacts.id });
      contactId = row.id;
      r.contacts.created++;
    }

    const tagRows = (c.tags ?? []).flatMap((t) => {
      const tagId = tagIds.get(t.id);
      return tagId ? [{ contactId, tagId }] : [];
    });
    if (tagRows.length) await tx.insert(contactTags).values(tagRows).onConflictDoNothing();

    const valueRows = (c.customFields ?? []).flatMap((f) => {
      const field = fields.get(f.customFieldDefinitionId);
      const value = field ? fieldValue(f.value, field.kind) : null;
      return field && value !== null ? [{ contactId, fieldId: field.id, value }] : [];
    });
    if (valueRows.length) await tx.insert(contactFieldValues).values(valueRows).onConflictDoNothing();
  }
}

async function downloadAttachment(deps: ImportDeps, url: string, originalName: string | null): Promise<string> {
  // A storage link, not the Umbler API: no Authorization header, the token never leaves app-utalk.
  const res = await (deps.fetchImpl ?? fetch)(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const mime = res.headers.get('content-type')?.split(';')[0].trim() || 'application/octet-stream';
  const saved = await saveMedia(deps.mediaDir, Buffer.from(await res.arrayBuffer()), mime, originalName);
  return saved.path;
}

async function importQuickAnswers(tx: Tx, list: UmblerQuickAnswer[], deps: ImportDeps, r: ImportReport): Promise<void> {
  const names = new Set((await tx.select({ name: quickAnswers.name }).from(quickAnswers)).map((q) => q.name));
  for (const qa of list) {
    const name = qa.name.trim();
    if (names.has(name)) {
      r.quickAnswers.existing++;
      continue;
    }
    const { body, unmapped } = convertUmblerVariables(
      qa.content ?? '',
      (qa.variables ?? []).map((v) => ({ defaultValue: v.defaultValue ?? '' })),
    );
    if (unmapped.length) r.unmappedVariables.push({ quickAnswer: name, variables: unmapped });

    let attachmentPath: string | null = null;
    const url = qa.attachment?.url;
    if (url) {
      r.quickAnswers.attachments++;
      if (!deps.dryRun) {
        // ponytail: a file saved before a failed commit stays orphaned in mediaDir; harmless for a one-off import.
        attachmentPath = await downloadAttachment(deps, url, qa.attachment?.originalName ?? null).catch(() => {
          r.quickAnswers.attachmentErrors.push(name);
          return null;
        });
      }
    }
    // ponytail: imported answers are shared ('all'); Umbler members are not users here, so the owner
    // of an "Apenas para mim" answer cannot be mapped. The admin adjusts visibility afterwards.
    await tx.insert(quickAnswers).values({ name, body, attachmentPath, visibility: 'all', ownerId: null });
    names.add(name);
    r.quickAnswers.created++;
  }
}

export async function importUmbler(deps: ImportDeps): Promise<ImportReport> {
  const data = await fetchUmbler(deps); // phase 1: read everything, touch nothing

  const counts = (): ImportCounts => ({ created: 0, existing: 0 });
  const report: ImportReport = {
    dryRun: deps.dryRun,
    organization: data.org.name,
    sectors: counts(),
    tags: counts(),
    customFields: { ...counts(), unsupported: [] },
    contacts: { ...counts(), skippedInvalidPhone: [] },
    quickAnswers: { ...counts(), attachments: 0, attachmentErrors: [] },
    unmappedVariables: [],
  };

  // Phase 2: one transaction. Dry-run takes the same path and rolls back, so its counts are exact.
  try {
    await deps.db.transaction(async (tx) => {
      await importSectors(tx, data.sectorList, report);
      const tagIds = await importTags(tx, data.tagList, report);
      const fields = await importFields(tx, data.fieldDefs, report);
      await importContacts(tx, data.contactList, tagIds, fields, report);
      await importQuickAnswers(tx, data.qaDetails, deps, report);
      if (deps.dryRun) tx.rollback();
    });
  } catch (err) {
    if (!(err instanceof TransactionRollbackError)) throw err;
  }
  return report;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w server -- test/importer/umbler.test.ts`
Expected: PASS (7 tests).

If only the `{{contato.primeiro_nome}}` assertion fails, `convertUmblerVariables` in `messages/quick-answers.ts` maps Umbler's `Contato.PrimeiroNome` to some other name. Fix that mapping there to match spec §5.7. Do not change this test.

- [ ] **Step 5: Write the CLI and the npm script**

Create `server/src/importer/cli.ts`:

```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { createPgDb } from '../db/client.js';
import { importUmbler } from './umbler.js';

// One-off import at go-live, after the app has started once (migrations applied):
//   npm run import:umbler -w server -- --token <UMBLER_TOKEN> --dry-run   (simulate, prints the report)
//   npm run import:umbler -w server -- --token <UMBLER_TOKEN>             (imports, saves the report)
// Production: docker compose exec app npm run import:umbler -w server -- --token <UMBLER_TOKEN>
// UMBLER_TOKEN in the environment works too and keeps the token out of shell history and `ps`.
const USAGE = 'Uso: npm run import:umbler -w server -- --token <UMBLER_TOKEN> [--dry-run]';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { token: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } },
  });
  const token = values.token ?? process.env.UMBLER_TOKEN;
  if (!token) throw new Error(USAGE);
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL não definido');
  const mediaDir = process.env.MEDIA_DIR ?? '/data/media';

  const report = await importUmbler({ db: createPgDb(url), mediaDir, token, dryRun: values['dry-run'] === true });
  const json = JSON.stringify(report, null, 2);
  console.log(json);

  if (report.dryRun) {
    console.error('Simulação: nada foi gravado.');
    return;
  }
  // data/import-report.json, next to data/media (/data/import-report.json in production).
  const file = join(dirname(mediaDir), 'import-report.json');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${json}\n`);
  console.error(`Relatório gravado em ${file}`);
}

main().then(
  () => process.exit(0), // postgres.js keeps the pool open; exit explicitly
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
```

Add the script:

```bash
npm pkg set -w server "scripts.import:umbler=tsx src/importer/cli.ts"
```

Expected: `server/package.json` → `"scripts"` contains `"import:umbler": "tsx src/importer/cli.ts"`.

- [ ] **Step 6: Verify the CLI wiring and typecheck**

Run: `npm run import:umbler -w server`
Expected: exit code 1 and stderr `Uso: npm run import:umbler -w server -- --token <UMBLER_TOKEN> [--dry-run]`. No network or DB access happens, because the token check runs first.

Run: `npm run typecheck -w server`
Expected: exit 0 with no errors.

Run: `npm test -w server`
Expected: the whole server suite PASSES.

- [ ] **Step 7: Commit**

```bash
git add server/src/importer/umbler.ts server/src/importer/cli.ts server/test/importer/umbler.test.ts server/package.json
git commit -m "feat(importer): idempotent Umbler Talk import of sectors, tags, fields, contacts and quick answers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


---

### Task 21: Deployment, backup and runbook

This task puts the system on one VPS: one image for the app, a Compose stack (Caddy, app, Postgres 16, Evolution API v2.3.7), secrets generated at install time, a daily backup, and a README in Portuguese with the runbook from spec §6/§8. Only Caddy publishes ports. Postgres and Evolution stay on the internal Docker network, and Caddy returns 404 for `/webhooks/*`.

Decisions that differ from the literal requirement text:
- The Postgres init script is `scripts/init-db.sh`, not `scripts/init-db.sql`. Init scripts cannot read `.env`, and the role passwords come from environment variables.
- `app` gets an explicit `environment:` list built from `.env` by Compose interpolation, not `env_file: .env`. With `env_file`, the app container would receive the Postgres superuser password and the Evolution DB password, which it never needs.
- `app` mounts only `./data/media`. `backup.sh` runs on the host and writes `./data/backup` directly, so no container needs the backup folder. A container that can read the backup could read the full dump of both databases.
- The app connects as its own role `talk`, owner of database `talk`, not as the Postgres superuser. `evolution` has its own role too (§6).
- The server is not compiled (Task 1): `tsx` is a runtime dependency that survives `npm prune --omit=dev`. The image only builds `web`, and the app, the admin seed and the importer all run as `node --import tsx server/src/….ts`.
- No earlier task serves the SPA, so this task adds it to `buildApp` (Steps 8a–8e): `@fastify/static` on `config.webDistDir`, plus an `index.html` fallback for GET deep links outside `/api`, `/ws` and `/webhooks`.

**Files:**
- Create: `.env.example`
- Create: `scripts/gen-secrets.sh`
- Create: `scripts/backup.sh`
- Create: `scripts/init-db.sh`
- Create: `scripts/test-scripts.sh`
- Create: `Dockerfile`
- Create: `.dockerignore`
- Create: `docker-compose.yml`
- Create: `Caddyfile`
- Create: `.gitattributes` (if Task 1 already created it, append the two lines instead)
- Modify: `.gitignore` (make sure `.env` and `data/` are ignored)
- Create: `README.md` (replace any stub left by Task 1)
- Modify: `server/src/app.ts` (SPA static + fallback, last thing before `return app;`)
- Test: `scripts/test-scripts.sh` (shell, runs in `alpine:3.20`)
- Test: `server/test/spa.test.ts`

**Interfaces:**
- Consumes:
  - **Task 1:**
    - Root `package.json` has `"workspaces": ["shared", "server", "web"]`, and a `package-lock.json` is committed.
    - The server is not compiled: it has no `build` script and runs as `node --import tsx src/index.ts`. `tsx` is a runtime dependency, so `npm prune --omit=dev` keeps it.
    - `npm run build -w web` emits `web/dist/index.html` plus `web/dist/assets/*`.
    - `@fastify/static@10.1.6` is already installed in `server`.
    - `GET /api/health` → 200.
    - `buildApp(ctx)` in `server/src/app.ts` ends with `return app;`. `Config.webDistDir: string | null`, where `WEB_DIST_DIR=""` gives `null`.
  - **Task 2:** `migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url))`. From `server/src/db/client.ts` this resolves to `server/drizzle`, so the image must contain `server/drizzle/`.
  - **Task 6:** the global auth `onRequest` hook answers 401 to anonymous `/api/*`, including unknown `/api/*` paths. The SPA test therefore logs in before it checks the `/api` 404.
  - **Tasks 12–14:** each registers its routes before the final `return app;`. The SPA fallback added here must stay the last registration.
  - **Contract `Config` env names:** `PORT`, `DATABASE_URL`, `APP_ORIGIN`, `COOKIE_SECURE`, `WEBHOOK_SECRET` (≥ 32 chars), `WEBHOOK_BASE_URL`, `MEDIA_DIR`, `WEB_DIST_DIR`, `EVOLUTION_URL`, `EVOLUTION_API_KEY`.
  - **Task 6:**
    - `server/src/auth/seed-admin.ts` CLI (run as `node --import tsx server/src/auth/seed-admin.ts`): `--email <e> --name <n>`, with the password from `SEED_ADMIN_PASSWORD` or a prompt. Prints `Administrador criado: <email>`.
    - `POST /api/auth/login` requires `Origin === APP_ORIGIN` and returns `Me`.
  - **Task 14:**
    - `server/src/index.ts` runs `runMigrations` at startup and listens on `0.0.0.0:PORT`.
    - It closes the server on SIGTERM.
    - Channels create Evolution instances whose webhook is `${WEBHOOK_BASE_URL}/webhooks/evolution/${WEBHOOK_SECRET}`.
  - **Task 20:** `server/src/importer/cli.ts` (run as `node --import tsx server/src/importer/cli.ts`) reads the Umbler token from env `UMBLER_TOKEN` and prints its report to stdout. After a real import it also writes `<dirname(MEDIA_DIR)>/import-report.json` = `/data/import-report.json`, so `/data` must be writable by `node`. If Task 20 chose different argument names, update README section "Importar do Umbler Talk" to match.
- Produces, for operators and later sub-projects (no code symbols):
  - Compose services:
    - `caddy` publishes 80 and 443.
    - `app` is at `http://app:3000`.
    - `postgres` has databases `talk` (owner `talk`) and `evolution` (owner `evolution`). The superuser is `postgres`.
    - `evolution` is at `http://evolution:8080`, with header `apikey: $EVOLUTION_API_KEY`.
  - App `DATABASE_URL` = `postgres://talk:${POSTGRES_TALK_PASSWORD}@postgres:5432/talk`.
  - Host folders `./data/media` (mounted at `/data/media`, owned by uid 1000) and `./data/backup` (`db.sql`, `media.tar.gz`).
  - Install directory used in all docs: `/opt/talk`.

---

- [ ] **Step 1: Write the failing script test**

Create `scripts/test-scripts.sh`:

```sh
#!/bin/sh
# Testa gen-secrets.sh e backup.sh sem Docker real (o "docker" é falso).
# Rode num Linux. No Windows/macOS:
#   docker run --rm -v "${PWD}:/w" -w /w alpine:3.20 sh scripts/test-scripts.sh
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
fail() { echo "FALHOU: $1" >&2; exit 1; }

mkdir -p "$T/scripts" "$T/bin"
cp "$ROOT/.env.example" "$T/"
cp "$ROOT/scripts/gen-secrets.sh" "$ROOT/scripts/backup.sh" "$T/scripts/"

# --- gen-secrets.sh ---
sh "$T/scripts/gen-secrets.sh" talk.exemplo.com.br >/dev/null
grep -qx 'DOMAIN=talk.exemplo.com.br' "$T/.env" || fail "DOMAIN não gravado"
grep -qx 'APP_ORIGIN=https://talk.exemplo.com.br' "$T/.env" || fail "APP_ORIGIN não gravado"
! grep -q 'troque' "$T/.env" || fail "sobrou valor de exemplo no .env"
KEYS='WEBHOOK_SECRET|EVOLUTION_API_KEY|POSTGRES_PASSWORD|POSTGRES_TALK_PASSWORD|POSTGRES_EVOLUTION_PASSWORD'
[ "$(grep -Ec "^($KEYS)=[0-9a-f]{64}$" "$T/.env")" -eq 5 ] || fail "segredos ausentes ou fora do formato hex de 64"
[ "$(grep -E "^($KEYS)=" "$T/.env" | cut -d= -f2 | sort -u | wc -l)" -eq 5 ] || fail "segredos repetidos"
[ "$(stat -c %a "$T/.env")" = 600 ] || fail "permissão do .env não é 600"
cp "$T/.env" "$T/env-antes"
if sh "$T/scripts/gen-secrets.sh" outro.com.br >/dev/null 2>&1; then fail "gen-secrets aceitou sobrescrever .env"; fi
cmp -s "$T/.env" "$T/env-antes" || fail ".env existente foi alterado"

# --- backup.sh ---
mkdir -p "$T/data/media/2026/10" "$T/data/backup"
echo foto > "$T/data/media/2026/10/a.jpg"
cat > "$T/bin/docker" <<'EOF'
#!/bin/sh
[ -n "${FAKE_DOCKER_FAIL:-}" ] && { echo "dump parcial"; exit 1; }
echo "-- dump novo"
EOF
chmod +x "$T/bin/docker"
echo "-- dump bom" > "$T/data/backup/db.sql"

if FAKE_DOCKER_FAIL=1 PATH="$T/bin:$PATH" sh "$T/scripts/backup.sh" >/dev/null 2>&1; then fail "backup com dump falho terminou com sucesso"; fi
[ "$(cat "$T/data/backup/db.sql")" = "-- dump bom" ] || fail "dump com falha sobrescreveu o db.sql bom"

PATH="$T/bin:$PATH" sh "$T/scripts/backup.sh" >/dev/null
[ "$(cat "$T/data/backup/db.sql")" = "-- dump novo" ] || fail "dump novo não foi gravado"
tar -tzf "$T/data/backup/media.tar.gz" | grep -q 'media/2026/10/a.jpg' || fail "mídia ausente do media.tar.gz"
[ ! -e "$T/data/backup/media.tar.gz.tmp" ] || fail "sobrou media.tar.gz.tmp"

echo "OK: scripts testados"
```

- [ ] **Step 2: Run it to verify it fails**

Run (from repo root; PowerShell or bash):
`docker run --rm -v "${PWD}:/w" -w /w alpine:3.20 sh scripts/test-scripts.sh`

Expected: FAIL. Exit code 1 with `cp: can't stat '/w/.env.example': No such file or directory`.

- [ ] **Step 3: Write `.env.example`**

Create `.env.example`:

```dotenv
# Modelo do .env. NÃO copie à mão: rode `sh scripts/gen-secrets.sh SEU-DOMINIO`,
# que gera o .env com segredos aleatórios e chmod 600.
# Este arquivo vai para o git; o .env (com os segredos) NUNCA.

# Endereço público do sistema. O Caddy emite o certificado HTTPS para este domínio.
DOMAIN=talk.exemplo.com.br
# Tem que ser exatamente https:// + DOMAIN (proteção contra CSRF: checagem de Origin).
APP_ORIGIN=https://talk.exemplo.com.br
# true em produção (cookie só via HTTPS). false só em teste local sem HTTPS.
COOKIE_SECURE=true

# Segredos: hex de 64 caracteres, gerados por scripts/gen-secrets.sh.
# Guarde uma cópia do .env FORA do servidor (gerenciador de senhas): sem ele não há restauração.
WEBHOOK_SECRET=troque-com-gen-secrets
EVOLUTION_API_KEY=troque-com-gen-secrets
POSTGRES_PASSWORD=troque-com-gen-secrets
POSTGRES_TALK_PASSWORD=troque-com-gen-secrets
POSTGRES_EVOLUTION_PASSWORD=troque-com-gen-secrets

# Definidos pelo docker-compose.yml / Dockerfile; não precisam estar aqui:
# PORT=3000
# DATABASE_URL=postgres://talk:(POSTGRES_TALK_PASSWORD)@postgres:5432/talk
# EVOLUTION_URL=http://evolution:8080
# WEBHOOK_BASE_URL=http://app:3000
# MEDIA_DIR=/data/media
# WEB_DIST_DIR=/app/web/dist
```

The placeholder `troque-com-gen-secrets` is 22 characters, so `loadConfig` rejects it as `WEBHOOK_SECRET`, which needs at least 32. An install that skipped `gen-secrets.sh` therefore refuses to start instead of running with a public secret.

- [ ] **Step 4: Write `scripts/gen-secrets.sh`**

Create `scripts/gen-secrets.sh`:

```sh
#!/bin/sh
# Uso: sh scripts/gen-secrets.sh talk.seudominio.com.br
# Cria o .env a partir do .env.example com segredos aleatórios (32 bytes em hex).
# Nunca sobrescreve um .env existente.
set -eu
cd "$(dirname "$0")/.."
DOMAIN=${1:?Informe o domínio. Ex.: sh scripts/gen-secrets.sh talk.jvo.adv.br}
if [ -e .env ]; then
  echo "Já existe um .env; nada foi alterado. Apague-o antes se quiser gerar outro." >&2
  exit 1
fi
secret() { od -An -tx1 -N32 /dev/urandom | tr -d ' \n'; }
umask 077
sed -e "s|^DOMAIN=.*|DOMAIN=$DOMAIN|" \
    -e "s|^APP_ORIGIN=.*|APP_ORIGIN=https://$DOMAIN|" \
    -e "s|^WEBHOOK_SECRET=.*|WEBHOOK_SECRET=$(secret)|" \
    -e "s|^EVOLUTION_API_KEY=.*|EVOLUTION_API_KEY=$(secret)|" \
    -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(secret)|" \
    -e "s|^POSTGRES_TALK_PASSWORD=.*|POSTGRES_TALK_PASSWORD=$(secret)|" \
    -e "s|^POSTGRES_EVOLUTION_PASSWORD=.*|POSTGRES_EVOLUTION_PASSWORD=$(secret)|" \
    .env.example > .env
chmod 600 .env
echo ".env criado (chmod 600). Guarde uma cópia FORA do servidor (gerenciador de senhas)."
```

- [ ] **Step 5: Write `scripts/backup.sh`**

Create `scripts/backup.sh`:

```sh
#!/bin/sh
# Backup diário: dump dos DOIS bancos (talk + evolution, que guarda a sessão do WhatsApp
# e cópias de mensagens de clientes) e da pasta de mídia.
# Cron (root):  30 3 * * * sh /opt/talk/scripts/backup.sh >> /var/log/talk-backup.log 2>&1
set -eu
cd "$(dirname "$0")/.."
mkdir -p data/backup

# Grava em .tmp e só renomeia no fim: um dump com falha nunca sobrescreve o último bom.
docker compose exec -T postgres pg_dumpall -U postgres --clean --if-exists > data/backup/db.sql.tmp
mv data/backup/db.sql.tmp data/backup/db.sql

tar -czf data/backup/media.tar.gz.tmp -C data media
mv data/backup/media.tar.gz.tmp data/backup/media.tar.gz

echo "$(date -Iseconds) backup ok"

# --- Cópia FORA do servidor com restic (use se o provedor do VPS NÃO tiver backup externo) ---
# Este bloco envia o dump e a mídia, criptografados, para o Backblaze B2.
# 1. sudo apt install restic
# 2. Crie um bucket privado no Backblaze B2 e uma Application Key só para ele.
# 3. Crie /root/.restic-env (sudo chmod 600 /root/.restic-env) com:
#      export B2_ACCOUNT_ID=id-da-application-key
#      export B2_ACCOUNT_KEY=application-key
#      export RESTIC_REPOSITORY=b2:nome-do-bucket:talk
#      export RESTIC_PASSWORD=senha-longa-aleatoria
#    Guarde RESTIC_PASSWORD também FORA do VPS. Sem ela o backup é ilegível.
# 4. Uma vez só: sudo sh -c '. /root/.restic-env && restic init'
# 5. Descomente as três linhas abaixo:
# . /root/.restic-env
# restic backup data/backup/db.sql data/media --tag talk
# restic forget --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune
```

- [ ] **Step 6: Make shell scripts LF-only and keep secrets out of git**

Create `.gitattributes`. If it already exists, append these lines.

```gitattributes
*.sh text eol=lf
.env.example text eol=lf
```

Run (bash, from repo root):

```bash
touch .gitignore
grep -qxF '.env' .gitignore || echo '.env' >> .gitignore
grep -qxF 'data/' .gitignore || echo 'data/' >> .gitignore
git check-ignore .env data/backup/db.sql
```

Expected: the last command prints `.env` and `data/backup/db.sql`.

- [ ] **Step 7: Run the script test to verify it passes**

Run: `docker run --rm -v "${PWD}:/w" -w /w alpine:3.20 sh scripts/test-scripts.sh`

Expected: PASS. The output is `OK: scripts testados`, with exit code 0.

- [ ] **Step 8: Commit**

```bash
git add .env.example scripts/gen-secrets.sh scripts/backup.sh scripts/test-scripts.sh .gitattributes .gitignore
git update-index --chmod=+x scripts/gen-secrets.sh scripts/backup.sh scripts/test-scripts.sh
git commit -m "feat(deploy): secret generation and atomic backup scripts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 8a: Write the failing SPA fallback test**

Create `server/test/spa.test.ts`:

```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loginAs, makeTestApp, makeTestCtx, seedBasics } from './helpers.js';

let dir: string;
let app: FastifyInstance;
let adminEmail: string;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'talk-web-'));
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><div id="root"></div>');
  const ctx = await makeTestCtx();
  const s = await seedBasics(ctx);
  adminEmail = s.admin.email;
  ({ app } = await makeTestApp({ ...ctx, config: { ...ctx.config, webDistDir: dir } }));
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('SPA static + fallback', () => {
  it('serves index.html for a deep link', async () => {
    const res = await app.inject({ method: 'GET', url: '/conversas/x' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('id="root"');
  });

  it('serves index.html at /', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('id="root"');
  });

  it('keeps unknown /api routes as JSON 404', async () => {
    const { headers } = await loginAs(app, adminEmail);
    const res = await app.inject({ method: 'GET', url: '/api/nada', headers });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Não encontrado' });
  });
});
```

- [ ] **Step 8b: Run it to verify it fails**

Run: `npm test -w server -- test/spa.test.ts`

Expected: FAIL. `serves index.html for a deep link` and `serves index.html at /` get 404 instead of 200, and the `/api/nada` test gets Fastify's default 404 body (`{"message":"Route GET:/api/nada not found",…}`) instead of `{ error: 'Não encontrado' }`.

- [ ] **Step 8c: Serve the SPA from `buildApp`**

In `server/src/app.ts`, insert this block as the **last thing before the final `return app;`**, after every route registration added by Tasks 1–20:

```ts
  // SPA: static files from web/dist, and index.html for GET deep links (/conversas/<id>, ...).
  // Must stay the last registration in buildApp. WEB_DIST_DIR="" (webDistDir null) disables it.
  if (ctx.config.webDistDir) {
    await app.register((await import('@fastify/static')).default, { root: ctx.config.webDistDir, wildcard: false });
    app.setNotFoundHandler((req, reply) =>
      req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/ws') && !req.url.startsWith('/webhooks')
        ? reply.sendFile('index.html')
        : reply.code(404).send({ error: 'Não encontrado' }),
    );
  }
```

- [ ] **Step 8d: Run it to verify it passes**

Run: `npm test -w server -- test/spa.test.ts`

Expected: PASS (3 tests). Then run `npm test -w server`. Expected: the whole server suite still PASSES.

- [ ] **Step 8e: Commit**

```bash
git add server/src/app.ts server/test/spa.test.ts
git commit -m "feat(server): serve the SPA with an index.html fallback for deep links

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 9: Write the Postgres init script**

Create `scripts/init-db.sh`:

```sh
#!/bin/sh
# Roda UMA vez, na primeira subida do Postgres (volume vazio), via /docker-entrypoint-initdb.d.
# Cria os bancos talk (app) e evolution (Evolution API), cada um com usuário próprio.
# Sem `set -u`: o entrypoint do Postgres pode executar este arquivo com `source`.
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres \
  -v talk_pass="$POSTGRES_TALK_PASSWORD" \
  -v evo_pass="$POSTGRES_EVOLUTION_PASSWORD" <<'SQL'
CREATE ROLE talk LOGIN PASSWORD :'talk_pass';
CREATE DATABASE talk OWNER talk;
CREATE ROLE evolution LOGIN PASSWORD :'evo_pass';
CREATE DATABASE evolution OWNER evolution;
SQL
```

- [ ] **Step 10: Write the Dockerfile and `.dockerignore`**

Create `.dockerignore`:

```gitignore
**/node_modules
**/dist
.env
.env.*
!.env.example
data
screenshots
docs
.git
```

Create `Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1

# --- build: instala tudo, compila só o web (o server roda com tsx), remove dependências de desenvolvimento ---
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build -w web && npm prune --omit=dev

# --- runtime ---
FROM node:24-alpine
ENV NODE_ENV=production \
    PORT=3000 \
    MEDIA_DIR=/data/media \
    WEB_DIST_DIR=/app/web/dist
WORKDIR /app
# ponytail: copies the whole pruned workspace (server runs from source via tsx). Trim web/src etc. if image size ever matters.
COPY --from=build /app /app
# /data também do node: o importador grava /data/import-report.json ao lado de /data/media.
RUN mkdir -p /data/media && chown node:node /data /data/media
USER node
EXPOSE 3000
CMD ["node", "--import", "tsx", "server/src/index.ts"]
```

- [ ] **Step 11: Write the Caddyfile**

Create `Caddyfile`:

```caddyfile
{$DOMAIN} {
	encode zstd gzip

	# O webhook da Evolution chega só pela rede interna do Docker (http://app:3000).
	# Pela internet, /webhooks responde 404 sem tocar no app.
	@webhooks path /webhooks /webhooks/*
	respond @webhooks 404

	# Também encaminha o upgrade de /ws (WebSocket) e mantém o cabeçalho Origin.
	reverse_proxy app:3000
}
```

- [ ] **Step 12: Write `docker-compose.yml`**

The Evolution variable names below come from `.env.example` at tag `2.3.7` of `EvolutionAPI/evolution-api`. Note `DATABASE_SAVE_MESSAGE_UPDATE` (not `DATABASE_SAVE_DATA_MESSAGE_UPDATE`) and the `DATABASE_SAVE_DATA_` prefix on the other save flags.

Create `docker-compose.yml`:

```yaml
name: talk

# Rotação de logs: sem isto o json-file cresce até encher o disco do VPS.
x-logging: &logging
  driver: json-file
  options:
    max-size: 10m
    max-file: "3"

services:
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    environment:
      DOMAIN: ${DOMAIN:?defina DOMAIN no .env}
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - app
    logging: *logging

  app:
    build: .
    restart: unless-stopped
    environment:
      APP_ORIGIN: ${APP_ORIGIN:?defina APP_ORIGIN no .env}
      COOKIE_SECURE: ${COOKIE_SECURE:-true}
      WEBHOOK_SECRET: ${WEBHOOK_SECRET:?rode scripts/gen-secrets.sh}
      EVOLUTION_API_KEY: ${EVOLUTION_API_KEY:?rode scripts/gen-secrets.sh}
      DATABASE_URL: postgres://talk:${POSTGRES_TALK_PASSWORD:?rode scripts/gen-secrets.sh}@postgres:5432/talk
      EVOLUTION_URL: http://evolution:8080
      WEBHOOK_BASE_URL: http://app:3000
      PORT: "3000"
      MEDIA_DIR: /data/media
    volumes:
      - ./data/media:/data/media
    depends_on:
      postgres:
        condition: service_healthy
    logging: *logging

  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?rode scripts/gen-secrets.sh}
      POSTGRES_TALK_PASSWORD: ${POSTGRES_TALK_PASSWORD:?rode scripts/gen-secrets.sh}
      POSTGRES_EVOLUTION_PASSWORD: ${POSTGRES_EVOLUTION_PASSWORD:?rode scripts/gen-secrets.sh}
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./scripts/init-db.sh:/docker-entrypoint-initdb.d/init-db.sh:ro
    healthcheck:
      # -h 127.0.0.1: durante o init o servidor temporário só escuta no socket, então só fica "healthy" depois do init.
      test: ["CMD", "pg_isready", "-h", "127.0.0.1", "-U", "postgres"]
      interval: 5s
      timeout: 3s
      retries: 30
    logging: *logging

  evolution:
    # Tag exata, nunca latest. Ao atualizar, anote a tag anterior (README › Atualizar a Evolution API).
    image: evoapicloud/evolution-api:v2.3.7
    restart: unless-stopped
    environment:
      SERVER_URL: http://evolution:8080
      AUTHENTICATION_API_KEY: ${EVOLUTION_API_KEY:?rode scripts/gen-secrets.sh}
      DATABASE_PROVIDER: postgresql
      DATABASE_CONNECTION_URI: postgresql://evolution:${POSTGRES_EVOLUTION_PASSWORD:?rode scripts/gen-secrets.sh}@postgres:5432/evolution?schema=evolution_api
      DATABASE_SAVE_DATA_INSTANCE: "true"
      DATABASE_SAVE_DATA_NEW_MESSAGE: "true"
      DATABASE_SAVE_MESSAGE_UPDATE: "true"
      DATABASE_SAVE_DATA_HISTORIC: "false"
      DATABASE_SAVE_DATA_CONTACTS: "false"
      DATABASE_SAVE_DATA_CHATS: "false"
      DATABASE_SAVE_DATA_LABELS: "false"
      CACHE_REDIS_ENABLED: "false"
      CACHE_LOCAL_ENABLED: "true"
      WEBHOOK_GLOBAL_ENABLED: "false"
      TELEMETRY_ENABLED: "false"
      LOG_LEVEL: ERROR,WARN,INFO
      CONFIG_SESSION_PHONE_CLIENT: Atendimento
    volumes:
      - evolution_instances:/evolution/instances
    depends_on:
      postgres:
        condition: service_healthy
    logging: *logging

volumes:
  pgdata:
  caddy_data:
  caddy_config:
  evolution_instances:
```

- [ ] **Step 13: Validate the Compose file**

Run in bash (Git Bash on Windows), from repo root. The commands create a throwaway local `.env`, which Step 18 deletes.

```bash
sh scripts/gen-secrets.sh localhost
sed -i -e 's|^DOMAIN=.*|DOMAIN=http://localhost|' \
       -e 's|^APP_ORIGIN=.*|APP_ORIGIN=http://localhost|' \
       -e 's|^COOKIE_SECURE=.*|COOKIE_SECURE=false|' .env
mkdir -p data/media data/backup
docker compose config --quiet && echo COMPOSE_OK
```

Expected: `.env criado (chmod 600)...` and then `COMPOSE_OK`, with no errors. With `DOMAIN=http://localhost`, Caddy serves plain HTTP on port 80 and creates no certificate.

- [ ] **Step 14: Build the image**

Run: `docker compose build app`

Expected:
- The build finishes with the image built for service `app`.
- `npm ci` and `npm run build -w web` complete with no `npm error`.

If `npm ci` fails on `@node-rs/argon2`, the lockfile is missing the musl binary. Regenerate it with `npm install --package-lock-only` and rebuild.

- [ ] **Step 15: Smoke test the stack**

Run (bash, from repo root):

```bash
docker compose up -d
timeout 180 sh -c 'until curl -fsS -o /dev/null http://localhost/api/health; do sleep 2; done'
curl -s -o /dev/null -w 'health %{http_code}\n' http://localhost/api/health
curl -s -o /dev/null -w 'webhook-pela-internet %{http_code}\n' -X POST http://localhost/webhooks/evolution/qualquer
curl -fsS http://localhost/ | grep -c '<script type="module"'
docker compose ps --format '{{.Service}} {{.Ports}}'
docker compose exec -T postgres psql -U postgres -Atc "select datname || ':' || pg_get_userbyid(datdba) from pg_database where datname in ('talk','evolution') order by 1"
```

Expected:
- `health 200`.
- `webhook-pela-internet 404`. Caddy blocked the request; the app itself would have answered 401 for the wrong secret.
- `1`, meaning the SPA `index.html` is served.
- In the `ps` output, only `caddy` lists host ports (`0.0.0.0:80->80/tcp`, `0.0.0.0:443->443/tcp`, …). The `app`, `postgres` and `evolution` lines show no `0.0.0.0` mapping.
- `evolution:evolution` and `talk:talk`.

- [ ] **Step 16: Smoke test the admin seed, login and Evolution key**

Run (bash):

```bash
docker compose exec -T -e SEED_ADMIN_PASSWORD=senha-smoke-123 app node --import tsx server/src/auth/seed-admin.ts --email admin@teste.local --name Admin
curl -fsS -X POST http://localhost/api/auth/login -H 'Origin: http://localhost' -H 'Content-Type: application/json' -d '{"email":"admin@teste.local","password":"senha-smoke-123"}'
curl -s -o /dev/null -w 'login-sem-origin %{http_code}\n' -X POST http://localhost/api/auth/login -H 'Content-Type: application/json' -d '{"email":"admin@teste.local","password":"senha-smoke-123"}'
docker compose exec -T app sh -c 'wget -qO- --header "apikey: $EVOLUTION_API_KEY" http://evolution:8080/instance/fetchInstances'
```

Expected:
- `Administrador criado: admin@teste.local`.
- A JSON `Me` with `"role":"admin"`. This proves the argon2 native binary loads on Alpine/musl.
- `login-sem-origin 403`.
- `[]`, meaning Evolution is up, its database is migrated and the generated key is accepted. If this prints `Connection refused`, Evolution is still running its own migrations. Wait 30 s and repeat the last command.

- [ ] **Step 17: Rehearse backup and restore (spec §8)**

This step destroys the local smoke-test database volume. Run it only on the dev machine.

```bash
sh scripts/backup.sh
ls -l data/backup
docker compose down -v
rm -rf data/media && tar -xzf data/backup/media.tar.gz -C data
docker compose up -d postgres
timeout 120 sh -c 'until docker compose exec -T postgres pg_isready -h 127.0.0.1 -U postgres; do sleep 2; done'
docker compose exec -T postgres psql -U postgres -d postgres < data/backup/db.sql > /dev/null
docker compose up -d
timeout 180 sh -c 'until curl -fsS -o /dev/null http://localhost/api/health; do sleep 2; done'
curl -fsS -X POST http://localhost/api/auth/login -H 'Origin: http://localhost' -H 'Content-Type: application/json' -d '{"email":"admin@teste.local","password":"senha-smoke-123"}'
```

Expected:
- `backup ok`, and `data/backup` lists `db.sql` and `media.tar.gz`.
- During `psql`, at most two errors that mention the role `postgres`: `current user cannot be dropped` and `role "postgres" already exists`. Postgres documents these as expected when a `pg_dumpall --clean` dump is restored by the same superuser.
- The final login returns the same admin `Me`. The `talk` database came back from the dump, and the startup migrations found nothing to apply.

- [ ] **Step 18: Tear down and commit**

```bash
docker compose down -v
rm -rf data .env
git add Dockerfile .dockerignore docker-compose.yml Caddyfile scripts/init-db.sh
git update-index --chmod=+x scripts/init-db.sh
git commit -m "feat(deploy): Docker image and Compose stack with Caddy, Postgres 16 and Evolution v2.3.7

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 19: Write the README (Portuguese runbook)**

Create `README.md`:

````markdown
# Atendimento WhatsApp do escritório

Sistema próprio de atendimento pelo WhatsApp que substitui o Umbler Talk.

Um VPS roda, via Docker Compose:

- **caddy**: HTTPS automático, a única porta aberta;
- **app**: API, tempo real e telas;
- **postgres**: bancos `talk` e `evolution`;
- **evolution**: a ponte com o WhatsApp, conectada por QR Code.

A mídia fica em `/opt/talk/data/media` e os backups em `/opt/talk/data/backup`.

> Segurança:
> - O arquivo `.env` contém todos os segredos. Ele nunca vai para o git.
> - Guarde uma cópia do `.env` fora do servidor, num gerenciador de senhas. Sem ela não há restauração.
> - O banco `evolution` também guarda cópias de mensagens de clientes. Ele entra no backup e segue as mesmas regras da LGPD do banco `talk`.

## 1. Requisitos do VPS

- Ubuntu 24.04 LTS, 2 vCPU, 4 GB de RAM, 40 GB de disco ou mais (a mídia cresce com o uso).
- Um domínio, por exemplo `talk.jvo.adv.br`, com registro DNS **A** apontando para o IP do VPS.
- Portas 80 e 443 liberadas no firewall do provedor. Só o Caddy publica portas: Postgres e Evolution ficam na rede interna do Docker.
- Backup automático ou snapshot do provedor ativado. Confirme no painel que a cópia fica **fora** do VPS e anote a retenção. Se o provedor não oferecer, use o restic (seção 7.1).

## 2. Instalação passo a passo

```bash
# 1. Docker
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"   # saia e entre de novo no SSH

# 2. Firewall
sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw enable

# 3. Código
sudo mkdir -p /opt/talk && sudo chown "$USER" /opt/talk
git clone URL-DO-REPOSITORIO /opt/talk
cd /opt/talk

# 4. Segredos (gera .env com chmod 600; troque pelo seu domínio)
sh scripts/gen-secrets.sh talk.jvo.adv.br

# 5. Pastas de dados (o app roda como usuário 1000 dentro do container)
mkdir -p data/media data/backup
sudo chown -R 1000:1000 data/media

# 6. Subir tudo (a primeira vez compila a imagem: alguns minutos)
docker compose up -d --build
docker compose ps
curl -fsS https://talk.jvo.adv.br/api/health
```

- O Postgres cria os bancos `talk` e `evolution` na primeira subida (`scripts/init-db.sh`).
- O app aplica as migrations sozinho toda vez que inicia.
- Se o `curl` falhar logo no início, espere um minuto: o Caddy ainda está emitindo o certificado.

## 3. Primeiro administrador

```bash
cd /opt/talk
read -rs -p 'Senha do administrador (mín. 8): ' SEED_ADMIN_PASSWORD; echo; export SEED_ADMIN_PASSWORD
docker compose exec -e SEED_ADMIN_PASSWORD app node --import tsx server/src/auth/seed-admin.ts --email voce@jvo.adv.br --name "Seu Nome"
unset SEED_ADMIN_PASSWORD
```

Saída esperada: `Administrador criado: voce@jvo.adv.br`.

Depois disso, entre em `https://talk.jvo.adv.br` e crie os demais usuários pela tela de Configurações.

## 4. Conectar o WhatsApp

1. Entre como administrador e vá em **Configurações → Canal WhatsApp**.
2. Crie o canal e clique em **Gerar novo QR / Reconectar**.
3. No celular do escritório: WhatsApp → **Aparelhos conectados** → **Conectar um aparelho** → leia o QR.
4. O status muda para **Conectado** e o banner vermelho "WhatsApp desconectado" some.

Atenção: conectar o mesmo número aqui desconecta o número do Umbler Talk. Faça isso só no dia da virada (seção 10).

Se o canal cair (logout pelo celular, QR expirado), repita os passos 2 e 3. O botão **Gerar novo QR / Reconectar** serve para isso.

## 5. Importar do Umbler Talk

O importador traz contatos, setores, etiquetas, campos personalizados e respostas rápidas, com anexos e variáveis. O histórico de conversas fica no Umbler.

1. No Umbler Talk: **Conta → Perfil → Tokens de acesso** → crie um token.
2. No servidor:

```bash
cd /opt/talk
read -rs -p 'Token do Umbler: ' UMBLER_TOKEN; echo; export UMBLER_TOKEN
docker compose exec -e UMBLER_TOKEN app node --import tsx server/src/importer/cli.ts | tee data/backup/relatorio-importacao.txt
unset UMBLER_TOKEN
```

3. Leia o relatório. Ele sai na tela, e o `tee` acima já guarda uma cópia em `data/backup/relatorio-importacao.txt`. Dentro do container, o importador também grava `/data/import-report.json`. Ele lista o que não pôde ser convertido, como variáveis `{{n}}` sem correspondência ou anexos que não baixaram. Corrija esses itens à mão na tela de Configurações.
4. Apague o token no Umbler depois da importação.

## 6. Atualizar

### 6.1 Atualizar o sistema

```bash
cd /opt/talk
sh scripts/backup.sh                       # sempre antes de atualizar
git log -1 --format=%h > data/backup/versao-anterior.txt
git pull
docker compose up -d --build app
docker compose logs --tail 50 app          # migrations aplicadas, sem erro
curl -fsS https://talk.jvo.adv.br/api/health
```

**Voltar a versão** se algo quebrar:

```bash
git checkout "$(cat data/backup/versao-anterior.txt)"
docker compose up -d --build app
```

Se a atualização tinha migration de banco, restaure também o banco da hora do backup (seção 9, passos 5 a 7). Mensagens recebidas depois do backup se perdem nesse caso.

### 6.2 Atualizar a Evolution API (com volta)

A Evolution usa tag fixa no `docker-compose.yml` (hoje `evoapicloud/evolution-api:v2.3.7`). Nunca use `latest`.

1. Leia as notas da nova versão em https://github.com/EvolutionAPI/evolution-api/releases.
2. Anote a tag atual e faça um dump só do banco da Evolution:

```bash
cd /opt/talk
grep 'evolution-api:' docker-compose.yml | tee -a data/backup/evolution-tags.txt
docker compose exec -T postgres pg_dump -U postgres -Fc evolution > data/backup/evolution-antes-da-atualizacao.dump
```

3. Troque a tag no `docker-compose.yml`, por exemplo `v2.3.7` por `v2.3.8`, e suba:

```bash
docker compose pull evolution
docker compose up -d evolution
docker compose logs --tail 50 evolution
```

4. Teste: o canal continua **Conectado**, e uma mensagem enviada e uma recebida funcionam (texto e uma imagem).

**Voltar** se algo falhar:

```bash
docker compose stop evolution
# devolva a tag anterior no docker-compose.yml (está em data/backup/evolution-tags.txt)
docker compose exec -T postgres psql -U postgres -c 'DROP DATABASE evolution' -c 'CREATE DATABASE evolution OWNER evolution'
docker compose exec -T postgres pg_restore -U postgres -d evolution < data/backup/evolution-antes-da-atualizacao.dump
docker compose up -d evolution
```

Se o canal não voltar a **Conectado**, use **Gerar novo QR / Reconectar** (seção 4).

## 7. Backup

`scripts/backup.sh` faz duas cópias:

- **Banco:** `pg_dumpall` dos bancos `talk` e `evolution`. O da Evolution guarda a sessão do WhatsApp, o que evita reescanear o QR. O dump vai para `data/backup/db.sql`, gravado primeiro como `.tmp` e só renomeado no fim. Um dump com falha nunca apaga o último bom.
- **Mídia:** `data/media` compactada em `data/backup/media.tar.gz`.

Agende uma vez:

```bash
sudo crontab -e
# adicione a linha:
30 3 * * * sh /opt/talk/scripts/backup.sh >> /var/log/talk-backup.log 2>&1
```

Confira no dia seguinte:

```bash
tail -n 3 /var/log/talk-backup.log
ls -l /opt/talk/data/backup
```

O log deve ter `backup ok`, com data de hoje.

### 7.1 Cópia fora do servidor

O backup acima fica **no mesmo VPS**: se o VPS for perdido, ele se perde junto. Use uma das opções:

- **Backup do provedor** (preferido, se existir): ative o backup ou snapshot diário automático do VPS. Confirme que é armazenado fora da máquina e com retenção de pelo menos 7 dias.
- **restic** (se o provedor não oferecer): siga as instruções comentadas no fim de `scripts/backup.sh`. Elas enviam `db.sql` e `data/media`, criptografados, para o Backblaze B2. Guarde a `RESTIC_PASSWORD` fora do VPS.

Os backups contêm dados pessoais de clientes (LGPD). Restrinja o acesso ao bucket e ao painel do provedor a quem administra o sistema.

## 8. Ensaio de restauração (obrigatório antes da virada)

Faça uma vez, num VPS descartável ou numa máquina com Docker, seguindo a seção 9 com o backup real. Só considere o ensaio concluído quando:

- o login funcionar;
- as conversas, contatos e cadastros aparecerem;
- uma mídia antiga abrir.

Depois, destrua a máquina de ensaio: ela contém dados de clientes.

## 9. Restauração (runbook)

Use este roteiro se perder o VPS ou o banco.

1. Crie o novo VPS e faça as etapas 1 a 3 da seção 2: Docker, firewall e código.
2. Restaure o `.env` guardado fora do servidor:

```bash
cd /opt/talk
nano .env          # cole o conteúdo guardado
chmod 600 .env
```

3. Traga `db.sql` e a mídia para `/opt/talk/data`:
   - **Do restic:**

```bash
sudo sh -c '. /root/.restic-env && restic restore latest --target /tmp/restauracao'
mkdir -p data/backup
sudo cp /tmp/restauracao/opt/talk/data/backup/db.sql data/backup/
sudo cp -a /tmp/restauracao/opt/talk/data/media data/
```

   - **De um `media.tar.gz`:** `mkdir -p data/backup && tar -xzf media.tar.gz -C data`, com o arquivo copiado para `/opt/talk`.
4. Ajuste o dono da mídia:

```bash
sudo chown -R 1000:1000 data/media
```

5. Suba **só** o Postgres e espere ficar pronto:

```bash
docker compose up -d postgres
until docker compose exec -T postgres pg_isready -h 127.0.0.1 -U postgres; do sleep 2; done
```

6. Restaure os dois bancos:

```bash
docker compose exec -T postgres psql -U postgres -d postgres < data/backup/db.sql > /dev/null
```

   Até dois erros sobre o papel `postgres` (`current user cannot be dropped`, `role "postgres" already exists`) são normais. Qualquer outro erro deve ser investigado.

7. Suba o resto e confira:

```bash
docker compose up -d --build
curl -fsS https://talk.jvo.adv.br/api/health
```

8. Se o IP mudou, atualize o registro DNS **A** do domínio.
9. Entre no sistema e confira o canal em **Configurações → Canal WhatsApp**. Se não estiver **Conectado**, use **Gerar novo QR / Reconectar** e leia o QR com o celular do escritório.
10. Reative o cron do backup (seção 7) e a cópia fora do servidor (seção 7.1).

## 10. Checklist da virada

**Antes do dia:**

- [ ] Sistema instalado, HTTPS funcionando, primeiro administrador criado.
- [ ] Usuários criados, cada um com seus setores e sua assinatura.
- [ ] Cadastros importados do Umbler (seção 5) e relatório de importação revisado.
- [ ] Menu de triagem e mensagem de encerramento configurados.
- [ ] Cron de backup rodando (`backup ok` no log) e cópia fora do servidor confirmada (seção 7.1).
- [ ] `.env` guardado fora do servidor.
- [ ] Ensaio de restauração feito (seção 8).

**Teste manual com um número de teste, antes de conectar o número oficial:**

- [ ] Conectar pelo QR e ver o status **Conectado**.
- [ ] Receber e enviar: texto, imagem, áudio (ouvir e gravar), documento e vídeo.
- [ ] Responder citando uma mensagem, nos dois sentidos.
- [ ] Reação do contato aparece na mensagem. Um 👍 numa conversa **finalizada** não reabre a conversa.
- [ ] Mensagem digitada no celular do escritório aparece como enviada, sem ligar "Esperando" e sem menu de triagem.
- [ ] Transferir para outro setor: o atendente do setor antigo deixa de ver a conversa.
- [ ] Finalizar com e sem a mensagem de encerramento; reabrir.
- [ ] Iniciar conversa: com um contato existente e com um telefone novo.
- [ ] Triagem: o contato novo recebe o menu, escolhe uma opção e a conversa vai para o setor certo.
- [ ] Anexo `.html` enviado pelo contato é baixado, não aberto no navegador.
- [ ] Desconectar pelo celular → banner vermelho → **Gerar novo QR / Reconectar** volta a conectar.

**Virada:**

1. [ ] Importar os cadastros mais recentes do Umbler (seção 5), se mudaram desde o teste.
2. [ ] Conectar o **número oficial** no sistema novo (seção 4). Isso desconecta o número do Umbler.
3. [ ] Durante uma semana, consultar o histórico antigo no Umbler quando preciso.
4. [ ] Cancelar a assinatura do Umbler Talk.
````

- [ ] **Step 20: Check the README against the spec**

Run (bash): `grep -c -e 'pg_dumpall' -e 'restic' -e 'seed-admin' -e 'evolution-tags' -e 'Gerar novo QR' README.md`

Expected: a number ≥ 8. Read the file once and confirm it covers every §8 manual-checklist item: QR, each media type, quoted reply, reaction, transfer, close, start chat, triage, reconnect. Confirm it also covers every runbook step: new VPS → clone → `.env` → `psql < db.sql` + media → `up -d` → re-scan QR.

- [ ] **Step 21: Commit**

```bash
git add README.md
git commit -m "docs: installation, update, backup/restore runbook and go-live checklist

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
