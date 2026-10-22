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

### Task 5: "Analisar": counts, proposals, warnings and the read test

"Analisar" reads lists only, about 300 calls (§11). It counts:
- contacts: new, already here, and without phone nor LID;
- chats: open, waiting, finished, and the period by `createdAtUTC`;
- the chats per channel and per attendant;
- tags, fields and quick answers: new or already here.

It proposes a destination for every channel, sector and attendant (§6.2):
- a channel: the same number, else the official channel (§18.3); not WhatsApp → `none`;
- a sector: the same name, without case, else `create`;
- an attendant: the same e-mail, without case, else `create` (§18.4).

It writes the fixed warnings of §6.3: token without full access, chats without content, plan limit, no read-test candidate, the count check, and free space. The channel warnings depend on the admin's choice, so the page computes them (Task 12).

The read test (§5.1) takes the newest finished chat whose last message is from the contact and still `Received`. It reads its messages with the import's own call, then looks at the chat again through `contacts/{id}/chats`. It never uses the chat-detail route.

`chats.ts` starts with the two chat calls the analysis shares with the import. `job.ts` starts with the analysis and a `runUmblerJob` that only knows `analyzing`; Task 10 replaces it. Every error becomes `failed` with its §9.4 code. The row never holds the token.

**Files:**
- Create: `server/src/importer/chats.ts`, `server/src/importer/job.ts`
- Modify: `server/test/importer/world.ts` (imports; append `depsOf`, `rowOf`, `analyze`)
- Test: `server/test/importer/analyze.test.ts` (create)

**Interfaces:**
- Consumes: Tasks 2-3 (client, `pages`, `getAll`, `fold`, `validPhone`, `lidOf`, `FIELD_KINDS`, the `Umbler*` types); Task 1 `umblerImports`, `emptyUmblerCounts`.
- Produces:
  - `FIRST_EVENT`, `MESSAGES_TAKE`, `chatQuery`, `MessagePage`, `fetchMessagePage`;
  - `UmblerImportRow`, `JobDeps`, `freeBytesOf`, `emptyProgress`, `analyzeUmbler`, `runUmblerJob`;
  - test world: `depsOf`, `rowOf`, `analyze`.

- [ ] **Step 1: Extend the test world**

In `server/test/importer/world.ts`, replace

```ts
import { emptyUmblerCounts, type UmblerAnalysisDto, type UmblerMappingDto } from '@talk/shared';
import { umblerImports } from '../../src/db/schema.js';
import { createUmblerClient, type ImportRun, type UmblerClient } from '../../src/importer/umbler.js';
```

with

```ts
import { eq } from 'drizzle-orm';
import { emptyUmblerCounts, type UmblerAnalysisDto, type UmblerMappingDto } from '@talk/shared';
import { umblerImports } from '../../src/db/schema.js';
import { emptyProgress, runUmblerJob, type JobDeps, type UmblerImportRow } from '../../src/importer/job.js';
import { createUmblerClient, type ImportRun, type UmblerClient } from '../../src/importer/umbler.js';
```

and append:

```ts
export const depsOf = (w: World): JobDeps => ({ client: w.client, sleep: async (ms) => void w.sleeps.push(ms), freeBytes: async () => w.free.bytes });

export async function rowOf(w: World, id: string): Promise<UmblerImportRow> {
  return (await w.ctx.db.select().from(umblerImports).where(eq(umblerImports.id, id)))[0]!;
}

/** "Analisar" as the worker runs it: a new 'analyzing' row and one job beat. */
export async function analyze(w: World): Promise<UmblerImportRow> {
  const [row] = await w.ctx.db.insert(umblerImports).values({ state: 'analyzing', progress: emptyProgress() }).returning();
  await runUmblerJob(w.ctx, depsOf(w));
  return rowOf(w, row!.id);
}
```

- [ ] **Step 2: Write the failing test**

Create `server/test/importer/analyze.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { channels } from '../../src/db/schema.js';
import { umblerChat, umblerMessage } from '../fakes/umbler-api.js';
import { analyze, importWorld, proposals, testAnalysis, type World } from './world.js';

let w: World;
let logs: unknown[][];
beforeEach(async () => {
  w = await importWorld();
  logs = [];
  for (const level of ['info', 'error'] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args));
});
afterEach(async () => {
  vi.restoreAllMocks();
  expect(w.fake.problems()).toEqual([]);
  await w.fake.close();
});

const closed = (closedAtUTC: string, over: Record<string, unknown> = {}) =>
  umblerChat({ open: false, closedAtUTC, createdAtUTC: closedAtUTC, ...over });
const received = { id: 'LAST', source: 'Contact', messageState: 'Received' };

describe('Analisar (spec 2026-10-21 importar-umbler §6.2)', () => {
  it('counts lists only and proposes sector by name, attendant by e-mail and channel by number', async () => {
    await w.ctx.db.update(channels).set({ phone: '5565999990000' }).where(eq(channels.id, w.s.channelId));
    w.fake.world.chats.push(
      umblerChat({ createdAtUTC: '2026-10-01T12:00:00Z', waiting: true }),
      umblerChat({ createdAtUTC: '2026-10-02T12:00:00Z', organizationMember: { id: 'M_CARLA' } }),
      closed('2025-03-04T12:00:00Z'),
      closed('2026-01-01T12:00:00Z', { channel: { _t: 'ChatWebsiteWidgetChannelReferenceModel', id: 'CH_WEB', name: 'Site' } }),
    );

    const row = await analyze(w);

    expect(row.state).toBe('analyzed');
    const a = row.analysis!;
    expect(a).toMatchObject({
      organizationId: 'ORG_TESTE_00001',
      organization: 'Escritório Teste',
      contacts: { total: 4, existing: 0, withoutAddress: 1 },
      chats: { open: 2, waiting: 1, closed: 2, from: '2025-03-04T12:00:00.000Z', to: '2026-10-02T12:00:00.000Z' },
      tags: { new: 2, existing: 0 },
      customFields: { new: 2, existing: 0, unsupported: ['Aceitou termos'] },
      quickAnswers: { new: 2, existing: 0 },
    });
    expect(a.channels.map((c) => [c.id, c.whatsapp, c.phone, c.chats])).toEqual([
      ['CH_WA', true, '5565999990000', 3],
      ['CH_WEB', false, null, 1],
    ]);
    expect(a.members.map((m) => [m.id, m.chats])).toEqual([['M_ANA', 3], ['M_CARLA', 1]]); // the AI agent stays out
    expect(proposals(a)).toEqual(proposals(testAnalysis(w)));
    expect(row.progress?.chatsRead).toBe(4);
    expect(w.fake.calls(/relative-messages/)).toEqual([]); // no candidate for the read test: no message call at all
    expect(JSON.stringify(logs)).not.toMatch(/Maria|5565|ana@teste|tok-teste/i);
  });

  it('an old WhatsApp number of the office goes to the official channel (§18.3); other kinds of channel never come', async () => {
    w.fake.world.channels.push({ _t: 'OrganizationCloudAPIWhatsappChannelReferenceModel', id: 'CH_OLD', name: 'Número antigo', phoneNumber: '+5565988880000' });
    const [second] = await w.ctx.db.insert(channels).values({ name: 'Outro', evolutionInstance: 'talk-outro', phone: '5565999990000' }).returning();

    const a = (await analyze(w)).analysis!;

    // CH_WA has the number of `second`, which is then the official channel; CH_OLD's number is nowhere here
    expect(Object.fromEntries(a.channels.map((c) => [c.id, c.proposal]))).toEqual({ CH_WA: second!.id, CH_WEB: 'none', CH_OLD: second!.id });
  });

  it('warns: token without full access, chats without content, plan limit, no read-test candidate, a count that disagrees, free space', async () => {
    const me = w.fake.world.me as { organizations: Array<Record<string, unknown>> };
    me.organizations[0]!.permissions = ['Operator'];
    w.fake.world.organization.maxDaysMessageHistoric = 90;
    w.fake.world.chats.push(umblerChat({ redactReason: 'InDisallowedSector' }));
    w.fake.world.totalBias = 1;
    w.free.bytes = 12.5 * 1024 ** 3;

    const a = (await analyze(w)).analysis!;

    expect(a.readTest).toBe('not_done');
    expect(a.warnings).toEqual([
      'O token é de um usuário sem acesso a tudo: gere o token com o Proprietário.',
      'O Umbler informou 2 conversas abertas, mas a lista trouxe 1.',
      '1 conversas vêm sem conteúdo para este token.',
      'O plano do Umbler mostra só os últimos 90 dias de mensagens; as anteriores não vêm.',
      'Não houve conversa para o teste de leitura; a importação confere as abertas durante a cópia.',
      'Espaço livre para arquivos: 12,5 GB.',
    ]);
  });

  it('read test (§5.1): reads the newest closed chat still "Received" from the contact, then looks at it again', async () => {
    const newest = closed('2026-09-10T12:00:00Z', { lastMessage: received, totalUnread: 2 });
    const older = closed('2026-09-05T12:00:00Z', { lastMessage: received });
    w.fake.world.chats.push(older, newest);
    w.fake.world.messages[newest.id as string] = [umblerMessage('M1', '2026-09-10T11:59:00Z')];

    expect((await analyze(w)).analysis!.readTest).toBe('ok');
    expect(w.fake.calls(/relative-messages/).map((r) => r.path)).toEqual([`/api/v1/chats/${newest.id}/relative-messages/`]);
    expect(w.fake.calls(/\/contacts\/C1\/chats\/$/).map((r) => r.query.get('ChatState'))).toEqual(['Closed']);

    w.fake.world.marksRead = newest.id as string; // this time reading marks it as read in Umbler
    expect((await analyze(w)).analysis!.readTest).toBe('marked');
  });

  it('a refused token fails the analysis with umbler_token, and the token is never in the row', async () => {
    w.fake.faults.push({ path: /members\/me/, status: 401 });
    const row = await analyze(w);
    expect(row).toMatchObject({ state: 'failed', error: 'umbler_token', analysis: null });
    expect(JSON.stringify(row)).not.toContain('tok-teste');
    expect(JSON.stringify(logs)).not.toContain('tok-teste');
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm test -w server -- test/importer/analyze.test.ts`
Expected: FAIL. `../../src/importer/job.js` does not exist.

- [ ] **Step 4: Create the chat calls and the analysis**

Create `server/src/importer/chats.ts`:

```ts
import type { Query, UmblerClient, UmblerMessage } from './umbler.js';

// Spec 2026-10-21 importar-umbler §7.6-7.8: Umbler chats and their messages, page by page.

/** §4: the first relative-messages page starts here; the next one at the last eventAtUTC - 1 ms. */
export const FIRST_EVENT = '2000-01-01T00:00:00Z';
export const MESSAGES_TAKE = 250; // the route's maximum

/** §4: direct conversations only, hidden ones included, without the token owner's pinned chats mixed in. */
export function chatQuery(org: string, state: 'open' | 'closed'): Query {
  return {
    organizationId: org,
    ContactTypes: ['DirectMessage'],
    Visibility: ['Show', 'Hide', 'HideUntilNextMessage'],
    IncludePinneds: false,
    ...(state === 'open'
      ? { ChatState: 'Open', ChatOrderBy: 'CreatedAtUTC', Order: 'Asc' }
      : { ChatState: 'Closed', ChatOrderBy: 'ClosedAtUTC', Order: 'Desc' }),
  };
}

export interface MessagePage { hasMessagesBeforeAllowedOrganizationPlan?: boolean; messages?: UmblerMessage[] }

/** One relative-messages page from `from` on (§4), without timeline events. "Analisar" reads with it too (§5.1). */
export function fetchMessagePage(client: UmblerClient, org: string, chatId: string, from: Date): Promise<MessagePage> {
  return client.get<MessagePage>(
    '/v1/chats/{chatId}/relative-messages/',
    { organizationId: org, FromEventUTC: from.toISOString(), Direction: 'TakeAfter', Take: MESSAGES_TAKE, IncludeMetadata: false },
    { chatId },
  );
}
```

Create `server/src/importer/job.ts`:

```ts
import { statfs } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { emptyUmblerCounts, type UmblerAnalysisDto, type UmblerProgressDto } from '@talk/shared';
import { errorTag } from '../bots/scheduler.js';
import type { AppCtx } from '../ctx.js';
import { channels, contacts, customFields, quickAnswers, sectors, tags, umblerImports, users } from '../db/schema.js';
import { normalizePhoneBR } from '../whatsapp/phone.js';
import { FIRST_EVENT, chatQuery, fetchMessagePage } from './chats.js';
import {
  FIELD_KINDS, Stopped, UmblerError, fold, getAll, isGone, lidOf, pages, validPhone, type UmblerChannel, type UmblerChat,
  type UmblerClient, type UmblerContact, type UmblerFieldDef, type UmblerMe, type UmblerOrganization, type UmblerQuickAnswer,
  type UmblerSector, type UmblerTag,
} from './umbler.js';

// Spec 2026-10-21 importar-umbler §5, §6.2, §9: "Analisar", the five phases and the resume. All state lives in
// umbler_imports and umbler_map, so a restart picks the row up where it stopped.

export type UmblerImportRow = typeof umblerImports.$inferSelect;

export interface JobDeps {
  client: UmblerClient;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<unknown>;
  freeBytes?: (dir: string) => Promise<number>;
}

/** Free bytes of the disk that holds `dir` (§6.3 "Espaço livre", §7.8 disk_full). */
export async function freeBytesOf(dir: string): Promise<number> {
  const s = await statfs(dir);
  return s.bavail * s.bsize;
}

export const emptyProgress = (): UmblerProgressDto => ({ ...emptyUmblerCounts(), done: 0, total: 0, chatsRead: 0 });
const n = (x: number) => x.toLocaleString('pt-BR');

// ---------- Analisar (§5.1, §6.2, §6.3) ----------

/** §5.1: reads the newest closed chat still "Received" from the contact the way the import does, then checks it again. */
async function readTest(client: UmblerClient, org: string, chat: UmblerChat): Promise<UmblerAnalysisDto['readTest']> {
  try {
    await fetchMessagePage(client, org, chat.id, new Date(FIRST_EVENT));
  } catch (err) {
    if (isGone(err)) return 'not_done';
    throw err;
  }
  const again = await client.get<{ items?: UmblerChat[] }>(
    '/v1/contacts/{id}/chats/',
    { organizationId: org, ChatState: 'Closed', Skip: 0, Take: 50 },
    { id: chat.contact.id },
  );
  const after = again.items?.find((c) => c.id === chat.id);
  if (!after) return 'not_done';
  const same = after.lastMessage?.messageState === chat.lastMessage?.messageState && (after.totalUnread ?? 0) === (chat.totalUnread ?? 0);
  return same ? 'ok' : 'marked';
}

/** "Analisar" (§6.2): lists only (no messages, ~300 calls), counts, proposals, warnings and the read test. */
export async function analyzeUmbler(ctx: AppCtx, deps: JobDeps, row: UmblerImportRow): Promise<void> {
  const c = deps.client;
  const me = await c.get<UmblerMe>('/v1/members/me/');
  const ref = me.organizations?.[0]; // ponytail: the office has exactly one organization (§4)
  if (!ref) throw new UmblerError('umbler_token', null, '/v1/members/me/');
  const q = { organizationId: ref.id };
  const org = await c.get<UmblerOrganization>('/v1/organizations/{id}/', {}, { id: ref.id });
  const channelList = await c.get<UmblerChannel[]>('/v1/channels/', q);
  const sectorList = await c.get<UmblerSector[]>('/v1/sectors/', q);
  const tagList = await getAll<UmblerTag>(c, '/v1/tags/', q);
  const fieldDefs = await c.get<UmblerFieldDef[]>('/v1/custom-field-definitions/', q);
  const answers = await getAll<UmblerQuickAnswer>(c, '/v1/quick-answers/', { ...q, viewFrom: 'Everyone' });

  const ours = await ctx.db.select({ phone: contacts.phone, lid: contacts.lid }).from(contacts);
  const phones = new Set(ours.flatMap((r) => (r.phone ? [r.phone] : [])));
  const lids = new Set(ours.flatMap((r) => (r.lid ? [r.lid] : [])));
  const contactCounts = { total: 0, existing: 0, withoutAddress: 0 };
  for await (const page of pages<UmblerContact>(c, '/v1/contacts/', { ...q, includeGroups: false, State: 'All' })) {
    for (const ct of page.items) {
      const phone = validPhone(ct.phoneNumber);
      const lid = lidOf(ct.lid);
      contactCounts.total += 1;
      if (!phone && !lid) contactCounts.withoutAddress += 1;
      else if ((phone && phones.has(phone)) || (lid && lids.has(lid))) contactCounts.existing += 1;
    }
    if (deps.signal?.aborted) throw new Stopped();
  }

  const progress = emptyProgress();
  const warnings: string[] = [];
  const stats = { open: 0, waiting: 0, closed: 0, redacted: 0, from: Number.POSITIVE_INFINITY, to: Number.NEGATIVE_INFINITY };
  const byChannel = new Map(channelList.map((ch) => [ch.id, { name: ch.name, type: ch._t, phone: ch.phoneNumber ?? null, chats: 0 }]));
  const byMember = new Map<string, number>();
  let candidate: UmblerChat | undefined;
  for (const state of ['open', 'closed'] as const) {
    let walked = 0;
    let total: number | null = null;
    for await (const page of pages<UmblerChat>(c, '/v1/chats/', chatQuery(ref.id, state), true)) {
      total ??= page.total;
      for (const ch of page.items) {
        walked += 1;
        stats[state] += 1;
        if (state === 'open' && ch.waiting) stats.waiting += 1;
        if (ch.redactReason) stats.redacted += 1;
        stats.from = Math.min(stats.from, Date.parse(ch.createdAtUTC));
        stats.to = Math.max(stats.to, Date.parse(ch.createdAtUTC));
        // a channel only a chat names (removed from Umbler) still gets its row
        const known = byChannel.get(ch.channel.id) ?? { name: ch.channel.name ?? '', type: ch.channel._t, phone: ch.channel.phoneNumber ?? null, chats: 0 };
        known.chats += 1;
        byChannel.set(ch.channel.id, known);
        if (ch.organizationMember) byMember.set(ch.organizationMember.id, (byMember.get(ch.organizationMember.id) ?? 0) + 1);
        if (state === 'closed' && !candidate && ch.lastMessage?.source === 'Contact' && ch.lastMessage.messageState === 'Received') {
          candidate = ch; // the newest one: the list is ClosedAtUTC Desc
        }
      }
      progress.chatsRead += page.items.length;
      await ctx.db.update(umblerImports).set({ progress }).where(eq(umblerImports.id, row.id)); // "N conversas lidas"
      if (deps.signal?.aborted) throw new Stopped();
    }
    // decision: page.totalItems of the first page is checked against what the walk found (§4 "conferir")
    if (total !== null && total !== walked) {
      warnings.push(`O Umbler informou ${n(total)} conversas ${state === 'open' ? 'abertas' : 'finalizadas'}, mas a lista trouxe ${n(walked)}.`);
    }
  }
  const tested = candidate ? await readTest(c, ref.id, candidate) : 'not_done';

  const ourSectors = await ctx.db.select({ id: sectors.id, name: sectors.name }).from(sectors);
  const ourUsers = await ctx.db.select({ id: users.id, email: users.email }).from(users);
  const ourChannels = await ctx.db
    .select({ id: channels.id, phone: channels.phone, status: channels.status })
    .from(channels)
    .orderBy(channels.createdAt);
  const sectorByName = new Map(ourSectors.map((s) => [fold(s.name), s.id]));
  const userByEmail = new Map(ourUsers.map((u) => [fold(u.email), u.id]));
  const channelByPhone = new Map(ourChannels.flatMap((ch) => (ch.phone ? [[normalizePhoneBR(ch.phone), ch.id] as const] : [])));

  const rows = [...byChannel].map(([id, ch]) => {
    const whatsapp = /whatsapp/i.test(ch.type);
    const phone = ch.phone ? normalizePhoneBR(ch.phone) : null;
    return { id, name: ch.name, type: ch.type, phone, whatsapp, chats: ch.chats, same: whatsapp && phone ? channelByPhone.get(phone) : undefined };
  });
  // §6.2 + §18.3: a WhatsApp number that is not here (an old number of the office) goes to the official channel: the one
  // an Umbler number matched, else our oldest connected channel, else our oldest channel.
  const official = rows.find((r) => r.same)?.same ?? ourChannels.find((ch) => ch.status === 'connected')?.id ?? ourChannels[0]?.id ?? 'none';
  const channelRows = rows.map(({ same, ...r }) => ({ ...r, proposal: r.whatsapp ? (same ?? official) : 'none' }));

  const members = (org.organizationMembers ?? [])
    .filter((m) => m._t === 'OrganizationHumanAgentReferenceModel' && m.emailAddress?.trim()) // AI agents stay out (§4)
    .map((m) => {
      const email = m.emailAddress!.trim();
      return {
        id: m.id, name: m.displayName?.trim() || email, email, active: m.active ?? false, chats: byMember.get(m.id) ?? 0,
        proposal: userByEmail.get(fold(email)) ?? 'create', // §18.4: no user with that e-mail → an inactive user
      };
    });

  const ourTags = new Set((await ctx.db.select({ name: tags.name }).from(tags)).map((t) => fold(t.name)));
  const ourFields = new Set((await ctx.db.select({ name: customFields.name }).from(customFields)).map((f) => fold(f.name)));
  const ourAnswers = new Set((await ctx.db.select({ name: quickAnswers.name }).from(quickAnswers)).map((a) => fold(a.name)));
  const newTags = tagList.filter((t) => !ourTags.has(fold(t.name.trim().slice(0, 30)))).length;
  const supported = fieldDefs.filter((d) => FIELD_KINDS[d._t]);
  const newFields = supported.filter((d) => !ourFields.has(fold(d.name))).length;
  const newAnswers = answers.filter((a) => !ourAnswers.has(fold(a.name))).length;

  const perms = ref.permissions ?? [];
  const everything = (perms.includes('Owner') || perms.includes('Admin')) && ref.allowedSectors?.allSectorsEnable && ref.allowedChannels?.allChannelsEnable;
  if (!everything) warnings.unshift('O token é de um usuário sem acesso a tudo: gere o token com o Proprietário.');
  if (stats.redacted) warnings.push(`${n(stats.redacted)} conversas vêm sem conteúdo para este token.`);
  if (org.maxDaysMessageHistoric) {
    warnings.push(`O plano do Umbler mostra só os últimos ${n(org.maxDaysMessageHistoric)} dias de mensagens; as anteriores não vêm.`);
  }
  if (tested === 'not_done') warnings.push('Não houve conversa para o teste de leitura; a importação confere as abertas durante a cópia.');
  const free = await (deps.freeBytes ?? freeBytesOf)(ctx.config.mediaDir);
  warnings.push(`Espaço livre para arquivos: ${(free / 1024 ** 3).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} GB.`);

  const analysis: UmblerAnalysisDto = {
    organizationId: ref.id,
    organization: org.name,
    contacts: contactCounts,
    chats: {
      open: stats.open, waiting: stats.waiting, closed: stats.closed,
      from: Number.isFinite(stats.from) ? new Date(stats.from).toISOString() : null,
      to: Number.isFinite(stats.to) ? new Date(stats.to).toISOString() : null,
    },
    channels: channelRows,
    sectors: sectorList.map((s) => ({ id: s.id, name: s.name.trim(), proposal: sectorByName.get(fold(s.name)) ?? 'create' })),
    members,
    tags: { new: newTags, existing: tagList.length - newTags },
    customFields: {
      new: newFields, existing: supported.length - newFields,
      unsupported: fieldDefs.filter((d) => !FIELD_KINDS[d._t]).map((d) => d.name.trim()),
    },
    quickAnswers: { new: newAnswers, existing: answers.length - newAnswers },
    readTest: tested,
    warnings,
  };
  await ctx.db.update(umblerImports).set({ state: 'analyzed', analysis, progress }).where(eq(umblerImports.id, row.id));
  console.info('umbler: analyzed', { importId: row.id, contacts: contactCounts.total, chats: stats.open + stats.closed, readTest: tested });
}

/** One beat (§9.3): the analysis of the 'analyzing' row; an error marks it failed with its §9.4 code. */
export async function runUmblerJob(ctx: AppCtx, deps: JobDeps): Promise<void> {
  const [row] = await ctx.db.select().from(umblerImports).where(eq(umblerImports.state, 'analyzing'));
  if (!row) return;
  try {
    await analyzeUmbler(ctx, deps, row);
  } catch (err) {
    if (err instanceof Stopped || deps.signal?.aborted) return;
    const code = err instanceof UmblerError ? err.code : 'unexpected';
    // ids, the code and the route template only (§3): never text, phone, name, URL or the token
    console.error('umbler: import stopped', { importId: row.id, code, route: err instanceof UmblerError ? err.route : null, err: errorTag(err) });
    await ctx.db.update(umblerImports).set({ state: 'failed', error: code }).where(eq(umblerImports.id, row.id));
  }
}
```

- [ ] **Step 5: Run the tests and the type check**

Run: `npm test -w server -- test/importer`
Expected: PASS.

Run: `npm run typecheck -w server`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/importer/chats.ts server/src/importer/job.ts server/test/importer/world.ts server/test/importer/analyze.test.ts
git commit -m "feat(server): Analisar do Umbler (counts, proposed mapping, warnings and the read test)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The match with the WhatsApp history, both ways

§8: an Umbler message and one of our rows are the same message when all of these hold:
- same contact and same channel, in any chat;
- same direction and same class: text, media (`image|video|audio|document|sticker`) or other;
- the same normalized text: no signature line, NFC, `\n`, no spaces at the ends;
- at most `MATCH_WINDOW_MS` (10 s) apart.

`pairUp` is pure. It pairs one to one in time order, and each item takes the free candidate with the smallest difference, a tie going to the older one. `matchCandidates` reads one side:
- `'ours'`: rows not imported from Umbler yet;
- `'umbler'`: imported rows still without a WhatsApp id.

`placeRecords` (the history import and the recovery) uses the second side before inserting. When it finds a twin, it only writes the `external_id` and counts the message as already there. A batch first checks whether any Umbler message exists at all, which is one cheap read, so the history copy costs nothing more before the switch.

**Files:**
- Create: `server/src/importer/match.ts`
- Modify: `server/src/history/place.ts` (import; the `umbler` flag; the claim before the insert)
- Test: `server/test/importer/match.test.ts` (create), `server/test/history/place.test.ts`

**Interfaces:**
- Consumes: Task 1 `umblerMap`; existing `stripSignature`.
- Produces: `MATCH_WINDOW_MS`, `Comparable`, `Candidate`, `normalizeText`, `pairUp`, `matchCandidates`, `hasUmblerMessages`, `claimUmblerTwin`.

- [ ] **Step 1: Write the failing tests**

Create `server/test/importer/match.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { messages, umblerMap } from '../../src/db/schema.js';
import { MATCH_WINDOW_MS, matchCandidates, normalizeText, pairUp, type Comparable } from '../../src/importer/match.js';
import { makeTestCtx, seedBasics } from '../helpers.js';
import { insertChat, newContact } from '../inbox/fixtures.js';

const at = (s: number) => new Date(Date.UTC(2026, 9, 1, 12, 0, 0) + s * 1000);
const msg = (o: Partial<Comparable> & { at: Date }): Comparable => ({ direction: 'in', kind: 'text', text: 'Bom dia', ...o });

describe('pairUp (spec 2026-10-21 importar-umbler §8)', () => {
  it('same direction, class and text within 10 s matches; 11 s, the other direction or another text does not', () => {
    const ours = [msg({ at: at(10) })];
    expect(MATCH_WINDOW_MS).toBe(10_000);
    expect(pairUp([msg({ at: at(0) })], ours)).toEqual([{ row: ours[0], diffMs: 10_000 }]);
    expect(pairUp([msg({ at: at(-1) })], ours)).toEqual([null]);
    expect(pairUp([msg({ at: at(10), direction: 'out' })], ours)).toEqual([null]);
    expect(pairUp([msg({ at: at(10), text: 'Bom dia!' })], ours)).toEqual([null]);
  });

  it('drops the signature line, CRLF, the spaces at the ends and compares NFC; a GIF image matches a WhatsApp video', () => {
    expect(normalizeText('*Financeiro - Ana:*\r\nSegue o boleto  ')).toBe('Segue o boleto');
    const signed = msg({ at: at(0), direction: 'out', text: '*Financeiro - Ana:*\r\nSegue o boleto  ' });
    expect(pairUp([signed], [msg({ at: at(2), direction: 'out', text: 'Segue o boleto' })])[0]).not.toBeNull();
    expect(pairUp([msg({ at: at(0), text: 'Sim, João' })], [msg({ at: at(0), text: 'Sim, João' })])[0]).not.toBeNull();
    const gif = msg({ at: at(0), kind: 'image', text: null });
    expect(pairUp([gif], [msg({ at: at(1), kind: 'video', text: '' })])[0]).not.toBeNull();
    expect(pairUp([gif], [msg({ at: at(1), kind: 'text', text: '' })])[0]).toBeNull();
    // a location or contact card from Umbler compares as WhatsApp's 'unsupported' with no text
    expect(pairUp([msg({ at: at(0), kind: 'unsupported', text: null })], [msg({ at: at(3), kind: 'unsupported', text: null })])[0]).not.toBeNull();
  });

  it('one to one in time order: a burst of equal texts pairs up; each takes the nearest free one, a tie the older', () => {
    const ours = [msg({ at: at(0.5), text: 'ok' }), msg({ at: at(1.2), text: 'ok' })];
    const pairs = pairUp([msg({ at: at(0), text: 'ok' }), msg({ at: at(1), text: 'ok' })], ours);
    expect(pairs.map((p) => p?.row)).toEqual([ours[0], ours[1]]);
    expect(pairUp([msg({ at: at(5), text: 'ok' }), msg({ at: at(5), text: 'ok' }), msg({ at: at(5), text: 'ok' })], [
      msg({ at: at(7), text: 'ok' }),
      msg({ at: at(3), text: 'ok' }),
    ]).map((p) => p?.row.at.getTime())).toEqual([at(3).getTime(), at(7).getTime(), undefined]);
  });
});

describe('matchCandidates (spec §8.1)', () => {
  it("lists the contact's rows on the channel in the window, any chat, never notes; 'ours' are not imported, 'umbler' have no WhatsApp id", async () => {
    const ctx = await makeTestCtx();
    const s = await seedBasics(ctx);
    const contactId = await newContact(ctx);
    const other = await newContact(ctx);
    const historyChat = await insertChat(ctx, { channelId: s.channelId, sectorId: s.defaultSector, contactId, state: 'closed', history: true });
    const openChat = await insertChat(ctx, { channelId: s.channelId, sectorId: s.defaultSector, contactId });
    const otherChat = await insertChat(ctx, { channelId: s.channelId, sectorId: s.defaultSector, contactId: other });
    const row = async (chatId: string, sentAt: Date, extra: Partial<typeof messages.$inferInsert> = {}) => {
      const [m] = await ctx.db
        .insert(messages)
        .values({ chatId, channelId: s.channelId, direction: 'in', kind: 'text', body: 'Bom dia', status: 'read', sentAt, ...extra })
        .returning({ id: messages.id });
      return m!.id;
    };
    const fromHistory = await row(historyChat, at(0), { externalId: 'wa-1' });
    const fromOpen = await row(openChat, at(9), { externalId: 'wa-2' });
    await row(openChat, at(1), { kind: 'note', direction: 'out' });
    await row(openChat, at(30), { externalId: 'wa-3' }); // outside the window
    await row(otherChat, at(0), { externalId: 'wa-4' });
    const imported = await row(historyChat, at(2));
    const importedWithId = await row(historyChat, at(3), { externalId: 'wa-5' });
    await ctx.db.insert(umblerMap).values([
      { kind: 'message', umblerId: 'U1', localId: imported },
      { kind: 'message', umblerId: 'U2', localId: importedWithId },
    ]);

    const scope = { contactId, channelId: s.channelId };
    const ids = async (side: 'ours' | 'umbler') => (await matchCandidates(ctx.db, scope, [{ at: at(5) }], side)).map((c) => c.id).sort();
    expect(await ids('ours')).toEqual([fromHistory, fromOpen].sort());
    expect(await ids('umbler')).toEqual([imported]);
    expect(await matchCandidates(ctx.db, scope, [], 'ours')).toEqual([]);
  });
});
```

In `server/test/history/place.test.ts`, replace

```ts
import { botRuns, chatEvents, chats, contacts, messageEdits, messages } from '../../src/db/schema.js';
```

with

```ts
import { botRuns, chatEvents, chats, contacts, messageEdits, messages, umblerMap } from '../../src/db/schema.js';
```

and append at the end of the file:

```ts
describe('placeRecords and rows imported from Umbler (spec 2026-10-21 importar-umbler §8)', () => {
  it('gives an Umbler row without WhatsApp id its id instead of inserting the same message twice', async () => {
    const contactId = await newContact(ctx, { phone: PHONE });
    const chatId = await insertChat(ctx, { channelId: s.channelId, sectorId: s.defaultSector, contactId, state: 'closed' });
    const [fromUmbler] = await ctx.db
      .insert(messages)
      .values({ chatId, channelId: s.channelId, direction: 'in', kind: 'text', body: 'texto um', status: 'read', sentAt: at('2026-10-10T12:00:03Z') })
      .returning();
    await ctx.db.insert(umblerMap).values({ kind: 'message', umblerId: 'U1', localId: fromUmbler!.id });

    const r = await place([rec({ id: 'um', at: '2026-10-10T12:00:00Z', text: 'texto um' }), rec({ id: 'dois', at: '2026-10-10T12:00:00Z', text: 'texto dois' })]);

    expect(r.inserted).toBe(1);
    const rows = await ctx.db.select().from(messages).orderBy(messages.body);
    expect(rows.map((m) => [m.body, m.externalId, m.chatId === chatId])).toEqual([
      ['texto dois', 'dois', false], // a new message: the history chat
      ['texto um', 'um', true], // the Umbler row stays where it is, now with its WhatsApp id
    ]);
    // a second copy of the same rows finds the WhatsApp id and changes nothing
    expect((await place([rec({ id: 'um', at: '2026-10-10T12:00:00Z', text: 'texto um' })])).inserted).toBe(0);
    expect(await ctx.db.$count(messages)).toBe(2);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w server -- test/importer/match.test.ts test/history/place.test.ts`
Expected: FAIL. `match.js` does not exist, and the new `placeRecords` test inserts a second "texto um" (`inserted` is 2).

- [ ] **Step 3: Write the match**

Create `server/src/importer/match.ts`:

```ts
import { and, eq, gte, isNull, lte, ne } from 'drizzle-orm';
import type { Db, Tx } from '../db/client.js';
import { chats, messages, umblerMap } from '../db/schema.js';
import { stripSignature } from '../messages/signature.js';

// Spec 2026-10-21 importar-umbler §8: the Umbler API has no WhatsApp id, so an Umbler message and a WhatsApp-history row
// are the same message when contact, channel, direction, class and text agree within MATCH_WINDOW_MS. Both directions
// use this module: the Umbler import (importer/chats.ts) and the WhatsApp history copy (history/place.ts).

/** §8.4, the calibration knob: the report shows the largest difference found. */
export const MATCH_WINDOW_MS = 10_000;
const MEDIA = new Set(['image', 'video', 'audio', 'document', 'sticker']);

export interface Comparable {
  direction: 'in' | 'out';
  kind: string;
  text: string | null;
  at: Date;
}
export interface Candidate extends Comparable {
  id: string;
  chatId: string;
  authorId: string | null;
  mediaPath: string | null;
}

/** §8.3: the text both sides compare (media without caption = ''). */
export function normalizeText(text: string | null): string {
  return stripSignature((text ?? '').normalize('NFC').replace(/\r\n/g, '\n')).trim();
}

// §8.2-8.3: direction, class (a GIF is an image in Umbler and a video on WhatsApp: both are 'media') and text.
// ponytail: compares the normalized strings, which is the same test as comparing their SHA-256 (spec §8.3).
function signature(c: Comparable): string {
  const cls = c.kind === 'text' ? 'text' : MEDIA.has(c.kind) ? 'media' : 'other';
  return `${c.direction}|${cls}|${normalizeText(c.text)}`;
}

/**
 * §8 one to one: `items` in time order; each takes the free candidate with the same signature and the smallest
 * |Δt| ≤ MATCH_WINDOW_MS (a tie goes to the older one). The answer is aligned with `items` (null = no match).
 * ponytail: O(items × candidates) per page (≤ 250 × a few hundred); index candidates by signature if a page gets slow.
 */
export function pairUp<C extends Comparable>(items: Comparable[], candidates: C[]): Array<{ row: C; diffMs: number } | null> {
  const free = candidates.map((row) => ({ row, sig: signature(row), used: false }));
  return items.map((item) => {
    const sig = signature(item);
    let best: (typeof free)[number] | null = null;
    let bestDiff = Number.POSITIVE_INFINITY;
    for (const f of free) {
      if (f.used || f.sig !== sig) continue;
      const diff = Math.abs(f.row.at.getTime() - item.at.getTime());
      if (diff > MATCH_WINDOW_MS) continue;
      if (diff < bestDiff || (diff === bestDiff && best && f.row.at < best.row.at)) {
        best = f;
        bestDiff = diff;
      }
    }
    if (!best) return null;
    best.used = true;
    return { row: best.row, diffMs: bestDiff };
  });
}

/**
 * §8.1-8.2: the contact's rows on the channel, in any of its chats, in [first - 10 s, last + 10 s], notes left out.
 * 'ours': rows not imported from Umbler (the Umbler import looks for them). 'umbler': rows imported from Umbler that have
 * no WhatsApp id yet (the WhatsApp history copy looks for them).
 */
export async function matchCandidates(
  db: Db | Tx,
  scope: { contactId: string; channelId: string },
  items: Array<{ at: Date }>,
  side: 'ours' | 'umbler',
): Promise<Candidate[]> {
  if (items.length === 0) return [];
  const times = items.map((i) => i.at.getTime());
  const where = and(
    eq(chats.contactId, scope.contactId),
    eq(messages.channelId, scope.channelId),
    ne(messages.kind, 'note'),
    gte(messages.sentAt, new Date(Math.min(...times) - MATCH_WINDOW_MS)),
    lte(messages.sentAt, new Date(Math.max(...times) + MATCH_WINDOW_MS)),
  );
  const imported = and(eq(umblerMap.kind, 'message'), eq(umblerMap.localId, messages.id));
  const query = db
    .select({
      id: messages.id, chatId: messages.chatId, direction: messages.direction, kind: messages.kind, text: messages.body,
      at: messages.sentAt, authorId: messages.authorId, mediaPath: messages.mediaPath,
    })
    .from(messages)
    .innerJoin(chats, eq(chats.id, messages.chatId));
  return side === 'ours'
    ? await query.leftJoin(umblerMap, imported).where(and(where, isNull(umblerMap.localId)))
    : await query.innerJoin(umblerMap, imported).where(and(where, isNull(messages.externalId)));
}

/** Any message imported from Umbler at all: without one, the history copy skips the reverse match (§8, one cheap read per batch). */
export async function hasUmblerMessages(db: Db | Tx): Promise<boolean> {
  const [row] = await db.select({ id: umblerMap.localId }).from(umblerMap).where(eq(umblerMap.kind, 'message')).limit(1);
  return row !== undefined;
}

/**
 * §8 the other way: a WhatsApp history message that is an Umbler row only gives it its WhatsApp id (counted as already
 * there). Covers a QR read after the switch, when the phone sends the last ~3.5 months again. True when it claimed one.
 */
export async function claimUmblerTwin(
  tx: Tx,
  scope: { contactId: string; channelId: string },
  ev: Comparable & { externalId: string },
): Promise<boolean> {
  const [pair] = pairUp([ev], await matchCandidates(tx, scope, [ev], 'umbler'));
  if (!pair) return false;
  await tx.update(messages).set({ externalId: ev.externalId }).where(eq(messages.id, pair.row.id));
  return true;
}
```

- [ ] **Step 4: Use it in `placeRecords`**

In `server/src/history/place.ts`, replace

```ts
import { chats, deletedChats, messages } from '../db/schema.js';
import { getDefaultSectorId } from '../inbox/chats.js';
```

with

```ts
import { chats, deletedChats, messages } from '../db/schema.js';
import { claimUmblerTwin, hasUmblerMessages } from '../importer/match.js';
import { getDefaultSectorId } from '../inbox/chats.js';
```

replace

```ts
    const deletedUntil = new Map(tombs.map((t) => [t.contactId, t.until]));
```

with

```ts
    const deletedUntil = new Map(tombs.map((t) => [t.contactId, t.until]));
    // spec 2026-10-21 importar-umbler §8: rows copied from Umbler have no WhatsApp id; this copy gives them one
    const umbler = await hasUmblerMessages(tx);
```

and replace

```ts
      const until = deletedUntil.get(contact.id);
      if (until && ev.sentAt <= until) continue;
```

with

```ts
      const until = deletedUntil.get(contact.id);
      if (until && ev.sentAt <= until) continue;
      const twin = { direction: ev.direction, kind: ev.kind, text: ev.body, at: ev.sentAt, externalId: ev.externalId };
      if (umbler && (await claimUmblerTwin(tx, { contactId: contact.id, channelId: channel.id }, twin))) continue;
```

- [ ] **Step 5: Run the tests and the type check**

Run: `npm test -w server -- test/importer test/history`
Expected: PASS.

Run: `npm run typecheck -w server`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/importer/match.ts server/src/history/place.ts server/test/importer/match.test.ts server/test/history/place.test.ts
git commit -m "feat(server): match Umbler messages with the WhatsApp history, and give Umbler rows their WhatsApp id" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: One Umbler message as one of our rows (`toIncoming`)

The §7.7 mapping is a pure function, tested without a database.
- Direction: the contact → `in`; `Member`, `Bot` and `External` (the office's phone) → `out`.
- Status: `Read`/`Played` → `read`, `Received` → `delivered`, `Failed`/`Error` → `failed`, the rest → `sent`.
- Notes: `isPrivate` → `note`, `out`, `sent`.
- Text: an `out` message with `prefix` → `formatSignature(content, prefix)`. Media: `file.caption ?? content`.
- Types: `Gif` → image, `File` → document; replies and a bot question with text → text; payment, order, poll, carousel, call attempt and unsupported → `unsupported` with `content`.
- Location and contact card → text (decision §7.7). `matchKind`/`matchText` say how WhatsApp stores them (§8).
- Reactions: the newest of each side.
- Reply id, deleted, edited.
- `Redacted` → `unsupported` with no text.

Timeline items and loose `Reaction` items are no message at all.

**Files:**
- Modify: `server/src/importer/chats.ts` (imports; append the §7.7 section)
- Test: `server/test/importer/incoming.test.ts` (create)

**Interfaces:**
- Consumes: Task 3 `UmblerMessage`; existing `formatSignature`, `messages` (for the `kind`/`status` types).
- Produces: `Incoming`, `toIncoming`.

- [ ] **Step 1: Write the failing test**

Create `server/test/importer/incoming.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { toIncoming } from '../../src/importer/chats.js';
import type { UmblerMessage } from '../../src/importer/umbler.js';
import { umblerMessage } from '../fakes/umbler-api.js';

const AT = '2026-09-01T12:00:00Z';
const m = (over: Record<string, unknown> = {}) => umblerMessage('U1', AT, over) as unknown as UmblerMessage;
const file = (over: Record<string, unknown> = {}) => ({
  url: 'https://utalk-wamedia.s3.amazonaws.com/x/y/z', contentType: 'image/jpeg', originalName: 'foto.jpg', originalSizeBytes: 1234,
  caption: null, failDownload: false, ...over,
});

describe('toIncoming (spec 2026-10-21 importar-umbler §7.7)', () => {
  it('direction and status: the contact is in; Member, Bot and External (the phone) are out', () => {
    expect(toIncoming(m())).toMatchObject({ umblerId: 'U1', at: new Date(AT), direction: 'in', kind: 'text', body: 'texto U1', status: 'read', bot: false });
    expect(toIncoming(m({ source: 'Member', sentByOrganizationMember: { id: 'M_ANA' } }))).toMatchObject({ direction: 'out', authorUmblerId: 'M_ANA' });
    expect(toIncoming(m({ source: 'Bot' }))).toMatchObject({ direction: 'out', bot: true, authorUmblerId: null });
    expect(toIncoming(m({ source: 'External' }))).toMatchObject({ direction: 'out', authorUmblerId: null });
    const status = (messageState: string) => toIncoming(m({ messageState }))!.status;
    expect(['Read', 'Played', 'Received', 'Failed', 'Error', 'Sent', 'Processing'].map(status)).toEqual([
      'read', 'read', 'delivered', 'failed', 'failed', 'sent', 'sent',
    ]);
  });

  it('text: an out message with prefix gets the signature line the client received; media: the caption wins', () => {
    expect(toIncoming(m({ source: 'Member', prefix: 'Financeiro - Ana', content: 'Segue o boleto' }))!.body).toBe('*Financeiro - Ana:*\nSegue o boleto');
    expect(toIncoming(m({ prefix: 'Maria', content: 'Oi' }))!.body).toBe('Oi'); // only the office signs
    expect(toIncoming(m({ messageType: 'Image', content: 'texto', file: file({ caption: 'legenda' }) }))).toMatchObject({
      kind: 'image', body: 'legenda', matchKind: 'image', matchText: 'legenda',
      file: { url: 'https://utalk-wamedia.s3.amazonaws.com/x/y/z', mime: 'image/jpeg', name: 'foto.jpg', size: 1234 },
    });
    expect(toIncoming(m({ messageType: 'Image', content: 'só content', file: file() }))!.body).toBe('só content');
    expect(toIncoming(m({ messageType: 'Image', file: file({ failDownload: true }) }))!.file!.url).toBeNull();
  });

  it('types: Gif is an image, File a document, replies and a bot question with text are text, the rest unsupported', () => {
    const kind = (messageType: string, over: Record<string, unknown> = {}) => toIncoming(m({ messageType, file: file(), ...over }))?.kind;
    expect(['Text', 'Url', 'ListReply', 'ButtonReply', 'QuickReply'].map((t) => kind(t))).toEqual(['text', 'text', 'text', 'text', 'text']);
    expect(['Image', 'Gif', 'Video', 'Audio', 'Sticker', 'File'].map((t) => kind(t))).toEqual(['image', 'image', 'video', 'audio', 'sticker', 'document']);
    expect(kind('List', { content: 'Escolha uma opção' })).toBe('text');
    expect(kind('List', { content: null })).toBe('unsupported');
    expect(['Payment', 'Order', 'Poll', 'Carousel', 'CallAttempt', 'Unsupported'].map((t) => kind(t))).toEqual(Array(6).fill('unsupported'));
    expect(toIncoming(m({ messageType: 'Poll', content: 'Qual horário?' }))).toMatchObject({ body: 'Qual horário?', file: null });
  });

  it('a location and a contact card become text (decision §7.7), and compare as WhatsApp stores them (§8)', () => {
    expect(toIncoming(m({ messageType: 'Location', location: { latitude: '-15.6', longitude: '-56.1', name: 'Escritório', address: null } }))).toMatchObject({
      kind: 'text', body: 'Localização: Escritório https://maps.google.com/?q=-15.6,-56.1', matchKind: 'unsupported', matchText: null,
    });
    expect(toIncoming(m({ messageType: 'Location', location: { latitude: '1', longitude: '2' } }))!.body).toBe('Localização: https://maps.google.com/?q=1,2');
    expect(toIncoming(m({ messageType: 'Contact', contacts: [{ name: 'Dr. Paulo', phoneNumbers: ['+55 65 3322-1100', '+55 65 99999-0000'] }] }))).toMatchObject({
      kind: 'text', body: 'Contato: Dr. Paulo +55 65 3322-1100 +55 65 99999-0000', matchKind: 'unsupported',
    });
  });

  it('a note is out and sent, and never compares with WhatsApp; reactions keep the newest of each side', () => {
    expect(toIncoming(m({ isPrivate: true, source: 'Member', content: 'Ligar amanhã', messageState: 'Received' }))).toMatchObject({
      kind: 'note', direction: 'out', status: 'sent', body: 'Ligar amanhã', matchKind: 'note',
    });
    const reactions = [
      { emoji: '👍', source: 'Contact', eventAtUTC: '2026-09-01T12:01:00Z' },
      { emoji: '❤️', source: 'Contact', eventAtUTC: '2026-09-01T12:03:00Z' },
      { emoji: '🙏', source: 'External', eventAtUTC: '2026-09-01T12:02:00Z' },
    ];
    expect(toIncoming(m({ reactions }))).toMatchObject({ reaction: '❤️', officeReaction: '🙏' });
    expect(toIncoming(m({ inReplyTo: { id: 'U0', chatId: 'X' } }))!.replyUmblerId).toBe('U0');
  });

  it('deleted, edited and redacted; timeline items and loose reactions are not messages', () => {
    expect(toIncoming(m({ messageState: 'Deleted' }))).toMatchObject({ deletedAt: new Date(AT), body: 'texto U1' });
    expect(toIncoming(m({ messageState: 'Edited', latestEdit: { senderAtUTC: '2026-09-01T12:05:00Z' } }))!.editedAt).toEqual(
      new Date('2026-09-01T12:05:00Z'),
    );
    expect(toIncoming(m({ messageState: 'Edited' }))!.editedAt).toEqual(new Date(AT));
    expect(toIncoming(m({ messageState: 'Redacted', messageType: 'Image', file: file() }))).toMatchObject({
      kind: 'unsupported', body: null, redacted: true, file: null,
    });
    expect(toIncoming(m({ _t: 'ChatClosedMetadataModel' }))).toBeNull();
    expect(toIncoming(m({ messageType: 'Reaction' }))).toBeNull();
    expect(toIncoming(m({ _t: 'SentMessageModel' }))).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w server -- test/importer/incoming.test.ts`
Expected: FAIL. `toIncoming` is not exported by `chats.ts`.

- [ ] **Step 3: Map the message**

In `server/src/importer/chats.ts`, replace

```ts
import type { Query, UmblerClient, UmblerMessage } from './umbler.js';
```

with

```ts
import { messages } from '../db/schema.js';
import { formatSignature } from '../messages/signature.js';
import type { Query, UmblerClient, UmblerMessage } from './umbler.js';
```

and append:

```ts
// ---------- §7.7: one Umbler message as one of our rows ----------

type Kind = (typeof messages.$inferSelect)['kind'];
type Status = (typeof messages.$inferSelect)['status'];

export interface Incoming {
  umblerId: string;
  at: Date;
  direction: 'in' | 'out';
  kind: Kind;
  body: string | null;
  /** §8.2: what the WhatsApp history stored for it (a location or a contact card is 'unsupported' with no text there) */
  matchKind: Kind;
  matchText: string | null;
  authorUmblerId: string | null;
  bot: boolean;
  status: Status;
  reaction: string | null;
  officeReaction: string | null;
  replyUmblerId: string | null;
  deletedAt: Date | null;
  editedAt: Date | null;
  redacted: boolean;
  file: { url: string | null; mime: string | null; name: string | null; size: number | null } | null;
}

const KEPT = new Set(['MessageModel', 'SentMessageModel']);
const STATUS: Record<string, Status> = { Read: 'read', Played: 'read', Received: 'delivered', Failed: 'failed', Error: 'failed' };
const TEXT_TYPES = new Set(['Text', 'Url', 'ListReply', 'ButtonReply', 'QuickReply']);
const MEDIA_TYPES: Record<string, Kind> = { Image: 'image', Gif: 'image', Video: 'video', Audio: 'audio', Sticker: 'sticker', File: 'document' };

function latestReaction(m: UmblerMessage, sources: string[]): string | null {
  const list = (m.reactions ?? []).filter((r) => sources.includes(r.source ?? ''));
  list.sort((a, b) => Date.parse(a.eventAtUTC) - Date.parse(b.eventAtUTC));
  return list.at(-1)?.emoji ?? null;
}

function locationText(l: NonNullable<UmblerMessage['location']>): string {
  const label = (l.name || l.address || '').trim();
  return `Localização: ${label ? `${label} ` : ''}https://maps.google.com/?q=${l.latitude},${l.longitude}`;
}

function contactText(list: NonNullable<UmblerMessage['contacts']>): string {
  return list.map((c) => ['Contato:', c.name?.trim(), ...(c.phoneNumbers ?? [])].filter(Boolean).join(' ')).join('\n');
}

/** §7.7; null for what is never a message of its own (timeline items, loose reactions). */
export function toIncoming(m: UmblerMessage): Incoming | null {
  if (!KEPT.has(m._t) || m.messageType === 'Reaction') return null;
  const at = new Date(m.eventAtUTC);
  const type = m.messageType ?? 'Unsupported';
  const content = m.content ?? null;
  const note = m.isPrivate === true;
  const redacted = !note && m.messageState === 'Redacted';
  const direction = note || m.source !== 'Contact' ? 'out' : 'in'; // Member, Bot and External (the phone) are the office
  let kind: Kind;
  let body: string | null;
  let asStored: Kind | null = null; // how the WhatsApp history stores it, when that differs
  if (note) {
    kind = 'note';
    body = content;
  } else if (redacted) {
    kind = 'unsupported';
    body = null;
  } else if (type === 'Location' && m.location) {
    kind = 'text';
    body = locationText(m.location);
    asStored = 'unsupported';
  } else if (type === 'Contact' && m.contacts?.length) {
    kind = 'text';
    body = contactText(m.contacts);
    asStored = 'unsupported';
  } else if (TEXT_TYPES.has(type) || (type === 'List' && content)) {
    kind = 'text';
    // the signature line the client received, as this system stores its own sends
    body = direction === 'out' && m.prefix && content !== null ? formatSignature(content, m.prefix) : content;
  } else if (MEDIA_TYPES[type]) {
    kind = MEDIA_TYPES[type]!;
    body = m.file?.caption ?? content;
  } else {
    kind = 'unsupported'; // Payment, Order, Poll, Carousel, CallAttempt, Unsupported
    body = content;
  }
  const media = !note && !redacted && MEDIA_TYPES[type] !== undefined;
  return {
    umblerId: m.id,
    at,
    direction,
    kind,
    body,
    matchKind: asStored ?? kind,
    matchText: asStored ? null : body,
    authorUmblerId: m.sentByOrganizationMember?.id ?? null,
    bot: m.source === 'Bot',
    status: note ? 'sent' : (STATUS[m.messageState ?? ''] ?? 'sent'),
    reaction: latestReaction(m, ['Contact']),
    officeReaction: latestReaction(m, ['Member', 'External']),
    replyUmblerId: m.inReplyTo?.id ?? null,
    deletedAt: m.messageState === 'Deleted' ? at : null,
    editedAt: m.messageState === 'Edited' ? new Date(m.latestEdit?.senderAtUTC ?? m.eventAtUTC) : null,
    redacted,
    file: media
      ? {
          url: m.file?.failDownload ? null : (m.file?.url ?? null),
          mime: m.file?.contentType ?? null,
          name: m.file?.originalName ?? null,
          size: m.file?.originalSizeBytes ?? null,
        }
      : null,
  };
}

const byTime = (a: Incoming, b: Incoming) => a.at.getTime() - b.at.getTime() || a.umblerId.localeCompare(b.umblerId);
```

- [ ] **Step 4: Run the tests and the type check**

Run: `npm test -w server -- test/importer/incoming.test.ts`
Expected: PASS.

Run: `npm run typecheck -w server`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add server/src/importer/chats.ts server/test/importer/incoming.test.ts
git commit -m "feat(server): map an Umbler message to our message row (types, signature, notes, reactions, location, contact)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Copy one chat: finished, open, joined, and its files

`importChat` copies one Umbler chat page by page (`Take=250`).

**What is skipped, before any message call:**
- a channel set to "Não importar";
- a chat whose `umbler_map` row points at a chat that is gone, which was deleted here and never comes back;
- a contact with no phone nor LID;
- a finished closed chat (§9.2).

A contact that only appears in a chat is created from `chat.contact` (§7.4).

**How each page is written (§7.8):**
1. Decide, reading only: what is mapped already, and what §8 matches. The match is Task 9; this task leaves it empty.
2. Download the files of the new rows, and of the mapped rows whose file was unavailable. They go outside any transaction, 4 at a time, with the free space checked before each one.
3. Write the page in one transaction:
   - the chat, the first time;
   - the rows and their `umbler_map` rows;
   - the summary;
   - the counters.

**The chat, the first time (§7.6):**
- Open, with no open chat of the contact here: open, in the mapped sector, owned by the mapped user only if active, keeping `waiting`, `waiting_since`, `private` and `unread`.
- Open, with an open chat of the contact here: **join** it (decision). Ours keeps its sector, owner, privacy and `waiting`; `unread` adds up; the tags are united.
- Finished: closed, with the original dates, the sector and owner (inactive too), `private`, and the `closed` event at `closedAtUTC` by `closedBy`.

**When the chat is complete:**
- the `waiting_since` fallback (the last contact message);
- `umbler_imported` at `createdAtUTC`, once;
- `done_at`, unless a file failed for now;
- an open chat publishes `chat.updated` once.

**A second run (§9.2):**
- A finished open chat is read again from its last imported message − 1 ms.
- An unfinished chat is read from the start. What is mapped is dropped, and its unavailable files are tried again.
- The state, sector, owner and tags of an imported chat never change.

A tombstone (`deleted_chats`) keeps out a new chat's messages up to `until`.

**Files:**
- Modify: `server/src/importer/chats.ts` (imports; append the files and chats sections)
- Test: `server/test/importer/chats.test.ts` (create)

**Interfaces:**
- Consumes:
  - Task 4 `upsertContact`; Task 7 `toIncoming`; Task 6 `Candidate`;
  - Task 3 `maps`, `saveProgress`, `checkStop`, `isGone`, `UmblerError`;
  - existing `messagePreview`, `saveMedia`, `stripSignature`.
- Produces: `MIN_FREE_BYTES`, `importChat`.

- [ ] **Step 1: Write the failing test**

Create `server/test/importer/chats.test.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  botRuns, chatEvents, chatTags, chats, contacts, deletedChats, messages, sectors, tags, umblerMap, users,
} from '../../src/db/schema.js';
import { importChat } from '../../src/importer/chats.js';
import { UmblerError, importCatalog, type ImportRun } from '../../src/importer/umbler.js';
import { PDF, umblerChat, umblerMessage } from '../fakes/umbler-api.js';
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

type Obj = Record<string, unknown>;
/** Puts a chat and its messages in the fake Umbler. */
function given(chat: Obj, list: Obj[]): Obj {
  w.fake.world.chats.push(chat);
  w.fake.world.messages[chat.id as string] = list;
  return chat;
}
const localOf = async (umblerId: string) =>
  (await w.ctx.db.select().from(umblerMap).where(and(eq(umblerMap.kind, 'chat'), eq(umblerMap.umblerId, umblerId))))[0];
const chatOf = async (umblerId: string) => {
  const m = await localOf(umblerId);
  return m ? (await w.ctx.db.select().from(chats).where(eq(chats.id, m.localId)))[0] : undefined;
};
const rowsOf = (chatId: string) => w.ctx.db.select().from(messages).where(eq(messages.chatId, chatId)).orderBy(asc(messages.sentAt));
const eventsOf = (chatId: string) => w.ctx.db.select().from(chatEvents).where(eq(chatEvents.chatId, chatId)).orderBy(asc(chatEvents.createdAt));
const userId = async (email: string) => (await w.ctx.db.select().from(users).where(eq(users.email, email)))[0]!.id;
const sectorId = async (name: string) => (await w.ctx.db.select().from(sectors).where(eq(sectors.name, name)))[0]!.id;
const tagId = async (name: string) => (await w.ctx.db.select().from(tags).where(eq(tags.name, name)))[0]!.id;
const relativeCalls = () => w.fake.calls(/relative-messages/);
const file = (name: string, over: Obj = {}) => ({
  url: w.fake.fileUrl(name), contentType: 'application/pdf', originalName: name, originalSizeBytes: PDF.length, caption: null, failDownload: false,
  ...over,
});

describe('a finished chat (spec 2026-10-21 importar-umbler §7.6, §7.7)', () => {
  it('lands in Finalizados with its dates, sector, owner (inactive too), privacy, tags, messages and the closed event', async () => {
    const chat = given(
      umblerChat({
        open: false, createdAtUTC: '2026-08-01T10:00:00Z', closedAtUTC: '2026-08-01T11:00:00Z', sector: { id: 'SEC3' },
        organizationMember: { id: 'M_CARLA' }, private: true, tags: [{ id: 'TAG1' }], closedBy: { id: 'M_ANA' },
      }),
      [
        umblerMessage('U1', '2026-08-01T10:00:00Z', { content: 'Bom dia, preciso de ajuda', messageState: 'Read' }),
        umblerMessage('U2', '2026-08-01T10:01:00Z', {
          source: 'Member', sentByOrganizationMember: { id: 'M_CARLA' }, prefix: 'Trabalhista - Carla', content: 'Claro!',
          inReplyTo: { id: 'U1' }, messageState: 'Received', reactions: [{ emoji: '👍', source: 'Contact', eventAtUTC: '2026-08-01T10:02:00Z' }],
        }),
        umblerMessage('U3', '2026-08-01T10:03:00Z', { isPrivate: true, source: 'Member', sentByOrganizationMember: { id: 'M_ANA' }, content: 'Cliente antigo' }),
        umblerMessage('U4', '2026-08-01T10:04:00Z', { content: 'apaguei', messageState: 'Deleted' }),
        umblerMessage('U5', '2026-08-01T10:05:00Z', { source: 'Bot', content: 'Atendimento encerrado.' }),
      ],
    );

    expect(await importChat(run, chat as never, 'closed')).toBe(true);

    const local = (await chatOf(chat.id as string))!;
    const carla = await userId('carla@antigo.test');
    expect(local).toMatchObject({
      state: 'closed', history: false, sectorId: await sectorId('Trabalhista'), ownerId: carla, private: true, unread: 0, waiting: false,
      triagePending: false, createdAt: new Date('2026-08-01T10:00:00Z'), closedAt: new Date('2026-08-01T11:00:00Z'),
      lastMessageAt: new Date('2026-08-01T10:05:00Z'), lastMessagePreview: 'Atendimento encerrado.',
    });
    expect((await w.ctx.db.select().from(chatTags).where(eq(chatTags.chatId, local.id))).map((t) => t.tagId)).toEqual([await tagId('Cliente')]);
    const rows = await rowsOf(local.id);
    expect(rows.map(({ direction, kind, body, authorId, status, externalId }) => ({ direction, kind, body, authorId, status, externalId }))).toEqual([
      { direction: 'in', kind: 'text', body: 'Bom dia, preciso de ajuda', authorId: null, status: 'read', externalId: null },
      { direction: 'out', kind: 'text', body: '*Trabalhista - Carla:*\nClaro!', authorId: carla, status: 'delivered', externalId: null },
      { direction: 'out', kind: 'note', body: 'Cliente antigo', authorId: w.s.agentA.id, status: 'sent', externalId: null },
      { direction: 'in', kind: 'text', body: 'apaguei', authorId: null, status: 'sent', externalId: null },
      { direction: 'out', kind: 'text', body: 'Atendimento encerrado.', authorId: null, status: 'read', externalId: null },
    ]);
    expect(rows[1]).toMatchObject({ replyToId: rows[0]!.id, reaction: '👍', sentAt: new Date('2026-08-01T10:01:00Z') });
    expect(rows[3]).toMatchObject({ deletedAt: new Date('2026-08-01T10:04:00Z'), deletedSource: 'contact' });
    expect((await eventsOf(local.id)).map(({ kind, data, authorId, createdAt }) => ({ kind, data, authorId, createdAt }))).toEqual([
      { kind: 'umbler_imported', data: { count: 5 }, authorId: null, createdAt: new Date('2026-08-01T10:00:00Z') },
      { kind: 'closed', data: {}, authorId: w.s.agentA.id, createdAt: new Date('2026-08-01T11:00:00Z') },
    ]);
    expect((await localOf(chat.id as string))!.doneAt).not.toBeNull();
    expect(run.progress.messages).toMatchObject({ total: 5, notes: 1, bot: 1, unknownAuthor: 0 });
    expect(run.progress.chats.closed).toBe(1);
    expect(w.ctx.hub.events.filter((e) => e.type === 'chat')).toEqual([]); // closed chats never publish
    expect(await w.ctx.db.$count(contacts, eq(contacts.phone, '5565999998888'))).toBe(1); // created from chat.contact
  });
});

describe('an open chat (§7.6)', () => {
  it('keeps sector, active owner, waiting and unread; waiting_since falls back to the last contact message; publishes once', async () => {
    const chat = given(umblerChat({ waiting: true, waitingSinceUTC: null, totalUnread: 2 }), [
      umblerMessage('U1', '2026-10-20T10:00:00Z'),
      umblerMessage('U2', '2026-10-20T10:01:00Z', { source: 'Member', sentByOrganizationMember: { id: 'M_ANA' } }),
      umblerMessage('U3', '2026-10-20T10:02:00Z'),
    ]);
    const inactive = given(
      umblerChat({
        organizationMember: { id: 'M_CARLA' }, waiting: true, waitingSinceUTC: '2026-10-20T09:00:00Z',
        contact: { id: 'C2', name: 'João Teste', phoneNumber: '5565988887777', lid: null },
      }),
      [umblerMessage('U9', '2026-10-20T09:00:00Z')],
    );

    await importChat(run, chat as never, 'open');
    await importChat(run, inactive as never, 'open');

    const local = (await chatOf(chat.id as string))!;
    expect(local).toMatchObject({
      state: 'open', sectorId: w.s.sectorA, ownerId: w.s.agentA.id, waiting: true, waitingSince: new Date('2026-10-20T10:02:00Z'),
      unread: 2, private: false, triagePending: false, history: false, closedAt: null,
    });
    expect(await chatOf(inactive.id as string)).toMatchObject({ ownerId: null, waitingSince: new Date('2026-10-20T09:00:00Z') }); // to the queue
    expect(w.ctx.hub.events.filter((e) => e.type === 'chat' && e.chatId === local.id)).toHaveLength(1);
    expect(run.progress.chats).toMatchObject({ openCreated: 2, openMerged: 0 });
    expect(w.ctx.wa.sent).toEqual([]); // no WhatsApp send, no triage, no bot
    expect(await w.ctx.db.$count(botRuns)).toBe(0);
  });

  it("joins the contact's open chat here (decision §7.6): it stays the current one, unread adds up, tags unite", async () => {
    const [maria] = await w.ctx.db.insert(contacts).values({ phone: '5565999998888', name: 'Maria' }).returning();
    const [ours] = await w.ctx.db
      .insert(chats)
      .values({ contactId: maria!.id, channelId: w.s.channelId, sectorId: w.s.sectorB, ownerId: w.s.agentB.id, unread: 1, lastMessageAt: new Date('2026-10-21T08:00:00Z') })
      .returning();
    await w.ctx.db.insert(chatTags).values({ chatId: ours!.id, tagId: await tagId('Prospecção') });
    const chat = given(umblerChat({ tags: [{ id: 'TAG1' }], totalUnread: 2, waiting: true, private: true }), [
      umblerMessage('U1', '2026-10-20T10:00:00Z'),
      umblerMessage('U2', '2026-10-20T10:01:00Z'),
    ]);

    await importChat(run, chat as never, 'open');

    const local = (await chatOf(chat.id as string))!;
    expect(local).toMatchObject({ id: ours!.id, sectorId: w.s.sectorB, ownerId: w.s.agentB.id, waiting: false, private: false, unread: 3 });
    expect(local.lastMessageAt).toEqual(new Date('2026-10-20T10:01:00Z')); // the newest message it has
    expect((await w.ctx.db.select().from(chatTags).where(eq(chatTags.chatId, ours!.id))).map((t) => t.tagId).sort()).toEqual(
      [await tagId('Cliente'), await tagId('Prospecção')].sort(),
    );
    expect((await eventsOf(ours!.id)).map((e) => [e.kind, e.data])).toEqual([['umbler_imported', { count: 2, merged: true }]]);
    expect(run.progress.chats).toMatchObject({ openCreated: 0, openMerged: 1 });
  });
});

describe('files (§7.8)', () => {
  it('downloads up to 4 at a time without Authorization; gone, missing or no link → unavailable; a temporary failure is retried later', async () => {
    for (const name of ['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf', 'e.pdf']) w.fake.world.files[name] = { body: PDF, mime: 'application/pdf', delayMs: 30 };
    w.fake.world.files['proibido.pdf'] = { body: PDF, mime: 'application/pdf', status: 403 };
    w.fake.faults.push({ path: /^\/s3\/e\.pdf$/, status: 500, times: 4 });
    const doc = (id: string, minute: number, f: Obj) =>
      umblerMessage(id, `2026-08-01T10:0${minute}:00Z`, { messageType: 'File', content: null, file: f });
    const chat = given(umblerChat({ open: false, closedAtUTC: '2026-08-01T11:00:00Z' }), [
      doc('U1', 1, file('a.pdf')), doc('U2', 2, file('b.pdf')), doc('U3', 3, file('c.pdf')), doc('U4', 4, file('d.pdf')),
      doc('U5', 5, file('proibido.pdf')), doc('U6', 6, file('sumiu.pdf')), doc('U7', 7, file('x.pdf', { failDownload: true })),
      doc('U8', 8, file('e.pdf')),
    ]);

    await importChat(run, chat as never, 'closed');

    const local = (await chatOf(chat.id as string))!;
    const rows = await rowsOf(local.id);
    expect(rows.map((r) => [r.kind, r.mediaName, r.mediaStatus, r.mediaPath !== null])).toEqual([
      ['document', 'a.pdf', null, true], ['document', 'b.pdf', null, true], ['document', 'c.pdf', null, true], ['document', 'd.pdf', null, true],
      ['document', 'proibido.pdf', 'expired', false], ['document', 'sumiu.pdf', 'expired', false], ['document', 'x.pdf', 'expired', false],
      ['document', 'e.pdf', 'expired', false],
    ]);
    expect(await readFile(join(w.ctx.config.mediaDir, rows[0]!.mediaPath!))).toEqual(PDF);
    expect(rows[0]).toMatchObject({ mediaMime: 'application/pdf', mediaSize: PDF.length });
    expect(rows[0]!.mediaSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(w.fake.stats.maxConcurrentFiles).toBeLessThanOrEqual(4);
    expect(run.progress.files).toEqual({ saved: 4, bytes: 4 * PDF.length, expired: 4 });
    expect((await localOf(chat.id as string))!.doneAt).toBeNull(); // e.pdf failed for now: not done

    await importChat(run, chat as never, 'closed'); // a new run: reads the chat again and retries the unavailable ones
    expect((await rowsOf(local.id)).map((r) => r.mediaStatus)).toEqual([null, null, null, null, 'expired', 'expired', 'expired', null]);
    expect(run.progress.files).toEqual({ saved: 5, bytes: 5 * PDF.length, expired: 3 });
    expect((await localOf(chat.id as string))!.doneAt).not.toBeNull();
    expect(await w.ctx.db.$count(messages)).toBe(8);
  });

  it('stops with disk_full below 2 GB, before the file', async () => {
    w.free.bytes = 1024 ** 3;
    const chat = given(umblerChat({ open: false, closedAtUTC: '2026-08-01T11:00:00Z' }), [
      umblerMessage('U1', '2026-08-01T10:00:00Z', { messageType: 'File', file: file('a.pdf') }),
    ]);
    const err = await importChat(run, chat as never, 'closed').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UmblerError);
    expect(err).toMatchObject({ code: 'disk_full' });
    expect(w.fake.calls(/^\/s3\//)).toEqual([]);
    expect(await chatOf(chat.id as string)).toBeUndefined();
  });
});

describe('what is skipped (§7.3, §7.6)', () => {
  it('channel "Não importar", no message at all, no phone nor LID, the tombstone, and a chat deleted here', async () => {
    const web = given(umblerChat({ channel: { _t: 'ChatWebsiteWidgetChannelReferenceModel', id: 'CH_WEB', name: 'Site' } }), [
      umblerMessage('W1', '2026-08-01T10:00:00Z'),
    ]);
    const empty = given(umblerChat(), []);
    const nobody = given(umblerChat({ contact: { id: 'C4', name: 'Sem Número', phoneNumber: null, lid: null } }), [umblerMessage('N1', '2026-08-01T10:00:00Z')]);
    expect(await importChat(run, web as never, 'open')).toBe(false);
    expect(await importChat(run, empty as never, 'open')).toBe(true);
    expect(await importChat(run, nobody as never, 'open')).toBe(false);
    expect(relativeCalls().map((r) => r.path)).toEqual([`/api/v1/chats/${empty.id}/relative-messages/`]);
    expect(await chatOf(empty.id as string)).toBeUndefined();

    // a chat an admin deleted here: messages up to the tombstone stay out of a new chat
    const [maria] = await w.ctx.db.select().from(contacts).where(eq(contacts.phone, '5565999998888'));
    await w.ctx.db.insert(deletedChats).values({ contactId: maria!.id, channelId: w.s.channelId, until: new Date('2026-08-01T10:30:00Z'), deletedAt: new Date() });
    const after = given(umblerChat({ open: false, closedAtUTC: '2026-08-01T12:00:00Z' }), [
      umblerMessage('T1', '2026-08-01T10:00:00Z'),
      umblerMessage('T2', '2026-08-01T11:00:00Z'),
    ]);
    await importChat(run, after as never, 'closed');
    const local = (await chatOf(after.id as string))!;
    expect((await rowsOf(local.id)).map((r) => r.body)).toEqual(['texto T2']);

    await w.ctx.db.delete(chats).where(eq(chats.id, local.id)); // deleted here: never comes back
    expect(await importChat(run, after as never, 'closed')).toBe(false);
    expect(await w.ctx.db.$count(chats, eq(chats.id, local.id))).toBe(0);
    expect(run.progress.chats).toMatchObject({ skippedChannel: 1, skippedEmpty: 1, skippedNoAddress: 1, skippedDeleted: 1, closed: 1 });
  });
});

describe('a second run (§9.2)', () => {
  it('a finished closed chat costs no call; an open one is read again from its last message - 1 ms and only adds what is new', async () => {
    const done = given(umblerChat({ open: false, closedAtUTC: '2026-08-01T11:00:00Z' }), [umblerMessage('D1', '2026-08-01T10:00:00Z')]);
    await importChat(run, done as never, 'closed');
    expect(await importChat(run, done as never, 'closed')).toBe(false);
    expect(relativeCalls()).toHaveLength(1);

    const open = given(umblerChat({ contact: { id: 'C2', name: 'João Teste', phoneNumber: '5565988887777', lid: null } }), [
      umblerMessage('O1', '2026-10-20T10:00:00Z'),
    ]);
    await importChat(run, open as never, 'open');
    w.fake.world.messages[open.id as string]!.push(umblerMessage('O2', '2026-10-20T10:05:00Z'));
    open.sector = { id: 'SEC1' }; // changed in Umbler meanwhile: a new run never changes an imported chat
    await importChat(run, open as never, 'open');

    const local = (await chatOf(open.id as string))!;
    expect((await rowsOf(local.id)).map((r) => r.body)).toEqual(['texto O1', 'texto O2']);
    expect(local.sectorId).toBe(w.s.sectorA);
    expect(relativeCalls().at(-1)!.query.get('FromEventUTC')).toBe('2026-10-20T09:59:59.999Z');
    expect((await eventsOf(local.id)).filter((e) => e.kind === 'umbler_imported')).toHaveLength(1);
  });

  it('reads 250 at a time, the next page from the last eventAtUTC - 1 ms, dropping ids it has seen', async () => {
    const list = Array.from({ length: 260 }, (_, i) => umblerMessage(`P${i}`, new Date(Date.UTC(2026, 7, 1, 10, 0, 0) + i * 1000).toISOString()));
    const chat = given(umblerChat({ open: false, closedAtUTC: '2026-08-01T12:00:00Z' }), list);
    await importChat(run, chat as never, 'closed');
    expect(relativeCalls().map((r) => [r.query.get('FromEventUTC'), r.query.get('Take')])).toEqual([
      ['2000-01-01T00:00:00.000Z', '250'],
      ['2026-08-01T10:04:08.999Z', '250'],
    ]);
    expect(await w.ctx.db.$count(messages)).toBe(260);
    expect(run.progress.messages.total).toBe(260);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w server -- test/importer/chats.test.ts`
Expected: FAIL. `importChat` is not exported by `chats.ts`.

- [ ] **Step 3: Copy the chat**

In `server/src/importer/chats.ts`, replace

```ts
import { messages } from '../db/schema.js';
import { formatSignature } from '../messages/signature.js';
import type { Query, UmblerClient, UmblerMessage } from './umbler.js';
```

with

```ts
import { randomUUID } from 'node:crypto';
import { and, count, desc, eq, inArray, isNull, max, min, ne, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { chatEvents, chatTags, chats, contacts, deletedChats, messages, umblerMap } from '../db/schema.js';
import { messagePreview } from '../messages/dto.js';
import { saveMedia } from '../messages/media.js';
import { formatSignature, stripSignature } from '../messages/signature.js';
import type { Candidate } from './match.js';
import {
  UmblerError, checkStop, isGone, maps, saveProgress, upsertContact, type ImportRun, type Query, type UmblerChat, type UmblerClient,
  type UmblerMessage,
} from './umbler.js';
```

and append:

```ts
// ---------- files (§7.8) ----------

const FILE_CONCURRENCY = 4;
/** §7.8: below this, the import stops with disk_full before the next file. */
export const MIN_FREE_BYTES = 2 * 1024 ** 3;

type Saved = { path: string; size: number; sha256: string; mime: string };
type FileOutcome = Saved | 'expired' | 'temporary';
interface FileJob { key: string; file: NonNullable<Incoming['file']> }

const isSaved = (f: FileOutcome | undefined): f is Saved => typeof f === 'object';
const mediaOf = (s: Saved) => ({ mediaPath: s.path, mediaSize: s.size, mediaSha256: s.sha256, mediaMime: s.mime, mediaStatus: null });

/** Up to 4 downloads at a time, outside any transaction; the free space is checked before each file. */
async function downloadFiles(run: ImportRun, jobs: FileJob[]): Promise<Map<string, FileOutcome>> {
  const out = new Map<string, FileOutcome>();
  const dir = run.ctx.config.mediaDir;
  let next = 0;
  let full = false;
  async function worker(): Promise<void> {
    while (!full && next < jobs.length) {
      const job = jobs[next++]!;
      if (!job.file.url) {
        out.set(job.key, 'expired'); // no link, or Umbler itself failed to download it
        continue;
      }
      if ((await run.freeBytes(dir)) < MIN_FREE_BYTES) {
        full = true;
        throw new UmblerError('disk_full');
      }
      const got = await run.client.file(job.file.url);
      if ('failed' in got) {
        out.set(job.key, got.failed === 'gone' ? 'expired' : 'temporary');
        continue;
      }
      const mime = job.file.mime || got.mime;
      out.set(job.key, { ...(await saveMedia(dir, got.data, mime, job.file.name)), mime });
    }
  }
  await Promise.all(Array.from({ length: Math.min(FILE_CONCURRENCY, jobs.length) }, worker));
  return out;
}

// ---------- chats (§7.6) ----------

interface ChatRun {
  state: 'open' | 'closed';
  localId: string | null; // our chat: created, joined (merged) or mapped by an earlier run
  merged: boolean;
  contactId: string;
  channelId: string;
  until: Date | null; // deleted_chats tombstone of a new chat (§7.6)
  temporary: boolean; // a file failed for now: no done_at, so a new run retries it (§7.8)
}

/** The contact of the chat: mapped, or created from chat.contact (§7.4). Null = skip (deleted here, or no phone nor LID). */
async function contactOf(run: ImportRun, chat: UmblerChat): Promise<string | null> {
  const { db } = run.ctx;
  const p = run.progress;
  const [mapped] = await db
    .select({ localId: umblerMap.localId })
    .from(umblerMap)
    .where(and(eq(umblerMap.kind, 'contact'), eq(umblerMap.umblerId, chat.contact.id)));
  if (mapped) {
    const [found] = await db.select({ id: contacts.id }).from(contacts).where(eq(contacts.id, mapped.localId));
    if (!found) p.chats.skippedDeleted += 1; // the contact was deleted here: it does not come back
    return found?.id ?? null;
  }
  const id = await db.transaction(async (tx) => {
    const created = await upsertContact(tx, chat.contact, p.contacts);
    await saveProgress(tx, run);
    return created;
  });
  if (!id) p.chats.skippedNoAddress += 1;
  return id;
}

async function lastImportedAt(run: ImportRun, chatId: string): Promise<Date | null> {
  const [row] = await run.ctx.db
    .select({ at: max(messages.sentAt) })
    .from(messages)
    .innerJoin(umblerMap, and(eq(umblerMap.kind, 'message'), eq(umblerMap.localId, messages.id)))
    .where(eq(messages.chatId, chatId));
  return row?.at ?? null;
}

/** §7.6: a new open chat (or the contact's open chat here: join), or a closed one in Finalizados with its `closed` event. */
async function createChat(tx: Tx, run: ImportRun, chat: UmblerChat, st: ChatRun): Promise<string> {
  const m = maps(run);
  const p = run.progress;
  const sectorId = (chat.sector && m.sectors[chat.sector.id]) || m.defaultSector;
  const member = chat.organizationMember ? m.members[chat.organizationMember.id] : undefined;
  const createdAt = new Date(chat.createdAtUTC);
  const base = {
    id: randomUUID(), contactId: st.contactId, channelId: st.channelId, sectorId, private: chat.private ?? false,
    triagePending: false, history: false, createdAt,
  };
  let chatId: string;
  if (st.state === 'open') {
    const [row] = await tx
      .insert(chats)
      .values({
        ...base,
        ownerId: member?.active ? member.id : null, // inactive or "Sem atendente": the sector's queue
        state: 'open',
        waiting: chat.waiting ?? false,
        waitingSince: chat.waiting && chat.waitingSinceUTC ? new Date(chat.waitingSinceUTC) : null,
        unread: chat.totalUnread ?? 0,
      })
      .onConflictDoNothing() // chats_one_open_per_contact_channel
      .returning({ id: chats.id });
    if (row) {
      chatId = row.id;
      p.chats.openCreated += 1;
    } else {
      // decision §7.6: join. The chat here stays the current one (sector, owner, privacy, waiting); unread adds up.
      const [open] = await tx
        .select({ id: chats.id })
        .from(chats)
        .where(and(eq(chats.contactId, st.contactId), eq(chats.channelId, st.channelId), eq(chats.state, 'open')));
      if (!open) throw new Error('umbler: open chat insert conflicted but none was found');
      chatId = open.id;
      await tx.update(chats).set({ unread: sql`${chats.unread} + ${chat.totalUnread ?? 0}` }).where(eq(chats.id, chatId));
      st.merged = true;
      p.chats.openMerged += 1;
    }
  } else {
    const closedAt = chat.closedAtUTC ? new Date(chat.closedAtUTC) : createdAt;
    const [row] = await tx
      .insert(chats)
      .values({ ...base, ownerId: member?.id ?? null, state: 'closed', waiting: false, unread: 0, closedAt })
      .returning({ id: chats.id });
    chatId = row!.id;
    const closedBy = (chat.closedBy && m.members[chat.closedBy.id]?.id) || null;
    // "Conversa finalizada por X" at the original time (addEvent would stamp clock_timestamp())
    await tx.insert(chatEvents).values({ id: randomUUID(), chatId, kind: 'closed', data: {}, authorId: closedBy, createdAt: closedAt });
    p.chats.closed += 1;
  }
  const tagIds = [...new Set((chat.tags ?? []).flatMap((t) => (m.tags[t.id] ? [m.tags[t.id]!] : [])))];
  if (tagIds.length) await tx.insert(chatTags).values(tagIds.map((tagId) => ({ chatId, tagId }))).onConflictDoNothing();
  await tx.insert(umblerMap).values({ kind: 'chat', umblerId: chat.id, localId: chatId });
  return chatId;
}

/**
 * last_message_at / preview from the newest message that is not a note. A WhatsApp-history chat also spans its
 * messages, and is deleted when a match took its last one (§8).
 */
async function refreshChat(tx: Tx, chatId: string): Promise<'removed' | 'open' | 'closed'> {
  const [chat] = await tx.select({ state: chats.state, history: chats.history }).from(chats).where(eq(chats.id, chatId));
  if (!chat) return 'removed';
  const [last] = await tx
    .select({ kind: messages.kind, body: messages.body, direction: messages.direction, sentAt: messages.sentAt })
    .from(messages)
    .where(and(eq(messages.chatId, chatId), ne(messages.kind, 'note')))
    .orderBy(desc(messages.sentAt))
    .limit(1);
  const patch: Partial<typeof chats.$inferInsert> = {
    lastMessageAt: last?.sentAt ?? null,
    // the preview is unsigned, as for this system's own sends
    lastMessagePreview: last ? messagePreview(last.kind, last.direction === 'out' && last.body ? stripSignature(last.body) : last.body) : null,
  };
  if (chat.history) {
    const [span] = await tx.select({ first: min(messages.sentAt), last: max(messages.sentAt) }).from(messages).where(eq(messages.chatId, chatId));
    if (!span?.first) {
      await tx.delete(chats).where(eq(chats.id, chatId));
      return 'removed';
    }
    patch.createdAt = span.first;
    patch.closedAt = span.last;
  }
  await tx.update(chats).set(patch).where(eq(chats.id, chatId));
  return chat.state;
}

async function replyOf(tx: Tx, i: Incoming, page: Map<string, string>): Promise<string | null> {
  if (!i.replyUmblerId) return null;
  const here = page.get(i.replyUmblerId);
  if (here) return here;
  const [row] = await tx
    .select({ id: messages.id })
    .from(umblerMap)
    .innerJoin(messages, eq(messages.id, umblerMap.localId))
    .where(and(eq(umblerMap.kind, 'message'), eq(umblerMap.umblerId, i.replyUmblerId)));
  return row?.id ?? null; // §7.7: quoted message imported already (any chat), else none
}

/** §7.8 (1) decide reading only, (2) download outside any transaction, (3) write the page in one transaction. */
async function placePage(run: ImportRun, chat: UmblerChat, st: ChatRun, all: Incoming[]): Promise<void> {
  const { ctx } = run;
  const m = maps(run);
  const p = run.progress;
  const known = new Set(run.analysis.members.map((x) => x.id));
  const items = !st.localId && st.until ? all.filter((i) => i.at > st.until!) : all; // tombstone: only for a new chat
  if (items.length === 0) return;

  // (1) what is in umbler_map already (a gone local row stays gone), and what §8 matches
  const mappedRows = await ctx.db
    .select({ umblerId: umblerMap.umblerId, id: messages.id, mediaPath: messages.mediaPath, mediaStatus: messages.mediaStatus })
    .from(umblerMap)
    .leftJoin(messages, eq(messages.id, umblerMap.localId))
    .where(and(eq(umblerMap.kind, 'message'), inArray(umblerMap.umblerId, items.map((i) => i.umblerId))));
  const mapped = new Map(mappedRows.map((r) => [r.umblerId, r]));
  const fresh = items.filter((i) => !mapped.has(i.umblerId));
  const match = new Map<string, { row: Candidate; diffMs: number }>(); // the §8 match with the WhatsApp history: next task

  // (2) files: new rows, matched rows without a file (§7.8 "ganho"), and mapped rows whose file was unavailable
  const jobs: FileJob[] = [];
  for (const i of fresh) if (i.file && !match.get(i.umblerId)?.row.mediaPath) jobs.push({ key: i.umblerId, file: i.file });
  const retry = items.filter((i) => {
    const r = mapped.get(i.umblerId);
    return i.file?.url && r?.id && !r.mediaPath && r.mediaStatus === 'expired';
  });
  for (const i of retry) jobs.push({ key: i.umblerId, file: i.file! });
  if (fresh.length === 0 && retry.length === 0) return; // a page read again on a new run: nothing to write
  const files = await downloadFiles(run, jobs);
  if ([...files.values()].includes('temporary')) st.temporary = true;

  // (3) one transaction for the page
  const removed: string[] = [];
  const openSources: string[] = [];
  await ctx.db.transaction(async (tx) => {
    st.localId ??= await createChat(tx, run, chat, st);
    const chatId = st.localId;
    const page = new Map<string, string>();
    const sources = new Set<string>();
    for (const i of fresh) {
      let author: string | null = null;
      if (i.authorUmblerId) {
        author = m.members[i.authorUmblerId]?.id ?? null;
        if (!known.has(i.authorUmblerId)) p.messages.unknownAuthor += 1; // removed from Umbler, or an AI agent (§7.2)
      }
      const file = files.get(i.umblerId);
      const pair = match.get(i.umblerId);
      let id: string;
      if (pair) {
        // §8: nothing is inserted; our row keeps its id, WhatsApp id, status and file, and moves to the imported chat
        id = pair.row.id;
        await tx
          .update(messages)
          .set({
            chatId,
            authorId: pair.row.authorId ?? author,
            ...(i.matchKind !== i.kind ? { kind: i.kind, body: i.body } : {}), // location / contact card: the §7.7 text
            ...(isSaved(file) ? mediaOf(file) : {}),
          })
          .where(eq(messages.id, id));
        if (pair.row.chatId !== chatId) sources.add(pair.row.chatId);
        p.messages.matched += 1;
        p.messages.maxMatchDiffMs = Math.max(p.messages.maxMatchDiffMs, pair.diffMs);
      } else {
        id = randomUUID();
        await tx.insert(messages).values({
          id, chatId, channelId: st.channelId, direction: i.direction, kind: i.kind, body: i.body,
          mediaName: i.file?.name ?? null,
          mediaMime: i.file ? (isSaved(file) ? file.mime : i.file.mime) : null,
          mediaSize: i.file ? (isSaved(file) ? file.size : i.file.size) : null,
          mediaPath: isSaved(file) ? file.path : null,
          mediaSha256: isSaved(file) ? file.sha256 : null,
          mediaStatus: i.file && !isSaved(file) ? 'expired' : null, // "Arquivo não está mais disponível…"
          authorId: author, replyToId: await replyOf(tx, i, page), externalId: null,
          reaction: i.reaction, officeReaction: i.officeReaction, status: i.status,
          deletedAt: i.deletedAt, deletedSource: i.deletedAt ? (i.direction === 'in' ? 'contact' : 'office') : null,
          editedAt: i.editedAt, sentAt: i.at, createdAt: i.at,
        });
      }
      await tx.insert(umblerMap).values({ kind: 'message', umblerId: i.umblerId, localId: id }).onConflictDoNothing();
      page.set(i.umblerId, id);
      p.messages.total += 1;
      if (i.kind === 'note') p.messages.notes += 1;
      if (i.bot) p.messages.bot += 1;
      if (i.redacted) p.messages.redacted += 1;
      if (isSaved(file)) {
        p.files.saved += 1;
        p.files.bytes += file.size;
      } else if (i.file && !(pair?.row.mediaPath)) {
        p.files.expired += 1;
      }
    }
    for (const i of retry) {
      const file = files.get(i.umblerId);
      if (!isSaved(file)) continue;
      await tx.update(messages).set(mediaOf(file)).where(and(eq(messages.id, mapped.get(i.umblerId)!.id!), isNull(messages.mediaPath)));
      p.files.saved += 1;
      p.files.bytes += file.size;
      p.files.expired -= 1;
    }
    await refreshChat(tx, chatId);
    for (const id of sources) {
      const r = await refreshChat(tx, id);
      if (r === 'removed') removed.push(id);
      else if (r === 'open') openSources.push(id);
    }
    await saveProgress(tx, run);
  });
  for (const id of removed) ctx.hub.publishChatRemoved(id);
  for (const id of openSources) await ctx.hub.publishChat(id);
}

/** The first time the chat is complete: the waiting_since fallback (§7.6) and "Conversa importada do Umbler Talk". */
async function finishChat(run: ImportRun, chat: UmblerChat, st: ChatRun): Promise<void> {
  const { ctx } = run;
  if (!st.localId) {
    run.progress.chats.skippedEmpty += 1; // no message at all (§7.6)
    await saveProgress(ctx.db, run);
    return;
  }
  const chatId = st.localId;
  await ctx.db.transaction(async (tx) => {
    const [event] = await tx
      .select({ id: chatEvents.id })
      .from(chatEvents)
      .where(and(eq(chatEvents.chatId, chatId), eq(chatEvents.kind, 'umbler_imported')));
    if (!event) {
      if (st.state === 'open' && !st.merged) {
        const lastIn = sql`(select max(${messages.sentAt}) from ${messages} where ${messages.chatId} = ${chatId} and ${messages.direction} = 'in')`;
        await tx.update(chats).set({ waitingSince: lastIn }).where(and(eq(chats.id, chatId), eq(chats.waiting, true), isNull(chats.waitingSince)));
      }
      const [{ n }] = await tx
        .select({ n: count() })
        .from(umblerMap)
        .innerJoin(messages, eq(messages.id, umblerMap.localId))
        .where(and(eq(umblerMap.kind, 'message'), eq(messages.chatId, chatId)));
      await tx.insert(chatEvents).values({
        id: randomUUID(), chatId, kind: 'umbler_imported', data: st.merged ? { count: n, merged: true } : { count: n },
        authorId: null, createdAt: new Date(chat.createdAtUTC),
      });
    }
    if (!st.temporary) {
      await tx.update(umblerMap).set({ doneAt: new Date() }).where(and(eq(umblerMap.kind, 'chat'), eq(umblerMap.umblerId, chat.id)));
    }
  });
  if (st.state === 'open') await ctx.hub.publishChat(chatId); // §7.6: it shows up in the Entrada; closed ones never publish
}

/**
 * §7.6: copies one Umbler chat page by page (Take=250). Returns false when it made no message call (channel "Não
 * importar", deleted here, no phone nor LID, or a finished closed chat).
 */
export async function importChat(run: ImportRun, chat: UmblerChat, state: 'open' | 'closed'): Promise<boolean> {
  const { ctx } = run;
  const p = run.progress;
  const channelId = run.mapping.channels[chat.channel.id];
  if (!channelId || channelId === 'none') {
    p.chats.skippedChannel += 1;
    return false;
  }
  const [mapped] = await ctx.db
    .select()
    .from(umblerMap)
    .where(and(eq(umblerMap.kind, 'chat'), eq(umblerMap.umblerId, chat.id)));
  if (mapped) {
    const [local] = await ctx.db.select({ id: chats.id }).from(chats).where(eq(chats.id, mapped.localId));
    if (!local) {
      p.chats.skippedDeleted += 1; // deleted here: never comes back
      return false;
    }
    if (mapped.doneAt && state === 'closed') return false; // §9.2: no message call
  }
  const contactId = await contactOf(run, chat);
  if (!contactId) return false;
  const [tomb] = mapped
    ? []
    : await ctx.db
        .select({ until: max(deletedChats.until) })
        .from(deletedChats)
        .where(and(eq(deletedChats.contactId, contactId), eq(deletedChats.channelId, channelId)));
  const st: ChatRun = {
    state, localId: mapped?.localId ?? null, merged: false, contactId, channelId, until: tomb?.until ?? null, temporary: false,
  };
  // §9.2: a finished open chat is read again from its last imported message - 1 ms; an unfinished one from the start
  // (what is mapped is dropped, and its unavailable files are tried again)
  const last = mapped?.doneAt ? await lastImportedAt(run, mapped.localId) : null;
  let from = last ? new Date(last.getTime() - 1) : new Date(FIRST_EVENT);
  const seen = new Set<string>();
  for (;;) {
    checkStop(run);
    let page: MessagePage;
    try {
      page = await fetchMessagePage(run.client, run.org, chat.id, from);
    } catch (err) {
      if (!isGone(err)) throw err;
      p.gone += 1; // deleted in Umbler during the copy
      return true;
    }
    if (page.hasMessagesBeforeAllowedOrganizationPlan) p.planLimited = true;
    const list = page.messages ?? [];
    const fresh = list.filter((x) => !seen.has(x.id));
    for (const x of fresh) seen.add(x.id);
    const items = fresh.map(toIncoming).filter((i): i is Incoming => i !== null).sort(byTime);
    await placePage(run, chat, st, items);
    // the limit may or may not be inclusive: next page from the last one - 1 ms, ids already seen dropped (§4)
    if (list.length < MESSAGES_TAKE || fresh.length === 0) break;
    from = new Date(Math.max(...list.map((x) => Date.parse(x.eventAtUTC))) - 1);
  }
  await finishChat(run, chat, st);
  return true;
}
```

- [ ] **Step 4: Run the tests and the type check**

Run: `npm test -w server -- test/importer`
Expected: PASS.

Run: `npm run typecheck -w server`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add server/src/importer/chats.ts server/test/importer/chats.test.ts
git commit -m "feat(server): copy an Umbler chat (finished, open or joined) with its messages and files" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Use the match while copying a chat

This fills the line Task 8 left empty.

**What a match does (§8):** nothing is inserted, and our row keeps its id, WhatsApp id, status and file. It gains:
- `chat_id`: the imported chat;
- `author_id`: the mapped attendant, when it was null;
- its `umbler_map` row;
- the Umbler file, when it had none. This is the gain of §7.8: media WhatsApp had already lost now comes back;
- for a location or contact card, the §7.7 text, with `kind='text'`.

**The chat it came from** is recalculated: `last_message_at` and the preview, plus `created_at` and `closed_at` for a WhatsApp-history chat. A history chat left without messages is deleted and published as `chat.removed`. An open one gets `chat.updated`.

The report keeps `matched` and the largest difference, `maxMatchDiffMs`. That is the calibration knob of §8.4.

**What never matches:** a note, a row of another contact or channel, or a row that is already in `umbler_map`.

**Files:**
- Modify: `server/src/importer/chats.ts` (the `match.js` import; the match block in `placePage`)
- Test: `server/test/importer/chats-match.test.ts` (create)

**Interfaces:**
- Consumes: Task 6 `matchCandidates`, `pairUp`; Task 8 `placePage`, `refreshChat`.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Create `server/test/importer/chats-match.test.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chats, contacts, messages, umblerMap } from '../../src/db/schema.js';
import { importChat } from '../../src/importer/chats.js';
import { importCatalog, type ImportRun } from '../../src/importer/umbler.js';
import { PDF, umblerChat, umblerMessage } from '../fakes/umbler-api.js';
import { insertChat, newContact } from '../inbox/fixtures.js';
import { importWorld, runFor, type World } from './world.js';

let w: World;
let run: ImportRun;
let maria: string;
let historyChat: string;
const T = Date.UTC(2026, 7, 1, 10, 0, 0);
const at = (s: number) => new Date(T + s * 1000);
const iso = (s: number) => at(s).toISOString();

beforeEach(async () => {
  w = await importWorld();
  run = await runFor(w);
  await importCatalog(run);
  maria = await newContact(w.ctx, { phone: '5565999998888', name: 'Maria' });
  historyChat = await insertChat(w.ctx, { channelId: w.s.channelId, sectorId: w.s.defaultSector, contactId: maria, state: 'closed', history: true });
});
afterEach(async () => {
  expect(w.fake.problems()).toEqual([]);
  await w.fake.close();
});

/** A row the WhatsApp history copy stored (spec 2026-10-16): it has a WhatsApp id. */
async function ours(chatId: string, s: number, values: Partial<typeof messages.$inferInsert>): Promise<string> {
  const [m] = await w.ctx.db
    .insert(messages)
    .values({ chatId, channelId: w.s.channelId, direction: 'in', kind: 'text', status: 'read', sentAt: at(s), createdAt: at(s), ...values })
    .returning({ id: messages.id });
  return m!.id;
}
async function importClosed(list: Array<Record<string, unknown>>): Promise<string> {
  const chat = umblerChat({ open: false, createdAtUTC: iso(0), closedAtUTC: iso(600) });
  w.fake.world.messages[chat.id as string] = list;
  await importChat(run, chat as never, 'closed');
  const [m] = await w.ctx.db.select().from(umblerMap).where(and(eq(umblerMap.kind, 'chat'), eq(umblerMap.umblerId, chat.id as string)));
  return m!.localId;
}
const row = async (id: string) => (await w.ctx.db.select().from(messages).where(eq(messages.id, id)))[0];
const chatRow = async (id: string) => (await w.ctx.db.select().from(chats).where(eq(chats.id, id)))[0];

describe('matching with the WhatsApp history (spec 2026-10-21 importar-umbler §8)', () => {
  it('the same message is not inserted again: our row moves to the imported chat with its id, WhatsApp id and status, and gains the author', async () => {
    const h1 = await ours(historyChat, 3, { body: 'Bom dia', externalId: 'wa1' });
    const h2 = await ours(historyChat, 62, { direction: 'out', body: 'Segue o boleto', externalId: 'wa2', status: 'delivered' });
    const h3 = await ours(historyChat, 71, { body: 'Ok', externalId: 'wa3' }); // 11 s from U4: not the same
    const h4 = await ours(historyChat, 300, { body: 'Outra coisa', externalId: 'wa4' }); // no twin in Umbler

    const imported = await importClosed([
      umblerMessage('U1', iso(0), { content: 'Bom dia' }),
      umblerMessage('U2', iso(60), { source: 'Member', sentByOrganizationMember: { id: 'M_ANA' }, prefix: 'Financeiro - Ana', content: 'Segue o boleto' }),
      umblerMessage('U3', iso(61), { isPrivate: true, source: 'Member', content: 'Segue o boleto' }), // a note never matches
      umblerMessage('U4', iso(60), { content: 'Ok' }),
    ]);

    const rows = await w.ctx.db.select().from(messages).where(eq(messages.chatId, imported)).orderBy(asc(messages.sentAt));
    expect(rows.map((m) => [m.id === h1 || m.id === h2 ? 'ours' : 'new', m.kind, m.body, m.externalId])).toEqual([
      ['ours', 'text', 'Bom dia', 'wa1'],
      ['new', 'text', 'Ok', null],
      ['new', 'note', 'Segue o boleto', null],
      ['ours', 'text', 'Segue o boleto', 'wa2'], // our row keeps its own time (62 s)
    ]);
    expect(await row(h2)).toMatchObject({ authorId: w.s.agentA.id, status: 'delivered', sentAt: at(62) });
    expect(await row(h3)).toMatchObject({ chatId: historyChat });
    expect(await row(h4)).toMatchObject({ chatId: historyChat });
    // the history chat it came from now spans what it has left
    expect(await chatRow(historyChat)).toMatchObject({ createdAt: at(71), closedAt: at(300), lastMessageAt: at(300), lastMessagePreview: 'Outra coisa' });
    expect(run.progress.messages).toMatchObject({ total: 4, matched: 2, maxMatchDiffMs: 3000 });
    const mapped = await w.ctx.db.select().from(umblerMap).where(eq(umblerMap.kind, 'message'));
    expect(Object.fromEntries(mapped.filter((m) => m.umblerId === 'U1' || m.umblerId === 'U2').map((m) => [m.umblerId, m.localId]))).toEqual({ U1: h1, U2: h2 });
  });

  it('a history chat left without messages is deleted (chat.removed)', async () => {
    await ours(historyChat, 0, { body: 'Bom dia', externalId: 'wa1' });
    await importClosed([umblerMessage('U1', iso(1), { content: 'Bom dia' })]);
    expect(await chatRow(historyChat)).toBeUndefined();
    expect(w.ctx.hub.events).toContainEqual({ type: 'chat.removed', chatId: historyChat });
  });

  it("a match whose file had expired on WhatsApp gets Umbler's file; a location gets the §7.7 text", async () => {
    w.fake.world.files['foto.jpg'] = { body: PDF, mime: 'image/jpeg' };
    const photo = await ours(historyChat, 0, { kind: 'image', body: null, externalId: 'wa1', mediaMime: 'image/jpeg', mediaStatus: 'expired' });
    const place = await ours(historyChat, 5, { kind: 'unsupported', body: null, externalId: 'wa2' });
    await ours(historyChat, 900, { body: 'fica no histórico', externalId: 'wa3' });

    await importClosed([
      umblerMessage('U1', iso(0), {
        messageType: 'Image', content: null,
        file: { url: w.fake.fileUrl('foto.jpg'), contentType: 'image/jpeg', originalName: 'foto.jpg', originalSizeBytes: PDF.length, failDownload: false },
      }),
      umblerMessage('U2', iso(4), { messageType: 'Location', location: { latitude: '-15.6', longitude: '-56.1', name: 'Fórum', address: null } }),
    ]);

    const p = (await row(photo))!;
    expect(p).toMatchObject({ mediaStatus: null, mediaMime: 'image/jpeg', externalId: 'wa1' });
    expect(await readFile(join(w.ctx.config.mediaDir, p.mediaPath!))).toEqual(PDF);
    expect(await row(place)).toMatchObject({ kind: 'text', body: 'Localização: Fórum https://maps.google.com/?q=-15.6,-56.1', externalId: 'wa2' });
    expect(run.progress.files).toMatchObject({ saved: 1, expired: 0 });
  });

  it("never matches another contact's row", async () => {
    const other = await newContact(w.ctx);
    const otherChat = await insertChat(w.ctx, { channelId: w.s.channelId, sectorId: w.s.defaultSector, contactId: other, state: 'closed', history: true });
    const theirs = await ours(otherChat, 0, { body: 'Bom dia', externalId: 'wa9' });
    await importClosed([umblerMessage('U1', iso(0), { content: 'Bom dia' })]);
    expect(await row(theirs)).toMatchObject({ chatId: otherChat });
    expect(await w.ctx.db.$count(contacts)).toBe(2);
    expect(run.progress.messages.matched).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w server -- test/importer/chats-match.test.ts`
Expected: FAIL. Every Umbler message is inserted as a new row (`matched` is 0), our history rows stay in the history chat, and the history chat is not deleted.

- [ ] **Step 3: Match before writing**

In `server/src/importer/chats.ts`, replace

```ts
import type { Candidate } from './match.js';
```

with

```ts
import { matchCandidates, pairUp, type Candidate } from './match.js';
```

and, in `placePage`, replace

```ts
  const match = new Map<string, { row: Candidate; diffMs: number }>(); // the §8 match with the WhatsApp history: next task
```

with

```ts
  const comparable = fresh.filter((i) => i.kind !== 'note'); // a note never matches (§8)
  const scope = { contactId: st.contactId, channelId: st.channelId };
  const pairs = pairUp(
    comparable.map((i) => ({ direction: i.direction, kind: i.matchKind, text: i.matchText, at: i.at })),
    await matchCandidates(ctx.db, scope, comparable, 'ours'),
  );
  const match = new Map<string, { row: Candidate; diffMs: number }>();
  comparable.forEach((i, n) => {
    const pair = pairs[n];
    if (pair) match.set(i.umblerId, pair);
  });
```

- [ ] **Step 4: Run the tests and the type check**

Run: `npm test -w server -- test/importer`
Expected: PASS.

Run: `npm run typecheck -w server`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add server/src/importer/chats.ts server/test/importer/chats-match.test.ts
git commit -m "feat(server): an Umbler message that is already here from the WhatsApp history moves our row instead of duplicating it" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: The five phases, the resume and the worker loop

**Phase 3** lists every open chat first. It copies the ones without unread messages first and then the ones with them (§5.2). Right after each of those, it reads the chat again through `contacts/{id}/chats/?ChatState=Open`. When `totalUnread` dropped without a new agent message, it stops with `umbler_marked_read`, so at most one chat is affected.

**Phase 5** walks the finished chats newest first, one list page at a time (§11: memory of one page).

**Before each chat**, the job waits while a WhatsApp history import is `running` (§9.3).

**`importUmbler`** runs the phases from the one the row is in, resetting `done`/`total` per phase. It ends with `state='done'`, the report (the counters plus `durationMs`) and `finished_at`. A stop between pages (`Stopped`, or the worker's abort during a wait) leaves the row `running`. Any other error makes it `failed` with its code.

**`umblerBeat`** builds the client from `UMBLER_TOKEN` with the worker's abortable sleep. Without the token, an active row fails with `umbler_token`.

**The worker** gets the third loop of `createHistoryWorker`, beside the media queue, with the same `AbortController`, every 15 s. `stop()` waits for it.

**Files:**
- Modify: `server/src/importer/chats.ts` (imports; append the phases)
- Modify: `server/src/importer/job.ts` (imports; `runUmblerJob` replaced by `importUmbler`, `runUmblerJob` for both states, `umblerBeat`)
- Modify: `server/src/history/jobs.ts` (imports, options, the third loop)
- Modify: `server/test/importer/world.ts` (append `startImport`)
- Test: `server/test/importer/job.test.ts` (create)

**Interfaces:**
- Consumes: Tasks 3-9 (all the phases); Task 5 `analyzeUmbler`.
- Produces:
  - `importOpenChats`, `importClosedChats`;
  - `importUmbler`, `runUmblerJob` (final), `umblerBeat`;
  - `createHistoryWorker(ctx, { umblerClient? })`;
  - test world: `startImport`.

- [ ] **Step 1: Extend the test world**

Append to the end of `server/test/importer/world.ts`:

```ts
/** "Importar" after an analysis, as the start route leaves the row, then one job beat (every phase, unless it stops). */
export async function startImport(w: World, row: UmblerImportRow, deps: JobDeps = depsOf(w)): Promise<UmblerImportRow> {
  await w.ctx.db
    .update(umblerImports)
    .set({ state: 'running', phase: 'catalog', mapping: proposals(row.analysis!), startedAt: new Date() })
    .where(eq(umblerImports.id, row.id));
  await runUmblerJob(w.ctx, deps);
  return rowOf(w, row.id);
}
```

- [ ] **Step 2: Write the failing test**

Create `server/test/importer/job.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chats, contactNotes, contacts, historyImports, messages, umblerImports, umblerMap } from '../../src/db/schema.js';
import { createHistoryWorker } from '../../src/history/jobs.js';
import { emptyProgress, runUmblerJob, umblerBeat, type JobDeps } from '../../src/importer/job.js';
import type { UmblerClient } from '../../src/importer/umbler.js';
import { umblerChat, umblerMessage } from '../fakes/umbler-api.js';
import { analyze, depsOf, importWorld, rowOf, startImport, type World } from './world.js';

let w: World;
beforeEach(async () => {
  w = await importWorld();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  expect(w.fake.problems()).toEqual([]);
  await w.fake.close();
});

type Obj = Record<string, unknown>;
const joao = { id: 'C2', name: 'João Teste', phoneNumber: '5565988887777', lid: null };
let chatsOf: { open: Obj; unread: Obj; older: Obj; newer: Obj };
/** Two open chats (one with unread messages) and two finished ones, two messages each; notes for Maria. */
function givenOffice(): void {
  const open = umblerChat({ createdAtUTC: '2026-10-01T10:00:00Z' });
  const unread = umblerChat({ createdAtUTC: '2026-09-01T10:00:00Z', totalUnread: 1, contact: joao, lastMessage: { id: 'X', source: 'Contact', messageState: 'Received' } });
  const older = umblerChat({ open: false, createdAtUTC: '2026-03-01T10:00:00Z', closedAtUTC: '2026-03-01T11:00:00Z' });
  const newer = umblerChat({ open: false, createdAtUTC: '2026-06-01T10:00:00Z', closedAtUTC: '2026-06-01T11:00:00Z', contact: joao });
  chatsOf = { open, unread, older, newer };
  for (const [i, chat] of [open, unread, older, newer].entries()) {
    const day = String(chat.createdAtUTC).slice(0, 10);
    w.fake.world.chats.push(chat);
    w.fake.world.messages[chat.id as string] = [umblerMessage(`A${i}`, `${day}T10:00:00Z`), umblerMessage(`B${i}`, `${day}T10:01:00Z`)];
  }
  w.fake.world.notes.C1 = [{ _t: 'NoteModel', id: 'N1', content: 'Retornar', pinned: false, createdBy: 'M_ANA', createdAtUTC: '2026-08-01T10:00:00Z' }];
  w.fake.world.notes.C2 = [];
  w.fake.world.notes.C3 = [];
}
const relativeChatIds = () => w.fake.calls(/relative-messages/).map((r) => r.path.split('/')[4]);
const counts = async () => ({
  contacts: await w.ctx.db.$count(contacts),
  chats: await w.ctx.db.$count(chats),
  messages: await w.ctx.db.$count(messages),
  notes: await w.ctx.db.$count(contactNotes),
  mapped: await w.ctx.db.$count(umblerMap, eq(umblerMap.kind, 'message')),
});
/** A client that stops the job (as the worker's stop() does) right after the call `when` matches. */
function stoppingAt(when: (route: string, query: Obj, params: Obj) => boolean): JobDeps {
  const abort = new AbortController();
  const client: UmblerClient = {
    async get<T>(route: string, query: Obj = {}, params: Record<string, string> = {}) {
      const res = await w.client.get<T>(route, query as never, params);
      if (when(route, query, params)) abort.abort();
      return res;
    },
    file: (url) => w.client.file(url),
  };
  return { ...depsOf(w), client, signal: abort.signal };
}

describe('Importar (spec 2026-10-21 importar-umbler §9)', () => {
  it('runs the five phases in order (open chats, notes, closed newest first) and ends with the report', async () => {
    givenOffice();
    const row = await startImport(w, await analyze(w));

    expect(row).toMatchObject({ state: 'done', phase: 'closed_chats', error: null });
    expect(row.finishedAt).not.toBeNull();
    // the open chat without unread messages first (§5.2), then the one with them; finished ones newest first (§9.1)
    expect(relativeChatIds()).toEqual([chatsOf.open.id, chatsOf.unread.id, chatsOf.newer.id, chatsOf.older.id]);
    const paths = w.fake.requests.map((r) => r.path);
    const firstNotes = paths.findIndex((p) => p.endsWith('/notes/'));
    expect(firstNotes).toBeGreaterThan(paths.lastIndexOf(`/api/v1/chats/${chatsOf.unread.id}/relative-messages/`));
    expect(firstNotes).toBeLessThan(paths.indexOf(`/api/v1/chats/${chatsOf.newer.id}/relative-messages/`));
    expect(w.fake.calls(/\/contacts\/C2\/chats\/$/).map((r) => r.query.get('ChatState'))).toEqual(['Open']); // the unread check
    expect(row.report).toMatchObject({
      contacts: { created: 2, completed: 0, lidOnly: 1, skipped: 1 },
      notes: 1,
      chats: { openCreated: 2, closed: 2 },
      messages: { total: 8, matched: 0 },
    });
    expect(row.report!.durationMs).toBeGreaterThanOrEqual(0);
    expect(await counts()).toEqual({ contacts: 3, chats: 4, messages: 8, notes: 1, mapped: 8 });
  });

  it('stops with umbler_marked_read when an open chat lost its unread count without an agent reply (§5.2)', async () => {
    givenOffice();
    w.fake.world.marksRead = chatsOf.unread.id as string; // reading it marks it as read in Umbler
    const row = await startImport(w, await analyze(w));
    expect(row).toMatchObject({ state: 'failed', error: 'umbler_marked_read', phase: 'open_chats' });
    expect(relativeChatIds()).toEqual([chatsOf.open.id, chatsOf.unread.id]); // at most one chat affected
  });

  it('a stop in the middle of the contacts or of a chat leaves it running; the next beat goes on without duplicates (§9.3)', async () => {
    givenOffice();
    w.fake.world.maxTake = 2; // contacts in two pages
    w.fake.world.messages[chatsOf.newer.id as string] = Array.from({ length: 251 }, (_, i) =>
      umblerMessage(`L${i}`, new Date(Date.UTC(2026, 5, 1, 10, 0, 0) + i * 1000).toISOString()),
    ); // two message pages
    const analyzed = await analyze(w);

    let row = await startImport(w, analyzed, stoppingAt((route, query) => route === '/v1/contacts/' && query.Skip === 2));
    expect(row).toMatchObject({ state: 'running', phase: 'contacts' });

    await runUmblerJob(w.ctx, stoppingAt((route, _q, params) => route.includes('relative-messages') && params.chatId === chatsOf.newer.id));
    row = await rowOf(w, analyzed.id);
    expect(row).toMatchObject({ state: 'running', phase: 'closed_chats' });
    expect(await w.ctx.db.$count(messages)).toBe(4 + 250); // the open chats, the first page of the long chat, then the stop

    await runUmblerJob(w.ctx, depsOf(w));
    row = await rowOf(w, analyzed.id);
    expect(row.state).toBe('done');
    expect(await counts()).toEqual({ contacts: 3, chats: 4, messages: 257, notes: 1, mapped: 257 });
    expect(row.report).toMatchObject({ contacts: { created: 2, lidOnly: 1 }, chats: { openCreated: 2, closed: 2 }, messages: { total: 257 }, notes: 1 });
  });

  it('"Analisar de novo" + "Importar" brings only what is missing; a finished closed chat costs no message call (§9.2)', async () => {
    givenOffice();
    await startImport(w, await analyze(w));
    const before = await counts();
    w.fake.world.messages[chatsOf.open.id as string]!.push(umblerMessage('C0', '2026-10-01T10:05:00Z'));
    const extra = umblerChat({ open: false, createdAtUTC: '2026-07-01T10:00:00Z', closedAtUTC: '2026-07-01T11:00:00Z' });
    w.fake.world.chats.push(extra);
    w.fake.world.messages[extra.id as string] = [umblerMessage('E1', '2026-07-01T10:00:00Z')];
    const calls = w.fake.requests.length;

    const second = await startImport(w, await analyze(w));

    expect(second.state).toBe('done');
    expect(await counts()).toEqual({ ...before, chats: before.chats + 1, messages: before.messages + 2, mapped: before.mapped + 2 });
    const relative = w.fake.requests.slice(calls).filter((r) => r.path.includes('relative-messages')).map((r) => r.path.split('/')[4]);
    expect(relative).toEqual([chatsOf.open.id, chatsOf.unread.id, extra.id]); // the old finished ones: none
  });

  it('waits while a WhatsApp history import runs (§9.3)', async () => {
    givenOffice();
    const [history] = await w.ctx.db
      .insert(historyImports)
      .values({ channelId: w.s.channelId, period: '3m', auto: false, state: 'running' })
      .returning();
    const deps: JobDeps = {
      ...depsOf(w),
      sleep: async (ms) => {
        w.sleeps.push(ms);
        await w.ctx.db.update(historyImports).set({ state: 'done' }).where(eq(historyImports.id, history!.id));
      },
    };
    const row = await startImport(w, await analyze(w), deps);
    expect(row.state).toBe('done');
    expect(w.sleeps).toContain(15_000);
  });

  it('without UMBLER_TOKEN an active row fails with umbler_token; the worker runs the job in its own loop', async () => {
    await w.ctx.db.insert(umblerImports).values({ state: 'analyzing', progress: emptyProgress() });
    await umblerBeat(w.ctx, new AbortController().signal); // makeTestCtx: umblerToken null
    expect((await w.ctx.db.select().from(umblerImports))[0]).toMatchObject({ state: 'failed', error: 'umbler_token' });

    const [row] = await w.ctx.db.insert(umblerImports).values({ state: 'analyzing', progress: emptyProgress() }).returning();
    const worker = createHistoryWorker(w.ctx, { umblerClient: () => w.client });
    worker.start();
    await vi.waitFor(async () => expect((await rowOf(w, row!.id)).state).toBe('analyzed'), { timeout: 10_000, interval: 50 });
    await worker.stop();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm test -w server -- test/importer/job.test.ts`
Expected: FAIL. `umblerBeat` is not exported by `job.ts`, and `createHistoryWorker` has no `umblerClient` option.

- [ ] **Step 4: Add phases 3 and 5**

In `server/src/importer/chats.ts`, replace

```ts
import { chatEvents, chatTags, chats, contacts, deletedChats, messages, umblerMap } from '../db/schema.js';
```

with

```ts
import { chatEvents, chatTags, chats, contacts, deletedChats, historyImports, messages, umblerMap } from '../db/schema.js';
```

replace

```ts
import {
  UmblerError, checkStop, isGone, maps, saveProgress, upsertContact, type ImportRun, type Query, type UmblerChat, type UmblerClient,
  type UmblerMessage,
} from './umbler.js';
```

with

```ts
import {
  UmblerError, checkStop, getAll, isGone, maps, orgQuery, pages, saveProgress, upsertContact, type ImportRun, type Query,
  type UmblerChat, type UmblerClient, type UmblerMessage,
} from './umbler.js';
```

and append:

```ts
// ---------- phases 3 and 5 (§9.1) ----------

const HISTORY_WAIT_MS = 15_000;

/** §9.3: the WhatsApp history copy writes into the same chats and §8 assumes one at a time: wait while one runs. */
async function waitForHistory(run: ImportRun): Promise<void> {
  while ((await run.ctx.db.$count(historyImports, eq(historyImports.state, 'running'))) > 0) {
    checkStop(run);
    await run.sleep(HISTORY_WAIT_MS);
  }
}

/** §5.2: after copying a chat that had unread messages, its unread count must not have dropped without an agent reply. */
async function checkUnread(run: ImportRun, before: UmblerChat): Promise<void> {
  const page = await run.client.get<{ items?: UmblerChat[] }>(
    '/v1/contacts/{id}/chats/',
    { ...orgQuery(run), ChatState: 'Open', Skip: 0, Take: 50 },
    { id: before.contact.id },
  );
  const after = page.items?.find((c) => c.id === before.id);
  if (!after) return;
  const agentReplied = after.lastMessage?.source === 'Member' && after.lastMessage.id !== before.lastMessage?.id;
  if ((after.totalUnread ?? 0) < (before.totalUnread ?? 0) && !agentReplied) {
    throw new UmblerError('umbler_marked_read', null, '/v1/contacts/{id}/chats/');
  }
}

/** Phase 3 (§9.1): every open chat listed first; the ones without unread messages copied first (§5.2). */
export async function importOpenChats(run: ImportRun): Promise<void> {
  const list = await getAll<UmblerChat>(run.client, '/v1/chats/', chatQuery(run.org, 'open'));
  const ordered = [...list.filter((c) => !c.totalUnread), ...list.filter((c) => (c.totalUnread ?? 0) > 0)];
  const p = run.progress;
  p.total = ordered.length;
  for (const chat of ordered) {
    checkStop(run);
    await waitForHistory(run);
    const read = await importChat(run, chat, 'open');
    if (read && (chat.totalUnread ?? 0) > 0) await checkUnread(run, chat);
    p.done += 1;
    await saveProgress(run.ctx.db, run);
  }
}

/** Phase 5 (§9.1): finished chats, newest first, one list page at a time (§11: memory of one page). */
export async function importClosedChats(run: ImportRun): Promise<void> {
  const p = run.progress;
  p.total = run.analysis.chats.closed;
  for await (const page of pages<UmblerChat>(run.client, '/v1/chats/', chatQuery(run.org, 'closed'))) {
    for (const chat of page.items) {
      checkStop(run);
      await waitForHistory(run);
      await importChat(run, chat, 'closed');
      p.done += 1;
    }
    await saveProgress(run.ctx.db, run);
  }
}
```

- [ ] **Step 5: Run the phases, from where the row stopped**

In `server/src/importer/job.ts`, replace

```ts
import { statfs } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { emptyUmblerCounts, type UmblerAnalysisDto, type UmblerProgressDto } from '@talk/shared';
import { errorTag } from '../bots/scheduler.js';
import type { AppCtx } from '../ctx.js';
import { channels, contacts, customFields, quickAnswers, sectors, tags, umblerImports, users } from '../db/schema.js';
import { normalizePhoneBR } from '../whatsapp/phone.js';
import { FIRST_EVENT, chatQuery, fetchMessagePage } from './chats.js';
import {
  FIELD_KINDS, Stopped, UmblerError, fold, getAll, isGone, lidOf, pages, validPhone, type UmblerChannel, type UmblerChat,
  type UmblerClient, type UmblerContact, type UmblerFieldDef, type UmblerMe, type UmblerOrganization, type UmblerQuickAnswer,
  type UmblerSector, type UmblerTag,
} from './umbler.js';
```

with

```ts
import { statfs } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { eq, inArray } from 'drizzle-orm';
import { UMBLER_IMPORT_PHASES, emptyUmblerCounts, type UmblerAnalysisDto, type UmblerImportPhase, type UmblerProgressDto } from '@talk/shared';
import { errorTag } from '../bots/scheduler.js';
import type { AppCtx } from '../ctx.js';
import { channels, contacts, customFields, quickAnswers, sectors, tags, umblerImports, users } from '../db/schema.js';
import { normalizePhoneBR } from '../whatsapp/phone.js';
import { FIRST_EVENT, chatQuery, fetchMessagePage, importClosedChats, importOpenChats } from './chats.js';
import {
  FIELD_KINDS, Stopped, UmblerError, createUmblerClient, fold, getAll, importCatalog, importContactsPhase, importNotesPhase, isGone,
  lidOf, pages, saveProgress, validPhone, type ImportRun, type UmblerChannel, type UmblerChat, type UmblerClient, type UmblerContact,
  type UmblerFieldDef, type UmblerMe, type UmblerOrganization, type UmblerQuickAnswer, type UmblerSector, type UmblerTag,
} from './umbler.js';
```

and replace the analysis-only `runUmblerJob`

```ts
/** One beat (§9.3): the analysis of the 'analyzing' row; an error marks it failed with its §9.4 code. */
export async function runUmblerJob(ctx: AppCtx, deps: JobDeps): Promise<void> {
  const [row] = await ctx.db.select().from(umblerImports).where(eq(umblerImports.state, 'analyzing'));
  if (!row) return;
  try {
    await analyzeUmbler(ctx, deps, row);
  } catch (err) {
    if (err instanceof Stopped || deps.signal?.aborted) return;
    const code = err instanceof UmblerError ? err.code : 'unexpected';
    // ids, the code and the route template only (§3): never text, phone, name, URL or the token
    console.error('umbler: import stopped', { importId: row.id, code, route: err instanceof UmblerError ? err.route : null, err: errorTag(err) });
    await ctx.db.update(umblerImports).set({ state: 'failed', error: code }).where(eq(umblerImports.id, row.id));
  }
}
```

with

```ts
// ---------- Importar (§9.1-9.3) ----------

const PHASES: Record<UmblerImportPhase, (run: ImportRun) => Promise<void>> = {
  catalog: importCatalog,
  contacts: importContactsPhase,
  open_chats: importOpenChats,
  notes: importNotesPhase,
  closed_chats: importClosedChats,
};

/** The phases from the one the row stopped in; every phase skips what umbler_map already has. */
export async function importUmbler(ctx: AppCtx, deps: JobDeps, row: UmblerImportRow): Promise<void> {
  if (!row.analysis || !row.mapping) throw new Error('umbler: a running import without analysis or mapping');
  const signal = deps.signal ?? new AbortController().signal;
  const run: ImportRun = {
    ctx,
    client: deps.client,
    importId: row.id,
    org: row.analysis.organizationId,
    analysis: row.analysis,
    mapping: row.mapping,
    progress: { ...emptyProgress(), ...row.progress },
    signal,
    sleep: deps.sleep ?? ((ms) => delay(ms, undefined, { signal })),
    freeBytes: deps.freeBytes ?? freeBytesOf,
  };
  for (let i = UMBLER_IMPORT_PHASES.indexOf(row.phase ?? 'catalog'); i < UMBLER_IMPORT_PHASES.length; i += 1) {
    const phase = UMBLER_IMPORT_PHASES[i]!;
    run.progress.done = 0;
    run.progress.total = 0;
    await saveProgress(ctx.db, run, phase);
    await PHASES[phase](run);
    console.info('umbler: phase done', { importId: row.id, phase });
  }
  const finishedAt = new Date();
  const { done: _done, total: _total, chatsRead: _read, maps: _maps, ...counts } = run.progress;
  const durationMs = finishedAt.getTime() - (row.startedAt ?? finishedAt).getTime();
  await ctx.db.update(umblerImports).set({ state: 'done', finishedAt, report: { ...counts, durationMs } }).where(eq(umblerImports.id, row.id));
  console.info('umbler: import done', { importId: row.id, chats: counts.chats.openCreated + counts.chats.closed, messages: counts.messages.total });
}

/**
 * One beat (§9.3): advances the active row (analyzing or running) until it ends, fails or the worker stops. A stop
 * between pages leaves it as it is; any other error marks it failed with its §9.4 code.
 */
export async function runUmblerJob(ctx: AppCtx, deps: JobDeps): Promise<void> {
  const [row] = await ctx.db.select().from(umblerImports).where(inArray(umblerImports.state, ['analyzing', 'running']));
  if (!row) return;
  try {
    if (row.state === 'analyzing') await analyzeUmbler(ctx, deps, row);
    else await importUmbler(ctx, deps, row);
  } catch (err) {
    if (err instanceof Stopped || deps.signal?.aborted) return;
    const code = err instanceof UmblerError ? err.code : 'unexpected';
    // ids, the code and the route template only (§3): never text, phone, name, URL or the token
    console.error('umbler: import stopped', { importId: row.id, code, route: err instanceof UmblerError ? err.route : null, err: errorTag(err) });
    await ctx.db.update(umblerImports).set({ state: 'failed', error: code }).where(eq(umblerImports.id, row.id));
  }
}

/** The worker's beat. Without UMBLER_TOKEN an active row fails with umbler_token (the token left the .env). */
export async function umblerBeat(ctx: AppCtx, signal: AbortSignal, makeClient?: () => UmblerClient): Promise<void> {
  const sleep = (ms: number) => delay(ms, undefined, { signal });
  const token = ctx.config.umblerToken;
  const client = makeClient ? makeClient() : token ? createUmblerClient({ token, sleep }) : null;
  if (!client) {
    await ctx.db.update(umblerImports).set({ state: 'failed', error: 'umbler_token' }).where(inArray(umblerImports.state, ['analyzing', 'running']));
    return;
  }
  await runUmblerJob(ctx, { client, signal, sleep });
}
```

- [ ] **Step 6: Run the job in the history worker**

In `server/src/history/jobs.ts`, replace

```ts
import { channels, historyImports } from '../db/schema.js';
import { copyRange } from './copy.js';
```

with

```ts
import { channels, historyImports } from '../db/schema.js';
import { umblerBeat } from '../importer/job.js';
import type { UmblerClient } from '../importer/umbler.js';
import { copyRange } from './copy.js';
```

replace

```ts
/**
 * The history worker (§5-6), one per app process: import passes that are due and, every 5 min, the back-fill of every
 * channel; plus the media queue in its own loop, so a long download run never delays an import pass. All state lives
 * in the DB, so a restart resumes where the previous process stopped.
 * ponytail: one process only; claim rows with FOR UPDATE SKIP LOCKED if the app ever runs more than one.
 */
export function createHistoryWorker(ctx: AppCtx, opts: { intervalMs?: number; mediaIntervalMs?: number } = {}) {
  const { intervalMs = 15_000, mediaIntervalMs = 10_000 } = opts;
```

with

```ts
/**
 * The history worker (§5-6), one per app process: import passes that are due and, every 5 min, the back-fill of every
 * channel; plus the media queue in its own loop, so a long download run never delays an import pass; plus the "Importar
 * do Umbler" job (spec 2026-10-21 importar-umbler §9.3) in a third loop, which runs for hours in one beat. All state
 * lives in the DB, so a restart resumes where the previous process stopped.
 * ponytail: one process only; claim rows with FOR UPDATE SKIP LOCKED if the app ever runs more than one.
 */
export function createHistoryWorker(
  ctx: AppCtx,
  opts: { intervalMs?: number; mediaIntervalMs?: number; umblerClient?: () => UmblerClient } = {},
) {
  const { intervalMs = 15_000, mediaIntervalMs = 10_000 } = opts;
```

replace

```ts
  let media: Promise<unknown> | null = null;
```

with

```ts
  let media: Promise<unknown> | null = null;
  let umbler: Promise<unknown> | null = null;
```

and replace

```ts
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
```

with

```ts
  function runUmbler(): void {
    if (umbler) return; // the import is still running: it goes on in the same beat
    umbler = umblerBeat(ctx, abort.signal, opts.umblerClient)
      .catch((err: unknown) => console.error('umbler: beat failed', errorTag(err)))
      .finally(() => {
        umbler = null;
      });
  }

  return {
    tick,
    start(): void {
      if (timers.length) return;
      abort = new AbortController();
      runJobs();
      runMedia();
      runUmbler();
      timers.push(setInterval(runJobs, intervalMs), setInterval(runMedia, mediaIntervalMs), setInterval(runUmbler, intervalMs));
      for (const t of timers) t.unref();
    },
    /** Clears the timers, ends the media loop after its current download and the Umbler job between pages, and waits for all. */
    async stop(): Promise<void> {
      for (const t of timers) clearInterval(t);
      timers.length = 0;
      abort.abort();
      await Promise.all([jobs, media, umbler]);
    },
  };
```

`server/src/index.ts` needs no change: it already starts and stops `createHistoryWorker(ctx)`.

- [ ] **Step 7: Run the tests and the type check**

Run: `npm test -w server -- test/importer test/history`
Expected: PASS.

Run: `npm run typecheck -w server`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add server/src/importer/chats.ts server/src/importer/job.ts server/src/history/jobs.ts server/test/importer/world.ts server/test/importer/job.test.ts
git commit -m "feat(server): run the Umbler import phases in the history worker, resuming where they stopped" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Routes: status, Analisar, Importar, Continuar

The four routes are admin-only: an agent gets 403, and every POST passes the global Origin check. The routes never call Umbler; the worker does.
- **`GET`** answers `tokenConfigured` and the newest import.
- **`analyze`** creates the `analyzing` row. It answers 400 without the token, and 409 while another import is active (the partial unique index).
- **`start`** works only on an `analyzed` row. Every Umbler channel, sector and attendant of the analysis needs a destination that exists here, and a channel that is not WhatsApp may only be "Não importar". The §6.3 blocks are checked again at that moment: automatic rules on, or a read test that marked a chat. The row then moves to `running` at `catalog`.
- **`resume`** ("Continuar") works only on a `failed` import that started. It checks the same blocks and goes back to `running` in the same phase, with the same counters.

The DTO computes `blocks` on every read of an `analyzed` or `failed` row, so the message disappears once the rules are switched off. It strips `progress.maps`.

**Files:**
- Create: `server/src/importer/routes.ts`
- Modify: `server/src/app.ts` (import, registration)
- Test: `server/test/importer/routes.test.ts` (create)

**Interfaces:**
- Consumes: Task 5 `emptyProgress`, `UmblerImportRow`; existing `getAutoRules`, `badRequest`, `conflict`, `forbidden`, `notFound`.
- Produces: `UMBLER_RUNNING`, `NO_TOKEN`, `BLOCK_RULES`, `BLOCK_READ_TEST`, `BAD_MAPPING`, `NOT_ANALYZED`, `NOT_FAILED`, `importBlocks`, `toUmblerImportDto`, `registerUmblerImportRoutes`.

- [ ] **Step 1: Write the failing test**

Create `server/test/importer/routes.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UmblerImportDto, UmblerImportStatusDto } from '@talk/shared';
import { settings, umblerImports } from '../../src/db/schema.js';
import { emptyProgress } from '../../src/importer/job.js';
import { BAD_MAPPING, BLOCK_READ_TEST, BLOCK_RULES, NO_TOKEN, NOT_FAILED, UMBLER_RUNNING } from '../../src/importer/routes.js';
import { TEST_ORIGIN, loginAs, makeTestApp } from '../helpers.js';
import { importWorld, proposals, testAnalysis, type World } from './world.js';

let w: World;
let app: FastifyInstance;
let admin: Record<string, string>;
let agent: Record<string, string>;
beforeEach(async () => {
  w = await importWorld();
  ({ app } = await makeTestApp(w.ctx));
  admin = (await loginAs(app, 'admin@teste.local')).headers;
  agent = (await loginAs(app, 'ana@teste.local')).headers;
});
afterEach(async () => {
  await app.close();
  expect(w.fake.requests).toEqual([]); // the routes never call Umbler: the worker does
  await w.fake.close();
});

const call = (method: 'GET' | 'POST', url: string, headers: Record<string, string>, payload?: object) =>
  app.inject({ method, url, headers, payload });
const analyzed = async (over: Partial<typeof umblerImports.$inferInsert> = {}) => {
  const [row] = await w.ctx.db
    .insert(umblerImports)
    .values({ state: 'analyzed', analysis: testAnalysis(w), progress: emptyProgress(), ...over })
    .returning();
  return row!;
};
const rulesOn = () =>
  w.ctx.db.insert(settings).values({
    key: 'auto_rules',
    value: { returnToQueue: { enabled: true, minutes: 30 }, closeInactive: { enabled: false, hours: 24, sendClosingMessage: true } },
  });

describe('Importar do Umbler routes (spec 2026-10-21 importar-umbler §10)', () => {
  it('admins only; a POST without Origin is refused', async () => {
    const row = await analyzed();
    for (const [method, url] of [
      ['GET', '/api/umbler-import'], ['POST', '/api/umbler-import/analyze'], ['POST', `/api/umbler-import/${row.id}/start`],
      ['POST', `/api/umbler-import/${row.id}/resume`],
    ] as const) {
      expect((await call(method, url, agent, method === 'POST' ? {} : undefined)).statusCode).toBe(403);
    }
    const { origin: _origin, ...noOrigin } = admin;
    expect((await call('POST', '/api/umbler-import/analyze', noOrigin)).statusCode).toBe(403);
    expect(admin.origin).toBe(TEST_ORIGIN);
  });

  it('GET says whether the token is configured, never any part of it, and returns the newest import', async () => {
    expect((await call('GET', '/api/umbler-import', admin)).json()).toEqual({ tokenConfigured: false, current: null });
    w.ctx.config.umblerToken = 'tok-segredo-123';
    await analyzed({ createdAt: new Date('2026-10-20T10:00:00Z') });
    const newest = await analyzed({ state: 'done', createdAt: new Date('2026-10-21T10:00:00Z') });
    const res = await call('GET', '/api/umbler-import', admin);
    const body = res.json<UmblerImportStatusDto>();
    expect(body.tokenConfigured).toBe(true);
    expect(body.current).toMatchObject({ id: newest.id, state: 'done', blocks: [] });
    expect(res.body).not.toContain('tok-segredo');
    expect(body.current!.progress).not.toHaveProperty('maps');
  });

  it('analyze: 400 without a token; creates the analyzing row; 409 while one is active', async () => {
    expect((await call('POST', '/api/umbler-import/analyze', admin)).json()).toEqual({ error: NO_TOKEN });
    w.ctx.config.umblerToken = 'tok-teste';
    const first = await call('POST', '/api/umbler-import/analyze', admin);
    expect(first.statusCode).toBe(200);
    expect(first.json<UmblerImportDto>()).toMatchObject({ state: 'analyzing', phase: null, analysis: null, startedAt: null });
    const again = await call('POST', '/api/umbler-import/analyze', admin);
    expect([again.statusCode, again.json()]).toEqual([409, { error: UMBLER_RUNNING }]);
  });

  it('start: every Umbler channel, sector and attendant needs a destination here; then it runs from the catalog', async () => {
    const row = await analyzed();
    const mapping = proposals(row.analysis!);
    const bad = await call('POST', `/api/umbler-import/${row.id}/start`, admin, { mapping: { ...mapping, sectors: { SEC1: w.s.defaultSector } } });
    expect([bad.statusCode, bad.json()]).toEqual([400, { error: BAD_MAPPING }]);
    const webToo = { ...mapping, channels: { ...mapping.channels, CH_WEB: w.s.channelId } }; // not WhatsApp: only "Não importar"
    expect((await call('POST', `/api/umbler-import/${row.id}/start`, admin, { mapping: webToo })).statusCode).toBe(400);

    const ok = await call('POST', `/api/umbler-import/${row.id}/start`, admin, { mapping });
    expect(ok.json<UmblerImportDto>()).toMatchObject({ state: 'running', phase: 'catalog', error: null });
    const [stored] = await w.ctx.db.select().from(umblerImports).where(eq(umblerImports.id, row.id));
    expect(stored!.mapping).toEqual(mapping);
    expect(stored!.startedAt).not.toBeNull();
    expect((await call('POST', `/api/umbler-import/${row.id}/start`, admin, { mapping })).statusCode).toBe(409); // not 'analyzed' anymore
  });

  it('start is blocked while the automatic rules are on or the read test marked a chat; 409 while another import is active', async () => {
    const marked = await analyzed({ analysis: testAnalysis(w, { readTest: 'marked' }) });
    const mapping = proposals(marked.analysis!);
    expect((await call('GET', '/api/umbler-import', admin)).json<UmblerImportStatusDto>().current!.blocks).toEqual([BLOCK_READ_TEST]);
    expect((await call('POST', `/api/umbler-import/${marked.id}/start`, admin, { mapping })).json()).toEqual({ error: BLOCK_READ_TEST });

    await w.ctx.db.update(umblerImports).set({ state: 'done' }).where(eq(umblerImports.id, marked.id));
    const row = await analyzed();
    await rulesOn();
    expect((await call('POST', `/api/umbler-import/${row.id}/start`, admin, { mapping })).json()).toEqual({ error: BLOCK_RULES });
    await w.ctx.db.delete(settings).where(eq(settings.key, 'auto_rules'));

    await analyzed({ state: 'running', phase: 'contacts', startedAt: new Date() });
    const busy = await call('POST', `/api/umbler-import/${row.id}/start`, admin, { mapping });
    expect([busy.statusCode, busy.json()]).toEqual([409, { error: UMBLER_RUNNING }]);
  });

  it('resume ("Continuar"): only a failed import; same blocks; back to running in the same phase with the same counters', async () => {
    const progress = { ...emptyProgress(), messages: { ...emptyProgress().messages, total: 120 } };
    const row = await analyzed({ state: 'failed', phase: 'closed_chats', error: 'umbler_429', startedAt: new Date(), progress, mapping: proposals(testAnalysis(w)) });
    const analysis = await analyzed({ state: 'failed', error: 'umbler_token' }); // a failed analysis: "Analisar de novo"
    expect((await call('POST', `/api/umbler-import/${analysis.id}/resume`, admin)).json()).toEqual({ error: NOT_FAILED });

    await rulesOn();
    expect((await call('POST', `/api/umbler-import/${row.id}/resume`, admin)).json()).toEqual({ error: BLOCK_RULES });
    await w.ctx.db.delete(settings).where(eq(settings.key, 'auto_rules'));

    const res = await call('POST', `/api/umbler-import/${row.id}/resume`, admin);
    expect(res.json<UmblerImportDto>()).toMatchObject({ state: 'running', phase: 'closed_chats', error: null, progress: { messages: { total: 120 } } });
    expect((await call('POST', `/api/umbler-import/${row.id}/resume`, admin)).json()).toEqual({ error: NOT_FAILED });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w server -- test/importer/routes.test.ts`
Expected: FAIL. `../../src/importer/routes.js` does not exist.

- [ ] **Step 3: Write the routes and register them**

Create `server/src/importer/routes.ts`:

```ts
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { UmblerAnalysisDto, UmblerImportDto, UmblerImportStatusDto, UmblerMappingDto, UmblerProgressDto } from '@talk/shared';
import { getAutoRules } from '../catalog/settings.js';
import type { AppCtx } from '../ctx.js';
import type { Db } from '../db/client.js';
import { channels, sectors, umblerImports, users } from '../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/http-error.js';
import { emptyProgress, type UmblerImportRow } from './job.js';

// Spec 2026-10-21 importar-umbler §6, §10: "Importar do Umbler" (admins only; every POST passes the global Origin check).

export const UMBLER_RUNNING = 'Já existe uma importação do Umbler em andamento';
export const NO_TOKEN = 'Token do Umbler não configurado';
export const BLOCK_RULES =
  'Desligue as Regras automáticas antes de importar: elas finalizariam ou devolveriam à fila as conversas abertas importadas e poderiam enviar a mensagem de encerramento a clientes.';
export const BLOCK_READ_TEST = 'A leitura marcou uma conversa como lida no Umbler. A importação foi bloqueada para não alterar o Umbler.';
// decisions: these three are not in the spec
export const BAD_MAPPING = 'Escolha um destino para cada canal, setor e atendente.';
export const NOT_ANALYZED = 'Analise o Umbler antes de importar.';
export const NOT_FAILED = 'Só uma importação que parou pode continuar.';

const idParams = z.object({ id: z.uuid() });
const startBody = z.object({
  mapping: z.object({
    channels: z.record(z.string(), z.string()),
    sectors: z.record(z.string(), z.string()),
    members: z.record(z.string(), z.string()),
  }),
});

/** §6.3, checked on every read and again right before start / resume (the rules may have been switched on meanwhile). */
export async function importBlocks(db: Db, row: UmblerImportRow): Promise<string[]> {
  const blocks: string[] = [];
  const rules = await getAutoRules(db);
  if (rules.returnToQueue.enabled || rules.closeInactive.enabled) blocks.push(BLOCK_RULES);
  if (row.analysis?.readTest === 'marked') blocks.push(BLOCK_READ_TEST);
  return blocks;
}

function progressDto(p: UmblerImportRow['progress']): UmblerProgressDto | null {
  if (!p) return null;
  const { maps: _maps, ...rest } = p; // the catalog maps are ids only, but the screen has no use for them
  return rest;
}

export async function toUmblerImportDto(db: Db, row: UmblerImportRow): Promise<UmblerImportDto> {
  return {
    id: row.id,
    state: row.state,
    phase: row.phase,
    analysis: row.analysis,
    progress: progressDto(row.progress),
    report: row.report,
    error: row.error,
    blocks: row.state === 'analyzed' || row.state === 'failed' ? await importBlocks(db, row) : [],
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

/** §10 start: every Umbler channel, sector and attendant of the analysis has a destination that exists. */
async function validMapping(db: Db, a: UmblerAnalysisDto, m: UmblerMappingDto): Promise<boolean> {
  const ids = async (rows: Promise<Array<{ id: string }>>) => new Set((await rows).map((r) => r.id));
  const ourChannels = await ids(db.select({ id: channels.id }).from(channels));
  const ourSectors = await ids(db.select({ id: sectors.id }).from(sectors));
  const ourUsers = await ids(db.select({ id: users.id }).from(users));
  return (
    a.channels.every((ch) => m.channels[ch.id] === 'none' || (ch.whatsapp && ourChannels.has(m.channels[ch.id] ?? ''))) &&
    a.sectors.every((s) => m.sectors[s.id] === 'create' || ourSectors.has(m.sectors[s.id] ?? '')) &&
    a.members.every((u) => m.members[u.id] === 'create' || m.members[u.id] === 'none' || ourUsers.has(m.members[u.id] ?? ''))
  );
}

const pgCode = (err: unknown) => {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.cause?.code ?? e?.code;
};

/** → running, after the §6.3 blocks; 409 while another import is active (umbler_imports_one_active). */
async function begin(db: Db, row: UmblerImportRow, patch: Partial<typeof umblerImports.$inferInsert>): Promise<UmblerImportDto> {
  const blocks = await importBlocks(db, row);
  if (blocks.length) throw conflict(blocks[0]);
  let updated: UmblerImportRow | undefined;
  try {
    [updated] = await db
      .update(umblerImports)
      .set({ ...patch, state: 'running', error: null })
      .where(and(eq(umblerImports.id, row.id), eq(umblerImports.state, row.state)))
      .returning();
  } catch (err) {
    if (pgCode(err) === '23505') throw conflict(UMBLER_RUNNING);
    throw err;
  }
  if (!updated) throw conflict(UMBLER_RUNNING); // changed meanwhile
  return toUmblerImportDto(db, updated);
}

async function rowOf(db: Db, id: string): Promise<UmblerImportRow> {
  const [row] = await db.select().from(umblerImports).where(eq(umblerImports.id, id));
  if (!row) throw notFound();
  return row;
}

export function registerUmblerImportRoutes(app: FastifyInstance, ctx: AppCtx): void {
  const admin = (req: FastifyRequest) => {
    if (req.user.role !== 'admin') throw forbidden();
  };

  // the screen polls this every 3 s while it analyzes or imports (§6); never any part of the token
  app.get('/api/umbler-import', async (req): Promise<UmblerImportStatusDto> => {
    admin(req);
    const [row] = await ctx.db.select().from(umblerImports).orderBy(desc(umblerImports.createdAt)).limit(1);
    return { tokenConfigured: ctx.config.umblerToken !== null, current: row ? await toUmblerImportDto(ctx.db, row) : null };
  });

  // the worker picks the row up on its next beat (≤ 15 s)
  app.post('/api/umbler-import/analyze', async (req) => {
    admin(req);
    if (!ctx.config.umblerToken) throw badRequest(NO_TOKEN);
    const [row] = await ctx.db
      .insert(umblerImports)
      .values({ state: 'analyzing', createdBy: req.user.id, progress: emptyProgress() })
      .onConflictDoNothing()
      .returning();
    if (!row) throw conflict(UMBLER_RUNNING);
    return toUmblerImportDto(ctx.db, row);
  });

  app.post('/api/umbler-import/:id/start', async (req) => {
    admin(req);
    const { id } = idParams.parse(req.params);
    const { mapping } = startBody.parse(req.body);
    const row = await rowOf(ctx.db, id);
    if (row.state !== 'analyzed' || !row.analysis) throw conflict(NOT_ANALYZED);
    if (!(await validMapping(ctx.db, row.analysis, mapping))) throw badRequest(BAD_MAPPING);
    return begin(ctx.db, row, { phase: 'catalog', mapping, startedAt: new Date() });
  });

  // "Continuar": same phase, same counters
  app.post('/api/umbler-import/:id/resume', async (req) => {
    admin(req);
    const row = await rowOf(ctx.db, idParams.parse(req.params).id);
    if (row.state !== 'failed' || !row.startedAt) throw conflict(NOT_FAILED);
    return begin(ctx.db, row, {});
  });
}
```

In `server/src/app.ts`, replace

```ts
import { registerContactRoutes } from './contacts/routes.js';
```

with

```ts
import { registerContactRoutes } from './contacts/routes.js';
import { registerUmblerImportRoutes } from './importer/routes.js';
```

and replace

```ts
  registerChannelRoutes(app, ctx);
  registerBotRoutes(app, ctx);
```

with

```ts
  registerChannelRoutes(app, ctx);
  registerBotRoutes(app, ctx);
  registerUmblerImportRoutes(app, ctx);
```

- [ ] **Step 4: Run the tests and the type check**

Run: `npm test -w server`
Expected: PASS (every server test).

Run: `npm run typecheck -w server`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add server/src/importer/routes.ts server/src/app.ts server/test/importer/routes.test.ts
git commit -m "feat(server): Importar do Umbler routes (admin): status, analyze, start and resume, with the import blocks" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Web: the "Importar do Umbler" page in Ajustes

The page sits in Ajustes › **Equipe e cadastros**, admin only. An agent who opens the URL is sent back to Perfil, and the server answers 403 anyway. It is built from the settings building blocks (`PageHeader`, `SettingsSection`, `SettingRow`, `block`, `ErrorText`, `Loading`, `btnPrimary`, `btnSecondary`) and `fieldSelect`. It polls `GET /api/umbler-import` every 3 s while the job analyzes or imports; there is no WebSocket event.

The states, with the copy of spec §6.1-6.4:
- **Sem token**: the text that says how to set it, and "Analisar" disabled. No part of the token is ever shown.
- **Analisando**: "Analisando o Umbler… N conversas lidas".
- **Analisado**:
  - "O que foi encontrado";
  - one selector per channel, sector and attendant, with the proposals;
  - per channel, the hint of §6.2/§6.3: the old number going to the official channel, the other number the replies leave from, or "N conversas deste canal não vêm.";
  - the blocks and warnings;
  - "Analisar de novo" and "Importar", which opens the confirmation and posts the mapping.
- **Importando**: "Etapa 3 de 5: conversas abertas — 120 de 135", the counters, and "Pode fechar esta tela…".
- **Falhou**: "A importação parou: <motivo>. O que já entrou fica." with "Continuar". A failed analysis shows "A análise parou: <motivo>." and offers "Analisar de novo" (decision 5).
- **Concluída**: "Importação concluída em dd/mm/aaaa hh:mm (duração h min)." with the report, and "Analisar de novo".

**Files:**
- Modify: `web/src/lib/api.ts` (types, `api.umblerImport`, `qk.umblerImport`), `web/src/lib/api.test.ts`
- Create: `web/src/pages/settings/UmblerImportSettings.tsx`, `web/src/pages/settings/UmblerImportSettings.test.tsx`
- Modify: `web/src/pages/settings/SettingsPage.tsx` (icon, import, item), `web/src/pages/settings/SettingsPage.test.tsx`

**Interfaces:**
- Consumes:
  - Task 1 `UMBLER_IMPORT_ERRORS`, `UMBLER_IMPORT_PHASES`, `UMBLER_PHASE_LABELS`, the DTOs;
  - Task 11's routes;
  - existing `confirmDialog`, `formatPhone`, `formatOfficeDateTime`, `api.channels.list`, `api.sectors.list`, `api.users.list`.
- Produces: `api.umblerImport.*`, `qk.umblerImport`, `UmblerImportSettings`, `durationText`, `progressLines`, `reportLines`, `channelHint`.

- [ ] **Step 1: Write the failing tests**

Append to the end of `web/src/lib/api.test.ts`:

```ts
describe('api routes of the 2026-10-21 importar-umbler delivery', () => {
  it('calls the Umbler import routes', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json(200, {}));
    vi.stubGlobal('fetch', fetchMock);
    const mapping = { channels: { CH: 'c1' }, sectors: { S: 'create' }, members: { M: 'none' } };
    await api.umblerImport.get();
    await api.umblerImport.analyze();
    await api.umblerImport.start('i1', mapping);
    await api.umblerImport.resume('i1');
    expect(fetchMock.mock.calls.map(([u, i]) => `${i?.method} ${String(u)} ${String(i?.body ?? '')}`)).toEqual([
      'GET /api/umbler-import ',
      'POST /api/umbler-import/analyze ',
      `POST /api/umbler-import/i1/start ${JSON.stringify({ mapping })}`,
      'POST /api/umbler-import/i1/resume ',
    ]);
  });
});
```

Create `web/src/pages/settings/UmblerImportSettings.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { emptyUmblerCounts, type UmblerAnalysisDto, type UmblerImportDto, type UmblerImportStatusDto } from '@talk/shared';
import { confirmDialog } from '../../lib/confirm';
import { UmblerImportSettings, durationText } from './UmblerImportSettings';

vi.mock('../../lib/confirm', () => ({ confirmDialog: vi.fn(async () => true) }));

const analysis: UmblerAnalysisDto = {
  organizationId: 'ORG', organization: 'Escritório Teste',
  contacts: { total: 2368, existing: 300, withoutAddress: 8 },
  chats: { open: 135, waiting: 12, closed: 9440, from: '2023-02-01T12:00:00.000Z', to: '2026-10-20T12:00:00.000Z' },
  channels: [
    { id: 'CH_OLD', name: 'Número antigo', type: 'OrganizationBrokerWhatsappChannelReferenceModel', phone: '5565988880000', whatsapp: true, chats: 900, proposal: 'ch1' },
    { id: 'CH_WEB', name: 'Site', type: 'OrganizationWebsiteWidgetChannelReferenceModel', phone: null, whatsapp: false, chats: 4, proposal: 'none' },
  ],
  sectors: [{ id: 'SEC1', name: 'Atendimento', proposal: 's1' }, { id: 'SEC3', name: 'Trabalhista', proposal: 'create' }],
  members: [{ id: 'M_CARLA', name: 'Carla Antiga', email: 'carla@antigo.test', active: false, chats: 321, proposal: 'create' }],
  tags: { new: 3, existing: 1 },
  customFields: { new: 1, existing: 0, unsupported: ['Aceitou termos'] },
  quickAnswers: { new: 5, existing: 2 },
  readTest: 'ok',
  warnings: ['Espaço livre para arquivos: 40 GB.'],
};
const counts = { ...emptyUmblerCounts(), done: 120, total: 135, chatsRead: 0 };
const imp = (over: Partial<UmblerImportDto> = {}): UmblerImportDto => ({
  id: 'i1', state: 'analyzed', phase: null, analysis, progress: counts, report: null, error: null, blocks: [],
  createdAt: '2026-10-21T12:00:00.000Z', startedAt: null, finishedAt: null, ...over,
});

let status: UmblerImportStatusDto;
const calls: Array<{ method: string; path: string; body: unknown }> = [];
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls.length = 0;
  status = { tokenConfigured: true, current: null };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    const method = init?.method ?? 'GET';
    calls.push({ method, path, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    if (method === 'GET' && path === '/api/umbler-import') return json(status);
    if (method === 'GET' && path === '/api/channels') return json([{ id: 'ch1', name: 'WhatsApp escritório', status: 'connected', phone: '5565999990000' }]);
    if (method === 'GET' && path === '/api/sectors') return json([{ id: 's1', name: 'Atendimento', position: 0, isDefault: true }]);
    if (method === 'GET' && path === '/api/users') return json([{ id: 'u1', name: 'Ana', email: 'ana@x', role: 'agent', signature: null, active: true, sectorIds: [], avatarUrl: null }]);
    if (method === 'POST') return json(imp({ state: 'running' }));
    return json({ error: 'inesperado' }, 500);
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
      <UmblerImportSettings />
    </QueryClientProvider>,
  );
}

describe('Importar do Umbler (spec 2026-10-21 importar-umbler §6)', () => {
  it('without the token: says how to set it, never shows any token, and "Analisar" is disabled', async () => {
    status = { tokenConfigured: false, current: null };
    renderPage();
    expect(await screen.findByText(/Token do Umbler não configurado\. Coloque/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Analisar' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('with the token: "Analisar" posts analyze; while analyzing it shows the chats read and no button', async () => {
    renderPage();
    expect(await screen.findByText('Token do Umbler configurado.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Analisar' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/umbler-import/analyze')).toBe(true));

    cleanup();
    status = { tokenConfigured: true, current: imp({ state: 'analyzing', analysis: null, progress: { ...counts, chatsRead: 450 } }) };
    renderPage();
    expect(await screen.findByText('Analisando o Umbler… 450 conversas lidas')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Analisar/ })).toBeNull();
  });

  it('analyzed: counts, the proposed destinations, the channel hints; "Importar" confirms and posts the mapping', async () => {
    status = { tokenConfigured: true, current: imp() };
    renderPage();
    expect(await screen.findByText('Contatos: 2.060 novos, 300 já existem aqui, 8 sem telefone nem LID (não vêm)')).toBeTruthy();
    expect(screen.getByText('Conversas abertas: 135 (das quais 12 esperando)')).toBeTruthy();
    expect(screen.getByText('Período: de 01/02/2023 a 20/10/2026')).toBeTruthy();
    const oldNumber = (await screen.findByLabelText('Número antigo')) as HTMLSelectElement;
    expect(oldNumber.value).toBe('ch1');
    expect(screen.getByText('As conversas do número +55 65 98888-0000 entram no canal WhatsApp escritório; respostas a elas saem do número oficial.')).toBeTruthy();
    expect((screen.getByLabelText('Site') as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getByText('4 conversas deste canal não vêm.')).toBeTruthy();
    expect((screen.getByLabelText('Trabalhista') as HTMLSelectElement).value).toBe('create');
    expect(screen.getByRole('option', { name: 'Criar setor “Trabalhista”' })).toBeTruthy();
    expect((screen.getByLabelText('Carla Antiga') as HTMLSelectElement).value).toBe('create');
    expect(screen.getByText('Espaço livre para arquivos: 40 GB.')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Carla Antiga'), { target: { value: 'none' } });
    fireEvent.change(oldNumber, { target: { value: 'none' } });
    expect(screen.getByText('900 conversas deste canal não vêm.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Importar' }));

    await waitFor(() => expect(calls.find((c) => c.path === '/api/umbler-import/i1/start')).toBeTruthy());
    expect(vi.mocked(confirmDialog)).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Importar 2.360 contatos e 9.575 conversas do Umbler?', confirmLabel: 'Importar' }),
    );
    expect(calls.find((c) => c.path === '/api/umbler-import/i1/start')!.body).toEqual({
      mapping: { channels: { CH_OLD: 'none', CH_WEB: 'none' }, sectors: { SEC1: 's1', SEC3: 'create' }, members: { M_CARLA: 'none' } },
    });
  });

  it('a block (automatic rules on) is shown and keeps "Importar" disabled', async () => {
    status = { tokenConfigured: true, current: imp({ blocks: ['Desligue as Regras automáticas antes de importar: …'] }) };
    renderPage();
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect((await screen.findByRole('button', { name: 'Importar' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('importing: the step, the counters, and that the screen may be closed', async () => {
    status = { tokenConfigured: true, current: imp({ state: 'running', phase: 'open_chats', startedAt: '2026-10-21T12:00:00.000Z' }) };
    renderPage();
    expect(await screen.findByText('Etapa 3 de 5: conversas abertas — 120 de 135')).toBeTruthy();
    expect(screen.getByText('Casadas com o histórico do WhatsApp: 0')).toBeTruthy();
    expect(screen.getByText('Pode fechar esta tela: a importação continua no servidor e retoma sozinha se o sistema reiniciar.')).toBeTruthy();
  });

  it('failed: the reason and "Continuar"; a failed analysis only offers "Analisar de novo"', async () => {
    status = { tokenConfigured: true, current: imp({ state: 'failed', phase: 'closed_chats', error: 'umbler_429', startedAt: '2026-10-21T12:00:00.000Z' }) };
    renderPage();
    expect(await screen.findByText('A importação parou: O Umbler limitou as requisições. Clique em Continuar daqui a alguns minutos. O que já entrou fica.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/umbler-import/i1/resume')).toBe(true));

    cleanup();
    status = { tokenConfigured: true, current: imp({ state: 'failed', error: 'umbler_token', analysis: null }) };
    renderPage();
    expect(await screen.findByText(/^A análise parou: O Umbler recusou o token/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Continuar' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Analisar de novo' })).toBeTruthy();
  });

  it('done: when it ended, how long it took, and the report', async () => {
    const report = { ...emptyUmblerCounts(), durationMs: 2 * 3_600_000 + 15 * 60_000, messages: { ...emptyUmblerCounts().messages, total: 150_000, matched: 4200, maxMatchDiffMs: 3500 } };
    status = {
      tokenConfigured: true,
      current: imp({ state: 'done', phase: 'closed_chats', report, startedAt: '2026-10-21T12:00:00.000Z', finishedAt: '2026-10-21T18:15:00.000Z' }),
    };
    renderPage();
    expect(await screen.findByText('Importação concluída em 21/10/2026 14:15 (duração 2 h 15 min).')).toBeTruthy();
    expect(screen.getByText('Casadas com o histórico do WhatsApp: 4.200 (maior diferença: 3,5 s)')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Analisar de novo' })).toBeTruthy();
    expect(durationText(40 * 60_000)).toBe('40 min');
  });
});
```

Append to the end of `web/src/pages/settings/SettingsPage.test.tsx`:

```tsx
it('lists "Importar do Umbler" under Equipe e cadastros for admins only (spec 2026-10-21 importar-umbler §6)', () => {
  const nav = (me: Me) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['me'], me);
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/configuracoes/importar-umbler']}>
          <Routes>
            <Route path="/configuracoes/:section?" element={<SettingsPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    return screen.getByRole('navigation', { name: 'Configurações' });
  };
  expect(within(nav(admin)).getByRole('link', { name: 'Importar do Umbler' }).getAttribute('href')).toBe('/configuracoes/importar-umbler');
  cleanup();
  const agentNav = nav({ ...admin, id: 'u2', role: 'agent' });
  expect(within(agentNav).queryByRole('link', { name: 'Importar do Umbler' })).toBeNull();
  expect(within(agentNav).getByRole('link', { name: 'Perfil' }).getAttribute('aria-current')).toBe('page'); // sent back to Perfil
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w web -- src/lib/api.test.ts src/pages/settings`
Expected: FAIL. `api.umblerImport` is undefined, `./UmblerImportSettings` does not exist, and the nav has no "Importar do Umbler" link.

- [ ] **Step 3: Add the client**

In `web/src/lib/api.ts`, replace

```ts
  TimelineItem,
  UserDto,
  UserPreferences,
} from '@talk/shared';
```

with

```ts
  TimelineItem,
  UmblerImportDto,
  UmblerImportStatusDto,
  UmblerMappingDto,
  UserDto,
  UserPreferences,
} from '@talk/shared';
```

replace

```ts
  botRuns: {
    listForChat: (chatId: string) => request<BotRunDto[]>('GET', `/api/chats/${enc(chatId)}/bot-runs`),
    start: (chatId: string, botId: string) => request<BotRunDto>('POST', `/api/chats/${enc(chatId)}/bot-runs`, { botId }),
    stop: (runId: string) => request<BotRunDto>('POST', `/api/bot-runs/${enc(runId)}/stop`),
  },
});
```

with

```ts
  botRuns: {
    listForChat: (chatId: string) => request<BotRunDto[]>('GET', `/api/chats/${enc(chatId)}/bot-runs`),
    start: (chatId: string, botId: string) => request<BotRunDto>('POST', `/api/chats/${enc(chatId)}/bot-runs`, { botId }),
    stop: (runId: string) => request<BotRunDto>('POST', `/api/bot-runs/${enc(runId)}/stop`),
  },
  /** Spec 2026-10-21 importar-umbler §10 (admin). */
  umblerImport: {
    get: () => request<UmblerImportStatusDto>('GET', '/api/umbler-import'),
    analyze: () => request<UmblerImportDto>('POST', '/api/umbler-import/analyze'),
    start: (id: string, mapping: UmblerMappingDto) => request<UmblerImportDto>('POST', `/api/umbler-import/${enc(id)}/start`, { mapping }),
    resume: (id: string) => request<UmblerImportDto>('POST', `/api/umbler-import/${enc(id)}/resume`),
  },
});
```

and replace

```ts
  /** Under ['chats'] so the WS reconnect invalidation refreshes it too. */
  chatBotRuns: (chatId: string) => ['chats', 'bot-runs', chatId] as const,
};
```

with

```ts
  /** Under ['chats'] so the WS reconnect invalidation refreshes it too. */
  chatBotRuns: (chatId: string) => ['chats', 'bot-runs', chatId] as const,
  umblerImport: ['umbler-import'] as const,
};
```

- [ ] **Step 4: Write the page**

Create `web/src/pages/settings/UmblerImportSettings.tsx`:

```tsx
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  UMBLER_IMPORT_ERRORS, UMBLER_IMPORT_PHASES, UMBLER_PHASE_LABELS, formatOfficeDateTime,
  type ChannelDto, type UmblerAnalysisDto, type UmblerCountsDto, type UmblerImportDto, type UmblerMappingDto,
} from '@talk/shared';
import { api, qk } from '../../lib/api';
import { confirmDialog } from '../../lib/confirm';
import { formatPhone } from '../../lib/format';
import { fieldSelect } from '../../components/ui';
import { ErrorText, Loading, PageHeader, SettingRow, SettingsSection, block, btnPrimary, btnSecondary } from '../../components/settings/common';

// Spec 2026-10-21 importar-umbler §6: Ajustes › Importar do Umbler (admins only; the server answers 403 to anyone else).

const POLL_MS = 3_000;
const n = (x: number) => x.toLocaleString('pt-BR');
const day = (iso: string) => new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
const gb = (bytes: number) => (bytes / 1024 ** 3).toLocaleString('pt-BR', { maximumFractionDigits: 1 });
const list = (names: string[]) => names.join(', ');

/** "(duração 2 h 15 min)" */
export function durationText(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const h = Math.floor(minutes / 60);
  return h ? `${h} h ${minutes % 60} min` : `${minutes} min`;
}

/** The counters while it runs (§6.1). */
export function progressLines(p: UmblerCountsDto): string[] {
  return [
    `Contatos: ${n(p.contacts.created + p.contacts.completed + p.contacts.lidOnly)}`,
    `Conversas: ${n(p.chats.openCreated + p.chats.openMerged + p.chats.closed)}`,
    `Mensagens: ${n(p.messages.total)} (notas internas: ${n(p.messages.notes)})`,
    `Observações: ${n(p.notes)}`,
    `Arquivos: ${n(p.files.saved)} baixados, ${n(p.files.expired)} indisponíveis`,
    `Casadas com o histórico do WhatsApp: ${n(p.messages.matched)}`,
  ];
}

/** The final report (§6.4): created / already here / left out, per item. */
export function reportLines(r: UmblerCountsDto): string[] {
  const lines = [
    `Setores: ${n(r.sectors.created)} criados, ${n(r.sectors.existing)} já existiam`,
    `Etiquetas: ${n(r.tags.created)} criadas, ${n(r.tags.existing)} já existiam`,
    `Campos personalizados: ${n(r.customFields.created)} criados, ${n(r.customFields.existing)} já existiam` +
      (r.customFields.unsupported.length ? `; não suportados: ${list(r.customFields.unsupported)}` : ''),
    `Atendentes: ${n(r.members.linked)} vinculados, ${n(r.members.createdInactive)} criados inativos, ${n(r.members.none)} sem atendente`,
    `Respostas rápidas: ${n(r.quickAnswers.created)} criadas, ${n(r.quickAnswers.existing)} já existiam` +
      (r.quickAnswers.unmappedVariables.length ? `; variáveis não convertidas em: ${list(r.quickAnswers.unmappedVariables)}` : '') +
      (r.quickAnswers.attachmentErrors.length ? `; anexos que falharam em: ${list(r.quickAnswers.attachmentErrors)}` : ''),
    `Contatos: ${n(r.contacts.created)} criados, ${n(r.contacts.completed)} completados, ${n(r.contacts.lidOnly)} só com LID, ` +
      `${n(r.contacts.skipped)} ignorados sem telefone nem LID`,
    `Observações: ${n(r.notes)}`,
    `Conversas abertas: ${n(r.chats.openCreated)} criadas, ${n(r.chats.openMerged)} juntadas a uma conversa aberta daqui`,
    `Conversas finalizadas: ${n(r.chats.closed)}`,
    `Conversas ignoradas: ${n(r.chats.skippedChannel)} de canal “Não importar”, ${n(r.chats.skippedEmpty)} sem mensagens, ` +
      `${n(r.chats.skippedDeleted)} apagadas aqui, ${n(r.chats.skippedNoAddress)} sem telefone nem LID`,
    `Mensagens: ${n(r.messages.total)} (notas ${n(r.messages.notes)}, de chatbot ${n(r.messages.bot)}, ` +
      `de atendente desconhecido ${n(r.messages.unknownAuthor)}, sem conteúdo para o token ${n(r.messages.redacted)})`,
    `Casadas com o histórico do WhatsApp: ${n(r.messages.matched)} (maior diferença: ` +
      `${(r.messages.maxMatchDiffMs / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} s)`,
    `Arquivos: ${n(r.files.saved)} baixados (${gb(r.files.bytes)} GB), ${n(r.files.expired)} indisponíveis`,
  ];
  if (r.gone) lines.push(`Apagados no Umbler durante a cópia: ${n(r.gone)}`);
  if (r.planLimited) lines.push('O plano do Umbler escondeu mensagens antigas; elas não vieram.');
  return lines;
}

type ChannelRow = UmblerAnalysisDto['channels'][number];

/** §6.2/§6.3 under a channel's selector: what its destination means. */
export function channelHint(ch: ChannelRow, target: string, ours: ChannelDto[]): string | null {
  if (target === 'none') return `${n(ch.chats)} conversas deste canal não vêm.`;
  const to = ours.find((c) => c.id === target);
  if (!to || !ch.phone || to.phone === ch.phone) return null;
  if (target === ch.proposal) {
    return `As conversas do número ${formatPhone(ch.phone)} entram no canal ${to.name}; respostas a elas saem do número oficial.`;
  }
  return to.phone ? `Respostas nessas conversas sairão do número ${formatPhone(to.phone)}.` : null;
}

function Lines({ lines }: { lines: string[] }) {
  return (
    <ul className="mt-2 space-y-1.5 text-sm text-fg-2">
      {lines.map((line, i) => (
        <li key={i}>{line}</li>
      ))}
    </ul>
  );
}

function Blocks({ blocks }: { blocks: string[] }) {
  return blocks.map((b) => (
    <p key={b} role="alert" className={`${block} mt-3 text-sm font-semibold text-danger`}>
      {b}
    </p>
  ));
}

function Analysis({ imp, analysis: a, onStart, pending }: {
  imp: UmblerImportDto;
  analysis: UmblerAnalysisDto;
  onStart: (mapping: UmblerMappingDto) => void;
  pending: boolean;
}) {
  const channels = useQuery({ queryKey: qk.channels, queryFn: api.channels.list });
  const sectors = useQuery({ queryKey: qk.sectors, queryFn: api.sectors.list });
  const users = useQuery({ queryKey: qk.users, queryFn: api.users.list });
  const [mapping, setMapping] = useState<UmblerMappingDto>(() => ({
    channels: Object.fromEntries(a.channels.map((c) => [c.id, c.proposal])),
    sectors: Object.fromEntries(a.sectors.map((s) => [s.id, s.proposal])),
    members: Object.fromEntries(a.members.map((m) => [m.id, m.proposal])),
  }));
  if (!channels.data || !sectors.data || !users.data) return <Loading error={channels.error ?? sectors.error ?? users.error} />;
  const set = (group: keyof UmblerMappingDto, id: string, value: string) =>
    setMapping((m) => ({ ...m, [group]: { ...m[group], [id]: value } }));
  const contactsToImport = a.contacts.total - a.contacts.withoutAddress;

  async function confirmStart() {
    const ok = await confirmDialog({
      title: `Importar ${n(contactsToImport)} contatos e ${n(a.chats.open + a.chats.closed)} conversas do Umbler?`,
      body: 'A cópia roda em segundo plano e pode levar algumas horas.',
      confirmLabel: 'Importar',
      danger: false,
    });
    if (ok) onStart(mapping);
  }

  return (
    <>
      <SettingsSection title="O que foi encontrado" description={`Organização ${a.organization} no Umbler Talk.`}>
        <Lines
          lines={[
            `Contatos: ${n(contactsToImport - a.contacts.existing)} novos, ${n(a.contacts.existing)} já existem aqui, ` +
              `${n(a.contacts.withoutAddress)} sem telefone nem LID (não vêm)`,
            `Conversas abertas: ${n(a.chats.open)} (das quais ${n(a.chats.waiting)} esperando)`,
            `Conversas finalizadas: ${n(a.chats.closed)}`,
            ...(a.chats.from && a.chats.to ? [`Período: de ${day(a.chats.from)} a ${day(a.chats.to)}`] : []),
            `Setores: ${n(a.sectors.length)} · Atendentes: ${n(a.members.length)}`,
            `Etiquetas: ${n(a.tags.new)} novas, ${n(a.tags.existing)} já existem`,
            `Campos: ${n(a.customFields.new)} novos, ${n(a.customFields.existing)} já existem` +
              (a.customFields.unsupported.length ? `; não suportados: ${list(a.customFields.unsupported)}` : ''),
            `Respostas rápidas: ${n(a.quickAnswers.new)} novas, ${n(a.quickAnswers.existing)} já existem`,
          ]}
        />
      </SettingsSection>

      <SettingsSection title="Canais">
        {a.channels.map((ch) => {
          const id = `umbler-channel-${ch.id}`;
          const hint = channelHint(ch, mapping.channels[ch.id] ?? 'none', channels.data);
          return (
            <SettingRow
              key={ch.id}
              label={ch.name}
              htmlFor={id}
              description={
                <>
                  {`${ch.whatsapp ? 'WhatsApp' : 'Não é WhatsApp'}${ch.phone ? ` · ${formatPhone(ch.phone)}` : ''} · ${n(ch.chats)} conversas`}
                  {hint && <span className="block text-fg-2">{hint}</span>}
                </>
              }
              control={
                <select
                  id={id}
                  value={mapping.channels[ch.id]}
                  disabled={!ch.whatsapp}
                  onChange={(e) => set('channels', ch.id, e.target.value)}
                  className={`${fieldSelect} w-64`}
                >
                  {ch.whatsapp &&
                    channels.data.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.phone ? `${c.name} (${formatPhone(c.phone)})` : c.name}
                      </option>
                    ))}
                  <option value="none">Não importar</option>
                </select>
              }
            />
          );
        })}
      </SettingsSection>

      <SettingsSection title="Setores">
        {a.sectors.map((s) => {
          const id = `umbler-sector-${s.id}`;
          return (
            <SettingRow
              key={s.id}
              label={s.name}
              htmlFor={id}
              control={
                <select id={id} value={mapping.sectors[s.id]} onChange={(e) => set('sectors', s.id, e.target.value)} className={`${fieldSelect} w-64`}>
                  {sectors.data.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                  <option value="create">{`Criar setor “${s.name}”`}</option>
                </select>
              }
            />
          );
        })}
      </SettingsSection>

      <SettingsSection title="Atendentes">
        {a.members.map((m) => {
          const id = `umbler-member-${m.id}`;
          return (
            <SettingRow
              key={m.id}
              label={m.name}
              htmlFor={id}
              description={`${m.email} · ${m.active ? 'ativo' : 'inativo'} no Umbler · ${n(m.chats)} conversas`}
              control={
                <select id={id} value={mapping.members[m.id]} onChange={(e) => set('members', m.id, e.target.value)} className={`${fieldSelect} w-64`}>
                  {users.data.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.active ? u.name : `${u.name} (inativo)`}
                    </option>
                  ))}
                  <option value="create">Criar usuário inativo</option>
                  <option value="none">Sem atendente</option>
                </select>
              }
            />
          );
        })}
      </SettingsSection>

      <SettingsSection title="Avisos">
        <Blocks blocks={imp.blocks} />
        <Lines lines={a.warnings} />
      </SettingsSection>

      <div className="mt-7 flex flex-wrap gap-2">
        <button type="button" disabled={pending || imp.blocks.length > 0} onClick={() => void confirmStart()} className={btnPrimary}>
          Importar
        </button>
      </div>
    </>
  );
}

function Running({ imp }: { imp: UmblerImportDto }) {
  const phase = imp.phase ?? 'catalog';
  const p = imp.progress;
  const of = p && p.total > 0 ? ` — ${n(p.done)} de ${n(p.total)}` : '';
  return (
    <SettingsSection title="Importando">
      <p role="status" className="text-sm font-semibold">
        {`Etapa ${UMBLER_IMPORT_PHASES.indexOf(phase) + 1} de ${UMBLER_IMPORT_PHASES.length}: ${UMBLER_PHASE_LABELS[phase]}${of}`}
      </p>
      {p && <Lines lines={progressLines(p)} />}
      <p className="mt-3 text-[13px] leading-[18px] text-muted">
        Pode fechar esta tela: a importação continua no servidor e retoma sozinha se o sistema reiniciar.
      </p>
    </SettingsSection>
  );
}

function Failed({ imp, onResume, pending }: { imp: UmblerImportDto; onResume: () => void; pending: boolean }) {
  const reason = UMBLER_IMPORT_ERRORS[imp.error ?? 'unexpected'].replace(/\.$/, '');
  if (!imp.startedAt) {
    // an analysis that stopped: "Analisar de novo" starts another one
    return (
      <p role="alert" className={`${block} mt-5 text-sm font-semibold text-danger`}>
        {`A análise parou: ${reason}.`}
      </p>
    );
  }
  return (
    <SettingsSection title="Importação">
      <p role="alert" className="text-sm font-semibold text-danger">{`A importação parou: ${reason}. O que já entrou fica.`}</p>
      <Blocks blocks={imp.blocks} />
      {imp.progress && <Lines lines={progressLines(imp.progress)} />}
      <button type="button" disabled={pending || imp.blocks.length > 0} onClick={onResume} className={`${btnPrimary} mt-4`}>
        Continuar
      </button>
    </SettingsSection>
  );
}

function Done({ imp }: { imp: UmblerImportDto }) {
  const r = imp.report;
  return (
    <SettingsSection title="Relatório">
      <p role="status" className="text-sm font-semibold">
        {`Importação concluída em ${imp.finishedAt ? formatOfficeDateTime(imp.finishedAt) : ''} (duração ${durationText(r?.durationMs ?? 0)}).`}
      </p>
      {r && <Lines lines={reportLines(r)} />}
    </SettingsSection>
  );
}

export function UmblerImportSettings() {
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: qk.umblerImport,
    queryFn: api.umblerImport.get,
    // §6: polls while it analyzes or imports (no WS event)
    refetchInterval: (q) => {
      const state = q.state.data?.current?.state;
      return state === 'analyzing' || state === 'running' ? POLL_MS : false;
    },
  });
  const act = useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.umblerImport }),
  });
  if (!status.data) return <Loading error={status.error} />;
  const { tokenConfigured, current } = status.data;
  const active = current?.state === 'analyzing' || current?.state === 'running';

  return (
    <>
      <PageHeader
        title="Importar do Umbler"
        description="Traz do Umbler Talk os contatos, os cadastros, os atendentes e todas as conversas, abertas e finalizadas."
      />
      <SettingsSection title="Token de acesso">
        <SettingRow
          label="Token do Umbler"
          description={
            tokenConfigured ? (
              'Token do Umbler configurado.'
            ) : (
              <>
                Token do Umbler não configurado. Coloque <code>UMBLER_TOKEN</code> no arquivo <code>.env</code> do servidor e reinicie o
                sistema.
              </>
            )
          }
          control={
            !active && (
              <button
                type="button"
                disabled={!tokenConfigured || act.isPending}
                onClick={() => act.mutate(() => api.umblerImport.analyze())}
                className={current ? btnSecondary : btnPrimary}
              >
                {current ? 'Analisar de novo' : 'Analisar'}
              </button>
            )
          }
        />
      </SettingsSection>
      <ErrorText error={act.error} />

      {current?.state === 'analyzing' && (
        <p role="status" className={`${block} mt-5 text-sm font-semibold`}>
          {`Analisando o Umbler… ${n(current.progress?.chatsRead ?? 0)} conversas lidas`}
        </p>
      )}
      {current?.state === 'analyzed' && current.analysis && (
        <Analysis
          key={current.id}
          imp={current}
          analysis={current.analysis}
          pending={act.isPending}
          onStart={(mapping) => act.mutate(() => api.umblerImport.start(current.id, mapping))}
        />
      )}
      {current?.state === 'running' && <Running imp={current} />}
      {current?.state === 'failed' && (
        <Failed imp={current} pending={act.isPending} onResume={() => act.mutate(() => api.umblerImport.resume(current.id))} />
      )}
      {current?.state === 'done' && <Done imp={current} />}
    </>
  );
}
```

- [ ] **Step 5: Add it to Ajustes**

In `web/src/pages/settings/SettingsPage.tsx`, replace

```tsx
import {
  BuildingsIcon, ChatsCircleIcon, FunnelIcon, LightningIcon, MagnifyingGlassIcon, RobotIcon, SlidersHorizontalIcon, TagIcon,
  TextAaIcon, TimerIcon, UserCircleIcon, UsersThreeIcon, WhatsappLogoIcon, type Icon,
} from '@phosphor-icons/react';
```

with

```tsx
import {
  BuildingsIcon, ChatsCircleIcon, CloudArrowDownIcon, FunnelIcon, LightningIcon, MagnifyingGlassIcon, RobotIcon, SlidersHorizontalIcon,
  TagIcon, TextAaIcon, TimerIcon, UserCircleIcon, UsersThreeIcon, WhatsappLogoIcon, type Icon,
} from '@phosphor-icons/react';
```

replace

```tsx
import { BotsSettings } from './bots/BotsSettings';
```

with

```tsx
import { BotsSettings } from './bots/BotsSettings';
import { UmblerImportSettings } from './UmblerImportSettings';
```

and replace

```tsx
  { path: 'campos', label: 'Campos personalizados', icon: TextAaIcon, group: 'Equipe e cadastros', adminOnly: true, page: CustomFieldsSettings },
];
```

with

```tsx
  { path: 'campos', label: 'Campos personalizados', icon: TextAaIcon, group: 'Equipe e cadastros', adminOnly: true, page: CustomFieldsSettings },
  { path: 'importar-umbler', label: 'Importar do Umbler', icon: CloudArrowDownIcon, group: 'Equipe e cadastros', adminOnly: true, page: UmblerImportSettings },
];
```

- [ ] **Step 6: Run the tests and the type check**

Run: `npm test -w web`
Expected: PASS.

Run: `npm run typecheck`
Expected: no errors in any workspace.

- [ ] **Step 7: Commit**

```bash
git add web/src/lib/api.ts web/src/lib/api.test.ts web/src/pages/settings/UmblerImportSettings.tsx web/src/pages/settings/UmblerImportSettings.test.tsx web/src/pages/settings/SettingsPage.tsx web/src/pages/settings/SettingsPage.test.tsx
git commit -m "feat(web): Importar do Umbler page (analysis, mapping, blocks, progress, Continuar and the report)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Docs: IMPLANTACAO §5, the go-live checklist and the acceptance script

Spec §13: `IMPLANTACAO.md` §5 becomes the screen's procedure, covering the token in the `.env`, the rules switched off, Analisar and Importar. It adds the rehearsal in the test environment, which gets the same protection as production and is erased at the end, and the go-live order. The go-live list trades "Cadastros importados" for "Importar do Umbler". The `Dockerfile` comment about `import-report.json` goes with the CLI. The acceptance script is spec §15, as a checklist.

**Files:**
- Modify: `docs/IMPLANTACAO.md` (§5; the go-live checklist line)
- Modify: `Dockerfile` (one comment)
- Create: `docs/superpowers/plans/2026-10-21-importar-umbler-aceite.md`

**Interfaces:**
- Consumes: the screen copy of Task 12; `UMBLER_TOKEN` (Task 1).
- Produces: nothing in code.

- [ ] **Step 1: Rewrite §5 of the deployment guide**

In `docs/IMPLANTACAO.md`, replace the whole §5

````markdown
## 5. Importar do Umbler Talk

O importador traz contatos, setores, etiquetas, campos personalizados e respostas rápidas, com anexos e variáveis. O histórico de conversas fica no Umbler.

1. No Umbler Talk: **Conta → Perfil → Tokens de acesso** → crie um token.
2. No servidor:

```bash
cd /opt/talk
read -rs -p 'Token do Umbler: ' UMBLER_TOKEN; echo; export UMBLER_TOKEN
# 1) Ensaio (--dry-run): lê tudo do Umbler, mostra as contagens e desfaz no fim. Nada é gravado.
docker compose exec -T -e UMBLER_TOKEN app node --import tsx server/src/importer/cli.ts --dry-run
# 2) Se o ensaio estiver certo, a importação real:
docker compose exec -T -e UMBLER_TOKEN app node --import tsx server/src/importer/cli.ts
unset UMBLER_TOKEN
# 3) Cópia do relatório da importação real no servidor:
docker compose cp app:/data/import-report.json data/backup/relatorio-importacao.json
```

3. Leia o relatório: ele sai na tela nos dois passos (o `-T` evita caracteres de terminal no texto) e a importação real também o grava em `/data/import-report.json` dentro do container, copiado acima para `data/backup/relatorio-importacao.json`. Ele lista o que não pôde ser convertido, como variáveis `{{n}}` sem correspondência ou anexos que não baixaram. Corrija esses itens à mão na tela de Configurações.
4. Apague o token no Umbler depois da importação.

````

with

````markdown
## 5. Importar do Umbler Talk

A tela **Ajustes › Importar do Umbler** (só administradores) traz do Umbler Talk tudo o que o escritório tem lá: contatos (com etiquetas, campos e observações), setores, etiquetas, campos personalizados, respostas rápidas, atendentes e **todas as conversas**, abertas e finalizadas, com mensagens, notas internas e arquivos. O importador só **lê** o Umbler (só `GET`; nunca marca conversa como lida).

1. No Umbler Talk, entre com o **Proprietário**: **Conta → Perfil → Tokens de acesso** → crie um token.
2. No servidor, coloque o token no `.env` e recrie o app. O token nunca aparece na tela, nos logs nem no banco:

```bash
cd /opt/talk
read -rs -p 'Token do Umbler: ' UMBLER_TOKEN; echo
printf 'UMBLER_TOKEN=%s\n' "$UMBLER_TOKEN" >> .env; unset UMBLER_TOKEN
chmod 600 .env
docker compose up -d app
```

3. Em **Configurações › Regras automáticas**, desligue as duas regras: com elas ligadas a importação fica bloqueada.
4. Em **Ajustes › Importar do Umbler**, clique em **Analisar** (cerca de 1 minuto). Confira as contagens, os avisos e o destino de cada canal, setor e atendente. Atendente sem e-mail igual aqui vira usuário **inativo**: guarda quem atendeu cada conversa e pode ser ativado em Ajustes › Atendentes.
5. Clique em **Importar**. A cópia roda em segundo plano (algumas horas, conforme o volume de arquivos), retoma sozinha se o sistema reiniciar e termina com um relatório na mesma tela. Se parar, a tela diz o motivo e oferece **Continuar**.
6. Com o relatório conferido: apague o token no Umbler, tire a linha `UMBLER_TOKEN` do `.env` e rode `docker compose up -d app`.

**Ensaio (ambiente de teste, antes da virada).** O ensaio recebe dados reais de clientes: o ambiente de teste precisa da mesma proteção da produção (HTTPS, senhas fortes, acesso restrito). No mapeamento, escolha o canal de teste para o canal do Umbler. Ninguém responde cliente pelo número de teste. Siga o [roteiro de aceite](superpowers/plans/2026-10-21-importar-umbler-aceite.md) e, no fim, apague o ambiente inteiro: `docker compose down -v` e a pasta `data/media`.

**Dia da virada (produção), nesta ordem:**

1. Fim do expediente no Umbler; anote as contagens de Entrada, Esperando e Finalizados.
2. Conecte o número oficial em Configurações › Canais (isso desconecta o Umbler, que fica congelado) e espere a importação automática do histórico do WhatsApp terminar.
3. Analisar → conferir o mapeamento e as contagens → Importar. As conversas abertas chegam nos primeiros minutos e o escritório já atende aqui; as finalizadas chegam depois, das mais recentes para as mais antigas.
4. Relatório conferido ("casadas com o histórico do WhatsApp" maior que zero e uma conversa recente sem mensagens repetidas) → apague o token → uma semana de consulta → cancele o Umbler e peça o encerramento da organização.

Se o Umbler deixar de responder à API com o canal desconectado, a ordem inversa (importar antes de conectar, com o escritório parado) também funciona: as mensagens repetidas são casadas nos dois sentidos.

````

and, in the go-live checklist (§10), replace

```markdown
- [ ] Cadastros importados do Umbler (seção 5) e relatório de importação revisado.
```

with

```markdown
- [ ] "Importar do Umbler" ensaiado no ambiente de teste (seção 5, roteiro de aceite), relatório revisado e ambiente de teste apagado.
- [ ] No dia da virada: Importar do Umbler na ordem da seção 5 (depois de conectar o número oficial e de o histórico do WhatsApp terminar).
```

- [ ] **Step 2: Drop the CLI from the Dockerfile comment**

In `Dockerfile`, replace

```dockerfile
# /data também do node: o importador grava /data/import-report.json ao lado de /data/media.
```

with

```dockerfile
# /data e /data/media do node: o app grava os arquivos das conversas em /data/media.
```

- [ ] **Step 3: Write the acceptance script**

Create `docs/superpowers/plans/2026-10-21-importar-umbler-aceite.md`:

```markdown
# Aceite manual: Importar do Umbler

Roteiro do §15 da [especificação](../specs/2026-10-21-importar-umbler-design.md). Primeiro no **ambiente de teste**; em produção, no dia da virada, o roteiro da seção 5 do [IMPLANTACAO.md](../../IMPLANTACAO.md) e as mesmas conferências por amostragem.

> ⚠️ O ambiente de teste recebe dados reais de clientes: HTTPS, senhas fortes e acesso restrito, como a produção. Ninguém responde cliente pelo número de teste. No fim, o ambiente é apagado.

## 0. Antes de começar

- [ ] Testes automáticos passando: `npm test`.
- [ ] Anote a versão testada: `git log -1 --format=%h` → `________`
- [ ] No Umbler, anote 3 conversas **abertas com não lidas** e o número do badge de cada uma: `________`, `________`, `________`.
- [ ] Anote as contagens do Umbler: Entrada `____`, Esperando `____`, Finalizados `____` (≈ 9440), Contatos `____` (≈ 2368).

## A. Token e análise

- [ ] Ajustes › Importar do Umbler, sem token: "Token do Umbler não configurado. Coloque UMBLER_TOKEN no arquivo .env do servidor e reinicie o sistema." e **Analisar** desabilitado.
- [ ] Token do Proprietário no `.env` de teste (IMPLANTACAO §5, passo 2): aparece "Token do Umbler configurado." e nenhum pedaço do token.
- [ ] Com as Regras automáticas ligadas, **Analisar** e veja o bloqueio "Desligue as Regras automáticas antes de importar…" com **Importar** desabilitado. Desligue-as e volte à tela: o bloqueio some.
- [ ] "Analisando o Umbler… N conversas lidas" e, em cerca de 1 minuto, "O que foi encontrado": as contagens batem com as anotadas (Finalizados, Contatos, abertas e esperando).
- [ ] O teste de leitura não bloqueou (nenhum aviso "A leitura marcou uma conversa como lida no Umbler…").
- [ ] Canais: o canal do Umbler → **canal de teste** (de propósito). Setores e atendentes conferidos; ex-atendentes em "Criar usuário inativo".
- [ ] Os avisos fazem sentido (espaço livre em disco, limite do plano, token sem acesso total, se houver).

## B. Importação

- [ ] **Importar** → confirmação "Importar N contatos e N conversas do Umbler? A cópia roda em segundo plano e pode levar algumas horas." → **Importar**.
- [ ] A tela mostra "Etapa 3 de 5: conversas abertas — x de y" e os contadores subindo; fechar e reabrir a tela não muda nada.
- [ ] Durante as conversas finalizadas, reinicie o servidor (`docker compose restart app`): a importação continua sozinha, sem duplicar (contadores seguem de onde estavam).
- [ ] Ao fim: "Importação concluída em dd/mm/aaaa hh:mm (duração …)." e o relatório.

## C. O que chegou

- [ ] Abertas na **Entrada** com o mesmo setor, atendente e "esperando" do Umbler; as de ex-atendentes na fila do setor ("Sem atendente").
- [ ] Finalizadas em **Finalizados** com as datas originais; a linha do tempo diz "Conversa importada do Umbler Talk: N mensagens" e "Conversa finalizada por X".
- [ ] Uma conversa com foto, áudio e PDF abre os três arquivos; um arquivo que o Umbler não tem mais mostra "Arquivo não está mais disponível…".
- [ ] Notas internas aparecem como notas; observações do contato aparecem na ficha, com autor e data.
- [ ] Respostas rápidas com anexo funcionam; as "apenas para mim" de um atendente ativo ficam só dele.
- [ ] Ex-atendentes aparecem em Ajustes › Atendentes como **inativos** e não conseguem entrar.
- [ ] Nada disparou: nenhuma triagem, chatbot, aviso ou mensagem ao WhatsApp; finalizadas sem não lidas.

## D. O Umbler não mudou

- [ ] As 3 conversas anotadas continuam com o **mesmo badge** de não lidas; nada mudou de estado.
- [ ] A tela "sendo utilizado em mais de um dispositivo" não apareceu no Umbler.
- [ ] Atividades do Umbler sem entradas novas do token.

## E. Encerramento do ensaio

- [ ] Relatório revisado (casadas com o histórico, maior diferença, arquivos indisponíveis).
- [ ] Ninguém respondeu cliente pelo número de teste.
- [ ] Token apagado no Umbler e tirado do `.env`.
- [ ] Ambiente de teste apagado: `docker compose down -v` e a pasta `data/media`.
```

- [ ] **Step 4: Check and run everything**

Run: `grep -rn "import:umbler\|importer/cli\|import-report" docs/IMPLANTACAO.md Dockerfile README.md server/src server/package.json`
Expected: nothing.

Run: `npm test`
Expected: PASS in every workspace.

Run: `npm run typecheck`
Expected: no errors in any workspace.

- [ ] **Step 5: Commit**

```bash
git add docs/IMPLANTACAO.md Dockerfile docs/superpowers/plans/2026-10-21-importar-umbler-aceite.md
git commit -m "docs: Importar do Umbler na implantação (ensaio, virada) e roteiro de aceite" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Self-review checklist (for the executor, after Task 13)

- [ ] Spec §3, GET only and never the read route:
  - the scan test (Task 2) passes;
  - every importer test ends with `fake.problems()` empty;
  - `grep -rn "fetchImpl(" server/src/importer` shows exactly two lines, both inside `createUmblerClient` (the API call and the file link).
- [ ] Spec §4, the calls:
  - `ContactTypes=DirectMessage`, the three `Visibility` values, `IncludePinneds=false`;
  - open chats `CreatedAtUTC Asc`, finished `ClosedAtUTC Desc`; `Behavior=CountAllAndGetSlice` on the first page in Analisar only;
  - `relative-messages` with `FromEventUTC`, `TakeAfter`, `Take=250`, `IncludeMetadata=false`, the next page from last − 1 ms with seen ids dropped;
  - `includeCustomFields`, with the per-contact fallback.
- [ ] Spec §5:
  - the read test on the newest finished "Received" chat, and the block;
  - open chats without unread first, then the unread check after each, and the stop with `umbler_marked_read`;
  - 100 ms between calls.
- [ ] Spec §6, the screen:
  - the six states with their exact copy;
  - "Analisar de novo" / "Importar", and the confirmation text;
  - per-channel hints, blocks and warnings, the 3 s polling, admin only.
- [ ] Spec §7.1-7.2:
  - names compared without case;
  - "apenas para mim" for an active owner;
  - inactive users with a random hash and no sectors;
  - unsupported fields listed.
- [ ] Spec §7.3-7.6:
  - "Não importar" and non-WhatsApp channels skipped;
  - LID-only contacts and `mergeLidPairs` before chats;
  - notes with author and `done_at`;
  - open, joined and finished chats; tombstone, deleted here, empty chat;
  - `chat.updated` only for open chats.
- [ ] Spec §7.7-7.8:
  - every type, signature, note, bot or phone, reactions, reply, deleted, edited, redacted, location and contact card;
  - files 4 at a time without `Authorization`, 64 MB, expired vs temporary, `disk_full` below 2 GB, retried on a new run.
- [ ] Spec §8:
  - both directions (Task 9 and Task 6 tests);
  - `maxMatchDiffMs` in the report;
  - history chat removed when emptied.
- [ ] Spec §9:
  - phase order;
  - `umbler_map` before every insert;
  - `done_at`, and a finished closed chat without calls;
  - resume after a stop, the wait for the history import, one active import (409);
  - the §9.4 waits and codes.
- [ ] Spec §10:
  - `UMBLER_TOKEN` in `config.ts`, `docker-compose.yml` and `.env.example`;
  - never in a DTO, row, report or log (`grep -rn "umblerToken" server/src` shows only `config.ts`, `routes.ts` (`!== null`) and `job.ts` (`createUmblerClient`)).
- [ ] Spec §12: `analysis` and `report` hold counts, office names (sectors, tags, fields, answers, attendants, channels) and no client data.
- [ ] Spec §13 and §15: IMPLANTACAO §5, the checklist line, and the acceptance script.
- [ ] Logs: `grep -rn "console\." server/src/importer` shows only ids, counts, the phase, the code, the route template and `errorTag(err)`.
- [ ] `ls server/drizzle/*.sql | tail -2` shows `0008_agendamentos_e_regras.sql` then `0009_importar_umbler.sql`, and `git diff origin/main -- server/drizzle/0008_agendamentos_e_regras.sql server/drizzle/meta/0008_snapshot.json` prints nothing.
