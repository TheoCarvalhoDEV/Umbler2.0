# Chat List Day-to-Day (order, bulk actions, conversation tags) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let agents choose the order of the chat list (including "longest waiting first"), act on up to 50 chats at once (transfer, close, mark read) and tag a conversation with its own tags, apart from the contact's.

**Architecture:** Shared constants first (`CHAT_SORTS`, `BULK_MAX`, `BulkResultDto`), then one migration (`chat_tags`, `chats.waiting_since`). The server keeps `waiting_since` next to every write of `waiting`. `listChats` becomes a list of keyset "runs": one run for the plain orders, and two for "waiting" (waiting ascending, then the rest descending). Each run is a plain `(key, id)` query, and the cursor carries the order and the run. Bulk actions are three routes that loop over the chats one at a time. Each step calls the same service the single action calls, so the same rules apply, and each chat gets its own result. Conversation tags reuse the tag catalog through a `chat_tags` join. They go out in the same `ChatListItem` that REST and the WebSocket already share. The web adds an invisible native `<select>` over an icon for the order (kept in `localStorage`), a selection mode on the cards with a bottom bar that reuses the transfer and close dialogs, tag chips on the card, a filter, and an editor in "Detalhes da conversa".

**Tech Stack:** Node 24, TypeScript 5.9.3 strict ESM, Fastify 5.12.7, drizzle-orm 0.45.4 / drizzle-kit 0.31.11, Postgres (PGlite 0.5.10 in tests), zod 4.6.7, vitest 5.0.4, React 19.3.1, @tanstack/react-query 5.104.2, react-router 8.4.0, Tailwind 4.3.3, @phosphor-icons/react 2.1.10. **No new dependency.**

**Spec:** `docs/superpowers/specs/2026-10-20-lista-dia-a-dia-design.md`.

**Base code.** This plan runs on `feat/lista-dia-a-dia`, on top of delivery 1 (merged in `main` 967b647: migration `0006`, notes edit/delete, search with `around`/`after` timeline cursors, favorites, preferences) and of commit 6cb812b (`ChatListItem.lastOutStatus` filled in `toChatListItem` by one more query; a reply from the office phone sets `unread: 0` in the ingest; a status update calls `publishChat`; `ChatListItem.tsx` shows `OutTick` before the preview). Every "replace X with Y" snippet below quotes that code verbatim. Delivery 1 rewrote `MessageBubble`, `MessageMenu`, `ConversationHeader`, `Composer`, `Timeline` and `ws.ts`; **this plan edits none of those.** Every Y keeps what delivery 1 and 6cb812b added. The files both touch, and what must survive:
- `shared/src/index.ts`: the `preferences.js`/`search.js` exports, `Me.preferences`, `MessageDto.favorite`, `MessageSearchHit`, `note_deleted`, `ChatListItem.lastOutStatus`.
- `server/src/db/schema.ts`, `server/drizzle/meta/*`, `server/test/db/schema.test.ts`: `users.preferences` and `message_favorites` (24 tables today; this plan makes 25).
- `server/src/inbox/queries.ts`: `searchChat`, the timeline cursors, the `FOLD_*`/`SEARCH_LIMIT` imports, and the `lastOutStatus` query in `toChatListItem`. This plan changes the imports, the top constants, `toChatListItem` and `listChats` only.
- `server/src/messages/ingest.ts`: the outbound branch's `unread: 0` and the `publishChat` after a status update.
- `server/src/chats/routes.ts`: the `SEARCH_*` import, `timelineQuery`, the search, note and favorite routes. This plan changes the imports, `listQuery`, the `close` action, and adds routes.
- `server/test/realtime/hub.test.ts`: `lastOutStatus: null` and `favorite: null` in the expected objects.
- `web/src/lib/api.ts` (+ `api.test.ts`): `setPreferences`, `timeline` cursors, `search`, `favorites`, `api.messages.favorite`, `api.notes`, and the `describe('api routes of the 2026-10-19 delivery', …)` block.
- `web/src/components/inbox/ChatListItem.tsx` (+ test): `OutTick` and its icons, and the ticks test.
- `web/src/components/contacts/ContactPanel.tsx`: `ChatDetailsTab`'s `onJump` and its `<Section title="Favoritas">`.

## Global Constraints

- No new dependency in any workspace.
- Every read and mutation of a chat goes through `getChatForUser`, which answers 404 when the user cannot see the chat. `canSee` already limits a private chat to its owner and to an admin with "ver todos", so there is no separate privacy check. A bulk step that gets 404 becomes `{ chatId, error: 'Conversa não encontrada' }` and touches nothing.
- Every new mutation is a non-GET `/api/*` route, so the global Origin check (`authPlugin`) covers it. Its tests send `loginAs(...).headers`, and one test per route family sends no Origin and expects 403.
- Logs never carry message text, phones or names. Only ids, counts and `err.name` go into a log. Bulk actions log only unexpected (non-`HttpError`) failures: `console.error('bulk chat action failed', { chatId, err: err.name })`.
- The migration is generated, never hand-edited: `npm run db:generate -w server -- --name lista_dia_a_dia` creates `0007_lista_dia_a_dia`, right after delivery 1's `0006_conversa_dia_a_dia`. The running dev server (`tsx watch`) applies it to its own database when it restarts. Never run SQL against that database by hand, and never start or stop the dev server.
- Extend, never rename. The new fields are optional (`ChatListFilters.sort`, `ChatListFilters.chatTagId` and `ChatListItem.chatTagIds`), and the server always fills `chatTagIds`. Only the exact `ChatListItem` literal in `hub.test.ts` gains the field.
- Inside `ctx.db.transaction(tx => …)` use only `tx`, because PGlite deadlocks otherwise. Publish to the hub after commit. Nothing new calls Evolution, except the bulk close's closing message, which goes through the existing `sendAgentMessage`.
- Limits: `BULK_MAX = 50` chats per bulk request (zod `.min(1).max(BULK_MAX)`) and at most 50 tag ids per `PUT /api/chats/:id/tags`, like the contact's `TagsBody`. A list shows at most 4 tag chips per card (`MAX_CHIPS`).
- `waiting_since` changes exactly where `waiting` does:
  - an inbound message sets `least(waiting_since, sentAt)`;
  - an outbound ingest, `touchChat`, `closeChat` and `closeChatAsBot` set it to `null`;
  - the dropped-echo restore in `sendSystemMessage` puts back `chat.waitingSince` together with `chat.waiting`.
- The order keys are `coalesce(last_message_at, created_at)` (`lastKey`), `created_at`, and `coalesce(waiting_since, last_message_at, created_at)` (`waitKey`). The tiebreak is always `chats.id` in the key's direction. The cursor is `base64url(JSON [sort, run, keyText, id])`. A cursor of another order, or of the old 2-tuple format, gets 400 `'Cursor inválido'`.
- UI copy is pt-BR, exactly as spec §7:
  - order: control "Ordenar conversas", title "Ordenar: <opção>", options "Última mensagem: mais recentes", "Última mensagem: mais antigas", "Data de criação: mais recentes", "Data de criação: mais antigas", "Esperando há mais tempo";
  - selection: button "Selecionar", checkbox "Selecionar <contato>", hint "Até 50 conversas por vez";
  - bulk bar: "N selecionadas" / "1 selecionada", "Transferir", "Finalizar", "Marcar como lida", "Cancelar";
  - bulk dialogs: "Transferir N conversas" / "Finalizar N conversas" ("1 conversa");
  - result: "X de N concluídas." / "1 de 1 concluída." / "X de N concluídas; Y não puderam: <motivo> / <motivo>" / "1 não pôde"; reasons "Conversa não encontrada", "Erro inesperado" and the single actions' messages without their final period;
  - tags: chip titles "Etiqueta da conversa: <nome>" / "Etiqueta do contato: <nome>", panel section "Etiquetas da conversa", filters "Etiqueta do contato" (renamed from "Etiqueta") and "Etiqueta da conversa".
- Code identifiers are English.
- Theme tokens only (`bg-surface`, `bg-panel`, `bg-sunken`, `bg-sidebar-hover`, `bg-sidebar-active`, `bg-primary-soft`, `text-fg`, `text-muted`, `text-link`, `text-danger`, `border-border`, `border-field`, `ring-primary`, `accent-primary`). Tag colors keep coming from `tagColorHex` as inline styles, as `TagsEditor` does today.
- Reuse what exists:
  - `TransferDialog`, `CloseDialog` and `Modal` (`web/src/components/conversation/ChatDialogs.tsx`);
  - the tag toggles of `TagsEditor`;
  - `closeChat`, `transferChat`, `markChatRead`, `applyBotRunningBehavior`, `getBotRunningBehavior` and `stopRunsForChat`;
  - the test seeds `seedChat`, `setupActions` and `seedWaitingRun`;
  - the `localStorage` try/catch pattern of `web/src/lib/theme.ts`.
- Commit after every task with a Conventional Commit message, staging only that task's files. Every commit command ends with `-m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`.

## Review Focus

These are inputs and conditions the spec implies but never tests, most likely first. The owning task adds the named test.

1. **Paging an order that is not a single key.** "Esperando há mais tempo" is waiting chats ascending followed by the rest descending. Equal keys are common, because history imports and seeds share timestamps. A page that ends at the end of the waiting run, or on a tie, must not repeat or skip a chat. **Owner: Task 3**, test `every order pages through every chat exactly once, across the waiting/rest boundary and on equal keys (Review Focus 1)`.
2. **A cursor from another order.** The web keeps the old pages while the order changes, and a stale tab can still hold an old-format cursor after the deploy. Either must give 400, never a wrong page. **Owner: Task 3**, test `a cursor of another order, or of the old format, is 400 (Review Focus 2)`.
3. **The chatbot or the triage clearing the wait.** `sendSystemMessage` must leave `waiting_since` alone, so a bot greeting does not make a waiting contact look fresh. When the bot message's webhook echo beats the gateway answer, the echo's ingest clears it, and the dropped-echo restore must put it back. **Owner: Task 2**, test `a chatbot or triage message leaves it alone, even when its echo beats the gateway (Review Focus 3)`.
4. **A bulk step on a chat the user may not act on.** Hidden, private, closed and duplicate ids must each give a per-chat result: no 404 or 409 for the whole request, no Evolution call, no change to the hidden chat. Under the default "Perguntar" a running chatbot must be stopped, not answered with 409 `BOT_RUNNING`. **Owner: Task 5**, tests `transfers each chat it can and tells why the others could not (Review Focus 4)` and `stops a running chatbot under "Perguntar" instead of asking, and keeps it under "Manter" (Review Focus 4)`.
5. **A failing closing message in the middle of a bulk close.** That chat stays open with the failed bubble, and the others still close. **Owner: Task 5**, test `closes in bulk with one closing-message choice; a failed send keeps that chat open (Review Focus 5)`.
6. **Conversation tags outliving their tag, or lost in a LID merge.** Deleting a catalog tag must drop it from every chat (FK cascade, not code). When `absorb` deletes a chat, its tags must move to the twin first. **Owner: Task 4**, tests `a tag deleted from the catalog leaves every conversation (Review Focus 6)` and `an absorbed chat's conversation tags move to the twin (Review Focus 6)`.
7. **A selected chat that leaves the list** (a transfer by someone else, chat.removed). The bar must not count it, and the request must not send it. **Owner: Task 8**, which derives `selectedIds` from the loaded list. That code is covered by `keeps the chats that failed selected and says why (spec §4)`.

---

## File Structure

Each line gives the path, the task that creates or first modifies it, and its responsibility.

**Shared**
- `shared/src/chat-list.ts` (T1, create): `CHAT_SORTS`, `ChatSort`, `DEFAULT_CHAT_SORT`, `BULK_MAX`, `BulkResultDto`.
- `shared/src/index.ts` (T1): re-exports; `ChatListFilters.sort?`, `ChatListFilters.chatTagId?`, `ChatListItem.chatTagIds?`.

**Server**
- `server/src/db/schema.ts` (T1): `chats.waitingSince`, table `chatTags`.
- `server/drizzle/0007_lista_dia_a_dia.sql`, `server/drizzle/meta/0007_snapshot.json`, `server/drizzle/meta/_journal.json` (T1): the generated migration.
- `server/src/messages/ingest.ts` (T2): inbound sets `waiting_since`, outbound clears it.
- `server/src/messages/send.ts` (T2): `touchChat` clears it; the dropped-echo restore keeps it.
- `server/src/inbox/chats.ts`:
  - (T2) `closeChat` and `closeChatAsBot` clear `waiting_since`;
  - (T4) adds `setChatTags`;
  - (T5) adds `validateTransferTarget`, which `transferChat` uses.
- `server/src/inbox/queries.ts`:
  - (T3) adds `lastKey`, `waitKey`, `RUNS`, `orderOf` and the order-aware cursor; `listChats` gains `sort` and `chatTagId`;
  - (T4) `toChatListItem` fills `chatTagIds`.
- `server/src/chats/routes.ts`:
  - (T3) `listQuery` gains `sort` and `chatTagId`;
  - (T4) adds `PUT /api/chats/:id/tags`;
  - (T5) adds the three bulk routes, and the `close` action calls `closeChatAndStopBots`.
- `server/src/history/merge.ts` (T4): `absorb` moves the chat tags to the twin.
- `server/src/inbox/bulk.ts` (T5, create): `closeChatAndStopBots`, `bulkTransfer`, `bulkClose`, `bulkRead`.

**Server tests**
- `server/test/db/schema.test.ts` (T1).
- `server/test/chats/seed.ts` (T2): `SeedChatOpts.createdAt?` and `SeedChatOpts.waitingSince?`.
- `server/test/chats/waiting-since.test.ts` (T2, create).
- `server/test/chats/list-order.test.ts` (T3, create).
- `server/test/chats/chat-tags.test.ts` (T4, create), `server/test/realtime/hub.test.ts` (T4), `server/test/history/merge.test.ts` (T4).
- `server/test/chats/bulk.test.ts` (T5, create).

**Web**
- `web/src/lib/api.ts` (+ `api.test.ts`) (T6): `BulkTransferInput`, `api.chats.setTags`, `bulkTransfer`, `bulkClose`, `bulkRead`.
- `web/src/components/inbox/chat-query.ts` (+ `chat-query.test.ts`) (T6): `InboxFilters.chatTagId`, `CHAT_SORT_LABELS`, `readChatSort`, `saveChatSort`, `withSort`.
- `web/src/components/inbox/bulk.ts` (+ `bulk.test.ts`) (T6, create): `bulkSummary`.
- `web/src/components/inbox/ChatListItem.tsx` (+ `ChatListItem.test.tsx`) (T7): tag chips and the `selection` prop.
- `web/src/components/inbox/FilterPanel.tsx` (T7): "Etiqueta do contato" and "Etiqueta da conversa".
- `web/src/components/contacts/TagsEditor.tsx` (+ `TagsEditor.test.tsx`) (T7): the shared `TagToggles` and `ChatTagsEditor`.
- `web/src/components/contacts/ContactPanel.tsx` (T7): the "Etiquetas da conversa" section.
- `web/src/components/conversation/ChatDialogs.tsx` (T8): `title?` on `TransferDialog` and `CloseDialog`; `TransferDialog.chat` narrowed to `Pick<ChatDetail, 'sectorId'>`.
- `web/src/components/inbox/BulkBar.tsx` (T8, create): the bar and its dialogs.
- `web/src/pages/Inbox.tsx` (+ `Inbox.test.tsx`) (T8): the order control, the selection mode, the tag map and the result line.

---

## Shared contract

Every name below is defined in exactly one task and used with this spelling everywhere.

**`shared/src/chat-list.ts` (Task 1)**
```ts
export const CHAT_SORTS: readonly ['last_desc', 'last_asc', 'created_desc', 'created_asc', 'waiting'];
export type ChatSort = (typeof CHAT_SORTS)[number];
export const DEFAULT_CHAT_SORT: ChatSort;   // 'last_desc'
export const BULK_MAX: number;              // 50
export interface BulkResultDto { done: string[]; failed: Array<{ chatId: string; error: string }> }
```

**`shared/src/index.ts` (Task 1)**
```ts
// ChatListFilters gains: sort?: ChatSort; chatTagId?: string
// ChatListItem gains (optional): chatTagIds?: string[]
```

**`server/src/db/schema.ts` (Task 1)**: `chats.waitingSince` (`waiting_since timestamptz`, nullable); table `chatTags` (`chatId` → chats cascade, `tagId` → tags cascade, primary key `(chatId, tagId)`).

**`server/src/inbox/chats.ts`**
```ts
export async function setChatTags(ctx: AppCtx, user: AuthUser, chatId: string, tagIds: string[]): Promise<ChatRow>;            // Task 4
export async function validateTransferTarget(db: Db | Tx, to: { sectorId?: string; ownerId?: string | null }): Promise<void>; // Task 5
```

**`server/src/inbox/bulk.ts` (Task 5)**
```ts
export async function closeChatAndStopBots(ctx: AppCtx, user: AuthUser, chatId: string, sendClosingMessage: boolean): Promise<ChatRow>;
export async function bulkTransfer(ctx: AppCtx, user: AuthUser, chatIds: string[], to: { sectorId?: string; ownerId?: string | null }): Promise<BulkResultDto>;
export async function bulkClose(ctx: AppCtx, user: AuthUser, chatIds: string[], sendClosingMessage: boolean): Promise<BulkResultDto>;
export async function bulkRead(ctx: AppCtx, user: AuthUser, chatIds: string[]): Promise<BulkResultDto>;
```

**HTTP (`server/src/chats/routes.ts`)**
| Route | Body / query | Answer | Task |
|---|---|---|---|
| `GET /api/chats` | gains `sort` (`CHAT_SORTS`) and `chatTagId` (uuid) | `{ items, nextCursor }` | 3 |
| `PUT /api/chats/:id/tags` | `{ tagIds: uuid[] }` (≤ 50) | `ChatDetail` | 4 |
| `POST /api/chats/bulk/transfer` | `{ chatIds, sectorId?, ownerId? }` (one of the two) | `BulkResultDto` | 5 |
| `POST /api/chats/bulk/close` | `{ chatIds, sendClosingMessage }` | `BulkResultDto` | 5 |
| `POST /api/chats/bulk/read` | `{ chatIds }` | `BulkResultDto` | 5 |

`chatIds` is `uuid[]`, 1 to `BULK_MAX`. find-my-way matches the static `/api/chats/bulk/…` before `/api/chats/:id/…`.

**Web**
- `web/src/lib/api.ts` (Task 6):
  - `BulkTransferInput { chatIds; sectorId?; ownerId? }`;
  - `api.chats.setTags(id, tagIds)`, `api.chats.bulkTransfer(input)`, `api.chats.bulkClose({ chatIds, sendClosingMessage })`, `api.chats.bulkRead(chatIds)`.
- `web/src/components/inbox/chat-query.ts` (Task 6): `InboxFilters.chatTagId`, `CHAT_SORT_LABELS: Record<ChatSort, string>`, `readChatSort(userId?)`, `saveChatSort(userId?, sort)` and `withSort(f, sort)`. The storage key is `talk.chatSort.<userId>`.
- `web/src/components/inbox/bulk.ts` (Task 6): `bulkSummary(r: BulkResultDto): string`.
- Components:
  - `ChatListItem` gains the props `tagById?: ReadonlyMap<string, TagDto>` and `selection?: { selected; disabled; onToggle() }` (Task 7);
  - `ChatTagsEditor({ chat })` lives in `TagsEditor.tsx` (Task 7);
  - `TransferDialog` and `CloseDialog` gain `title?` (Task 8);
  - `BulkBar({ chatIds, tab, onResult(summary, failedIds), onCancel })` (Task 8).

---

### Task 1: Shared contract, `chat_tags`, `chats.waiting_since` and migration 0007

Nothing reads the new pieces yet, so this task only has to compile and migrate. The schema test proves the migration matches the schema and that both foreign keys cascade.

**Files:**
- Create: `shared/src/chat-list.ts`
- Modify: `shared/src/index.ts` (imports and re-exports at the top, `ChatListFilters`, `ChatListItem`)
- Modify: `server/src/db/schema.ts` (`chats` columns, new table after `chatPins`)
- Generated: `server/drizzle/0007_lista_dia_a_dia.sql`, `server/drizzle/meta/0007_snapshot.json`, `server/drizzle/meta/_journal.json`
- Test: `server/test/db/schema.test.ts` (import line, table count, new `it`)

**Interfaces:**
- Consumes: nothing new.
- Produces: everything under `shared/src/chat-list.ts`, `shared/src/index.ts` and `server/src/db/schema.ts` in the Shared contract.

- [ ] **Step 1: Write the failing schema test**

In `server/test/db/schema.test.ts`, replace

```ts
import {
  botRuns, botVersions, bots, chats, contacts, historyImports, messageEdits, messageFavorites, messages, sectors,
} from '../../src/db/schema.js';
```

with

```ts
import {
  botRuns, botVersions, bots, chatTags, chats, contacts, historyImports, messageEdits, messageFavorites, messages, sectors, tags,
} from '../../src/db/schema.js';
```

replace `expect(tables).toHaveLength(24);` with `expect(tables).toHaveLength(25);`, and add at the end of the first `describe('database schema', …)`, after the test `rejects a duplicate (channel_id, external_id) but accepts many NULL external ids`:

```ts
  it('chat_tags: one row per (chat, tag), gone with the chat or the tag; waiting_since starts empty (spec 2026-10-20)', async () => {
    const [c] = await db.insert(contacts).values({ phone: '5565999990002' }).returning({ id: contacts.id });
    const [chat] = await db
      .insert(chats)
      .values({ contactId: c!.id, channelId: s.channelId, sectorId: s.defaultSector })
      .returning();
    expect(chat!.waitingSince).toBeNull();
    const [t1, t2] = await db
      .insert(tags)
      .values([{ name: 'Prazo', color: '#ef4444' }, { name: 'Audiência', color: '#2563eb' }])
      .returning({ id: tags.id });
    await db.insert(chatTags).values([{ chatId: chat!.id, tagId: t1!.id }, { chatId: chat!.id, tagId: t2!.id }]);
    expect(await pgCode(db.insert(chatTags).values({ chatId: chat!.id, tagId: t1!.id }))).toBe(UNIQUE_VIOLATION);

    await db.delete(tags).where(eq(tags.id, t1!.id));
    expect((await db.select().from(chatTags)).map((r) => r.tagId)).toEqual([t2!.id]);
    await db.delete(chats).where(eq(chats.id, chat!.id));
    expect(await db.select().from(chatTags)).toEqual([]);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w server -- test/db/schema.test.ts`
Expected: FAIL. `chatTags` is not exported by `schema.js` (`does not provide an export named 'chatTags'`, or the type error), and the table count is off by one.

- [ ] **Step 3: Create the shared module**

Create `shared/src/chat-list.ts`:

```ts
// Chat list order and bulk actions (spec 2026-10-20 §3, §4). Runtime values with no imports: tsx (server) and
// Vite (web) load this source directly.

/** The list orders. `waiting` = waiting chats first (longest wait on top), then the rest by last message. */
export const CHAT_SORTS = ['last_desc', 'last_asc', 'created_desc', 'created_asc', 'waiting'] as const;
export type ChatSort = (typeof CHAT_SORTS)[number];
/** Today's order: last message, newest first. */
export const DEFAULT_CHAT_SORT: ChatSort = 'last_desc';

/** Chats per bulk request (spec §4). */
export const BULK_MAX = 50;

/** Answer of POST /api/chats/bulk/*: each chat once, in request order; `error` is a short pt-BR reason. */
export interface BulkResultDto { done: string[]; failed: Array<{ chatId: string; error: string }> }
```

- [ ] **Step 4: Export it and add the DTO fields**

In `shared/src/index.ts`, after `import type { UserPreferences } from './preferences.js';`, add:

```ts
import type { ChatSort } from './chat-list.js';
```

After `export { SEARCH_MIN_CHARS, SEARCH_MAX_CHARS, SEARCH_LIMIT, FOLD_FROM, FOLD_TO, foldText } from './search.js';`, add:

```ts
export { CHAT_SORTS, DEFAULT_CHAT_SORT, BULK_MAX } from './chat-list.js';
export type * from './chat-list.js';
```

Replace

```ts
export interface ChatListFilters { tab: ChatTab; q?: string; sectorId?: string; ownerId?: string; tagId?: string; from?: string; to?: string; cursor?: string; limit?: number }
```

with

```ts
export interface ChatListFilters { tab: ChatTab; q?: string; sectorId?: string; ownerId?: string; tagId?: string; from?: string; to?: string; cursor?: string; limit?: number;
  // spec 2026-10-20: list order (absent = DEFAULT_CHAT_SORT) and the conversation-tag filter
  sort?: ChatSort; chatTagId?: string }
```

and in `ChatListItem` replace

```ts
  // status of the last (non-note) message when the office sent it; null when the contact sent it or there is none
  lastOutStatus?: MessageDto['status'] | null }
```

with

```ts
  // status of the last (non-note) message when the office sent it; null when the contact sent it or there is none
  lastOutStatus?: MessageDto['status'] | null;
  // the conversation's own tags (spec 2026-10-20 §5), apart from tagIds (the contact's); toChatListItem always fills it
  chatTagIds?: string[] }
```

- [ ] **Step 5: Add the column and the table**

In `server/src/db/schema.ts`, in `chats`, after `history: boolean('history').notNull().default(false), // §5.3: imported from the phone; closed, read-only, visible to all`, add:

```ts
    // spec 2026-10-20 §3: the oldest contact message still unanswered; null whenever `waiting` is false
    waitingSince: timestamp('waiting_since', { withTimezone: true }),
```

After the `chatPins` table (before `export const messages = pgTable(`), add:

```ts
/** Spec 2026-10-20 §5: the conversation's own tags, from the same catalog as the contact's. */
export const chatTags = pgTable(
  'chat_tags',
  {
    chatId: uuid('chat_id').notNull().references(() => chats.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id').notNull().references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.chatId, t.tagId] })],
);
```

- [ ] **Step 6: Generate the migration**

Run: `npm run db:generate -w server -- --name lista_dia_a_dia`
Expected: it creates `server/drizzle/0007_lista_dia_a_dia.sql` and `server/drizzle/meta/0007_snapshot.json`, and adds the `0007_lista_dia_a_dia` entry (idx 7) to `_journal.json` after `0006_conversa_dia_a_dia`.

Run: `grep -E '^(CREATE|ALTER|DROP)' server/drizzle/0007_lista_dia_a_dia.sql`
Expected: exactly 4 lines: `CREATE TABLE "chat_tags" (` (its body holds the composite primary key), `ALTER TABLE "chats" ADD COLUMN "waiting_since" timestamp with time zone;…`, and two `ALTER TABLE "chat_tags" ADD CONSTRAINT … FOREIGN KEY … ON DELETE cascade …`. Anything else (for example a `message_favorites` or `preferences` statement) means the schema and the 0006 snapshot disagree. In that case stop: do not edit the SQL or the snapshot, and report it.

- [ ] **Step 7: Run the tests and the type check**

Run: `npm test -w server -- test/db/schema.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: no errors in any workspace.

- [ ] **Step 8: Commit**

```bash
git add shared/src/chat-list.ts shared/src/index.ts server/src/db/schema.ts server/drizzle/0007_lista_dia_a_dia.sql server/drizzle/meta/0007_snapshot.json server/drizzle/meta/_journal.json server/test/db/schema.test.ts
git commit -m "feat(shared,server): chat list order and bulk limit, chat_tags and chats.waiting_since (migration 0007)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `waiting_since` follows the conversation

`waiting` is written in five places. `waiting_since` must change in exactly the same ones, or "Esperando há mais tempo" goes wrong. The ingest uses `least()`, which skips a null in Postgres: the first unanswered message wins, and a late webhook of an older message pulls the time back.

**Files:**
- Modify: `server/src/messages/ingest.ts` (the `tx.update(chats).set({...})` in `ingestMessage`)
- Modify: `server/src/messages/send.ts` (`touchChat`; the dropped-echo restore in `sendSystemMessage`)
- Modify: `server/src/inbox/chats.ts` (`closeChat`, `closeChatAsBot`)
- Modify: `server/test/chats/seed.ts` (`SeedChatOpts`, the `chats` insert)
- Test: `server/test/chats/waiting-since.test.ts` (create)

**Interfaces:**
- Consumes: Task 1 `chats.waitingSince`.
- Produces: `SeedChatOpts.createdAt?: Date`, `SeedChatOpts.waitingSince?: Date | null` (used by Tasks 3 and 5).

- [ ] **Step 1: Let the seed set the new fields**

In `server/test/chats/seed.ts`, add to `SeedChatOpts`, after `at?: Date;`:

```ts
  /** Defaults to `at`. */
  createdAt?: Date;
  waitingSince?: Date | null;
```

and in the `chats` insert replace

```ts
    unread: o.unread ?? 0, lastMessageAt: at, lastMessagePreview: 'oi', createdAt: at,
```

with

```ts
    unread: o.unread ?? 0, lastMessageAt: at, lastMessagePreview: 'oi', createdAt: o.createdAt ?? at,
    waitingSince: o.waitingSince ?? null,
```

- [ ] **Step 2: Write the failing test**

Create `server/test/chats/waiting-since.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chats } from '../../src/db/schema.js';
import { closeChat } from '../../src/inbox/chats.js';
import { handleInbound, type IngestHooks } from '../../src/messages/ingest.js';
import { sendAgentMessage, sendSystemMessage } from '../../src/messages/send.js';
import type { InboundEvent } from '../../src/whatsapp/types.js';
import { enableSeeAll, makeTestCtx, seedBasics } from '../helpers.js';
import { seedChat } from './seed.js';

type MessageEvent = Extract<InboundEvent, { type: 'message' }>;

const PHONE = '5565999999999';
const hooks: IngestHooks = { startTriage: async () => {}, handleTriageReply: async () => false };
const t = (min: number) => new Date(Date.UTC(2026, 9, 20, 12, min));

let ctx: Awaited<ReturnType<typeof makeTestCtx>>;
let s: Awaited<ReturnType<typeof seedBasics>>;

beforeEach(async () => {
  ctx = await makeTestCtx();
  s = await seedBasics(ctx);
  await enableSeeAll(ctx, s.admin); // inbound chats open in the default sector, which no agent belongs to
});

let seq = 0;
function msg(min: number, direction: 'in' | 'out' = 'in'): MessageEvent {
  seq += 1;
  return {
    type: 'message', instance: s.instance, externalId: `WAIT${seq}`, direction, phone: PHONE, lid: null,
    pushName: 'Maria Cliente', kind: 'text', body: `mensagem ${seq}`, hasMedia: false, mediaMime: null, mediaName: null,
    replyToExternalId: null, sentAt: t(min), raw: { key: { id: `WAIT${seq}` } },
  };
}

async function onlyChat() {
  const rows = await ctx.db.select().from(chats);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

describe('chats.waiting_since (spec 2026-10-20 §3)', () => {
  it('the first unanswered contact message sets it, later ones keep it, the agent reply clears it', async () => {
    await handleInbound(ctx, [msg(1)], hooks);
    expect(await onlyChat()).toMatchObject({ waiting: true, waitingSince: t(1) });
    await handleInbound(ctx, [msg(5)], hooks);
    expect((await onlyChat()).waitingSince).toEqual(t(1));

    await sendAgentMessage(ctx, s.admin, (await onlyChat()).id, { text: 'Bom dia', signature: false });
    expect(await onlyChat()).toMatchObject({ waiting: false, waitingSince: null });

    await handleInbound(ctx, [msg(9)], hooks);
    expect((await onlyChat()).waitingSince).toEqual(t(9));
  });

  it('a message from the office phone and closing the chat clear it', async () => {
    await handleInbound(ctx, [msg(1)], hooks);
    await handleInbound(ctx, [msg(2, 'out')], hooks);
    expect(await onlyChat()).toMatchObject({ waiting: false, waitingSince: null });

    await handleInbound(ctx, [msg(3)], hooks);
    expect((await onlyChat()).waitingSince).toEqual(t(3));
    await closeChat(ctx, s.admin, (await onlyChat()).id, { sendClosingMessage: false });
    expect(await onlyChat()).toMatchObject({ state: 'closed', waiting: false, waitingSince: null });
  });

  it('a chatbot or triage message leaves it alone, even when its echo beats the gateway (Review Focus 3)', async () => {
    const { chatId } = await seedChat(ctx, {
      channelId: s.channelId, sectorId: s.sectorA, phone: PHONE, waiting: true, waitingSince: t(1),
    });
    const row = async () => (await ctx.db.select().from(chats).where(eq(chats.id, chatId)))[0]!;
    const realSendText = ctx.wa.sendText.bind(ctx.wa);
    vi.spyOn(ctx.wa, 'sendText').mockImplementation(async (instance, phone, text, quoted) => {
      const res = await realSendText(instance, phone, text, quoted);
      // Evolution's fromMe echo is ingested while our call is still pending: it clears waiting and waiting_since
      await handleInbound(ctx, [{ ...msg(2, 'out'), externalId: res.externalId, phone, body: text }], hooks);
      return res;
    });

    const sent = await sendSystemMessage(ctx, await row(), { text: 'Escolha uma opção' });

    expect(sent).toMatchObject({ ok: true, echoDropped: true });
    expect(await row()).toMatchObject({ waiting: true, waitingSince: t(1) });
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm test -w server -- test/chats/waiting-since.test.ts`
Expected: the first two tests FAIL, because `waitingSince` is `null` where `t(1)` is expected. The third test passes now (nothing writes the column yet). It keeps the next steps honest: after Step 4 alone it FAILS (the echo's ingest clears `waitingSince`), and Step 5's restore makes it pass again.

- [ ] **Step 4: Set and clear it on ingest**

In `server/src/messages/ingest.ts`, inside `ingestMessage`, replace

```ts
          ...(inbound
            ? { unread: sql`${chats.unread} + 1`, waiting: true }
            : { waiting: false, triagePending: false, unread: 0 }), // answering from the phone means it was read
```

with

```ts
          ...(inbound
            ? // spec 2026-10-20 §3: the oldest contact message still unanswered (least() skips a null)
              { unread: sql`${chats.unread} + 1`, waiting: true, waitingSince: sql`least(${chats.waitingSince}, ${sentAt}::timestamptz)` }
            : { waiting: false, waitingSince: null, triagePending: false, unread: 0 }), // answering from the phone means it was read
```

- [ ] **Step 5: Clear it on an agent send, keep it on a system send**

In `server/src/messages/send.ts`, in `touchChat`, replace

```ts
      waiting: false,
      unread: 0,
```

with

```ts
      waiting: false,
      waitingSince: null,
      unread: 0,
```

and in `sendSystemMessage` replace

```ts
      await ctx.db.update(chats).set({ waiting: chat.waiting }).where(and(eq(chats.id, chat.id), eq(chats.state, 'open')));
```

with

```ts
      await ctx.db
        .update(chats)
        .set({ waiting: chat.waiting, waitingSince: chat.waitingSince })
        .where(and(eq(chats.id, chat.id), eq(chats.state, 'open')));
```

- [ ] **Step 6: Clear it on close**

In `server/src/inbox/chats.ts`, replace both occurrences (in `closeChat` and in `closeChatAsBot`) of

```ts
    { state: 'closed', closedAt: new Date(), waiting: false, triagePending: false },
```

with

```ts
    { state: 'closed', closedAt: new Date(), waiting: false, waitingSince: null, triagePending: false },
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test -w server -- test/chats/waiting-since.test.ts test/messages/ingest.test.ts test/messages/send.test.ts test/chats/actions.test.ts test/inbox/chats-actions.test.ts test/triage`
Expected: PASS.

Run: `npm run typecheck -w server`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add server/src/messages/ingest.ts server/src/messages/send.ts server/src/inbox/chats.ts server/test/chats/seed.ts server/test/chats/waiting-since.test.ts
git commit -m "feat(server): chats.waiting_since follows the first unanswered contact message" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: List order, order-aware cursor and the conversation-tag filter (API)

Each order is a list of runs. Each run is one keyset query, `(key, id) < | > cursor`, in one direction. "waiting" has two runs, and a page that empties the first run goes on into the second. Every comparison is a plain row comparison in a single direction, so ties and the boundary between the two runs are exact. The pins keep today's rule: they come only on the first page, and here they follow the same runs.

**Files:**
- Modify: `server/src/inbox/queries.ts` (imports; replace `sortKey` and the cursor helpers; `listChats`)
- Modify: `server/src/chats/routes.ts` (`@talk/shared` import, `listQuery`)
- Test: `server/test/chats/list-order.test.ts` (create)

**Interfaces:**
- Consumes: Task 1 `CHAT_SORTS`, `DEFAULT_CHAT_SORT`, `ChatSort`, `chatTags`, `chats.waitingSince`; Task 2 `SeedChatOpts.createdAt`, `waitingSince`.
- Produces: `GET /api/chats?sort=&chatTagId=`.

- [ ] **Step 1: Write the failing tests**

Create `server/test/chats/list-order.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHAT_SORTS, type ChatListItem } from '@talk/shared';
import { chatPins, chatTags, contactTags, tags } from '../../src/db/schema.js';
import { enableSeeAll, loginAs, makeTestApp, makeTestCtx, seedBasics } from '../helpers.js';
import { seedChat, type SeedChatOpts } from './seed.js';

let app: FastifyInstance;
let ctx: Awaited<ReturnType<typeof makeTestCtx>>;
let s: Awaited<ReturnType<typeof seedBasics>>;
let headers: Record<string, string>;

beforeEach(async () => {
  ctx = await makeTestCtx();
  s = await seedBasics(ctx);
  ({ app } = await makeTestApp(ctx));
  await enableSeeAll(ctx, s.admin);
  ({ headers } = await loginAs(app, s.admin.email));
});
afterEach(async () => {
  await app.close();
});

const t = (min: number) => new Date(Date.UTC(2026, 9, 20, 12, min));
const chat = async (o: Partial<SeedChatOpts> = {}) =>
  (await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, ...o })).chatId;

async function list(query: string) {
  const res = await app.inject({ method: 'GET', url: `/api/chats${query}`, headers });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { items: ChatListItem[]; nextCursor: string | null };
}
const ids = (r: { items: ChatListItem[] }) => r.items.map((i) => i.id);

/** Every page of `query`, `limit` chats at a time. */
async function walk(query: string, limit: number): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await list(`?${query}&limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`);
    seen.push(...ids(page));
    cursor = page.nextCursor;
  } while (cursor);
  return seen;
}

describe('GET /api/chats?sort= (spec 2026-10-20 §3)', () => {
  it('orders by last message or by creation date, both ways; the default is the last message, newest first', async () => {
    const a = await chat({ at: t(10), createdAt: t(1) });
    const b = await chat({ at: t(20), createdAt: t(3) });
    const c = await chat({ at: t(5), createdAt: t(2) });

    expect(ids(await list(''))).toEqual([b, a, c]);
    expect(ids(await list('?sort=last_desc'))).toEqual([b, a, c]);
    expect(ids(await list('?sort=last_asc'))).toEqual([c, a, b]);
    expect(ids(await list('?sort=created_desc'))).toEqual([b, c, a]);
    expect(ids(await list('?sort=created_asc'))).toEqual([a, c, b]);
  });

  it('"Esperando há mais tempo": waiting chats first, the longest wait on top, then the rest by last message', async () => {
    const w1 = await chat({ waiting: true, waitingSince: t(8), at: t(30) });
    const w2 = await chat({ waiting: true, waitingSince: t(2), at: t(40) });
    const legacy = await chat({ waiting: true, waitingSince: null, at: t(5) }); // waiting since before migration 0007
    const n1 = await chat({ at: t(50) });
    const n2 = await chat({ at: t(45) });

    expect(ids(await list('?sort=waiting'))).toEqual([w2, legacy, w1, n1, n2]);
    expect(ids(await list('?sort=waiting&tab=waiting'))).toEqual([w2, legacy, w1]);
  });

  it('every order pages through every chat exactly once, across the waiting/rest boundary and on equal keys (Review Focus 1)', async () => {
    const rows = [[t(3), true], [t(3), true], [t(7), true], [t(9), false], [t(9), false]] as const;
    for (const [at, waiting] of rows) await chat({ at, waiting, waitingSince: waiting ? t(1) : null });

    for (const sort of CHAT_SORTS) {
      const whole = ids(await list(`?sort=${sort}`));
      expect(new Set(whole).size, sort).toBe(5);
      expect(await walk(`sort=${sort}`, 2), sort).toEqual(whole);
      expect(await walk(`sort=${sort}`, 1), sort).toEqual(whole);
    }
  });

  it('a cursor of another order, or of the old format, is 400 (Review Focus 2)', async () => {
    await chat({ at: t(1) });
    await chat({ at: t(2) });
    const get = (q: string) => app.inject({ method: 'GET', url: `/api/chats${q}`, headers });
    const first = await list('?limit=1');
    expect(first.nextCursor).not.toBeNull();
    expect((await list(`?limit=1&cursor=${first.nextCursor}`)).items).toHaveLength(1);

    expect((await get(`?sort=created_desc&limit=1&cursor=${first.nextCursor}`)).statusCode).toBe(400);
    const old = Buffer.from(JSON.stringify(['2026-10-20 12:00:00+00', randomUUID()])).toString('base64url');
    expect((await get(`?cursor=${old}`)).statusCode).toBe(400);
    expect((await get('?sort=alfabetica')).statusCode).toBe(400);
  });

  it('pinned chats stay on top in every order', async () => {
    const old = await chat({ at: t(1) });
    await chat({ at: t(2), waiting: true, waitingSince: t(2) });
    await chat({ at: t(3) });
    await ctx.db.insert(chatPins).values({ userId: s.admin.id, chatId: old, createdAt: new Date() });

    for (const sort of CHAT_SORTS) {
      const page = await list(`?sort=${sort}`);
      expect(ids(page)[0], sort).toBe(old);
      expect(page.items[0]!.pinned, sort).toBe(true);
      expect(page.items).toHaveLength(3);
    }
  });

  it('filters by conversation tag, apart from the contact tag (spec §5)', async () => {
    const tagged = await chat({ at: t(1) });
    const { chatId: other, contactId } = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, at: t(2) });
    const [prazo] = await ctx.db.insert(tags).values({ name: 'Prazo', color: '#ef4444' }).returning({ id: tags.id });
    await ctx.db.insert(chatTags).values({ chatId: tagged, tagId: prazo!.id });
    await ctx.db.insert(contactTags).values({ contactId, tagId: prazo!.id });

    expect(ids(await list(`?chatTagId=${prazo!.id}`))).toEqual([tagged]);
    expect(ids(await list(`?tagId=${prazo!.id}`))).toEqual([other]);
    expect(ids(await list(`?tagId=${prazo!.id}&chatTagId=${prazo!.id}`))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w server -- test/chats/list-order.test.ts`
Expected: FAIL. `listQuery` is a plain `z.object`, so zod strips the unknown `sort` and `chatTagId` keys. The orders come back in the default order, the filter returns both chats, and `?sort=alfabetica` gets 200 instead of 400.

- [ ] **Step 3: Replace the sort key and the cursor helpers**

In `server/src/inbox/queries.ts`, replace

```ts
import { FOLD_FROM, FOLD_TO, SEARCH_LIMIT, foldText } from '@talk/shared';
import type { ChatDetail, ChatListFilters, ChatListItem, MessageSearchHit, TimelineItem } from '@talk/shared';
```

with

```ts
import { CHAT_SORTS, DEFAULT_CHAT_SORT, FOLD_FROM, FOLD_TO, SEARCH_LIMIT, foldText } from '@talk/shared';
import type { ChatDetail, ChatListFilters, ChatListItem, ChatSort, MessageSearchHit, TimelineItem } from '@talk/shared';
```

and

```ts
import { chatEvents, chatPins, chats, contacts, contactTags, messages, tags, users } from '../db/schema.js';
```

with

```ts
import { chatEvents, chatPins, chatTags, chats, contacts, contactTags, messages, tags, users } from '../db/schema.js';
```

The `drizzle-orm` import already has `asc`, `desc`, `notInArray` and `type SQL`. Then replace the block from `// A chat with no message yet (started by an agent) sorts by its creation time.` down to the end of `decodeCursor` with:

```ts
// A chat with no message yet (started by an agent) sorts by its creation time.
const lastKey = sql`coalesce(${chats.lastMessageAt}, ${chats.createdAt})`;
// Chats already waiting before migration 0007 have no waiting_since: their last message is the closest guess.
const waitKey = sql`coalesce(${chats.waitingSince}, ${chats.lastMessageAt}, ${chats.createdAt})`;

/** One keyset run of the list: the chats matching `where`, by (key, id) in `dir` (spec 2026-10-20 §3). */
interface Run { where?: SQL; key: SQL; dir: 'asc' | 'desc' }
const RUNS: Record<ChatSort, Run[]> = {
  last_desc: [{ key: lastKey, dir: 'desc' }],
  last_asc: [{ key: lastKey, dir: 'asc' }],
  created_desc: [{ key: sql`${chats.createdAt}`, dir: 'desc' }],
  created_asc: [{ key: sql`${chats.createdAt}`, dir: 'asc' }],
  // waiting chats first, the longest wait on top; then the others by last message, newest first
  waiting: [
    { where: eq(chats.waiting, true), key: waitKey, dir: 'asc' },
    { where: eq(chats.waiting, false), key: lastKey, dir: 'desc' },
  ],
};
const orderOf = (r: Run) => (r.dir === 'desc' ? [desc(r.key), desc(chats.id)] : [asc(r.key), asc(chats.id)]);

// The cursor is [order, run, key, id]; the key is the timestamptz as Postgres text, so microseconds survive the round trip.
const cursorSchema = z.tuple([
  z.enum(CHAT_SORTS),
  z.number().int().min(0),
  z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}(:\d{2})?$/),
  z.uuid(),
]);
type Cursor = z.infer<typeof cursorSchema>;
const encodeCursor = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString('base64url');
function decodeCursor(cursor: string, sort: ChatSort): Cursor {
  let c: Cursor;
  try {
    c = cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
  } catch {
    throw badRequest('Cursor inválido');
  }
  // a cursor belongs to one order: the web starts the list over when the order changes
  if (c[0] !== sort || c[1] >= RUNS[sort].length) throw badRequest('Cursor inválido');
  return c;
}
```

- [ ] **Step 4: Rewrite `listChats`**

Replace the whole `listChats` function (from `export async function listChats(` to the `return { items, nextCursor };` and its closing brace, just before `export async function getChatDetail`) with:

```ts
export async function listChats(
  ctx: AppCtx,
  user: AuthUser,
  f: ChatListFilters,
): Promise<{ items: ChatListItem[]; nextCursor: string | null }> {
  const db = ctx.db;
  const limit = clampLimit(f.limit);
  const sort = f.sort ?? DEFAULT_CHAT_SORT;
  const runs = RUNS[sort];
  const conds: Array<SQL | undefined> = [visibleChatsWhere(user)];

  conds.push(eq(chats.state, f.tab === 'closed' ? 'closed' : 'open'));
  // History spec §8: history chats stay out of Finalizados; a search still finds them.
  if (f.tab === 'closed' && !f.q?.trim()) conds.push(eq(chats.history, false));
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
  // spec 2026-10-20 §5: the conversation's own tag
  if (f.chatTagId) {
    conds.push(inArray(chats.id, db.select({ id: chatTags.chatId }).from(chatTags).where(eq(chatTags.tagId, f.chatTagId))));
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
  const base = (r: Run) =>
    db
      .select({ chat: chats, key: sql<string>`${r.key}::text` })
      .from(chats)
      .innerJoin(contacts, eq(contacts.id, chats.contactId));

  // Pins (max 3 per user) are prepended to the first page only, in the same order, so the cursor covers unpinned chats alone.
  const pinned: Array<{ chat: ChatRow }> = [];
  if (!f.cursor) {
    for (const r of runs) {
      pinned.push(...(await base(r).where(and(...conds, r.where, inArray(chats.id, myPins()))).orderBy(...orderOf(r))));
    }
  }

  // Each run is a plain keyset query; a page that empties one run goes on into the next.
  const after = f.cursor ? decodeCursor(f.cursor, sort) : null;
  const rows: Array<{ chat: ChatRow; key: string; run: number }> = [];
  for (let i = after ? after[1] : 0; i < runs.length && rows.length <= limit; i++) {
    const r = runs[i]!;
    const from =
      after && after[1] === i
        ? sql`(${r.key}, ${chats.id}) ${sql.raw(r.dir === 'desc' ? '<' : '>')} (${after[2]}::timestamptz, ${after[3]}::uuid)`
        : undefined;
    const got = await base(r)
      .where(and(...conds, r.where, notInArray(chats.id, myPins()), from))
      .orderBy(...orderOf(r))
      .limit(limit + 1 - rows.length);
    rows.push(...got.map((g) => ({ ...g, run: i })));
  }

  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const nextCursor = rows.length > limit && last ? encodeCursor([sort, last.run, last.key, last.chat.id]) : null;

  // ponytail: toChatListItem runs a few small queries per chat; batch them if listing 100 chats gets slow.
  const items: ChatListItem[] = [];
  for (const r of [...pinned, ...page]) items.push(await toChatListItem(db, r.chat, user.id));
  return { items, nextCursor };
}
```

- [ ] **Step 5: Accept the query fields**

In `server/src/chats/routes.ts`, replace

```ts
import { SEARCH_MAX_CHARS, SEARCH_MIN_CHARS } from '@talk/shared';
```

with

```ts
import { CHAT_SORTS, SEARCH_MAX_CHARS, SEARCH_MIN_CHARS } from '@talk/shared';
```

In `listQuery`, after `tagId: z.uuid().optional(),`, add:

```ts
  chatTagId: z.uuid().optional(),
  sort: z.enum(CHAT_SORTS).optional(),
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -w server -- test/chats/list-order.test.ts test/chats/list-and-timeline.test.ts test/contacts`
Expected: PASS. The old `cursor pagination walks every chat once, newest first` and `?cursor=xyz` 400 tests still pass unchanged.

Run: `npm run typecheck -w server`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add server/src/inbox/queries.ts server/src/chats/routes.ts server/test/chats/list-order.test.ts
git commit -m "feat(server): chat list orders with an order-aware cursor, and the conversation-tag filter" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Conversation tags (API, DTO, LID merge)

The service mirrors `setContactTags`: a set replace in one transaction, then a publish after commit. The DTO reads the tags fresh, so the `ChatDetail` built from the pre-change row still carries the new set. `absorb` moves the tags before it deletes the absorbed chat, because the cascade would drop them otherwise.

**Files:**
- Modify: `server/src/inbox/chats.ts` (schema import; new `setChatTags`)
- Modify: `server/src/inbox/queries.ts` (`toChatListItem`)
- Modify: `server/src/chats/routes.ts` (chats import, `tagsBody`, the route)
- Modify: `server/src/history/merge.ts` (schema import, `absorb`)
- Test: `server/test/chats/chat-tags.test.ts` (create), `server/test/realtime/hub.test.ts` (the full `ChatListItem` test), `server/test/history/merge.test.ts` (import line, new `it`)

**Interfaces:**
- Consumes: Task 1 `chatTags`, `ChatListItem.chatTagIds`.
- Produces: `setChatTags`; `PUT /api/chats/:id/tags`; `ChatListItem.chatTagIds` filled on REST and WebSocket.

- [ ] **Step 1: Write the failing tests**

Create `server/test/chats/chat-tags.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatDetail } from '@talk/shared';
import { contactTags, tags } from '../../src/db/schema.js';
import { loginAs, makeTestApp, makeTestCtx, seedBasics } from '../helpers.js';
import { seedChat, type SeedChatOpts } from './seed.js';

let app: FastifyInstance;
let ctx: Awaited<ReturnType<typeof makeTestCtx>>;
let s: Awaited<ReturnType<typeof seedBasics>>;
let headers: Record<string, string>;
let prazo: string; // catalog position 1
let audiencia: string; // catalog position 0

beforeEach(async () => {
  ctx = await makeTestCtx();
  s = await seedBasics(ctx);
  ({ app } = await makeTestApp(ctx));
  ({ headers } = await loginAs(app, s.agentA.email));
  const rows = await ctx.db
    .insert(tags)
    .values([{ name: 'Prazo', color: '#ef4444', position: 1 }, { name: 'Audiência', color: '#2563eb', position: 0 }])
    .returning({ id: tags.id });
  [prazo, audiencia] = rows.map((r) => r.id) as [string, string];
});
afterEach(async () => {
  await app.close();
});

/** agentA's chat in sector A. */
const mine = (o: Partial<SeedChatOpts> = {}) =>
  seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, ownerId: s.agentA.id, ...o });
const put = (chatId: string, tagIds: string[], h: Record<string, string> = headers) =>
  app.inject({ method: 'PUT', url: `/api/chats/${chatId}/tags`, headers: h, payload: { tagIds } });
const detail = async (chatId: string) =>
  (await app.inject({ method: 'GET', url: `/api/chats/${chatId}`, headers })).json() as ChatDetail;

describe('PUT /api/chats/:id/tags (spec 2026-10-20 §5)', () => {
  it('replaces the conversation tags, apart from the contact tags, and answers the ChatDetail', async () => {
    const { chatId, contactId } = await mine();
    await ctx.db.insert(contactTags).values({ contactId, tagId: prazo });

    const res = await put(chatId, [prazo, prazo]);

    expect(res.statusCode).toBe(200);
    expect(res.json() as ChatDetail).toMatchObject({ id: chatId, chatTagIds: [prazo], tagIds: [prazo] });
    expect(ctx.hub.events).toContainEqual({ type: 'chat', chatId });
    expect(((await put(chatId, [])).json() as ChatDetail).chatTagIds).toEqual([]);
    expect((await detail(chatId)).tagIds).toEqual([prazo]); // the contact's tag never moved
    expect(ctx.wa.sent).toEqual([]);
  });

  it('lists them in catalog order, on a closed chat too, and they survive reopening', async () => {
    const { chatId } = await mine({ state: 'closed' });
    expect(((await put(chatId, [prazo, audiencia])).json() as ChatDetail).chatTagIds).toEqual([audiencia, prazo]);

    const reopened = await app.inject({ method: 'POST', url: `/api/chats/${chatId}/reopen`, headers });

    expect(reopened.statusCode).toBe(200);
    expect(reopened.json() as ChatDetail).toMatchObject({ state: 'open', chatTagIds: [audiencia, prazo] });
  });

  it('400 for an unknown tag or more than 50, 404 for a chat the user cannot see, 403 without Origin', async () => {
    const { chatId } = await mine();
    await put(chatId, [prazo]);

    expect((await put(chatId, [audiencia, randomUUID()])).statusCode).toBe(400);
    expect((await put(chatId, Array.from({ length: 51 }, () => randomUUID()))).statusCode).toBe(400);
    expect((await detail(chatId)).chatTagIds).toEqual([prazo]); // the refused requests changed nothing
    const hidden = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorB });
    expect((await put(hidden.chatId, [prazo])).statusCode).toBe(404);
    expect((await put(chatId, [audiencia], { cookie: headers.cookie! })).statusCode).toBe(403);
  });

  it('a tag deleted from the catalog leaves every conversation (Review Focus 6)', async () => {
    const { chatId } = await mine();
    await put(chatId, [prazo, audiencia]);
    const admin = await loginAs(app, s.admin.email);

    expect((await app.inject({ method: 'DELETE', url: `/api/tags/${audiencia}`, headers: admin.headers })).statusCode).toBe(204);

    expect((await detail(chatId)).chatTagIds).toEqual([prazo]);
  });
});
```

In `server/test/history/merge.test.ts`, replace

```ts
import {
  chats, contactFieldValues, contactNotes, contactTags, contacts, customFields, deletedChats, messages, tags,
} from '../../src/db/schema.js';
```

with

```ts
import {
  chatTags, chats, contactFieldValues, contactNotes, contactTags, contacts, customFields, deletedChats, messages, tags,
} from '../../src/db/schema.js';
```

and add inside `describe('mergeLidPairs (§5.4)', …)`, after the test `with an open chat on both sides, the LID chat's messages go into the phone contact's open chat`:

```ts
  it("an absorbed chat's conversation tags move to the twin (Review Focus 6)", async () => {
    const lidId = await lidOnly();
    const phoneId = await newContact(ctx, { phone: PHONE });
    const lidChat = await insertChat(ctx, { channelId: s.channelId, sectorId: s.defaultSector, contactId: lidId });
    const phoneChat = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, contactId: phoneId });
    const [t1, t2] = await ctx.db
      .insert(tags)
      .values([{ name: 'Prazo', color: '#ef4444' }, { name: 'Audiência', color: '#2563eb' }])
      .returning({ id: tags.id });
    await ctx.db.insert(chatTags).values([
      { chatId: lidChat, tagId: t1!.id },
      { chatId: lidChat, tagId: t2!.id },
      { chatId: phoneChat, tagId: t1!.id },
    ]);

    await mergeLidPairs(ctx, pair);

    const rows = await ctx.db.select().from(chatTags).where(eq(chatTags.chatId, phoneChat));
    expect(rows.map((r) => r.tagId).sort()).toEqual([t1!.id, t2!.id].sort());
  });
```

In `server/test/realtime/hub.test.ts`, replace

```ts
import { channels, chatPins, chats, contactTags, contacts, messages, tags, userSectors, users } from '../../src/db/schema.js';
```

with

```ts
import { channels, chatPins, chatTags, chats, contactTags, contacts, messages, tags, userSectors, users } from '../../src/db/schema.js';
```

In `it('sends the full ChatListItem with per-user pinned flag and contact tags', …)`, rename it to `sends the full ChatListItem with per-user pinned flag, contact tags and conversation tags`. After `await ctx.db.insert(contactTags).values({ contactId, tagId });`, add:

```ts
    await ctx.db.insert(chatTags).values({ chatId: chat.id, tagId });
```

and in `expected` replace

```ts
      history: false,
      lastOutStatus: null,
    };
```

with

```ts
      history: false,
      lastOutStatus: null,
      chatTagIds: [tagId],
    };
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w server -- test/chats/chat-tags.test.ts test/history/merge.test.ts test/realtime/hub.test.ts`
Expected: FAIL. The PUT route is 404 (no route), `chatTagIds` is missing from the DTO, and the merged chat holds only `t1`.

- [ ] **Step 3: Fill `chatTagIds` in the DTO**

In `server/src/inbox/queries.ts`, in `toChatListItem`, after the `tagRows` query (it ends with `.orderBy(asc(tags.position));`, just before the comment `// the message the preview shows (notes never set it): who sent it and, if the office did, its ticks`) add:

```ts
  const chatTagRows = await db
    .select({ id: chatTags.tagId })
    .from(chatTags)
    .innerJoin(tags, eq(tags.id, chatTags.tagId))
    .where(eq(chatTags.chatId, chat.id))
    .orderBy(asc(tags.position), asc(tags.name));
```

and in the returned object replace

```ts
    tagIds: tagRows.map((r) => r.id),
    history: chat.history,
    lastOutStatus: last?.direction === 'out' ? last.status : null,
  };
```

with

```ts
    tagIds: tagRows.map((r) => r.id),
    history: chat.history,
    lastOutStatus: last?.direction === 'out' ? last.status : null,
    chatTagIds: chatTagRows.map((r) => r.id),
  };
```

- [ ] **Step 4: Add the service**

In `server/src/inbox/chats.ts`, replace

```ts
import {
  channels, chatPins, chats, contacts, deletedChats, messages, quickAnswers, sectors, settings, users,
} from '../db/schema.js';
```

with

```ts
import {
  channels, chatPins, chatTags, chats, contacts, deletedChats, messages, quickAnswers, sectors, settings, tags, users,
} from '../db/schema.js';
```

(`inArray` and `badRequest` are already imported.) Add after `pinChat` (before `async function resolveContactId`):

```ts
/** Spec 2026-10-20 §5: replaces the conversation's tags (same catalog as the contact's). Anyone who sees the chat, open or not. */
export async function setChatTags(ctx: AppCtx, user: AuthUser, chatId: string, tagIds: string[]): Promise<ChatRow> {
  const chat = await getChatForUser(ctx, user, chatId);
  const unique = [...new Set(tagIds)];
  // Only `tx` inside (PGlite serializes transactions; ctx.db here would deadlock).
  await ctx.db.transaction(async (tx) => {
    if (unique.length && (await tx.$count(tags, inArray(tags.id, unique))) !== unique.length) {
      throw badRequest('Etiqueta inexistente');
    }
    await tx.delete(chatTags).where(eq(chatTags.chatId, chatId));
    if (unique.length) await tx.insert(chatTags).values(unique.map((tagId) => ({ chatId, tagId }))).onConflictDoNothing();
  });
  await ctx.hub.publishChat(chatId);
  return chat;
}
```

- [ ] **Step 5: Add the route**

In `server/src/chats/routes.ts`, replace

```ts
import {
  assumeChat, closeChat, deleteChat, getChatForUser, markChatRead, markChatUnread, pinChat, reopenChat, setChatPrivacy,
  startChat, transferChat, type ChatRow,
} from '../inbox/chats.js';
```

with

```ts
import {
  assumeChat, closeChat, deleteChat, getChatForUser, markChatRead, markChatUnread, pinChat, reopenChat, setChatPrivacy,
  setChatTags, startChat, transferChat, type ChatRow,
} from '../inbox/chats.js';
```

After the `forwardBody` union (it ends with `]);`, before `async function readMultipart`), add:

```ts
/** Spec 2026-10-20 §5: same limit as the contact's tags. */
const tagsBody = z.object({ tagIds: z.array(z.uuid()).max(50) });
```

and after the two `/api/chats/:id/pin` routes (before `r.post('/api/chats/:id/messages', …)`):

```ts
    // The detail is read after the change, so it carries the new chatTagIds.
    r.put('/api/chats/:id/tags', async (req) => {
      const { id } = idParams.parse(req.params);
      return toChatDetail(ctx.db, await setChatTags(ctx, req.user, id, tagsBody.parse(req.body).tagIds), req.user.id);
    });
```

- [ ] **Step 6: Carry the tags through a merge**

In `server/src/history/merge.ts`, replace

```ts
import {
  botRuns, chatEvents, chats, contactFieldValues, contactNotes, contactTags, contacts, deletedChats, messages,
} from '../db/schema.js';
```

with

```ts
import {
  botRuns, chatEvents, chatTags, chats, contactFieldValues, contactNotes, contactTags, contacts, deletedChats, messages,
} from '../db/schema.js';
```

In `absorb`, before `await tx.delete(chats).where(eq(chats.id, from.id));`, add:

```ts
  // spec 2026-10-20 §5: the conversation's tags follow its messages (the delete below would cascade them away)
  const tagRows = await tx.select({ tagId: chatTags.tagId }).from(chatTags).where(eq(chatTags.chatId, from.id));
  if (tagRows.length) {
    await tx.insert(chatTags).values(tagRows.map((t) => ({ chatId: twin.id, tagId: t.tagId }))).onConflictDoNothing();
  }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test -w server -- test/chats/chat-tags.test.ts test/history/merge.test.ts test/realtime/hub.test.ts test/chats/list-order.test.ts test/catalog`
Expected: PASS.

Run: `npm run typecheck -w server`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add server/src/inbox/chats.ts server/src/inbox/queries.ts server/src/chats/routes.ts server/src/history/merge.ts server/test/chats/chat-tags.test.ts server/test/history/merge.test.ts server/test/realtime/hub.test.ts
git commit -m "feat(server): conversation tags (PUT /api/chats/:id/tags, chatTagIds in the list DTO, kept on a LID merge)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Bulk transfer, close and read (API)

Each bulk step is the single action's own service call, so canSee, open/closed, the stale check, the closing-message rule and the bot stop are the same rules, not copies. The destination is validated once, up front. Without that, an invalid sector would first stop every chat's bot and only then fail 50 times. The single "Finalizar" route and the bulk close now share `closeChatAndStopBots`.

**Files:**
- Create: `server/src/inbox/bulk.ts`
- Modify: `server/src/inbox/chats.ts` (new `validateTransferTarget`; `transferChat` uses it)
- Modify: `server/src/chats/routes.ts` (imports, bulk bodies, three routes, the `close` action)
- Test: `server/test/chats/bulk.test.ts` (create)

**Interfaces:**
- Consumes: Task 1 `BULK_MAX`, `BulkResultDto`; existing `closeChat`, `transferChat`, `markChatRead`, `getChatForUser`, `applyBotRunningBehavior`, `getBotRunningBehavior`, `stopRunsForChat`, `sendAgentMessage`; test seeds `setupActions`, `seedWaitingRun`, `seedChat`.
- Produces: everything under `server/src/inbox/bulk.ts` and `validateTransferTarget` in the Shared contract; the three bulk routes.

- [ ] **Step 1: Write the failing tests**

Create `server/test/chats/bulk.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BulkResultDto } from '@talk/shared';
import { botRuns, chats, messages, settings } from '../../src/db/schema.js';
import { seedWaitingRun, setupActions, type ActionsWorld } from '../messages/actions-seed.js';
import { seedChat, type SeedChatOpts } from './seed.js';

let w: ActionsWorld;
beforeEach(async () => {
  w = await setupActions(); // agentA's open chat w.chatId (sector A, owner agentA)
});
afterEach(async () => {
  await w.app.close();
});

let n = 0;
/** Another chat of agentA in sector A, with its own phone contact. */
const another = (o: Partial<SeedChatOpts> = {}) =>
  seedChat(w.ctx, {
    channelId: w.s.channelId, sectorId: w.s.sectorA, ownerId: w.s.agentA.id, phone: `5565988880${String(++n).padStart(3, '0')}`, ...o,
  });
/** A chat agentA cannot see (sector B, nobody's). */
const hiddenChat = (o: Partial<SeedChatOpts> = {}) =>
  seedChat(w.ctx, { channelId: w.s.channelId, sectorId: w.s.sectorB, phone: '5511988887777', ...o });
const bulk = (action: 'transfer' | 'close' | 'read', payload: object, headers: Record<string, string> = w.headers) =>
  w.app.inject({ method: 'POST', url: `/api/chats/bulk/${action}`, headers, payload });
const chatRow = async (id: string) => (await w.ctx.db.select().from(chats).where(eq(chats.id, id)))[0]!;
const runStates = async (chatId: string) =>
  (await w.ctx.db.select().from(botRuns).where(eq(botRuns.chatId, chatId))).map((r) => r.state);
async function setSetting(key: string, value: string) {
  await w.ctx.db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
}

describe('POST /api/chats/bulk/* (spec 2026-10-20 §4)', () => {
  it('transfers each chat it can and tells why the others could not (Review Focus 4)', async () => {
    const open2 = (await another()).chatId;
    const closed = (await another({ state: 'closed' })).chatId;
    const hidden = (await hiddenChat()).chatId;

    const res = await bulk('transfer', { chatIds: [w.chatId, open2, closed, hidden, w.chatId], sectorId: w.s.defaultSector });

    expect(res.statusCode).toBe(200);
    expect(res.json() as BulkResultDto).toEqual({
      done: [w.chatId, open2],
      failed: [
        { chatId: closed, error: 'Conversa finalizada' },
        { chatId: hidden, error: 'Conversa não encontrada' },
      ],
    });
    expect((await chatRow(w.chatId)).sectorId).toBe(w.s.defaultSector);
    expect((await chatRow(open2)).sectorId).toBe(w.s.defaultSector);
    expect((await chatRow(hidden)).sectorId).toBe(w.s.sectorB);
    expect(w.ctx.hub.events).not.toContainEqual({ type: 'chat', chatId: hidden });
  });

  it('stops a running chatbot under "Perguntar" instead of asking, and keeps it under "Manter" (Review Focus 4)', async () => {
    await seedWaitingRun(w); // default behavior: ask
    expect((await bulk('transfer', { chatIds: [w.chatId], sectorId: w.s.sectorB })).json()).toEqual({ done: [w.chatId], failed: [] });
    expect(await runStates(w.chatId)).toEqual(['stopped']);

    await setSetting('bot_running_behavior', 'keep');
    const other = await another();
    await seedWaitingRun(w, other.chatId, other.contactId);
    expect((await bulk('transfer', { chatIds: [other.chatId], sectorId: w.s.sectorB })).json()).toEqual({
      done: [other.chatId], failed: [],
    });
    expect(await runStates(other.chatId)).toEqual(['waiting_reply']);
  });

  it('a destination that does not exist is one 400, and nothing changes, not even a chatbot', async () => {
    await seedWaitingRun(w);

    expect((await bulk('transfer', { chatIds: [w.chatId], sectorId: randomUUID() })).statusCode).toBe(400);
    expect((await bulk('transfer', { chatIds: [w.chatId], ownerId: randomUUID() })).statusCode).toBe(400);
    expect((await bulk('transfer', { chatIds: [w.chatId] })).statusCode).toBe(400);

    expect((await chatRow(w.chatId)).sectorId).toBe(w.s.sectorA);
    expect(await runStates(w.chatId)).toEqual(['waiting_reply']);
  });

  it('closes in bulk with one closing-message choice; a failed send keeps that chat open (Review Focus 5)', async () => {
    await setSetting('closing_message', 'Obrigado pelo contato!');
    const other = await another();
    await seedWaitingRun(w, other.chatId, other.contactId);
    w.ctx.wa.failNext(new Error('Evolution fora do ar')); // the first chat's closing message

    const res = await bulk('close', { chatIds: [w.chatId, other.chatId], sendClosingMessage: true });

    expect(res.json()).toEqual({
      done: [other.chatId],
      failed: [{ chatId: w.chatId, error: 'Mensagem de encerramento não enviada; a conversa continua aberta' }],
    });
    expect((await chatRow(w.chatId)).state).toBe('open');
    expect(await chatRow(other.chatId)).toMatchObject({ state: 'closed', waitingSince: null });
    const closing = await w.ctx.db.select().from(messages).where(eq(messages.body, 'Obrigado pelo contato!'));
    const statusOf = new Map(closing.map((m) => [m.chatId, m.status]));
    expect(statusOf.get(w.chatId)).toBe('failed'); // the bubble stays, to be resent
    expect(statusOf.get(other.chatId)).not.toBe('failed');
    expect(await runStates(other.chatId)).toEqual(['stopped']);
  });

  it('marks read in bulk only the chats the user sees', async () => {
    await w.ctx.db.update(chats).set({ unread: 3 }).where(eq(chats.id, w.chatId));
    const hidden = (await hiddenChat({ unread: 2 })).chatId;

    expect((await bulk('read', { chatIds: [w.chatId, hidden] })).json()).toEqual({
      done: [w.chatId],
      failed: [{ chatId: hidden, error: 'Conversa não encontrada' }],
    });
    expect((await chatRow(w.chatId)).unread).toBe(0);
    expect((await chatRow(hidden)).unread).toBe(2);
  });

  it('refuses more than 50 chats, an empty list and a request without Origin', async () => {
    expect((await bulk('read', { chatIds: Array.from({ length: 51 }, () => randomUUID()) })).statusCode).toBe(400);
    expect((await bulk('close', { chatIds: [] })).statusCode).toBe(400);
    expect((await bulk('read', { chatIds: [w.chatId] }, { cookie: w.headers.cookie! })).statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w server -- test/chats/bulk.test.ts`
Expected: FAIL. `/api/chats/bulk/transfer` falls into `/api/chats/:id/transfer`, where `id = 'bulk'` fails `z.uuid()`, so the answer is 400 and not 200. `/api/chats/bulk/read` gets 400 the same way.

- [ ] **Step 3: Validate the destination once**

In `server/src/inbox/chats.ts`, after `activeUserExists` (before `export async function getClosingMessage`), add:

```ts
/** 400 for a missing or nonexistent destination. The bulk transfer checks it once, before any chatbot is stopped. */
export async function validateTransferTarget(db: Db | Tx, to: { sectorId?: string; ownerId?: string | null }): Promise<void> {
  if (to.sectorId === undefined && to.ownerId === undefined) throw badRequest('Informe o setor ou o atendente.');
  if (to.sectorId !== undefined && !(await sectorExists(db, to.sectorId))) throw badRequest('Setor inválido.');
  if (to.ownerId && !(await activeUserExists(db, to.ownerId))) throw badRequest('Atendente inválido.');
}
```

and in `transferChat` replace

```ts
  if (to.sectorId === undefined && to.ownerId === undefined) throw badRequest('Informe o setor ou o atendente.');
  const chat = await getChatForUser(ctx, user, chatId);
  if (chat.state !== 'open') throw conflict('Conversa finalizada.');
  if (to.sectorId !== undefined && !(await sectorExists(ctx.db, to.sectorId))) throw badRequest('Setor inválido.');
  if (to.ownerId && !(await activeUserExists(ctx.db, to.ownerId))) throw badRequest('Atendente inválido.');
```

with

```ts
  const chat = await getChatForUser(ctx, user, chatId);
  if (chat.state !== 'open') throw conflict('Conversa finalizada.');
  await validateTransferTarget(ctx.db, to);
```

The three checks now live in one place. The only order change: an empty destination on a chat the user cannot see is 404 instead of 400 (the route's `transferBody` refuses an empty destination before that anyway). `test/inbox/chats-actions.test.ts` `400 for empty target, unknown sector or unknown agent; 409 for a closed chat` still passes.

- [ ] **Step 4: Create the bulk module**

Create `server/src/inbox/bulk.ts`:

```ts
// Spec 2026-10-20 §4: bulk transfer, close and mark-read. Each chat goes through the very service the single action
// uses (canSee, open/closed, stale check, closing message, chatbots), one chat at a time, and gets its own result.
import type { BulkResultDto } from '@talk/shared';
import { stopRunsForChat } from '../bots/engine.js';
import { applyBotRunningBehavior } from '../bots/hooks.js';
import { getBotRunningBehavior } from '../catalog/settings.js';
import type { AppCtx } from '../ctx.js';
import { HttpError } from '../lib/http-error.js';
import { sendAgentMessage } from '../messages/send.js';
import { closeChat, getChatForUser, markChatRead, transferChat, validateTransferTarget, type ChatRow } from './chats.js';
import type { AuthUser } from './visibility.js';

/** "Finalizar", single or bulk: the closing message goes out first, then every chatbot run in the chat stops. */
export async function closeChatAndStopBots(ctx: AppCtx, user: AuthUser, chatId: string, sendClosingMessage: boolean): Promise<ChatRow> {
  const closed = await closeChat(ctx, user, chatId, {
    sendClosingMessage,
    // Closing text is the office's canned message, so it goes without the agent signature.
    // botAction 'keep': closing never asks, the runs are stopped right below.
    sendClosing: async (text: string) =>
      (await sendAgentMessage(ctx, user, chatId, { text, signature: false, botAction: 'keep' })).status !== 'failed',
  });
  // Spec §5.5: closing the chat stops every bot run in it.
  await stopRunsForChat(ctx, chatId, { userId: user.id, reason: 'chat_closed' });
  return closed;
}

/** The single action's pt-BR message, short: no final period; a 404 says which thing was not found. */
function reasonOf(err: unknown): string {
  if (!(err instanceof HttpError)) return 'Erro inesperado';
  return err.status === 404 ? 'Conversa não encontrada' : err.message.replace(/\.$/, '');
}

/** Runs `one` for each distinct chat, in order, one at a time. A refusal is that chat's result; the rest go on. */
async function eachChat(chatIds: string[], one: (chatId: string) => Promise<unknown>): Promise<BulkResultDto> {
  const result: BulkResultDto = { done: [], failed: [] };
  for (const chatId of new Set(chatIds)) {
    try {
      await one(chatId);
      result.done.push(chatId);
    } catch (err) {
      if (!(err instanceof HttpError)) {
        console.error('bulk chat action failed', { chatId, err: err instanceof Error ? err.name : 'unknown' });
      }
      result.failed.push({ chatId, error: reasonOf(err) });
    }
  }
  return result;
}

export async function bulkTransfer(
  ctx: AppCtx,
  user: AuthUser,
  chatIds: string[],
  to: { sectorId?: string; ownerId?: string | null },
): Promise<BulkResultDto> {
  await validateTransferTarget(ctx.db, to); // one 400 for the request, before any chatbot stops
  // There is no one to ask chat by chat: "keep" is honored, "ask" becomes "stop" (like closing does).
  const botAction = (await getBotRunningBehavior(ctx.db)) === 'keep' ? 'keep' : 'stop';
  return eachChat(chatIds, async (chatId) => {
    await getChatForUser(ctx, user, chatId); // 404 first, as in the single route
    await applyBotRunningBehavior(ctx, user, chatId, botAction, 'transfer');
    await transferChat(ctx, user, chatId, to);
  });
}

export async function bulkClose(ctx: AppCtx, user: AuthUser, chatIds: string[], sendClosingMessage: boolean): Promise<BulkResultDto> {
  return eachChat(chatIds, (chatId) => closeChatAndStopBots(ctx, user, chatId, sendClosingMessage));
}

export async function bulkRead(ctx: AppCtx, user: AuthUser, chatIds: string[]): Promise<BulkResultDto> {
  return eachChat(chatIds, (chatId) => markChatRead(ctx, user, chatId));
}
```

- [ ] **Step 5: Add the routes and share the close**

In `server/src/chats/routes.ts`, replace

```ts
import { CHAT_SORTS, SEARCH_MAX_CHARS, SEARCH_MIN_CHARS } from '@talk/shared';
import { stopRunsForChat } from '../bots/engine.js';
import { applyBotRunningBehavior } from '../bots/hooks.js';
```

with

```ts
import { BULK_MAX, CHAT_SORTS, SEARCH_MAX_CHARS, SEARCH_MIN_CHARS } from '@talk/shared';
import { applyBotRunningBehavior } from '../bots/hooks.js';
```

(`stopRunsForChat` becomes unused; `applyBotRunningBehavior` stays for the single transfer), replace

```ts
import {
  assumeChat, closeChat, deleteChat, getChatForUser, markChatRead, markChatUnread, pinChat, reopenChat, setChatPrivacy,
  setChatTags, startChat, transferChat, type ChatRow,
} from '../inbox/chats.js';
```

with

```ts
import { bulkClose, bulkRead, bulkTransfer, closeChatAndStopBots } from '../inbox/bulk.js';
import {
  assumeChat, deleteChat, getChatForUser, markChatRead, markChatUnread, pinChat, reopenChat, setChatPrivacy, setChatTags,
  startChat, transferChat, type ChatRow,
} from '../inbox/chats.js';
```

and keep the `sendAgentMessage` import, which the messages route still uses.

After `const closeBody = z.object({ sendClosingMessage: z.boolean().default(false) });`, add:

```ts
/** Spec 2026-10-20 §4: 1 to BULK_MAX chats per request; the same destination and choice for all of them. */
const bulkIds = z.array(z.uuid()).min(1).max(BULK_MAX);
const bulkTransferBody = z
  .object({ chatIds: bulkIds, sectorId: z.uuid().optional(), ownerId: z.uuid().nullable().optional() })
  .refine((b) => b.sectorId !== undefined || b.ownerId !== undefined, 'Informe o setor ou o atendente');
const bulkCloseBody = z.object({ chatIds: bulkIds, sendClosingMessage: z.boolean().default(false) });
const bulkReadBody = z.object({ chatIds: bulkIds });
```

Replace

```ts
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
```

with

```ts
    action('close', (user, id, body) =>
      closeChatAndStopBots(ctx, user, id, closeBody.parse(body ?? {}).sendClosingMessage),
    );
```

and add after the `r.post('/api/chats', …)` route (before `r.get('/api/chats/:id', …)`):

```ts
    // Static paths: find-my-way matches them before /api/chats/:id/…; the answer is 200 with one result per chat.
    r.post('/api/chats/bulk/transfer', async (req) => {
      const { chatIds, ...to } = bulkTransferBody.parse(req.body);
      return bulkTransfer(ctx, req.user, chatIds, to);
    });
    r.post('/api/chats/bulk/close', async (req) => {
      const { chatIds, sendClosingMessage } = bulkCloseBody.parse(req.body);
      return bulkClose(ctx, req.user, chatIds, sendClosingMessage);
    });
    r.post('/api/chats/bulk/read', async (req) => bulkRead(ctx, req.user, bulkReadBody.parse(req.body).chatIds));
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -w server -- test/chats/bulk.test.ts test/chats/actions.test.ts test/inbox test/bots/integration.test.ts`
Expected: PASS. The single-close tests (`close with sendClosingMessage …`, 409 on a gateway failure) are unchanged and still pass through `closeChatAndStopBots`.

Run: `npm test -w server` and `npm run typecheck -w server`
Expected: PASS, no errors.

- [ ] **Step 7: Commit**

```bash
git add server/src/inbox/bulk.ts server/src/inbox/chats.ts server/src/chats/routes.ts server/test/chats/bulk.test.ts
git commit -m "feat(server): bulk transfer, close and mark-read with one result per chat" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Web client, list query helpers and the bulk summary

These are pure modules and the API client, so the components in Tasks 7 and 8 only wire them. The order stays out of the query key when it is the default, so the main list keeps sharing its cache with the unread badges, as it does today.

**Files:**
- Modify: `web/src/lib/api.ts` (`@talk/shared` type import; `BulkTransferInput`; four calls in `api.chats`)
- Modify: `web/src/components/inbox/chat-query.ts` (whole file below)
- Create: `web/src/components/inbox/bulk.ts`
- Test: `web/src/lib/api.test.ts` (new `describe` at the end), `web/src/components/inbox/chat-query.test.ts` (imports, new `it`, new `describe`), `web/src/components/inbox/bulk.test.ts` (create)

**Interfaces:**
- Consumes: Task 1 `CHAT_SORTS`, `DEFAULT_CHAT_SORT`, `ChatSort`, `BulkResultDto`, `ChatListFilters.sort/chatTagId`; Tasks 4–5 routes.
- Produces: everything under `web/src/lib/api.ts`, `chat-query.ts` and `bulk.ts` in the Shared contract.

- [ ] **Step 1: Write the failing tests**

In `web/src/lib/api.test.ts`, add at the end of the file, after `describe('api routes of the 2026-10-19 delivery', …)`:

```ts
describe('api routes of the 2026-10-20 delivery', () => {
  it('calls the conversation-tag and bulk routes, and sends sort and chatTagId', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json(200, { done: [], failed: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await api.chats.setTags('c1', ['t1']);
    await api.chats.bulkTransfer({ chatIds: ['c1', 'c2'], sectorId: 's1', ownerId: null });
    await api.chats.bulkClose({ chatIds: ['c1'], sendClosingMessage: true });
    await api.chats.bulkRead(['c1']);
    await api.chats.list({ tab: 'inbox', sort: 'waiting', chatTagId: 't1' });
    expect(fetchMock.mock.calls.map(([u, i]) => `${i?.method} ${String(u)} ${String(i?.body ?? '')}`)).toEqual([
      'PUT /api/chats/c1/tags {"tagIds":["t1"]}',
      'POST /api/chats/bulk/transfer {"chatIds":["c1","c2"],"sectorId":"s1","ownerId":null}',
      'POST /api/chats/bulk/close {"chatIds":["c1"],"sendClosingMessage":true}',
      'POST /api/chats/bulk/read {"chatIds":["c1"]}',
      'GET /api/chats?tab=inbox&sort=waiting&chatTagId=t1 ',
    ]);
  });
});
```

In `web/src/components/inbox/chat-query.test.ts`, replace

```ts
import { describe, expect, it } from 'vitest';
import { buildChatQuery, EMPTY_FILTERS, NO_OWNER, type InboxFilters } from './chat-query';
```

with

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildChatQuery, EMPTY_FILTERS, NO_OWNER, readChatSort, saveChatSort, withSort, type InboxFilters,
} from './chat-query';
```

add at the end of `describe('buildChatQuery', …)`:

```ts
  it('maps the conversation tag (spec 2026-10-20 §5)', () => {
    expect(buildChatQuery('inbox', '', { ...EMPTY_FILTERS, chatTagId: 't9' }, now)).toEqual({ tab: 'inbox', limit: 50, chatTagId: 't9' });
  });
```

and at the end of the file:

```ts
describe('chat order (spec 2026-10-20 §3)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('remembers the order per user; the default is not stored', () => {
    expect(readChatSort('u1')).toBe('last_desc');
    saveChatSort('u1', 'waiting');
    expect(readChatSort('u1')).toBe('waiting');
    expect(readChatSort('u2')).toBe('last_desc');
    saveChatSort('u1', 'last_desc');
    expect(localStorage.getItem('talk.chatSort.u1')).toBeNull();
  });

  it('falls back to the default on a stale value or blocked storage', () => {
    localStorage.setItem('talk.chatSort.u1', 'alfabetica');
    expect(readChatSort('u1')).toBe('last_desc');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readChatSort('u1')).toBe('last_desc');
    expect(() => saveChatSort('u1', 'waiting')).not.toThrow();
  });

  it('adds sort to the query only when it is not the default', () => {
    const base = buildChatQuery('inbox', '', EMPTY_FILTERS, now);
    expect(withSort(base, 'last_desc')).toBe(base);
    expect(withSort(base, 'created_asc')).toEqual({ tab: 'inbox', limit: 50, sort: 'created_asc' });
  });
});
```

Create `web/src/components/inbox/bulk.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { bulkSummary } from './bulk';

describe('bulkSummary (spec 2026-10-20 §4)', () => {
  it('says how many were done out of how many', () => {
    expect(bulkSummary({ done: ['a', 'b'], failed: [] })).toBe('2 de 2 concluídas.');
    expect(bulkSummary({ done: ['a'], failed: [] })).toBe('1 de 1 concluída.');
  });

  it('adds how many could not, with each distinct reason once', () => {
    expect(bulkSummary({ done: ['a'], failed: [{ chatId: 'b', error: 'Conversa finalizada' }] })).toBe(
      '1 de 2 concluídas; 1 não pôde: Conversa finalizada',
    );
    expect(
      bulkSummary({
        done: [],
        failed: [
          { chatId: 'a', error: 'Conversa finalizada' },
          { chatId: 'b', error: 'Conversa finalizada' },
          { chatId: 'c', error: 'Conversa não encontrada' },
        ],
      }),
    ).toBe('0 de 3 concluídas; 3 não puderam: Conversa finalizada / Conversa não encontrada');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w web -- src/lib/api.test.ts src/components/inbox/chat-query.test.ts src/components/inbox/bulk.test.ts`
Expected: FAIL. `api.chats.setTags is not a function`, `readChatSort` and `withSort` are not exported, and `./bulk` does not exist.

- [ ] **Step 3: Add the API calls**

In `web/src/lib/api.ts`, in the `import type { … } from '@talk/shared';` list, add `BulkResultDto,` between `BotVersionSummaryDto,` and `ChannelDto,`. After `export interface StartChatInput { contactId?: string; phone?: string; name?: string; sectorId?: string }`, add:

```ts
/** Spec 2026-10-20 §4: the same destination for every chat (one of the two). */
export interface BulkTransferInput { chatIds: string[]; sectorId?: string; ownerId?: string | null }
```

and inside `api.chats`, after the `sendSticker: (id: string, input: SendStickerInput) => …` line (the last entry, just before the `},` that closes `chats` and the `messages: {` block):

```ts
    /** Spec 2026-10-20 §5: the conversation's own tags (the contact's go through api.contacts.setTags). */
    setTags: (id: string, tagIds: string[]) => request<ChatDetail>('PUT', `/api/chats/${enc(id)}/tags`, { tagIds }),
    bulkTransfer: (input: BulkTransferInput) => request<BulkResultDto>('POST', '/api/chats/bulk/transfer', input),
    bulkClose: (input: { chatIds: string[]; sendClosingMessage: boolean }) =>
      request<BulkResultDto>('POST', '/api/chats/bulk/close', input),
    bulkRead: (chatIds: string[]) => request<BulkResultDto>('POST', '/api/chats/bulk/read', { chatIds }),
```

- [ ] **Step 4: Rewrite `chat-query.ts`**

Replace `web/src/components/inbox/chat-query.ts` with:

```ts
import { CHAT_SORTS, DEFAULT_CHAT_SORT, type ChatListFilters, type ChatSort, type ChatTab } from '@talk/shared';

export type Period = 'any' | 'today' | '7d' | '30d' | 'range';

/** UI filter state; '' means "todos". rangeFrom/rangeTo are <input type="date"> values (YYYY-MM-DD). */
export interface InboxFilters {
  sectorId: string;
  ownerId: string;
  /** The contact's tag. */
  tagId: string;
  /** The conversation's own tag (spec 2026-10-20 §5). */
  chatTagId: string;
  period: Period;
  rangeFrom: string;
  rangeTo: string;
}

export const EMPTY_FILTERS: InboxFilters = {
  sectorId: '', ownerId: '', tagId: '', chatTagId: '', period: 'any', rangeFrom: '', rangeTo: '',
};
/** ownerId sentinel for "Sem atendente" (server: owner_id IS NULL). */
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
  if (f.chatTagId) out.chatTagId = f.chatTagId;
  if (f.period === 'today') out.from = startOfDaysAgo(now, 0).toISOString();
  if (f.period === '7d') out.from = startOfDaysAgo(now, 6).toISOString();
  if (f.period === '30d') out.from = startOfDaysAgo(now, 29).toISOString();
  if (f.period === 'range') {
    if (f.rangeFrom) out.from = parseDay(f.rangeFrom, false).toISOString();
    if (f.rangeTo) out.to = parseDay(f.rangeTo, true).toISOString();
  }
  return out;
}

/** Spec 2026-10-20 §3, exact copy. */
export const CHAT_SORT_LABELS: Record<ChatSort, string> = {
  last_desc: 'Última mensagem: mais recentes',
  last_asc: 'Última mensagem: mais antigas',
  created_desc: 'Data de criação: mais recentes',
  created_asc: 'Data de criação: mais antigas',
  waiting: 'Esperando há mais tempo',
};

const sortKey = (userId: string | undefined) => `talk.chatSort.${userId ?? 'anon'}`;

/** The order is per user and per browser. A stale value or blocked storage (private window) gives the default. */
export function readChatSort(userId: string | undefined): ChatSort {
  try {
    const v = localStorage.getItem(sortKey(userId));
    return (CHAT_SORTS as readonly string[]).includes(v ?? '') ? (v as ChatSort) : DEFAULT_CHAT_SORT;
  } catch {
    return DEFAULT_CHAT_SORT;
  }
}

export function saveChatSort(userId: string | undefined, sort: ChatSort): void {
  try {
    if (sort === DEFAULT_CHAT_SORT) localStorage.removeItem(sortKey(userId));
    else localStorage.setItem(sortKey(userId), sort);
  } catch {
    // storage blocked: the order lasts until the page reloads
  }
}

/** The default order stays out of the query, so the list keeps sharing its cache with the unread badges. */
export const withSort = (f: ChatListFilters, sort: ChatSort): ChatListFilters =>
  sort === DEFAULT_CHAT_SORT ? f : { ...f, sort };
```

- [ ] **Step 5: Create the summary**

Create `web/src/components/inbox/bulk.ts`:

```ts
import type { BulkResultDto } from '@talk/shared';

/** Spec 2026-10-20 §4: "X de N concluídas; Y não puderam: <motivo>", each distinct reason once. */
export function bulkSummary(r: BulkResultDto): string {
  const total = r.done.length + r.failed.length;
  const head = `${r.done.length} de ${total} ${total === 1 ? 'concluída' : 'concluídas'}`;
  if (r.failed.length === 0) return `${head}.`;
  const reasons = [...new Set(r.failed.map((f) => f.error))].join(' / ');
  return `${head}; ${r.failed.length} não ${r.failed.length === 1 ? 'pôde' : 'puderam'}: ${reasons}`;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -w web -- src/lib/api.test.ts src/components/inbox/chat-query.test.ts src/components/inbox/bulk.test.ts`
Expected: PASS.

Run: `npm run typecheck -w web`
Expected: no errors. `Inbox.tsx` still compiles: `EMPTY_FILTERS` gained a field, and nothing reads it yet.

- [ ] **Step 7: Commit**

```bash
git add web/src/lib/api.ts web/src/lib/api.test.ts web/src/components/inbox/chat-query.ts web/src/components/inbox/chat-query.test.ts web/src/components/inbox/bulk.ts web/src/components/inbox/bulk.test.ts
git commit -m "feat(web): client for conversation tags and bulk actions, list order helpers and the bulk summary" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Tag chips, selection on the card, the tag filter and the panel editor

The card gets two optional props, so the existing `ChatListItem` tests and the Inbox keep working unchanged until Task 8 passes them. The contact editor and the new conversation editor share one `TagToggles`.

**Files:**
- Modify: `web/src/components/inbox/ChatListItem.tsx` (whole file below)
- Modify: `web/src/components/inbox/FilterPanel.tsx` (ids, the tag select's label, a new select)
- Modify: `web/src/components/contacts/TagsEditor.tsx` (whole file below)
- Modify: `web/src/components/contacts/ContactPanel.tsx` (import, `ChatDetailsTab`)
- Test: `web/src/components/inbox/ChatListItem.test.tsx` (imports, new `describe`), `web/src/components/contacts/TagsEditor.test.tsx` (mock, imports, new `describe`)

**Interfaces:**
- Consumes: Task 1 `BULK_MAX`, `ChatListItem.chatTagIds`; Task 6 `InboxFilters.chatTagId`, `api.chats.setTags`.
- Produces: `ChatListItem` props `tagById?` and `selection?`, and `ChatTagsEditor`.

- [ ] **Step 1: Write the failing tests**

In `web/src/components/inbox/ChatListItem.test.tsx`, change the shared import to `import type { ChatListItem as ChatItem, TagDto } from '@talk/shared';`. Then add at the end:

```tsx
const TAGS = new Map<string, TagDto>(
  ['Cliente', 'Prazo', 'E3', 'E4', 'E5', 'E6'].map((name, i): [string, TagDto] => [
    `t${i + 1}`,
    { id: `t${i + 1}`, name, emoji: null, color: '#2563eb', position: i },
  ]),
);

function renderWith(chat: Partial<ChatItem>, selection?: { selected: boolean; disabled: boolean; onToggle: () => void }) {
  const onOpen = vi.fn();
  render(
    <ul>
      <ChatListItem
        chat={{ ...CHAT, ...chat }}
        sectorName={null}
        owner={null}
        active={false}
        onOpen={onOpen}
        onTogglePin={() => {}}
        onMarkUnread={() => {}}
        onOpenWith={() => {}}
        tagById={TAGS}
        selection={selection}
      />
    </ul>,
  );
  return onOpen;
}
const chipTitles = () => [...document.querySelectorAll('[title^="Etiqueta"]')].map((e) => e.getAttribute('title'));

describe('ChatListItem tags and selection (spec 2026-10-20 §4, §5)', () => {
  it('shows conversation tags first and filled, contact tags outlined, and skips unknown ids', () => {
    renderWith({ tagIds: ['t1', 'gone'], chatTagIds: ['t2'] });
    expect(chipTitles()).toEqual(['Etiqueta da conversa: Prazo', 'Etiqueta do contato: Cliente']);
    expect(screen.getByTitle('Etiqueta da conversa: Prazo').className).toContain('text-white');
    expect(screen.getByTitle('Etiqueta do contato: Cliente').className).not.toContain('text-white');
  });

  it('shows at most 4 chips and +N for the rest', () => {
    renderWith({ tagIds: ['t1', 't3', 't4'], chatTagIds: ['t2', 't5', 't6'] });
    expect(chipTitles()).toHaveLength(4);
    expect(screen.getByText('+2')).toBeTruthy();
  });

  it('in selection mode the row toggles the checkbox instead of opening, and the menu is gone', () => {
    const onToggle = vi.fn();
    const onOpen = renderWith({}, { selected: false, disabled: false, onToggle });
    expect(document.querySelector('details')).toBeNull();
    fireEvent.click(screen.getByText('Maria'));
    fireEvent.click(screen.getByLabelText('Selecionar Maria'));
    expect(onToggle).toHaveBeenCalledTimes(2);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('a disabled checkbox (50 already selected) does nothing and says why', () => {
    const onToggle = vi.fn();
    renderWith({}, { selected: false, disabled: true, onToggle });
    const box = screen.getByLabelText('Selecionar Maria') as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(box.closest('label')?.getAttribute('title')).toBe('Até 50 conversas por vez');
    fireEvent.click(screen.getByText('Maria'));
    expect(onToggle).not.toHaveBeenCalled();
  });
});
```

In `web/src/components/contacts/TagsEditor.test.tsx`:
- add `chats: { setTags: vi.fn() },` to the hoisted `m`;
- change the shared import to `import type { ChatDetail, ContactDto, TagDto } from '@talk/shared';`;
- change the component import to `import { ChatTagsEditor, TagsEditor } from './TagsEditor';`;
- add at the end:

```tsx
describe('ChatTagsEditor (spec 2026-10-20 §5)', () => {
  const chat: ChatDetail = {
    id: 'ch1', contact: { id: 'c1', name: 'Maria', phone: null, avatarUrl: null }, channelId: 'w1', sectorId: 's1',
    ownerId: null, state: 'closed', waiting: false, private: false, unread: 0, lastMessageAt: null,
    lastMessagePreview: null, pinned: false, tagIds: ['t1'], chatTagIds: [], triagePending: false,
    createdAt: '2026-10-20T12:00:00.000Z', closedAt: '2026-10-20T13:00:00.000Z',
  };

  it('toggles the conversation tags (not the contact ones) and caches the returned detail', async () => {
    m.chats.setTags.mockImplementation(async (_id: string, chatTagIds: string[]) => ({ ...chat, chatTagIds }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ChatTagsEditor chat={chat} />
      </QueryClientProvider>,
    );
    // t1 is the contact's tag: not pressed here
    expect((await screen.findByRole('button', { name: /Cliente/ })).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: /Urgente/ }));
    await waitFor(() => expect(m.chats.setTags).toHaveBeenCalledWith('ch1', ['t2']));
    await waitFor(() => expect(qc.getQueryData<ChatDetail>(qk.chat('ch1'))?.chatTagIds).toEqual(['t2']));
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w web -- src/components/inbox/ChatListItem.test.tsx src/components/contacts/TagsEditor.test.tsx`
Expected: FAIL. There are no chips (`chipTitles()` is `[]`), no "Selecionar Maria" checkbox, and `ChatTagsEditor` is not exported.

- [ ] **Step 3: Rewrite the card**

Replace `web/src/components/inbox/ChatListItem.tsx` with:

```tsx
import { ChatCircleText, Check, Checks, Clock, DotsThreeVertical, LockSimple, PushPin, WarningCircle } from '@phosphor-icons/react';
import { BULK_MAX, tagColorHex, type ChatListItem as ChatItem, type TagDto } from '@talk/shared';
import { contactLabel, listTime } from '../../lib/format';
import { Avatar } from '../Avatar';

interface Props {
  chat: ChatItem;
  sectorName: string | null;
  /** History spec §7: set only when there is more than one channel. */
  channelName?: string | null;
  owner: { name: string; avatarUrl: string | null } | null;
  active: boolean;
  onOpen(): void;
  onTogglePin(): void;
  onMarkUnread(): void;
  /** Opens the chat with ConversationHeader's own dialog (?acao=…), so its rules apply. */
  onOpenWith(acao: 'transferir' | 'finalizar'): void;
  /** Admins only; undefined hides the item. */
  onDelete?: () => void;
  /** The tag catalog by id, for the chips. An unknown id (a tag just deleted) is skipped. */
  tagById?: ReadonlyMap<string, TagDto>;
  /** Spec 2026-10-20 §4 "Selecionar": a checkbox; the row toggles it instead of opening the chat; no menu. */
  selection?: { selected: boolean; disabled: boolean; onToggle(): void };
}

/** Like WhatsApp: the last message was the office's, with its ticks. */
function OutTick({ status }: { status: NonNullable<ChatItem['lastOutStatus']> }) {
  const cls = 'shrink-0';
  switch (status) {
    case 'pending':
      return <Clock size={14} aria-label="Você · enviando" className={cls} />;
    case 'sent':
      return <Check size={14} aria-label="Você · enviada" className={cls} />;
    case 'delivered':
      return <Checks size={14} aria-label="Você · entregue" className={cls} />;
    case 'read':
      return <Checks size={14} weight="bold" aria-label="Você · lida" className={`${cls} text-read`} />;
    case 'failed':
      return <WarningCircle size={14} weight="fill" aria-label="Você · falhou" className={`${cls} text-danger`} />;
  }
}

const NO_TAGS: ReadonlyMap<string, TagDto> = new Map();
const MAX_CHIPS = 4;
type Chip = { tag: TagDto; kind: 'chat' | 'contact' };

/** Spec 2026-10-20 §5: a conversation tag is filled and carries a speech bubble; a contact tag is only outlined. */
function TagChip({ tag, kind }: Chip) {
  const color = tagColorHex(tag.color);
  const what = kind === 'chat' ? 'Etiqueta da conversa' : 'Etiqueta do contato';
  return (
    <span
      title={`${what}: ${tag.name}`}
      className={`flex max-w-28 items-center gap-0.5 rounded-full border px-1.5 py-px ${kind === 'chat' ? 'text-white' : ''}`}
      style={kind === 'chat' ? { backgroundColor: color, borderColor: color } : { borderColor: color, color }}
    >
      {kind === 'chat' && <ChatCircleText size={10} weight="fill" aria-hidden className="shrink-0" />}
      <span className="sr-only">{what}: </span>
      <span className="truncate">
        {tag.emoji ? `${tag.emoji} ` : ''}
        {tag.name}
      </span>
    </span>
  );
}

export function ChatListItem({
  chat, sectorName, channelName = null, owner, active, onOpen, onTogglePin, onMarkUnread, onOpenWith, onDelete,
  tagById = NO_TAGS, selection,
}: Props) {
  const title = contactLabel(chat.contact);
  const unread = chat.unread > 0;
  const workable = chat.state === 'open' && !chat.history;
  const menu: Array<{ label: string; run: () => void; danger?: boolean } | false> = [
    { label: chat.pinned ? 'Desafixar' : 'Fixar', run: onTogglePin },
    !unread && { label: 'Marcar como não lida', run: onMarkUnread },
    workable && { label: 'Transferir', run: () => onOpenWith('transferir') },
    workable && { label: 'Finalizar', run: () => onOpenWith('finalizar') },
    !!onDelete && { label: 'Excluir conversa', run: onDelete, danger: true },
  ];
  const chipsOf = (ids: string[], kind: Chip['kind']): Chip[] =>
    ids.flatMap((id) => {
      const tag = tagById.get(id);
      return tag ? [{ tag, kind }] : [];
    });
  const chips = [...chipsOf(chat.chatTagIds ?? [], 'chat'), ...chipsOf(chat.tagIds, 'contact')];
  const highlighted = active || !!selection?.selected;
  return (
    <li className={`flex items-stretch rounded-xl ${highlighted ? 'bg-sidebar-active' : 'hover:bg-sidebar-hover'}`}>
      {selection && (
        <label
          title={selection.disabled ? `Até ${BULK_MAX} conversas por vez` : undefined}
          className="flex shrink-0 cursor-pointer items-center pl-3"
        >
          <input
            type="checkbox"
            aria-label={`Selecionar ${title}`}
            checked={selection.selected}
            disabled={selection.disabled}
            onChange={selection.onToggle}
            className="size-4 accent-primary"
          />
        </label>
      )}
      <button
        type="button"
        onClick={
          selection
            ? () => {
                if (!selection.disabled) selection.onToggle();
              }
            : onOpen
        }
        aria-current={active ? 'true' : undefined}
        className="flex min-w-0 flex-1 gap-3 rounded-xl py-3 pl-3 text-left"
      >
        <Avatar name={chat.contact.name} src={chat.contact.avatarUrl} className="size-10 shrink-0 text-sm bg-panel" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1">
            <span className={`truncate ${unread || active ? 'font-semibold' : 'font-medium'}`}>{title}</span>
            {chat.private && <LockSimple aria-label="Conversa privada" className="shrink-0 text-private" />}
            {chat.pinned && <PushPin aria-label="Fixada" weight="fill" className="shrink-0 text-muted" />}
            <span className={`ml-auto shrink-0 font-mono text-[11px] ${unread ? 'font-semibold text-link' : 'text-muted'}`}>
              {chat.lastMessageAt ? listTime(chat.lastMessageAt) : ''}
            </span>
          </span>
          <span className="flex items-center gap-2">
            <span className={`flex min-w-0 items-center gap-1 text-sm ${unread ? 'text-fg' : 'text-muted'}`}>
              {chat.lastOutStatus && <OutTick status={chat.lastOutStatus} />}
              <span className="truncate">{chat.lastMessagePreview ?? ''}</span>
            </span>
            {unread && (
              <span
                aria-label={`Não lidas: ${chat.unread}`}
                className="ml-auto min-w-5 shrink-0 rounded-full bg-primary px-1.5 text-center text-[11px] font-bold text-white"
              >
                {chat.unread}
              </span>
            )}
          </span>
          <span className="mt-1.5 flex min-w-0 items-center gap-1.5 text-[11px]">
            {channelName && <span className="rounded-md bg-panel px-2 py-0.5 font-medium text-muted">{channelName}</span>}
            {sectorName && <span className="rounded-md bg-panel px-2 py-0.5 font-medium text-muted">{sectorName}</span>}
            {owner ? (
              <span
                title={owner.name}
                role="img"
                aria-label={`Responsável: ${owner.name}`}
                className="flex min-w-0 items-center gap-1 rounded-full border border-border py-px pr-2 pl-px text-muted"
              >
                <Avatar name={owner.name} src={owner.avatarUrl} className="size-4 shrink-0 text-[8px] bg-primary text-white" />
                <span aria-hidden className="truncate">{owner.name.split(' ')[0]}</span>
              </span>
            ) : (
              chat.state === 'open' && <span className="rounded-full bg-brass-soft px-2 py-0.5 font-semibold text-brass">Sem atendente</span>
            )}
          </span>
          {chips.length > 0 && (
            <span className="mt-1 flex min-w-0 flex-wrap items-center gap-1 text-[10px] font-medium">
              {chips.slice(0, MAX_CHIPS).map((c) => (
                <TagChip key={`${c.kind}:${c.tag.id}`} {...c} />
              ))}
              {chips.length > MAX_CHIPS && <span className="text-muted">+{chips.length - MAX_CHIPS}</span>}
            </span>
          )}
        </span>
      </button>
      {!selection && (
        <details className="relative">
          <summary aria-label="Opções da conversa" className="cursor-pointer list-none rounded-lg px-1.5 py-3 text-muted hover:text-fg">
            <DotsThreeVertical size={18} />
          </summary>
          <div className="absolute right-1 z-10 mt-1 rounded-lg border border-border bg-surface py-1 shadow-lg">
            {menu.map(
              (item) =>
                item && (
                  <button
                    key={item.label}
                    type="button"
                    onClick={(e) => {
                      e.currentTarget.closest('details')?.removeAttribute('open');
                      item.run();
                    }}
                    className={`block w-full whitespace-nowrap px-3 py-1.5 text-left text-sm hover:bg-sidebar-hover ${item.danger ? 'text-danger' : ''}`}
                  >
                    {item.label}
                  </button>
                ),
            )}
          </div>
        </details>
      )}
    </li>
  );
}
```

- [ ] **Step 4: Share the tag toggles and add the conversation editor**

Replace `web/src/components/contacts/TagsEditor.tsx` with:

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { tagColorHex, type ChatDetail, type ContactDto } from '@talk/shared';
import { api, qk } from '../../lib/api';

// ponytail: every tag is a toggle chip; add a search popover if the office passes ~40 tags.
/** The catalog as toggle chips; `tagIds` are the pressed ones. Used for the contact and for the conversation. */
function TagToggles(props: { tagIds: string[]; pending: boolean; error: Error | null; onChange: (tagIds: string[]) => void }) {
  const tags = useQuery({ queryKey: qk.tags, queryFn: () => api.tags.list() });
  const selected = new Set(props.tagIds);

  if (!tags.data?.length) return <p className="text-sm text-muted">Nenhuma etiqueta cadastrada.</p>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {tags.data.map((t) => {
        const on = selected.has(t.id);
        const color = tagColorHex(t.color); // the shared palette (Task 15), same as Task 19's form
        return (
          <button
            key={t.id}
            type="button"
            aria-pressed={on}
            disabled={props.pending}
            onClick={() => props.onChange(on ? props.tagIds.filter((id) => id !== t.id) : [...props.tagIds, t.id])}
            className="rounded-full border border-border px-2.5 py-0.5 text-xs font-medium disabled:opacity-60"
            style={on ? { backgroundColor: color, borderColor: color, color: '#fff' } : { borderColor: color, color }}
          >
            {t.emoji ? `${t.emoji} ` : ''}
            {t.name}
          </button>
        );
      })}
      {props.error && <p role="alert" className="w-full text-xs text-danger">{props.error.message}</p>}
    </div>
  );
}

export function TagsEditor({ contact }: { contact: ContactDto }) {
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (tagIds: string[]) => api.contacts.setTags(contact.id, tagIds),
    onSuccess: (dto) => {
      qc.setQueryData(qk.contact(dto.id), dto);
      void qc.invalidateQueries({ queryKey: qk.contactList({}) }); // {} partially matches every list filter
      void qc.invalidateQueries({ queryKey: qk.chats }); // ChatListItem.tagIds come from the contact
    },
  });
  return <TagToggles tagIds={contact.tagIds} pending={save.isPending} error={save.error} onChange={(ids) => save.mutate(ids)} />;
}

/** Spec 2026-10-20 §5: the conversation's own tags, same catalog; anyone who sees the chat, open or closed. */
export function ChatTagsEditor({ chat }: { chat: ChatDetail }) {
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (tagIds: string[]) => api.chats.setTags(chat.id, tagIds),
    onSuccess: (dto) => {
      qc.setQueryData(qk.chat(dto.id), dto);
      void qc.invalidateQueries({ queryKey: qk.chatLists }); // the chips and the "Etiqueta da conversa" filter
    },
  });
  return (
    <TagToggles tagIds={chat.chatTagIds ?? []} pending={save.isPending} error={save.error} onChange={(ids) => save.mutate(ids)} />
  );
}
```

- [ ] **Step 5: Add the section in "Detalhes da conversa"**

In `web/src/components/contacts/ContactPanel.tsx`, replace `import { TagsEditor } from './TagsEditor';` with `import { ChatTagsEditor, TagsEditor } from './TagsEditor';`. In `ChatDetailsTab`, replace

```tsx
    <div className="space-y-6">
      <Rows rows={rows} />
      <Section title="Favoritas">
```

with

```tsx
    <div className="space-y-6">
      <Rows rows={rows} />
      <Section title="Etiquetas da conversa">
        <ChatTagsEditor chat={c} />
      </Section>
      <Section title="Favoritas">
```

The "Favoritas" section (`<FavoritesList chatId={chatId} onJump={onJump} />`) and the `onJump` prop stay as they are.

- [ ] **Step 6: Add the conversation-tag filter**

In `web/src/components/inbox/FilterPanel.tsx`, change

```tsx
  const ids = { sector: useId(), owner: useId(), tag: useId(), from: useId(), to: useId() };
```

to

```tsx
  const ids = { sector: useId(), owner: useId(), tag: useId(), chatTag: useId(), from: useId(), to: useId() };
```

and replace the whole tag `<div>` (the one with `htmlFor={ids.tag}`) with:

```tsx
      <div>
        <label htmlFor={ids.tag} className="text-muted">Etiqueta do contato</label>
        <select id={ids.tag} value={value.tagId} onChange={(e) => set({ tagId: e.target.value })} className={field}>
          <option value="">Todas</option>
          {tags.map((t) => (
            <option key={t.id} value={t.id}>{`${t.emoji ? `${t.emoji} ` : ''}${t.name}`}</option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor={ids.chatTag} className="text-muted">Etiqueta da conversa</label>
        <select id={ids.chatTag} value={value.chatTagId} onChange={(e) => set({ chatTagId: e.target.value })} className={field}>
          <option value="">Todas</option>
          {tags.map((t) => (
            <option key={t.id} value={t.id}>{`${t.emoji ? `${t.emoji} ` : ''}${t.name}`}</option>
          ))}
        </select>
      </div>
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test -w web -- src/components/inbox/ChatListItem.test.tsx src/components/contacts/TagsEditor.test.tsx src/pages/Inbox.test.tsx`
Expected: PASS. The old menu tests still find their items, because they pass no `selection`.

Run: `npm run typecheck -w web`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add web/src/components/inbox/ChatListItem.tsx web/src/components/inbox/ChatListItem.test.tsx web/src/components/inbox/FilterPanel.tsx web/src/components/contacts/TagsEditor.tsx web/src/components/contacts/TagsEditor.test.tsx web/src/components/contacts/ContactPanel.tsx
git commit -m "feat(web): conversation tag chips, selection mode on the card, tag filter and the editor in Detalhes da conversa" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Order control, selection mode and the bulk bar in the Inbox

The last task wires everything. The order lives in `Inbox` state, starts from `localStorage`, and is part of the query key (Task 6 `withSort`), so changing it refetches from page one. The selection is a `Set` of ids. The count and the request use only the ids still in the loaded list (Review Focus 7). `BulkBar` reuses the transfer and close dialogs, which only gain a `title`.

**Files:**
- Modify: `web/src/components/conversation/ChatDialogs.tsx` (`TransferDialog` and `CloseDialog` props, the `Modal` titles)
- Create: `web/src/components/inbox/BulkBar.tsx`
- Modify: `web/src/pages/Inbox.tsx` (whole file below)
- Test: `web/src/pages/Inbox.test.tsx` (imports, the `showModal` stub, `calls` with bodies, bulk routes in the stub, four new tests)

**Interfaces:**
- Consumes: Task 1 `BULK_MAX`, `CHAT_SORTS`, `DEFAULT_CHAT_SORT`, `ChatSort`, `BulkResultDto`; Task 6 `api.chats.bulk*`, `CHAT_SORT_LABELS`, `readChatSort`, `saveChatSort`, `withSort`, `bulkSummary`; Task 7 `ChatListItem` `tagById`/`selection`.
- Produces: `TransferDialog`/`CloseDialog` `title?`, `BulkBar`.

- [ ] **Step 1: Write the failing tests**

In `web/src/pages/Inbox.test.tsx`:

- change the testing-library import to `import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';` and the shared import to `import type { BulkResultDto, ChannelDto, ChatListItem, Me } from '@talk/shared';`;
- after the `vi.mock(...)` line add:

```tsx
// jsdom has no modal <dialog> API; the browser opens ChatDialogs' Modal with showModal()
HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
  this.setAttribute('open', '');
};
```

- change `const calls: Array<{ method: string; url: URL }> = [];` to `const calls: Array<{ method: string; url: URL; body?: string }> = [];`, and the push to `calls.push({ method, url, body: typeof init?.body === 'string' ? init.body : undefined });`;
- next to `let channelsReply`, add `let bulkReply: BulkResultDto = { done: [], failed: [] };`. In `beforeEach`, add `bulkReply = { done: ['a', 'b'], failed: [] };` and `localStorage.clear();`;
- in the fetch stub, before `if (url.pathname === '/api/chats') {`, add:

```tsx
    if (url.pathname.startsWith('/api/chats/bulk/') && method === 'POST') return json(bulkReply);
```

- add at the end of the file:

```tsx
it('sends the chosen order as sort and remembers it for this user (spec 2026-10-20 §3)', async () => {
  renderInbox(adminMe);
  await screen.findByText('Ana Souza');
  const listCalls = () => calls.filter((c) => c.url.pathname === '/api/chats');
  expect(listCalls().every((c) => !c.url.searchParams.has('sort'))).toBe(true); // the default stays out of the query

  fireEvent.change(screen.getByLabelText('Ordenar conversas'), { target: { value: 'waiting' } });

  await waitFor(() => expect(listCalls().some((c) => c.url.searchParams.get('sort') === 'waiting')).toBe(true));
  expect(localStorage.getItem('talk.chatSort.adm')).toBe('waiting');
  cleanup();
  renderInbox(adminMe);
  expect((screen.getByLabelText('Ordenar conversas') as HTMLSelectElement).value).toBe('waiting');
});

it('selects chats and marks them read in bulk; the summary stays after the bar closes (spec 2026-10-20 §4)', async () => {
  renderInbox(adminMe);
  await screen.findByText('Ana Souza');
  fireEvent.click(screen.getByRole('button', { name: 'Selecionar' }));
  expect(screen.queryAllByLabelText('Opções da conversa')).toHaveLength(0);

  fireEvent.click(screen.getByLabelText('Selecionar Ana Souza'));
  fireEvent.click(screen.getByText('+55 65 99999-0000')); // the row toggles too
  expect(screen.getByText('2 selecionadas')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Marcar como lida' }));

  expect((await screen.findByRole('status')).textContent).toBe('2 de 2 concluídas.');
  const post = calls.find((c) => c.url.pathname === '/api/chats/bulk/read');
  expect(JSON.parse(post!.body!)).toEqual({ chatIds: ['a', 'b'] });
  expect(screen.queryByText('2 selecionadas')).toBeNull(); // all done: the selection mode ends
  expect(where()).toBe('/chats'); // nothing was opened
});

it('keeps the chats that failed selected and says why (spec §4)', async () => {
  bulkReply = { done: ['b'], failed: [{ chatId: 'a', error: 'Conversa finalizada' }] };
  renderInbox(adminMe);
  await screen.findByText('Ana Souza');
  fireEvent.click(screen.getByRole('button', { name: 'Selecionar' }));
  fireEvent.click(screen.getByLabelText('Selecionar Ana Souza'));
  fireEvent.click(screen.getByLabelText('Selecionar +55 65 99999-0000'));
  fireEvent.click(screen.getByRole('button', { name: 'Marcar como lida' }));

  expect((await screen.findByRole('status')).textContent).toBe('1 de 2 concluídas; 1 não pôde: Conversa finalizada');
  expect(screen.getByText('1 selecionada')).toBeTruthy();
  expect((screen.getByLabelText('Selecionar Ana Souza') as HTMLInputElement).checked).toBe(true);
});

it('transfers the selection in one request to the chosen sector (spec §4)', async () => {
  renderInbox(adminMe);
  await screen.findByText('Ana Souza');
  fireEvent.click(screen.getByRole('button', { name: 'Selecionar' }));
  fireEvent.click(screen.getByLabelText('Selecionar Ana Souza'));
  fireEvent.click(screen.getByLabelText('Selecionar +55 65 99999-0000'));
  fireEvent.click(screen.getByRole('button', { name: 'Transferir' }));

  const dialog = await screen.findByLabelText('Transferir 2 conversas');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Transferir' }));

  expect((await screen.findByRole('status')).textContent).toBe('2 de 2 concluídas.');
  const post = calls.find((c) => c.url.pathname === '/api/chats/bulk/transfer');
  expect(JSON.parse(post!.body!)).toEqual({ chatIds: ['a', 'b'], sectorId: 's1', ownerId: null });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w web -- src/pages/Inbox.test.tsx`
Expected: the four new tests FAIL, because there is no "Ordenar conversas" control and no "Selecionar" button. The existing tests still pass.

- [ ] **Step 3: Let the dialogs take a title**

In `web/src/components/conversation/ChatDialogs.tsx`, in `TransferDialog`'s props replace `chat: ChatDetail;` with:

```tsx
  /** Only the starting sector is read; the bulk bar passes the default sector. */
  chat: Pick<ChatDetail, 'sectorId'>;
  /** Spec 2026-10-20 §4: "Transferir N conversas". */
  title?: string;
```

and change its `<Modal title="Transferir conversa" onCancel={props.onCancel}>` to `<Modal title={props.title ?? 'Transferir conversa'} onCancel={props.onCancel}>`.

In `CloseDialog`'s props add `title?: string;` and change `<Modal title="Finalizar conversa" onCancel={props.onCancel}>` to `<Modal title={props.title ?? 'Finalizar conversa'} onCancel={props.onCancel}>`. `ConversationHeader` passes the full `chat` and no title, so it compiles and behaves as before.

- [ ] **Step 4: Create the bar**

Create `web/src/components/inbox/BulkBar.tsx`:

```tsx
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { BulkResultDto, ChatTab } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { CloseDialog, TransferDialog } from '../conversation/ChatDialogs';
import { bulkSummary } from './bulk';

interface Props {
  /** The selected chats still in the list. */
  chatIds: string[];
  tab: ChatTab;
  /** After each run: the summary line and the chats that could not be done. */
  onResult(summary: string, failedIds: string[]): void;
  onCancel(): void;
}

const conversations = (n: number) => (n === 1 ? '1 conversa' : `${n} conversas`);

/** Spec 2026-10-20 §4: the bar under the list while "Selecionar" is on. */
export function BulkBar({ chatIds, tab, onResult, onCancel }: Props) {
  const sectors = useQuery({ queryKey: qk.sectors, queryFn: api.sectors.list }).data ?? [];
  const users = useQuery({ queryKey: qk.users, queryFn: api.users.list }).data ?? [];
  const [dialog, setDialog] = useState<'transfer' | 'close' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const n = chatIds.length;
  const workable = tab !== 'closed'; // Finalizados: nothing to transfer or finish
  const startSector = sectors.find((s) => s.isDefault) ?? sectors[0];

  async function run(call: () => Promise<BulkResultDto>) {
    setBusy(true);
    setError(null);
    try {
      const result = await call();
      setDialog(null);
      onResult(bulkSummary(result), result.failed.map((f) => f.chatId));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível concluir. Tente de novo.');
    } finally {
      setBusy(false);
    }
  }

  function closeDialog() {
    setDialog(null);
    setError(null);
  }

  const button =
    'h-8 rounded-lg border border-border bg-surface px-2.5 font-medium hover:bg-sidebar-hover disabled:cursor-not-allowed disabled:opacity-50';
  return (
    <div className="border-t border-border bg-panel px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-auto font-semibold">{n === 1 ? '1 selecionada' : `${n} selecionadas`}</span>
        <button type="button" disabled={busy || n === 0 || !workable} onClick={() => setDialog('transfer')} className={button}>
          Transferir
        </button>
        <button type="button" disabled={busy || n === 0 || !workable} onClick={() => setDialog('close')} className={button}>
          Finalizar
        </button>
        <button type="button" disabled={busy || n === 0} onClick={() => void run(() => api.chats.bulkRead(chatIds))} className={button}>
          Marcar como lida
        </button>
        <button type="button" onClick={onCancel} className="h-8 rounded-lg px-2.5 text-muted hover:text-fg">
          Cancelar
        </button>
      </div>
      {error && !dialog && (
        <p role="alert" className="mt-2 text-danger">
          {error}
        </p>
      )}
      {dialog === 'transfer' && startSector && (
        <TransferDialog
          title={`Transferir ${conversations(n)}`}
          chat={{ sectorId: startSector.id }}
          sectors={sectors}
          users={users}
          busy={busy}
          error={error}
          onCancel={closeDialog}
          onConfirm={(to) => void run(() => api.chats.bulkTransfer({ chatIds, ...to }))}
        />
      )}
      {dialog === 'close' && (
        <CloseDialog
          title={`Finalizar ${conversations(n)}`}
          busy={busy}
          error={error}
          onCancel={closeDialog}
          onConfirm={(sendClosingMessage) => void run(() => api.chats.bulkClose({ chatIds, sendClosingMessage }))}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 5: Wire the Inbox**

Replace `web/src/pages/Inbox.tsx` with:

```tsx
import { useEffect, useState, type UIEvent } from 'react';
import { Outlet, useNavigate, useParams } from 'react-router';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowsDownUp, CheckSquare, Eye, EyeSlash, Funnel, MagnifyingGlass, Plus } from '@phosphor-icons/react';
import {
  BULK_MAX, CHAT_SORTS, DEFAULT_CHAT_SORT, type ChatListFilters, type ChatListItem as ChatItem, type ChatSort, type ChatTab,
} from '@talk/shared';
import { api, ApiError, qk } from '../lib/api';
import { useMe } from '../lib/auth';
import { confirmDialog } from '../lib/confirm';
import { BulkBar } from '../components/inbox/BulkBar';
import { ChatListItem } from '../components/inbox/ChatListItem';
import { FilterPanel } from '../components/inbox/FilterPanel';
import { NewChatDialog } from '../components/inbox/NewChatDialog';
import {
  buildChatQuery, CHAT_SORT_LABELS, EMPTY_FILTERS, readChatSort, saveChatSort, withSort, type InboxFilters,
} from '../components/inbox/chat-query';

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
  // one banner for all row/header actions: the last error wins, any success clears it
  const [actionError, setActionError] = useState<string | null>(null);
  const me = useMe().data;
  // spec 2026-10-20 §3: per user, kept in this browser
  const [sort, setSort] = useState<ChatSort>(() => readChatSort(me?.id));
  // spec 2026-10-20 §4: selection mode, the selected ids and the last bulk result line
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [notice, setNotice] = useState<string | null>(null);

  const sectors = useQuery({ queryKey: qk.sectors, queryFn: api.sectors.list });
  const users = useQuery({ queryKey: qk.users, queryFn: api.users.list });
  const tags = useQuery({ queryKey: qk.tags, queryFn: api.tags.list });
  const channels = useQuery({ queryKey: qk.channels, queryFn: api.channels.list });
  const channelList = channels.data ?? [];
  // History spec §7: the channel shows on the card only when there is more than one
  const channelName = new Map<string, string>(channelList.length > 1 ? channelList.map((c): [string, string] => [c.id, c.name]) : []);
  const sectorName = new Map((sectors.data ?? []).map((s) => [s.id, s.name]));
  const userById = new Map((users.data ?? []).map((u) => [u.id, u]));
  const tagById = new Map((tags.data ?? []).map((t) => [t.id, t]));
  const badges: Record<ChatTab, number> = { inbox: useUnreadChats('inbox'), waiting: useUnreadChats('waiting'), closed: 0 };

  const list = useChatList(withSort(buildChatQuery(tab, q, filters), sort));
  const chats = list.data?.pages.flatMap((p) => p.items) ?? [];

  // a new list (tab, search, filters, order) starts an empty selection
  useEffect(() => setSelected(new Set()), [tab, q, filters, sort]);
  // Review Focus 7: a chat that left the list (WS, someone else's transfer) drops out of the count and of the request
  const selectedIds = chats.filter((c) => selected.has(c.id)).map((c) => c.id);
  const toggleSelected = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  function stopSelecting() {
    setSelecting(false);
    setSelected(new Set());
  }
  function changeSort(next: ChatSort) {
    setSort(next);
    saveChatSort(me?.id, next);
  }

  const pin = useMutation({
    mutationFn: (chat: ChatItem) => api.chats.pin(chat.id, !chat.pinned),
    onSuccess: () => {
      setActionError(null);
      // pins are per user: refetch this user's lists (pinned chats sort first)
      return qc.invalidateQueries({ queryKey: qk.chatLists });
    },
    onError: (err) =>
      setActionError(
        err instanceof ApiError && err.status === 409
          ? 'Você já fixou 3 conversas. Desafixe uma para fixar outra.'
          : err instanceof Error
            ? err.message
            : 'Não foi possível concluir. Tente de novo.',
      ),
  });

  const failed = (err: unknown) => setActionError(err instanceof Error ? err.message : 'Não foi possível concluir. Tente de novo.');
  const refreshLists = () => {
    setActionError(null);
    return qc.invalidateQueries({ queryKey: qk.chatLists });
  };
  const markUnread = useMutation({ mutationFn: api.chats.markUnread, onSuccess: refreshLists, onError: failed });
  // chat.removed (WS) drops it from every list too; the refetch covers a socket that is reconnecting
  const remove = useMutation({
    mutationFn: api.chats.remove,
    onSuccess: (_data, id) => {
      if (id === activeId) navigate('/chats');
      return refreshLists();
    },
    onError: failed,
  });

  async function confirmRemove(id: string) {
    const ok = await confirmDialog({
      title: 'Excluir conversa?',
      body: 'A conversa, as mensagens e os arquivos dela saem do sistema para todos. O WhatsApp do contato e o celular não mudam. Não dá para desfazer.',
      confirmLabel: 'Excluir',
    });
    if (ok) remove.mutate(id);
  }

  // Admin-only "Ver todos os setores": the server re-reads it on every request, so refetch what it filters.
  const view = useMutation({
    mutationFn: api.auth.setView,
    onError: () => setActionError('Não foi possível alterar a visualização. Tente novamente.'),
    onSuccess: (next) => {
      setActionError(null);
      qc.setQueryData(qk.me, next);
      return Promise.all([qc.invalidateQueries({ queryKey: qk.chats }), qc.invalidateQueries({ queryKey: qk.contacts })]);
    },
  });

  function onScroll(e: UIEvent<HTMLUListElement>) {
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 200 && list.hasNextPage && !list.isFetchingNextPage) {
      void list.fetchNextPage();
    }
  }

  const activeFilters =
    [filters.sectorId, filters.ownerId, filters.tagId, filters.chatTagId].filter(Boolean).length + (filters.period === 'any' ? 0 : 1);

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-[360px] shrink-0 flex-col border-r border-border bg-surface">
        <div className="flex items-center gap-1 pt-4 pr-3 pl-5">
          <h1 className="mr-auto text-xl font-semibold tracking-tight">Conversas</h1>
          {me?.role === 'admin' && (
            <button
              type="button"
              aria-label="Ver todos os setores"
              aria-pressed={me.seeAllSectors}
              title={me.seeAllSectors ? 'Vendo todos os setores' : 'Vendo só os seus setores'}
              disabled={view.isPending}
              onClick={() => view.mutate(!me.seeAllSectors)}
              className={`flex size-10 items-center justify-center rounded-lg hover:bg-sidebar-hover ${me.seeAllSectors ? 'bg-primary-soft text-link' : 'text-muted'}`}
            >
              {me.seeAllSectors ? <Eye size={20} /> : <EyeSlash size={20} />}
            </button>
          )}
          <button
            type="button"
            aria-pressed={selecting}
            onClick={() => {
              setNotice(null);
              if (selecting) stopSelecting();
              else setSelecting(true);
            }}
            className={`flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium hover:bg-sidebar-hover ${selecting ? 'bg-primary-soft text-link' : 'text-muted'}`}
          >
            <CheckSquare size={16} aria-hidden /> Selecionar
          </button>
          <button
            type="button"
            aria-label="Nova conversa"
            title="Nova conversa"
            onClick={() => setShowNew(true)}
            className="flex h-9 items-center gap-1.5 rounded-lg bg-primary pr-3 pl-2.5 text-sm font-semibold text-white hover:bg-primary-hover"
          >
            <Plus size={16} weight="bold" aria-hidden /> Nova
          </button>
        </div>

        <div role="tablist" className="mx-4 mt-3 flex gap-0.5 rounded-xl bg-panel p-[3px]">
          {TABS.map(({ tab: t, label }) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg text-sm ${
                tab === t ? 'bg-surface font-semibold text-fg shadow-sm' : 'font-medium text-muted hover:text-fg'
              }`}
            >
              {label}
              {badges[t] > 0 && (
                <span
                  aria-label={`Conversas não lidas: ${badges[t]}`}
                  className={`min-w-5 rounded-full px-1.5 text-[11px] font-bold ${t === 'waiting' ? 'bg-brass-soft text-brass' : 'bg-primary text-white'}`}
                >
                  {badges[t]}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 px-4 pt-3 pb-2">
          <label className="flex h-10 flex-1 items-center gap-2 rounded-lg border border-border bg-surface px-3 focus-within:ring-2 focus-within:ring-primary">
            <MagnifyingGlass aria-hidden="true" className="text-muted" />
            <input
              type="search"
              aria-label="Buscar conversas"
              placeholder="Buscar por nome ou telefone"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full bg-transparent py-1.5 text-sm outline-none"
            />
          </label>
          <label
            title={`Ordenar: ${CHAT_SORT_LABELS[sort]}`}
            className={`relative flex size-10 shrink-0 items-center justify-center rounded-lg border border-border hover:bg-sidebar-hover focus-within:ring-2 focus-within:ring-primary ${sort === DEFAULT_CHAT_SORT ? 'text-muted' : 'text-link'}`}
          >
            <ArrowsDownUp size={18} aria-hidden />
            {/* the native list, invisible over the icon: keyboard, screen readers and phones get the real <select> */}
            <select
              aria-label="Ordenar conversas"
              value={sort}
              onChange={(e) => changeSort(e.target.value as ChatSort)}
              className="absolute inset-0 cursor-pointer opacity-0"
            >
              {CHAT_SORTS.map((s) => (
                <option key={s} value={s}>
                  {CHAT_SORT_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            aria-label="Filtrar conversas"
            aria-expanded={showFilters}
            onClick={() => setShowFilters((v) => !v)}
            className={`relative flex size-10 items-center justify-center rounded-lg border border-border hover:bg-sidebar-hover ${activeFilters ? 'text-link' : 'text-muted'}`}
          >
            <Funnel size={18} weight={activeFilters ? 'fill' : 'regular'} />
            {activeFilters > 0 && (
              <span aria-hidden className="absolute -top-1.5 -right-1.5 flex size-4 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-white">
                {activeFilters}
              </span>
            )}
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
        {actionError && (
          <p role="alert" className="mx-3 mb-2 rounded bg-danger/15 px-3 py-2 text-sm text-danger">
            {actionError}
          </p>
        )}
        {notice && (
          <p role="status" className="mx-3 mb-2 rounded bg-panel px-3 py-2 text-sm text-fg">
            {notice}
          </p>
        )}

        <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2" onScroll={onScroll}>
          {me?.role === 'admin' && !me.seeAllSectors && me.sectorIds.length === 0 && (
            <li className="px-4 pb-4 text-sm text-muted">
              Você não está em nenhum setor. Ative “Ver todos os setores” para ver as conversas do escritório.
            </li>
          )}
          {chats.map((c) => (
            <ChatListItem
              key={c.id}
              chat={c}
              active={c.id === activeId}
              sectorName={sectorName.get(c.sectorId) ?? null}
              channelName={channelName.get(c.channelId) ?? null}
              owner={c.ownerId ? (userById.get(c.ownerId) ?? null) : null}
              tagById={tagById}
              selection={
                selecting
                  ? {
                      selected: selected.has(c.id),
                      disabled: !selected.has(c.id) && selectedIds.length >= BULK_MAX,
                      onToggle: () => toggleSelected(c.id),
                    }
                  : undefined
              }
              onOpen={() => navigate(`/chats/${c.id}`)}
              onTogglePin={() => pin.mutate(c)}
              onMarkUnread={() => {
                // leave first: the open pane marks a chat read as soon as it sees unread > 0
                if (c.id === activeId) navigate('/chats');
                markUnread.mutate(c.id);
              }}
              onOpenWith={(acao) => navigate(`/chats/${c.id}?acao=${acao}`)}
              onDelete={me?.role === 'admin' ? () => void confirmRemove(c.id) : undefined}
            />
          ))}
          {list.isPending && <li className="p-4 text-sm text-muted">Carregando…</li>}
          {list.isError && <li className="p-4 text-sm text-danger">Não foi possível carregar as conversas.</li>}
          {list.isSuccess && chats.length === 0 && <li className="p-4 text-sm text-muted">Nenhuma conversa</li>}
          {list.isFetchingNextPage && <li className="p-4 text-sm text-muted">Carregando…</li>}
        </ul>

        {selecting && (
          <BulkBar
            chatIds={selectedIds}
            tab={tab}
            onCancel={stopSelecting}
            onResult={(summary, failedIds) => {
              setNotice(summary);
              void qc.invalidateQueries({ queryKey: qk.chatLists });
              // all done: leave the mode; otherwise keep only what failed, to retry or look at
              if (failedIds.length) setSelected(new Set(failedIds));
              else stopSelecting();
            }}
          />
        )}
      </aside>

      <section className="min-w-0 flex-1">
        <Outlet />
      </section>

      {showNew && <NewChatDialog sectors={sectors.data ?? []} onClose={() => setShowNew(false)} />}
    </div>
  );
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -w web -- src/pages/Inbox.test.tsx src/components/conversation/ConversationHeader.test.tsx`
Expected: PASS. That includes the existing Inbox tests, such as `renders chat items…` (two "Financeiro" chips, no tag chips with an empty catalog) and the "Ver todos os setores" tests, plus the header's transfer and close dialogs.

Run: `npm test` (all workspaces) and `npm run typecheck`
Expected: PASS, no errors.

- [ ] **Step 7: Commit**

```bash
git add web/src/components/conversation/ChatDialogs.tsx web/src/components/inbox/BulkBar.tsx web/src/pages/Inbox.tsx web/src/pages/Inbox.test.tsx
git commit -m "feat(web): list order control, selection mode and the bulk bar (transferir, finalizar, marcar como lida)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Self-review checklist (for the executor, after Task 8)

- [ ] Spec §3: five orders; pins on top; the cursor carries the order; `waiting_since` lifecycle (Tasks 2–3); `localStorage` per user with try/catch (Task 6); control next to the filter (Task 8).
- [ ] Spec §4: cap 50 on both sides (Tasks 5 and 8); per-chat results; bot rule "keep"/"stop"; one 400 for a bad destination; closing-message failure per chat; result line and "keep the failed ones selected" (Task 8); Transferir/Finalizar disabled on Finalizados.
- [ ] Spec §5: `chat_tags` with cascades (Task 1); PUT route on open and closed chats, and no history check in `setChatTags` (Task 4); WS DTO (`hub.test.ts`); LID merge; chips that look different on the card; editor in "Detalhes da conversa"; both filters (Task 7).
- [ ] Delivery 1 and 6cb812b survive: `OutTick` and `lastOutStatus` (card, DTO, `hub.test.ts`), the outbound ingest's `unread: 0`, the search/note/favorite routes, the `Favoritas` section, the `2026-10-19` block in `api.test.ts`.
- [ ] `git diff --stat origin/main...HEAD -- web/src/components/conversation/MessageBubble.tsx web/src/components/conversation/MessageMenu.tsx web/src/components/conversation/ConversationHeader.tsx web/src/components/conversation/Composer.tsx web/src/components/conversation/Timeline.tsx web/src/lib/ws.ts` prints nothing.
- [ ] `ls server/drizzle/*.sql | tail -2` shows `0006_conversa_dia_a_dia.sql` then `0007_lista_dia_a_dia.sql`, and `git diff origin/main...HEAD -- server/drizzle/0006_conversa_dia_a_dia.sql server/drizzle/meta/0006_snapshot.json` prints nothing.
- [ ] `grep -rn "console\." server/src/inbox/bulk.ts` shows only ids and `err.name`.
