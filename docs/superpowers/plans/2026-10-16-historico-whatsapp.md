# WhatsApp History and Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import the history the phone sends to Evolution after every QR pairing (and on demand), recover messages that arrived while the app was down, all as silent history, plus the channel fixes (down banner, QR that shows up late, channel name on chat cards).

**Architecture:** A new `server/src/history/` module copies Evolution's stored `Message` rows through `POST /chat/findMessages` in monthly windows of 500-row pages, runs each row through the existing webhook parser, and places it with ingest's exported `resolveContact` into the contact's open chat or a closed `history` chat, never touching unread/waiting/triage/bots. One in-process worker (15 s beat) runs the `history_imports` rows (automatic after a QR, repeated every 2 min; or on demand) and a 5-min back-fill per channel; a second loop downloads queued media (≤ 21 days) by `key.id`. LID-only contacts are merged into phone contacts whenever a copied live row carries a LID↔phone pair. Progress travels on the existing `channel.status` WS event through an extended `ChannelDto`.

**Tech Stack:** Node 24, TypeScript 5.9 strict ESM, Fastify 5.12.7, drizzle-orm 0.45.4 / drizzle-kit 0.31.11, Postgres (PGlite in tests), zod 4.6.7, vitest 5.0.4, React 19, @tanstack/react-query 5, Tailwind 4, @phosphor-icons/react, Evolution API v2.3.7 (Baileys 7.0.0-rc.9).

**Spec:** `docs/superpowers/specs/2026-10-16-historico-whatsapp-design.md` (binding). Background measurements live in the session scratchpad (`facts-code.md`, `facts-evolution-src.md`, `facts-evolution-data.md`, `spike-volume.md`, `spike-lid.md`, `spike-media.md`, `spike-pull.md`); every fact this plan relies on is restated where it is used.

## Global Constraints

- No new dependency in any workspace. Use the stdlib and what is installed.
- Evolution stays `evoapicloud/evolution-api:v2.3.7`. In **both** `docker-compose.dev.yml` and `docker-compose.yml`: `DATABASE_SAVE_DATA_HISTORIC`, `DATABASE_SAVE_DATA_CHATS`, `DATABASE_SAVE_DATA_CONTACTS` = `"true"`; `CONFIG_SESSION_PHONE_CLIENT` = `Atendimento` (prod) / `Atendimento (teste)` (dev); no `CONFIG_SESSION_PHONE_NAME`. `syncFullHistory` is never passed to `createInstance`.
- The instance webhook stays exactly what the message-actions delivery set: `MESSAGES_UPSERT, MESSAGES_UPDATE, MESSAGES_DELETE, CONNECTION_UPDATE, QRCODE_UPDATED` (`WEBHOOK_EVENTS` in `whatsapp/evolution.ts`, pushed to existing instances at boot by `syncWebhooks`). Never `MESSAGES_SET`, never `MESSAGES_EDITED`, which stalls Evolution's queue while the app is down. (Spec §4 lists the four events from before message actions; `MESSAGES_DELETE` carries live revokes and stays.) No task of this plan touches `WEBHOOK_EVENTS`, `webhookConfig`, `setWebhook` or `syncWebhooks`.
- `findMessages`: `where.messageTimestamp {gte, lte}`, ISO strings with `Z`, both bounds always, `lte` ≤ `2038-01-19T03:14:07Z`; monthly windows from newest to oldest inside the period; `offset` 500; every page; repeated ids dropped by `key.id`.
- Insert only ids the app does not have (`unique(channel_id, external_id)`); **never update** an existing message. Batches of ≤ 500 messages per transaction. `created_at` = `sent_at` on every copied message. No hub call per message: one `chat.updated` per open chat touched, after each batch commits.
- Everything copied is history only: never `unread`, `waiting`, `triage_pending`, triage, bots, `startChannelBot`, `resumeBotsOnReply`, live media fetch or avatar refresh.
- Message actions stay live-only (spec §2 "Fora: edição/remoção aplicadas a mensagens antigas"; §5.2 "nunca atualiza"). The parser now turns some rows into `revoke`, `edit` and `reaction` events (ingest's `applyRevoke`/`applyEdit`/`applyReaction`); a copy keeps only `type: 'message'` events, never calls those functions, and never writes `office_reaction`, `deleted_at/by/source`, `edited_at`, `forwarded_from_id` or `message_edits`. A row Evolution already rewrote after an edit or a delete is copied as Evolution holds it, without the "editada"/"apagada" mark.
- Left out of every copy: groups, `status@broadcast`, `@newsletter`, `protocolMessage`, `associatedChildMessage`, `secretEncryptedMessage`, reactions, and all the parser already ignores. Groups stay out of scope.
- Periods: `'3m' | '12m' | 'all'`, labels **3 meses**, **12 meses**, **Tudo**.
- Timings: automatic import repeats every **2 min** and ends after **10 min without news** (at most **60 min** after it started); back-fill every **5 min** and at boot, window `backfill_until − 10 min` … `now − 30 min`; media download only for messages **≤ 21 days** old, one at a time, **30 s** timeout; down banner after **> 1 min** disconnected.
- UI strings, verbatim: "Importar histórico", "Importando histórico… N mensagens", "Histórico importado: N mensagens, desde DD/MM/AAAA", "Gerando QR code…", "Canal X desconectado: leia o QR code em Configurações › Canais", "Arquivo não está mais disponível no WhatsApp", "Baixar", "Contato sem número", and the 409 text "Já existe uma importação em andamento". Other copy is pt-BR; code identifiers are English.
- Logs carry only ids, counts and error name/code (`errorTag`). Never a body, phone, LID, name or Evolution's response text.
- Import and back-fill never run inside the live ingest transaction. Inside `ctx.db.transaction(tx => …)` use only `tx` (PGlite deadlocks otherwise); publish to the hub only after commit.
- Every user read of a chat, message or media goes through `canSee` / `visibleChatsWhere` (404 otherwise). History chats (`chats.history = true`) are visible to every logged-in user and read-only.
- One migration, `0004` (after `0003_acoes_mensagem`), generated with `npm run db:generate -w server -- --name historico_whatsapp`; never hand-edited.
- ESM with `.js` import extensions in server code, `strict: true`, ids from `crypto.randomUUID()`, `timestamptz` in UTC.
- New DTO fields are optional in `@talk/shared` (existing literals keep compiling); the server always fills them.
- Tests run on PGlite (`makeTestCtx` / `makeTestApp`) with the fake gateway and the fake clock (`2026-10-14T13:00:00Z`). No real network, no real timers: the worker is driven through `tick()` and `drainMediaQueue()`.
- One commit per task. Every commit command ends with `-m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`.

## Review Focus

These are inputs the spec implies but its test list does not pin, most likely first. Each owning task carries the named test.

1. **The webhook already stored the message** (live, with unread, triage or a bot) and the import or back-fill meets the same id later, possibly with edited content (Evolution rewrites edited rows in place). The copy must skip it: one row, body unchanged, unread unchanged. **Owner: Task 3**, test `never rewrites a message the webhook already stored, nor counts it again (Review Focus 1)`.
2. **A row without a usable `messageTimestamp`.** The parser falls back to "now", so such a row would land as today's message and jump its chat to the top. It must be dropped. **Owner: Task 3**, test `skips a row without a valid timestamp instead of dating it today (Review Focus 2)`.
3. **A blocked contact.** Live ingest drops their messages; the import must do the same and must not create a history chat for them. **Owner: Task 3**, test `drops a blocked contact's history (Review Focus 3)`.
4. **The channel drops while media is queued.** Evolution cannot fetch then; the queue must leave the items queued (not mark them failed or expired) and resume once the channel is back. **Owner: Task 6**, test `leaves queued media alone while the channel is disconnected (Review Focus 4)`.
5. **The server restarts in the middle of an automatic import** (the phone can take 44 min to send everything). The import is a DB row; the next process must pick it up and keep repeating. **Owner: Task 8**, test `resumes an automatic import left running by a previous process (Review Focus 5)`.
6. **The history holds a revoke, an edit or a reaction about a message the app already stores.** Since message actions the parser turns those rows into `revoke`/`edit`/`reaction` events; a copy must drop them, leaving the stored message, its marks and the timeline untouched. **Owner: Task 3**, test `never applies an edit, a revoke or a reaction found in the history (Review Focus 6)`.

---

## File Structure

Each line gives the path, the task that creates or first modifies it, and its responsibility.

**Config and docs**
- `docker-compose.dev.yml`, `docker-compose.yml` (T1): Evolution saves history, chats and contacts; session client name back.
- `README.md`, `docs/IMPLANTACAO.md` (T13): feature section, LGPD note and the manual SQL cleanup.
- `docs/superpowers/plans/2026-10-16-historico-whatsapp-aceite.md` (T13, create): manual acceptance (spec §11).

**Shared**
- `shared/src/index.ts` (T1): `HistoryPeriod`, `HistoryImportState`, `HistoryImportDto`; optional `ChannelDto.historyPeriod/disconnectedAt/historyImport`, `ChatListItem.history`, `MessageDto.mediaExpired`; `ChatEventKind` gains `history_imported`, `contact_merged`.

**Server**
- `server/src/db/schema.ts` (T1): `channels.historyPeriod/backfillUntil/disconnectedAt`, `chats.history` + `chats_one_history_per_contact_channel`, `messages.mediaStatus` + `messages_media_queued_idx`, table `historyImports` + `history_imports_one_running_per_channel`.
- `server/drizzle/0004_historico_whatsapp.sql`, `server/drizzle/meta/0004_snapshot.json`, `server/drizzle/meta/_journal.json` (T1): generated.
- `server/src/whatsapp/types.ts` (T2): `GatewayError`, `MessagePage`, `EvolutionContact`, gateway methods `findMessages`, `findContacts`, `downloadMediaById`.
- `server/src/whatsapp/evolution.ts` (T2): the three calls; `call()` gets a per-call timeout and throws `GatewayError`.
- `server/src/whatsapp/fake.ts` (T2): `historyRecords`, `findCalls`, `contactRecords`, `mediaById`, `mediaLookups`.
- `server/src/messages/ingest.ts` (T3): exports `MessageEvent`, `Contact`, `resolveContact` (now `{ contact, created }`, optional `name`).
- `server/src/history/place.ts` (T3, create): `toHistoryEvents`, `realName`, `placeRecords`, `writeHistoryEvents`, `MEDIA_MAX_AGE_MS`. (T5) merges LID pairs before placing.
- `server/src/bots/scheduler.ts` (T4): `errorTag` exported and adds `status`.
- `server/src/history/copy.ts` (T4, create): `PAGE_SIZE`, `monthlyWindows`, `copyRange`.
- `server/src/history/merge.ts` (T5, create): `mergeLidPairs`.
- `server/src/messages/dto.ts` (T6): `MEDIA_KINDS` exported, `mediaExpired`.
- `server/src/history/media.ts` (T6, create): `downloadMessageMedia`, `drainMediaQueue`, `downloadMediaForUser`.
- `server/src/chats/routes.ts` (T6): `POST /api/messages/:id/media`.
- `server/src/history/imports.ts` (T7, create): `HistoryImportRow`, `IMPORT_RUNNING`, `toHistoryImportDto`, `latestImports`, `startHistoryImport`.
- `server/src/history/jobs.ts` (T7, create): `periodStart`, `runImportPass`. (T8) adds `runBackfill`, `createHistoryWorker`.
- `server/src/channels/service.ts` (T7): `toChannelDto(row, last)`, `listChannels`, `loadChannelDto`, `setChannelStatus` (disconnectedAt, automatic import). (T9) `connectChannel(…, opts)`, `importChannelHistory`.
- `server/src/realtime/hub.ts` (T7): `publishChannel` sends `loadChannelDto`.
- `server/src/index.ts` (T8): starts and stops the history worker.
- `server/src/channels/routes.ts` (T9): connect body `{ historyPeriod? }`, `POST /api/channels/:id/history-import`.
- `server/src/inbox/visibility.ts` (T10): history chats visible to everyone.
- `server/src/inbox/queries.ts` (T10): `ChatListItem.history`; Finalizados without history unless searching.
- `server/src/inbox/chats.ts` (T10): history chats cannot be reopened or made private. `server/src/messages/send.ts` (T10): no notes on them.
- Tests: `server/test/db/schema.test.ts` (T1); `server/test/whatsapp/evolution.test.ts`, `fake.test.ts` (T2); `server/test/history/records.ts` (T3, create, builders), `place.test.ts` (T3), `copy.test.ts` (T4), `merge.test.ts` (T5), `media.test.ts` (T6), `jobs.test.ts` (T7), `backfill.test.ts` (T8); `server/test/channels/routes.test.ts` (T7, T9), `service.test.ts` (T7), `server/test/realtime/hub.test.ts` (T6, T7, T10), `server/test/messages/dto.test.ts` (T6), `server/test/inbox/fixtures.ts` (T5: `history`), `server/test/inbox/visibility.test.ts`, `chats-actions.test.ts`, `server/test/chats/list-and-timeline.test.ts` (T10).

**Web**
- `web/src/components/conversation/model.ts` (T1): `eventText` for the two new kinds.
- `web/src/lib/api.ts` (T6): `api.messages.downloadMedia`. (T11) `api.channels.connect(id, period)`, `api.channels.importHistory`.
- `web/src/components/conversation/MessageBubble.tsx` (T6): expired text and "Baixar".
- `web/src/pages/settings/ChannelsSettings.tsx` (T11): period select, "Importar histórico", progress, QR polling while connecting.
- `web/src/components/layout/ChannelBanner.tsx` (T12, create; moved out of `AppLayout.tsx`): admin banner after 1 min.
- `web/src/components/inbox/ChatListItem.tsx`, `web/src/pages/Inbox.tsx` (T12): channel name when > 1 channel.
- `web/src/lib/format.ts` (T12): "Contato sem número".
- `web/src/components/conversation/ConversationHeader.tsx`, `ConversationView.tsx` (T12): history chats are read-only.
- Web tests: `model.test.ts` (T1), `MessageBubble.test.tsx` (T6), `pages/settings/ChannelsSettings.test.tsx` (T11, create), `components/layout/ChannelBanner.test.tsx` (T12, create), `pages/Inbox.test.tsx`, `lib/format-inbox.test.ts`, `conversation/ConversationHeader.test.tsx` (T12).

---

## Shared contract

Later tasks rely on these names exactly. A task that needs something else adds it inside its own files and renames nothing below.

```ts
// shared/src/index.ts (Task 1)
export type HistoryPeriod = '3m' | '12m' | 'all';
export type HistoryImportState = 'running' | 'done' | 'failed';
export interface HistoryImportDto { id: string; period: HistoryPeriod; state: HistoryImportState; startedAt: string; finishedAt: string | null; messagesImported: number; contactsCreated: number; oldestMessageAt: string | null; error: string | null }
// ChannelDto += historyPeriod?: HistoryPeriod; disconnectedAt?: string | null; historyImport?: HistoryImportDto | null
// ChatListItem += history?: boolean        MessageDto += mediaExpired?: boolean
// ChatEventKind += 'history_imported' (data { count }) | 'contact_merged' (data {})

// server/src/whatsapp/types.ts (Task 2)
export class GatewayError extends Error { readonly status: number }           // non-2xx from Evolution
export interface MessagePage { total: number; pages: number; records: unknown[] }
export interface EvolutionContact { remoteJid: string; pushName: string | null }
// WhatsAppGateway +=
findMessages(instance: string, q: { gte: Date; lte: Date; page: number; offset: number }): Promise<MessagePage>;
findContacts(instance: string): Promise<EvolutionContact[]>;
downloadMediaById(instance: string, externalId: string): Promise<DownloadedMedia>;

// server/src/messages/ingest.ts (Task 3)
export type MessageEvent = Extract<InboundEvent, { type: 'message' }>;
export type Contact = typeof contacts.$inferSelect;
export function resolveContact(tx: Tx, ev: MessageEvent, name?: string | null): Promise<{ contact: Contact; created: boolean } | undefined>;

// server/src/history/place.ts (Task 3)
export const MEDIA_MAX_AGE_MS: number;                       // 21 days
export type ContactNames = Map<string, string>;              // 'p:<phone>' | 'l:<lid>' → name
export interface ChannelRef { id: string; evolutionInstance: string }
export interface PlaceResult { inserted: number; contactsCreated: number; oldest: Date | null; historyCounts: Map<string, number> }
export function realName(name: string | null | undefined): string | null;
export function toHistoryEvents(instance: string, records: unknown[]): MessageEvent[];
export function placeRecords(ctx: AppCtx, channel: ChannelRef, records: unknown[], opts: { names: ContactNames; seen: Set<string> }): Promise<PlaceResult>;
export function writeHistoryEvents(ctx: AppCtx, counts: Map<string, number>): Promise<void>;

// server/src/history/copy.ts (Task 4)
export const PAGE_SIZE = 500;
export interface CopyTotals { inserted: number; contactsCreated: number; oldest: Date | null }
export function monthlyWindows(from: Date, to: Date): Array<{ gte: Date; lte: Date }>;
export function copyRange(ctx: AppCtx, channel: ChannelRef, from: Date, to: Date, onPage?: (r: PlaceResult) => Promise<void>): Promise<CopyTotals>;

// server/src/history/merge.ts (Task 5)
export function mergeLidPairs(ctx: AppCtx, pairs: Array<{ lid: string; phone: string }>): Promise<number>;

// server/src/history/media.ts (Task 6)
export type MediaOutcome = 'saved' | 'expired' | 'failed' | 'skipped';
export function downloadMessageMedia(ctx: AppCtx, messageId: string): Promise<MediaOutcome>;
export function drainMediaQueue(ctx: AppCtx, signal?: AbortSignal): Promise<number>;
export function downloadMediaForUser(ctx: AppCtx, user: AuthUser, messageId: string): Promise<MessageDto>;

// server/src/history/imports.ts (Task 7)
export type HistoryImportRow = typeof historyImports.$inferSelect;
export const IMPORT_RUNNING = 'Já existe uma importação em andamento';
export function toHistoryImportDto(r: HistoryImportRow): HistoryImportDto;
export function latestImports(db: Db | Tx, channelIds: string[]): Promise<Map<string, HistoryImportRow>>;
export function startHistoryImport(ctx: AppCtx, channelId: string, input: { period: HistoryPeriod; auto: boolean }): Promise<HistoryImportRow>;

// server/src/history/jobs.ts (Tasks 7–8)
export function periodStart(period: HistoryPeriod, now: Date): Date;
export function runImportPass(ctx: AppCtx, importId: string): Promise<HistoryImportRow | null>;
export const BACKFILL_EVERY_MS: number;                      // 5 min
export function runBackfill(ctx: AppCtx, channelId: string): Promise<number>;
export function createHistoryWorker(ctx: AppCtx, opts?: { intervalMs?: number; mediaIntervalMs?: number }): { tick(): Promise<void>; start(): void; stop(): Promise<void> };

// server/src/channels/service.ts (Tasks 7, 9)
export function toChannelDto(row: ChannelRow, last?: HistoryImportRow | null): ChannelDto;
export function loadChannelDto(db: Db | Tx, channelId: string): Promise<ChannelDto | null>;
export function connectChannel(ctx: AppCtx, channelId: string, opts?: { historyPeriod?: HistoryPeriod }): Promise<{ qrBase64: string | null }>;
export function importChannelHistory(ctx: AppCtx, channelId: string, period: HistoryPeriod): Promise<ChannelDto>;

// web (Tasks 6, 11)
api.messages.downloadMedia(messageId: string): Promise<MessageDto>;
api.channels.connect(id: string, historyPeriod?: HistoryPeriod): Promise<{ qrBase64: string | null }>;
api.channels.importHistory(id: string, period: HistoryPeriod): Promise<ChannelDto>;
```

---

## Tasks (execution order)

1. Schema, shared types, event texts and Evolution config
2. Gateway: findMessages, findContacts, downloadMediaById
3. Placing Evolution rows as history
4. Copying a time range (windows, pages, names)
5. Automatic merge of LID-only contacts
6. History media: queue, "expirada" and "Baixar"
7. History import job, automatic start after a QR, channel DTO
8. Back-fill, worker and boot wiring
9. Channel routes: period on connect and "Importar histórico"
10. Visibility and read-only history chats
11. Web Canais: period, "Importar histórico", progress and QR polling
12. Web inbox: down banner, channel name on cards, history chats read-only
13. Docs: README, IMPLANTACAO (LGPD) and manual acceptance

---

### Task 1: Schema, shared types, event texts and Evolution config

**Files:**
- Modify: `shared/src/index.ts:24` (`ChannelDto`), `:28` (`ChatListItem`), `:38` (end of `MessageDto`), `:40-43` (`ChatEventKind`)
- Modify: `server/src/db/schema.ts:17` (import), `:63-71` (`channels`), `:141-165` (`chats`), `:177-216` (`messages`), end of file after `messageEdits` (`historyImports`)
- Create (generated): `server/drizzle/0004_historico_whatsapp.sql`, `server/drizzle/meta/0004_snapshot.json`; Modify (generated): `server/drizzle/meta/_journal.json`
- Modify: `web/src/components/conversation/model.ts:106-107` (`eventText`, after `message_edited`)
- Modify: `docker-compose.dev.yml:31-46`, `docker-compose.yml:78-80`
- Test: `server/test/db/schema.test.ts`, `web/src/components/conversation/model.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: the shared types of the contract; columns `channels.historyPeriod` (`text`, default `'3m'`), `channels.backfillUntil`, `channels.disconnectedAt` (`timestamptz` null), `chats.history` (`boolean`, default false), `messages.mediaStatus` (`'queued' | 'expired' | null`), table `historyImports` with `id, channelId, period, auto, state ('running' default), startedAt, finishedAt, messagesImported (0), contactsCreated (0), oldestMessageAt, error, lastNewAt, nextRunAt`; partial unique indexes `chats_one_history_per_contact_channel (contact_id, channel_id) WHERE history = true` and `history_imports_one_running_per_channel (channel_id) WHERE state = 'running'`.

- [ ] **Step 1: Write the failing schema tests**

In `server/test/db/schema.test.ts`, change the import line and the table count, then add three tests inside `describe('database schema', …)`:

```ts
import { botRuns, botVersions, bots, chats, contacts, historyImports, messageEdits, messages, sectors } from '../../src/db/schema.js';
```

(`messageEdits` stays: the `message action columns` tests use it.)

```ts
  it('applies the migration: every schema table and column exists', async () => {
    const tables = Object.values(schema).filter((t) => is(t, PgTable));
    expect(tables).toHaveLength(22);
    // select() lists every column explicitly, so a column missing from the SQL fails here.
    for (const t of tables) await db.select().from(t).limit(1);
  });
```

```ts
  it('history_imports: one running import per channel; finished ones never block a new one (§5.1)', async () => {
    const base = { channelId: s.channelId, period: '3m' as const, auto: false };
    expect(await pgCode(db.insert(historyImports).values({ ...base, state: 'done' }))).toBeNull();
    expect(await pgCode(db.insert(historyImports).values({ ...base, state: 'running' }))).toBeNull();
    expect(await pgCode(db.insert(historyImports).values({ ...base, state: 'running' }))).toBe(UNIQUE_VIOLATION);
  });

  it('chats: one history chat per contact and channel, which may sit next to an open one (§5.3)', async () => {
    const [c] = await db.insert(contacts).values({ phone: '5565999990001' }).returning({ id: contacts.id });
    const chat = { contactId: c!.id, channelId: s.channelId, sectorId: s.defaultSector };
    expect(await pgCode(db.insert(chats).values({ ...chat, state: 'open' }))).toBeNull();
    expect(await pgCode(db.insert(chats).values({ ...chat, state: 'closed', history: true }))).toBeNull();
    expect(await pgCode(db.insert(chats).values({ ...chat, state: 'closed', history: true }))).toBe(UNIQUE_VIOLATION);
    expect(await pgCode(db.insert(chats).values({ ...chat, state: 'closed' }))).toBeNull();
  });

  it('new channel and chat columns start empty, with the 3-month period', async () => {
    const [ch] = await db.select().from(schema.channels).where(eq(schema.channels.id, s.channelId));
    expect(ch).toMatchObject({ historyPeriod: '3m', backfillUntil: null, disconnectedAt: null });
    const [chat] = await db
      .insert(chats)
      .values({ contactId: (await db.insert(contacts).values({ phone: '5565999990002' }).returning())[0]!.id, channelId: s.channelId, sectorId: s.defaultSector })
      .returning();
    expect(chat!.history).toBe(false);
  });
```

In `web/src/components/conversation/model.test.ts`, add after `describe('eventText for chatbot events', …)`:

```ts
describe('eventText for history events', () => {
  it('describes an import into a history chat and a contact merge', () => {
    expect(eventText(event({ kind: 'history_imported', data: { count: 1234 } }), new Map())).toBe(
      'Histórico do WhatsApp importado: 1.234 mensagens',
    );
    expect(eventText(event({ kind: 'contact_merged' }), new Map())).toBe('Contato sem número juntado a este contato');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w server -- test/db/schema.test.ts`
Expected: FAIL. `expected [ …21 tables ] to have a length of 22` (21 = 20 of the core and chatbot plus `message_edits` of message actions); the `history_imports` test fails because `historyImports` is `undefined` (drizzle throws on `insert(undefined)`); the `chats` and columns tests fail with `column "history" of relation "chats" does not exist` / `historyPeriod` missing.

Run: `npm test -w web -- src/components/conversation/model.test.ts`
Expected: FAIL in `eventText for history events`: `expected undefined to be 'Histórico do WhatsApp importado: 1.234 mensagens'`.

- [ ] **Step 3: Add the shared types**

In `shared/src/index.ts`, replace line 24 (`export interface ChannelDto …`) with:

```ts
export type HistoryPeriod = '3m' | '12m' | 'all';
export type HistoryImportState = 'running' | 'done' | 'failed';
/** One copy of the phone's history from Evolution (spec 2026-10-16 §5.6). Dates are ISO. */
export interface HistoryImportDto { id: string; period: HistoryPeriod; state: HistoryImportState; startedAt: string; finishedAt: string | null; messagesImported: number; contactsCreated: number; oldestMessageAt: string | null; error: string | null }
export interface ChannelDto { id: string; name: string; status: 'disconnected' | 'connecting' | 'connected'; phone: string | null;
  // optional so existing literals compile; the server always fills them (history import, Task 7)
  historyPeriod?: HistoryPeriod; disconnectedAt?: string | null; historyImport?: HistoryImportDto | null }
```

Replace line 28 (`export interface ChatListItem …`) with:

```ts
export interface ChatListItem { id: string; contact: ContactRef; channelId: string; sectorId: string; ownerId: string | null; state: 'open' | 'closed'; waiting: boolean; private: boolean; unread: number; lastMessageAt: string | null; lastMessagePreview: string | null; pinned: boolean; tagIds: string[];
  // imported from the phone (closed, read-only, visible to everyone); optional so existing literals compile (Task 10 fills it)
  history?: boolean }
```

Replace line 38 (`  forwarded?: boolean }`, the last line of `MessageDto`; the message-action fields above it stay) with:

```ts
  forwarded?: boolean;
  // history media (spec 2026-10-16 historico §5.5), optional for the same reason; toMessageDto always fills it (history Task 6)
  mediaExpired?: boolean }
```

Replace lines 40-43 (`export type ChatEventKind = …`, through the `message_deleted`/`message_edited` line) with:

```ts
export type ChatEventKind =
  | 'created' | 'assigned' | 'transferred' | 'closed' | 'reopened' | 'privacy_changed' | 'triage_routed'
  | 'bot_started' | 'bot_finished' | 'bot_stopped' | 'bot_failed' | 'bot_transferred' | 'bot_note'
  | 'message_deleted' | 'message_edited' // data: { messageId, source: MessageChangeSource }
  | 'history_imported' | 'contact_merged'; // data: { count } | {}
```

- [ ] **Step 4: Add the columns and the table to the schema**

In `server/src/db/schema.ts`, replace line 17 with:

```ts
import type {
  BotGraph, BotRunState, BotRunStep, BotRunVars, ChatEventKind, HistoryImportState, HistoryPeriod, MessageChangeSource,
} from '@talk/shared';
```

Replace the `channels` table (lines 63-71) with:

```ts
export const channels = pgTable('channels', {
  id: id(),
  name: text('name').notNull(),
  kind: text('kind').$type<'whatsapp_qr'>().notNull().default('whatsapp_qr'),
  evolutionInstance: text('evolution_instance').notNull().unique(),
  status: text('status').$type<'disconnected' | 'connecting' | 'connected'>().notNull().default('disconnected'),
  phone: text('phone'),
  createdAt: createdAt(),
  historyPeriod: text('history_period').$type<HistoryPeriod>().notNull().default('3m'), // §5.1: what a QR pairing imports
  backfillUntil: timestamp('backfill_until', { withTimezone: true }), // §6: Evolution rows up to here were copied
  disconnectedAt: timestamp('disconnected_at', { withTimezone: true }), // §7: start of the current outage (admin banner)
});
```

In the `chats` table, add after `closedAt: …,` (line 157):

```ts
    history: boolean('history').notNull().default(false), // §5.3: imported from the phone; closed, read-only, visible to all
```

and add to its index list, after `index('chats_last_message_at_idx').on(t.lastMessageAt),`:

```ts
    // §5.3: later imports append to the contact's one history chat on the channel
    uniqueIndex('chats_one_history_per_contact_channel')
      .on(t.contactId, t.channelId)
      .where(sql`${t.history} = true`),
```

In the `messages` table, add after `mediaSha256: …,` (line 207, the last message-action column; `officeReaction` … `mediaSha256` above it stay as they are):

```ts
    mediaStatus: text('media_status').$type<'queued' | 'expired'>(), // §5.5 history media: waiting for the queue, or gone from WhatsApp
```

and add to its index list, after `index('messages_chat_sent_idx').on(t.chatId, t.sentAt),`:

```ts
    index('messages_media_queued_idx').on(t.sentAt).where(sql`${t.mediaStatus} = 'queued'`),
```

Append at the end of the file (after `messageEdits`):

```ts
export const historyImports = pgTable(
  'history_imports',
  {
    id: id(),
    channelId: uuid('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
    period: text('period').$type<HistoryPeriod>().notNull(),
    auto: boolean('auto').notNull(), // true = started by a QR pairing: repeats every 2 min while news arrive (§5.1)
    state: text('state').$type<HistoryImportState>().notNull().default('running'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    messagesImported: integer('messages_imported').notNull().default(0),
    contactsCreated: integer('contacts_created').notNull().default(0),
    oldestMessageAt: timestamp('oldest_message_at', { withTimezone: true }),
    error: text('error'), // error name/code only (§9)
    lastNewAt: timestamp('last_new_at', { withTimezone: true }), // last pass that inserted something
    nextRunAt: timestamp('next_run_at', { withTimezone: true }), // when the worker runs the next pass; null once finished
  },
  (t) => [
    // §5.1: one import per channel at a time; a second request is a 409
    uniqueIndex('history_imports_one_running_per_channel').on(t.channelId).where(sql`${t.state} = 'running'`),
    index('history_imports_channel_idx').on(t.channelId, t.startedAt),
  ],
);
```

- [ ] **Step 5: Generate the migration**

Run: `npm run db:generate -w server -- --name historico_whatsapp`
Expected: drizzle-kit prints `[✓] Your SQL migration file ➜ drizzle\0004_historico_whatsapp.sql 🚀` with no rename prompt. It writes `server/drizzle/0004_historico_whatsapp.sql`, `server/drizzle/meta/0004_snapshot.json` and appends `"idx": 4, "tag": "0004_historico_whatsapp"` to `_journal.json` (after `0003_acoes_mensagem`). Do not edit the generated files.

Run: `grep -n "CREATE TABLE \"history_imports\"\|history_imports_one_running_per_channel\|chats_one_history_per_contact_channel\|ADD COLUMN \"history\"\|ADD COLUMN \"media_status\"\|ADD COLUMN \"history_period\" text DEFAULT '3m' NOT NULL\|messages_media_queued_idx" server/drizzle/0004_historico_whatsapp.sql`
Expected: seven matching lines.

Run: `grep -c "office_reaction\|message_edits\|deleted_at" server/drizzle/0004_historico_whatsapp.sql`
Expected: `0` (those came with `0003_acoes_mensagem`; a non-zero count means the 0003 snapshot was not picked up, so stop and regenerate from a clean tree).

- [ ] **Step 6: Add the two event texts**

In `web/src/components/conversation/model.ts`, add after the `case 'message_edited':` return (line 107, the last case), inside the switch:

```ts
    case 'history_imported':
      return `Histórico do WhatsApp importado: ${Number(e.data.count ?? 0).toLocaleString('pt-BR')} mensagens`;
    case 'contact_merged':
      return 'Contato sem número juntado a este contato';
```

- [ ] **Step 7: Evolution config in both compose files**

In `docker-compose.dev.yml`, replace lines 31-46 (from `DATABASE_SAVE_DATA_INSTANCE` through `CONFIG_SESSION_PHONE_NAME: Desktop`; that is the uncommitted 16/10 test edit in the working tree, with the "Teste do histórico" and "Windows + Desktop" comments) with the block below. On a clean checkout the same block is lines 31-43 (the three `"false"` values, `CONFIG_SESSION_PHONE_CLIENT: Atendimento (teste)`, no `CONFIG_SESSION_PHONE_NAME`); replace that one the same way.

```yaml
      DATABASE_SAVE_DATA_INSTANCE: "true"
      DATABASE_SAVE_DATA_NEW_MESSAGE: "true"
      DATABASE_SAVE_MESSAGE_UPDATE: "true"
      # Histórico do WhatsApp (spec 2026-10-16 §4): a Evolution guarda o histórico que o celular manda a cada QR,
      # e o app copia de lá. LGPD: docs/IMPLANTACAO.md › Histórico do WhatsApp e LGPD.
      DATABASE_SAVE_DATA_HISTORIC: "true"
      DATABASE_SAVE_DATA_CONTACTS: "true"
      DATABASE_SAVE_DATA_CHATS: "true"
      DATABASE_SAVE_DATA_LABELS: "false"
      CACHE_REDIS_ENABLED: "false"
      CACHE_LOCAL_ENABLED: "true"
      WEBHOOK_GLOBAL_ENABLED: "false"
      TELEMETRY_ENABLED: "false"
      LOG_LEVEL: ERROR,WARN,INFO
      CONFIG_SESSION_PHONE_CLIENT: Atendimento (teste)
```

In `docker-compose.yml`, replace lines 78-80 with:

```yaml
      # Histórico do WhatsApp (spec 2026-10-16 §4): a Evolution guarda o histórico que o celular manda a cada QR,
      # e o app copia de lá. LGPD: docs/IMPLANTACAO.md › Histórico do WhatsApp e LGPD.
      DATABASE_SAVE_DATA_HISTORIC: "true"
      DATABASE_SAVE_DATA_CONTACTS: "true"
      DATABASE_SAVE_DATA_CHATS: "true"
```

(`CONFIG_SESSION_PHONE_CLIENT: Atendimento` stays as it is; there is no `CONFIG_SESSION_PHONE_NAME` in this file.)

Run: `grep -n "DATABASE_SAVE_DATA_HISTORIC\|DATABASE_SAVE_DATA_CONTACTS\|DATABASE_SAVE_DATA_CHATS\|CONFIG_SESSION" docker-compose.yml docker-compose.dev.yml`
Expected: exactly eight lines: the three `"true"` lines and `CONFIG_SESSION_PHONE_CLIENT: Atendimento` in `docker-compose.yml`; the three `"true"` lines and `CONFIG_SESSION_PHONE_CLIENT: Atendimento (teste)` in `docker-compose.dev.yml`. No `CONFIG_SESSION_PHONE_NAME`.

- [ ] **Step 8: Run the tests and the typecheck**

Run: `npm test -w server -- test/db/schema.test.ts`
Expected: PASS (all tests, including the three new ones).

Run: `npm test -w web -- src/components/conversation/model.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: exit 0 for `shared`, `server` and `web` (the exhaustive `eventText` switch now covers the two new kinds).

Run: `npm test`
Expected: PASS. Nothing else reads the new columns yet.

- [ ] **Step 9: Commit**

```bash
git add shared/src/index.ts server/src/db/schema.ts server/drizzle/0004_historico_whatsapp.sql server/drizzle/meta/0004_snapshot.json server/drizzle/meta/_journal.json server/test/db/schema.test.ts web/src/components/conversation/model.ts web/src/components/conversation/model.test.ts docker-compose.dev.yml docker-compose.yml
git commit -m "feat(server): tabela history_imports, conversas de histórico e config da Evolution para guardar o histórico" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Gateway: findMessages, findContacts, downloadMediaById

**Files:**
- Modify: `server/src/whatsapp/types.ts` (whole file shown)
- Modify: `server/src/whatsapp/evolution.ts:48` (import), `:55` (below `webhookConfig`), `:76-87` (`call`), `:153-168` (media and picture methods)
- Modify: `server/src/whatsapp/fake.ts` (whole file shown)
- Test: `server/test/whatsapp/evolution.test.ts`, `server/test/whatsapp/fake.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `GatewayError`, `MessagePage`, `EvolutionContact`, `findMessages`, `findContacts`, `downloadMediaById` (contract). The fake gains `historyRecords: unknown[]`, `findCalls: Array<{ instance; gte: string; lte: string; page; offset }>` (ISO strings), `contactRecords: EvolutionContact[]`, `mediaById: Map<string, DownloadedMedia | Error>`, `mediaLookups: Array<{ instance; externalId }>`. `findMessages` and `downloadMediaById` call `guard()` (so `failNext` reaches them); `findContacts` does not.

Facts this task relies on (Evolution 2.3.7 source + live probes): the time filter applies only when **both** bounds are given (else it is silently dropped); bounds go through `new Date(v)`, so ISO with `Z` works and epoch seconds would be read as milliseconds; `messageTimestamp` is `int4` seconds, so an `lte` after `2038-01-19T03:14:07Z` is an HTTP 500; the answer is `{ messages: { total, pages, currentPage, records } }`, ordered `messageTimestamp DESC`, `offset` is the page size and `page` is 1-based. `getBase64FromMediaMessage` with only `{ message: { key: { id } } }` makes Evolution load the row by `key.id` from its own DB; expired media answers HTTP 400 after ~5.5 s. `findContacts` returns the Contact rows (`remoteJid`, `pushName`, …) as an array.

- [ ] **Step 1: Write the failing gateway tests**

Add to `server/test/whatsapp/evolution.test.ts`, change the import line to:

```ts
import { createEvolutionGateway, jidOf } from '../../src/whatsapp/evolution.js';
import { GatewayError } from '../../src/whatsapp/types.js';
```

and add inside `describe('createEvolutionGateway', …)`:

```ts
  it('findMessages posts both ISO bounds, the offset and the page, and reads the page', async () => {
    const record = { key: { id: 'A1', remoteJid: '556599999999@s.whatsapp.net', fromMe: false }, messageTimestamp: 1790000000 };
    const { wa, req } = setup(200, { messages: { total: 1, pages: 1, currentPage: 2, records: [record] } });
    await expect(
      wa.findMessages('talk-abc', { gte: new Date('2026-09-01T00:00:00Z'), lte: new Date('2026-09-30T23:59:59Z'), page: 2, offset: 500 }),
    ).resolves.toEqual({ total: 1, pages: 1, records: [record] });
    expect(req()).toEqual({
      url: 'http://evolution:8080/chat/findMessages/talk-abc',
      method: 'POST',
      headers: JSON_HEADERS,
      body: { where: { messageTimestamp: { gte: '2026-09-01T00:00:00.000Z', lte: '2026-09-30T23:59:59.000Z' } }, offset: 500, page: 2 },
    });
  });

  it("findMessages caps lte at Evolution's int4 seconds limit", async () => {
    const { wa, req } = setup(200, { messages: { total: 0, pages: 0, currentPage: 1, records: [] } });
    await wa.findMessages('talk-abc', { gte: new Date('2009-01-01T00:00:00Z'), lte: new Date('2100-01-01T00:00:00Z'), page: 1, offset: 500 });
    expect(req().body.where.messageTimestamp.lte).toBe('2038-01-19T03:14:07.000Z');
  });

  it('findMessages answers an empty page for an answer without records', async () => {
    const { wa } = setup(200, {});
    await expect(
      wa.findMessages('talk-abc', { gte: new Date(0), lte: new Date(1000), page: 1, offset: 500 }),
    ).resolves.toEqual({ total: 0, pages: 0, records: [] });
  });

  it('findContacts returns the remoteJid and push name of each Contact row', async () => {
    const { wa, req } = setup(200, [
      { id: 'c1', remoteJid: '201234567890123@lid', pushName: 'Maria Souza', profilePicUrl: null },
      { id: 'c2', remoteJid: '556599999999@s.whatsapp.net', pushName: '' },
      { id: 'c3' },
    ]);
    await expect(wa.findContacts('talk-abc')).resolves.toEqual([
      { remoteJid: '201234567890123@lid', pushName: 'Maria Souza' },
      { remoteJid: '556599999999@s.whatsapp.net', pushName: null },
    ]);
    expect(req()).toMatchObject({ url: 'http://evolution:8080/chat/findContacts/talk-abc', method: 'POST', body: { where: {} } });
  });

  it('downloadMediaById asks Evolution by key.id only', async () => {
    const { wa, req } = setup(201, { mediaType: 'imageMessage', fileName: 'x.jpeg', mimetype: 'image/jpeg', base64: 'QUJD' });
    await expect(wa.downloadMediaById('talk-abc', '3EB0FOTO')).resolves.toEqual({ base64: 'QUJD', mime: 'image/jpeg', fileName: 'x.jpeg' });
    expect(req()).toMatchObject({
      url: 'http://evolution:8080/chat/getBase64FromMediaMessage/talk-abc',
      method: 'POST',
      body: { message: { key: { id: '3EB0FOTO' } }, convertToMp4: false },
    });
  });

  it('a non-2xx answer throws GatewayError carrying the HTTP status', async () => {
    const { wa } = setup(400, { status: 400, error: 'Bad Request', response: { message: ['Error: Failed to fetch stream from https://mmg.whatsapp.net/x'] } });
    const err = await wa.downloadMediaById('talk-abc', '3EB0VELHA').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect(err).toMatchObject({ name: 'GatewayError', status: 400 });
  });
```

Add to `server/test/whatsapp/fake.test.ts`, inside `describe('createFakeGateway', …)`:

```ts
  it('findMessages serves historyRecords inside the inclusive second bounds, newest first, by page', async () => {
    const wa = createFakeGateway();
    const r = (id: string, t: number) => ({ key: { id }, messageTimestamp: t });
    wa.historyRecords.push(r('a', 100), r('b', 300), r('c', 200), r('d', 400));
    const q = { gte: new Date(100_000), lte: new Date(300_999), offset: 2 };

    expect(await wa.findMessages('talk-test', { ...q, page: 1 })).toEqual({ total: 3, pages: 2, records: [r('b', 300), r('c', 200)] });
    expect(await wa.findMessages('talk-test', { ...q, page: 2 })).toEqual({ total: 3, pages: 2, records: [r('a', 100)] });
    expect(wa.findCalls).toEqual([
      { instance: 'talk-test', gte: '1970-01-01T00:01:40.000Z', lte: '1970-01-01T00:05:00.999Z', page: 1, offset: 2 },
      { instance: 'talk-test', gte: '1970-01-01T00:01:40.000Z', lte: '1970-01-01T00:05:00.999Z', page: 2, offset: 2 },
    ]);
  });

  it('downloadMediaById answers by key.id (PNG by default, or the armed media/error) and records the lookup', async () => {
    const wa = createFakeGateway();
    wa.mediaById.set('expirada', new Error('400'));
    wa.mediaById.set('audio', { base64: 'T2dnUw==', mime: 'audio/ogg' });

    await expect(wa.downloadMediaById('talk-test', 'qualquer')).resolves.toMatchObject({ mime: 'image/png' });
    await expect(wa.downloadMediaById('talk-test', 'audio')).resolves.toEqual({ base64: 'T2dnUw==', mime: 'audio/ogg' });
    await expect(wa.downloadMediaById('talk-test', 'expirada')).rejects.toThrow('400');
    expect(wa.mediaLookups.map((l) => l.externalId)).toEqual(['qualquer', 'audio', 'expirada']);
    expect(await wa.findContacts('talk-test')).toEqual([]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w server -- test/whatsapp/evolution.test.ts test/whatsapp/fake.test.ts`
Expected: FAIL. `wa.findMessages is not a function`, `wa.findContacts is not a function`, `wa.downloadMediaById is not a function`; `GatewayError` is `undefined` (`toBeInstanceOf` throws); in the fake test `Cannot read properties of undefined (reading 'push')` for `historyRecords`.

- [ ] **Step 3: Extend the gateway types**

Replace `server/src/whatsapp/types.ts` with (everything message actions added — `MessageKeyRef`, `sendReaction`, `deleteForEveryone`, `editText`, `sendSticker`, `setWebhook`, the `revoke`/`edit` events and `reaction.fromMe` — is kept verbatim):

```ts
export type ChannelStatus = 'disconnected' | 'connecting' | 'connected';
export type MessageKind = 'text' | 'image' | 'audio' | 'video' | 'document' | 'sticker' | 'note' | 'unsupported';
export interface QuotedRef { externalId: string; body: string | null; fromMe: boolean }
export interface SendResult { externalId: string }
export interface OutgoingMedia { kind: 'image' | 'video' | 'document'; base64: string; mime: string; fileName: string; caption?: string }
export interface DownloadedMedia { base64: string; mime: string; fileName?: string }
/** A message in a 1:1 chat. `address` as in waAddress: canonical phone digits or '<lid>@lid'. */
export interface MessageKeyRef { address: string; externalId: string; fromMe: boolean }
/** One page of Evolution's POST /chat/findMessages; records are raw Message rows (key, pushName, message, messageType, messageTimestamp, contextInfo…). */
export interface MessagePage { total: number; pages: number; records: unknown[] }
/** A row of Evolution's Contact table (DATABASE_SAVE_DATA_CONTACTS=true): the phone's address-book or push name. */
export interface EvolutionContact { remoteJid: string; pushName: string | null }

/** A non-2xx answer from Evolution. `status` tells "media expired" (400) from a temporary failure. */
export class GatewayError extends Error {
  override name = 'GatewayError';
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface WhatsAppGateway {
  createInstance(instance: string, webhookUrl: string): Promise<void>;
  connect(instance: string): Promise<{ qrBase64: string | null }>;
  connectionState(instance: string): Promise<ChannelStatus>;
  sendText(instance: string, phone: string, text: string, quoted?: QuotedRef): Promise<SendResult>;
  sendMedia(instance: string, phone: string, media: OutgoingMedia, quoted?: QuotedRef): Promise<SendResult>;
  sendAudio(instance: string, phone: string, base64: string, quoted?: QuotedRef): Promise<SendResult>;
  downloadMedia(instance: string, rawMessage: unknown): Promise<DownloadedMedia>;
  /** URL of the contact's profile picture, or null when there is none. `address` as in waAddress (phone or '<lid>@lid'). */
  fetchProfilePicture(instance: string, address: string): Promise<string | null>;
  /** '' removes the reaction (spec §3). */
  sendReaction(instance: string, key: MessageKeyRef, emoji: string): Promise<void>;
  deleteForEveryone(instance: string, key: MessageKeyRef): Promise<void>;
  /** Text or caption of a message the office sent. Evolution needs the original in its own DB (DATABASE_SAVE_DATA_NEW_MESSAGE). */
  editText(instance: string, key: MessageKeyRef, text: string): Promise<void>;
  /** PNG, JPEG or WebP as raw base64; Evolution converts it to WebP. */
  sendSticker(instance: string, phone: string, base64: string, quoted?: QuotedRef): Promise<SendResult>;
  /** Replaces the instance's webhook URL and event list (createInstance only sets them at creation). */
  setWebhook(instance: string, webhookUrl: string): Promise<void>;
  /** Evolution's stored messages with messageTimestamp in [gte, lte] (inclusive, whole seconds), newest first; `page` is 1-based. */
  findMessages(instance: string, q: { gte: Date; lte: Date; page: number; offset: number }): Promise<MessagePage>;
  /** Every Contact row Evolution keeps for the instance. */
  findContacts(instance: string): Promise<EvolutionContact[]>;
  /** Media of a message Evolution has stored, looked up by key.id; GatewayError 400 when WhatsApp no longer has the file. */
  downloadMediaById(instance: string, externalId: string): Promise<DownloadedMedia>;
}

export type InboundEvent =
  | { type: 'message'; instance: string; externalId: string; direction: 'in' | 'out';
      phone: string | null; lid: string | null; pushName: string | null;
      kind: MessageKind; body: string | null; hasMedia: boolean;
      mediaMime: string | null; mediaName: string | null;
      replyToExternalId: string | null; sentAt: Date; raw: unknown }
  // fromMe: the office reacted (from its phone, or the echo of our own sendReaction). parse.ts always fills it.
  | { type: 'reaction'; instance: string; targetExternalId: string; emoji: string | null; fromMe?: boolean }
  // Deleted for everyone: by the contact, or (fromMe) by the office phone or our own deleteMessageForEveryone.
  | { type: 'revoke'; instance: string; targetExternalId: string; fromMe: boolean }
  // An edit; text null = WhatsApp's encrypted edit format, the new text is unknown.
  | { type: 'edit'; instance: string; targetExternalId: string; fromMe: boolean; text: string | null }
  | { type: 'status'; instance: string; externalId: string; status: 'sent' | 'delivered' | 'read' | 'failed' }
  | { type: 'connection'; instance: string; status: ChannelStatus; phone: string | null } // phone from `wuid` (owner JID) via phoneFromJid, null when absent
  | { type: 'qrcode'; instance: string; qrBase64: string }
  | { type: 'ignored'; reason: string };
```

- [ ] **Step 4: Implement the three Evolution calls**

In `server/src/whatsapp/evolution.ts`, add to the header comment block, before the `import` line (line 48):

```ts
// - Routes: POST /chat/findMessages/:i (200, { messages: { total, pages, currentPage, records } }), POST /chat/findContacts/:i
//   (200, Contact[]); the Baileys channel overrides findMessages (whatsapp.baileys.service.ts fetchMessages): the time filter
//   needs BOTH bounds, values go through new Date() (ISO with Z; epoch seconds would be read as ms), ORDER BY
//   messageTimestamp DESC, offset = page size, page 1-based. messageTimestamp is int4 seconds (lte past 2038 → 500).
// - getBase64FromMediaMessage with only { key: { id } } loads the row by key.id from Evolution's DB (getMessage(key, true));
//   expired media → 400 "Failed to fetch stream" after ~5.5 s (no working re-upload in 2.3.7).
```

Replace the import line (line 48, `import type { ChannelStatus, DownloadedMedia, QuotedRef, SendResult, WhatsAppGateway } from './types.js';`) with:

```ts
import {
  GatewayError,
  type ChannelStatus,
  type DownloadedMedia,
  type EvolutionContact,
  type QuotedRef,
  type SendResult,
  type WhatsAppGateway,
} from './types.js';
```

Below `const webhookConfig = …;` (line 55; `WEBHOOK_EVENTS` and `webhookConfig` above it stay unchanged) add:

```ts
// Evolution keeps messageTimestamp as int4 seconds: a bound past 2038-01-19T03:14:07Z is an HTTP 500.
const MAX_TIMESTAMP_MS = Date.UTC(2038, 0, 19, 3, 14, 7);
const isoBound = (d: Date) => new Date(Math.min(d.getTime(), MAX_TIMESTAMP_MS)).toISOString();

function toMedia(res: { base64?: string; mimetype?: string; fileName?: string } | null): DownloadedMedia {
  if (!res?.base64) throw new Error('Evolution getBase64FromMediaMessage returned no media');
  return { base64: res.base64, mime: res.mimetype || 'application/octet-stream', fileName: res.fileName || undefined };
}
```

Replace the `call` function (lines 76-87) with (it keeps `'DELETE'`, used by `deleteForEveryone`):

```ts
  async function call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, timeoutMs = 90_000): Promise<T | null> {
    const res = await fetchImpl(base + path, {
      method,
      headers: { apikey: cfg.apiKey, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      // ponytail: 90 s by default, just above Baileys' 60 s query timeout; a media lookup by id passes 30 s (§5.5)
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new GatewayError(`Evolution ${method} ${path} failed: ${res.status} ${text.slice(0, 300)}`, res.status);
    return text ? (JSON.parse(text) as T) : null;
  }
```

Replace `downloadMedia` and `fetchProfilePicture` (lines 153-168; `sendReaction` … `setWebhook` after them stay) with:

```ts
    async downloadMedia(instance, rawMessage): Promise<DownloadedMedia> {
      return toMedia(
        await call<{ base64?: string; mimetype?: string; fileName?: string }>(
          'POST',
          `/chat/getBase64FromMediaMessage/${seg(instance)}`,
          { message: rawMessage, convertToMp4: false },
        ),
      );
    },

    async fetchProfilePicture(instance, address) {
      const res = await call<{ profilePictureUrl?: string | null }>('POST', `/chat/fetchProfilePictureUrl/${seg(instance)}`, {
        number: address,
      });
      return res?.profilePictureUrl || null;
    },

    async findMessages(instance, q) {
      const res = await call<{ messages?: { total?: unknown; pages?: unknown; records?: unknown } }>(
        'POST',
        `/chat/findMessages/${seg(instance)}`,
        // Both bounds, always: with only one, Evolution 2.3.7 silently drops the time filter.
        { where: { messageTimestamp: { gte: isoBound(q.gte), lte: isoBound(q.lte) } }, offset: q.offset, page: q.page },
      );
      const m = res?.messages;
      return {
        total: Number(m?.total) || 0,
        pages: Number(m?.pages) || 0,
        records: Array.isArray(m?.records) ? m.records : [],
      };
    },

    async findContacts(instance): Promise<EvolutionContact[]> {
      const res = await call<unknown>('POST', `/chat/findContacts/${seg(instance)}`, { where: {} });
      if (!Array.isArray(res)) return [];
      return res.flatMap((row: unknown) => {
        const c = row as { remoteJid?: unknown; pushName?: unknown } | null;
        if (typeof c?.remoteJid !== 'string') return [];
        return [{ remoteJid: c.remoteJid, pushName: typeof c.pushName === 'string' && c.pushName ? c.pushName : null }];
      });
    },

    async downloadMediaById(instance, externalId): Promise<DownloadedMedia> {
      return toMedia(
        await call<{ base64?: string; mimetype?: string; fileName?: string }>(
          'POST',
          `/chat/getBase64FromMediaMessage/${seg(instance)}`,
          { message: { key: { id: externalId } }, convertToMp4: false },
          30_000,
        ),
      );
    },
```

- [ ] **Step 5: Extend the fake gateway**

Replace `server/src/whatsapp/fake.ts` with (the message-action methods `sendReaction`, `deleteForEveryone`, `editText`, `sendSticker` and `setWebhook` are kept verbatim):

```ts
import type { ChannelStatus, DownloadedMedia, EvolutionContact, SendResult, WhatsAppGateway } from './types.js';

// 1×1 transparent PNG.
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const stamp = (r: unknown) => Number((r as { messageTimestamp?: unknown } | null)?.messageTimestamp);

export function createFakeGateway(): WhatsAppGateway & {
  sent: Array<{ method: string; instance: string; phone?: string; payload: unknown }>;
  failNext(err?: Error): void;
  status: Map<string, ChannelStatus>;
  /** fetchProfilePicture answers by address: a URL, or an Error to throw; unset → null (no picture). */
  profilePictures: Map<string, string | Error>;
  pictureLookups: Array<{ instance: string; address: string }>;
  /** Rows findMessages serves (Evolution's Message table), filtered by messageTimestamp seconds, newest first, paged. */
  historyRecords: unknown[];
  findCalls: Array<{ instance: string; gte: string; lte: string; page: number; offset: number }>;
  /** Rows findContacts answers. */
  contactRecords: EvolutionContact[];
  /** downloadMediaById answers by key.id: media, or an Error to throw; unset → the 1×1 PNG. */
  mediaById: Map<string, DownloadedMedia | Error>;
  mediaLookups: Array<{ instance: string; externalId: string }>;
} {
  const sent: Array<{ method: string; instance: string; phone?: string; payload: unknown }> = [];
  const status = new Map<string, ChannelStatus>();
  const profilePictures = new Map<string, string | Error>();
  const pictureLookups: Array<{ instance: string; address: string }> = [];
  const historyRecords: unknown[] = [];
  const findCalls: Array<{ instance: string; gte: string; lte: string; page: number; offset: number }> = [];
  const contactRecords: EvolutionContact[] = [];
  const mediaById = new Map<string, DownloadedMedia | Error>();
  const mediaLookups: Array<{ instance: string; externalId: string }> = [];
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
    profilePictures,
    pictureLookups,
    historyRecords,
    findCalls,
    contactRecords,
    mediaById,
    mediaLookups,
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
    async sendAudio(instance, phone, base64, quoted) {
      return send('sendAudio', instance, phone, { base64, quoted });
    },
    async downloadMedia() {
      guard();
      return { base64: PNG_1X1, mime: 'image/png' };
    },
    async sendReaction(instance, key, emoji) {
      guard();
      sent.push({ method: 'sendReaction', instance, phone: key.address, payload: { key, emoji } });
    },
    async deleteForEveryone(instance, key) {
      guard();
      sent.push({ method: 'deleteForEveryone', instance, phone: key.address, payload: { key } });
    },
    async editText(instance, key, text) {
      guard();
      sent.push({ method: 'editText', instance, phone: key.address, payload: { key, text } });
    },
    async sendSticker(instance, phone, base64, quoted) {
      return send('sendSticker', instance, phone, { base64, quoted });
    },
    async setWebhook(instance, webhookUrl) {
      guard();
      sent.push({ method: 'setWebhook', instance, payload: { webhookUrl } });
    },
    // No guard(): this runs in the background after inbound messages and must not eat an error armed by failNext.
    async fetchProfilePicture(instance, address) {
      pictureLookups.push({ instance, address });
      const v = profilePictures.get(address);
      if (v instanceof Error) throw v;
      return v ?? null;
    },
    async findMessages(instance, q) {
      guard();
      findCalls.push({ instance, gte: q.gte.toISOString(), lte: q.lte.toISOString(), page: q.page, offset: q.offset });
      const lo = Math.floor(q.gte.getTime() / 1000);
      const hi = Math.floor(q.lte.getTime() / 1000);
      const rows = historyRecords.filter((r) => stamp(r) >= lo && stamp(r) <= hi).sort((a, b) => stamp(b) - stamp(a));
      const start = (q.page - 1) * q.offset;
      return { total: rows.length, pages: Math.ceil(rows.length / q.offset), records: rows.slice(start, start + q.offset) };
    },
    // No guard(): names are best effort and must not eat an error armed for findMessages.
    async findContacts() {
      return contactRecords;
    },
    async downloadMediaById(instance, externalId) {
      guard();
      mediaLookups.push({ instance, externalId });
      const v = mediaById.get(externalId);
      if (v instanceof Error) throw v;
      return v ?? { base64: PNG_1X1, mime: 'image/png' };
    },
  };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -w server -- test/whatsapp/evolution.test.ts test/whatsapp/fake.test.ts`
Expected: PASS. The existing error-message assertions (`failed: 500 …`, including the message-action ones) still hold: the message text did not change. A real Evolution failure now logs `GatewayError` where `messages/actions.ts` and `syncWebhooks` log `err.name`; their tests use the fake, whose errors stay plain `Error`s.

Run: `npm run typecheck -w server`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add server/src/whatsapp/types.ts server/src/whatsapp/evolution.ts server/src/whatsapp/fake.ts server/test/whatsapp/evolution.test.ts server/test/whatsapp/fake.test.ts
git commit -m "feat(server): findMessages, findContacts e mídia por key.id no gateway da Evolution" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 3: Placing Evolution rows as history

**Files:**
- Modify: `server/src/messages/ingest.ts:18` and `:23` (exported types), `:176-177` (call site), `:276-300` (`resolveContact`)
- Create: `server/src/history/place.ts`
- Create: `server/test/history/records.ts` (row builders shared by Tasks 3–8)
- Test: `server/test/history/place.test.ts`

**Interfaces:**
- Consumes: Task 1 columns `chats.history`, `messages.mediaStatus`, event kind `history_imported`; Task 2 gateway types (only through the fake in tests). Existing `parseEvolutionWebhook(body: unknown): InboundEvent[]` (`whatsapp/parse.ts`), `getDefaultSectorId(db: Db | Tx): Promise<string>` (`inbox/chats.ts`), `addEvent(db, chatId, kind, data, authorId)` (`inbox/events.ts`), `messagePreview(kind, body): string` (`messages/dto.ts`).
- Produces (contract): `MessageEvent`, `Contact`, `resolveContact(tx, ev, name?)` returning `{ contact, created } | undefined`; `MEDIA_MAX_AGE_MS`, `ContactNames`, `ChannelRef`, `PlaceResult`, `realName`, `toHistoryEvents`, `placeRecords`, `writeHistoryEvents`. Test builders `rec`, `imageRec`, `sec`, `PHONE`, `PHONE_JID`, `LID`, `LID_JID`.

Placement rules (spec §5.2–5.3), in the order `placeRecords` applies them: drop what §5.2 leaves out, every non-`message` event the parser yields (`revoke`, `edit`, `reaction`: message actions stay live-only) and rows without a positive `messageTimestamp`; drop ids already seen in this copy; sort the batch oldest first; skip ids the app already stores; resolve the contact (a digits-only push name is no name; else the name from Evolution's Contact table); skip blocked contacts; put the message in the contact's open chat on this channel, else in its history chat (created closed, `history = true`, default sector, no owner, `created_at` = first message, `closed_at` = last); insert with `created_at = sent_at` and `media_status` `queued` (≤ 21 days) or `expired`; move `last_message_at`/preview only forward; for history chats widen `created_at`/`closed_at`. After commit, one `chat.updated` per open chat touched.

- [ ] **Step 1: Create the row builders**

Create `server/test/history/records.ts`:

```ts
// Rows as Evolution 2.3.7's POST /chat/findMessages returns them (the Message table): history rows have
// key { remoteJid, fromMe, id } only; live rows of LID chats add remoteJidAlt (the phone JID) and addressingMode.
// History push names are the JID's digits (Evolution's fallback), never a real name.

export const PHONE_JID = '556599999999@s.whatsapp.net'; // 12 digits, as WhatsApp sends a DDD ≥ 31 mobile
export const PHONE = '5565999999999'; // contacts.phone after normalizePhoneBR
export const LID = '201234567890123';
export const LID_JID = `${LID}@lid`;

/** Unix seconds, as Evolution stores messageTimestamp. */
export const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);

export interface RecOpts {
  id: string;
  at: string; // ISO
  jid?: string;
  alt?: string; // remoteJidAlt: present only on live rows of LID chats
  fromMe?: boolean;
  text?: string;
  pushName?: string;
  messageType?: string;
  message?: Record<string, unknown>;
  contextInfo?: Record<string, unknown> | null;
  timestamp?: unknown; // overrides messageTimestamp (pass undefined to leave it out)
}

export function rec(o: RecOpts): Record<string, unknown> {
  const key: Record<string, unknown> = { remoteJid: o.jid ?? PHONE_JID, fromMe: o.fromMe ?? false, id: o.id };
  if (o.alt) Object.assign(key, { remoteJidAlt: o.alt, addressingMode: 'lid', participant: '' });
  const jidUser = String(key.remoteJid).split('@')[0];
  return {
    id: `row-${o.id}`,
    key,
    pushName: o.pushName ?? (o.fromMe ? 'Você' : jidUser),
    messageType: o.messageType ?? 'conversation',
    message: o.message ?? { conversation: o.text ?? `texto ${o.id}` },
    messageTimestamp: 'timestamp' in o ? o.timestamp : sec(o.at),
    instanceId: 'inst-1',
    source: 'android',
    contextInfo: o.contextInfo ?? null,
    MessageUpdate: [],
  };
}

export function imageRec(o: Omit<RecOpts, 'message' | 'messageType'>): Record<string, unknown> {
  return rec({
    ...o,
    messageType: 'imageMessage',
    message: {
      imageMessage: { url: 'https://mmg.whatsapp.net/v/x.enc', mimetype: 'image/jpeg', mediaKey: 'a2V5', directPath: '/v/x.enc', fileLength: '1234' },
    },
  });
}
```

- [ ] **Step 2: Write the failing placement tests**

Create `server/test/history/place.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { botRuns, chatEvents, chats, contacts, messageEdits, messages } from '../../src/db/schema.js';
import { placeRecords, realName, toHistoryEvents, writeHistoryEvents } from '../../src/history/place.js';
import { makeTestCtx, seedBasics } from '../helpers.js';
import { insertChat, newContact } from '../inbox/fixtures.js';
import { LID, LID_JID, PHONE, imageRec, rec } from './records.js';

type Ctx = Awaited<ReturnType<typeof makeTestCtx>>;

let ctx: Ctx;
let s: Awaited<ReturnType<typeof seedBasics>>;
let channel: { id: string; evolutionInstance: string };

beforeEach(async () => {
  ctx = await makeTestCtx(); // fake clock: 2026-10-14T13:00:00Z
  s = await seedBasics(ctx);
  channel = { id: s.channelId, evolutionInstance: s.instance };
});
afterEach(() => vi.restoreAllMocks());

const place = (records: unknown[], names = new Map<string, string>()) =>
  placeRecords(ctx, channel, records, { names, seen: new Set() });
const at = (iso: string) => new Date(iso);
const contactByPhone = async (phone: string) => (await ctx.db.select().from(contacts).where(eq(contacts.phone, phone)))[0]!;
const chatsOf = (contactId: string) => ctx.db.select().from(chats).where(eq(chats.contactId, contactId));
const chatById = async (id: string) => (await ctx.db.select().from(chats).where(eq(chats.id, id)))[0]!;
const messagesOf = (chatId: string) => ctx.db.select().from(messages).where(eq(messages.chatId, chatId));

describe('realName', () => {
  it('treats a push name made only of digits as no name', () => {
    expect(realName('556599999999')).toBeNull();
    expect(realName('+55 (65) 99999-9999')).toBeNull();
    expect(realName('   ')).toBeNull();
    expect(realName(null)).toBeNull();
    expect(realName('  Maria Souza ')).toBe('Maria Souza');
  });
});

describe('toHistoryEvents', () => {
  it('keeps 1:1 messages and drops what §5.2 leaves out', () => {
    const t = '2026-10-10T12:00:00Z';
    const events = toHistoryEvents(s.instance, [
      rec({ id: 'ok', at: t }),
      rec({ id: 'grupo', at: t, jid: '120363000000000000@g.us' }),
      rec({ id: 'status', at: t, jid: 'status@broadcast' }),
      rec({ id: 'canal', at: t, jid: '120363111111111111@newsletter' }),
      rec({ id: 'apagada', at: t, messageType: 'protocolMessage', message: { protocolMessage: { type: 0, key: { id: 'ok' } } } }),
      rec({ id: 'album', at: t, messageType: 'associatedChildMessage', message: { associatedChildMessage: { message: { imageMessage: {} } } } }),
      rec({
        id: 'edicao', at: t, messageType: 'secretEncryptedMessage',
        message: { secretEncryptedMessage: { secretEncType: 2, targetMessageKey: { id: 'ok' } } }, // the parser would yield an 'edit'
      }),
      rec({ id: 'reacao', at: t, messageType: 'reactionMessage', message: { reactionMessage: { key: { id: 'ok' }, text: '👍' } } }),
      rec({ id: 'reacao-minha', at: t, fromMe: true, messageType: 'reactionMessage', message: { reactionMessage: { key: { id: 'ok' }, text: '❤️' } } }),
      rec({ id: 'sem-hora', at: t, timestamp: undefined }),
      rec({ id: 'hora-zero', at: t, timestamp: 0 }),
    ]);
    expect(events.map((e) => e.externalId)).toEqual(['ok']);
    expect(events[0]).toMatchObject({ phone: PHONE, lid: null, direction: 'in', kind: 'text', sentAt: at(t) });
  });
});

describe('placeRecords', () => {
  it('with no open chat, creates one closed history chat in the default sector spanning its messages (§5.3)', async () => {
    const r = await place([
      rec({ id: 'h2', at: '2026-10-03T15:30:00Z', fromMe: true, text: 'última' }),
      rec({ id: 'h1', at: '2026-10-01T10:00:00Z', text: 'primeira' }),
    ]);

    expect(r).toMatchObject({ inserted: 2, contactsCreated: 1, oldest: at('2026-10-01T10:00:00Z') });
    const contact = await contactByPhone(PHONE);
    expect(contact.name).toBeNull(); // the history push name is only the number
    const [chat] = await chatsOf(contact.id);
    expect(chat).toMatchObject({
      history: true, state: 'closed', sectorId: s.defaultSector, ownerId: null, unread: 0, waiting: false,
      triagePending: false, private: false, createdAt: at('2026-10-01T10:00:00Z'), closedAt: at('2026-10-03T15:30:00Z'),
      lastMessageAt: at('2026-10-03T15:30:00Z'), lastMessagePreview: 'última',
    });
    expect(r.historyCounts).toEqual(new Map([[chat!.id, 2]]));
    const rows = await messagesOf(chat!.id);
    expect(rows.map((m) => [m.externalId, m.direction, m.authorId, m.status]).sort()).toEqual([
      ['h1', 'in', null, 'sent'],
      ['h2', 'out', null, 'sent'],
    ]);
    for (const m of rows) expect(m.createdAt).toEqual(m.sentAt); // §5.2: stable order with live messages

    await writeHistoryEvents(ctx, r.historyCounts);
    const events = await ctx.db.select().from(chatEvents).where(eq(chatEvents.chatId, chat!.id));
    expect(events.map((e) => [e.kind, e.data])).toEqual([['history_imported', { count: 2 }]]);
  });

  it('a later import appends to the same history chat and widens its span', async () => {
    await place([rec({ id: 'b', at: '2026-10-05T10:00:00Z' })]);
    await place([rec({ id: 'a', at: '2026-09-20T10:00:00Z' }), rec({ id: 'c', at: '2026-10-08T10:00:00Z', text: 'mais nova' })]);
    const chatRows = await chatsOf((await contactByPhone(PHONE)).id);
    expect(chatRows).toHaveLength(1);
    expect(chatRows[0]).toMatchObject({
      createdAt: at('2026-09-20T10:00:00Z'), closedAt: at('2026-10-08T10:00:00Z'), lastMessagePreview: 'mais nova',
    });
  });

  it('with an open chat, messages go into it without touching unread, waiting or triage', async () => {
    const contactId = await newContact(ctx, { phone: PHONE, name: 'Maria' });
    const chatId = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, contactId, unread: 2 });
    await ctx.db
      .update(chats)
      .set({ waiting: true, triagePending: true, lastMessageAt: at('2026-10-12T09:00:00Z'), lastMessagePreview: 'ao vivo' })
      .where(eq(chats.id, chatId));

    const r = await place([rec({ id: 'antiga', at: '2026-10-01T10:00:00Z', text: 'antiga' })]);

    expect(r.historyCounts.size).toBe(0);
    expect(await chatById(chatId)).toMatchObject({
      state: 'open', history: false, unread: 2, waiting: true, triagePending: true,
      lastMessageAt: at('2026-10-12T09:00:00Z'), lastMessagePreview: 'ao vivo',
    });
    expect(await ctx.db.$count(chats)).toBe(1);
    expect(ctx.hub.events).toEqual([{ type: 'chat', chatId }]); // one chat.updated for the batch, nothing per message

    await place([rec({ id: 'nova', at: '2026-10-13T08:00:00Z', text: 'mais nova' })]);
    expect(await chatById(chatId)).toMatchObject({ unread: 2, lastMessageAt: at('2026-10-13T08:00:00Z'), lastMessagePreview: 'mais nova' });
  });

  it('starts no bot, triage, avatar lookup or media download and writes no "created" event (§5.3)', async () => {
    const live = vi.spyOn(ctx.wa, 'downloadMedia');
    const byId = vi.spyOn(ctx.wa, 'downloadMediaById');
    await place([rec({ id: 't1', at: '2026-10-13T10:00:00Z' }), imageRec({ id: 'i1', at: '2026-10-13T10:01:00Z' })]);
    expect(await ctx.db.$count(messages)).toBe(2);
    expect(await ctx.db.$count(botRuns)).toBe(0);
    expect(await ctx.db.$count(chatEvents)).toBe(0);
    expect(ctx.wa.sent).toEqual([]);
    expect(ctx.wa.pictureLookups).toEqual([]);
    expect(live).not.toHaveBeenCalled();
    expect(byId).not.toHaveBeenCalled();
    expect(ctx.hub.events.filter((e) => e.type === 'message.created')).toEqual([]);
  });

  it('never rewrites a message the webhook already stored, nor counts it again (Review Focus 1)', async () => {
    const contactId = await newContact(ctx, { phone: PHONE });
    const chatId = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, contactId, unread: 1 });
    await ctx.db.insert(messages).values({
      chatId, channelId: s.channelId, direction: 'in', kind: 'text', body: 'original', externalId: 'live1', status: 'sent',
      sentAt: at('2026-10-14T12:50:00Z'),
    });

    // Evolution rewrote the row after an edit: new content and a later timestamp, same key.id
    const r = await place([rec({ id: 'live1', at: '2026-10-14T12:50:13Z', text: 'editada depois' })]);

    expect(r.inserted).toBe(0);
    expect((await messagesOf(chatId)).map((m) => m.body)).toEqual(['original']);
    expect((await chatById(chatId)).unread).toBe(1);
  });

  it('never applies an edit, a revoke or a reaction found in the history (Review Focus 6)', async () => {
    const contactId = await newContact(ctx, { phone: PHONE });
    const chatId = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, contactId });
    await ctx.db.insert(messages).values({
      chatId, channelId: s.channelId, direction: 'in', kind: 'text', body: 'original', externalId: 'alvo', status: 'sent',
      sentAt: at('2026-10-10T12:00:00Z'),
    });
    const t = '2026-10-10T12:05:00Z';

    const r = await place([
      rec({ id: 'apaga', at: t, messageType: 'protocolMessage', message: { protocolMessage: { type: 0, key: { id: 'alvo' } } } }),
      rec({
        id: 'edita', at: t, messageType: 'secretEncryptedMessage',
        message: { secretEncryptedMessage: { secretEncType: 2, targetMessageKey: { id: 'alvo' } } },
      }),
      rec({ id: 'reage', at: t, messageType: 'reactionMessage', message: { reactionMessage: { key: { id: 'alvo' }, text: '👍' } } }),
      rec({ id: 'reage-eu', at: t, fromMe: true, messageType: 'reactionMessage', message: { reactionMessage: { key: { id: 'alvo' }, text: '❤️' } } }),
    ]);

    expect(r.inserted).toBe(0);
    const [m] = await ctx.db.select().from(messages).where(eq(messages.externalId, 'alvo'));
    expect(m).toMatchObject({ body: 'original', deletedAt: null, deletedSource: null, editedAt: null, reaction: null, officeReaction: null });
    expect(await ctx.db.$count(messageEdits)).toBe(0);
    expect(await ctx.db.$count(chatEvents)).toBe(0);
  });

  it('a second copy of the same rows adds nothing', async () => {
    const rows = [rec({ id: 'h1', at: '2026-10-01T10:00:00Z' }), rec({ id: 'h2', at: '2026-10-02T10:00:00Z' })];
    expect((await place(rows)).inserted).toBe(2);
    expect((await place(rows)).inserted).toBe(0);
    expect(await ctx.db.$count(messages)).toBe(2);
    expect(await ctx.db.$count(chats)).toBe(1);
  });

  it('a LID-only row creates a contact with the lid and no phone; a digits-only push name is no name (§5.4)', async () => {
    await place([rec({ id: 'l1', at: '2026-10-01T10:00:00Z', jid: LID_JID })]);
    const [c] = await ctx.db.select().from(contacts).where(eq(contacts.lid, LID));
    expect(c).toMatchObject({ phone: null, lid: LID, name: null });
    expect(await chatsOf(c!.id)).toHaveLength(1);
  });

  it("names a contact from Evolution's Contact table when the push name is only digits", async () => {
    await place([rec({ id: 'l2', at: '2026-10-01T10:00:00Z', jid: LID_JID })], new Map([[`l:${LID}`, 'Maria Souza']]));
    const [c] = await ctx.db.select().from(contacts).where(eq(contacts.lid, LID));
    expect(c!.name).toBe('Maria Souza');
  });

  it('queues media up to 21 days old and marks older media expired (§5.5)', async () => {
    await place([
      imageRec({ id: 'nova', at: '2026-09-24T13:00:00Z' }), // 20 days before the fake clock
      imageRec({ id: 'velha', at: '2026-09-22T12:00:00Z' }), // 22 days
      rec({ id: 'texto', at: '2026-09-23T12:00:00Z' }),
    ]);
    const rows = await ctx.db.select().from(messages);
    expect(new Map(rows.map((m) => [m.externalId, m.mediaStatus]))).toEqual(
      new Map([['nova', 'queued'], ['velha', 'expired'], ['texto', null]]),
    );
    expect(rows.find((m) => m.externalId === 'nova')).toMatchObject({ kind: 'image', mediaMime: 'image/jpeg', mediaPath: null });
  });

  it("drops a blocked contact's history (Review Focus 3)", async () => {
    const contactId = await newContact(ctx, { phone: PHONE });
    await ctx.db.update(contacts).set({ blocked: true }).where(eq(contacts.id, contactId));
    expect((await place([rec({ id: 'b1', at: '2026-10-01T10:00:00Z' })])).inserted).toBe(0);
    expect(await chatsOf(contactId)).toEqual([]);
  });

  it('skips a row without a valid timestamp instead of dating it today (Review Focus 2)', async () => {
    const r = await place([
      rec({ id: 'x1', at: '2026-10-01T10:00:00Z', timestamp: undefined }),
      rec({ id: 'x2', at: '2026-10-01T10:00:00Z', timestamp: 'abc' }),
    ]);
    expect(r.inserted).toBe(0);
    expect(await ctx.db.$count(chats)).toBe(0);
  });

  it('threads a quote of an earlier message of the same batch', async () => {
    await place([
      rec({ id: 'resp', at: '2026-10-01T10:05:00Z', fromMe: true, text: 'Pode sim', contextInfo: { stanzaId: 'perg' } }),
      rec({ id: 'perg', at: '2026-10-01T10:00:00Z', text: 'Posso mandar o contrato?' }),
    ]);
    const rows = await ctx.db.select().from(messages);
    const perg = rows.find((m) => m.externalId === 'perg')!;
    expect(rows.find((m) => m.externalId === 'resp')!.replyToId).toBe(perg.id);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -w server -- test/history/place.test.ts`
Expected: FAIL. The file fails to collect with `Failed to load url ../../src/history/place.js (resolved id: …) … Does the file exist?`.

- [ ] **Step 4: Export `resolveContact` from ingest with the created flag and an optional name**

In `server/src/messages/ingest.ts`, replace line 18 (`type MessageEvent = …`) with:

```ts
export type MessageEvent = Extract<InboundEvent, { type: 'message' }>;
```

replace line 23 (`type Contact = …`; the `RevokeEvent`/`EditEvent`/`MessageStatus` aliases between them stay private) with:

```ts
export type Contact = typeof contacts.$inferSelect;
```

replace lines 176-177 (in `ingestMessage`) with:

```ts
      const contact = (await resolveContact(tx, ev))?.contact;
      if (!contact || contact.blocked) throw new Skip();
```

and replace the whole `resolveContact` function (lines 276-300, with its one-line doc comment) with:

```ts
/**
 * Match by normalized phone, then by lid; fill what is missing; create on first contact (race-safe).
 * `name` defaults to the push name of inbound messages (on fromMe it is the office's own name); the history
 * import passes the name it trusts (spec 2026-10-16 §5.4). `created` = this call inserted the contact.
 */
export async function resolveContact(
  tx: Tx,
  ev: MessageEvent,
  name: string | null = ev.direction === 'in' ? ev.pushName : null,
): Promise<{ contact: Contact; created: boolean } | undefined> {
  const phone = ev.phone ? normalizePhoneBR(ev.phone) : null;
  if (!phone && !ev.lid) return undefined;

  const { byPhone, byLid } = await lookup(tx, phone, ev.lid);
  // ponytail: when phone and lid point at two different contacts we use the phone one; the history
  // copy joins a LID-only contact into the phone one (history/merge.ts)
  const found = byPhone ?? byLid;

  if (!found) {
    const [inserted] = await tx
      .insert(contacts)
      .values({ id: randomUUID(), phone, lid: ev.lid, name })
      .onConflictDoNothing()
      .returning({ id: contacts.id });
    const again = await lookup(tx, phone, ev.lid);
    const contact = again.byPhone ?? again.byLid;
    return contact ? { contact, created: !!inserted } : undefined;
  }

  const patch: Partial<typeof contacts.$inferInsert> = {};
  if (!found.phone && phone && !byPhone) patch.phone = phone;
  if (!found.lid && ev.lid && !byLid) patch.lid = ev.lid;
  if (!found.name && name) patch.name = name;
  if (Object.keys(patch).length > 0) {
    await tx.update(contacts).set({ ...patch, updatedAt: new Date() }).where(eq(contacts.id, found.id));
  }
  return { contact: found, created: false };
}
```

- [ ] **Step 5: Implement the placement**

Create `server/src/history/place.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { AppCtx } from '../ctx.js';
import type { Tx } from '../db/client.js';
import { chats, messages } from '../db/schema.js';
import { getDefaultSectorId } from '../inbox/chats.js';
import { addEvent } from '../inbox/events.js';
import { messagePreview } from '../messages/dto.js';
import { resolveContact, type Contact, type MessageEvent } from '../messages/ingest.js';
import { parseEvolutionWebhook } from '../whatsapp/parse.js';

/** §5.5: WhatsApp keeps media downloadable for about 3 weeks (measured: ok at 22 days, gone at 23). */
export const MEDIA_MAX_AGE_MS = 21 * 24 * 60 * 60_000;

/**
 * messageType values that are never a message of their own (§5.2): revokes/edits, album children, edits in the new
 * format and reactions. The parser already drops groups, status@broadcast, newsletters (no address) and the rest.
 * Since message actions the parser turns secretEncryptedMessage into an 'edit' event and reactions (fromMe too) into
 * 'reaction' events; toHistoryEvents keeps only 'message' events, so history never edits, deletes or reacts (spec §2).
 */
const SKIP_TYPES = new Set(['protocolMessage', 'associatedChildMessage', 'secretEncryptedMessage', 'reactionMessage', 'editedMessage']);

/** Names from Evolution's Contact table, keyed 'p:<phone>' (normalized) or 'l:<lid>'. */
export type ContactNames = Map<string, string>;

export interface ChannelRef {
  id: string;
  evolutionInstance: string;
}

export interface PlaceResult {
  inserted: number;
  contactsCreated: number;
  oldest: Date | null;
  /** history chat id → messages added to it (the caller writes one history_imported event per chat). */
  historyCounts: Map<string, number>;
}

type Target = { id: string; history: boolean };

/** A push name made only of digits is Evolution's fallback (the JID's user part), not a name (§5.4). */
export function realName(name: string | null | undefined): string | null {
  const n = name?.trim();
  return n && !/^[\d\s+()-]+$/.test(n) ? n : null;
}

const stampOf = (r: unknown) => Number((r as { messageTimestamp?: unknown } | null)?.messageTimestamp);
const typeOf = (r: unknown) => String((r as { messageType?: unknown } | null)?.messageType);

/** Raw Evolution rows → message events, minus what §5.2 leaves out (and every revoke/edit/reaction event). */
export function toHistoryEvents(instance: string, records: unknown[]): MessageEvent[] {
  // A row without a positive timestamp would get the parser's "now" fallback and land as today's message.
  const kept = records.filter((r) => stampOf(r) > 0 && !SKIP_TYPES.has(typeOf(r)));
  if (kept.length === 0) return [];
  return parseEvolutionWebhook({ event: 'messages.upsert', instance, data: kept }).filter(
    (e): e is MessageEvent => e.type === 'message',
  );
}

function nameFor(names: ContactNames, ev: MessageEvent): string | null {
  return (ev.phone ? names.get(`p:${ev.phone}`) : undefined) ?? (ev.lid ? names.get(`l:${ev.lid}`) : undefined) ?? null;
}

/** §5.3: the contact's open chat on the channel, else its history chat (created closed when missing). */
async function destinationChat(tx: Tx, contactId: string, channelId: string, sectorId: string, firstAt: Date): Promise<Target> {
  const same = and(eq(chats.contactId, contactId), eq(chats.channelId, channelId));
  const [open] = await tx.select({ id: chats.id }).from(chats).where(and(same, eq(chats.state, 'open')));
  if (open) return { id: open.id, history: false };
  const findHistory = async () => (await tx.select({ id: chats.id }).from(chats).where(and(same, eq(chats.history, true))))[0];
  const found = await findHistory();
  if (found) return { id: found.id, history: true };
  await tx
    .insert(chats)
    .values({
      id: randomUUID(), contactId, channelId, sectorId, ownerId: null, state: 'closed', history: true,
      waiting: false, private: false, triagePending: false, unread: 0, createdAt: firstAt, closedAt: firstAt,
    })
    .onConflictDoNothing(); // chats_one_history_per_contact_channel: a concurrent copy created it
  const created = await findHistory();
  if (!created) throw new Error('placeRecords: history chat insert conflicted but none was found');
  return { id: created.id, history: true };
}

/** last_message_at/preview only move forward; unread, waiting and triage never change (§3 opção B). */
async function touchChat(tx: Tx, chat: Target, ev: MessageEvent): Promise<void> {
  const sentAt = ev.sentAt.toISOString();
  const isNewest = sql`(${chats.lastMessageAt} is null or ${chats.lastMessageAt} <= ${sentAt}::timestamptz)`;
  await tx
    .update(chats)
    .set({
      lastMessageAt: sql`greatest(${chats.lastMessageAt}, ${sentAt}::timestamptz)`,
      lastMessagePreview: sql`case when ${isNewest} then ${messagePreview(ev.kind, ev.body)} else ${chats.lastMessagePreview} end`,
      // a history chat spans its first to its last message (§5.3)
      ...(chat.history
        ? {
            createdAt: sql`least(${chats.createdAt}, ${sentAt}::timestamptz)`,
            closedAt: sql`greatest(${chats.closedAt}, ${sentAt}::timestamptz)`,
          }
        : {}),
    })
    .where(eq(chats.id, chat.id));
}

/**
 * Places one batch (one findMessages page, ≤ 500 rows) as history (§5.2–5.3) in one short transaction, then
 * publishes chat.updated once per open chat it touched. `seen` carries the ids of the whole copy: Evolution
 * stores some history messages twice. Never calls triage, bots, avatar refresh or media download.
 */
export async function placeRecords(
  ctx: AppCtx,
  channel: ChannelRef,
  records: unknown[],
  opts: { names: ContactNames; seen: Set<string> },
): Promise<PlaceResult> {
  const result: PlaceResult = { inserted: 0, contactsCreated: 0, oldest: null, historyCounts: new Map() };
  const parsed = toHistoryEvents(channel.evolutionInstance, records);
  const events = parsed.filter((ev) => {
    if (opts.seen.has(ev.externalId)) return false;
    opts.seen.add(ev.externalId);
    return true;
  });
  if (events.length === 0) return result;
  events.sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime()); // oldest first: a quote finds its earlier message
  const mediaCutoff = ctx.botRuntime.now().getTime() - MEDIA_MAX_AGE_MS;
  const openTouched = new Set<string>();

  // Only `tx` inside (PGlite serializes transactions; ctx.db here would deadlock), and no hub calls.
  await ctx.db.transaction(async (tx) => {
    const have = await tx
      .select({ externalId: messages.externalId })
      .from(messages)
      .where(and(eq(messages.channelId, channel.id), inArray(messages.externalId, events.map((e) => e.externalId))));
    const stored = new Set(have.map((r) => r.externalId));
    const sectorId = await getDefaultSectorId(tx);
    const contactByAddress = new Map<string, Contact | null>();
    const chatByContact = new Map<string, Target>();

    for (const ev of events) {
      if (stored.has(ev.externalId)) continue; // never update a stored message (§5.2)

      const address = `${ev.phone ?? ''}|${ev.lid ?? ''}`;
      let contact = contactByAddress.get(address);
      if (contact === undefined) {
        const resolved = await resolveContact(tx, ev, realName(ev.pushName) ?? nameFor(opts.names, ev));
        if (resolved?.created) result.contactsCreated += 1;
        contact = resolved?.contact ?? null;
        contactByAddress.set(address, contact);
      }
      if (!contact || contact.blocked) continue;

      let chat = chatByContact.get(contact.id);
      if (!chat) {
        chat = await destinationChat(tx, contact.id, channel.id, sectorId, ev.sentAt);
        chatByContact.set(contact.id, chat);
      }

      let replyToId: string | null = null;
      if (ev.replyToExternalId) {
        const [quoted] = await tx
          .select({ id: messages.id })
          .from(messages)
          .where(and(eq(messages.channelId, channel.id), eq(messages.externalId, ev.replyToExternalId)))
          .limit(1);
        replyToId = quoted?.id ?? null;
      }

      const [row] = await tx
        .insert(messages)
        .values({
          id: randomUUID(),
          chatId: chat.id,
          channelId: channel.id,
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
          createdAt: ev.sentAt, // §5.2: same order as live messages; never "the last reply" a bot reads
          mediaStatus: ev.hasMedia ? (ev.sentAt.getTime() >= mediaCutoff ? 'queued' : 'expired') : null,
        })
        .onConflictDoNothing({ target: [messages.channelId, messages.externalId] })
        .returning({ id: messages.id });
      if (!row) continue; // the live webhook stored it meanwhile

      await touchChat(tx, chat, ev);
      result.inserted += 1;
      if (!result.oldest || ev.sentAt < result.oldest) result.oldest = ev.sentAt;
      if (chat.history) result.historyCounts.set(chat.id, (result.historyCounts.get(chat.id) ?? 0) + 1);
      else openTouched.add(chat.id);
    }
  });

  for (const chatId of openTouched) await ctx.hub.publishChat(chatId);
  return result;
}

/** One history_imported { count } event per history chat that received messages (§5.3). */
export async function writeHistoryEvents(ctx: AppCtx, counts: Map<string, number>): Promise<void> {
  if (counts.size === 0) return;
  await ctx.db.transaction(async (tx) => {
    for (const [chatId, count] of counts) await addEvent(tx, chatId, 'history_imported', { count }, null);
  });
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -w server -- test/history/place.test.ts test/messages/ingest.test.ts`
Expected: PASS. `ingest.test.ts` proves the live path still resolves contacts as before.

Run: `npm run typecheck -w server`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add server/src/messages/ingest.ts server/src/history/place.ts server/test/history/records.ts server/test/history/place.test.ts
git commit -m "feat(server): grava mensagens da Evolution como histórico (conversa aberta ou de histórico, sem fila nem bot)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Copying a time range (windows, pages, names)

**Files:**
- Modify: `server/src/bots/scheduler.ts:14-19` (`errorTag`: exported, adds `status`)
- Create: `server/src/history/copy.ts`
- Test: `server/test/history/copy.test.ts`

**Interfaces:**
- Consumes: Task 2 `ctx.wa.findMessages`, `ctx.wa.findContacts`, `GatewayError`, fake `historyRecords`/`findCalls`/`contactRecords`; Task 3 `placeRecords`, `writeHistoryEvents`, `realName`, `ChannelRef`, `ContactNames`, `PlaceResult`, builders `rec`, `LID`, `LID_JID`; existing `phoneFromJid`, `lidFromJid` (`whatsapp/phone.ts`).
- Produces (contract): `PAGE_SIZE`, `CopyTotals`, `monthlyWindows`, `copyRange`; `errorTag(err: unknown): string` exported from `bots/scheduler.ts` (`"<name> <pg code>"`, else `"<name> <http status>"`, else `"<name>"`).

Measured on the real account (46 163 rows): monthly windows with `offset` 500 read every row once (0 lost, 0 repeated) in ~6 s; the DB has no tiebreaker after `messageTimestamp DESC`, so a page edge inside a same-second group can, rarely, swap a row between pages (seen at offset 100, never at 500). Ids repeated by Evolution (496) are dropped by `key.id`.

- [ ] **Step 1: Write the failing copy tests**

Create `server/test/history/copy.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatEvents, chats, contacts, messages } from '../../src/db/schema.js';
import { copyRange, monthlyWindows } from '../../src/history/copy.js';
import { GatewayError } from '../../src/whatsapp/types.js';
import { makeTestCtx, seedBasics } from '../helpers.js';
import { LID, LID_JID, rec } from './records.js';

type Ctx = Awaited<ReturnType<typeof makeTestCtx>>;

let ctx: Ctx;
let s: Awaited<ReturnType<typeof seedBasics>>;
let channel: { id: string; evolutionInstance: string };
let logged: ReturnType<typeof vi.spyOn>;

const FROM = new Date('2026-08-01T00:00:00Z');
const TO = new Date('2026-10-14T13:00:00Z');

beforeEach(async () => {
  ctx = await makeTestCtx();
  s = await seedBasics(ctx);
  channel = { id: s.channelId, evolutionInstance: s.instance };
  logged = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('monthlyWindows', () => {
  it('splits by UTC calendar month, newest first, with inclusive whole-second bounds', () => {
    expect(monthlyWindows(new Date('2026-07-16T12:00:00Z'), new Date('2026-10-14T13:00:00Z'))).toEqual([
      { gte: new Date('2026-10-01T00:00:00Z'), lte: new Date('2026-10-14T13:00:00Z') },
      { gte: new Date('2026-09-01T00:00:00Z'), lte: new Date('2026-09-30T23:59:59Z') },
      { gte: new Date('2026-08-01T00:00:00Z'), lte: new Date('2026-08-31T23:59:59Z') },
      { gte: new Date('2026-07-16T12:00:00Z'), lte: new Date('2026-07-31T23:59:59Z') },
    ]);
    expect(monthlyWindows(new Date('2026-10-14T13:00:00Z'), new Date('2026-10-14T12:00:00Z'))).toEqual([]);
  });
});

describe('copyRange', () => {
  it('reads every page of every window, copies each message once and writes one event per history chat', async () => {
    const start = Date.parse('2026-10-02T00:00:00Z');
    for (let i = 0; i < 501; i += 1) ctx.wa.historyRecords.push(rec({ id: `o${i}`, at: new Date(start + i * 60_000).toISOString() }));
    // Evolution stored this one twice (two history chunks overlap)
    ctx.wa.historyRecords.push(rec({ id: 's1', at: '2026-09-10T08:00:00Z' }), rec({ id: 's1', at: '2026-09-10T08:00:00Z' }));

    const totals = await copyRange(ctx, channel, FROM, TO);

    expect(totals).toEqual({ inserted: 502, contactsCreated: 1, oldest: new Date('2026-09-10T08:00:00Z') });
    expect(ctx.wa.findCalls.map((c) => [c.gte.slice(0, 7), c.page, c.offset])).toEqual([
      ['2026-10', 1, 500],
      ['2026-10', 2, 500],
      ['2026-09', 1, 500],
      ['2026-08', 1, 500],
    ]);
    expect(await ctx.db.$count(messages)).toBe(502);
    const [chat] = await ctx.db.select().from(chats);
    const events = await ctx.db.select().from(chatEvents).where(eq(chatEvents.chatId, chat!.id));
    expect(events.map((e) => [e.kind, e.data])).toEqual([['history_imported', { count: 502 }]]);
  });

  it('only reads inside [from, to]', async () => {
    ctx.wa.historyRecords.push(rec({ id: 'antes', at: '2026-07-31T23:59:59Z' }), rec({ id: 'dentro', at: '2026-08-01T00:00:00Z' }));
    expect((await copyRange(ctx, channel, FROM, TO)).inserted).toBe(1);
    expect((await ctx.db.select().from(messages)).map((m) => m.externalId)).toEqual(['dentro']);
  });

  it("names contacts from Evolution's Contact table, ignoring digits-only names", async () => {
    ctx.wa.contactRecords.push(
      { remoteJid: LID_JID, pushName: 'Maria Souza' },
      { remoteJid: '556588887777@s.whatsapp.net', pushName: '556588887777' },
    );
    ctx.wa.historyRecords.push(
      rec({ id: 'l1', at: '2026-10-01T10:00:00Z', jid: LID_JID }),
      rec({ id: 'p1', at: '2026-10-01T11:00:00Z', jid: '556588887777@s.whatsapp.net' }),
    );
    await copyRange(ctx, channel, FROM, TO);
    const rows = await ctx.db.select({ phone: contacts.phone, lid: contacts.lid, name: contacts.name }).from(contacts);
    expect(rows).toEqual(
      expect.arrayContaining([
        { phone: null, lid: LID, name: 'Maria Souza' },
        { phone: '5565988887777', lid: null, name: null },
      ]),
    );
  });

  it('copies without names when findContacts fails, logging only the error name', async () => {
    ctx.wa.findContacts = async () => {
      throw new Error('Evolution POST /chat/findContacts/talk-test failed: 500 Maria Souza');
    };
    ctx.wa.historyRecords.push(rec({ id: 'p1', at: '2026-10-01T10:00:00Z' }));
    expect((await copyRange(ctx, channel, FROM, TO)).inserted).toBe(1);
    expect(logged).toHaveBeenCalledWith('history: findContacts failed', 'Error');
  });

  it('stops at the first Evolution failure and keeps what was already copied (§9)', async () => {
    ctx.wa.historyRecords.push(rec({ id: 'out1', at: '2026-10-05T10:00:00Z' }), rec({ id: 'set1', at: '2026-09-05T10:00:00Z' }));
    const real = ctx.wa.findMessages;
    let n = 0;
    ctx.wa.findMessages = async (instance, q) => {
      n += 1;
      if (n === 2) throw new GatewayError('Evolution POST /chat/findMessages/talk-test failed: 500 ', 500);
      return real(instance, q);
    };

    await expect(copyRange(ctx, channel, FROM, TO)).rejects.toMatchObject({ name: 'GatewayError', status: 500 });
    expect((await ctx.db.select().from(messages)).map((m) => m.externalId)).toEqual(['out1']);
    // the event for what did come in is still written
    expect((await ctx.db.select().from(chatEvents)).map((e) => e.data)).toEqual([{ count: 1 }]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w server -- test/history/copy.test.ts`
Expected: FAIL. `Failed to load url ../../src/history/copy.js … Does the file exist?`.

- [ ] **Step 3: Export `errorTag` with the HTTP status**

In `server/src/bots/scheduler.ts`, replace lines 14-19 (doc comment and `function errorTag`) with:

```ts
/** Error name and pg code (or HTTP status of a GatewayError) only: never the message, which may quote contact data. */
export function errorTag(err: unknown): string {
  const e = err as { name?: unknown; code?: unknown; status?: unknown } | null;
  const name = typeof e?.name === 'string' ? e.name : 'Error';
  if (typeof e?.code === 'string') return `${name} ${e.code}`;
  return typeof e?.status === 'number' ? `${name} ${e.status}` : name;
}
```

- [ ] **Step 4: Implement the copy**

Create `server/src/history/copy.ts`:

```ts
import { errorTag } from '../bots/scheduler.js';
import type { AppCtx } from '../ctx.js';
import { lidFromJid, phoneFromJid } from '../whatsapp/phone.js';
import { placeRecords, realName, writeHistoryEvents, type ChannelRef, type ContactNames, type PlaceResult } from './place.js';

/** §5.2: findMessages page size; each page is placed in one transaction. */
export const PAGE_SIZE = 500;

export interface CopyTotals {
  inserted: number;
  contactsCreated: number;
  oldest: Date | null;
}

/** UTC calendar months covering [from, to], newest first; both bounds inclusive (Evolution floors to seconds). */
export function monthlyWindows(from: Date, to: Date): Array<{ gte: Date; lte: Date }> {
  const out: Array<{ gte: Date; lte: Date }> = [];
  let end = to;
  while (end >= from) {
    const monthStart = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
    out.push({ gte: monthStart < from ? from : monthStart, lte: end });
    end = new Date(monthStart.getTime() - 1000);
  }
  return out;
}

/** Address-book names Evolution keeps (DATABASE_SAVE_DATA_CONTACTS); best effort. */
async function loadContactNames(ctx: AppCtx, instance: string): Promise<ContactNames> {
  const names: ContactNames = new Map();
  try {
    for (const c of await ctx.wa.findContacts(instance)) {
      const name = realName(c.pushName);
      if (!name) continue;
      const phone = phoneFromJid(c.remoteJid);
      const lid = lidFromJid(c.remoteJid);
      if (phone) names.set(`p:${phone}`, name);
      if (lid) names.set(`l:${lid}`, name);
    }
  } catch (err) {
    // without names a contact shows its number, or "Contato sem número"
    console.error('history: findContacts failed', errorTag(err));
  }
  return names;
}

/**
 * Copies Evolution's stored messages with messageTimestamp in [from, to] as history (§5.2–5.4): monthly windows
 * newest first, every page of each. `onPage` sees each page's result (progress). Throws on the first Evolution
 * failure; what was copied before stays, and its history_imported events are still written.
 */
export async function copyRange(
  ctx: AppCtx,
  channel: ChannelRef,
  from: Date,
  to: Date,
  onPage?: (r: PlaceResult) => Promise<void>,
): Promise<CopyTotals> {
  const totals: CopyTotals = { inserted: 0, contactsCreated: 0, oldest: null };
  const names = await loadContactNames(ctx, channel.evolutionInstance);
  const seen = new Set<string>();
  const historyCounts = new Map<string, number>();
  try {
    for (const w of monthlyWindows(from, to)) {
      // ponytail: OFFSET pages over "messageTimestamp DESC" with no tiebreaker may swap a row at a page edge inside a
      // same-second group (measured: never at offset 500); the next import or back-fill pass picks a missed row up.
      for (let page = 1, pages = 1; page <= pages; page += 1) {
        const res = await ctx.wa.findMessages(channel.evolutionInstance, { gte: w.gte, lte: w.lte, page, offset: PAGE_SIZE });
        pages = res.pages;
        const r = await placeRecords(ctx, channel, res.records, { names, seen });
        totals.inserted += r.inserted;
        totals.contactsCreated += r.contactsCreated;
        if (r.oldest && (!totals.oldest || r.oldest < totals.oldest)) totals.oldest = r.oldest;
        for (const [id, n] of r.historyCounts) historyCounts.set(id, (historyCounts.get(id) ?? 0) + n);
        if (onPage) await onPage(r);
      }
    }
  } finally {
    await writeHistoryEvents(ctx, historyCounts);
  }
  return totals;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w server -- test/history/copy.test.ts test/bots/scheduler.test.ts`
Expected: PASS (`scheduler.test.ts` still sees `'Error 57P01'`).

Run: `npm run typecheck -w server`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add server/src/bots/scheduler.ts server/src/history/copy.ts server/test/history/copy.test.ts
git commit -m "feat(server): copia da Evolution por janelas mensais, todas as páginas, sem ids repetidos" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Automatic merge of LID-only contacts

**Files:**
- Create: `server/src/history/merge.ts`
- Modify: `server/src/history/place.ts` (import; merge before placing, in `placeRecords`)
- Modify: `server/test/inbox/fixtures.ts:25-48` (`insertChat` gets `history`)
- Test: `server/test/history/merge.test.ts`

**Interfaces:**
- Consumes: Task 1 `chats.history`, event kind `contact_merged`; Task 3 `placeRecords`, builders `PHONE`, `PHONE_JID`, `LID`, `LID_JID`, `rec`; existing `removeAvatarFile(mediaDir, path)` (`media/avatar-files.ts`), `addEvent`, `seedMessage` (`test/chats/seed.ts`), `eventsOf`/`newContact` (`test/inbox/fixtures.ts`).
- Produces (contract): `mergeLidPairs(ctx, pairs): Promise<number>` (number of contacts joined into a phone contact). `insertChat(ctx, { …, history?: boolean })` in the test fixtures.

Why pairs come from copied rows: webhooks never carry the LID (Evolution rewrites `remoteJid` to the phone before sending), and no Evolution endpoint returns a LID↔phone map. Evolution's own live rows keep `remoteJid = <lid>@lid` plus `remoteJidAlt = <phone>@s.whatsapp.net` (strictly 1:1), and every import pass and every 5-min back-fill reads those rows; the parser turns such a row into `phone` + `lid`. So `placeRecords` merges each pair it meets before placing the batch, including pairs on rows the app already stores (spec §5.4, §6 "no mesmo ciclo").

Merge rules (spec §5.4): only a contact that has the LID **and no phone** is merged. No contact with that phone → the LID-only contact just gets the phone. Otherwise, per chat of the LID-only contact: an open chat whose twin (the phone contact's open chat on the same channel) exists hands its messages and events to the twin and is deleted; a history chat with a twin history chat does the same (the twin widens `created_at`/`closed_at`); any other chat just changes `contact_id`. Tags and custom fields are united (the phone contact's value wins on a clash); notes and bot runs move; empty fields of the phone contact are filled; the LID-only contact is deleted and its LID moves to the phone contact; each surviving chat gets a `contact_merged` event; they are published after commit.

- [ ] **Step 1: Let the fixtures insert history chats**

In `server/test/inbox/fixtures.ts`, replace `insertChat` (lines 25-48) with:

```ts
/** Inserts a chat row directly (no event, no hub); returns its id. */
export async function insertChat(
  ctx: AppCtx,
  f: { channelId: string; sectorId: string; contactId?: string; ownerId?: string | null; private?: boolean; state?: 'open' | 'closed'; unread?: number; history?: boolean },
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
    history: f.history ?? false,
  });
  return id;
}
```

- [ ] **Step 2: Write the failing merge tests**

Create `server/test/history/merge.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { chats, contactFieldValues, contactNotes, contactTags, contacts, customFields, messages, tags } from '../../src/db/schema.js';
import { mergeLidPairs } from '../../src/history/merge.js';
import { placeRecords } from '../../src/history/place.js';
import { makeTestCtx, seedBasics } from '../helpers.js';
import { seedMessage } from '../chats/seed.js';
import { eventsOf, insertChat, newContact } from '../inbox/fixtures.js';
import { LID, LID_JID, PHONE, PHONE_JID, rec } from './records.js';

type Ctx = Awaited<ReturnType<typeof makeTestCtx>>;

let ctx: Ctx;
let s: Awaited<ReturnType<typeof seedBasics>>;

beforeEach(async () => {
  ctx = await makeTestCtx();
  s = await seedBasics(ctx);
});

const at = (iso: string) => new Date(iso);
const pair = [{ lid: LID, phone: PHONE }];
const chatById = async (id: string) => (await ctx.db.select().from(chats).where(eq(chats.id, id)))[0];

async function lidOnly(extra: Partial<typeof contacts.$inferInsert> = {}): Promise<string> {
  const id = randomUUID();
  await ctx.db.insert(contacts).values({ id, lid: LID, phone: null, name: null, ...extra });
  return id;
}

describe('mergeLidPairs (§5.4)', () => {
  it('joins the LID-only contact into the phone contact: chats, tags, fields and notes move, phone values win', async () => {
    const lidId = await lidOnly({ name: 'Maria (sem número)', email: 'maria@exemplo.com.br' });
    const phoneId = await newContact(ctx, { phone: PHONE, name: 'Maria' });
    const historyChat = await insertChat(ctx, { channelId: s.channelId, sectorId: s.defaultSector, contactId: lidId, state: 'closed', history: true });
    const [t1, t2] = await ctx.db
      .insert(tags)
      .values([{ name: 'Cliente', color: '#22c55e' }, { name: 'VIP', color: '#ef4444' }])
      .returning({ id: tags.id });
    await ctx.db.insert(contactTags).values([
      { contactId: lidId, tagId: t1!.id },
      { contactId: lidId, tagId: t2!.id },
      { contactId: phoneId, tagId: t1!.id },
    ]);
    const [cpf, origem] = await ctx.db
      .insert(customFields)
      .values([{ name: 'CPF', kind: 'cpf' }, { name: 'Origem', kind: 'text' }])
      .returning({ id: customFields.id });
    await ctx.db.insert(contactFieldValues).values([
      { contactId: lidId, fieldId: cpf!.id, value: '111' },
      { contactId: phoneId, fieldId: cpf!.id, value: '222' },
      { contactId: lidId, fieldId: origem!.id, value: 'Indicação' },
    ]);
    await ctx.db.insert(contactNotes).values({ contactId: lidId, body: 'Ligar à tarde' });

    expect(await mergeLidPairs(ctx, pair)).toBe(1);

    expect(await ctx.db.select().from(contacts).where(eq(contacts.id, lidId))).toEqual([]);
    const [c] = await ctx.db.select().from(contacts).where(eq(contacts.id, phoneId));
    expect(c).toMatchObject({ phone: PHONE, lid: LID, name: 'Maria', email: 'maria@exemplo.com.br' });
    expect((await chatById(historyChat))!.contactId).toBe(phoneId);
    const tagIds = (await ctx.db.select().from(contactTags).where(eq(contactTags.contactId, phoneId))).map((r) => r.tagId);
    expect(tagIds.sort()).toEqual([t1!.id, t2!.id].sort());
    const fields = await ctx.db.select().from(contactFieldValues).where(eq(contactFieldValues.contactId, phoneId));
    expect(new Map(fields.map((f) => [f.fieldId, f.value]))).toEqual(new Map([[cpf!.id, '222'], [origem!.id, 'Indicação']]));
    expect((await ctx.db.select().from(contactNotes))[0]!.contactId).toBe(phoneId);
    expect((await eventsOf(ctx, historyChat)).map((e) => [e.kind, e.data])).toEqual([['contact_merged', {}]]);
  });

  it("with an open chat on both sides, the LID chat's messages go into the phone contact's open chat", async () => {
    const lidId = await lidOnly();
    const phoneId = await newContact(ctx, { phone: PHONE });
    const lidChat = await insertChat(ctx, { channelId: s.channelId, sectorId: s.defaultSector, contactId: lidId, unread: 1 });
    const phoneChat = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, contactId: phoneId, unread: 2 });
    const m1 = await seedMessage(ctx, lidChat, s.channelId, at('2026-10-14T12:30:00Z'), { body: 'pelo LID' });
    await seedMessage(ctx, phoneChat, s.channelId, at('2026-10-14T12:00:00Z'), { body: 'antes' });
    await ctx.db.update(chats).set({ lastMessageAt: at('2026-10-14T12:30:00Z'), lastMessagePreview: 'pelo LID' }).where(eq(chats.id, lidChat));
    await ctx.db.update(chats).set({ lastMessageAt: at('2026-10-14T12:00:00Z'), lastMessagePreview: 'antes' }).where(eq(chats.id, phoneChat));

    await mergeLidPairs(ctx, pair);

    expect(await chatById(lidChat)).toBeUndefined();
    expect((await ctx.db.select().from(messages).where(eq(messages.id, m1)))[0]!.chatId).toBe(phoneChat);
    expect(await chatById(phoneChat)).toMatchObject({
      sectorId: s.sectorA, unread: 3, lastMessageAt: at('2026-10-14T12:30:00Z'), lastMessagePreview: 'pelo LID',
    });
    expect((await eventsOf(ctx, phoneChat)).map((e) => e.kind)).toEqual(['contact_merged']);
    expect(ctx.hub.events).toContainEqual({ type: 'chat', chatId: phoneChat });
  });

  it('two history chats become one spanning both', async () => {
    const lidId = await lidOnly();
    const phoneId = await newContact(ctx, { phone: PHONE });
    const lidChat = await insertChat(ctx, { channelId: s.channelId, sectorId: s.defaultSector, contactId: lidId, state: 'closed', history: true });
    const phoneChat = await insertChat(ctx, { channelId: s.channelId, sectorId: s.defaultSector, contactId: phoneId, state: 'closed', history: true });
    await ctx.db.update(chats).set({ createdAt: at('2026-08-01T10:00:00Z'), closedAt: at('2026-08-05T10:00:00Z') }).where(eq(chats.id, lidChat));
    await ctx.db.update(chats).set({ createdAt: at('2026-09-01T10:00:00Z'), closedAt: at('2026-09-03T10:00:00Z') }).where(eq(chats.id, phoneChat));
    const m1 = await seedMessage(ctx, lidChat, s.channelId, at('2026-08-02T10:00:00Z'));

    await mergeLidPairs(ctx, pair);

    expect(await ctx.db.select().from(chats).where(eq(chats.contactId, phoneId))).toHaveLength(1);
    expect(await chatById(phoneChat)).toMatchObject({ createdAt: at('2026-08-01T10:00:00Z'), closedAt: at('2026-09-03T10:00:00Z') });
    expect((await ctx.db.select().from(messages).where(eq(messages.id, m1)))[0]!.chatId).toBe(phoneChat);
  });

  it('without a contact holding that phone, the LID-only contact only gains the phone', async () => {
    const lidId = await lidOnly();
    expect(await mergeLidPairs(ctx, pair)).toBe(0);
    const [c] = await ctx.db.select().from(contacts).where(eq(contacts.id, lidId));
    expect(c).toMatchObject({ phone: PHONE, lid: LID });
  });

  it('leaves a contact that already has a phone alone', async () => {
    const both = await newContact(ctx, { phone: '5565988887777' });
    await ctx.db.update(contacts).set({ lid: LID }).where(eq(contacts.id, both));
    await newContact(ctx, { phone: PHONE });
    expect(await mergeLidPairs(ctx, pair)).toBe(0);
    expect(await ctx.db.$count(contacts)).toBe(2);
  });

  it('runs inside placeRecords: a live row with remoteJid @lid + remoteJidAlt merges before it is placed', async () => {
    const lidId = await lidOnly();
    const historyChat = await insertChat(ctx, { channelId: s.channelId, sectorId: s.defaultSector, contactId: lidId, state: 'closed', history: true });
    const phoneId = await newContact(ctx, { phone: PHONE, name: 'Maria' });

    await placeRecords(
      ctx,
      { id: s.channelId, evolutionInstance: s.instance },
      [rec({ id: 'live-lid', at: '2026-10-14T12:00:00Z', jid: LID_JID, alt: PHONE_JID, pushName: 'Maria' })],
      { names: new Map(), seen: new Set() },
    );

    expect(await ctx.db.select().from(contacts).where(eq(contacts.lid, LID))).toMatchObject([{ id: phoneId, phone: PHONE }]);
    const [m] = await ctx.db.select().from(messages).where(eq(messages.externalId, 'live-lid'));
    expect(m!.chatId).toBe(historyChat);
    expect((await chatById(historyChat))!.contactId).toBe(phoneId);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -w server -- test/history/merge.test.ts`
Expected: FAIL. `Failed to load url ../../src/history/merge.js … Does the file exist?`.

- [ ] **Step 4: Implement the merge**

Create `server/src/history/merge.ts`:

```ts
import { and, eq, isNull } from 'drizzle-orm';
import type { AppCtx } from '../ctx.js';
import type { Tx } from '../db/client.js';
import { botRuns, chatEvents, chats, contactFieldValues, contactNotes, contactTags, contacts, messages } from '../db/schema.js';
import { addEvent } from '../inbox/events.js';
import { removeAvatarFile } from '../media/avatar-files.js';

type Contact = typeof contacts.$inferSelect;
type ChatRow = typeof chats.$inferSelect;

const earliest = (a: Date, b: Date) => (a < b ? a : b);
const latest = (a: Date | null, b: Date | null) => (a && b ? (a > b ? a : b) : (a ?? b));

/** The phone contact's chat that takes `from` over (same channel, both open or both history), if any. */
async function twinOf(tx: Tx, from: ChatRow, intoId: string): Promise<ChatRow | undefined> {
  if (from.state !== 'open' && !from.history) return undefined;
  const [twin] = await tx
    .select()
    .from(chats)
    .where(
      and(eq(chats.contactId, intoId), eq(chats.channelId, from.channelId), from.history ? eq(chats.history, true) : eq(chats.state, 'open')),
    );
  return twin;
}

/** Moves `from`'s messages and events into `twin`, then deletes `from` (its pins and bot runs go with it). */
async function absorb(tx: Tx, from: ChatRow, twin: ChatRow): Promise<void> {
  await tx.update(messages).set({ chatId: twin.id }).where(eq(messages.chatId, from.id));
  await tx.update(chatEvents).set({ chatId: twin.id }).where(eq(chatEvents.chatId, from.id));
  await tx.delete(chats).where(eq(chats.id, from.id));
  const newer = from.lastMessageAt !== null && (twin.lastMessageAt === null || from.lastMessageAt > twin.lastMessageAt);
  await tx
    .update(chats)
    .set({
      unread: twin.unread + from.unread,
      ...(newer ? { lastMessageAt: from.lastMessageAt, lastMessagePreview: from.lastMessagePreview } : {}),
      ...(twin.history ? { createdAt: earliest(twin.createdAt, from.createdAt), closedAt: latest(twin.closedAt, from.closedAt) } : {}),
    })
    .where(eq(chats.id, twin.id));
}

/** Joins `from` (LID only) into `into` (has the phone); returns the ids of the chats that now hold `from`'s history. */
async function moveContact(tx: Tx, from: Contact, into: Contact): Promise<string[]> {
  const touched = new Set<string>();
  for (const chat of await tx.select().from(chats).where(eq(chats.contactId, from.id))) {
    const twin = await twinOf(tx, chat, into.id);
    if (twin) {
      await absorb(tx, chat, twin);
      touched.add(twin.id);
    } else {
      await tx.update(chats).set({ contactId: into.id }).where(eq(chats.id, chat.id));
      touched.add(chat.id);
    }
  }
  // Tags and custom fields are united; on a clash the phone contact's value stays (§5.4).
  const tagRows = await tx.select({ tagId: contactTags.tagId }).from(contactTags).where(eq(contactTags.contactId, from.id));
  if (tagRows.length) {
    await tx.insert(contactTags).values(tagRows.map((t) => ({ contactId: into.id, tagId: t.tagId }))).onConflictDoNothing();
  }
  const fieldRows = await tx.select().from(contactFieldValues).where(eq(contactFieldValues.contactId, from.id));
  if (fieldRows.length) {
    await tx
      .insert(contactFieldValues)
      .values(fieldRows.map((f) => ({ contactId: into.id, fieldId: f.fieldId, value: f.value })))
      .onConflictDoNothing();
  }
  await tx.update(contactNotes).set({ contactId: into.id }).where(eq(contactNotes.contactId, from.id));
  await tx.update(botRuns).set({ contactId: into.id }).where(eq(botRuns.contactId, from.id));
  await tx.delete(contacts).where(eq(contacts.id, from.id)); // frees the lid (unique); its tag/field rows cascade
  await tx
    .update(contacts)
    .set({
      lid: into.lid ?? from.lid,
      name: into.name ?? from.name,
      email: into.email ?? from.email,
      landline: into.landline ?? from.landline,
      address: into.address ?? from.address,
      updatedAt: new Date(),
    })
    .where(eq(contacts.id, into.id));
  for (const id of touched) await addEvent(tx, id, 'contact_merged', {}, null);
  return [...touched];
}

/**
 * §5.4: for each LID ↔ phone pair seen on a live Evolution row, a contact that has only that LID is joined into the
 * contact with that phone, or just gains the phone when there is none. One short transaction per pair; publishes the
 * chats that changed after commit. Returns how many contacts were joined into another.
 */
export async function mergeLidPairs(ctx: AppCtx, pairs: Array<{ lid: string; phone: string }>): Promise<number> {
  let merged = 0;
  const done = new Set<string>();
  for (const { lid, phone } of pairs) {
    if (done.has(lid)) continue;
    done.add(lid);
    const out = await ctx.db.transaction(async (tx) => {
      const [from] = await tx.select().from(contacts).where(and(eq(contacts.lid, lid), isNull(contacts.phone)));
      if (!from) return null;
      const [into] = await tx.select().from(contacts).where(eq(contacts.phone, phone));
      if (!into) {
        await tx.update(contacts).set({ phone, updatedAt: new Date() }).where(eq(contacts.id, from.id));
        return null;
      }
      return { chatIds: await moveContact(tx, from, into), avatarPath: from.avatarPath };
    });
    if (!out) continue;
    merged += 1;
    if (out.avatarPath) await removeAvatarFile(ctx.config.mediaDir, out.avatarPath).catch(() => undefined);
    for (const chatId of out.chatIds) await ctx.hub.publishChat(chatId);
  }
  return merged;
}
```

- [ ] **Step 5: Merge before placing each batch**

In `server/src/history/place.ts`, add to the imports:

```ts
import { mergeLidPairs } from './merge.js';
```

and in `placeRecords`, right after `const parsed = toHistoryEvents(channel.evolutionInstance, records);`, add:

```ts
  // §5.4/§6: a live row carries remoteJid @lid + remoteJidAlt (the phone). Join a LID-only contact into the phone one
  // first, so this batch (and every later one) finds a single contact. Rows the app already stores count too.
  await mergeLidPairs(ctx, parsed.flatMap((ev) => (ev.phone && ev.lid ? [{ lid: ev.lid, phone: ev.phone }] : [])));
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -w server -- test/history/merge.test.ts test/history/place.test.ts test/history/copy.test.ts`
Expected: PASS.

Run: `npm run typecheck -w server`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add server/src/history/merge.ts server/src/history/place.ts server/test/inbox/fixtures.ts server/test/history/merge.test.ts
git commit -m "feat(server): junta contato só com LID ao contato com telefone quando a Evolution revela o par" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: History media: queue, "expirada" and "Baixar"

**Files:**
- Modify: `server/src/messages/dto.ts:9` (`MEDIA_KINDS` exported), `:64` (`mediaExpired`)
- Create: `server/src/history/media.ts`
- Modify: `server/src/chats/routes.ts:7` (import, before `../inbox/chats.js`), `:188-190` (new route right after resend)
- Modify: `web/src/lib/api.ts:198` (`api.messages.downloadMedia`, after `mediaUrl`; the message-action calls stay)
- Modify: `web/src/components/conversation/MessageBubble.tsx:37-44` (`MediaView` opening), new `DownloadButton` (its imports — `useState`, `useQueryClient`, `api`, `applyWsEvent`, `errorMessage` — are already in the file)
- Test: `server/test/history/media.test.ts`, `server/test/messages/dto.test.ts:41`, `server/test/realtime/hub.test.ts:160`, `web/src/components/conversation/MessageBubble.test.tsx`

**Interfaces:**
- Consumes: Task 1 `messages.mediaStatus`, `MessageDto.mediaExpired`; Task 2 `ctx.wa.downloadMediaById`, `GatewayError`, fake `mediaById`/`mediaLookups`; Task 3 `MEDIA_MAX_AGE_MS`; Task 4 `errorTag`; existing `saveMedia(mediaDir, data, mime, originalName?)` (`messages/media.ts`), `MEDIA_UNAVAILABLE` (`messages/ingest.ts`), `getChatForUser` (`inbox/chats.ts`), `toMessageDto`, `applyWsEvent`, `errorMessage`.
- Produces (contract): `MediaOutcome`, `downloadMessageMedia`, `drainMediaQueue`, `downloadMediaForUser`; `MEDIA_KINDS` exported from `messages/dto.ts`; route `POST /api/messages/:id/media` → `MessageDto` (200), 404 when the user cannot see the chat, 400 `'Esta mensagem não tem arquivo.'`, 502 `'Não foi possível baixar o arquivo. Tente de novo.'`; `api.messages.downloadMedia(messageId)`.

States of a media message without a file: `media_status = 'queued'` (history ≤ 21 days, waiting for the queue), `'expired'` (older, or Evolution answered 400; never retried, bubble says "Arquivo não está mais disponível no WhatsApp"), `null` with `error = 'mídia indisponível'` (a temporary failure, live or history; the bubble offers "Baixar"). The queue runs one download at a time, newest first, only for connected channels; a queued item that is older than 21 days by the time its turn comes (app down for weeks) becomes expired without a call.

- [ ] **Step 1: Write the failing server tests**

Create `server/test/history/media.test.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { channels, messages } from '../../src/db/schema.js';
import { downloadMessageMedia, drainMediaQueue } from '../../src/history/media.js';
import { toMessageDto } from '../../src/messages/dto.js';
import { MEDIA_UNAVAILABLE } from '../../src/messages/ingest.js';
import { GatewayError } from '../../src/whatsapp/types.js';
import { loginAs, makeTestApp, makeTestCtx, seedBasics } from '../helpers.js';
import { seedMessage } from '../chats/seed.js';
import { insertChat } from '../inbox/fixtures.js';

type Ctx = Awaited<ReturnType<typeof makeTestCtx>>;

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const expired400 = () => new GatewayError('Evolution POST /chat/getBase64FromMediaMessage/talk-test failed: 400 {"status":400}', 400);

let ctx: Ctx;
let s: Awaited<ReturnType<typeof seedBasics>>;
let chatId: string;
let logged: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  ctx = await makeTestCtx(); // fake clock: 2026-10-14T13:00:00Z
  s = await seedBasics(ctx);
  chatId = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA });
  logged = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const media = (externalId: string, sentAt: string, extra: Partial<typeof messages.$inferInsert> = {}) =>
  seedMessage(ctx, chatId, s.channelId, new Date(sentAt), { kind: 'image', body: null, externalId, mediaMime: 'image/jpeg', ...extra });
const queued = (externalId: string, sentAt: string) => media(externalId, sentAt, { mediaStatus: 'queued' });
const row = async (id: string) => (await ctx.db.select().from(messages).where(eq(messages.id, id)))[0]!;

describe('downloadMessageMedia', () => {
  it('saves the file Evolution finds by key.id and clears the queue state', async () => {
    const id = await queued('img1', '2026-10-10T12:00:00Z');

    expect(await downloadMessageMedia(ctx, id)).toBe('saved');

    const m = await row(id);
    expect(m).toMatchObject({
      mediaStatus: null, error: null, mediaMime: 'image/png', mediaSize: Buffer.from(PNG, 'base64').length,
      mediaSha256: expect.stringMatching(/^[0-9a-f]{64}$/), // like live media: the recent-stickers list dedupes by it
    });
    expect((await readFile(join(ctx.config.mediaDir, m.mediaPath!))).toString('base64')).toBe(PNG);
    expect(ctx.wa.mediaLookups).toEqual([{ instance: s.instance, externalId: 'img1' }]);
    expect(ctx.hub.events).toContainEqual({ type: 'message.updated', chatId, messageId: id });
  });

  it('a 400 from Evolution marks the media expired for good (§5.5)', async () => {
    const id = await queued('img1', '2026-10-10T12:00:00Z');
    ctx.wa.mediaById.set('img1', expired400());

    expect(await downloadMessageMedia(ctx, id)).toBe('expired');

    const m = await row(id);
    expect(m).toMatchObject({ mediaStatus: 'expired', mediaPath: null, error: null });
    expect(await toMessageDto(ctx.db, m)).toMatchObject({ media: null, mediaUnavailable: true, mediaExpired: true });
    expect(await downloadMessageMedia(ctx, id)).toBe('skipped'); // never asked again
    expect(ctx.wa.mediaLookups).toHaveLength(1);
  });

  it('a temporary failure leaves it downloadable and logs only the error name', async () => {
    const id = await queued('img1', '2026-10-10T12:00:00Z');
    ctx.wa.mediaById.set('img1', new Error('The operation was aborted due to timeout'));

    expect(await downloadMessageMedia(ctx, id)).toBe('failed');

    const m = await row(id);
    expect(m).toMatchObject({ mediaStatus: null, error: MEDIA_UNAVAILABLE, mediaPath: null });
    expect(await toMessageDto(ctx.db, m)).toMatchObject({ mediaUnavailable: true, mediaExpired: false });
    expect(logged).toHaveBeenCalledWith('history: media download failed', { messageId: id, err: 'Error' });
  });
});

describe('drainMediaQueue', () => {
  it('downloads queued media one at a time, newest first; what aged past 21 days becomes expired unasked', async () => {
    const a = await queued('a', '2026-10-10T12:00:00Z');
    const b = await queued('b', '2026-10-12T12:00:00Z');
    const old = await queued('velha', '2026-09-01T12:00:00Z');

    expect(await drainMediaQueue(ctx)).toBe(2);

    expect(ctx.wa.mediaLookups.map((l) => l.externalId)).toEqual(['b', 'a']);
    expect((await row(a)).mediaPath).not.toBeNull();
    expect((await row(b)).mediaPath).not.toBeNull();
    expect((await row(old)).mediaStatus).toBe('expired');
  });

  it('leaves queued media alone while the channel is disconnected (Review Focus 4)', async () => {
    await ctx.db.update(channels).set({ status: 'disconnected' }).where(eq(channels.id, s.channelId));
    const a = await queued('a', '2026-10-10T12:00:00Z');

    expect(await drainMediaQueue(ctx)).toBe(0);

    expect((await row(a)).mediaStatus).toBe('queued');
    expect(ctx.wa.mediaLookups).toEqual([]);
  });

  it('stops when the signal aborts', async () => {
    await queued('a', '2026-10-10T12:00:00Z');
    const stop = new AbortController();
    stop.abort();
    expect(await drainMediaQueue(ctx, stop.signal)).toBe(0);
  });
});

describe('POST /api/messages/:id/media ("Baixar")', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    ({ app } = await makeTestApp(ctx));
  });
  afterEach(async () => {
    await app.close();
  });

  const post = async (email: string, id: string) => {
    const { headers } = await loginAs(app, email);
    return app.inject({ method: 'POST', url: `/api/messages/${id}/media`, headers });
  };

  it('downloads a file that failed before and returns the message with it', async () => {
    const id = await media('aud1', '2026-10-10T12:00:00Z', { kind: 'audio', error: MEDIA_UNAVAILABLE });
    const res = await post(s.agentA.email, id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id, media: { url: `/api/media/${id}` }, mediaUnavailable: false, mediaExpired: false, error: null });
  });

  it('is 404 for a chat the user cannot see', async () => {
    const id = await queued('img1', '2026-10-10T12:00:00Z');
    expect((await post(s.agentB.email, id)).statusCode).toBe(404);
    expect(ctx.wa.mediaLookups).toEqual([]);
  });

  it('answers an expired file as expired without asking WhatsApp again', async () => {
    const id = await media('img1', '2026-08-01T12:00:00Z', { mediaStatus: 'expired' });
    const res = await post(s.agentA.email, id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ mediaExpired: true });
    expect(ctx.wa.mediaLookups).toEqual([]);
  });

  it('a 400 from WhatsApp turns the message expired', async () => {
    const id = await queued('img1', '2026-10-10T12:00:00Z');
    ctx.wa.mediaById.set('img1', expired400());
    const res = await post(s.agentA.email, id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ mediaExpired: true, media: null });
  });

  it('a temporary failure is 502 and the message stays downloadable', async () => {
    const id = await queued('img1', '2026-10-10T12:00:00Z');
    ctx.wa.mediaById.set('img1', new Error('ECONNRESET'));
    const res = await post(s.agentA.email, id);
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('Não foi possível baixar o arquivo. Tente de novo.');
    expect((await row(id)).mediaStatus).toBeNull();
  });

  it('a text message has nothing to download', async () => {
    const id = await seedMessage(ctx, chatId, s.channelId, new Date('2026-10-10T12:00:00Z'), { externalId: 't1' });
    const res = await post(s.agentA.email, id);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Esta mensagem não tem arquivo.');
  });
});
```

In `server/test/messages/dto.test.ts`, the full `toEqual` literal (line 41) gains `mediaExpired: false,` after `mediaUnavailable: false,` (its message-action fields `officeReaction`, `deleted`, `edited`, `forwarded` stay). In `server/test/realtime/hub.test.ts`, the `message` literal (line 160) gains `mediaExpired: false,` after `mediaUnavailable: false,`.

- [ ] **Step 2: Write the failing web test**

In `web/src/components/conversation/MessageBubble.test.tsx`, the imports (`afterEach`, `vi`, `fireEvent`, `waitFor`), the file-level `afterEach` (cleanup + `vi.unstubAllGlobals()`), `stubFetch`/`calls`, `base` and `renderBubble(m, opts?)` already exist (message actions). Add at the end of the file:

```tsx
describe('MessageBubble media that is not on the server', () => {
  const missing: MessageDto = {
    ...base, direction: 'in', kind: 'image', body: null, media: null, mediaUnavailable: true,
    authorId: null, authorName: null, authorAvatarUrl: null,
  };

  it('says the file is gone from WhatsApp and offers no download', () => {
    const c = renderBubble({ ...missing, mediaExpired: true });
    expect(c.textContent).toContain('Arquivo não está mais disponível no WhatsApp');
    expect(screen.queryByRole('button', { name: 'Baixar' })).toBeNull();
  });

  it('"Baixar" asks the server for a file that is not downloaded yet', async () => {
    stubFetch({
      'POST /api/messages/m1/media': {
        ...missing, media: { url: '/api/media/m1', mime: 'image/png', name: null, size: 70 }, mediaUnavailable: false,
      },
    });
    renderBubble({ ...missing, mediaExpired: false });

    fireEvent.click(screen.getByRole('button', { name: 'Baixar' }));

    await waitFor(() => expect(calls).toContainEqual({ method: 'POST', path: '/api/messages/m1/media', body: undefined }));
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -w server -- test/history/media.test.ts test/messages/dto.test.ts`
Expected: FAIL. `media.test.ts` fails to collect (`Failed to load url ../../src/history/media.js`); `dto.test.ts` fails on `toEqual` (`mediaExpired` missing from the DTO).

Run: `npm test -w web -- src/components/conversation/MessageBubble.test.tsx`
Expected: FAIL. The expired test finds `mídia indisponível` instead of the new text; `Unable to find an accessible element with the role "button" and name "Baixar"`.

- [ ] **Step 4: Add `mediaExpired` to the message DTO**

In `server/src/messages/dto.ts`, replace line 9 with:

```ts
export const MEDIA_KINDS = new Set(['image', 'audio', 'video', 'document', 'sticker']);
```

and replace line 64 (`mediaUnavailable: …,`) with:

```ts
    mediaUnavailable: row.mediaPath == null && MEDIA_KINDS.has(row.kind),
    // §5.5: WhatsApp no longer has the file (history older than 3 weeks, or a 400 on download); never retried
    mediaExpired: row.mediaStatus === 'expired',
```

- [ ] **Step 5: Implement the download, the queue and the user action**

Create `server/src/history/media.ts`:

```ts
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { and, desc, eq, isNull, lt } from 'drizzle-orm';
import type { MessageDto } from '@talk/shared';
import { errorTag } from '../bots/scheduler.js';
import type { AppCtx } from '../ctx.js';
import { channels, messages } from '../db/schema.js';
import { getChatForUser } from '../inbox/chats.js';
import type { AuthUser } from '../inbox/visibility.js';
import { HttpError, badRequest, notFound } from '../lib/http-error.js';
import { MEDIA_KINDS, toMessageDto } from '../messages/dto.js';
import { MEDIA_UNAVAILABLE } from '../messages/ingest.js';
import { saveMedia } from '../messages/media.js';
import { GatewayError } from '../whatsapp/types.js';
import { MEDIA_MAX_AGE_MS } from './place.js';

export type MediaOutcome = 'saved' | 'expired' | 'failed' | 'skipped';

/**
 * §5.5: one download by key.id (Evolution looks the message up in its own DB), saved like live media. A 400 means
 * WhatsApp no longer has the file: expired, never retried. Anything else may be retried with "Baixar".
 * 'skipped' = nothing to do (already has a file, already expired, or no WhatsApp id).
 */
export async function downloadMessageMedia(ctx: AppCtx, messageId: string): Promise<MediaOutcome> {
  const [found] = await ctx.db
    .select({ msg: messages, instance: channels.evolutionInstance })
    .from(messages)
    .innerJoin(channels, eq(channels.id, messages.channelId))
    .where(eq(messages.id, messageId));
  if (!found || found.msg.mediaPath || found.msg.mediaStatus === 'expired' || !found.msg.externalId) return 'skipped';
  const { msg, instance } = found;
  const stillMissing = and(eq(messages.id, msg.id), isNull(messages.mediaPath)); // a double click or the queue got there first

  let outcome: MediaOutcome;
  try {
    const media = await ctx.wa.downloadMediaById(instance, msg.externalId!);
    const name = msg.mediaName ?? media.fileName ?? null;
    const saved = await saveMedia(ctx.config.mediaDir, Buffer.from(media.base64, 'base64'), media.mime, name);
    const [done] = await ctx.db
      .update(messages)
      .set({
        mediaPath: saved.path, mediaSize: saved.size, mediaMime: media.mime, mediaName: name, mediaSha256: saved.sha256,
        mediaStatus: null, error: null,
      })
      .where(stillMissing)
      .returning({ id: messages.id });
    if (!done) {
      await rm(join(ctx.config.mediaDir, saved.path), { force: true }); // the other download won: no orphan file
      return 'skipped';
    }
    outcome = 'saved';
  } catch (err) {
    const expired = err instanceof GatewayError && err.status === 400;
    if (!expired) console.error('history: media download failed', { messageId: msg.id, err: errorTag(err) });
    await ctx.db
      .update(messages)
      .set(expired ? { mediaStatus: 'expired', error: null } : { mediaStatus: null, error: MEDIA_UNAVAILABLE })
      .where(stillMissing);
    outcome = expired ? 'expired' : 'failed';
  }
  await ctx.hub.publishMessage(msg.chatId, 'message.updated', msg.id);
  return outcome;
}

/**
 * §5.5 queue: downloads queued history media one at a time, newest first, for connected channels only, until the
 * queue is empty or `signal` aborts. Returns how many it tried.
 */
export async function drainMediaQueue(ctx: AppCtx, signal?: AbortSignal): Promise<number> {
  let tried = 0;
  while (!signal?.aborted) {
    // Queued so long ago that WhatsApp dropped the file meanwhile (e.g. the app was down for weeks): no call needed.
    const cutoff = new Date(ctx.botRuntime.now().getTime() - MEDIA_MAX_AGE_MS);
    await ctx.db
      .update(messages)
      .set({ mediaStatus: 'expired' })
      .where(and(eq(messages.mediaStatus, 'queued'), lt(messages.sentAt, cutoff)));
    const [next] = await ctx.db
      .select({ id: messages.id })
      .from(messages)
      .innerJoin(channels, eq(channels.id, messages.channelId))
      .where(and(eq(messages.mediaStatus, 'queued'), eq(channels.status, 'connected')))
      .orderBy(desc(messages.sentAt))
      .limit(1);
    if (!next) break;
    if ((await downloadMessageMedia(ctx, next.id)) === 'skipped') {
      await ctx.db.update(messages).set({ mediaStatus: null }).where(eq(messages.id, next.id)); // not downloadable: leave the queue
    }
    tried += 1;
  }
  return tried;
}

/** "Baixar" (§5.5): one try for a media message the user can see; 502 on a temporary failure. */
export async function downloadMediaForUser(ctx: AppCtx, user: AuthUser, messageId: string): Promise<MessageDto> {
  const [msg] = await ctx.db.select().from(messages).where(eq(messages.id, messageId));
  if (!msg) throw notFound();
  await getChatForUser(ctx, user, msg.chatId); // 404 when the user cannot see the chat
  if (!MEDIA_KINDS.has(msg.kind)) throw badRequest('Esta mensagem não tem arquivo.');
  if (!msg.mediaPath && msg.mediaStatus !== 'expired') {
    if ((await downloadMessageMedia(ctx, msg.id)) === 'failed') throw new HttpError(502, 'Não foi possível baixar o arquivo. Tente de novo.');
  }
  const [fresh] = await ctx.db.select().from(messages).where(eq(messages.id, msg.id));
  return toMessageDto(ctx.db, fresh!);
}
```

In `server/src/chats/routes.ts`, add to the imports, before `import { assumeChat, … } from '../inbox/chats.js';` (line 7):

```ts
import { downloadMediaForUser } from '../history/media.js';
```

and right after the resend route (lines 188-190, before the `reaction` route), inside the same `app.register` scope:

```ts

    // §5.5 "Baixar": one download by key.id for a media message that has no file yet
    r.post('/api/messages/:id/media', async (req) => downloadMediaForUser(ctx, req.user, idParams.parse(req.params).id));
```

- [ ] **Step 6: The bubble: expired text and "Baixar"**

In `web/src/lib/api.ts`, in the `messages` block (lines 196-208), add after `mediaUrl: …,` (line 198; `react`, `remove`, `edit`, `edits` and `forward` below it stay):

```ts
    /** "Baixar": one download try for a media message without a file (history spec §5.5). */
    downloadMedia: (messageId: string) => request<MessageDto>('POST', `/api/messages/${enc(messageId)}/media`),
```

In `web/src/components/conversation/MessageBubble.tsx`, replace the `MediaView` opening (from `function MediaView({ m }: { m: MessageDto }) {` through the `mediaUnavailable` block, lines 37-44) with:

```tsx
/** §5.5: one download try; the answer replaces the message in the timeline cache. */
function DownloadButton({ m }: { m: MessageDto }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    setBusy(true);
    setError(null);
    try {
      applyWsEvent(qc, { type: 'message.updated', message: await api.messages.downloadMedia(m.id) });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" onClick={() => void download()} disabled={busy} className="font-semibold not-italic underline disabled:opacity-50">
        Baixar
      </button>
      {error && (
        <span role="alert" className="not-italic text-danger">
          {error}
        </span>
      )}
    </>
  );
}

function MediaView({ m }: { m: MessageDto }) {
  if (m.mediaExpired) {
    return (
      <p className="flex items-center gap-1 text-sm italic text-muted">
        <ImageBroken size={16} /> Arquivo não está mais disponível no WhatsApp
      </p>
    );
  }
  if (m.mediaUnavailable) {
    return (
      <p className="flex flex-wrap items-center gap-2 text-sm italic text-muted">
        <ImageBroken size={16} /> mídia indisponível <DownloadButton m={m} />
      </p>
    );
  }
```

(The rest of `MediaView` is unchanged.)

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test -w server -- test/history/media.test.ts test/messages/dto.test.ts test/realtime/hub.test.ts`
Expected: PASS.

Run: `npm test -w web -- src/components/conversation/MessageBubble.test.tsx`
Expected: PASS.

Run: `npm test`
Expected: PASS. If another test compares a full `MessageDto` with `toEqual`, add `mediaExpired: false` to its literal; do not change `toMessageDto`.

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add server/src/messages/dto.ts server/src/history/media.ts server/src/chats/routes.ts server/test/history/media.test.ts server/test/messages/dto.test.ts server/test/realtime/hub.test.ts web/src/lib/api.ts web/src/components/conversation/MessageBubble.tsx web/src/components/conversation/MessageBubble.test.tsx
git commit -m "feat: fila de mídia do histórico, estado expirada e botão Baixar" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: History import job, automatic start after a QR, channel DTO

**Files:**
- Create: `server/src/history/imports.ts`
- Create: `server/src/history/jobs.ts`
- Modify: `server/src/channels/service.ts:1-8` (imports), `:32-39` (`toChannelDto`, `listChannels`, new `loadChannelDto`), `:87-104` (`setChannelStatus`); `webhookUrl`, `createChannel`, `syncChannelStatuses` and `syncWebhooks` stay as they are
- Modify: `server/src/realtime/hub.ts:1-7` (imports), `:87-96` (`publishChannel`)
- Test: `server/test/history/jobs.test.ts`; update `server/test/channels/routes.test.ts:30-35` and `:57`, `server/test/channels/service.test.ts:42`, `server/test/realtime/hub.test.ts:185`

**Interfaces:**
- Consumes: Task 1 `historyImports`, `channels.historyPeriod/disconnectedAt`, `HistoryImportDto`; Task 4 `copyRange`, `errorTag`; Task 3 builders; existing `getChannelQr`/`setChannelQr` (`channels/service.ts`), `conflict`, `HttpError`.
- Produces (contract): `HistoryImportRow`, `IMPORT_RUNNING`, `toHistoryImportDto`, `latestImports`, `startHistoryImport`; `periodStart`, `runImportPass`; `toChannelDto(row, last?)`, `loadChannelDto`; `ChannelDto` always carries `historyPeriod`, `disconnectedAt`, `historyImport` (the newest import of the channel, or null); `setChannelStatus` keeps `disconnected_at` and starts an automatic import on a QR pairing.

Rules (spec §5.1, §5.6): an import is a `history_imports` row. A pass copies `[periodStart(period, now), now]` and adds its counts after every page (and publishes `channel.status`, so the screen shows "Importando histórico… N"). A manual import ends `done` after one pass. An automatic one sets `next_run_at = now + 2 min` while passes keep bringing news, and ends `done` once 10 min have passed since the last news (the start counts as news) or 60 min since it started. An Evolution error ends it `failed` with only `errorTag` in `error`; what came in stays and a new import can start. "A new QR pairing" = the status changes to `connected` while a QR is stored for the instance (the QR is stored from `connect` or `qrcode.updated` and cleared on `connected`); a session Evolution resumes on its own shows no QR and imports nothing.

- [ ] **Step 1: Write the failing tests**

Create `server/test/history/jobs.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { channels, historyImports, messages } from '../../src/db/schema.js';
import { listChannels, setChannelQr, setChannelStatus } from '../../src/channels/service.js';
import { IMPORT_RUNNING, startHistoryImport } from '../../src/history/imports.js';
import { periodStart, runImportPass } from '../../src/history/jobs.js';
import { GatewayError } from '../../src/whatsapp/types.js';
import { makeTestCtx, seedBasics } from '../helpers.js';
import { statusOf } from '../inbox/fixtures.js';
import { rec } from './records.js';

type Ctx = Awaited<ReturnType<typeof makeTestCtx>>;
const MIN = 60_000;
const T0 = new Date('2026-10-14T13:00:00Z'); // the fake clock's start
const after = (ms: number) => new Date(T0.getTime() + ms);

let ctx: Ctx;
let s: Awaited<ReturnType<typeof seedBasics>>;
let logged: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  ctx = await makeTestCtx();
  s = await seedBasics(ctx);
  logged = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const imports = () => ctx.db.select().from(historyImports);
const channelPublishes = () => ctx.hub.events.filter((e) => e.type === 'channel' && e.channelId === s.channelId).length;

describe('periodStart', () => {
  it('goes back 3 or 12 calendar months; "Tudo" starts in 2009', () => {
    expect(periodStart('3m', T0)).toEqual(new Date('2026-07-14T13:00:00Z'));
    expect(periodStart('12m', T0)).toEqual(new Date('2025-10-14T13:00:00Z'));
    expect(periodStart('all', T0)).toEqual(new Date('2009-01-01T00:00:00Z'));
  });
});

describe('startHistoryImport', () => {
  it('creates a running import due now and publishes the channel', async () => {
    const imp = await startHistoryImport(ctx, s.channelId, { period: '12m', auto: false });
    expect(imp).toMatchObject({ channelId: s.channelId, period: '12m', auto: false, state: 'running', startedAt: T0, nextRunAt: T0, messagesImported: 0 });
    expect(channelPublishes()).toBe(1);
  });

  it(`answers 409 "${IMPORT_RUNNING}" while one runs`, async () => {
    await startHistoryImport(ctx, s.channelId, { period: '3m', auto: false });
    const err = await startHistoryImport(ctx, s.channelId, { period: '3m', auto: false }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 409, message: IMPORT_RUNNING });
  });
});

describe('runImportPass', () => {
  it('a manual import copies its period once and ends done with the counts and the oldest date', async () => {
    ctx.wa.historyRecords.push(rec({ id: 'a', at: '2026-10-10T12:00:00Z' }), rec({ id: 'b', at: '2026-08-20T09:00:00Z' }));
    const imp = await startHistoryImport(ctx, s.channelId, { period: '3m', auto: false });

    const row = await runImportPass(ctx, imp.id);

    expect(row).toMatchObject({
      state: 'done', finishedAt: T0, nextRunAt: null, messagesImported: 2, contactsCreated: 1,
      oldestMessageAt: new Date('2026-08-20T09:00:00Z'), error: null,
    });
    expect(await runImportPass(ctx, imp.id)).toBeNull(); // a finished import never runs again
  });

  it('only copies the chosen period', async () => {
    ctx.wa.historyRecords.push(rec({ id: 'antiga', at: '2026-06-01T12:00:00Z' }), rec({ id: 'recente', at: '2026-09-01T12:00:00Z' }));
    const three = await startHistoryImport(ctx, s.channelId, { period: '3m', auto: false });
    expect((await runImportPass(ctx, three.id))?.messagesImported).toBe(1);
    const twelve = await startHistoryImport(ctx, s.channelId, { period: '12m', auto: false });
    expect((await runImportPass(ctx, twelve.id))?.messagesImported).toBe(1); // only the one the first pass left out
    expect(await ctx.db.$count(messages)).toBe(2);
  });

  it('publishes the progress after each page that brought something', async () => {
    ctx.wa.historyRecords.push(rec({ id: 'a', at: '2026-10-10T12:00:00Z' }), rec({ id: 'b', at: '2026-09-10T12:00:00Z' }));
    const imp = await startHistoryImport(ctx, s.channelId, { period: '3m', auto: false });
    const before = channelPublishes();
    await runImportPass(ctx, imp.id);
    expect(channelPublishes() - before).toBe(3); // October page, September page, the final state
  });

  it('an automatic import repeats every 2 min while news arrive and ends after 10 min without any (§5.1)', async () => {
    ctx.wa.historyRecords.push(rec({ id: 'a1', at: '2026-10-01T10:00:00Z' }));
    const imp = await startHistoryImport(ctx, s.channelId, { period: '3m', auto: true });

    expect(await runImportPass(ctx, imp.id)).toMatchObject({ state: 'running', messagesImported: 1, lastNewAt: T0, nextRunAt: after(2 * MIN) });

    ctx.clock.advance(2 * MIN);
    ctx.wa.historyRecords.push(rec({ id: 'a2', at: '2026-10-02T10:00:00Z' })); // the phone is still sending
    expect(await runImportPass(ctx, imp.id)).toMatchObject({ state: 'running', messagesImported: 2, lastNewAt: after(2 * MIN), nextRunAt: after(4 * MIN) });

    ctx.clock.advance(8 * MIN); // 8 min without news
    expect(await runImportPass(ctx, imp.id)).toMatchObject({ state: 'running', nextRunAt: after(12 * MIN) });

    ctx.clock.advance(2 * MIN); // 10 min without news
    expect(await runImportPass(ctx, imp.id)).toMatchObject({ state: 'done', finishedAt: after(12 * MIN), nextRunAt: null, messagesImported: 2 });
  });

  it('an automatic import ends after 60 min even while news keep coming', async () => {
    const imp = await startHistoryImport(ctx, s.channelId, { period: '3m', auto: true });
    await ctx.db.update(historyImports).set({ startedAt: new Date(T0.getTime() - 61 * MIN) }).where(eq(historyImports.id, imp.id));
    ctx.wa.historyRecords.push(rec({ id: 'n1', at: '2026-10-01T10:00:00Z' }));
    expect(await runImportPass(ctx, imp.id)).toMatchObject({ state: 'done', messagesImported: 1 });
  });

  it('an Evolution failure ends it failed with only the error name and status, keeping what came in; it can run again (§9)', async () => {
    ctx.wa.historyRecords.push(rec({ id: 'f1', at: '2026-10-10T10:00:00Z' }), rec({ id: 'f2', at: '2026-09-10T10:00:00Z' }));
    const real = ctx.wa.findMessages;
    let n = 0;
    ctx.wa.findMessages = async (instance, q) => {
      n += 1;
      if (n === 2) throw new GatewayError('Evolution POST /chat/findMessages/talk-test failed: 500 {"message":"Maria Souza"}', 500);
      return real(instance, q);
    };
    const imp = await startHistoryImport(ctx, s.channelId, { period: '3m', auto: true });

    expect(await runImportPass(ctx, imp.id)).toMatchObject({ state: 'failed', error: 'GatewayError 500', messagesImported: 1, nextRunAt: null });
    expect(logged.mock.calls.flat().join(' ')).not.toContain('Maria');
    await expect(startHistoryImport(ctx, s.channelId, { period: '3m', auto: false })).resolves.toMatchObject({ state: 'running' });
  });
});

describe('automatic import on a new QR pairing (§5.1)', () => {
  beforeEach(async () => {
    await ctx.db.update(channels).set({ status: 'connecting', historyPeriod: '12m' }).where(eq(channels.id, s.channelId));
  });

  it('connected after a QR was shown starts an automatic import with the channel period', async () => {
    setChannelQr(ctx, s.instance, 'data:image/png;base64,QR');
    await setChannelStatus(ctx, s.instance, 'connected', '5565988887777');
    expect(await imports()).toMatchObject([{ channelId: s.channelId, period: '12m', auto: true, state: 'running' }]);
  });

  it('a session Evolution resumes by itself (no QR) imports nothing', async () => {
    await setChannelStatus(ctx, s.instance, 'connected');
    expect(await imports()).toEqual([]);
  });

  it('while an import runs, a new pairing does not start a second one', async () => {
    await startHistoryImport(ctx, s.channelId, { period: '3m', auto: false });
    setChannelQr(ctx, s.instance, 'data:image/png;base64,QR');
    expect(await statusOf(setChannelStatus(ctx, s.instance, 'connected'))).toBe(200);
    expect(await imports()).toHaveLength(1);
  });
});

describe('channel DTO', () => {
  it('lists the period, the disconnection time and the newest import of each channel', async () => {
    ctx.wa.historyRecords.push(rec({ id: 'a', at: '2026-10-10T12:00:00Z' }));
    const imp = await startHistoryImport(ctx, s.channelId, { period: '12m', auto: false });
    await runImportPass(ctx, imp.id);

    expect(await listChannels(ctx.db)).toEqual([
      {
        id: s.channelId, name: 'WhatsApp teste', status: 'connected', phone: null, historyPeriod: '3m', disconnectedAt: null,
        historyImport: {
          id: imp.id, period: '12m', state: 'done', startedAt: T0.toISOString(), finishedAt: T0.toISOString(),
          messagesImported: 1, contactsCreated: 1, oldestMessageAt: '2026-10-10T12:00:00.000Z', error: null,
        },
      },
    ]);
  });

  it('disconnectedAt is set when the channel drops, kept while it stays down, cleared when it connects (§7)', async () => {
    await setChannelStatus(ctx, s.instance, 'disconnected');
    const first = (await listChannels(ctx.db))[0]!.disconnectedAt;
    expect(first).toEqual(expect.any(String));
    await setChannelStatus(ctx, s.instance, 'disconnected', '5565911112222'); // only the phone changes
    expect((await listChannels(ctx.db))[0]!.disconnectedAt).toBe(first);
    await setChannelStatus(ctx, s.instance, 'connected');
    expect((await listChannels(ctx.db))[0]!.disconnectedAt).toBeNull();
  });
});
```

Update the three existing literals that list a whole `ChannelDto`:
- `server/test/channels/routes.test.ts:30-35`: the `toContainEqual` object becomes `{ id: seed.channelId, name: expect.any(String), status: expect.stringMatching(/^(disconnected|connecting|connected)$/), phone: null, historyPeriod: '3m', disconnectedAt: null, historyImport: null }`.
- `server/test/channels/routes.test.ts:57` and `server/test/channels/service.test.ts:42`: `{ id: expect.any(String), name: 'Escritório', status: 'disconnected', phone: null, historyPeriod: '3m', disconnectedAt: null, historyImport: null }`.
- `server/test/realtime/hub.test.ts:185`: `channel: { id: row.id, name: row.name, status: 'connected', phone: '5565999990000', historyPeriod: '3m', disconnectedAt: null, historyImport: null }`.

(The `syncWebhooks` test at the end of `service.test.ts` stays untouched.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w server -- test/history/jobs.test.ts test/channels test/realtime/hub.test.ts`
Expected: FAIL. `jobs.test.ts` fails to collect (`Failed to load url ../../src/history/imports.js`); the channel and hub tests fail on `toEqual`/`toContainEqual` because the DTO has no `historyPeriod`, `disconnectedAt`, `historyImport`.

- [ ] **Step 3: The import rows**

Create `server/src/history/imports.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { desc, inArray } from 'drizzle-orm';
import type { HistoryImportDto, HistoryPeriod } from '@talk/shared';
import type { AppCtx } from '../ctx.js';
import type { Db, Tx } from '../db/client.js';
import { historyImports } from '../db/schema.js';
import { conflict } from '../lib/http-error.js';

export type HistoryImportRow = typeof historyImports.$inferSelect;

/** §5.1: the 409 when the channel already has an import running. */
export const IMPORT_RUNNING = 'Já existe uma importação em andamento';

export function toHistoryImportDto(r: HistoryImportRow): HistoryImportDto {
  return {
    id: r.id,
    period: r.period,
    state: r.state,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
    messagesImported: r.messagesImported,
    contactsCreated: r.contactsCreated,
    oldestMessageAt: r.oldestMessageAt ? r.oldestMessageAt.toISOString() : null,
    error: r.error,
  };
}

/** The newest import of each channel: the one Configurações › Canais shows. */
export async function latestImports(db: Db | Tx, channelIds: string[]): Promise<Map<string, HistoryImportRow>> {
  if (channelIds.length === 0) return new Map();
  const rows = await db
    .selectDistinctOn([historyImports.channelId])
    .from(historyImports)
    .where(inArray(historyImports.channelId, channelIds))
    .orderBy(historyImports.channelId, desc(historyImports.startedAt));
  return new Map(rows.map((r) => [r.channelId, r]));
}

/** A running import, due now (the worker runs it on its next beat). 409 IMPORT_RUNNING while one runs (partial unique index). */
export async function startHistoryImport(
  ctx: AppCtx,
  channelId: string,
  input: { period: HistoryPeriod; auto: boolean },
): Promise<HistoryImportRow> {
  const now = ctx.botRuntime.now();
  const [row] = await ctx.db
    .insert(historyImports)
    .values({ id: randomUUID(), channelId, period: input.period, auto: input.auto, state: 'running', startedAt: now, lastNewAt: now, nextRunAt: now })
    .onConflictDoNothing()
    .returning();
  if (!row) throw conflict(IMPORT_RUNNING);
  await ctx.hub.publishChannel(channelId);
  return row;
}
```

- [ ] **Step 4: The import pass**

Create `server/src/history/jobs.ts`:

```ts
import { and, eq, sql } from 'drizzle-orm';
import type { HistoryPeriod } from '@talk/shared';
import { errorTag } from '../bots/scheduler.js';
import type { AppCtx } from '../ctx.js';
import { channels, historyImports } from '../db/schema.js';
import { copyRange } from './copy.js';
import type { HistoryImportRow } from './imports.js';

const MIN = 60_000;
/** §5.1: the phone may take ~45 min to send its history, so an automatic import repeats the copy. */
const AUTO_REPEAT_MS = 2 * MIN;
const AUTO_QUIET_MS = 10 * MIN;
const AUTO_MAX_MS = 60 * MIN;
/** "Tudo" starts the year WhatsApp launched: monthly windows from there are ~210 cheap requests. */
const ALL_START = new Date('2009-01-01T00:00:00Z');

/** Start of the period an import copies (UTC calendar months back from `now`). */
export function periodStart(period: HistoryPeriod, now: Date): Date {
  if (period === 'all') return ALL_START;
  const months = period === '3m' ? 3 : 12;
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, now.getUTCDate(), now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds()),
  );
}

/**
 * One pass of a running import (§5.1–5.6): copies [periodStart, now], adds the counts after each page and publishes
 * channel.status, then decides done / next pass in 2 min / failed. Returns the updated row, or null when the import
 * is no longer running.
 */
export async function runImportPass(ctx: AppCtx, importId: string): Promise<HistoryImportRow | null> {
  const [imp] = await ctx.db
    .select()
    .from(historyImports)
    .where(and(eq(historyImports.id, importId), eq(historyImports.state, 'running')));
  if (!imp) return null;
  const [channel] = await ctx.db.select().from(channels).where(eq(channels.id, imp.channelId));
  if (!channel) return null;
  const now = ctx.botRuntime.now();

  let inserted = 0;
  let patch: Partial<typeof historyImports.$inferInsert>;
  try {
    await copyRange(ctx, channel, periodStart(imp.period, now), now, async (r) => {
      if (r.inserted === 0 && r.contactsCreated === 0) return;
      inserted += r.inserted;
      await ctx.db
        .update(historyImports)
        .set({
          messagesImported: sql`${historyImports.messagesImported} + ${r.inserted}`,
          contactsCreated: sql`${historyImports.contactsCreated} + ${r.contactsCreated}`,
          oldestMessageAt: r.oldest ? sql`least(${historyImports.oldestMessageAt}, ${r.oldest.toISOString()}::timestamptz)` : undefined,
        })
        .where(eq(historyImports.id, imp.id));
      await ctx.hub.publishChannel(channel.id); // "Importando histórico… N mensagens" (§5.6)
    });
    const lastNewAt = inserted > 0 ? now : (imp.lastNewAt ?? imp.startedAt);
    const finished =
      !imp.auto || now.getTime() - lastNewAt.getTime() >= AUTO_QUIET_MS || now.getTime() - imp.startedAt.getTime() >= AUTO_MAX_MS;
    patch = finished
      ? { state: 'done', finishedAt: now, lastNewAt, nextRunAt: null }
      : { lastNewAt, nextRunAt: new Date(now.getTime() + AUTO_REPEAT_MS) };
  } catch (err) {
    // §9: stop, keep what came in; only the error name/code is kept and logged
    console.error('history: import failed', imp.id, errorTag(err));
    patch = { state: 'failed', finishedAt: now, error: errorTag(err), nextRunAt: null };
  }
  const [row] = await ctx.db.update(historyImports).set(patch).where(eq(historyImports.id, imp.id)).returning();
  await ctx.hub.publishChannel(channel.id);
  return row ?? null;
}
```

- [ ] **Step 5: Channel DTO and the automatic start**

In `server/src/channels/service.ts`, replace the imports (lines 1-8) with:

```ts
import { randomUUID } from 'node:crypto';
import { and, asc, eq, ne, or, sql } from 'drizzle-orm';
import type { ChannelDto } from '@talk/shared';
import type { AppCtx } from '../ctx.js';
import type { Db, Tx } from '../db/client.js';
import { channels } from '../db/schema.js';
import { latestImports, startHistoryImport, toHistoryImportDto, type HistoryImportRow } from '../history/imports.js';
import { HttpError, notFound } from '../lib/http-error.js';
import type { ChannelStatus } from '../whatsapp/types.js';
```

Replace `toChannelDto` and `listChannels` (lines 32-39) with:

```ts
export function toChannelDto(row: ChannelRow, last: HistoryImportRow | null = null): ChannelDto {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    phone: row.phone,
    historyPeriod: row.historyPeriod,
    disconnectedAt: row.disconnectedAt ? row.disconnectedAt.toISOString() : null,
    historyImport: last ? toHistoryImportDto(last) : null,
  };
}

export async function listChannels(db: Db | Tx): Promise<ChannelDto[]> {
  const rows = await db.select().from(channels).orderBy(asc(channels.createdAt));
  const last = await latestImports(db, rows.map((r) => r.id));
  return rows.map((r) => toChannelDto(r, last.get(r.id) ?? null));
}

/** The DTO channel.status carries (hub.publishChannel), with the newest import. */
export async function loadChannelDto(db: Db | Tx, channelId: string): Promise<ChannelDto | null> {
  const [row] = await db.select().from(channels).where(eq(channels.id, channelId));
  if (!row) return null;
  return toChannelDto(row, (await latestImports(db, [row.id])).get(row.id) ?? null);
}
```

Replace `setChannelStatus` with its doc comment (lines 87-104, between `getChannelQrById` and `syncChannelStatuses`) with:

```ts
/**
 * Single implementation, also used by messages/ingest.ts for connection.update webhooks.
 * Updates channels.status (and channels.phone when a phone is given: connection.update `wuid`);
 * publishes channel.status only when something actually changed. A null phone keeps the stored number.
 * Unknown instance → no-op. Reaching 'connected' clears the stored QR.
 * History spec: keeps disconnected_at (§7 banner) and, on a new QR pairing, starts an automatic import (§5.1).
 */
export async function setChannelStatus(ctx: AppCtx, instance: string, status: ChannelStatus, phone: string | null = null): Promise<void> {
  // "A new QR pairing" = connected while a QR is on screen; a session Evolution resumes by itself shows none.
  const pairedByQr = status === 'connected' && getChannelQr(ctx, instance) !== null;
  const changed = phone
    ? or(ne(channels.status, status), sql`${channels.phone} is distinct from ${phone}`)
    : ne(channels.status, status);
  const [row] = await ctx.db
    .update(channels)
    .set({
      ...(phone ? { status, phone } : { status }),
      // the start of the outage: coalesce keeps it while the channel stays down
      disconnectedAt: status === 'disconnected' ? sql`coalesce(${channels.disconnectedAt}, now())` : null,
    })
    .where(and(eq(channels.evolutionInstance, instance), changed))
    .returning({ id: channels.id, historyPeriod: channels.historyPeriod });
  if (status === 'connected') setChannelQr(ctx, instance, null);
  if (!row) return;
  if (pairedByQr) {
    await startHistoryImport(ctx, row.id, { period: row.historyPeriod, auto: true }).catch((err: unknown) => {
      // one is already running: its next pass picks the new history up
      if (!(err instanceof HttpError && err.status === 409)) throw err;
    });
  }
  await ctx.hub.publishChannel(row.id);
}
```

In `server/src/realtime/hub.ts`, replace lines 1-7 (imports; `channels` leaves the schema import, `loadChannelDto` reads it now) with:

```ts
import { eq } from 'drizzle-orm';
import type { NotificationDto, WsEvent } from '@talk/shared';
import { loadChannelDto } from '../channels/service.js';
import type { Db } from '../db/client.js';
import { chats, messages } from '../db/schema.js';
import { toChatListItem } from '../inbox/queries.js';
import { canSee, loadAuthUser, type AuthUser } from '../inbox/visibility.js';
import { toMessageDto } from '../messages/dto.js';
```

and replace `publishChannel` (lines 87-96) with:

```ts
    async publishChannel(channelId) {
      if (byUser.size === 0) return;
      const channel = await loadChannelDto(getDb(), channelId); // with the import progress (history spec §5.6)
      if (!channel) return;
      const event: WsEvent = { type: 'channel.status', channel };
      for (const sockets of [...byUser.values()]) for (const socket of [...sockets]) send(socket, event);
    },
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -w server -- test/history/jobs.test.ts test/channels test/realtime/hub.test.ts test/messages/ingest.test.ts test/webhooks/routes.test.ts`
Expected: PASS.

Run: `npm run typecheck -w server`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add server/src/history/imports.ts server/src/history/jobs.ts server/src/channels/service.ts server/src/realtime/hub.ts server/test/history/jobs.test.ts server/test/channels/routes.test.ts server/test/channels/service.test.ts server/test/realtime/hub.test.ts
git commit -m "feat(server): importação do histórico (automática após o QR, repetida a cada 2 min) e progresso no canal" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Back-fill, worker and boot wiring

**Files:**
- Modify: `server/src/history/jobs.ts` (imports; append `BACKFILL_EVERY_MS`, `runBackfill`, `createHistoryWorker`)
- Modify: `server/src/index.ts:12` (import), `:56` (start), `:59-65` (stop in the signal handler); the boot calls `syncChannelStatuses` and `syncWebhooks` (lines 42-46) stay as they are
- Test: `server/test/history/backfill.test.ts`

**Interfaces:**
- Consumes: Task 4 `copyRange`; Task 6 `drainMediaQueue`; Task 7 `runImportPass`, `startHistoryImport`; Task 1 `channels.backfillUntil`, `historyImports.nextRunAt`.
- Produces (contract): `BACKFILL_EVERY_MS`, `runBackfill(ctx, channelId): Promise<number>` (messages copied), `createHistoryWorker(ctx, opts?)` with `tick()` (due import passes, then the back-fill of every channel when 5 min have passed since the last one; the first tick always back-fills), `start()` (a beat at once, then every `intervalMs` = 15 s; the media queue at once, then every `mediaIntervalMs` = 10 s; idempotent; timers `unref`), `stop()` (clears timers, aborts the media loop, waits for what is running).

Back-fill rules (spec §6): per channel, the window is `backfill_until − 10 min` … `now − 30 min` (the last 30 min stay with the webhook, which Evolution retries for ~20 min, so a message that can still arrive live keeps its queue and bots). The first run of a channel only sets `backfill_until = now − 30 min` (what came before is the history import's job). A failure leaves `backfill_until`, so the next run retries the same window. Everything copied follows §5.2–5.3 (history only), and the LID pairs of the window's live rows are merged in the same cycle (Task 5, through `placeRecords`).

- [ ] **Step 1: Write the failing tests**

Create `server/test/history/backfill.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { channels, chats, historyImports, messages } from '../../src/db/schema.js';
import { startHistoryImport } from '../../src/history/imports.js';
import { createHistoryWorker, runBackfill } from '../../src/history/jobs.js';
import { GatewayError } from '../../src/whatsapp/types.js';
import { makeTestCtx, seedBasics } from '../helpers.js';
import { insertChat, newContact } from '../inbox/fixtures.js';
import { PHONE, rec } from './records.js';

type Ctx = Awaited<ReturnType<typeof makeTestCtx>>;
const MIN = 60_000;

let ctx: Ctx;
let s: Awaited<ReturnType<typeof seedBasics>>;

beforeEach(async () => {
  ctx = await makeTestCtx(); // fake clock: 2026-10-14T13:00:00Z
  s = await seedBasics(ctx);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const until = async () => (await ctx.db.select().from(channels).where(eq(channels.id, s.channelId)))[0]!.backfillUntil;
const setUntil = (iso: string) => ctx.db.update(channels).set({ backfillUntil: new Date(iso) }).where(eq(channels.id, s.channelId));
const externalIds = async () => (await ctx.db.select().from(messages)).map((m) => m.externalId).sort();

describe('runBackfill (§6)', () => {
  it('the first run only sets the watermark 30 min back and copies nothing', async () => {
    ctx.wa.historyRecords.push(rec({ id: 'velha', at: '2026-10-14T10:00:00Z' }));
    expect(await runBackfill(ctx, s.channelId)).toBe(0);
    expect(await until()).toEqual(new Date('2026-10-14T12:30:00Z'));
    expect(ctx.wa.findCalls).toEqual([]);
  });

  it('copies what the app missed between backfill_until − 10 min and now − 30 min, then advances', async () => {
    await setUntil('2026-10-14T12:00:00Z');
    ctx.wa.historyRecords.push(
      rec({ id: 'antes', at: '2026-10-14T11:49:00Z' }), // before the 10-min overlap: an earlier run covered it
      rec({ id: 'folga', at: '2026-10-14T11:55:00Z' }), // inside the overlap
      rec({ id: 'perdida', at: '2026-10-14T12:20:00Z' }),
      rec({ id: 'recente', at: '2026-10-14T12:45:00Z' }), // last 30 min: still the webhook's
    );

    expect(await runBackfill(ctx, s.channelId)).toBe(2);

    expect(await externalIds()).toEqual(['folga', 'perdida']);
    expect(ctx.wa.findCalls).toEqual([
      { instance: s.instance, gte: '2026-10-14T11:50:00.000Z', lte: '2026-10-14T12:30:00.000Z', page: 1, offset: 500 },
    ]);
    expect(await until()).toEqual(new Date('2026-10-14T12:30:00Z'));
  });

  it('what it copies is history only, even into the open chat: no unread, no waiting, no bot or triage', async () => {
    await setUntil('2026-10-14T12:00:00Z');
    const contactId = await newContact(ctx, { phone: PHONE });
    const chatId = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, contactId });
    ctx.wa.historyRecords.push(rec({ id: 'perdida', at: '2026-10-14T12:20:00Z' }));

    expect(await runBackfill(ctx, s.channelId)).toBe(1);

    const [chat] = await ctx.db.select().from(chats).where(eq(chats.id, chatId));
    expect(chat).toMatchObject({ unread: 0, waiting: false, triagePending: false });
    expect((await ctx.db.select().from(messages))[0]!.chatId).toBe(chatId);
    expect(ctx.wa.sent).toEqual([]);
  });

  it('an Evolution failure keeps backfill_until, so the next run retries the same window', async () => {
    await setUntil('2026-10-14T12:00:00Z');
    ctx.wa.findMessages = async () => {
      throw new GatewayError('Evolution POST /chat/findMessages/talk-test failed: 502 ', 502);
    };
    await expect(runBackfill(ctx, s.channelId)).rejects.toMatchObject({ status: 502 });
    expect(await until()).toEqual(new Date('2026-10-14T12:00:00Z'));
  });
});

describe('createHistoryWorker', () => {
  it('a tick runs due imports and back-fills at the first tick, then only every 5 min', async () => {
    ctx.wa.historyRecords.push(rec({ id: 'a', at: '2026-10-10T12:00:00Z' }));
    const imp = await startHistoryImport(ctx, s.channelId, { period: '3m', auto: false });
    const worker = createHistoryWorker(ctx);

    await worker.tick();
    const [done] = await ctx.db.select().from(historyImports).where(eq(historyImports.id, imp.id));
    expect(done).toMatchObject({ state: 'done', messagesImported: 1 });
    expect(await until()).toEqual(new Date('2026-10-14T12:30:00Z'));

    ctx.clock.advance(1 * MIN);
    await worker.tick();
    expect(await until()).toEqual(new Date('2026-10-14T12:30:00Z'));

    ctx.clock.advance(4 * MIN); // 5 min after the first back-fill
    await worker.tick();
    expect(await until()).toEqual(new Date('2026-10-14T12:35:00Z'));
  });

  it('resumes an automatic import left running by a previous process (Review Focus 5)', async () => {
    const at = (iso: string) => new Date(iso);
    const [left] = await ctx.db
      .insert(historyImports)
      .values({
        channelId: s.channelId, period: '3m', auto: true, state: 'running', startedAt: at('2026-10-14T12:50:00Z'),
        lastNewAt: at('2026-10-14T12:58:00Z'), nextRunAt: at('2026-10-14T12:59:00Z'), messagesImported: 40,
      })
      .returning();
    ctx.wa.historyRecords.push(rec({ id: 'tardia', at: '2026-10-10T12:00:00Z' })); // the phone kept sending

    await createHistoryWorker(ctx).tick();

    const [row] = await ctx.db.select().from(historyImports).where(eq(historyImports.id, left!.id));
    expect(row).toMatchObject({ state: 'running', messagesImported: 41, lastNewAt: at('2026-10-14T13:00:00Z'), nextRunAt: at('2026-10-14T13:02:00Z') });
  });

  it('start runs a beat at once (back-fill at boot) and stop waits for it', async () => {
    const worker = createHistoryWorker(ctx);
    worker.start();
    worker.start(); // idempotent
    await worker.stop();
    expect(await until()).toEqual(new Date('2026-10-14T12:30:00Z'));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w server -- test/history/backfill.test.ts`
Expected: FAIL. `runBackfill` and `createHistoryWorker` are not exported by `jobs.ts`: `TypeError: runBackfill is not a function` / `createHistoryWorker is not a function`.

- [ ] **Step 3: Implement the back-fill and the worker**

In `server/src/history/jobs.ts`, replace the first import line with:

```ts
import { and, asc, eq, lte, sql } from 'drizzle-orm';
```

add after `import { copyRange } from './copy.js';`:

```ts
import { drainMediaQueue } from './media.js';
```

and append at the end of the file:

```ts
/** §6: back-fill cadence (also once at boot). */
export const BACKFILL_EVERY_MS = 5 * MIN;
/** The last 30 min still belong to the webhook (Evolution retries ~20 min): there a message keeps its queue and bots. */
const BACKFILL_LAG_MS = 30 * MIN;
const BACKFILL_OVERLAP_MS = 10 * MIN;

/**
 * §6: copies, as history, Evolution's messages in [backfill_until − 10 min, now − 30 min] the app does not have, and
 * advances backfill_until. The first run of a channel only sets the watermark. Throws on an Evolution failure
 * (backfill_until stays). Returns how many messages it copied.
 */
export async function runBackfill(ctx: AppCtx, channelId: string): Promise<number> {
  const [channel] = await ctx.db.select().from(channels).where(eq(channels.id, channelId));
  if (!channel) return 0;
  const lteAt = new Date(ctx.botRuntime.now().getTime() - BACKFILL_LAG_MS);
  if (!channel.backfillUntil) {
    await ctx.db.update(channels).set({ backfillUntil: lteAt }).where(eq(channels.id, channelId));
    return 0;
  }
  const totals = await copyRange(ctx, channel, new Date(channel.backfillUntil.getTime() - BACKFILL_OVERLAP_MS), lteAt);
  await ctx.db.update(channels).set({ backfillUntil: lteAt }).where(eq(channels.id, channelId));
  return totals.inserted;
}

/**
 * The history worker (§5–6), one per app process: import passes that are due and, every 5 min, the back-fill of every
 * channel; plus the media queue in its own loop, so a long download run never delays an import pass. All state lives
 * in the DB, so a restart resumes where the previous process stopped.
 * ponytail: one process only; claim rows with FOR UPDATE SKIP LOCKED if the app ever runs more than one.
 */
export function createHistoryWorker(ctx: AppCtx, opts: { intervalMs?: number; mediaIntervalMs?: number } = {}) {
  const { intervalMs = 15_000, mediaIntervalMs = 10_000 } = opts;
  let lastBackfill = Number.NEGATIVE_INFINITY;
  const timers: Array<ReturnType<typeof setInterval>> = [];
  let abort = new AbortController();
  let jobs: Promise<unknown> | null = null;
  let media: Promise<unknown> | null = null;

  async function tick(): Promise<void> {
    const now = ctx.botRuntime.now();
    const due = await ctx.db
      .select({ id: historyImports.id })
      .from(historyImports)
      .where(and(eq(historyImports.state, 'running'), lte(historyImports.nextRunAt, now)))
      .orderBy(asc(historyImports.nextRunAt));
    for (const { id } of due) {
      try {
        await runImportPass(ctx, id);
      } catch (err) {
        console.error('history: import pass failed', id, errorTag(err)); // a DB error; the next beat retries
      }
    }
    if (now.getTime() - lastBackfill < BACKFILL_EVERY_MS) return;
    lastBackfill = now.getTime();
    for (const { id } of await ctx.db.select({ id: channels.id }).from(channels)) {
      try {
        await runBackfill(ctx, id);
      } catch (err) {
        console.error('history: backfill failed', id, errorTag(err));
      }
    }
  }

  function runJobs(): void {
    if (jobs) return; // the previous beat is still running
    jobs = tick()
      .catch((err: unknown) => console.error('history: tick failed', errorTag(err)))
      .finally(() => {
        jobs = null;
      });
  }

  function runMedia(): void {
    if (media) return;
    media = drainMediaQueue(ctx, abort.signal)
      .catch((err: unknown) => console.error('history: media queue failed', errorTag(err)))
      .finally(() => {
        media = null;
      });
  }

  return {
    tick,
    start(): void {
      if (timers.length) return;
      abort = new AbortController();
      runJobs();
      runMedia();
      timers.push(setInterval(runJobs, intervalMs), setInterval(runMedia, mediaIntervalMs));
      for (const t of timers) t.unref();
    },
    /** Clears the timers, ends the media loop after its current download, and waits for both. */
    async stop(): Promise<void> {
      for (const t of timers) clearInterval(t);
      timers.length = 0;
      abort.abort();
      await Promise.all([jobs, media]);
    },
  };
}
```

- [ ] **Step 4: Wire it into the boot**

In `server/src/index.ts`, add after `import { createAvatarSweep } from './contacts/avatar.js';` (line 12):

```ts
import { createHistoryWorker } from './history/jobs.js';
```

After `avatarSweep.start();` (line 56) add:

```ts

// History spec §5–6: import passes (repeated every 2 min after a QR), the 5-min back-fill (also now, at boot) and the
// media queue (≤ 21 days, one at a time). State lives in the DB: a restart resumes.
const history = createHistoryWorker(ctx);
history.start();
```

and inside the signal handler, after `void avatarSweep.stop();` (line 62), add:

```ts
    void history.stop();
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w server -- test/history`
Expected: PASS (every file under `test/history`).

Run: `npm run typecheck -w server`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add server/src/history/jobs.ts server/src/index.ts server/test/history/backfill.test.ts
git commit -m "feat(server): recuperação a cada 5 min com folga de 30 min e worker do histórico no boot" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Channel routes: period on connect and "Importar histórico"

**Files:**
- Modify: `server/src/channels/service.ts:3` (import `HistoryPeriod`), `connectChannel` (lines 68-78 at the start of this plan; Task 7's edits move it down), new `importChannelHistory`
- Modify: `server/src/channels/routes.ts` (whole file shown)
- Test: `server/test/channels/routes.test.ts`

**Interfaces:**
- Consumes: Task 7 `startHistoryImport`, `loadChannelDto`, `IMPORT_RUNNING` (through the 409); Task 1 `channels.historyPeriod`.
- Produces (contract): `connectChannel(ctx, channelId, opts?: { historyPeriod?: HistoryPeriod })` stores the period before calling `wa.connect`; `importChannelHistory(ctx, channelId, period): Promise<ChannelDto>`; routes `POST /api/channels/:id/connect` body `{ historyPeriod?: '3m' | '12m' | 'all' }` (body optional) and `POST /api/channels/:id/history-import` body `{ period }` (admin; 200 `ChannelDto` with the running import; 400 bad period; 404 unknown channel; 409 `{ error: 'Já existe uma importação em andamento' }`).

- [ ] **Step 1: Write the failing route tests**

In `server/test/channels/routes.test.ts`, add inside the file (after the existing `describe`):

```ts
describe('history routes (§5.1)', () => {
  const importUrl = () => `/api/channels/${seed.channelId}/history-import`;
  const channelRow = async () => (await ctx.db.select().from(channels).where(eq(channels.id, seed.channelId)))[0]!;

  it('POST /api/channels/:id/history-import is admin only', async () => {
    const agent = await loginAs(app, seed.agentA.email);
    const res = await app.inject({ method: 'POST', url: importUrl(), headers: agent.headers, payload: { period: '3m' } });
    expect(res.statusCode).toBe(403);
  });

  it('starts an import with the period, keeps the period on the channel and answers the channel', async () => {
    const admin = await loginAs(app, seed.admin.email);
    const res = await app.inject({ method: 'POST', url: importUrl(), headers: admin.headers, payload: { period: '12m' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: seed.channelId, historyPeriod: '12m', historyImport: { period: '12m', state: 'running', messagesImported: 0 },
    });
    expect((await channelRow()).historyPeriod).toBe('12m');
  });

  it('a second request while one runs is 409 "Já existe uma importação em andamento"', async () => {
    const admin = await loginAs(app, seed.admin.email);
    await app.inject({ method: 'POST', url: importUrl(), headers: admin.headers, payload: { period: '3m' } });
    const res = await app.inject({ method: 'POST', url: importUrl(), headers: admin.headers, payload: { period: '3m' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('Já existe uma importação em andamento');
  });

  it('rejects an unknown period (400) and an unknown channel (404)', async () => {
    const admin = await loginAs(app, seed.admin.email);
    expect((await app.inject({ method: 'POST', url: importUrl(), headers: admin.headers, payload: { period: '6m' } })).statusCode).toBe(400);
    const res = await app.inject({
      method: 'POST', url: `/api/channels/${crypto.randomUUID()}/history-import`, headers: admin.headers, payload: { period: '3m' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('connect keeps the chosen period on the channel before asking Evolution for the QR', async () => {
    const connect = vi.spyOn(ctx.wa, 'connect');
    const admin = await loginAs(app, seed.admin.email);
    const res = await app.inject({
      method: 'POST', url: `/api/channels/${seed.channelId}/connect`, headers: admin.headers, payload: { historyPeriod: 'all' },
    });
    expect(res.statusCode).toBe(200);
    expect(connect).toHaveBeenCalledWith(seed.instance);
    expect((await channelRow()).historyPeriod).toBe('all');
  });

  it('connect without a body keeps working, and a bad period is 400', async () => {
    const admin = await loginAs(app, seed.admin.email);
    const url = `/api/channels/${seed.channelId}/connect`;
    expect((await app.inject({ method: 'POST', url, headers: admin.headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url, headers: admin.headers, payload: { historyPeriod: 'x' } })).statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w server -- test/channels/routes.test.ts`
Expected: FAIL. The import route answers 404 (route not registered) where 403/200/409/400 are expected; `historyPeriod` stays `'3m'` after connect; the bad connect period answers 200.

- [ ] **Step 3: The service functions**

In `server/src/channels/service.ts`, change line 3 to:

```ts
import type { ChannelDto, HistoryPeriod } from '@talk/shared';
```

replace `connectChannel` with:

```ts
export async function connectChannel(
  ctx: AppCtx,
  channelId: string,
  opts: { historyPeriod?: HistoryPeriod } = {},
): Promise<{ qrBase64: string | null }> {
  const [row] = await ctx.db.select().from(channels).where(eq(channels.id, channelId)).limit(1);
  if (!row) throw notFound();
  // §5.1: what the automatic import after this QR pairing copies; stored before the QR can be read
  if (opts.historyPeriod && opts.historyPeriod !== row.historyPeriod) {
    await ctx.db.update(channels).set({ historyPeriod: opts.historyPeriod }).where(eq(channels.id, channelId));
  }
  const { qrBase64 } = await ctx.wa.connect(row.evolutionInstance);
  // The first QR comes back here; later ones arrive as qrcode.updated webhooks (ingest → setChannelQr).
  if (qrBase64) setChannelQr(ctx, row.evolutionInstance, qrBase64);
  // no QR means Evolution already holds an open session: ask instead of assuming "connecting"
  const status = qrBase64 ? 'connecting' : await ctx.wa.connectionState(row.evolutionInstance);
  await setChannelStatus(ctx, row.evolutionInstance, status);
  return { qrBase64 };
}

/** "Importar histórico" (§5.1): copies what Evolution already stored, no QR. 409 while an import runs. */
export async function importChannelHistory(ctx: AppCtx, channelId: string, period: HistoryPeriod): Promise<ChannelDto> {
  const [row] = await ctx.db.select({ id: channels.id }).from(channels).where(eq(channels.id, channelId));
  if (!row) throw notFound();
  await ctx.db.update(channels).set({ historyPeriod: period }).where(eq(channels.id, channelId));
  await startHistoryImport(ctx, channelId, { period, auto: false });
  return (await loadChannelDto(ctx.db, channelId))!;
}
```

- [ ] **Step 4: The routes**

Replace `server/src/channels/routes.ts` with:

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppCtx } from '../ctx.js';
import { requireAdmin, requireUser } from '../auth/plugin.js';
import { connectChannel, createChannel, getChannelQrById, importChannelHistory, listChannels } from './service.js';

const createBody = z.object({ name: z.string().trim().min(1).max(60) });
const idParams = z.object({ id: z.uuid() });
const period = z.enum(['3m', '12m', 'all']);
const connectBody = z.object({ historyPeriod: period.optional() });
const importBody = z.object({ period });

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
    return connectChannel(ctx, id, connectBody.parse(request.body ?? {}));
  });

  // §5.6: the QR shown to the admin comes from qrcode.updated (stored in memory by ingest); polled by the UI.
  app.get('/api/channels/:id/qr', async (request) => {
    await requireAdmin(request);
    const { id } = idParams.parse(request.params);
    return getChannelQrById(ctx, id);
  });

  // History spec §5.1: copy what Evolution already stored for the channel, in the chosen period.
  app.post('/api/channels/:id/history-import', async (request) => {
    await requireAdmin(request);
    const { id } = idParams.parse(request.params);
    return importChannelHistory(ctx, id, importBody.parse(request.body).period);
  });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w server -- test/channels`
Expected: PASS.

Run: `npm run typecheck -w server`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add server/src/channels/service.ts server/src/channels/routes.ts server/test/channels/routes.test.ts
git commit -m "feat(server): período do histórico no conectar e rota Importar histórico (409 se já roda)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Visibility and read-only history chats

**Files:**
- Modify: `server/src/inbox/visibility.ts:17-45`
- Modify: `server/src/inbox/queries.ts:74` (`toChatListItem`), `:97` (`listChats`)
- Modify: `server/src/inbox/chats.ts:17` (constant), `setChatPrivacy` (`:175-177`), `reopenChat` (`:223-225`)
- Modify: `server/src/messages/send.ts` (`addNote`, `:406-407`, and its import of `inbox/chats.js`, line 11)
- Test: `server/test/inbox/visibility.test.ts`, `server/test/chats/list-and-timeline.test.ts`, `server/test/inbox/chats-actions.test.ts`, `server/test/realtime/hub.test.ts:82-96`

**Interfaces:**
- Consumes: Task 1 `chats.history`, `ChatListItem.history`; Task 5 `insertChat({ history })`.
- Produces: `ChatVisibilityFields.history?: boolean`; `canSee` true for any history chat; `visibleChatsWhere` ORs `history = true`; `ChatListItem.history` always set; `HISTORY_READ_ONLY = 'Conversa de histórico do WhatsApp: só leitura.'` exported from `inbox/chats.ts` (409 on reopen, privacy and notes); `GET /api/chats?tab=closed` leaves history chats out unless `q` is set.

Spec §8: history chats are visible to every logged-in user (they predate the system and are context); the sector barrier still holds for every chat the system creates. They are read-only: no reopen, transfer, privacy (transfer, assume and close already need an open chat), and no notes. They stay out of **Finalizados** but show in the contact's history (`listContactChats` uses `visibleChatsWhere`) and in search.

- [ ] **Step 1: Write the failing tests**

In `server/test/inbox/visibility.test.ts`, add two rows to the `cases` table:

```ts
  ['agent sees an imported history chat of another sector (§8)', agent, { sectorId: 'B', ownerId: null, private: false, history: true }, true],
  ['agent without sectors sees history chats', { ...agent, sectorIds: [] }, { sectorId: 'B', ownerId: null, private: false, history: true }, true],
```

and inside `describe('visibleChatsWhere / loadAuthUser (PGlite)', …)`:

```ts
  it('history chats are visible to every logged-in user, in SQL as in canSee (§8)', async () => {
    const hist = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorB, state: 'closed', history: true });
    await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorB, state: 'closed' }); // a regular closed chat of sector B
    const all = await ctx.db.select().from(chats);
    for (const user of [s.agentA, { ...s.agentA, sectorIds: [] }, s.admin]) {
      const viaSql = (await ctx.db.select({ id: chats.id }).from(chats).where(visibleChatsWhere(user))).map((r) => r.id);
      expect(viaSql).toEqual([hist]);
      expect(all.filter((c) => canSee(user, c)).map((c) => c.id)).toEqual([hist]);
    }
  });
```

In `server/test/chats/list-and-timeline.test.ts`, change the imports to:

```ts
import { eq } from 'drizzle-orm';
import { chatPins, chats, contactTags, tags, userSectors } from '../../src/db/schema.js';
```

and add inside `describe('GET /api/chats', …)`:

```ts
  it('Finalizados leaves history chats out, but a search finds them (§8)', async () => {
    const closed = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, state: 'closed', name: 'Ana Paula' });
    const hist = await seedChat(ctx, { channelId: s.channelId, sectorId: s.defaultSector, state: 'closed', name: 'Ana Histórico' });
    await ctx.db.update(chats).set({ history: true }).where(eq(chats.id, hist.chatId));
    const { headers } = await loginAs(app, s.agentA.email);

    expect(ids(await list(headers, '?tab=closed'))).toEqual([closed.chatId]);
    expect(ids(await list(headers, '?tab=closed&q=Hist'))).toEqual([hist.chatId]);
    const found = await list(headers, '?tab=closed&q=Ana');
    expect(found.items.find((i) => i.id === hist.chatId)?.history).toBe(true);
    expect(found.items.find((i) => i.id === closed.chatId)?.history).toBe(false);
  });

  it('an agent of another sector opens a history chat and reads its timeline (§8)', async () => {
    const hist = await seedChat(ctx, { channelId: s.channelId, sectorId: s.defaultSector, state: 'closed' });
    await ctx.db.update(chats).set({ history: true }).where(eq(chats.id, hist.chatId));
    await seedMessage(ctx, hist.chatId, s.channelId, t(1), { body: 'histórico' });
    const { headers } = await loginAs(app, s.agentB.email);

    const detail = await app.inject({ method: 'GET', url: `/api/chats/${hist.chatId}`, headers });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ history: true, state: 'closed' });
    const timeline = await app.inject({ method: 'GET', url: `/api/chats/${hist.chatId}/timeline`, headers });
    expect(timeline.statusCode).toBe(200);
    expect((timeline.json() as TimelineItem[]).map((i) => (i.type === 'message' ? i.body : i.kind))).toEqual(['histórico']);
  });
```

In `server/test/inbox/chats-actions.test.ts`, add the import:

```ts
import { addNote } from '../../src/messages/send.js';
```

and at the end of the file:

```ts
describe('history chats are read-only (§8)', () => {
  it('cannot be reopened, transferred, made private or get a note', async () => {
    const id = await insertChat(ctx, { channelId: s.channelId, sectorId: s.defaultSector, state: 'closed', history: true });
    await enableSeeAll(ctx, s.admin);
    expect(await statusOf(reopenChat(ctx, s.admin, id))).toBe(409);
    expect(await statusOf(setChatPrivacy(ctx, s.admin, id, true))).toBe(409);
    expect(await statusOf(transferChat(ctx, s.agentA, id, { sectorId: s.sectorA }))).toBe(409);
    expect(await statusOf(addNote(ctx, s.agentA, id, 'nota'))).toBe(409);
    const [chat] = await ctx.db.select().from(chats).where(eq(chats.id, id));
    expect(chat).toMatchObject({ state: 'closed', private: false, history: true });
  });
});
```

In `server/test/realtime/hub.test.ts`, the `expected` chat literal (lines 82-96) gains `history: false,` after `tagIds: [tagId],`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w server -- test/inbox/visibility.test.ts test/chats/list-and-timeline.test.ts test/inbox/chats-actions.test.ts test/realtime/hub.test.ts`
Expected: FAIL. The two new `canSee` rows return `false`; the SQL test gets `[]`; the Finalizados test also lists the history chat and `history` is `undefined` on the items; agentB gets 404 on the history chat; reopen answers 200 instead of 409; `hub.test.ts` fails on `toEqual` (`history` missing).

- [ ] **Step 3: Visibility**

In `server/src/inbox/visibility.ts`, replace lines 17-45 (from `export interface ChatVisibilityFields` through `visibleChatsWhere`) with:

```ts
export interface ChatVisibilityFields {
  sectorId: string;
  ownerId: string | null;
  private: boolean;
  history?: boolean; // imported from the phone (history spec §8)
}

const seesAll = (user: AuthUser) => user.role === 'admin' && user.seeAllSectors;

/**
 * Sector barrier: an admin with "ver todos" sees everything; anyone else (admins included) sees own chats
 * plus the non-private chats of their sectors. Imported history chats predate the system: every user sees them.
 */
export function canSee(user: AuthUser, chat: ChatVisibilityFields): boolean {
  if (seesAll(user)) return true;
  if (chat.history) return true;
  if (chat.ownerId === user.id) return true;
  return !chat.private && user.sectorIds.includes(chat.sectorId);
}

/**
 * Same rule as canSee, as a WHERE over `chats`. undefined only for an admin with "ver todos" (no filter).
 * history OR owner=me OR (private=false AND sector IN mine).
 */
export function visibleChatsWhere(user: AuthUser): SQL | undefined {
  if (seesAll(user)) return undefined;
  const history = eq(chats.history, true);
  const mine = eq(chats.ownerId, user.id);
  if (user.sectorIds.length === 0) return or(history, mine);
  return or(history, mine, and(eq(chats.private, false), inArray(chats.sectorId, user.sectorIds)));
}
```

- [ ] **Step 4: Lists and the read-only rules**

In `server/src/inbox/queries.ts`, in `toChatListItem` add after `tagIds: tagRows.map((r) => r.id),`:

```ts
    history: chat.history,
```

and in `listChats`, after `conds.push(eq(chats.state, f.tab === 'closed' ? 'closed' : 'open'));`, add:

```ts
  // History spec §8: history chats stay out of Finalizados; a search still finds them.
  if (f.tab === 'closed' && !f.q?.trim()) conds.push(eq(chats.history, false));
```

In `server/src/inbox/chats.ts`, add after the `STALE` constant (line 17):

```ts
/** History spec §8: imported history chats are read-only. */
export const HISTORY_READ_ONLY = 'Conversa de histórico do WhatsApp: só leitura.';
```

in `setChatPrivacy`, right after `const chat = await getChatForUser(ctx, user, chatId);`, add:

```ts
  if (chat.history) throw conflict(HISTORY_READ_ONLY);
```

and in `reopenChat`, right after `const chat = await getChatForUser(ctx, user, chatId);`, add the same line:

```ts
  if (chat.history) throw conflict(HISTORY_READ_ONLY);
```

In `server/src/messages/send.ts`, change the import from `'../inbox/chats.js'` (line 11) to `import { HISTORY_READ_ONLY, getChatForUser, type ChatRow } from '../inbox/chats.js';`, and in `addNote` (line 406), right after `const chat = await getChatForUser(ctx, user, chatId);`, add:

```ts
  if (chat.history) throw conflict(HISTORY_READ_ONLY);
```

(`conflict` is already imported in `send.ts`; it is used by `sendAgentMessage`.) Message actions need nothing here: `messages/actions.ts` already answers 409 "Conversa finalizada" for any chat that is not open (react, delete, edit, forward from it), and a history chat is always closed; the bubble menu is hidden there too (`chatOpen` is false).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w server -- test/inbox test/chats test/realtime test/contacts`
Expected: PASS.

Run: `npm test -w server`
Expected: PASS. If another test compares a full `ChatListItem` with `toEqual`, add `history: false` to its literal; do not change `toChatListItem`.

Run: `npm run typecheck -w server`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add server/src/inbox/visibility.ts server/src/inbox/queries.ts server/src/inbox/chats.ts server/src/messages/send.ts server/test/inbox/visibility.test.ts server/test/chats/list-and-timeline.test.ts server/test/inbox/chats-actions.test.ts server/test/realtime/hub.test.ts
git commit -m "feat(server): conversas de histórico visíveis a todos, só leitura e fora de Finalizados" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Web Canais: period, "Importar histórico", progress and QR polling

**Files:**
- Modify: `web/src/lib/api.ts:2-33` (import `HistoryPeriod`), `:242-246` (`api.channels`)
- Modify: `web/src/pages/settings/ChannelsSettings.tsx` (whole file shown)
- Test: `web/src/pages/settings/ChannelsSettings.test.tsx` (create)

**Interfaces:**
- Consumes: Task 1 `ChannelDto.historyPeriod/historyImport`, `HistoryImportDto`, `HistoryPeriod`; Task 9 routes; existing `send`, `useSend`, `Section`, `ErrorText`, `Loading`, `btn`, `btnPrimary` (`components/settings/common.tsx`), `qk.channels`, WS `channel.status` reducer (`lib/ws.ts`).
- Produces: `api.channels.connect(id, historyPeriod?)`, `api.channels.importHistory(id, period)`; exported `importText(imp: HistoryImportDto): string`.

UI rules: one "Período do histórico" select per channel (3 meses / 12 meses / Tudo, starting at the channel's stored period) used by both "Gerar novo QR / Reconectar" and "Importar histórico"; a note that the phone sends about 3.5 months; the import line under the channel ("Importando histórico… N mensagens" / "Histórico importado: N mensagens, desde DD/MM/AAAA" / failure), live through `channel.status`; "Importar histórico" disabled while one runs; the 409 shown as an error. QR (spec §7): poll `GET /api/channels/:id/qr` at once and every 5 s while the channel is `connecting` (even when `connect` answered without a QR) and show "Gerando QR code…" until a QR arrives.

- [ ] **Step 1: Write the failing web tests**

Create `web/src/pages/settings/ChannelsSettings.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ChannelDto, HistoryImportDto } from '@talk/shared';
import { ChannelsSettings, importText } from './ChannelsSettings';

const channel = (over: Partial<ChannelDto> = {}): ChannelDto => ({
  id: 'ch1', name: 'WhatsApp escritório', status: 'connected', phone: '5565999990000', historyPeriod: '3m',
  disconnectedAt: null, historyImport: null, ...over,
});
const imp = (over: Partial<HistoryImportDto> = {}): HistoryImportDto => ({
  id: 'i1', period: '3m', state: 'running', startedAt: '2026-10-16T12:00:00.000Z', finishedAt: null,
  messagesImported: 0, contactsCreated: 0, oldestMessageAt: null, error: null, ...over,
});

interface Reply { status?: number; body?: unknown }
let routes: Record<string, Reply>;
const calls: Array<{ method: string; path: string; body: unknown }> = [];
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls.length = 0;
  routes = {};
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    const method = init?.method ?? 'GET';
    calls.push({ method, path, body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body });
    const reply = routes[`${method} ${path}`];
    if (!reply) return json({ error: 'inesperado' }, 500);
    return json(reply.body ?? null, reply.status ?? 200);
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ChannelsSettings />
    </QueryClientProvider>,
  );
}

const called = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);

describe('importText', () => {
  it('shows the running count, the result with the oldest date, and a failure', () => {
    expect(importText(imp({ messagesImported: 46163 }))).toBe('Importando histórico… 46.163 mensagens');
    expect(importText(imp({ state: 'done', messagesImported: 1234, oldestMessageAt: '2026-07-20T15:00:00.000Z' }))).toBe(
      'Histórico importado: 1.234 mensagens, desde 20/07/2026',
    );
    expect(importText(imp({ state: 'done', messagesImported: 0 }))).toBe('Histórico importado: 0 mensagens');
    expect(importText(imp({ state: 'failed' }))).toBe('A importação do histórico falhou. Clique em “Importar histórico” para tentar de novo.');
  });
});

describe('Settings › Canais', () => {
  it('while connecting, polls the QR although connect gave none, showing "Gerando QR code…" until it comes (§7)', async () => {
    routes['GET /api/channels'] = { body: [channel({ status: 'connecting' })] };
    routes['GET /api/channels/ch1/qr'] = { body: { qrBase64: null } };
    renderPage();
    expect(await screen.findByText('Gerando QR code…')).toBeTruthy();
    await waitFor(() => expect(called('GET', '/api/channels/ch1/qr').length).toBeGreaterThan(0));
    expect(called('POST', '/api/channels/ch1/connect')).toHaveLength(0);
  });

  it('shows the QR as soon as the poll brings it', async () => {
    routes['GET /api/channels'] = { body: [channel({ status: 'connecting' })] };
    routes['GET /api/channels/ch1/qr'] = { body: { qrBase64: 'data:image/png;base64,QRTESTE' } };
    renderPage();
    const img = await screen.findByAltText('QR Code do canal WhatsApp escritório');
    expect(img.getAttribute('src')).toBe('data:image/png;base64,QRTESTE');
    expect(screen.queryByText('Gerando QR code…')).toBeNull();
  });

  it('Reconectar sends the chosen period', async () => {
    routes['GET /api/channels'] = { body: [channel({ status: 'disconnected' })] };
    routes['POST /api/channels/ch1/connect'] = { body: { qrBase64: null } };
    renderPage();
    fireEvent.change(await screen.findByLabelText('Período do histórico'), { target: { value: '12m' } });
    fireEvent.click(screen.getByRole('button', { name: 'Gerar novo QR / Reconectar' }));
    await waitFor(() => expect(called('POST', '/api/channels/ch1/connect')).toHaveLength(1));
    expect(called('POST', '/api/channels/ch1/connect')[0]!.body).toEqual({ historyPeriod: '12m' });
  });

  it('Importar histórico posts the period and shows the import running', async () => {
    routes['GET /api/channels'] = { body: [channel()] };
    routes['POST /api/channels/ch1/history-import'] = { body: channel({ historyPeriod: 'all', historyImport: imp({ period: 'all' }) }) };
    renderPage();
    fireEvent.change(await screen.findByLabelText('Período do histórico'), { target: { value: 'all' } });
    fireEvent.click(screen.getByRole('button', { name: 'Importar histórico' }));
    expect(await screen.findByText('Importando histórico… 0 mensagens')).toBeTruthy();
    expect(called('POST', '/api/channels/ch1/history-import')[0]!.body).toEqual({ period: 'all' });
    expect((screen.getByRole('button', { name: 'Importar histórico' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the result of the last import with the oldest date', async () => {
    routes['GET /api/channels'] = {
      body: [channel({ historyImport: imp({ state: 'done', messagesImported: 1234, oldestMessageAt: '2026-07-20T15:00:00.000Z' }) })],
    };
    renderPage();
    expect(await screen.findByText('Histórico importado: 1.234 mensagens, desde 20/07/2026')).toBeTruthy();
  });

  it('shows the 409 when an import is already running', async () => {
    routes['GET /api/channels'] = { body: [channel()] };
    routes['POST /api/channels/ch1/history-import'] = { status: 409, body: { error: 'Já existe uma importação em andamento' } };
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Importar histórico' }));
    expect(await screen.findByText('Já existe uma importação em andamento')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w web -- src/pages/settings/ChannelsSettings.test.tsx`
Expected: FAIL. `importText` is not exported (`TypeError: importText is not a function`); `Unable to find an element with the text: Gerando QR code…`; no `Período do histórico` label; no "Importar histórico" button.

- [ ] **Step 3: The API calls**

In `web/src/lib/api.ts`, add `HistoryPeriod,` to the `@talk/shared` type import (between `GraphProblem,` and `ManualBotDto,`), and replace the `channels` block (lines 242-246) with:

```ts
  channels: {
    list: () => request<ChannelDto[]>('GET', '/api/channels'),
    create: (name: string) => request<ChannelDto>('POST', '/api/channels', { name }),
    /** `historyPeriod`: what the automatic import after this QR copies (history spec §5.1). */
    connect: (id: string, historyPeriod?: HistoryPeriod) =>
      request<{ qrBase64: string | null }>('POST', `/api/channels/${enc(id)}/connect`, historyPeriod ? { historyPeriod } : undefined),
    importHistory: (id: string, period: HistoryPeriod) => request<ChannelDto>('POST', `/api/channels/${enc(id)}/history-import`, { period }),
  },
```

- [ ] **Step 4: The Canais screen**

Replace `web/src/pages/settings/ChannelsSettings.tsx` with:

```tsx
import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ChannelDto, HistoryImportDto, HistoryPeriod } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { formatPhone } from '../../lib/format';
import { ErrorText, Loading, Section, btn, btnPrimary, send, useSend } from '../../components/settings/common';

const QR_POLL_MS = 5_000;

const STATUS: Record<ChannelDto['status'], { label: string; className: string }> = {
  connected: { label: 'Conectado', className: 'bg-success/20 text-success' },
  connecting: { label: 'Conectando', className: 'bg-primary/20 text-link' },
  disconnected: { label: 'Desconectado', className: 'bg-danger/20 text-danger' },
};

/** History spec §3: the three periods (the phone sends about 3.5 months whatever is picked). */
const PERIODS: Array<[HistoryPeriod, string]> = [
  ['3m', '3 meses'],
  ['12m', '12 meses'],
  ['all', 'Tudo'],
];

const asImageSrc = (qr: string) => (qr.startsWith('data:') ? qr : `data:image/png;base64,${qr}`);

function withQr(current: Record<string, string>, channelId: string, qr: string | null) {
  const next = { ...current };
  if (qr) next[channelId] = qr;
  else delete next[channelId];
  return next;
}

const count = (n: number) => n.toLocaleString('pt-BR');
const day = (iso: string) => new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });

/** History spec §5.6: the import line under the channel; channel.status keeps it live. */
export function importText(imp: HistoryImportDto): string {
  if (imp.state === 'running') return `Importando histórico… ${count(imp.messagesImported)} mensagens`;
  if (imp.state === 'failed') return 'A importação do histórico falhou. Clique em “Importar histórico” para tentar de novo.';
  return `Histórico importado: ${count(imp.messagesImported)} mensagens${imp.oldestMessageAt ? `, desde ${day(imp.oldestMessageAt)}` : ''}`;
}

export function ChannelsSettings() {
  const qc = useQueryClient();
  // applyWsEvent writes every channel.status into qk.channels, so this list (pill and import line) is live
  const channels = useQuery({ queryKey: qk.channels, queryFn: api.channels.list });
  const create = useSend(qk.channels);
  const [name, setName] = useState('');
  const [qr, setQr] = useState<Record<string, string>>({});
  const [periods, setPeriods] = useState<Record<string, HistoryPeriod>>({});
  const periodOf = (c: ChannelDto): HistoryPeriod => periods[c.id] ?? c.historyPeriod ?? '3m';

  const connect = useMutation({
    mutationFn: (v: { id: string; period: HistoryPeriod }) => api.channels.connect(v.id, v.period),
    // the first QR may come back here; null QR = no QR yet or Evolution already has a session. Refetch the list too,
    // so a "connecting" status starts the QR polling below even if the channel.status event is late.
    onSuccess: ({ qrBase64 }, v) => {
      setQr((cur) => withQr(cur, v.id, qrBase64));
      void qc.invalidateQueries({ queryKey: qk.channels });
    },
  });
  const importHistory = useMutation({
    mutationFn: (v: { id: string; period: HistoryPeriod }) => api.channels.importHistory(v.id, v.period),
    onSuccess: (ch) => qc.setQueryData<ChannelDto[]>(qk.channels, (list) => list?.map((c) => (c.id === ch.id ? ch : c))),
  });

  // History spec §7: poll while a channel is connecting, even when connect answered without a QR (it can come later),
  // and while a shown QR is not connected yet (later QRs arrive as qrcode.updated). A stable string, so the
  // interval is not reset on every render.
  const polling = (channels.data ?? [])
    .filter((c) => c.status === 'connecting' || (qr[c.id] !== undefined && c.status !== 'connected'))
    .map((c) => c.id)
    .join(',');

  // ponytail: 5 s polling; push qrcode.updated over WS if this ever feels slow.
  useEffect(() => {
    if (!polling) return;
    const poll = () => {
      for (const id of polling.split(',')) {
        send<{ qrBase64: string | null }>(`/api/channels/${id}/qr`, 'GET')
          .then(({ qrBase64 }) => {
            if (qrBase64) setQr((cur) => withQr(cur, id, qrBase64));
          })
          .catch(() => {}); // a failed poll keeps the last QR on screen; the next tick retries
      }
    };
    poll();
    const t = setInterval(poll, QR_POLL_MS);
    return () => clearInterval(t);
  }, [polling]);

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
          className="flex-1 rounded border border-border px-2 py-1.5 text-sm"
        />
        <button type="submit" disabled={!name.trim() || create.isPending} className={btnPrimary}>
          Novo canal
        </button>
      </form>
      <ErrorText error={create.error} />
      <ErrorText error={connect.error} />
      <ErrorText error={importHistory.error} />

      {channels.data.length === 0 && <p className="text-sm text-muted">Nenhum canal cadastrado.</p>}
      <ul className="space-y-3">
        {channels.data.map((c) => {
          const code = qr[c.id];
          const running = c.historyImport?.state === 'running';
          return (
            <li key={c.id} className="rounded border border-border p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="font-medium">{c.name}</p>
                  <p className="text-sm text-muted">{c.phone ? formatPhone(c.phone) : 'Nenhum número conectado'}</p>
                </div>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS[c.status].className}`}>
                  {STATUS[c.status].label}
                </span>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="text-sm text-muted">Período do histórico</span>
                <select
                  aria-label="Período do histórico"
                  value={periodOf(c)}
                  onChange={(e) => setPeriods((cur) => ({ ...cur, [c.id]: e.target.value as HistoryPeriod }))}
                  className="rounded border border-field px-2 py-1 text-sm"
                >
                  {PERIODS.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                {c.status !== 'connected' && (
                  <button
                    type="button"
                    disabled={connect.isPending}
                    onClick={() => connect.mutate({ id: c.id, period: periodOf(c) })}
                    className={btn}
                  >
                    Gerar novo QR / Reconectar
                  </button>
                )}
                <button
                  type="button"
                  disabled={importHistory.isPending || running}
                  onClick={() => importHistory.mutate({ id: c.id, period: periodOf(c) })}
                  className={btn}
                >
                  Importar histórico
                </button>
              </div>
              <p className="mt-1 text-xs text-muted">
                O WhatsApp envia cerca de 3,5 meses de histórico; com “12 meses” ou “Tudo” vem só o que o celular mandar.
              </p>
              {c.historyImport && (
                <p role="status" className="mt-2 text-sm">
                  {importText(c.historyImport)}
                </p>
              )}

              {c.status === 'connecting' && !code && <p className="mt-4 text-sm text-muted">Gerando QR code…</p>}
              {code && c.status !== 'connected' && (
                <div className="mt-4 flex flex-wrap gap-4">
                  <img src={asImageSrc(code)} alt={`QR Code do canal ${c.name}`} className="h-64 w-64 rounded border border-border bg-panel p-2" />
                  <ol className="max-w-xs list-decimal space-y-1 pl-5 text-sm">
                    <li>Abra o WhatsApp no celular do escritório.</li>
                    <li>Toque em Mais opções › Aparelhos conectados › Conectar um aparelho.</li>
                    <li>Aponte a câmera para este código.</li>
                    <li>O código se renova sozinho (esta tela busca o mais recente a cada 5 segundos). Mantenha-a aberta até aparecer “Conectado”.</li>
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

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w web -- src/pages/settings/ChannelsSettings.test.tsx`
Expected: PASS (7 tests).

Run: `npm run typecheck -w web`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/api.ts web/src/pages/settings/ChannelsSettings.tsx web/src/pages/settings/ChannelsSettings.test.tsx
git commit -m "feat(web): período e Importar histórico em Canais, progresso ao vivo e QR que chega depois" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Web inbox: down banner, channel name on cards, history chats read-only

**Files:**
- Create: `web/src/components/layout/ChannelBanner.tsx` (moved out of `AppLayout.tsx` and rewritten)
- Modify: `web/src/components/layout/AppLayout.tsx:1-18` (imports), `:107-123` (old `ChannelBanner` removed)
- Modify: `web/src/components/inbox/ChatListItem.tsx:6-13` (prop), `:47-48` (badge)
- Modify: `web/src/pages/Inbox.tsx:58-62` (channels query), `:203-212` (prop)
- Modify: `web/src/lib/format.ts:36-41` (`contactLabel`)
- Modify: `web/src/components/conversation/ConversationHeader.tsx` (title, status label, "Reabrir")
- Modify: `web/src/components/conversation/ConversationView.tsx:43` (`ClosedFooter` text)
- Test: `web/src/components/layout/ChannelBanner.test.tsx` (create), `web/src/pages/Inbox.test.tsx`, `web/src/lib/format-inbox.test.ts:14`, `web/src/components/conversation/ConversationHeader.test.tsx`

**Interfaces:**
- Consumes: Task 1 `ChannelDto.disconnectedAt`, `ChatListItem.history`; Task 7 server DTO; existing `useCurrentUser` (`lib/auth`), `qk.channels`, `api.channels.list`.
- Produces: `ChannelBanner()` and `downChannels(list: ChannelDto[], now: number): ChannelDto[]` (status `disconnected` for more than 60 s, or with no `disconnectedAt`); `ChatListItem` prop `channelName?: string | null`; `contactLabel` falls back to "Contato sem número".

Spec §7: the banner is for admins only and appears in the inbox once a channel has been `disconnected` for more than 1 min: "Canal X desconectado: leia o QR code em Configurações › Canais", the last words linking to `/configuracoes/canais`; it goes away when the channel connects (the WS `channel.status` updates `qk.channels`). It replaces the old red "WhatsApp desconectado" banner, which showed to everyone for any non-connected status. The channel name shows on chat cards only when there is more than one channel. A LID-only contact without a name reads "Contato sem número" (§5.4). History chats show "Histórico do WhatsApp" instead of "Finalizada" and have no "Reabrir" (§8).

- [ ] **Step 1: Write the failing web tests**

Create `web/src/components/layout/ChannelBanner.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type { ChannelDto, Me } from '@talk/shared';
import { qk } from '../../lib/api';
import { ChannelBanner, downChannels } from './ChannelBanner';

const admin: Me = { id: 'u-admin', name: 'Admin', email: 'admin@teste.local', role: 'admin', signature: null, sectorIds: [], seeAllSectors: false, avatarUrl: null };
const agent: Me = { ...admin, id: 'u-agent', role: 'agent' };
const ch = (over: Partial<ChannelDto>): ChannelDto => ({ id: 'ch1', name: 'Escritório', status: 'disconnected', phone: null, ...over });
const NOW = Date.parse('2026-10-16T12:00:00.000Z');

let channels: ChannelDto[] = [];
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(channels), { status: 200, headers: { 'content-type': 'application/json' } })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderBanner(me: Me, list: ChannelDto[]) {
  channels = list;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(qk.me, me);
  qc.setQueryData(qk.channels, list);
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ChannelBanner />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('downChannels', () => {
  it('lists channels disconnected for more than 1 min, or since an unknown time (§7)', () => {
    const list = [
      ch({ id: 'a', disconnectedAt: '2026-10-16T11:58:59.000Z' }), // 61 s
      ch({ id: 'b', disconnectedAt: '2026-10-16T11:59:30.000Z' }), // 30 s
      ch({ id: 'c', disconnectedAt: null }),
      ch({ id: 'd', status: 'connecting' }),
      ch({ id: 'e', status: 'connected' }),
    ];
    expect(downChannels(list, NOW).map((c) => c.id)).toEqual(['a', 'c']);
  });
});

describe('ChannelBanner', () => {
  it('tells an admin which channel is down and links to Configurações › Canais', () => {
    renderBanner(admin, [ch({ disconnectedAt: null })]);
    expect(screen.getByRole('alert').textContent).toBe('Canal Escritório desconectado: leia o QR code em Configurações › Canais');
    expect(screen.getByRole('link', { name: 'Configurações › Canais' }).getAttribute('href')).toBe('/configuracoes/canais');
  });

  it('shows nothing to an agent, nor while every channel is up', () => {
    renderBanner(agent, [ch({ disconnectedAt: null })]);
    expect(screen.queryByRole('alert')).toBeNull();
    cleanup();
    renderBanner(admin, [ch({ status: 'connected' })]);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
```

In `web/src/pages/Inbox.test.tsx`:
- add `ChannelDto` to the `@talk/shared` type import;
- add `let channelsReply: ChannelDto[] = [];` above `beforeEach`, set `channelsReply = [];` as the first line of `beforeEach`, and add to the fetch stub, before the `/api/chats` line: `if (url.pathname === '/api/channels') return json(channelsReply);`;
- add the tests:

```tsx
it('shows the channel name on the cards when there is more than one channel (§7)', async () => {
  channelsReply = [
    { id: 'ch1', name: 'Escritório', status: 'connected', phone: null },
    { id: 'ch2', name: 'Financeiro WhatsApp', status: 'connected', phone: null },
  ];
  renderInbox(adminMe);
  expect(await screen.findAllByText('Escritório')).toHaveLength(2); // chats a and b are both on ch1
});

it('shows no channel name with a single channel', async () => {
  channelsReply = [{ id: 'ch1', name: 'Escritório', status: 'connected', phone: null }];
  renderInbox(adminMe);
  await screen.findByText('Ana Souza');
  await waitFor(() => expect(calls.some((c) => c.url.pathname === '/api/channels')).toBe(true));
  expect(screen.queryByText('Escritório')).toBeNull();
});
```

In `web/src/lib/format-inbox.test.ts`, line 14 becomes:

```ts
    expect(contactLabel({ name: null, phone: null })).toBe('Contato sem número'); // LID-only contact (history spec §5.4)
```

In `web/src/components/conversation/ConversationHeader.test.tsx`, add:

```tsx
describe('ConversationHeader for an imported history chat (§8)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('is read-only: no Reabrir, labelled as WhatsApp history; a LID-only contact reads "Contato sem número"', () => {
    stubFetch();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(qk.me, ME);
    render(
      <QueryClientProvider client={qc}>
        <ConversationHeader
          chat={{ ...CHAT, state: 'closed', history: true, contact: { id: 'k2', name: null, phone: null, avatarUrl: null } }}
          contactPanelOpen={false}
          onToggleContactPanel={() => {}}
          onOpenChat={() => {}}
        />
      </QueryClientProvider>,
    );
    expect(screen.queryByRole('button', { name: 'Reabrir' })).toBeNull();
    expect(screen.getByText('Histórico do WhatsApp')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Contato sem número' })).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w web -- src/components/layout/ChannelBanner.test.tsx src/pages/Inbox.test.tsx src/lib/format-inbox.test.ts src/components/conversation/ConversationHeader.test.tsx`
Expected: FAIL. `ChannelBanner.test.tsx` fails to load (`Failed to resolve import "./ChannelBanner"`); the Inbox test finds no "Escritório"; `contactLabel` returns `'Sem nome'`; the header still shows "Reabrir" and "Finalizada".

- [ ] **Step 3: The banner**

Create `web/src/components/layout/ChannelBanner.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { WarningCircleIcon } from '@phosphor-icons/react';
import type { ChannelDto } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { useCurrentUser } from '../../lib/auth';

const GRACE_MS = 60_000;

/** History spec §7: down for more than 1 min (no disconnectedAt = an outage older than this field). */
export function downChannels(list: ChannelDto[], now: number): ChannelDto[] {
  return list.filter((c) => c.status === 'disconnected' && (!c.disconnectedAt || now - Date.parse(c.disconnectedAt) > GRACE_MS));
}

/** Admins only: a disconnected channel, with the way back. Disappears when channel.status says connected. */
export function ChannelBanner() {
  const me = useCurrentUser();
  const isAdmin = me.role === 'admin';
  const { data } = useQuery({ queryKey: qk.channels, queryFn: api.channels.list, enabled: isAdmin });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000); // re-check the 1-min grace without new events
    return () => clearInterval(t);
  }, []);

  const down = isAdmin ? downChannels(data ?? [], now) : [];
  if (down.length === 0) return null;
  return (
    <div role="alert" className="flex flex-col gap-0.5 bg-danger-strong px-4 py-2 text-sm font-medium text-white">
      {down.map((c) => (
        <p key={c.id} className="flex items-center gap-2">
          <WarningCircleIcon size={18} weight="fill" aria-hidden />
          <span>
            Canal {c.name} desconectado: leia o QR code em{' '}
            <Link to="/configuracoes/canais" className="underline underline-offset-2">
              Configurações › Canais
            </Link>
          </span>
        </p>
      ))}
    </div>
  );
}
```

In `web/src/components/layout/AppLayout.tsx`: delete the old `function ChannelBanner() { … }` (lines 107-123); remove `useQuery` from the `@tanstack/react-query` import (keep `useQueryClient`), `WarningCircleIcon` from the Phosphor import, `Link` from the `react-router` import (keep `NavLink`, `Outlet`) and the `api, qk` import, and add:

```tsx
import { ChannelBanner } from './ChannelBanner';
```

(`<ChannelBanner />` stays where it is, above `<main>`.)

- [ ] **Step 4: Channel name on cards, "Contato sem número", read-only header**

In `web/src/components/inbox/ChatListItem.tsx`, add to `Props` (after `sectorName: string | null;`):

```ts
  /** History spec §7: set only when there is more than one channel. */
  channelName?: string | null;
```

change the signature to `export function ChatListItem({ chat, sectorName, channelName = null, owner, active, onOpen, onTogglePin }: Props) {`, and add right before the sector badge (line 48):

```tsx
            {channelName && <span className="rounded bg-panel px-1.5 text-xs text-muted">{channelName}</span>}
```

In `web/src/pages/Inbox.tsx`, after `const tags = useQuery(…);` add:

```ts
  const channels = useQuery({ queryKey: qk.channels, queryFn: api.channels.list });
  const channelList = channels.data ?? [];
  // History spec §7: the channel shows on the card only when there is more than one
  const channelName = new Map<string, string>(channelList.length > 1 ? channelList.map((c): [string, string] => [c.id, c.name]) : []);
```

and pass the prop in the `ChatListItem` element:

```tsx
              channelName={channelName.get(c.channelId) ?? null}
```

In `web/src/lib/format.ts`, replace `contactLabel` (lines 36-41) with:

```ts
/** Contact display name: name, else the phone through formatPhone; a LID-only contact without a name is "Contato sem número". */
export function contactLabel(c: { name: string | null; phone: string | null }): string {
  const name = c.name?.trim();
  if (name) return name;
  return formatPhone(c.phone) || 'Contato sem número';
}
```

In `web/src/components/conversation/ConversationHeader.tsx`:
- replace `import { formatPhone } from '../../lib/format';` (line 7) with `import { contactLabel } from '../../lib/format';` (line 119 was its only use);
- the title (line 119) becomes `<h2 className="truncate font-semibold text-fg">{contactLabel(chat.contact)}</h2>`;
- `{!open && <span>Finalizada</span>}` becomes `{!open && <span>{chat.history ? 'Histórico do WhatsApp' : 'Finalizada'}</span>}`;
- the "Reabrir" button condition `{!open && (` becomes `{!open && !chat.history && (` (history chats are read-only, §8).

In `web/src/components/conversation/ConversationView.tsx`, in `ClosedFooter`, replace `Conversa finalizada —{' '}` with:

```tsx
      {chat.history ? 'Histórico importado do WhatsApp (só leitura)' : 'Conversa finalizada'} —{' '}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w web`
Expected: PASS, including the four files of Step 2.

Run: `npm run typecheck -w web`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/layout/ChannelBanner.tsx web/src/components/layout/ChannelBanner.test.tsx web/src/components/layout/AppLayout.tsx web/src/components/inbox/ChatListItem.tsx web/src/pages/Inbox.tsx web/src/pages/Inbox.test.tsx web/src/lib/format.ts web/src/lib/format-inbox.test.ts web/src/components/conversation/ConversationHeader.tsx web/src/components/conversation/ConversationHeader.test.tsx web/src/components/conversation/ConversationView.tsx
git commit -m "feat(web): aviso de canal desconectado para admins, nome do canal nos cartões e conversa de histórico só leitura" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Docs: README, IMPLANTACAO (LGPD) and manual acceptance

**Files:**
- Modify: `README.md` (new section after "## Chatbot (entrega 2a)")
- Modify: `docs/IMPLANTACAO.md:72-82` (section 4), new section 4.1
- Create: `docs/superpowers/plans/2026-10-16-historico-whatsapp-aceite.md`

**Interfaces:**
- Consumes: everything above (names of screens, buttons and texts).
- Produces: documentation only.

- [ ] **Step 1: README**

In `README.md`, insert before `## Arquitetura`:

```md
## Histórico do WhatsApp

- **Importação ao ler o QR:** o celular manda o histórico recente (cerca de 3,5 meses) e o sistema copia da Evolution, no período escolhido em Configurações › Canais (**3 meses**, **12 meses** ou **Tudo**). A cópia se repete a cada 2 minutos enquanto chegam mensagens novas e termina após 10 minutos sem novidade (no máximo 1 hora). A tela mostra "Importando histórico… N mensagens" e, no fim, "Histórico importado: N mensagens, desde DD/MM/AAAA".
- **Importar histórico** (admin) copia de novo o que a Evolution já guardou, sem QR. Uma importação por canal de cada vez.
- **Só histórico:** nada importado conta como não lido, vai para a fila ou dispara chatbot ou triagem. Vai para a conversa aberta do contato, se houver; senão, para uma **conversa de histórico** (finalizada, só leitura, visível para todos os atendentes, fora da aba Finalizados; aparece na ficha do contato e na busca).
- **Contatos sem número:** quem o WhatsApp só identifica por um código interno aparece como "Contato sem número" e é juntado sozinho ao contato com telefone quando o número aparece.
- **Mídia:** fotos, áudios, vídeos e documentos das últimas 3 semanas são baixados em segundo plano; os mais antigos mostram "Arquivo não está mais disponível no WhatsApp". O botão **Baixar** tenta de novo quando a mídia ainda não veio.
- **Recuperação:** a cada 5 minutos (e ao ligar o servidor) o sistema copia da Evolution, como histórico, as mensagens que chegaram enquanto ele estava fora do ar.
- **Canal:** aviso para os admins quando um canal fica desconectado por mais de 1 minuto; o QR aparece mesmo quando demora ("Gerando QR code…"); com mais de um canal, o nome do canal aparece no cartão da conversa.
- Grupos ficam de fora. Guardar o histórico na Evolution tem efeito na LGPD: veja `docs/IMPLANTACAO.md` › Histórico do WhatsApp e LGPD.
```

- [ ] **Step 2: IMPLANTACAO**

In `docs/IMPLANTACAO.md`, replace section 4 (lines 72-82, from `## 4. Conectar o WhatsApp` up to the paragraph that ends with "O botão **Gerar novo QR / Reconectar** serve para isso.") with:

````md
## 4. Conectar o WhatsApp

1. Entre como administrador e vá em **Configurações → Canais**.
2. Crie o canal. Em **Período do histórico** escolha **3 meses**, **12 meses** ou **Tudo** e clique em **Gerar novo QR / Reconectar**. Enquanto o código é preparado a tela mostra "Gerando QR code…".
3. No celular do escritório: WhatsApp → **Aparelhos conectados** → **Conectar um aparelho** → leia o QR.
4. O status muda para **Conectado** e aparece "Importando histórico… N mensagens". O celular manda o histórico recente (cerca de 3,5 meses, mesmo com "12 meses" ou "Tudo") e o sistema copia em segundo plano por até 1 hora. No fim: "Histórico importado: N mensagens, desde DD/MM/AAAA".

Atenção: conectar o mesmo número aqui desconecta o número do Umbler Talk. Faça isso só no dia da virada (seção 10).

Se o canal cair (logout pelo celular, QR expirado), depois de 1 minuto os administradores veem na caixa de entrada a faixa "Canal X desconectado: leia o QR code em Configurações › Canais". Repita os passos 2 e 3. **Importar histórico** copia de novo o que a Evolution já guardou, sem ler o QR.

### 4.1 Histórico do WhatsApp e LGPD

A Evolution guarda o histórico que o celular manda a cada leitura de QR (`DATABASE_SAVE_DATA_HISTORIC`, `DATABASE_SAVE_DATA_CHATS` e `DATABASE_SAVE_DATA_CONTACTS` = `"true"` no `docker-compose.yml`). Isso muda a decisão do núcleo (§6), que não guardava esse texto:

- o banco `evolution` passa a ter o **texto** das conversas do celular, cerca de 1 kB por mensagem (~45 MB por leitura de QR com o volume do escritório), **inclusive de grupos**: o sistema não importa grupos, mas a Evolution os guarda;
- a mídia não fica na Evolution: o sistema baixa só a das últimas 3 semanas para `data/media`;
- esse banco já está no backup diário (`pg_dumpall`, seção 7) e segue as mesmas regras de acesso e retenção do núcleo. O dump fica maior.

Não há tela para apagar o histórico da Evolution. Depois que a importação terminou ("Histórico importado…" em Configurações › Canais), você pode apagar da Evolution as mensagens com mais de N dias. O que já foi importado continua no sistema. Use N de pelo menos **30**: o botão **Baixar** e a recuperação de mensagens perdidas usam as linhas recentes. **Importar histórico** só traz de novo o que ainda estiver na Evolution.

```bash
docker compose exec postgres psql -U postgres -d evolution
```

```sql
-- 1) Conte antes (troque 90 pelo número de dias que vai manter):
SELECT i.name AS instancia, count(*) AS mensagens
FROM evolution_api."Message" m
JOIN evolution_api."Instance" i ON i.id = m."instanceId"
WHERE m."messageTimestamp" < extract(epoch FROM now() - interval '90 days')
GROUP BY i.name;

-- 2) Apague só a instância do canal (o nome "talk-xxxxxxxx" do passo 1).
--    As linhas de "MessageUpdate" dessas mensagens saem junto (cascata).
BEGIN;
DELETE FROM evolution_api."Message" m
USING evolution_api."Instance" i
WHERE i.id = m."instanceId"
  AND i.name = 'talk-xxxxxxxx'
  AND m."messageTimestamp" < extract(epoch FROM now() - interval '90 days');
COMMIT;
```

Rode o passo 1 de novo: a instância não deve aparecer. Anote a data e o N usado no registro de tratamento de dados do escritório.
````

- [ ] **Step 3: Manual acceptance checklist**

Create `docs/superpowers/plans/2026-10-16-historico-whatsapp-aceite.md`:

```md
# Aceite manual: histórico do WhatsApp e sincronização

Roteiro do §11 da [especificação](../specs/2026-10-16-historico-whatsapp-design.md).

> ⚠️ Use só o **número de teste**. Ler o QR com o número do escritório o desconecta do Umbler Talk na hora.

## 0. Antes de começar

- [ ] Testes automáticos passando: `npm test`.
- [ ] Ambiente local rodando (README, "Rodar localmente") com o `docker-compose.dev.yml` desta entrega: `docker compose -f docker-compose.dev.yml --env-file .env.dev up -d --force-recreate evolution` e confira `docker compose -f docker-compose.dev.yml --env-file .env.dev exec evolution printenv DATABASE_SAVE_DATA_HISTORIC` → `true`.
- [ ] O celular de teste tem conversas com fotos e áudios recentes (menos de 3 semanas) e antigos, e pelo menos um contato que ainda não está no sistema.
- [ ] Anote a versão testada: `git log -1 --format=%h` → `________`

## A. Importação automática ao ler o QR

- [ ] Configurações › Canais: no canal de teste, **Período do histórico** = **3 meses**, **Gerar novo QR / Reconectar**. Aparece "Gerando QR code…" e, em seguida, o QR.
- [ ] Leia o QR. O status vira **Conectado** e aparece "Importando histórico… N mensagens", com N subindo.
- [ ] Em até ~15 minutos (10 minutos sem novidade) aparece "Histórico importado: N mensagens, desde DD/MM/AAAA", com a data por volta de 3 meses atrás.
- [ ] Clique de novo em **Importar histórico** enquanto uma importação roda: aparece "Já existe uma importação em andamento".

## B. Onde o histórico aparece

- [ ] Um contato **com telefone** e sem conversa aberta: na busca por nome/telefone (aba Finalizados com texto na busca) aparece a conversa; ela diz "Histórico importado do WhatsApp (só leitura)", sem **Reabrir**; a ficha do contato › "Todas as conversas deste contato" a lista.
- [ ] A aba **Finalizados** sem busca **não** mostra conversas de histórico.
- [ ] Um contato com conversa **aberta**: as mensagens antigas aparecem na conversa aberta, na ordem certa, e o contador de não lidas não mudou.
- [ ] Contatos **sem número** aparecem como "Contato sem número" (ou com o nome da agenda do celular).
- [ ] Entre com um atendente de outro setor: ele também vê a conversa de histórico.
- [ ] Nada entrou como **não lido**, nenhuma conversa foi para **Esperando**, nenhum chatbot nem triagem rodou (veja a linha do tempo: só "Histórico do WhatsApp importado: N mensagens").

## C. Mídia

- [ ] Fotos e áudios de menos de 3 semanas abrem (podem levar alguns minutos para baixar todos).
- [ ] Mídias mais antigas mostram "Arquivo não está mais disponível no WhatsApp", sem botão.
- [ ] Uma mídia com "mídia indisponível" tem o botão **Baixar**; clicar baixa (ou mostra o aviso de expirada).

## D. Recuperação com o app fora do ar

- [ ] Pare só o app (`Ctrl+C` no `npm run dev`), deixe a Evolution rodando.
- [ ] Do outro celular, mande 3 mensagens para o número de teste ao longo de **40 minutos**.
- [ ] Religue o app. As mensagens que chegaram há mais de 30 minutos aparecem em até 5 minutos, como histórico (sem não lidas, sem chatbot). As mais recentes chegam pelo webhook normalmente.

## E. Canal desconectado

- [ ] No celular de teste, remova o aparelho em **Aparelhos conectados**.
- [ ] Como admin, depois de 1 minuto, a caixa de entrada mostra "Canal <nome> desconectado: leia o QR code em Configurações › Canais". O link abre Configurações › Canais.
- [ ] Como atendente, a faixa não aparece.
- [ ] Leia o QR de novo: a faixa some e uma nova importação automática começa.

## F. Mais de um canal

- [ ] Crie um segundo canal (não precisa conectar). Os cartões da caixa de entrada passam a mostrar o nome do canal.

## Resultado

- Data: ________ · Quem testou: ________ · Versão: ________
- [ ] Aprovado  [ ] Reprovado — o que falhou: ____________________
```

- [ ] **Step 4: Check the docs**

Run: `grep -n "Histórico do WhatsApp\|Importar histórico\|Contato sem número" README.md docs/IMPLANTACAO.md docs/superpowers/plans/2026-10-16-historico-whatsapp-aceite.md`
Expected: matches in all three files.

Run: `npm test`
Expected: PASS (docs only; nothing else changed).

- [ ] **Step 5: Commit**

```bash
git add README.md docs/IMPLANTACAO.md docs/superpowers/plans/2026-10-16-historico-whatsapp-aceite.md
git commit -m "docs: histórico do WhatsApp no README, LGPD e limpeza manual na implantação, roteiro de aceite" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Decisions this plan takes where the spec is silent or loose

- **"Nova leitura de QR" (§5.1)** is detected as: the status becomes `connected` while a QR is stored for the instance (from `connect` or `qrcode.updated`). Evolution also emits `connecting → open` on transient reconnects of a saved session; those show no QR and do not start an import.
- **LID↔phone pairs (§5.4, §6)** come from the rows the copies already read (live rows keep `remoteJidAlt`), so every import pass and every back-fill merges what it sees; there is no extra Evolution call. Name for LID-only contacts: the push name if not digits-only, else the name from Evolution's Contact table (`findContacts`), else none.
- **Paging (§5.2)** follows the spec (monthly windows, offset 500, all pages); the rare page-edge swap the spike reproduced at offset 100 is caught by later passes.
- **Events:** one `history_imported { count }` per history chat per copy (not per batch); `contact_merged` on each chat that received the LID-only contact's history. Event texts: "Histórico do WhatsApp importado: N mensagens", "Contato sem número juntado a este contato".
- **Down banner (§7)** replaces the old global red banner (shown to everyone for any non-connected state) and stays above every page, so it also shows in the inbox; admins only, as the spec says.
- **Search (§8)** = the inbox search: with text in the Finalizados search, history chats are listed.
- Copy the spec does not give, written here: the period note, the failure line in Canais, the 502 on "Baixar", the read-only footer and header label, `HISTORY_READ_ONLY`.
- **Message actions vs. history (added when develop brought "ações de mensagem"; the spec predates it and is silent):** a copy never applies the `revoke`/`edit`/`reaction` events the parser now yields (spec §2 keeps "edição/remoção aplicadas a mensagens antigas" out, §5.2 "nunca atualiza"). A message that Evolution stores already edited or deleted is copied as Evolution holds it (current text, no "editada"/"apagada" mark, no `message_edits` row), and a revoke or edit that happened while the app was down is not recovered by the back-fill. Live webhooks still apply edits and deletes to history-copied rows, since they match by `external_id`. History chats are closed, so the message-action routes already refuse them (409 "Conversa finalizada"). Downloaded history media fills `media_sha256` like live media, so history stickers join the recent-stickers list of whoever can see the chat (every user, for history chats).
