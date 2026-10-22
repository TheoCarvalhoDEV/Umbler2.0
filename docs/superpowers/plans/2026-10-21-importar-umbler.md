# Importar do Umbler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring everything the office has in Umbler Talk into the system before the subscription is cancelled, from an admin screen in Ajustes. That covers sectors, tags, custom fields, quick answers and attendants, plus contacts with their tags, fields and notes. It also covers **every conversation**, open and finished, with its messages, internal notes and files. Umbler is only ever read. Open chats arrive open, in the same sector with the same owner, and finished ones arrive in Finalizados with their original dates. The rows WhatsApp history already copied are matched instead of duplicated. The import runs in the background, resumes by itself after a restart and ends with a report.

**Architecture:** `shared/src/umbler.ts` holds the import's states, phases, pt-BR error texts and DTOs. One migration (`0009`) adds `umbler_imports`, one row per run that holds the analysis, the admin's mapping, the progress and the report, and `umbler_map`, which maps an Umbler id to ours so nothing is imported twice. `server/src/importer/umbler.ts` keeps its name and grows:
- the HTTP client, which can only `GET`. It keeps the rate and the waits of §9.4, never follows a redirect and sends no token to file links;
- the Umbler types and `ImportRun`;
- phase 1 (the catalog, which reuses and extends the CLI importer's functions; `cli.ts` goes);
- phase 2 (contacts, with LID-only contacts and `mergeLidPairs`);
- phase 4 (the contacts' notes).

`importer/chats.ts` turns an Umbler message into a row (`toIncoming`) and copies a chat page by page. Each page is decided reading only, its files are downloaded outside any transaction, 4 at a time, and the page is then written in one transaction. The same file holds phases 3 (open chats, then the unread check) and 5 (finished chats, newest first). `importer/match.ts` is the §8 match with the WhatsApp history. The Umbler import uses it to move our row instead of inserting, and `history/place.ts` uses it the other way, to give an Umbler row its WhatsApp id. `importer/job.ts` runs "Analisar" (lists only, proposals, warnings, the read test) and the five phases. Every counter is saved with the page that changed it, so a stop or a restart resumes the phase and skips what `umbler_map` has. The job is the history worker's third loop, beside its media queue, with the same `AbortController`. `importer/routes.ts` has the four admin routes, and they re-check the §6.3 blocks on every read and before start and resume. The web gets the "Importar do Umbler" page in Ajustes › Equipe e cadastros, which polls every 3 s while the job works. The docs cover IMPLANTACAO §5 and the acceptance script.

**Tech Stack:** Node 24, TypeScript 5.9.3 strict ESM, Fastify 5.12.7, drizzle-orm 0.45.4 / drizzle-kit 0.31.11, Postgres (PGlite 0.5.10 in tests), zod 4.6.7, vitest 5.0.4, React 19.3.1, @tanstack/react-query 5.104.2, react-router 8.4.0, Tailwind 4.3.3, @phosphor-icons/react 2.1.10. **No new dependency:** the fake Umbler API uses `node:http`.

**Spec:** `docs/superpowers/specs/2026-10-21-importar-umbler-design.md`, binding, with the user's answers in §18. Its §18 settles the open questions:
- the test environment may hold real client data and is erased afterwards;
- the office starts answering here right after connecting;
- chats from old Umbler numbers go to the official channel;
- an ex-attendant becomes an inactive user.

**Base code.** This plan runs on `feat/importar-umbler`, which is `origin/main` at `87cbb06` plus the two spec commits. That base has migration `0008_agendamentos_e_regras` and 26 tables. Every "replace X with Y" snippet below quotes that code, or this plan's own earlier task, verbatim. The following must survive:
- the 2026-10-20 deliveries: `chat_tags`, `waiting_since` and the auto rules (`getAutoRules`);
- the scheduled messages: `absorb` moving `scheduled_messages` in `history/merge.ts`;
- the history import: `placeRecords`, the tombstones, `mergeLidPairs` and the media queue;
- the "Mensageiro" visual: `ui.ts` and `components/settings/common.tsx`.

## Global Constraints

- **Only `GET` to Umbler.** `UmblerClient.get(route, query, params)` has no method parameter, and `file(url)` is a plain `fetch(url)`. The Task 2 test scans every file in `server/src/importer/` and fails on any of these:
  - a `method:`;
  - a quoted `POST`/`PUT`/`PATCH`/`DELETE`;
  - `/read/`, `/unread/`, `/pin/`, `/redownload-media/`, `/transcribe/` or `/favorite/`;
  - the chat-detail route `'/v1/chats/{id}/'` or `/v1/messages/`.

  The importer never calls `PUT /v1/chats/{id}/read/`, `GET /v1/chats/{id}/` or `/v1/messages/{id}/`.
- **The token.** It comes only from the env, as `UMBLER_TOKEN` (`Config.umblerToken: string | null`, where empty means absent). It is never written to a log, the DB, a DTO, the report or the web. Only `/api/umbler-import` says `tokenConfigured: boolean`. File links get no `Authorization` header, API calls use `redirect: 'error'`, and `prettifyError` never shows a value.
- **Tests never call Umbler.** They use the fake Umbler API (`server/test/fakes/umbler-api.ts`), a `node:http` server on `127.0.0.1` with a random port and `/s3/<name>` in the role of the file links. Every importer test ends with `expect(fake.problems()).toEqual([])`, which means only `GET` requests, no read/unread/pin route, no chat or message detail route, and no `Authorization` on a file link.
- **Logs** carry Umbler ids, our ids, counts, the phase, the §9.4 code, the route template (`GET /v1/chats/{chatId}/relative-messages/ → 500`) and `errorTag(err)` only. A log never carries text, a phone, a name, an e-mail, a file URL or the token. `UmblerError.message` is `GET <template> → <status>`.
- **Routes.** Every new mutation is a non-GET `/api/*` route, so the global Origin check (`authPlugin`) covers it. All four routes are admin-only, and an agent gets 403. Tests send `loginAs(...).headers`, and one test sends a POST without Origin and expects 403.
- **The migration is generated, never hand-edited.** `npm run db:generate -w server -- --name importar_umbler` creates `0009_importar_umbler`, right after `0008_agendamentos_e_regras`. Never run SQL by hand. Never start or stop the dev server, its database or Evolution.
- **Extend, never rename.** On existing types, only `ChatEventKind` gains a member: `'umbler_imported'`, with data `{ count, merged? }`. The new DTOs live in `shared/src/umbler.ts`. `Config` gains `umblerToken`, so the one `Config` literal in `server/test/helpers.ts` gains `umblerToken: null`.
- **PGlite.** Inside `ctx.db.transaction(tx => …)` use only `tx`. Publish to the hub after commit. Never call Umbler or a file link inside a transaction (§11).
- **Pace (§9.4).**
  - API calls: at least `MIN_GAP_MS` (100 ms) apart, one at a time, `CALL_TIMEOUT_MS` (30 s).
  - 429: wait `Retry-After` when it comes, else 5, 10, 20, 40, 60, 60, 60 s; the 8th 429 stops with `umbler_429`.
  - 401/403: stop at once with `umbler_token`.
  - 5xx, network error or timeout: one more try after each of 2, 10 and 30 s, then `umbler_unavailable`.
  - 400 and any other 4xx: stop with `umbler_400`. A 404 on one note list or one chat's messages is skipped and counted (`isGone`).
  - File links: one more try after each of 1, 5 and 25 s, 60 s each, at most `FILE_MAX_BYTES` (64 MB), 4 at a time, and the import stops with `disk_full` below `MIN_FREE_BYTES` (2 GB).
- **Sizes.**
  - lists: `Take=50` (`PAGE_SIZE`);
  - messages: `Take=250` (`MESSAGES_TAKE`), the next page starting at the last `eventAtUTC` − 1 ms;
  - contacts: 100 per transaction;
  - the match: `MATCH_WINDOW_MS` = 10 s;
  - the wait for a running WhatsApp history import: 15 s;
  - the screen's poll: 3 s.
- **No side effects here.** An import never triggers triage, a bot, `startChannelBot`, `resumeOnReply`, a notification or a WhatsApp send. `unread` is set only on open chats (their `totalUnread`). Open chats publish `chat.updated` once, when they are finished. Finished chats never publish.
- **UI copy is pt-BR, exactly as spec §6 and §9.4.** It is all in `UMBLER_IMPORT_ERRORS` (shared), `importer/routes.ts` and `job.ts` (the analysis warnings), and `UmblerImportSettings.tsx`. Code identifiers are English.
- **Mensageiro visual.** Use `PageHeader`, `SettingsSection`, `SettingRow`, `block`, `ErrorText`, `Loading`, `btnPrimary` and `btnSecondary` from `components/settings/common.tsx`, and `fieldSelect` from `components/ui.ts`. Use theme tokens only (`text-fg`, `text-fg-2`, `text-muted`, `text-danger`, `bg-sunken` through `block`), never raw colors.
- **Commits.** Commit after every task with a Conventional Commit message, staging only that task's files. Every commit command ends with `-m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`.

## Decisions beyond the spec

The spec is silent on these. Each is the smallest choice that keeps the spec's behaviour.

1. `umbler_imports.created_at` is added, because "a mais recente" needs an order and `started_at` is null during an analysis.
2. Error code `unexpected` covers a database or program error, with the text "Erro inesperado no servidor. Clique em Continuar para tentar de novo."
3. "3 tentativas (2 s, 10 s, 30 s)" is read as one more try after each wait, so 4 calls in all. The same goes for files (1, 5 and 25 s).
4. The §4 check of `page.totalItems` against the walk shows a warning: "O Umbler informou N conversas abertas|finalizadas, mas a lista trouxe M."
5. A failed **analysis** (no `startedAt`) reads "A análise parou: <motivo>." and offers "Analisar de novo". `resume` refuses it with 409 `NOT_FAILED`.
6. Three route errors the spec does not word:
   - `BAD_MAPPING`: "Escolha um destino para cada canal, setor e atendente.";
   - `NOT_ANALYZED`: "Analise o Umbler antes de importar.";
   - `NOT_FAILED`: "Só uma importação que parou pode continuar.".
7. The "canal oficial" of §6.2 and §18.3 is our channel whose number some Umbler channel matched. Without one, it is our oldest connected channel, and without that, our oldest channel.
8. A matched location or contact card makes our row `kind='text'` as well as giving it the §7.7 text, or the bubble would still say "Mensagem não suportada".
9. §8.3 compares the normalized strings, which is the same test as comparing their SHA-256.
10. A chat without `done_at` is read again **from the start**, and the files that were unavailable are retried. `done_at` is withheld only when a file failed for now (5xx, network error or timeout after the retries). A 403, 404 or 410, no link, or a file over 64 MB counts as copied as far as possible.
11. `umbler_imported` is written once, when the chat is first complete, with count = the Umbler messages now in that chat. It is stamped at the Umbler `createdAtUTC`. The `closed` event is stamped at `closedAtUTC`. Both are direct inserts, because `addEvent` would stamp `clock_timestamp()`.
12. The catalog phase's maps (Umbler id → our id) are kept in `progress.maps` (ids only), which the DTO strips.
13. The Umbler loop runs at the history worker's 15 s beat, so "Analisar" starts at most 15 s after the click.
14. The analysis lists human members with an e-mail only. AI agents and removed members count as "atendente desconhecido".

## Review Focus

These are inputs and conditions the spec implies but never tests, most likely first. The owning task adds the named test.

1. **The import changes the office's Umbler.** A read marks a chat as read (§5), a non-GET slips in, or the chat-detail route gets called. **Owner: Task 2**, test `calls Umbler with GET only: no method, no read/unread/pin, no chat or message detail route`. **Task 5**, test `read test (§5.1): reads the newest closed chat still "Received" from the contact, then looks at it again`. **Task 10**, test `stops with umbler_marked_read when an open chat lost its unread count without an agent reply (§5.2)`.
2. **Messages that exist on both sides get duplicated.** There is no WhatsApp id (§4.1, §8), and it must hold in both directions. **Owner: Task 9**, test `the same message is not inserted again: our row moves to the imported chat with its id, WhatsApp id and status, and gains the author`. **Task 6**, test `gives an Umbler row without WhatsApp id its id instead of inserting the same message twice`.
3. **A restart, a stop or a second run duplicates rows or recounts.** **Owner: Task 10**, tests `a stop in the middle of the contacts or of a chat leaves it running; the next beat goes on without duplicates (§9.3)` and `"Analisar de novo" + "Importar" brings only what is missing; a finished closed chat costs no message call (§9.2)`.
4. **The token leaks** into a log, the row, the DTO, a file link or a redirect. **Owner: Task 2**, tests `files: no Authorization; …` and `never follows a redirect (redirect: 'error')…`. **Task 5**, test `a refused token fails the analysis with umbler_token, and the token is never in the row`. **Task 11**, test `GET says whether the token is configured, never any part of it, and returns the newest import`.
5. **Open chats land wrong in the Inbox, or the automatic rules act on them.** The owner may be inactive, the contact may already have an open chat here, `unread` or `waiting` may be lost. **Owner: Task 8**, tests `keeps sector, active owner, waiting and unread; waiting_since falls back to the last contact message; publishes once` and `joins the contact's open chat here (decision §7.6)…`. **Task 11**, test `start is blocked while the automatic rules are on or the read test marked a chat; 409 while another import is active`.

---

## File Structure

Each line gives the path, the task that creates or first modifies it, and its responsibility.

**Shared**
- `shared/src/umbler.ts` (T1, create): states, phases, `UMBLER_PHASE_LABELS`, `UMBLER_IMPORT_ERRORS`, the DTOs, `emptyUmblerCounts`.
- `shared/src/index.ts` (T1): re-exports; `ChatEventKind` gains `'umbler_imported'`.

**Server**
- `server/src/config.ts` (T1): `Config.umblerToken`, `UMBLER_TOKEN` optional.
- `server/src/db/schema.ts` (T1): `UmblerCatalogMaps`, tables `umblerImports`, `umblerMap`.
- `server/drizzle/0009_importar_umbler.sql`, `server/drizzle/meta/0009_snapshot.json`, `server/drizzle/meta/_journal.json` (T1): the generated migration.
- `docker-compose.yml`, `.env.example` (T1): `UMBLER_TOKEN`.
- `server/src/importer/umbler.ts`:
  - T2: the GET-only client, `pages`, `getAll`, `UmblerError`;
  - T3, rewritten: the Umbler types, `ImportRun`, phase 1 (catalog);
  - T4: phase 2 (contacts) and phase 4 (notes).
- `server/src/importer/cli.ts` (T3, delete), `server/package.json` (T3): the `import:umbler` script goes.
- `server/src/importer/chats.ts`:
  - T5, create: `chatQuery`, `fetchMessagePage`;
  - T7: `toIncoming`;
  - T8: `importChat` and files;
  - T9: the §8 match inside it;
  - T10: phases 3 and 5.
- `server/src/importer/job.ts`:
  - T5, create: `analyzeUmbler`, `runUmblerJob`;
  - T10: `importUmbler`, `umblerBeat` and the final `runUmblerJob`.
- `server/src/importer/match.ts` (T6, create): `pairUp`, `matchCandidates`, `claimUmblerTwin`.
- `server/src/history/place.ts` (T6): the reverse match before an insert.
- `server/src/history/jobs.ts` (T10): the third loop in `createHistoryWorker`.
- `server/src/importer/routes.ts` (T11, create), `server/src/app.ts` (T11): the four routes.

**Server tests**
- `server/test/helpers.ts`, `server/test/db/schema.test.ts`, `server/test/config.test.ts` (T1).
- `server/test/fakes/umbler-api.ts` (T2, create): the fake Umbler API.
- `server/test/importer/client.test.ts` (T2, create).
- `server/test/importer/world.ts` (T3, create; T5 and T10 append): `importWorld`, `testAnalysis`, `proposals`, `runFor`, `depsOf`, `rowOf`, `analyze`, `startImport`.
- `server/test/importer/umbler.test.ts` (T3, rewritten): the catalog phase.
- `server/test/importer/contacts.test.ts` (T4), `analyze.test.ts` (T5), `match.test.ts` (T6), `incoming.test.ts` (T7), `chats.test.ts` (T8), `chats-match.test.ts` (T9), `job.test.ts` (T10), `routes.test.ts` (T11), all created.
- `server/test/history/place.test.ts` (T6): the reverse match.

**Web**
- `web/src/components/conversation/model.ts` (+ `model.test.ts`) (T1): `eventText` for `umbler_imported`.
- `web/src/lib/api.ts` (+ `api.test.ts`) (T12): `api.umblerImport.*`, `qk.umblerImport`.
- `web/src/pages/settings/UmblerImportSettings.tsx` (+ test) (T12, create): the page.
- `web/src/pages/settings/SettingsPage.tsx` (+ test) (T12): the "Importar do Umbler" item.

**Docs**
- `docs/IMPLANTACAO.md`, `Dockerfile` (T13): §5 becomes the screen's procedure; the go-live checklist line changes; the stale `import-report.json` comment goes.
- `docs/superpowers/plans/2026-10-21-importar-umbler-aceite.md` (T13, create): the §15 acceptance script.

---

## Shared contract

Every name below is defined in exactly one task and used with this spelling everywhere.

**`shared/src/umbler.ts` (Task 1)**
```ts
export const UMBLER_IMPORT_STATES: readonly ['analyzing', 'analyzed', 'running', 'done', 'failed'];
export type UmblerImportState = (typeof UMBLER_IMPORT_STATES)[number];
export const UMBLER_IMPORT_PHASES: readonly ['catalog', 'contacts', 'open_chats', 'notes', 'closed_chats'];
export type UmblerImportPhase = (typeof UMBLER_IMPORT_PHASES)[number];
export const UMBLER_PHASE_LABELS: Record<UmblerImportPhase, string>; // 'cadastros' … 'conversas finalizadas'
export const UMBLER_IMPORT_ERRORS: { umbler_token; umbler_429; umbler_unavailable; umbler_marked_read; disk_full; umbler_400; unexpected }; // pt-BR
export type UmblerImportError = keyof typeof UMBLER_IMPORT_ERRORS;
export interface UmblerMappingDto { channels: Record<string, string>; sectors: Record<string, string>; members: Record<string, string> } // id | 'create' | 'none'
export interface UmblerAnalysisDto { organizationId; organization; contacts: { total; existing; withoutAddress }; chats: { open; waiting; closed; from; to };
  channels: Array<{ id; name; type; phone; whatsapp; chats; proposal }>; sectors: Array<{ id; name; proposal }>;
  members: Array<{ id; name; email; active; chats; proposal }>; tags: { new; existing }; customFields: { new; existing; unsupported: string[] };
  quickAnswers: { new; existing }; readTest: 'ok' | 'marked' | 'not_done'; warnings: string[] }
export interface UmblerCountsDto { sectors; tags; customFields; members: { linked; createdInactive; none }; quickAnswers: { created; existing; unmappedVariables; attachmentErrors };
  contacts: { created; completed; lidOnly; skipped }; notes; chats: { openCreated; openMerged; closed; skippedChannel; skippedEmpty; skippedDeleted; skippedNoAddress };
  messages: { total; notes; bot; unknownAuthor; redacted; matched; maxMatchDiffMs }; files: { saved; bytes; expired }; gone; planLimited }
export interface UmblerProgressDto extends UmblerCountsDto { done: number; total: number; chatsRead: number }
export interface UmblerReportDto extends UmblerCountsDto { durationMs: number }
export interface UmblerImportDto { id; state; phase; analysis; progress; report; error; blocks: string[]; createdAt; startedAt; finishedAt }
export interface UmblerImportStatusDto { tokenConfigured: boolean; current: UmblerImportDto | null }
export function emptyUmblerCounts(): UmblerCountsDto;
// shared/src/index.ts: ChatEventKind gains 'umbler_imported' (data { count, merged? })
```

**`server/src/db/schema.ts` and `config.ts` (Task 1)**
- `Config.umblerToken: string | null`.
- `interface UmblerCatalogMaps`:
  - `sectors`, `tags`: `Record<umblerId, ourId>`;
  - `fields`: `Record<umblerId, { id, kind }>`;
  - `members`: `Record<umblerId, { id, active }>`;
  - `defaultSector`.
- `umblerImports`:
  - `id`, `state`, `phase`, `analysis`, `mapping`, `progress` (`UmblerProgressDto & { maps? }`), `report`, `error`;
  - `createdBy` → users, set null;
  - `createdAt`, `startedAt`, `finishedAt`, `updatedAt`;
  - unique index `umbler_imports_one_active` on `((true))` where `state in ('analyzing','running')`.
- `umblerMap`:
  - `kind` (`'contact' | 'note' | 'chat' | 'message'`), `umblerId`, `localId`, `doneAt`;
  - primary key `(kind, umbler_id)`;
  - index `umbler_map_local_idx (kind, local_id)`;
  - no foreign key.

**Server**
```ts
// server/src/importer/umbler.ts — client (Task 2)
export const UMBLER_API: string; export const FILE_MAX_BYTES: number; export const PAGE_SIZE: number;
export class UmblerError extends Error { code: UmblerImportError; status: number | null; route: string | null }
export const isGone: (err: unknown) => boolean; // a 404
export type Query = Record<string, string | number | boolean | string[]>;
export type UmblerFile = { data: Buffer; mime: string } | { failed: 'gone' | 'temporary' };
export interface UmblerClient { get<T>(route: string, query?: Query, params?: Record<string, string>): Promise<T>; file(url: string): Promise<UmblerFile> }
export function createUmblerClient(opts: { token: string; baseUrl?: string; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<unknown>; now?: () => number }): UmblerClient;
export function pages<T>(client: UmblerClient, route: string, query: Query, count?: boolean): AsyncGenerator<{ items: T[]; total: number | null }>;
export function getAll<T>(client: UmblerClient, route: string, query: Query): Promise<T[]>;
// server/src/importer/umbler.ts — run and catalog (Task 3)
export interface UmblerMe; UmblerMember; UmblerOrganization; UmblerChannel; UmblerSector; UmblerTag; UmblerFieldDef; UmblerContact; UmblerQuickAnswer; UmblerNote; UmblerChat; UmblerMessage;
export type UmblerProgress = UmblerProgressDto & { maps?: UmblerCatalogMaps };
export interface ImportRun { ctx; client; importId; org; analysis; mapping; progress: UmblerProgress; signal: AbortSignal; sleep(ms); freeBytes(dir) }
export class Stopped extends Error {}; export function checkStop(run: ImportRun): void;
export async function saveProgress(db: Db | Tx, run: ImportRun, phase?: UmblerImportPhase): Promise<void>;
export function maps(run: ImportRun): UmblerCatalogMaps; export const orgQuery: (run: ImportRun) => Query; export const fold: (s: string) => string;
export function validPhone(raw?: string | null): string | null; export function lidOf(raw?: string | null): string | null;
export const FIELD_KINDS: Record<string, 'text' | 'number' | 'date' | 'cpf' | 'cnpj'>;
export async function importCatalog(run: ImportRun): Promise<void>;          // phase 1; sets phase 'contacts' in its transaction
// server/src/importer/umbler.ts — contacts and notes (Task 4)
export async function upsertContact(tx: Tx, c: UmblerContact, counts: UmblerProgress['contacts']): Promise<string | null>;
export async function importContactsPhase(run: ImportRun): Promise<void>;    // phase 2
export async function importNotesPhase(run: ImportRun): Promise<void>;       // phase 4
// server/src/importer/chats.ts (Tasks 5, 7, 8, 10)
export const FIRST_EVENT = '2000-01-01T00:00:00Z'; export const MESSAGES_TAKE = 250; export const MIN_FREE_BYTES: number; // T5, T5, T8
export function chatQuery(org: string, state: 'open' | 'closed'): Query;                                          // T5
export interface MessagePage { hasMessagesBeforeAllowedOrganizationPlan?: boolean; messages?: UmblerMessage[] }  // T5
export function fetchMessagePage(client: UmblerClient, org: string, chatId: string, from: Date): Promise<MessagePage>; // T5
export interface Incoming { umblerId; at; direction; kind; body; matchKind; matchText; authorUmblerId; bot; status; reaction; officeReaction; replyUmblerId; deletedAt; editedAt; redacted; file } // T7
export function toIncoming(m: UmblerMessage): Incoming | null;                                                    // T7
export async function importChat(run: ImportRun, chat: UmblerChat, state: 'open' | 'closed'): Promise<boolean>;   // T8 (+ the match, T9)
export async function importOpenChats(run: ImportRun): Promise<void>; export async function importClosedChats(run: ImportRun): Promise<void>; // T10
// server/src/importer/match.ts (Task 6)
export const MATCH_WINDOW_MS = 10_000;
export interface Comparable { direction: 'in' | 'out'; kind: string; text: string | null; at: Date }
export interface Candidate extends Comparable { id: string; chatId: string; authorId: string | null; mediaPath: string | null }
export function normalizeText(text: string | null): string;
export function pairUp<C extends Comparable>(items: Comparable[], candidates: C[]): Array<{ row: C; diffMs: number } | null>;
export async function matchCandidates(db: Db | Tx, scope: { contactId; channelId }, items: Array<{ at: Date }>, side: 'ours' | 'umbler'): Promise<Candidate[]>;
export async function hasUmblerMessages(db: Db | Tx): Promise<boolean>;
export async function claimUmblerTwin(tx: Tx, scope: { contactId; channelId }, ev: Comparable & { externalId: string }): Promise<boolean>;
// server/src/importer/job.ts (Tasks 5, 10)
export type UmblerImportRow = typeof umblerImports.$inferSelect;
export interface JobDeps { client: UmblerClient; signal?: AbortSignal; sleep?: (ms: number) => Promise<unknown>; freeBytes?: (dir: string) => Promise<number> }
export async function freeBytesOf(dir: string): Promise<number>; export const emptyProgress: () => UmblerProgressDto;
export async function analyzeUmbler(ctx: AppCtx, deps: JobDeps, row: UmblerImportRow): Promise<void>;          // T5
export async function runUmblerJob(ctx: AppCtx, deps: JobDeps): Promise<void>;                                  // T5 (analysis), T10 (both)
export async function importUmbler(ctx: AppCtx, deps: JobDeps, row: UmblerImportRow): Promise<void>;            // T10
export async function umblerBeat(ctx: AppCtx, signal: AbortSignal, makeClient?: () => UmblerClient): Promise<void>; // T10
// server/src/history/jobs.ts (Task 10): createHistoryWorker opts gain umblerClient?: () => UmblerClient
// server/src/importer/routes.ts (Task 11)
export const UMBLER_RUNNING, NO_TOKEN, BLOCK_RULES, BLOCK_READ_TEST, BAD_MAPPING, NOT_ANALYZED, NOT_FAILED: string;
export async function importBlocks(db: Db, row: UmblerImportRow): Promise<string[]>;
export async function toUmblerImportDto(db: Db, row: UmblerImportRow): Promise<UmblerImportDto>;
export function registerUmblerImportRoutes(app: FastifyInstance, ctx: AppCtx): void;
```

**HTTP (Task 11)**

| Route | Body | Answer |
|---|---|---|
| `GET /api/umbler-import` | | `UmblerImportStatusDto` (`current` = the newest by `created_at`) |
| `POST /api/umbler-import/analyze` | | `UmblerImportDto` (`analyzing`); 400 `NO_TOKEN`; 409 `UMBLER_RUNNING` |
| `POST /api/umbler-import/:id/start` | `{ mapping: UmblerMappingDto }` | `UmblerImportDto` (`running`, phase `catalog`); 409 `NOT_ANALYZED`; 400 `BAD_MAPPING`; 409 block text; 409 `UMBLER_RUNNING` |
| `POST /api/umbler-import/:id/resume` | | `UmblerImportDto` (`running`, same phase and counters); 409 `NOT_FAILED`; 409 block text; 409 `UMBLER_RUNNING` |

All four are admin-only (403 otherwise).

**Web**
- `web/src/lib/api.ts` (Task 12): `api.umblerImport.get()`, `analyze()`, `start(id, mapping)` and `resume(id)`; `qk.umblerImport` (`['umbler-import']`).
- `web/src/pages/settings/UmblerImportSettings.tsx` (Task 12):
  - `UmblerImportSettings` at `/configuracoes/importar-umbler` (admin only);
  - `durationText(ms)`, `progressLines(counts)`, `reportLines(counts)`, `channelHint(row, target, ourChannels)`.

**Test seams**
- `server/test/fakes/umbler-api.ts` (Task 2):
  - `startFakeUmbler()` → `{ world, requests, faults, stats, baseUrl, fileUrl, problems, calls, close }`;
  - `FakeUmbler`, `UmblerWorld`, `Fault`, `ORG`, `MEMBERS`, `PDF`;
  - `umblerChat(over)`, `umblerMessage(id, at, over)`.
- `server/test/importer/world.ts`:
  - T3: `importWorld()`, `testAnalysis(w, over)`, `proposals(analysis)`, `runFor(w, opts)`;
  - T5: `depsOf(w)`, `rowOf(w, id)`, `analyze(w)`;
  - T10: `startImport(w, row, deps?)`.

---

### Task 1: Shared contract, `UMBLER_TOKEN`, `umbler_imports` / `umbler_map` and migration 0009

Nothing reads the new tables yet. This task has to compile, migrate, read the token without ever showing it, and describe the new event. The new `ChatEventKind` forces `eventText`'s exhaustive switch to change in this task too, or the web typecheck fails.

**Files:**
- Create: `shared/src/umbler.ts`
- Modify: `shared/src/index.ts` (re-exports, `ChatEventKind`)
- Modify: `server/src/config.ts` (`Config`, env schema, `loadConfig`)
- Modify: `server/test/helpers.ts` (the `Config` literal of `makeTestCtx`)
- Modify: `server/src/db/schema.ts` (`@talk/shared` type import; `UmblerCatalogMaps`, `umblerImports`, `umblerMap` at the end)
- Generated: `server/drizzle/0009_importar_umbler.sql`, `server/drizzle/meta/0009_snapshot.json`, `server/drizzle/meta/_journal.json`
- Modify: `docker-compose.yml`, `.env.example`
- Modify: `web/src/components/conversation/model.ts` (`eventText`)
- Test: `server/test/db/schema.test.ts`, `server/test/config.test.ts`, `web/src/components/conversation/model.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: everything under `shared/src/umbler.ts`, `Config.umblerToken`, `umblerImports`, `umblerMap`, `UmblerCatalogMaps` and the `'umbler_imported'` event kind (Shared contract).

- [ ] **Step 1: Write the failing tests**

In `server/test/db/schema.test.ts`, replace

```ts
import { eq, is } from 'drizzle-orm';
```

with

```ts
import { randomUUID } from 'node:crypto';
import { eq, is } from 'drizzle-orm';
```

and

```ts
  botRuns, botVersions, bots, chatTags, chats, contacts, historyImports, messageEdits, messageFavorites, messages, scheduledMessages,
  sectors, tags,
} from '../../src/db/schema.js';
```

with

```ts
  botRuns, botVersions, bots, chatTags, chats, contacts, historyImports, messageEdits, messageFavorites, messages, scheduledMessages,
  sectors, tags, umblerImports, umblerMap,
} from '../../src/db/schema.js';
```

replace

```ts
    expect(tables).toHaveLength(26);
```

with

```ts
    expect(tables).toHaveLength(28);
```

and add the new test before the `message_favorites` one, replacing

```ts
  it('message_favorites: one star per message, gone with the message; users.preferences starts empty (spec 2026-10-19)', async () => {
```

with

```ts
  it('umbler_imports: one active import at a time; umbler_map: one row per kind and Umbler id (spec 2026-10-21 importar-umbler §9)', async () => {
    expect(await pgCode(db.insert(umblerImports).values({ state: 'analyzing' }))).toBeNull();
    expect(await pgCode(db.insert(umblerImports).values({ state: 'running' }))).toBe(UNIQUE_VIOLATION);
    expect(await pgCode(db.insert(umblerImports).values([{ state: 'done' }, { state: 'failed' }, { state: 'analyzed' }]))).toBeNull();
    const [row] = await db.select().from(umblerImports).where(eq(umblerImports.state, 'analyzing'));
    expect(row).toMatchObject({
      phase: null, analysis: null, mapping: null, progress: null, report: null, error: null, createdBy: null, startedAt: null, finishedAt: null,
    });
    const localId = randomUUID();
    expect(await pgCode(db.insert(umblerMap).values({ kind: 'chat', umblerId: 'U1', localId }))).toBeNull();
    expect(await pgCode(db.insert(umblerMap).values({ kind: 'chat', umblerId: 'U1', localId: randomUUID() }))).toBe(UNIQUE_VIOLATION);
    expect(await pgCode(db.insert(umblerMap).values({ kind: 'message', umblerId: 'U1', localId }))).toBeNull();
    expect((await db.select().from(umblerMap))[0]!.doneAt).toBeNull();
  });

  it('message_favorites: one star per message, gone with the message; users.preferences starts empty (spec 2026-10-19)', async () => {
```

In `server/test/config.test.ts`, replace

```ts
  it('rejects an APP_ORIGIN that is not a URL', () => {
```

with

```ts
  it('reads UMBLER_TOKEN as optional: empty is absent, never shown in an error (spec 2026-10-21 importar-umbler §10)', () => {
    expect(loadConfig(base).umblerToken).toBeNull();
    expect(loadConfig({ ...base, UMBLER_TOKEN: '' }).umblerToken).toBeNull();
    expect(loadConfig({ ...base, UMBLER_TOKEN: '  eyJ.token  ' }).umblerToken).toBe('eyJ.token');
    const err = (() => {
      try {
        loadConfig({ ...base, UMBLER_TOKEN: 'eyJ.segredo', WEBHOOK_SECRET: 'curto' });
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err?.message).toMatch(/WEBHOOK_SECRET/);
    expect(err?.message).not.toContain('eyJ.segredo');
  });

  it('rejects an APP_ORIGIN that is not a URL', () => {
```

In `web/src/components/conversation/model.test.ts`, replace

```ts
describe('eventText for chatbot events', () => {
```

with

```ts
describe('eventText for the Umbler import (spec 2026-10-21 importar-umbler §10)', () => {
  it('describes an imported chat and one joined into a chat here', () => {
    expect(eventText(event({ kind: 'umbler_imported', data: { count: 1234 } }), new Map())).toBe('Conversa importada do Umbler Talk: 1.234 mensagens');
    expect(eventText(event({ kind: 'umbler_imported', data: { count: 3, merged: true } }), new Map())).toBe(
      '3 mensagens de uma conversa aberta no Umbler Talk juntadas a esta',
    );
  });
});

describe('eventText for chatbot events', () => {
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w server -- test/db/schema.test.ts test/config.test.ts`
Expected: FAIL. `umblerImports` is not exported by `schema.js`, the table count is 26, and `umblerToken` is `undefined`.

Run: `npm test -w web -- src/components/conversation/model.test.ts`
Expected: FAIL on the new test: `eventText` returns `undefined` for `'umbler_imported'`.

- [ ] **Step 3: Create the shared module**

Create `shared/src/umbler.ts`:

```ts
// Importar do Umbler Talk (spec 2026-10-21 importar-umbler §6, §9, §10). Runtime values with no imports: tsx (server)
// and Vite (web) load this source directly.

export const UMBLER_IMPORT_STATES = ['analyzing', 'analyzed', 'running', 'done', 'failed'] as const;
export type UmblerImportState = (typeof UMBLER_IMPORT_STATES)[number];

/** §9.1, in this order. */
export const UMBLER_IMPORT_PHASES = ['catalog', 'contacts', 'open_chats', 'notes', 'closed_chats'] as const;
export type UmblerImportPhase = (typeof UMBLER_IMPORT_PHASES)[number];

/** "Etapa 3 de 5: conversas abertas" (§6.1). */
export const UMBLER_PHASE_LABELS: Record<UmblerImportPhase, string> = {
  catalog: 'cadastros',
  contacts: 'contatos',
  open_chats: 'conversas abertas',
  notes: 'observações dos contatos',
  closed_chats: 'conversas finalizadas',
};

/** §9.4: why an import stopped (umbler_imports.error keeps only the code). `unexpected` is a database or program error. */
export const UMBLER_IMPORT_ERRORS = {
  umbler_token: 'O Umbler recusou o token (expirado ou apagado). Gere outro, troque UMBLER_TOKEN no .env e reinicie o sistema.',
  umbler_429: 'O Umbler limitou as requisições. Clique em Continuar daqui a alguns minutos.',
  umbler_unavailable: 'O Umbler não respondeu. Clique em Continuar para tentar de novo.',
  umbler_marked_read: 'Uma leitura marcou conversa como lida no Umbler; a importação parou por segurança.',
  disk_full: 'Pouco espaço em disco para os arquivos (menos de 2 GB).',
  umbler_400: 'O Umbler recusou uma consulta do importador. Avise o suporte técnico.',
  unexpected: 'Erro inesperado no servidor. Clique em Continuar para tentar de novo.',
} as const;
export type UmblerImportError = keyof typeof UMBLER_IMPORT_ERRORS;

/** Where each Umbler channel, sector and attendant goes (§6.2): one of our ids, 'create' or 'none'. */
export interface UmblerMappingDto {
  /** our channel id or 'none' */
  channels: Record<string, string>;
  /** our sector id or 'create' */
  sectors: Record<string, string>;
  /** our user id, 'create' (inactive user, §7.2) or 'none' */
  members: Record<string, string>;
}

/** "O que foi encontrado" (§6.2). Office data only: no client name, phone or text (§12). */
export interface UmblerAnalysisDto {
  organizationId: string;
  organization: string;
  contacts: { total: number; existing: number; withoutAddress: number };
  chats: { open: number; waiting: number; closed: number; from: string | null; to: string | null };
  channels: Array<{ id: string; name: string; type: string; phone: string | null; whatsapp: boolean; chats: number; proposal: string }>;
  sectors: Array<{ id: string; name: string; proposal: string }>;
  members: Array<{ id: string; name: string; email: string; active: boolean; chats: number; proposal: string }>;
  tags: { new: number; existing: number };
  customFields: { new: number; existing: number; unsupported: string[] };
  quickAnswers: { new: number; existing: number };
  readTest: 'ok' | 'marked' | 'not_done';
  warnings: string[];
}

/** The counters of §6.1 and §6.4; the progress while it runs, the report when it ends. */
export interface UmblerCountsDto {
  sectors: { created: number; existing: number };
  tags: { created: number; existing: number };
  customFields: { created: number; existing: number; unsupported: string[] };
  members: { linked: number; createdInactive: number; none: number };
  quickAnswers: { created: number; existing: number; unmappedVariables: string[]; attachmentErrors: string[] };
  contacts: { created: number; completed: number; lidOnly: number; skipped: number };
  notes: number;
  chats: {
    openCreated: number; openMerged: number; closed: number;
    skippedChannel: number; skippedEmpty: number; skippedDeleted: number; skippedNoAddress: number;
  };
  messages: { total: number; notes: number; bot: number; unknownAuthor: number; redacted: number; matched: number; maxMatchDiffMs: number };
  files: { saved: number; bytes: number; expired: number };
  /** notes or chats deleted in Umbler during the copy (404) */
  gone: number;
  /** relative-messages said the plan hides older messages */
  planLimited: boolean;
}
/** done/total: the current phase ("120 de 135"); chatsRead: the analysis ("N conversas lidas"). */
export interface UmblerProgressDto extends UmblerCountsDto { done: number; total: number; chatsRead: number }
export interface UmblerReportDto extends UmblerCountsDto { durationMs: number }

export interface UmblerImportDto {
  id: string;
  state: UmblerImportState;
  phase: UmblerImportPhase | null;
  analysis: UmblerAnalysisDto | null;
  progress: UmblerProgressDto | null;
  report: UmblerReportDto | null;
  error: UmblerImportError | null;
  /** §6.3 reasons "Importar"/"Continuar" is blocked right now (pt-BR, checked on every read) */
  blocks: string[];
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** GET /api/umbler-import */
export interface UmblerImportStatusDto { tokenConfigured: boolean; current: UmblerImportDto | null }

export function emptyUmblerCounts(): UmblerCountsDto {
  return {
    sectors: { created: 0, existing: 0 },
    tags: { created: 0, existing: 0 },
    customFields: { created: 0, existing: 0, unsupported: [] },
    members: { linked: 0, createdInactive: 0, none: 0 },
    quickAnswers: { created: 0, existing: 0, unmappedVariables: [], attachmentErrors: [] },
    contacts: { created: 0, completed: 0, lidOnly: 0, skipped: 0 },
    notes: 0,
    chats: { openCreated: 0, openMerged: 0, closed: 0, skippedChannel: 0, skippedEmpty: 0, skippedDeleted: 0, skippedNoAddress: 0 },
    messages: { total: 0, notes: 0, bot: 0, unknownAuthor: 0, redacted: 0, matched: 0, maxMatchDiffMs: 0 },
    files: { saved: 0, bytes: 0, expired: 0 },
    gone: 0,
    planLimited: false,
  };
}
```

In `shared/src/index.ts`, replace

```ts
  formatOfficeDateTime,
} from './automation.js';
export type * from './automation.js';
```

with

```ts
  formatOfficeDateTime,
} from './automation.js';
export type * from './automation.js';
export { UMBLER_IMPORT_STATES, UMBLER_IMPORT_PHASES, UMBLER_PHASE_LABELS, UMBLER_IMPORT_ERRORS, emptyUmblerCounts } from './umbler.js';
export type * from './umbler.js';
```

and replace

```ts
  | 'message_scheduled' | 'scheduled_canceled' | 'returned_to_queue';
```

with

```ts
  | 'message_scheduled' | 'scheduled_canceled' | 'returned_to_queue'
  // spec 2026-10-21 importar-umbler §10: data { count, merged? }
  | 'umbler_imported';
```

- [ ] **Step 4: Read the token from the environment, never showing it**

In `server/src/config.ts`, replace

```ts
  evolution: { url: string; apiKey: string };
  sessionDays: number;
}
```

with

```ts
  evolution: { url: string; apiKey: string };
  sessionDays: number;
  /** Spec 2026-10-21 importar-umbler §10: the Umbler access token; null = not configured. Never logged, stored or sent to the web. */
  umblerToken: string | null;
}
```

replace

```ts
  EVOLUTION_API_KEY: z.string().min(1),
});
```

with

```ts
  EVOLUTION_API_KEY: z.string().min(1),
  // optional; empty = absent (docker-compose passes UMBLER_TOKEN: ${UMBLER_TOKEN:-})
  UMBLER_TOKEN: z.string().optional().transform((v) => v?.trim() || null),
});
```

and replace

```ts
    sessionDays: 30,
  };
}
```

with

```ts
    sessionDays: 30,
    umblerToken: e.UMBLER_TOKEN,
  };
}
```

In `server/test/helpers.ts`, replace

```ts
    evolution: { url: 'http://evolution.test', apiKey: 'test-key' },
    sessionDays: 30,
  };
```

with

```ts
    evolution: { url: 'http://evolution.test', apiKey: 'test-key' },
    sessionDays: 30,
    umblerToken: null,
  };
```

In `docker-compose.yml` (service `app`, `environment`), replace

```yaml
      MEDIA_DIR: /data/media
```

with

```yaml
      MEDIA_DIR: /data/media
      UMBLER_TOKEN: ${UMBLER_TOKEN:-}
```

In `.env.example`, replace

```bash
POSTGRES_EVOLUTION_PASSWORD=troque-com-gen-secrets
```

with

```bash
POSTGRES_EVOLUTION_PASSWORD=troque-com-gen-secrets

# Importar do Umbler (Ajustes › Importar do Umbler): token de acesso do Umbler Talk (Perfil → Tokens de acesso), gerado
# com o Proprietário. Só durante a importação: depois, apague a linha e reinicie. Nunca aparece na tela nem nos logs.
# UMBLER_TOKEN=
```

- [ ] **Step 5: Add the tables**

In `server/src/db/schema.ts`, replace

```ts
import type {
  BotGraph, BotRunState, BotRunStep, BotRunVars, ChatEventKind, HistoryImportState, HistoryPeriod, MessageChangeSource,
  ScheduledStatus, UserPreferences,
} from '@talk/shared';
```

with

```ts
import type {
  BotGraph, BotRunState, BotRunStep, BotRunVars, ChatEventKind, HistoryImportState, HistoryPeriod, MessageChangeSource,
  ScheduledStatus, UmblerAnalysisDto, UmblerImportError, UmblerImportPhase, UmblerImportState, UmblerMappingDto,
  UmblerProgressDto, UmblerReportDto, UserPreferences,
} from '@talk/shared';
```

and append after `deletedChats`, at the end of the file:

```ts
/** Spec 2026-10-21 importar-umbler §7: what the catalog phase resolved (Umbler id → ours), read by the later phases and a resume. */
export interface UmblerCatalogMaps {
  sectors: Record<string, string>;
  tags: Record<string, string>;
  fields: Record<string, { id: string; kind: 'text' | 'number' | 'date' | 'cpf' | 'cnpj' }>;
  /** linked or created users; an attendant mapped to "Sem atendente" is absent */
  members: Record<string, { id: string; active: boolean }>;
  defaultSector: string;
}

/** Spec 2026-10-21 importar-umbler §10: one "Importar do Umbler" run. analyzing → analyzed → running → done | failed. */
export const umblerImports = pgTable(
  'umbler_imports',
  {
    id: id(),
    state: text('state').$type<UmblerImportState>().notNull(),
    phase: text('phase').$type<UmblerImportPhase>(),
    analysis: jsonb('analysis').$type<UmblerAnalysisDto>(),
    mapping: jsonb('mapping').$type<UmblerMappingDto>(),
    progress: jsonb('progress').$type<UmblerProgressDto & { maps?: UmblerCatalogMaps }>(),
    report: jsonb('report').$type<UmblerReportDto>(),
    error: text('error').$type<UmblerImportError>(), // the code only (§9.4)
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(), // "a mais recente" (GET /api/umbler-import)
    startedAt: timestamp('started_at', { withTimezone: true }), // "Importar"; null while it is only an analysis
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  // §9.3: one active import at a time (a constant expression, so any two active rows collide)
  (t) => [uniqueIndex('umbler_imports_one_active').on(sql`(true)`).where(sql`${t.state} in ('analyzing', 'running')`)],
);

/** Spec §9.2: Umbler id → our id, so nothing is ever imported twice. No foreign key: a local id that is gone = deleted here. */
export const umblerMap = pgTable(
  'umbler_map',
  {
    kind: text('kind').$type<'contact' | 'note' | 'chat' | 'message'>().notNull(),
    umblerId: text('umbler_id').notNull(),
    localId: uuid('local_id').notNull(),
    doneAt: timestamp('done_at', { withTimezone: true }), // contact: notes copied; chat: every message and file copied
  },
  (t) => [primaryKey({ columns: [t.kind, t.umblerId] }), index('umbler_map_local_idx').on(t.kind, t.localId)],
);
```

- [ ] **Step 6: Generate the migration**

Run: `npm run db:generate -w server -- --name importar_umbler`
Expected: it creates `server/drizzle/0009_importar_umbler.sql` and `server/drizzle/meta/0009_snapshot.json`, and it adds the `0009_importar_umbler` entry (idx 9) to `_journal.json` after `0008_agendamentos_e_regras`.

Run: `grep -E '^(CREATE|ALTER|DROP)' server/drizzle/0009_importar_umbler.sql`
Expected: exactly 5 lines:
- `CREATE TABLE "umbler_imports" (`;
- `CREATE TABLE "umbler_map" (`;
- `ALTER TABLE "umbler_imports" ADD CONSTRAINT "umbler_imports_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null …`;
- `CREATE UNIQUE INDEX "umbler_imports_one_active" ON "umbler_imports" USING btree ((true)) WHERE "umbler_imports"."state" in ('analyzing', 'running');…`;
- `CREATE INDEX "umbler_map_local_idx" ON "umbler_map" USING btree ("kind","local_id");`.

Anything else means the schema and the 0008 snapshot disagree. In that case stop: do not edit the SQL or the snapshot, and report it.

- [ ] **Step 7: Describe the event on the web**

In `web/src/components/conversation/model.ts`, replace

```ts
    case 'returned_to_queue':
      return `Devolvida à fila: sem resposta há ${Number(e.data.minutes ?? 0)} min`;
  }
```

with

```ts
    case 'returned_to_queue':
      return `Devolvida à fila: sem resposta há ${Number(e.data.minutes ?? 0)} min`;
    case 'umbler_imported': {
      const n = Number(e.data.count ?? 0).toLocaleString('pt-BR');
      return e.data.merged === true
        ? `${n} mensagens de uma conversa aberta no Umbler Talk juntadas a esta`
        : `Conversa importada do Umbler Talk: ${n} mensagens`;
    }
  }
```

- [ ] **Step 8: Run the tests and the type check**

Run: `npm test -w server -- test/db/schema.test.ts test/config.test.ts`
Expected: PASS.

Run: `npm test -w web -- src/components/conversation/model.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: no errors in any workspace.

- [ ] **Step 9: Commit**

```bash
git add shared/src/umbler.ts shared/src/index.ts server/src/config.ts server/test/helpers.ts server/src/db/schema.ts server/drizzle/0009_importar_umbler.sql server/drizzle/meta/0009_snapshot.json server/drizzle/meta/_journal.json docker-compose.yml .env.example server/test/db/schema.test.ts server/test/config.test.ts web/src/components/conversation/model.ts web/src/components/conversation/model.test.ts
git commit -m "feat(shared,server): Umbler import contract, UMBLER_TOKEN, umbler_imports and umbler_map (migration 0009)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The Umbler client (GET only) and the fake Umbler API

The client replaces the CLI importer's `umblerClient` in place. The CLI importer keeps working through it, and its current test still passes, until Task 3 removes both. From here on, the fake API is the only Umbler any test talks to.

**Files:**
- Modify: `server/src/importer/umbler.ts` (two imports, the constants, the client block, `fetchUmbler`)
- Create: `server/test/fakes/umbler-api.ts`
- Test: `server/test/importer/client.test.ts` (create)

**Interfaces:**
- Consumes: Task 1 `UmblerImportError`.
- Produces:
  - `UMBLER_API`, `FILE_MAX_BYTES`, `PAGE_SIZE`;
  - `UmblerError`, `isGone`;
  - `Query`, `UmblerFile`, `UmblerClient`, `UmblerClientOpts`;
  - `createUmblerClient`, `pages`, `getAll`;
  - the fake: `startFakeUmbler`, `FakeUmbler`, `UmblerWorld`, `Fault`, `ORG`, `MEMBERS`, `PDF`, `umblerChat` and `umblerMessage`.

- [ ] **Step 1: Create the fake Umbler API**

It holds the §14 shapes:
- `members/me`, `organizations/{id}`, `channels`, `sectors`, `tags`, `custom-field-definitions`, `quick-answers` (+ `/{id}`);
- `contacts` (Skip/Take, `includeCustomFields`), `contacts/{id}/custom-fields`, `contacts/{id}/notes`, `contacts/{id}/chats`;
- `chats`, which answers 400 unless the query has `ContactTypes=DirectMessage`, the three `Visibility` values, `IncludePinneds=false` and the spec's order;
- `relative-messages`, with an inclusive limit, `Take ≤ 250` and `hasMessagesBeforeAllowedOrganizationPlan`;
- `/s3/<name>`.

It records every request. Faults can be injected per path (status, how many times, `Retry-After`, `Location`), along with slow or forbidden files and a chat whose read "marks it as read" (`marksRead`).

Create `server/test/fakes/umbler-api.ts`:

```ts
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

// A fake Umbler Talk API on a random local port (spec 2026-10-21 importar-umbler §14), with the shapes of
// docs/umbler/utalk-openapi-v1.json, plus /s3/<name> in the role of the file links. It records every request; every
// test ends with expect(fake.problems()).toEqual([]). Never a real call.

export const ORG = 'ORG_TESTE_00001';
type Obj = Record<string, unknown>;

export interface FakeRequest { method: string; path: string; query: URLSearchParams; auth: string | null }
/** The next `times` (default 1) requests whose path matches answer `status`; Infinity = always. */
export interface Fault { path: RegExp; status: number; times?: number; retryAfter?: string; location?: string }
export interface FakeFile { body: Buffer; mime: string; status?: number; delayMs?: number }

export interface UmblerWorld {
  me: Obj;
  organization: Obj;
  channels: Obj[];
  sectors: Obj[];
  tags: Obj[];
  fieldDefs: Obj[];
  quickAnswers: Obj[];
  contacts: Obj[];
  /** GET /v1/contacts/{id}/custom-fields/ (the §4.1 fallback) */
  contactFields: Record<string, Obj[]>;
  notes: Record<string, Obj[]>;
  chats: Obj[];
  /** by chat id */
  messages: Record<string, Obj[]>;
  files: Record<string, FakeFile>;
  maxTake: number;
  /** added to page.totalItems (Behavior=CountAllAndGetSlice): an Umbler count that disagrees with its own list */
  totalBias: number;
  /** the contact list ignores includeCustomFields */
  omitCustomFields: boolean;
  planLimited: boolean;
  /** reading this chat's messages marks it as read in Umbler (the risk of §5): lastMessage → Read, totalUnread → 0 */
  marksRead: string | null;
}

export const MEMBERS = {
  ana: { _t: 'OrganizationHumanAgentReferenceModel', id: 'M_ANA', displayName: 'Ana Umbler', emailAddress: 'ANA@teste.local', active: true },
  carla: { _t: 'OrganizationHumanAgentReferenceModel', id: 'M_CARLA', displayName: 'Carla Antiga', emailAddress: 'carla@antigo.test', active: false },
  robo: { _t: 'OrganizationAIAgentReferenceModel', id: 'M_IA', displayName: 'Assistente', active: true },
};
export const PDF = Buffer.from('%PDF-1.4 anexo sintetico');

function defaultWorld(fileUrl: (name: string) => string): UmblerWorld {
  const tagRef = (id: string, name: string) => ({ _t: 'SimpleTagReferenceModel', id, name });
  return {
    me: {
      _t: 'HumanOrganizationAgentModel',
      id: 'M_ANA',
      emailAddress: 'ana@teste.local',
      organizations: [
        {
          _t: 'OrganizationReferenceForHumanAgentModel', id: ORG, name: 'Escritório Teste', active: true, permissions: ['Owner'],
          allowedSectors: { allSectorsEnable: true, sectors: [] }, allowedChannels: { allChannelsEnable: true, channels: [] },
        },
      ],
    },
    organization: {
      _t: 'SimpleOrganizationModel', id: ORG, name: 'Escritório Teste', maxDaysMessageHistoric: null,
      organizationMembers: [MEMBERS.ana, MEMBERS.carla, MEMBERS.robo],
    },
    channels: [
      { _t: 'OrganizationBrokerWhatsappChannelReferenceModel', id: 'CH_WA', name: 'WhatsApp Umbler', state: 'Live', phoneNumber: '+5565999990000' },
      { _t: 'OrganizationWebsiteWidgetChannelReferenceModel', id: 'CH_WEB', name: 'Site', state: 'Live' },
    ],
    sectors: [
      { _t: 'SectorReferenceModel', id: 'SEC1', name: 'Atendimento', default: true, order: 0, groupIds: [] },
      { _t: 'SectorReferenceModel', id: 'SEC2', name: ' FINANCEIRO ', default: false, order: 1, groupIds: [] },
      { _t: 'SectorReferenceModel', id: 'SEC3', name: 'Trabalhista', default: false, order: 2, groupIds: [] },
    ],
    tags: [
      { _t: 'TagModel', id: 'TAG1', name: 'Cliente', emoji: '⭐', color: 'Gold', order: 0, groupIds: [] },
      { _t: 'TagModel', id: 'TAG2', name: 'Prospecção', emoji: null, color: 'Blue', order: 1, groupIds: [] },
    ],
    fieldDefs: [
      { _t: 'CPFCustomFieldDefinitionModel', id: 'CF1', name: 'CPF' },
      { _t: 'DateCustomFieldDefinitionModel', id: 'CF2', name: 'Nascimento' },
      { _t: 'LogicCustomFieldDefinitionModel', id: 'CF3', name: 'Aceitou termos' },
    ],
    quickAnswers: [
      {
        _t: 'QuickAnswerModel', id: 'QA1', name: 'Boas-vindas', content: 'Olá {{1}}, aqui é {{2}}.', organizationMember: null,
        variables: [{ name: 'nome', defaultValue: 'Contato.PrimeiroNome' }, { name: 'assinatura', defaultValue: 'Valor fixo qualquer' }],
        attachment: null,
      },
      {
        _t: 'QuickAnswerModel', id: 'QA2', name: 'Procuração', content: 'Segue a procuração.', organizationMember: { id: 'M_ANA' },
        variables: [], attachment: { fileId: 'F1', fileType: 'File', url: fileUrl('procuracao.pdf'), originalName: 'procuracao.pdf' },
      },
    ],
    contacts: [
      {
        _t: 'SimpleContactModel', id: 'C1', name: 'Maria Teste', phoneNumber: '+55 65 9999-8888', lid: null, email: 'maria@example.test',
        landline: null, address: { addressLine1: 'Rua das Flores, 100', city: 'Cuiabá', state: 'MT', zipCode: null }, isBlocked: false,
        tags: [tagRef('TAG1', 'Cliente')],
        customFields: [
          { _t: 'ContactCPFCustomFieldModel', customFieldDefinitionId: 'CF1', value: '000.000.000-00' },
          { _t: 'ContactDateCustomFieldModel', customFieldDefinitionId: 'CF2', value: '1990-05-17T00:00:00Z' },
          { _t: 'ContactLogicCustomFieldModel', customFieldDefinitionId: 'CF3', value: true },
        ],
      },
      {
        _t: 'SimpleContactModel', id: 'C2', name: 'João Teste', phoneNumber: '5565988887777', lid: '201234567890123', isBlocked: true,
        tags: [tagRef('TAG1', 'Cliente'), tagRef('TAG2', 'Prospecção')], customFields: [],
      },
      { _t: 'SimpleContactModel', id: 'C3', name: 'Só LID', phoneNumber: '123', lid: '209999999999999@lid', isBlocked: false, tags: [], customFields: [] },
      { _t: 'SimpleContactModel', id: 'C4', name: 'Sem Número', phoneNumber: null, lid: null, isBlocked: false, tags: [], customFields: [] },
    ],
    contactFields: {},
    notes: {},
    chats: [],
    messages: {},
    files: { 'procuracao.pdf': { body: PDF, mime: 'application/pdf' } },
    maxTake: 50,
    totalBias: 0,
    omitCustomFields: false,
    planLimited: false,
    marksRead: null,
  };
}

let seq = 0;
/** A BasicChatModel: Maria (C1) on the WhatsApp channel, sector Financeiro, owner Ana, open. */
export function umblerChat(over: Obj = {}): Obj {
  seq += 1;
  return {
    _t: 'BasicChatModel', id: `CHAT${seq}`, createdAtUTC: '2026-09-01T12:00:00Z',
    contact: { _t: 'ContactReferenceModel', id: 'C1', name: 'Maria Teste', phoneNumber: '+5565999998888', lid: null, contactType: 'DirectMessage' },
    channel: { _t: 'ChatBrokerWhatsappChannelReferenceModel', id: 'CH_WA', name: 'WhatsApp Umbler', phoneNumber: '+5565999990000' },
    sector: { _t: 'SectorReferenceModel', id: 'SEC2', name: 'Financeiro' },
    organizationMember: { _t: 'ChatAgentReferenceModel', id: 'M_ANA' },
    tags: [], open: true, private: false, waiting: false, waitingSinceUTC: null, totalUnread: 0, closedAtUTC: null, closedBy: null,
    redactReason: null, lastMessage: null, visibility: 'Show',
    ...over,
  };
}

/** A MessageModel from the contact, read, text "texto <id>". */
export function umblerMessage(id: string, at: string, over: Obj = {}): Obj {
  return {
    _t: 'MessageModel', id, createdAtUTC: at, eventAtUTC: at, chat: { _t: 'ChatIdReferenceModel', id: 'X' }, source: 'Contact',
    isPrivate: false, messageType: 'Text', content: `texto ${id}`, prefix: null, file: null, messageState: 'Read', reactions: [],
    contacts: [], sentByOrganizationMember: null, inReplyTo: null, latestEdit: null, location: null,
    ...over,
  };
}

const json = (res: ServerResponse, body: unknown, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

export async function startFakeUmbler() {
  const requests: FakeRequest[] = [];
  const faults: Fault[] = [];
  let concurrentFiles = 0;
  const stats = { maxConcurrentFiles: 0 };
  let origin = '';
  const fileUrl = (name: string) => `${origin}/s3/${name}`;
  const server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const world = defaultWorld(fileUrl);

  const page = (url: URL, items: Obj[]) => {
    const skip = Number(url.searchParams.get('Skip') ?? '0');
    const take = Math.min(Number(url.searchParams.get('Take') ?? '50'), world.maxTake);
    const slice = items.slice(skip, skip + take);
    const totalItems = url.searchParams.get('Behavior') === 'CountAllAndGetSlice' ? items.length + world.totalBias : 0;
    return { page: { totalItems, skipped: skip, took: slice.length, maxTake: world.maxTake }, items: slice };
  };
  const byState = (state: string | null, list: Obj[]) =>
    state === 'Closed' ? list.filter((c) => c.open === false) : state === 'All' ? list : list.filter((c) => c.open !== false);

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', origin);
    const p = url.pathname;
    requests.push({ method: req.method ?? '', path: p, query: url.searchParams, auth: req.headers.authorization ?? null });
    const fault = faults.find((f) => f.path.test(p) && (f.times ?? 1) > 0);
    if (fault) {
      fault.times = (fault.times ?? 1) - 1;
      res.writeHead(fault.status, {
        'content-type': 'application/json',
        ...(fault.retryAfter ? { 'retry-after': fault.retryAfter } : {}),
        ...(fault.location ? { location: fault.location } : {}),
      });
      res.end('{}');
      return;
    }
    if (p.startsWith('/s3/')) {
      const file = world.files[decodeURIComponent(p.slice(4))];
      if (!file) return json(res, { error: 'NoSuchKey' }, 404);
      concurrentFiles += 1;
      stats.maxConcurrentFiles = Math.max(stats.maxConcurrentFiles, concurrentFiles);
      if (file.delayMs) await delay(file.delayMs);
      concurrentFiles -= 1;
      res.writeHead(file.status ?? 200, { 'content-type': file.mime });
      res.end(file.body);
      return;
    }
    const q = url.searchParams;
    const orgOk = q.get('organizationId') === ORG;
    let m: RegExpExecArray | null;
    if (p === '/api/v1/members/me/') return json(res, world.me);
    if (p === `/api/v1/organizations/${ORG}/`) return json(res, world.organization);
    if (!orgOk) return json(res, { error: 'organizationId' }, 400);
    if (p === '/api/v1/channels/') return json(res, world.channels);
    if (p === '/api/v1/sectors/') return json(res, world.sectors);
    if (p === '/api/v1/tags/') return json(res, page(url, world.tags));
    if (p === '/api/v1/custom-field-definitions/') return json(res, world.fieldDefs);
    if (p === '/api/v1/quick-answers/') return json(res, page(url, world.quickAnswers));
    if ((m = /^\/api\/v1\/quick-answers\/([^/]+)\/$/.exec(p))) {
      const qa = world.quickAnswers.find((x) => x.id === m![1]);
      return qa ? json(res, qa) : json(res, { error: 'not found' }, 404);
    }
    if (p === '/api/v1/contacts/') {
      const asked = q.getAll('includeCustomFields');
      const list = world.contacts.map((c) => {
        if (world.omitCustomFields || asked.length === 0) {
          const { customFields: _cf, ...rest } = c;
          return rest;
        }
        return c;
      });
      return json(res, page(url, list));
    }
    if ((m = /^\/api\/v1\/contacts\/([^/]+)\/custom-fields\/$/.exec(p))) return json(res, world.contactFields[m[1]!] ?? []);
    if ((m = /^\/api\/v1\/contacts\/([^/]+)\/notes\/$/.exec(p))) {
      const notes = world.notes[m[1]!];
      return notes ? json(res, notes) : json(res, { error: 'not found' }, 404);
    }
    if ((m = /^\/api\/v1\/contacts\/([^/]+)\/chats\/$/.exec(p))) {
      const id = m[1];
      const mine = world.chats.filter((c) => (c.contact as Obj).id === id);
      return json(res, page(url, byState(q.get('ChatState') ?? 'All', mine)));
    }
    if (p === '/api/v1/chats/') {
      // §4: the importer must ask for direct chats, hidden ones too, without pinned ones mixed in, in the spec's order
      const state = q.get('ChatState');
      const order = state === 'Closed' ? 'ClosedAtUTC/Desc' : 'CreatedAtUTC/Asc';
      const ok =
        q.getAll('ContactTypes').join() === 'DirectMessage' &&
        q.getAll('Visibility').sort().join() === 'Hide,HideUntilNextMessage,Show' &&
        q.get('IncludePinneds') === 'false' &&
        `${q.get('ChatOrderBy')}/${q.get('Order')}` === order;
      if (!ok) return json(res, { error: 'unexpected chat query' }, 400);
      const list = [...byState(state ?? 'Open', world.chats)].sort((a, b) =>
        state === 'Closed'
          ? String(b.closedAtUTC).localeCompare(String(a.closedAtUTC))
          : String(a.createdAtUTC).localeCompare(String(b.createdAtUTC)),
      );
      return json(res, page(url, list));
    }
    if ((m = /^\/api\/v1\/chats\/([^/]+)\/relative-messages\/$/.exec(p))) {
      const chatId = m[1]!;
      const take = Number(q.get('Take'));
      if (!(take >= 1 && take <= 250) || q.get('Direction') !== 'TakeAfter' || q.get('IncludeMetadata') !== 'false') {
        return json(res, { error: 'bad relative-messages query' }, 400);
      }
      const all = world.messages[chatId];
      if (!all) return json(res, { error: 'not found' }, 404);
      const from = Date.parse(q.get('FromEventUTC') ?? '');
      const list = [...all]
        .sort((a, b) => Date.parse(String(a.eventAtUTC)) - Date.parse(String(b.eventAtUTC)))
        .filter((x) => Date.parse(String(x.eventAtUTC)) >= from) // inclusive
        .slice(0, take);
      if (world.marksRead === chatId) {
        const chat = world.chats.find((c) => c.id === chatId);
        if (chat) Object.assign(chat, { totalUnread: 0, lastMessage: { ...(chat.lastMessage as Obj), messageState: 'Read' } });
      }
      return json(res, { hasMessagesBeforeAllowedOrganizationPlan: world.planLimited, messages: list });
    }
    return json(res, { error: 'not found' }, 404);
  }

  return {
    world,
    requests,
    faults,
    stats,
    baseUrl: `${origin}/api`,
    fileUrl,
    /** What must never happen (§3, §5, §14): a non-GET, read/unread/pin, a chat or message detail, a token on a file link. */
    problems(): string[] {
      return requests.flatMap((r) => {
        const out: string[] = [];
        if (r.method !== 'GET') out.push(`${r.method} ${r.path}`);
        if (/\/(read|unread|pin)\/?$/.test(r.path)) out.push(`read/unread/pin ${r.path}`);
        if (/^\/api\/v1\/chats\/[^/]+\/$/.test(r.path) || r.path.startsWith('/api/v1/messages/')) out.push(`detail ${r.path}`);
        if (r.path.startsWith('/s3/') && r.auth !== null) out.push(`Authorization on ${r.path}`);
        return out;
      });
    },
    calls: (path: RegExp) => requests.filter((r) => path.test(r.path)),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export type FakeUmbler = Awaited<ReturnType<typeof startFakeUmbler>>;
```

- [ ] **Step 2: Write the failing test**

Create `server/test/importer/client.test.ts`:

```ts
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FILE_MAX_BYTES, UmblerError, createUmblerClient, isGone, type UmblerClient } from '../../src/importer/umbler.js';
import { ORG, PDF, startFakeUmbler, type FakeUmbler } from '../fakes/umbler-api.js';

let fake: FakeUmbler;
let sleeps: number[];
let client: UmblerClient;
const q = { organizationId: ORG };
const waits = () => sleeps.filter((ms) => ms >= 1000); // without the 100 ms spacing

beforeEach(async () => {
  fake = await startFakeUmbler();
  sleeps = [];
  client = createUmblerClient({ token: 'tok-teste', baseUrl: fake.baseUrl, sleep: async (ms) => void sleeps.push(ms) });
});
afterEach(async () => {
  expect(fake.problems()).toEqual([]);
  await fake.close();
});

describe('Umbler client (spec 2026-10-21 importar-umbler §9.4)', () => {
  it('sends the Bearer token and the query, fills the route template, and keeps 100 ms between calls (fake clock)', async () => {
    let now = 0;
    const spaced: number[] = [];
    const timed = createUmblerClient({
      token: 'tok-teste', baseUrl: fake.baseUrl, now: () => now,
      sleep: async (ms) => {
        spaced.push(ms);
        now += ms;
      },
    });
    await timed.get('/v1/sectors/', q);
    await timed.get('/v1/quick-answers/{id}/', q, { id: 'QA1' });
    now += 30;
    await timed.get('/v1/channels/', q);
    expect(spaced).toEqual([100, 70]);
    expect(fake.requests.map((r) => [r.path, r.auth, r.query.get('organizationId')])).toEqual([
      ['/api/v1/sectors/', 'Bearer tok-teste', ORG],
      ['/api/v1/quick-answers/QA1/', 'Bearer tok-teste', ORG],
      ['/api/v1/channels/', 'Bearer tok-teste', ORG],
    ]);
  });

  it('429: waits Retry-After when it comes, else 5, 10, 20, 40, 60, 60, 60 s, and stops at the 8th refusal', async () => {
    fake.faults.push({ path: /\/sectors\/$/, status: 429, retryAfter: '7' });
    await expect(client.get('/v1/sectors/', q)).resolves.toHaveLength(3);
    expect(waits()).toEqual([7000]);

    sleeps.length = 0;
    fake.faults.push({ path: /\/tags\/$/, status: 429, times: 8 });
    const err = await client.get('/v1/tags/', q).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UmblerError);
    expect(err).toMatchObject({ code: 'umbler_429', status: 429, route: '/v1/tags/' });
    expect(waits()).toEqual([5000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
  });

  it('401 and 403 stop at once with umbler_token', async () => {
    fake.faults.push({ path: /\/sectors\/$/, status: 401 }, { path: /\/channels\/$/, status: 403 });
    await expect(client.get('/v1/sectors/', q)).rejects.toMatchObject({ code: 'umbler_token', status: 401 });
    await expect(client.get('/v1/channels/', q)).rejects.toMatchObject({ code: 'umbler_token', status: 403 });
    expect(fake.requests).toHaveLength(2);
    expect(waits()).toEqual([]);
  });

  it('5xx: one more try after 2, 10 and 30 s, then umbler_unavailable; a 500 then 200 goes on', async () => {
    fake.faults.push({ path: /\/sectors\/$/, status: 500 });
    await expect(client.get('/v1/sectors/', q)).resolves.toHaveLength(3);
    expect(waits()).toEqual([2000]);

    sleeps.length = 0;
    fake.faults.push({ path: /\/channels\/$/, status: 503, times: 4 });
    await expect(client.get('/v1/channels/', q)).rejects.toMatchObject({ code: 'umbler_unavailable', status: 503 });
    expect(waits()).toEqual([2000, 10_000, 30_000]);
  });

  it("never follows a redirect (redirect: 'error'): the token stays at app-utalk", async () => {
    fake.faults.push({ path: /\/sectors\/$/, status: 302, location: `${fake.baseUrl}/elsewhere`, times: 4 });
    await expect(client.get('/v1/sectors/', q)).rejects.toMatchObject({ code: 'umbler_unavailable', status: null });
    expect(fake.calls(/elsewhere/)).toEqual([]);
  });

  it('400 stops with umbler_400; a 404 is the same code, and isGone tells the one-item callers', async () => {
    fake.faults.push({ path: /\/sectors\/$/, status: 400 });
    await expect(client.get('/v1/sectors/', q)).rejects.toMatchObject({ code: 'umbler_400', status: 400 });
    const err = await client.get('/v1/contacts/{id}/notes/', q, { id: 'NOPE' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'umbler_400', status: 404 });
    expect(isGone(err)).toBe(true);
    expect(String((err as Error).message)).toBe('GET /v1/contacts/{id}/notes/ → 404'); // the template, never the id
  });

  it('files: no Authorization; 403/404/410 and over 64 MB are gone at once; 5xx is retried after 1, 5 and 25 s', async () => {
    await expect(client.file(fake.fileUrl('procuracao.pdf'))).resolves.toEqual({ data: PDF, mime: 'application/pdf' });

    fake.world.files['proibido.pdf'] = { body: PDF, mime: 'application/pdf', status: 403 };
    fake.world.files['grande.bin'] = { body: Buffer.alloc(FILE_MAX_BYTES + 1), mime: 'application/octet-stream' };
    await expect(client.file(fake.fileUrl('proibido.pdf'))).resolves.toEqual({ failed: 'gone' });
    await expect(client.file(fake.fileUrl('sumiu.pdf'))).resolves.toEqual({ failed: 'gone' });
    await expect(client.file(fake.fileUrl('grande.bin'))).resolves.toEqual({ failed: 'gone' });
    expect(waits()).toEqual([]);

    fake.faults.push({ path: /^\/s3\/procuracao/, status: 500, times: 4 });
    await expect(client.file(fake.fileUrl('procuracao.pdf'))).resolves.toEqual({ failed: 'temporary' });
    expect(waits()).toEqual([1000, 5000, 25_000]);
    fake.faults.push({ path: /^\/s3\/procuracao/, status: 502 });
    await expect(client.file(fake.fileUrl('procuracao.pdf'))).resolves.toMatchObject({ mime: 'application/pdf' });
    expect(fake.calls(/^\/s3\//).every((r) => r.auth === null)).toBe(true);
  });
});

describe('server/src/importer (spec §3)', () => {
  it('calls Umbler with GET only: no method, no read/unread/pin, no chat or message detail route', async () => {
    const dir = fileURLToPath(new URL('../../src/importer', import.meta.url));
    const files = (await readdir(dir)).filter((f) => f.endsWith('.ts'));
    const offenders: string[] = [];
    for (const f of files) {
      const text = await readFile(join(dir, f), 'utf8');
      const bad = [
        /\bmethod\s*:/, // fetch(…, { method }) – the client has no method parameter
        /['"`](POST|PUT|PATCH|DELETE)['"`]/,
        /\/(read|unread|pin|redownload-media|transcribe|favorite)\//,
        /['"`]\/v1\/chats\/\{\w+\}\/['"`]/, // GET /v1/chats/{id}/ is what the Umbler app calls to open a chat (§3)
        /['"`]\/v1\/messages\//,
      ];
      for (const re of bad) if (re.test(text)) offenders.push(`${f}: ${re}`);
    }
    expect(files).toContain('umbler.ts');
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm test -w server -- test/importer/client.test.ts`
Expected: FAIL. `createUmblerClient`, `UmblerError`, `isGone` and `FILE_MAX_BYTES` are not exported by `umbler.ts`, so the file does not load.

- [ ] **Step 4: Replace the client**

In `server/src/importer/umbler.ts`, replace

```ts
import { setTimeout as delay } from 'node:timers/promises';
import { tagColorHex } from '@talk/shared';
```

with

```ts
import { setTimeout as delay } from 'node:timers/promises';
import { tagColorHex, type UmblerImportError } from '@talk/shared';
```

replace

```ts
import { saveMedia } from '../messages/media.js';
```

with

```ts
import { baseMime, saveMedia } from '../messages/media.js';
```

replace the constants

```ts
export const UMBLER_API = 'https://app-utalk.umbler.com/api';
// ponytail: fixed spacing = the documented 100 req / 5 s; a token bucket only if imports get too slow.
const MIN_GAP_MS = 50;
const RETRY_AFTER_MS = 5_000;
const MAX_ATTEMPTS = 4;
const PAGE_SIZE = 50;
```

with

```ts
export const UMBLER_API = 'https://app-utalk.umbler.com/api';
/** §9.4: one call at a time, at least 100 ms apart (10/s, half the documented 100 GET per 5 s). */
const MIN_GAP_MS = 100;
const CALL_TIMEOUT_MS = 30_000;
/** §9.4 429: Retry-After when it comes, else these waits; the 8th refusal stops. */
const WAITS_429_S = [5, 10, 20, 40, 60, 60, 60];
/** §9.4 5xx, network error, timeout: one more try after each wait, then stop. */
const WAITS_DOWN_MS = [2_000, 10_000, 30_000];
/** §7.8 file links: one more try after each wait; 60 s per try; at most 64 MB (the send limit). */
const FILE_WAITS_MS = [1_000, 5_000, 25_000];
const FILE_TIMEOUT_MS = 60_000;
export const FILE_MAX_BYTES = 64 * 1024 * 1024;
export const PAGE_SIZE = 50;
```

replace the client and `getAll`

```ts
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
```

with

```ts
/** A stop of §9.4. `route` is the template ("/v1/chats/{chatId}/relative-messages/"): never an id, a value or the token. */
export class UmblerError extends Error {
  constructor(
    public code: UmblerImportError,
    public status: number | null = null,
    public route: string | null = null,
  ) {
    super(route ? `GET ${route} → ${status ?? 'sem resposta'}` : code);
    this.name = 'UmblerError';
  }
}

/** §9.4: a note or chat deleted in Umbler during the copy is skipped (and counted) by the one-item callers. */
export const isGone = (err: unknown): boolean => err instanceof UmblerError && err.status === 404;

export type Query = Record<string, string | number | boolean | string[]>;
/** A downloaded file, or why not: 'gone' (403/404/410, too big) never comes back; 'temporary' failed every try. */
export type UmblerFile = { data: Buffer; mime: string } | { failed: 'gone' | 'temporary' };

export interface UmblerClient {
  /** GET only: there is no method parameter (§3). `route` is a template whose {names} come from `params`. */
  get<T>(route: string, query?: Query, params?: Record<string, string>): Promise<T>;
  /** A file link (S3): no Authorization header, so the token never leaves app-utalk (§7.8). */
  file(url: string): Promise<UmblerFile>;
}

export interface UmblerClientOpts {
  token: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<unknown>;
  now?: () => number;
}

export function createUmblerClient(opts: UmblerClientOpts): UmblerClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? delay;
  const now = opts.now ?? Date.now;
  const base = opts.baseUrl ?? UMBLER_API;
  let last = Number.NEGATIVE_INFINITY;

  async function call(url: URL): Promise<Response | null> {
    const wait = last + MIN_GAP_MS - now();
    if (wait > 0) await sleep(wait);
    last = now();
    try {
      return await fetchImpl(url, {
        headers: { Authorization: `Bearer ${opts.token}`, Accept: 'application/json' },
        redirect: 'error', // the token never follows a redirect
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch {
      return null; // network error, timeout or a redirect
    }
  }

  async function get<T>(route: string, query: Query = {}, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(base + route.replace(/\{(\w+)\}/g, (_m, k: string) => encodeURIComponent(params[k] ?? '')));
    for (const [k, v] of Object.entries(query)) for (const x of [v].flat()) url.searchParams.append(k, String(x));
    for (let limited = 0, down = 0; ; ) {
      const res = await call(url);
      if (res?.ok) return (await res.json()) as T;
      await res?.body?.cancel();
      const status = res?.status ?? null;
      if (status === 429) {
        if (limited === WAITS_429_S.length) throw new UmblerError('umbler_429', status, route);
        const retryAfter = Number(res?.headers.get('retry-after'));
        await sleep((retryAfter > 0 ? retryAfter : WAITS_429_S[limited]!) * 1000);
        limited += 1;
      } else if (status === 401 || status === 403) {
        throw new UmblerError('umbler_token', status, route);
      } else if (status === null || status >= 500) {
        if (down === WAITS_DOWN_MS.length) throw new UmblerError('umbler_unavailable', status, route);
        await sleep(WAITS_DOWN_MS[down]!);
        down += 1;
      } else {
        throw new UmblerError('umbler_400', status, route); // 400 (our query), 404 (isGone) and any other 4xx
      }
    }
  }

  async function fileOnce(url: string): Promise<UmblerFile> {
    if (!/^https?:\/\//.test(url)) return { failed: 'gone' };
    let res: Response;
    try {
      res = await fetchImpl(url, { signal: AbortSignal.timeout(FILE_TIMEOUT_MS) });
    } catch {
      return { failed: 'temporary' };
    }
    if (!res.ok || Number(res.headers.get('content-length')) > FILE_MAX_BYTES) {
      await res.body?.cancel();
      return { failed: res.status >= 500 ? 'temporary' : 'gone' };
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for await (const chunk of res.body ?? []) {
        size += chunk.length;
        if (size > FILE_MAX_BYTES) return { failed: 'gone' }; // leaving the loop cancels the download
        chunks.push(chunk);
      }
    } catch {
      return { failed: 'temporary' }; // the timeout or the connection dropped mid-file
    }
    return { data: Buffer.concat(chunks), mime: baseMime(res.headers.get('content-type') ?? '') || 'application/octet-stream' };
  }

  return {
    get,
    async file(url) {
      for (let attempt = 0; ; attempt += 1) {
        const got = await fileOnce(url);
        if (!('failed' in got) || got.failed === 'gone' || attempt === FILE_WAITS_MS.length) return got;
        await sleep(FILE_WAITS_MS[attempt]!);
      }
    },
  };
}

/** §4 Skip/Take pages (Take=50) until the first empty one. `count`: the first page asks for page.totalItems (Analisar). */
export async function* pages<T>(
  client: UmblerClient,
  route: string,
  query: Query,
  count = false,
): AsyncGenerator<{ items: T[]; total: number | null }> {
  for (let skip = 0; ; ) {
    const first = count && skip === 0;
    const page = await client.get<{ page?: { totalItems?: number }; items?: T[] }>(route, {
      ...query,
      Skip: skip,
      Take: PAGE_SIZE,
      ...(first ? { Behavior: 'CountAllAndGetSlice' } : {}),
    });
    const items = page.items ?? [];
    if (items.length === 0) return;
    yield { items, total: first ? (page.page?.totalItems ?? null) : null };
    skip += items.length;
  }
}

export async function getAll<T>(client: UmblerClient, route: string, query: Query): Promise<T[]> {
  const all: T[] = [];
  for await (const page of pages<T>(client, route, query)) all.push(...page.items);
  return all;
}
```

and, in `fetchUmbler`, replace

```ts
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
```

with

```ts
async function fetchUmbler(deps: ImportDeps) {
  const client = createUmblerClient({ token: deps.token, baseUrl: deps.baseUrl, fetchImpl: deps.fetchImpl, sleep: deps.sleep });
  const get = client.get;
  const me = await get<UmblerMe>('/v1/members/me/', {});
  // ponytail: first organization of the token; the office has exactly one.
  const org = me.organizations?.[0];
  if (!org) throw new Error('O token do Umbler não pertence a nenhuma organização');
  const q: Query = { organizationId: org.id };

  const sectorList = await get<UmblerSector[]>('/v1/sectors/', q);
  const tagList = await getAll<UmblerTag>(client, '/v1/tags/', q);
  const fieldDefs = await get<UmblerFieldDef[]>('/v1/custom-field-definitions/', q);
  const contactList = await getAll<UmblerContact>(client, '/v1/contacts/', {
    ...q,
    includeGroups: false,
    includeCustomFields: fieldDefs.map((d) => d.id),
  });
  const qaList = await getAll<{ id: string }>(client, '/v1/quick-answers/', { ...q, viewFrom: 'Everyone' });
  const qaDetails: UmblerQuickAnswer[] = [];
  for (const { id } of qaList) qaDetails.push(await get<UmblerQuickAnswer>('/v1/quick-answers/{id}/', q, { id }));
```

- [ ] **Step 5: Run the tests and the type check**

Run: `npm test -w server -- test/importer/client.test.ts test/importer/umbler.test.ts`
Expected: PASS. The CLI importer's test still passes through the new client: the first 429 still waits 5 s.

Run: `npm run typecheck -w server`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/importer/umbler.ts server/test/fakes/umbler-api.ts server/test/importer/client.test.ts
git commit -m "feat(server): GET-only Umbler client with the spec pace and waits, and a fake Umbler API for tests" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Catalog phase (sectors, tags, fields, attendants, quick answers) and the end of the CLI importer

`umbler.ts` is rewritten around `ImportRun`:
- the client of Task 2 stays byte for byte;
- `importUmbler`, `fetchUmbler`, `ImportDeps`, `ImportReport` and the old `importContacts` go, and so do `cli.ts` and the `import:umbler` script (spec §3). Task 4 brings contacts back as a phase;
- the catalog functions become phase 1 (§7.1, §7.2): names compare without case, the admin's sector mapping wins, and attendants are linked by e-mail or created inactive;
- a quick answer whose `organizationMember` is an active user becomes `visibility='owner'`;
- the quick answers' details and attachments are fetched **before** the one transaction, because no network call may happen inside it (§11).

The transaction also stores the catalog maps in `progress.maps` and moves the row to phase `contacts`. The catalog counters are not idempotent, so the catalog must never run twice.

The old test file becomes the catalog test over the fake API (§14: "o teste atual de `umbler.test.ts` passa a usar este servidor"). `world.ts` builds an `ImportRun` the way `job.ts` will (Task 10). Its row is `analyzed`, not active, so one test can make several runs.

**Files:**
- Modify (whole file): `server/src/importer/umbler.ts`
- Delete: `server/src/importer/cli.ts`
- Modify: `server/package.json` (the `import:umbler` script)
- Create: `server/test/importer/world.ts`
- Test: `server/test/importer/umbler.test.ts` (whole file replaced)

**Interfaces:**
- Consumes:
  - Task 1: `UmblerCatalogMaps`, `umblerImports`, `UmblerAnalysisDto`, `UmblerMappingDto`, `UmblerProgressDto`, `emptyUmblerCounts`;
  - Task 2: the client;
  - existing: `getDefaultSectorId`, `hashPassword`, `convertUmblerVariables`, `saveMedia`, `tagColorHex`.
- Produces:
  - the `Umbler*` types, `UmblerProgress`, `ImportRun`;
  - `Stopped`, `checkStop`, `saveProgress`, `maps`, `orgQuery`, `fold`, `validPhone`, `lidOf`, `FIELD_KINDS`;
  - `importCatalog`;
  - test world: `importWorld`, `testAnalysis`, `proposals`, `runFor`.

- [ ] **Step 1: Write the test world**

Create `server/test/importer/world.ts`:

```ts
import { emptyUmblerCounts, type UmblerAnalysisDto, type UmblerMappingDto } from '@talk/shared';
import { umblerImports } from '../../src/db/schema.js';
import { createUmblerClient, type ImportRun, type UmblerClient } from '../../src/importer/umbler.js';
import { ORG, startFakeUmbler, type FakeUmbler } from '../fakes/umbler-api.js';
import { makeTestCtx, seedBasics } from '../helpers.js';

// The Umbler import tests' world (spec 2026-10-21 importar-umbler §14): a test app context, the seeded office and the fake
// Umbler API. Every test ends with expect(w.fake.problems()).toEqual([]) and w.fake.close().

export interface World {
  ctx: Awaited<ReturnType<typeof makeTestCtx>>;
  s: Awaited<ReturnType<typeof seedBasics>>;
  fake: FakeUmbler;
  client: UmblerClient;
  sleeps: number[];
  free: { bytes: number };
}

export async function importWorld(): Promise<World> {
  const ctx = await makeTestCtx();
  const s = await seedBasics(ctx);
  const fake = await startFakeUmbler();
  const sleeps: number[] = [];
  const client = createUmblerClient({ token: 'tok-teste', baseUrl: fake.baseUrl, sleep: async (ms) => void sleeps.push(ms) });
  return { ctx, s, fake, client, sleeps, free: { bytes: 100 * 1024 ** 3 } };
}

/** What "Analisar" proposes for the fake's default world (the analysis test checks the real one against it). */
export function testAnalysis(w: World, over: Partial<UmblerAnalysisDto> = {}): UmblerAnalysisDto {
  return {
    organizationId: ORG,
    organization: 'Escritório Teste',
    contacts: { total: 4, existing: 0, withoutAddress: 1 },
    chats: { open: 0, waiting: 0, closed: 0, from: null, to: null },
    channels: [
      {
        id: 'CH_WA', name: 'WhatsApp Umbler', type: 'OrganizationBrokerWhatsappChannelReferenceModel', phone: '5565999990000',
        whatsapp: true, chats: 0, proposal: w.s.channelId,
      },
      { id: 'CH_WEB', name: 'Site', type: 'OrganizationWebsiteWidgetChannelReferenceModel', phone: null, whatsapp: false, chats: 0, proposal: 'none' },
    ],
    sectors: [
      { id: 'SEC1', name: 'Atendimento', proposal: w.s.defaultSector },
      { id: 'SEC2', name: 'FINANCEIRO', proposal: w.s.sectorA },
      { id: 'SEC3', name: 'Trabalhista', proposal: 'create' },
    ],
    members: [
      { id: 'M_ANA', name: 'Ana Umbler', email: 'ANA@teste.local', active: true, chats: 0, proposal: w.s.agentA.id },
      { id: 'M_CARLA', name: 'Carla Antiga', email: 'carla@antigo.test', active: false, chats: 0, proposal: 'create' },
    ],
    tags: { new: 2, existing: 0 },
    customFields: { new: 2, existing: 0, unsupported: ['Aceitou termos'] },
    quickAnswers: { new: 2, existing: 0 },
    readTest: 'not_done',
    warnings: [],
    ...over,
  };
}

export function proposals(a: UmblerAnalysisDto): UmblerMappingDto {
  return {
    channels: Object.fromEntries(a.channels.map((c) => [c.id, c.proposal])),
    sectors: Object.fromEntries(a.sectors.map((s) => [s.id, s.proposal])),
    members: Object.fromEntries(a.members.map((m) => [m.id, m.proposal])),
  };
}

/**
 * An ImportRun as job.ts builds it, over a new umbler_imports row (the tests call the phases directly). The row is
 * 'analyzed', not active, so one test can make several runs (umbler_imports_one_active).
 */
export async function runFor(w: World, opts: { analysis?: UmblerAnalysisDto; mapping?: UmblerMappingDto } = {}): Promise<ImportRun> {
  const analysis = opts.analysis ?? testAnalysis(w);
  const mapping = opts.mapping ?? proposals(analysis);
  const [row] = await w.ctx.db
    .insert(umblerImports)
    .values({ state: 'analyzed', phase: 'catalog', analysis, mapping, startedAt: new Date() })
    .returning();
  return {
    ctx: w.ctx, client: w.client, importId: row!.id, org: ORG, analysis, mapping,
    progress: { ...emptyUmblerCounts(), done: 0, total: 0, chatsRead: 0 },
    signal: new AbortController().signal,
    sleep: async (ms) => void w.sleeps.push(ms),
    freeBytes: async () => w.free.bytes,
  };
}
```

- [ ] **Step 2: Write the failing test**

Replace the whole content of `server/test/importer/umbler.test.ts` with:

```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyPassword } from '../../src/auth/password.js';
import { customFields, quickAnswers, sectors, tags, umblerImports, userSectors, users } from '../../src/db/schema.js';
import { importCatalog } from '../../src/importer/umbler.js';
import { convertUmblerVariables } from '../../src/messages/quick-answers.js';
import { PDF } from '../fakes/umbler-api.js';
import { TEST_PASSWORD, loginAs, makeTestApp } from '../helpers.js';
import { importWorld, proposals, runFor, testAnalysis, type World } from './world.js';

let w: World;
beforeEach(async () => {
  w = await importWorld();
});
afterEach(async () => {
  expect(w.fake.problems()).toEqual([]);
  await w.fake.close();
});

const userByEmail = async (email: string) => (await w.ctx.db.select().from(users).where(eq(users.email, email)))[0];

describe('catalog phase (spec 2026-10-21 importar-umbler §7.1, §7.2)', () => {
  it('matches sectors by name without case, creates tags and fields, and moves to contacts in the same transaction', async () => {
    const run = await runFor(w);
    await importCatalog(run);

    const sectorRows = await w.ctx.db.select().from(sectors);
    expect(sectorRows.map((s) => s.name).sort()).toEqual(['Atendimento', 'Financeiro', 'Jurídico', 'Trabalhista']);
    const trabalhista = sectorRows.find((s) => s.name === 'Trabalhista')!;
    expect(run.progress.sectors).toEqual({ created: 1, existing: 2 });
    expect(run.progress.maps?.sectors).toEqual({ SEC1: w.s.defaultSector, SEC2: w.s.sectorA, SEC3: trabalhista.id });

    const tagRows = await w.ctx.db.select().from(tags).orderBy(tags.position);
    expect(tagRows.map(({ name, emoji, color }) => ({ name, emoji, color }))).toEqual([
      { name: 'Cliente', emoji: '⭐', color: '#ca8a04' },
      { name: 'Prospecção', emoji: null, color: '#2563eb' },
    ]);
    const fieldRows = await w.ctx.db.select().from(customFields).orderBy(customFields.position);
    expect(fieldRows.map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: 'CPF', kind: 'cpf' },
      { name: 'Nascimento', kind: 'date' },
    ]);
    expect(run.progress.customFields).toEqual({ created: 2, existing: 0, unsupported: ['Aceitou termos'] });

    const [row] = await w.ctx.db.select().from(umblerImports).where(eq(umblerImports.id, run.importId));
    expect(row!.phase).toBe('contacts');
    expect(row!.progress?.maps?.tags).toEqual({ TAG1: tagRows[0]!.id, TAG2: tagRows[1]!.id });
  });

  it('attendants: the same e-mail links the user unchanged; "Criar usuário inativo" makes an agent nobody can log in as (§7.2)', async () => {
    const run = await runFor(w);
    await importCatalog(run);

    const carla = (await userByEmail('carla@antigo.test'))!;
    expect(carla).toMatchObject({ name: 'Carla Antiga', role: 'agent', active: false });
    expect(await w.ctx.db.$count(userSectors, eq(userSectors.userId, carla.id))).toBe(0);
    expect(await verifyPassword(carla.passwordHash, TEST_PASSWORD)).toBe(false);
    expect(run.progress.maps?.members).toEqual({ M_ANA: { id: w.s.agentA.id, active: true }, M_CARLA: { id: carla.id, active: false } });
    expect(run.progress.members).toEqual({ linked: 1, createdInactive: 1, none: 0 });
    expect(await userByEmail('ana@teste.local')).toMatchObject({ name: 'Ana Financeiro', role: 'agent', active: true });

    const { app } = await makeTestApp(w.ctx);
    await expect(loginAs(app, 'carla@antigo.test')).rejects.toThrow(/401/); // nobody knows the password
    await app.close();
  });

  it('"Sem atendente" maps nobody and creates nobody', async () => {
    const analysis = testAnalysis(w);
    const run = await runFor(w, { analysis, mapping: { ...proposals(analysis), members: { M_ANA: 'none', M_CARLA: 'none' } } });
    await importCatalog(run);
    expect(run.progress.maps?.members).toEqual({});
    expect(run.progress.members).toEqual({ linked: 0, createdInactive: 0, none: 2 });
    expect(await userByEmail('carla@antigo.test')).toBeUndefined();
  });

  it("quick answers: variables converted, the attachment saved, and an active user's \"Apenas para mim\" stays that user's", async () => {
    const run = await runFor(w);
    await importCatalog(run);

    const [welcome] = await w.ctx.db.select().from(quickAnswers).where(eq(quickAnswers.name, 'Boas-vindas'));
    const converted = convertUmblerVariables('Olá {{1}}, aqui é {{2}}.', [
      { defaultValue: 'Contato.PrimeiroNome' },
      { defaultValue: 'Valor fixo qualquer' },
    ]);
    expect(welcome).toMatchObject({ body: converted.body, visibility: 'all', ownerId: null, attachmentPath: null });
    const [proxy] = await w.ctx.db.select().from(quickAnswers).where(eq(quickAnswers.name, 'Procuração'));
    expect(proxy).toMatchObject({ visibility: 'owner', ownerId: w.s.agentA.id });
    expect(await readFile(join(w.ctx.config.mediaDir, proxy!.attachmentPath!))).toEqual(PDF);
    expect(run.progress.quickAnswers).toEqual({ created: 2, existing: 0, unmappedVariables: ['Boas-vindas'], attachmentErrors: [] });
    expect(w.fake.calls(/^\/s3\//).map((r) => r.auth)).toEqual([null]); // the token never leaves app-utalk
  });

  it('keeps what is already here (any case); a second catalog creates nothing and downloads nothing', async () => {
    await w.ctx.db.insert(tags).values({ name: 'cliente', color: '#000000' });
    await w.ctx.db.insert(quickAnswers).values({ name: 'BOAS-VINDAS', body: 'Olá!' });
    const first = await runFor(w);
    await importCatalog(first);
    expect(first.progress.tags).toEqual({ created: 1, existing: 1 });
    expect(first.progress.quickAnswers).toMatchObject({ created: 1, existing: 1 });

    const second = await runFor(w);
    await importCatalog(second);
    expect(second.progress).toMatchObject({
      sectors: { created: 0, existing: 3 },
      tags: { created: 0, existing: 2 },
      customFields: { created: 0, existing: 2 },
      members: { linked: 2, createdInactive: 0, none: 0 },
      quickAnswers: { created: 0, existing: 2 },
    });
    expect(w.fake.calls(/^\/s3\//)).toHaveLength(1);
    expect(w.fake.calls(/\/quick-answers\/QA\d\/$/).map((r) => r.path)).toEqual(['/api/v1/quick-answers/QA2/']);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm test -w server -- test/importer/umbler.test.ts`
Expected: FAIL. `importCatalog` is not exported by `umbler.ts`.

- [ ] **Step 4: Rewrite `umbler.ts` around the import run and phase 1**

The section `// ---------- the Umbler API` is Task 2's code, unchanged. `contactFieldValues`, `contactNotes`, `contactTags`, `contacts`, `umblerMap`, `and`, `inArray`, `isNull`, `mergeLidPairs`, `toAddress` and `fieldValue` are imported or defined here for Task 4, which appends the contacts and notes phases.

Replace the whole content of `server/src/importer/umbler.ts` with:

```ts
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  tagColorHex, type UmblerAnalysisDto, type UmblerImportError, type UmblerImportPhase, type UmblerMappingDto, type UmblerProgressDto,
} from '@talk/shared';
import { hashPassword } from '../auth/password.js';
import type { AppCtx } from '../ctx.js';
import type { Db, Tx } from '../db/client.js';
import {
  contactFieldValues, contactNotes, contactTags, contacts, customFields, quickAnswers, sectors, tags, umblerImports, umblerMap, users,
  type UmblerCatalogMaps,
} from '../db/schema.js';
import { mergeLidPairs } from '../history/merge.js';
import { getDefaultSectorId } from '../inbox/chats.js';
import { baseMime, saveMedia } from '../messages/media.js';
import { convertUmblerVariables } from '../messages/quick-answers.js';
import { lidFromJid, normalizePhoneBR } from '../whatsapp/phone.js';

// ---------- the Umbler API: GET only (spec 2026-10-21 importar-umbler §3, §9.4) ----------

export const UMBLER_API = 'https://app-utalk.umbler.com/api';
/** §9.4: one call at a time, at least 100 ms apart (10/s, half the documented 100 GET per 5 s). */
const MIN_GAP_MS = 100;
const CALL_TIMEOUT_MS = 30_000;
/** §9.4 429: Retry-After when it comes, else these waits; the 8th refusal stops. */
const WAITS_429_S = [5, 10, 20, 40, 60, 60, 60];
/** §9.4 5xx, network error, timeout: one more try after each wait, then stop. */
const WAITS_DOWN_MS = [2_000, 10_000, 30_000];
/** §7.8 file links: one more try after each wait; 60 s per try; at most 64 MB (the send limit). */
const FILE_WAITS_MS = [1_000, 5_000, 25_000];
const FILE_TIMEOUT_MS = 60_000;
export const FILE_MAX_BYTES = 64 * 1024 * 1024;
export const PAGE_SIZE = 50;

/** A stop of §9.4. `route` is the template ("/v1/chats/{chatId}/relative-messages/"): never an id, a value or the token. */
export class UmblerError extends Error {
  constructor(
    public code: UmblerImportError,
    public status: number | null = null,
    public route: string | null = null,
  ) {
    super(route ? `GET ${route} → ${status ?? 'sem resposta'}` : code);
    this.name = 'UmblerError';
  }
}

/** §9.4: a note or chat deleted in Umbler during the copy is skipped (and counted) by the one-item callers. */
export const isGone = (err: unknown): boolean => err instanceof UmblerError && err.status === 404;

export type Query = Record<string, string | number | boolean | string[]>;
/** A downloaded file, or why not: 'gone' (403/404/410, too big) never comes back; 'temporary' failed every try. */
export type UmblerFile = { data: Buffer; mime: string } | { failed: 'gone' | 'temporary' };

export interface UmblerClient {
  /** GET only: there is no method parameter (§3). `route` is a template whose {names} come from `params`. */
  get<T>(route: string, query?: Query, params?: Record<string, string>): Promise<T>;
  /** A file link (S3): no Authorization header, so the token never leaves app-utalk (§7.8). */
  file(url: string): Promise<UmblerFile>;
}

export interface UmblerClientOpts {
  token: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<unknown>;
  now?: () => number;
}

export function createUmblerClient(opts: UmblerClientOpts): UmblerClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? delay;
  const now = opts.now ?? Date.now;
  const base = opts.baseUrl ?? UMBLER_API;
  let last = Number.NEGATIVE_INFINITY;

  async function call(url: URL): Promise<Response | null> {
    const wait = last + MIN_GAP_MS - now();
    if (wait > 0) await sleep(wait);
    last = now();
    try {
      return await fetchImpl(url, {
        headers: { Authorization: `Bearer ${opts.token}`, Accept: 'application/json' },
        redirect: 'error', // the token never follows a redirect
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch {
      return null; // network error, timeout or a redirect
    }
  }

  async function get<T>(route: string, query: Query = {}, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(base + route.replace(/\{(\w+)\}/g, (_m, k: string) => encodeURIComponent(params[k] ?? '')));
    for (const [k, v] of Object.entries(query)) for (const x of [v].flat()) url.searchParams.append(k, String(x));
    for (let limited = 0, down = 0; ; ) {
      const res = await call(url);
      if (res?.ok) return (await res.json()) as T;
      await res?.body?.cancel();
      const status = res?.status ?? null;
      if (status === 429) {
        if (limited === WAITS_429_S.length) throw new UmblerError('umbler_429', status, route);
        const retryAfter = Number(res?.headers.get('retry-after'));
        await sleep((retryAfter > 0 ? retryAfter : WAITS_429_S[limited]!) * 1000);
        limited += 1;
      } else if (status === 401 || status === 403) {
        throw new UmblerError('umbler_token', status, route);
      } else if (status === null || status >= 500) {
        if (down === WAITS_DOWN_MS.length) throw new UmblerError('umbler_unavailable', status, route);
        await sleep(WAITS_DOWN_MS[down]!);
        down += 1;
      } else {
        throw new UmblerError('umbler_400', status, route); // 400 (our query), 404 (isGone) and any other 4xx
      }
    }
  }

  async function fileOnce(url: string): Promise<UmblerFile> {
    if (!/^https?:\/\//.test(url)) return { failed: 'gone' };
    let res: Response;
    try {
      res = await fetchImpl(url, { signal: AbortSignal.timeout(FILE_TIMEOUT_MS) });
    } catch {
      return { failed: 'temporary' };
    }
    if (!res.ok || Number(res.headers.get('content-length')) > FILE_MAX_BYTES) {
      await res.body?.cancel();
      return { failed: res.status >= 500 ? 'temporary' : 'gone' };
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for await (const chunk of res.body ?? []) {
        size += chunk.length;
        if (size > FILE_MAX_BYTES) return { failed: 'gone' }; // leaving the loop cancels the download
        chunks.push(chunk);
      }
    } catch {
      return { failed: 'temporary' }; // the timeout or the connection dropped mid-file
    }
    return { data: Buffer.concat(chunks), mime: baseMime(res.headers.get('content-type') ?? '') || 'application/octet-stream' };
  }

  return {
    get,
    async file(url) {
      for (let attempt = 0; ; attempt += 1) {
        const got = await fileOnce(url);
        if (!('failed' in got) || got.failed === 'gone' || attempt === FILE_WAITS_MS.length) return got;
        await sleep(FILE_WAITS_MS[attempt]!);
      }
    },
  };
}

/** §4 Skip/Take pages (Take=50) until the first empty one. `count`: the first page asks for page.totalItems (Analisar). */
export async function* pages<T>(
  client: UmblerClient,
  route: string,
  query: Query,
  count = false,
): AsyncGenerator<{ items: T[]; total: number | null }> {
  for (let skip = 0; ; ) {
    const first = count && skip === 0;
    const page = await client.get<{ page?: { totalItems?: number }; items?: T[] }>(route, {
      ...query,
      Skip: skip,
      Take: PAGE_SIZE,
      ...(first ? { Behavior: 'CountAllAndGetSlice' } : {}),
    });
    const items = page.items ?? [];
    if (items.length === 0) return;
    yield { items, total: first ? (page.page?.totalItems ?? null) : null };
    skip += items.length;
  }
}

export async function getAll<T>(client: UmblerClient, route: string, query: Query): Promise<T[]> {
  const all: T[] = [];
  for await (const page of pages<T>(client, route, query)) all.push(...page.items);
  return all;
}

// ---------- what we read (docs/umbler/utalk-openapi-v1.json; only the fields we map) ----------

export interface UmblerRef { id: string }
export interface UmblerMe {
  organizations?: Array<{
    id: string;
    name: string;
    permissions?: string[];
    allowedSectors?: { allSectorsEnable?: boolean } | null;
    allowedChannels?: { allChannelsEnable?: boolean } | null;
  }>;
}
export interface UmblerMember { _t: string; id: string; displayName?: string | null; emailAddress?: string | null; active?: boolean }
export interface UmblerOrganization { id: string; name: string; maxDaysMessageHistoric?: number | null; organizationMembers?: UmblerMember[] }
export interface UmblerChannel { _t: string; id: string; name: string; phoneNumber?: string | null }
export interface UmblerSector { id: string; name: string; default: boolean; order: number }
export interface UmblerTag { id: string; name: string; emoji?: string | null; color?: string | null; order: number }
export interface UmblerFieldDef { _t: string; id: string; name: string }
export interface UmblerContact {
  id: string;
  name?: string | null;
  phoneNumber?: string | null;
  lid?: string | null;
  email?: string | null;
  landline?: string | null;
  address?: Record<string, string | null> | null;
  isBlocked?: boolean;
  tags?: UmblerRef[];
  customFields?: Array<{ customFieldDefinitionId: string; value?: unknown }>;
}
export interface UmblerQuickAnswer {
  id: string;
  name: string;
  content?: string | null;
  variables?: Array<{ defaultValue?: string | null }>;
  attachment?: { url?: string | null; originalName?: string | null } | null;
  organizationMember?: UmblerRef | null;
}
export interface UmblerNote { id: string; content: string; pinned?: boolean; createdBy?: string | null; createdAtUTC: string }
export interface UmblerChat {
  id: string;
  createdAtUTC: string;
  contact: { id: string; name?: string | null; phoneNumber?: string | null; lid?: string | null };
  channel: { id: string; _t: string; name?: string | null; phoneNumber?: string | null };
  sector?: UmblerRef | null;
  organizationMember?: UmblerRef | null;
  tags?: UmblerRef[];
  private?: boolean;
  waiting?: boolean;
  waitingSinceUTC?: string | null;
  totalUnread?: number;
  closedAtUTC?: string | null;
  closedBy?: UmblerRef | null;
  redactReason?: string | null;
  lastMessage?: { id: string; source?: string; messageState?: string } | null;
}
export interface UmblerMessage {
  _t: string;
  id: string;
  eventAtUTC: string;
  source?: string;
  isPrivate?: boolean;
  messageType?: string;
  content?: string | null;
  prefix?: string | null;
  file?: {
    url?: string | null;
    contentType?: string | null;
    originalName?: string | null;
    originalSizeBytes?: number | null;
    caption?: string | null;
    failDownload?: boolean;
  } | null;
  sentByOrganizationMember?: UmblerRef | null;
  inReplyTo?: UmblerRef | null;
  messageState?: string;
  latestEdit?: { senderAtUTC?: string | null } | null;
  reactions?: Array<{ emoji: string; source?: string; eventAtUTC: string }>;
  location?: { latitude: string; longitude: string; name?: string | null; address?: string | null } | null;
  contacts?: Array<{ name?: string | null; phoneNumbers?: string[] }>;
}

// ---------- one running import ----------

export type UmblerProgress = UmblerProgressDto & { maps?: UmblerCatalogMaps };

/** What every phase reads, and the counters it adds to (saved with the page that changed them, §9.3). */
export interface ImportRun {
  ctx: AppCtx;
  client: UmblerClient;
  importId: string;
  org: string;
  analysis: UmblerAnalysisDto;
  mapping: UmblerMappingDto;
  progress: UmblerProgress;
  signal: AbortSignal;
  sleep: (ms: number) => Promise<unknown>;
  freeBytes: (dir: string) => Promise<number>;
}

/** Thrown between pages once the worker stops: the row stays 'running' and the next start resumes it (§9.3). */
export class Stopped extends Error {}
export function checkStop(run: ImportRun): void {
  if (run.signal.aborted) throw new Stopped();
}

/** Writes the counters (and the phase, when given); inside the page's transaction, so a restart never counts twice. */
export async function saveProgress(db: Db | Tx, run: ImportRun, phase?: UmblerImportPhase): Promise<void> {
  await db
    .update(umblerImports)
    .set({ progress: run.progress, ...(phase ? { phase } : {}) })
    .where(eq(umblerImports.id, run.importId));
}

export function maps(run: ImportRun): UmblerCatalogMaps {
  if (!run.progress.maps) throw new Error('umbler: the catalog phase did not run');
  return run.progress.maps;
}

export const orgQuery = (run: ImportRun): Query => ({ organizationId: run.org });
/** Names compare trimmed and without case (§6.2, §7.1). */
export const fold = (s: string): string => s.trim().toLowerCase();
const str = (v: string | null | undefined): string | null => v?.trim() || null;
const byOrder = <T extends { order: number }>(list: T[]): T[] => [...list].sort((a, b) => a.order - b.order);

export function validPhone(raw: string | null | undefined): string | null {
  const phone = normalizePhoneBR(raw ?? '');
  return /^\d{10,15}$/.test(phone) ? phone : null;
}
export function lidOf(raw: string | null | undefined): string | null {
  return raw ? (lidFromJid(raw) ?? (/^\d+$/.test(raw) ? raw : null)) : null;
}

// ---------- phase 1: catalog (§7.1, §7.2), one transaction ----------

type FieldKind = UmblerCatalogMaps['fields'][string]['kind'];

// Umbler definition `_t` → our kind. Anything else (logic, lists, options, members, references, files, dictionaries)
// is listed in customFields.unsupported and its values are skipped.
export const FIELD_KINDS: Record<string, FieldKind> = {
  TextCustomFieldDefinitionModel: 'text',
  LinkCustomFieldDefinitionModel: 'text',
  NumberCustomFieldDefinitionModel: 'number',
  DecimalCustomFieldDefinitionModel: 'number',
  CurrencyCustomFieldDefinitionModel: 'number',
  DateCustomFieldDefinitionModel: 'date',
  CPFCustomFieldDefinitionModel: 'cpf',
  CNPJCustomFieldDefinitionModel: 'cnpj',
};

function toAddress(a: Record<string, string | null> | null | undefined): Record<string, string> | null {
  const entries = Object.entries(a ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].trim() !== '');
  return entries.length ? Object.fromEntries(entries) : null;
}

function fieldValue(v: unknown, kind: FieldKind): string | null {
  if (typeof v === 'number') return String(v);
  if (typeof v !== 'string' || !v.trim()) return null;
  return kind === 'date' ? v.trim().slice(0, 10) : v.trim();
}

/** The admin's choice wins; 'create' (or an id that is gone) reuses a sector of the same name, else creates it. */
async function importSectors(tx: Tx, list: UmblerSector[], mapping: Record<string, string>, c: UmblerProgress) {
  const rows = await tx.select().from(sectors);
  const ours = new Set(rows.map((s) => s.id));
  const byName = new Map(rows.map((s) => [fold(s.name), s.id]));
  let hasDefault = rows.some((s) => s.isDefault);
  const map: Record<string, string> = {};
  for (const [i, s] of byOrder(list).entries()) {
    const target = mapping[s.id];
    const id = target && ours.has(target) ? target : byName.get(fold(s.name));
    if (id) {
      map[s.id] = id;
      c.sectors.existing += 1;
      continue;
    }
    const name = s.name.trim();
    const [row] = await tx.insert(sectors).values({ name, position: i, isDefault: s.default && !hasDefault }).returning({ id: sectors.id });
    hasDefault ||= s.default;
    byName.set(fold(name), row!.id);
    map[s.id] = row!.id;
    c.sectors.created += 1;
  }
  return map;
}

async function importTags(tx: Tx, list: UmblerTag[], c: UmblerProgress) {
  const idByName = new Map((await tx.select({ id: tags.id, name: tags.name }).from(tags)).map((t) => [fold(t.name), t.id]));
  const map: Record<string, string> = {};
  for (const [i, t] of byOrder(list).entries()) {
    const name = t.name.trim().slice(0, 30); // tags.name is varchar(30)
    let id = idByName.get(fold(name));
    if (id) {
      c.tags.existing += 1;
    } else {
      // Umbler TagColor name → hex of the shared palette, so the tag matches a TagForm swatch.
      const [row] = await tx
        .insert(tags)
        .values({ name, emoji: str(t.emoji), color: tagColorHex(t.color ?? ''), position: i })
        .returning({ id: tags.id });
      id = row!.id;
      idByName.set(fold(name), id);
      c.tags.created += 1;
    }
    map[t.id] = id;
  }
  return map;
}

async function importFields(tx: Tx, list: UmblerFieldDef[], c: UmblerProgress) {
  const rows = await tx.select({ id: customFields.id, name: customFields.name, kind: customFields.kind }).from(customFields);
  const byName = new Map(rows.map((f) => [fold(f.name), { id: f.id, kind: f.kind }]));
  const map: UmblerCatalogMaps['fields'] = {};
  for (const [i, d] of list.entries()) {
    const name = d.name.trim();
    const kind = FIELD_KINDS[d._t];
    if (!kind) {
      c.customFields.unsupported.push(name);
      continue;
    }
    let field = byName.get(fold(name));
    if (field) {
      c.customFields.existing += 1;
    } else {
      const [row] = await tx
        .insert(customFields)
        .values({ name, kind, position: i })
        .returning({ id: customFields.id, kind: customFields.kind });
      field = row!;
      byName.set(fold(name), field);
      c.customFields.created += 1;
    }
    map[d.id] = field;
  }
  return map;
}

/** §7.2: link to the chosen user (nothing in it changes), or create an inactive agent nobody can log in as. */
async function importMembers(tx: Tx, list: UmblerAnalysisDto['members'], mapping: Record<string, string>, c: UmblerProgress) {
  const rows = await tx.select({ id: users.id, email: users.email, active: users.active }).from(users);
  const byId = new Map(rows.map((u) => [u.id, u]));
  const byEmail = new Map(rows.map((u) => [fold(u.email), u]));
  const map: UmblerCatalogMaps['members'] = {};
  for (const m of list) {
    const target = mapping[m.id] ?? 'none';
    const found = target === 'none' ? undefined : target === 'create' ? byEmail.get(fold(m.email)) : byId.get(target);
    if (found) {
      map[m.id] = { id: found.id, active: found.active };
      c.members.linked += 1;
    } else if (target === 'create') {
      // a hash of 32 random bytes nobody knows; role agent, no sectors (§7.2)
      const passwordHash = await hashPassword(randomBytes(32).toString('base64'));
      const email = fold(m.email);
      const [row] = await tx
        .insert(users)
        .values({ name: m.name.trim() || email, email, passwordHash, role: 'agent', active: false })
        .returning({ id: users.id });
      map[m.id] = { id: row!.id, active: false };
      byEmail.set(email, { id: row!.id, email, active: false });
      c.members.createdInactive += 1;
    } else {
      c.members.none += 1; // "Sem atendente", or the chosen user was deleted meanwhile
    }
  }
  return map;
}

async function importQuickAnswers(
  tx: Tx,
  list: UmblerQuickAnswer[],
  attachments: Map<string, string | null>,
  members: UmblerCatalogMaps['members'],
  c: UmblerProgress,
): Promise<void> {
  const names = new Set((await tx.select({ name: quickAnswers.name }).from(quickAnswers)).map((q) => fold(q.name)));
  for (const qa of list) {
    const name = qa.name.trim();
    if (names.has(fold(name))) {
      c.quickAnswers.existing += 1;
      continue;
    }
    const { body, unmapped } = convertUmblerVariables(
      qa.content ?? '',
      (qa.variables ?? []).map((v) => ({ defaultValue: v.defaultValue ?? '' })),
    );
    if (unmapped.length) c.quickAnswers.unmappedVariables.push(name);
    if (attachments.get(qa.id) === null) c.quickAnswers.attachmentErrors.push(name);
    // §7.1: "Apenas para mim" (inferred from organizationMember, §4.1) of an active user stays that user's
    const owner = qa.organizationMember ? members[qa.organizationMember.id] : undefined;
    const mine = owner?.active === true;
    await tx.insert(quickAnswers).values({
      name, body, attachmentPath: attachments.get(qa.id) ?? null, visibility: mine ? 'owner' : 'all', ownerId: mine ? owner.id : null,
    });
    names.add(fold(name));
    c.quickAnswers.created += 1;
  }
}

/** A quick-answer attachment saved under mediaDir; null when it could not be downloaded (listed in the report). */
async function saveAttachment(run: ImportRun, url: string, name: string | null): Promise<string | null> {
  const got = await run.client.file(url);
  if ('failed' in got) return null;
  // ponytail: a file saved before a failed commit stays orphaned in mediaDir; harmless for a one-off import.
  return (await saveMedia(run.ctx.config.mediaDir, got.data, got.mime, name)).path;
}

/** Phase 1 (§7.1, §9.1): sectors, tags, fields, attendants and quick answers in one transaction, which also moves to 'contacts'. */
export async function importCatalog(run: ImportRun): Promise<void> {
  const q = orgQuery(run);
  const sectorList = await run.client.get<UmblerSector[]>('/v1/sectors/', q);
  const tagList = await getAll<UmblerTag>(run.client, '/v1/tags/', q);
  const fieldDefs = await run.client.get<UmblerFieldDef[]>('/v1/custom-field-definitions/', q);
  const listed = await getAll<UmblerQuickAnswer>(run.client, '/v1/quick-answers/', { ...q, viewFrom: 'Everyone' });
  const existing = new Set((await run.ctx.db.select({ name: quickAnswers.name }).from(quickAnswers)).map((r) => fold(r.name)));
  // Details and files of the new answers only, before the transaction: no network call inside it (§11).
  const details: UmblerQuickAnswer[] = [];
  const attachments = new Map<string, string | null>();
  for (const item of listed) {
    if (existing.has(fold(item.name))) {
      details.push(item);
      continue;
    }
    checkStop(run);
    const qa = await run.client.get<UmblerQuickAnswer>('/v1/quick-answers/{id}/', q, { id: item.id });
    details.push(qa);
    if (qa.attachment?.url) attachments.set(qa.id, await saveAttachment(run, qa.attachment.url, qa.attachment.originalName ?? null));
  }
  const c = run.progress;
  await run.ctx.db.transaction(async (tx) => {
    const sectorMap = await importSectors(tx, sectorList, run.mapping.sectors, c);
    const tagMap = await importTags(tx, tagList, c);
    const fieldMap = await importFields(tx, fieldDefs, c);
    const members = await importMembers(tx, run.analysis.members, run.mapping.members, c);
    await importQuickAnswers(tx, details, attachments, members, c);
    c.maps = { sectors: sectorMap, tags: tagMap, fields: fieldMap, members, defaultSector: await getDefaultSectorId(tx) };
    await saveProgress(tx, run, 'contacts'); // its counters are not idempotent: the catalog never runs twice
  });
}
```

- [ ] **Step 5: Remove the command-line importer**

Run: `git rm server/src/importer/cli.ts` (this stages the deletion; the commit below does not list the file again)

In `server/package.json`, replace

```json
    "dev:admin": "tsx --env-file=../.env.dev src/auth/seed-admin.ts",
    "import:umbler": "tsx src/importer/cli.ts"
```

with

```json
    "dev:admin": "tsx --env-file=../.env.dev src/auth/seed-admin.ts"
```

Run: `grep -rn "import:umbler\|importer/cli\|importUmbler" server README.md docker-compose.yml`
Expected: nothing. `docs/IMPLANTACAO.md` and the `Dockerfile` comment still mention the CLI; Task 13 rewrites them.

- [ ] **Step 6: Run the tests and the type check**

Run: `npm test -w server -- test/importer`
Expected: PASS (`client.test.ts` and `umbler.test.ts`).

Run: `npm run typecheck -w server`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add server/src/importer/umbler.ts server/package.json server/test/importer/world.ts server/test/importer/umbler.test.ts
git commit -m "feat(server): Umbler catalog phase (sectors, tags, fields, attendants, quick answers); the CLI importer goes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Contacts phase and the contacts' notes

Phase 2 (§7.4) is today's matching (phone first, then LID; only empty fields are filled), with these changes:
- a contact with a LID but no valid phone becomes a LID-only contact instead of being skipped;
- every contact gets its `umbler_map` row in the same transaction;
- contacts go 100 per transaction;
- a phone + LID pair feeds `mergeLidPairs` after the commit, so a LID-only contact the WhatsApp history created is joined to the phone contact before any chat. §8 needs a single contact.

When the list ignored `includeCustomFields`, each contact's fields are fetched before the transaction (§4.1).

Phase 4 (§7.5) makes one notes call per mapped contact still without `done_at`. A 404 (deleted in Umbler) counts in `gone`. `done_at` is set in the same transaction as the notes, so a second run makes no call. `upsertContact` is exported because Task 8 creates the contact of a chat whose contact is not in the list.

**Files:**
- Modify: `server/src/importer/umbler.ts` (append the section)
- Test: `server/test/importer/contacts.test.ts` (create)

**Interfaces:**
- Consumes: Task 3 `ImportRun`, `maps`, `saveProgress`, `checkStop`, `validPhone`, `lidOf`, `isGone`, `pages`; existing `mergeLidPairs`.
- Produces: `upsertContact`, `importContactsPhase`, `importNotesPhase`.

- [ ] **Step 1: Write the failing test**

Create `server/test/importer/contacts.test.ts`:

```ts
import { and, eq, isNotNull } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chats, contactFieldValues, contactNotes, contactTags, contacts, customFields, tags, umblerMap } from '../../src/db/schema.js';
import { importCatalog, importContactsPhase, importNotesPhase, type ImportRun } from '../../src/importer/umbler.js';
import { insertChat } from '../inbox/fixtures.js';
import { importWorld, runFor, type World } from './world.js';

let w: World;
let run: ImportRun;
beforeEach(async () => {
  w = await importWorld();
  run = await runFor(w);
  await importCatalog(run);
});
afterEach(async () => {
  expect(w.fake.problems()).toEqual([]);
  await w.fake.close();
});

const contactBy = async (where: ReturnType<typeof eq>) => (await w.ctx.db.select().from(contacts).where(where))[0];
const tagNames = async (contactId: string) =>
  (await w.ctx.db.select({ name: tags.name }).from(contactTags).innerJoin(tags, eq(tags.id, contactTags.tagId)).where(eq(contactTags.contactId, contactId)))
    .map((t) => t.name)
    .sort();

describe('contacts phase (spec 2026-10-21 importar-umbler §7.4)', () => {
  it('phone first, then LID; fills only what is empty; a LID-only contact comes; no phone nor LID stays out', async () => {
    await w.ctx.db.insert(contacts).values({ phone: '5565988887777', name: 'Nome Editado' }); // João, edited here

    await importContactsPhase(run);

    const maria = (await contactBy(eq(contacts.phone, '5565999998888')))!; // '+55 65 9999-8888' gains the 9
    expect(maria).toMatchObject({ name: 'Maria Teste', email: 'maria@example.test', blocked: false, lid: null });
    expect(maria.address).toEqual({ addressLine1: 'Rua das Flores, 100', city: 'Cuiabá', state: 'MT' });
    expect(await tagNames(maria.id)).toEqual(['Cliente']);
    const values = await w.ctx.db
      .select({ name: customFields.name, value: contactFieldValues.value })
      .from(contactFieldValues)
      .innerJoin(customFields, eq(customFields.id, contactFieldValues.fieldId))
      .where(eq(contactFieldValues.contactId, maria.id))
      .orderBy(customFields.name);
    expect(values).toEqual([{ name: 'CPF', value: '000.000.000-00' }, { name: 'Nascimento', value: '1990-05-17' }]);

    const joao = (await contactBy(eq(contacts.phone, '5565988887777')))!;
    expect(joao).toMatchObject({ name: 'Nome Editado', blocked: false, lid: '201234567890123' }); // blocked only on a new contact
    expect(await tagNames(joao.id)).toEqual(['Cliente', 'Prospecção']);

    expect(await contactBy(eq(contacts.lid, '209999999999999'))).toMatchObject({ name: 'Só LID', phone: null });
    expect(run.progress.contacts).toEqual({ created: 1, completed: 1, lidOnly: 1, skipped: 1 });
    expect((await w.ctx.db.select().from(umblerMap)).map((r) => `${r.kind}:${r.umblerId}`).sort()).toEqual(['contact:C1', 'contact:C2', 'contact:C3']);
    expect(run.progress.done).toBe(4);
  });

  it('joins a LID-only contact the WhatsApp history created into the phone contact before any chat (mergeLidPairs)', async () => {
    const [phoneOnly] = await w.ctx.db.insert(contacts).values({ phone: '5565988887777', name: 'João' }).returning();
    const [lidOnly] = await w.ctx.db.insert(contacts).values({ lid: '201234567890123', name: null }).returning();
    const historyChat = await insertChat(w.ctx, {
      channelId: w.s.channelId, sectorId: w.s.defaultSector, contactId: lidOnly!.id, state: 'closed', history: true,
    });

    await importContactsPhase(run);

    expect(await contactBy(eq(contacts.id, lidOnly!.id))).toBeUndefined();
    expect(await contactBy(eq(contacts.id, phoneOnly!.id))).toMatchObject({ lid: '201234567890123' });
    expect((await w.ctx.db.select().from(chats).where(eq(chats.id, historyChat)))[0]!.contactId).toBe(phoneOnly!.id);
  });

  it('asks each contact for its fields when the list ignores includeCustomFields (§4.1); a second run calls nothing per contact', async () => {
    w.fake.world.omitCustomFields = true;
    w.fake.world.contactFields.C1 = [{ _t: 'ContactCPFCustomFieldModel', customFieldDefinitionId: 'CF1', value: '111.111.111-11' }];

    await importContactsPhase(run);
    expect(w.fake.calls(/\/custom-fields\/$/).map((r) => r.path)).toEqual([
      '/api/v1/contacts/C1/custom-fields/',
      '/api/v1/contacts/C2/custom-fields/',
      '/api/v1/contacts/C3/custom-fields/',
      '/api/v1/contacts/C4/custom-fields/',
    ]);
    const maria = (await contactBy(eq(contacts.phone, '5565999998888')))!;
    expect((await w.ctx.db.select().from(contactFieldValues).where(eq(contactFieldValues.contactId, maria.id))).map((v) => v.value)).toEqual([
      '111.111.111-11',
    ]);

    const before = w.fake.requests.length;
    run.progress.contacts = { created: 0, completed: 0, lidOnly: 0, skipped: 0 };
    await importContactsPhase(run);
    // the list again (two pages: the second is empty), then only C4, which never got a map row
    expect(w.fake.requests.slice(before).map((r) => r.path)).toEqual(['/api/v1/contacts/', '/api/v1/contacts/', '/api/v1/contacts/C4/custom-fields/']);
    expect(run.progress.contacts).toEqual({ created: 0, completed: 0, lidOnly: 0, skipped: 1 });
  });
});

describe('notes phase (spec §7.5)', () => {
  it('copies the notes with author, pinned and date; a 404 is skipped and counted; done_at means no second call', async () => {
    w.fake.world.notes.C1 = [
      { _t: 'NoteModel', id: 'N1', content: 'Cliente pediu retorno', pinned: true, createdBy: 'M_ANA', createdAtUTC: '2026-08-01T10:00:00Z' },
      { _t: 'NoteModel', id: 'N2', content: 'Nota da IA', pinned: false, createdBy: 'M_IA', createdAtUTC: '2026-08-02T10:00:00Z' },
    ];
    w.fake.world.notes.C3 = []; // C2 has none: the fake answers 404 (deleted in Umbler)
    await importContactsPhase(run);

    await importNotesPhase(run);

    const maria = (await contactBy(eq(contacts.phone, '5565999998888')))!;
    const notes = await w.ctx.db.select().from(contactNotes).where(eq(contactNotes.contactId, maria.id)).orderBy(contactNotes.createdAt);
    expect(notes.map(({ body, pinned, authorId, createdAt }) => ({ body, pinned, authorId, createdAt }))).toEqual([
      { body: 'Cliente pediu retorno', pinned: true, authorId: w.s.agentA.id, createdAt: new Date('2026-08-01T10:00:00Z') },
      { body: 'Nota da IA', pinned: false, authorId: null, createdAt: new Date('2026-08-02T10:00:00Z') },
    ]);
    expect(run.progress).toMatchObject({ notes: 2, gone: 1, done: 3, total: 3 });
    expect(await w.ctx.db.$count(umblerMap, and(eq(umblerMap.kind, 'contact'), isNotNull(umblerMap.doneAt)))).toBe(3);

    const before = w.fake.calls(/\/notes\/$/).length;
    await importNotesPhase(run);
    expect(w.fake.calls(/\/notes\/$/)).toHaveLength(before);
    expect(await w.ctx.db.$count(contactNotes)).toBe(2);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w server -- test/importer/contacts.test.ts`
Expected: FAIL. `importContactsPhase` and `importNotesPhase` are not exported by `umbler.ts`.

- [ ] **Step 3: Add phases 2 and 4**

Append to the end of `server/src/importer/umbler.ts`:

```ts
// ---------- phase 2: contacts (§7.4), phase 4: their notes (§7.5) ----------

const CONTACT_BATCH = 100;

/**
 * §7.4: phone first, then LID; fills only what is empty. No valid phone but a LID → a LID-only contact; neither → null
 * (counted). Writes the umbler_map row in the same transaction; `blocked` only on a new contact.
 */
export async function upsertContact(tx: Tx, c: UmblerContact, counts: UmblerProgress['contacts']): Promise<string | null> {
  const phone = validPhone(c.phoneNumber);
  const lid = lidOf(c.lid);
  if (!phone && !lid) {
    counts.skipped += 1;
    return null;
  }
  const [byPhone] = phone ? await tx.select().from(contacts).where(eq(contacts.phone, phone)) : [];
  const [byLid] = lid ? await tx.select().from(contacts).where(eq(contacts.lid, lid)) : [];
  const found = byPhone ?? byLid;
  let id: string;
  if (found) {
    // never overwrite data already edited here; a LID owned by another contact is never copied
    await tx
      .update(contacts)
      .set({
        name: found.name ?? str(c.name),
        phone: found.phone ?? phone,
        lid: found.lid ?? (byLid ? null : lid),
        email: found.email ?? str(c.email),
        landline: found.landline ?? str(c.landline),
        address: found.address ?? toAddress(c.address),
      })
      .where(eq(contacts.id, found.id));
    id = found.id;
    counts.completed += 1;
  } else {
    const [row] = await tx
      .insert(contacts)
      .values({
        name: str(c.name), phone, lid, email: str(c.email), landline: str(c.landline), address: toAddress(c.address),
        blocked: c.isBlocked ?? false,
      })
      .returning({ id: contacts.id });
    id = row!.id;
    if (phone) counts.created += 1;
    else counts.lidOnly += 1;
  }
  await tx.insert(umblerMap).values({ kind: 'contact', umblerId: c.id, localId: id }).onConflictDoNothing();
  return id;
}

async function importContactBatch(run: ImportRun, list: UmblerContact[]): Promise<void> {
  if (list.length === 0) return;
  const m = maps(run);
  const p = run.progress;
  const mapped = await run.ctx.db
    .select({ umblerId: umblerMap.umblerId })
    .from(umblerMap)
    .where(and(eq(umblerMap.kind, 'contact'), inArray(umblerMap.umblerId, list.map((c) => c.id))));
  const done = new Set(mapped.map((r) => r.umblerId));
  const todo = list.filter((c) => !done.has(c.id));
  // §4.1: the list ignored includeCustomFields → one call per contact, before the transaction
  if (Object.keys(m.fields).length > 0) {
    for (const c of todo) {
      if (c.customFields !== undefined) continue;
      checkStop(run);
      c.customFields = await run.client
        .get<NonNullable<UmblerContact['customFields']>>('/v1/contacts/{id}/custom-fields/', orgQuery(run), { id: c.id })
        .catch((err: unknown) => {
          if (isGone(err)) return [];
          throw err;
        });
    }
  }
  const pairs: Array<{ lid: string; phone: string }> = [];
  await run.ctx.db.transaction(async (tx) => {
    for (const c of todo) {
      const id = await upsertContact(tx, c, p.contacts);
      if (!id) continue;
      const tagRows = (c.tags ?? []).flatMap((t) => (m.tags[t.id] ? [{ contactId: id, tagId: m.tags[t.id]! }] : []));
      if (tagRows.length) await tx.insert(contactTags).values(tagRows).onConflictDoNothing();
      const valueRows = (c.customFields ?? []).flatMap((f) => {
        const field = m.fields[f.customFieldDefinitionId];
        const value = field ? fieldValue(f.value, field.kind) : null;
        return field && value !== null ? [{ contactId: id, fieldId: field.id, value }] : [];
      });
      if (valueRows.length) await tx.insert(contactFieldValues).values(valueRows).onConflictDoNothing();
      const phone = validPhone(c.phoneNumber);
      const lid = lidOf(c.lid);
      if (phone && lid) pairs.push({ lid, phone });
    }
    p.done += list.length;
    await saveProgress(tx, run);
  });
  // §7.4: a LID-only contact the WhatsApp history created joins the phone one before any chat (§8 needs a single contact)
  await mergeLidPairs(run.ctx, pairs);
}

/** Phase 2 (§9.1): the whole contact list, 100 per transaction; contacts already in umbler_map are skipped. */
export async function importContactsPhase(run: ImportRun): Promise<void> {
  const fieldIds = Object.keys(maps(run).fields);
  run.progress.total = run.analysis.contacts.total;
  let batch: UmblerContact[] = [];
  const query = { ...orgQuery(run), includeGroups: false, State: 'All', includeCustomFields: fieldIds };
  for await (const page of pages<UmblerContact>(run.client, '/v1/contacts/', query)) {
    checkStop(run);
    batch.push(...page.items);
    if (batch.length >= CONTACT_BATCH) {
      await importContactBatch(run, batch);
      batch = [];
    }
  }
  await importContactBatch(run, batch);
}

/** Phase 4 (§7.5): one notes call per imported contact still without done_at; a 404 (deleted in Umbler) is skipped. */
export async function importNotesPhase(run: ImportRun): Promise<void> {
  const { db } = run.ctx;
  const m = maps(run);
  const p = run.progress;
  const todo = await db
    .select({ umblerId: umblerMap.umblerId, localId: umblerMap.localId })
    .from(umblerMap)
    .where(and(eq(umblerMap.kind, 'contact'), isNull(umblerMap.doneAt)));
  p.total = todo.length;
  for (const row of todo) {
    checkStop(run);
    let notes: UmblerNote[] = [];
    try {
      notes = await run.client.get<UmblerNote[]>('/v1/contacts/{id}/notes/', orgQuery(run), { id: row.umblerId });
    } catch (err) {
      if (!isGone(err)) throw err;
      p.gone += 1;
    }
    await db.transaction(async (tx) => {
      const [contact] = await tx.select({ id: contacts.id }).from(contacts).where(eq(contacts.id, row.localId));
      const have = notes.length
        ? await tx
            .select({ umblerId: umblerMap.umblerId })
            .from(umblerMap)
            .where(and(eq(umblerMap.kind, 'note'), inArray(umblerMap.umblerId, notes.map((n) => n.id))))
        : [];
      const copied = new Set(have.map((r) => r.umblerId));
      for (const n of contact ? notes : []) {
        if (copied.has(n.id)) continue;
        const [note] = await tx
          .insert(contactNotes)
          .values({
            contactId: contact!.id, body: n.content, pinned: n.pinned ?? false, createdAt: new Date(n.createdAtUTC),
            authorId: (n.createdBy && m.members[n.createdBy]?.id) || null,
          })
          .returning({ id: contactNotes.id });
        await tx.insert(umblerMap).values({ kind: 'note', umblerId: n.id, localId: note!.id });
        p.notes += 1;
      }
      await tx
        .update(umblerMap)
        .set({ doneAt: new Date() })
        .where(and(eq(umblerMap.kind, 'contact'), eq(umblerMap.umblerId, row.umblerId)));
      p.done += 1;
      await saveProgress(tx, run);
    });
  }
}
```

- [ ] **Step 4: Run the tests and the type check**

Run: `npm test -w server -- test/importer test/history`
Expected: PASS.

Run: `npm run typecheck -w server`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add server/src/importer/umbler.ts server/test/importer/contacts.test.ts
git commit -m "feat(server): Umbler contacts phase (LID-only contacts, LID merge) and the contacts' notes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

