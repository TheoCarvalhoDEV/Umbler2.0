# Conversation Day-to-Day (notes, search, favorites, preferences) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let agents edit and delete internal notes, search inside one conversation and jump to any hit, star messages for the whole team, and set their own Enter / sound / browser-notification preferences.

**Architecture:** Shared pure code first: note rules next to the other message-action rules, one accent fold (`foldText` + the `FOLD_FROM`/`FOLD_TO` table that SQL `translate()` also uses) and the preference defaults. The server reuses the edit path for notes (no Evolution branch, no event), adds a hard delete for notes with a `note_deleted` event, a shared-star table `message_favorites`, a per-chat search query and two new timeline cursors (`after`, `around`). Preferences live in `users.preferences jsonb` and are merged with `||` in one `UPDATE`. The web adds an anchored timeline mode (a second infinite query around one message, paged both ways), a search bar under the header, a favorites list in the "Detalhes da conversa" tab, and a Preferences page; the composer, the message sound/notification hook and the chatbot toasts read the preferences from the cached `me`.

**Tech Stack:** Node 24, TypeScript 5.9.3 strict ESM, Fastify 5.12.7, drizzle-orm 0.45.4 / drizzle-kit 0.31.11, Postgres (PGlite 0.5.10 in tests), zod 4.6.7, vitest 5.0.4, React 19.3.1, @tanstack/react-query 5.104.2, react-router 8.4.0, Tailwind 4.3.3, @phosphor-icons/react 2.1.10. **No new dependency.**

**Spec:** `docs/superpowers/specs/2026-10-19-conversa-dia-a-dia-design.md`.

## Global Constraints

- No new dependency in any workspace. The sound stays the WebAudio beep that `web/src/lib/notify.tsx` already has.
- Notes, favorites, search and preferences never call Evolution (`ctx.wa`). Tests assert `w.ctx.wa.sent` stays `[]`.
- Every read and mutation of a chat or message goes through `getChatForUser` (404 when the user cannot see the chat). Mutations that change a message (note edit, note delete) also need an open chat (409 `'Conversa finalizada'`) through the existing `loadTarget`. Starring works in closed and history chats (spec §5).
- Every new mutation is a non-GET `/api/*` route, so the global Origin check (`authPlugin`) covers it; its tests send `loginAs(...).headers`.
- Logs never carry message text, phones or names. New event data carries no text: `note_deleted` has `data: {}`.
- The migration is generated, never hand-edited: `npm run db:generate -w server -- --name conversa_dia_a_dia` creates `0006_conversa_dia_a_dia`. The running dev server (`tsx watch`) applies it to its own database when it restarts; never run SQL against that database by hand and never start or stop the dev server.
- Extend, never rename. New DTO fields are **optional** (`MessageDto.favorite`, `Me.preferences`, `AuthUser.preferences`); the server always fills them. Tests that `toEqual` a full `MessageDto` or `Me` gain the new field (listed in Tasks 2 and 5).
- Inside `ctx.db.transaction(tx => …)` use only `tx` (PGlite deadlocks otherwise). Publish to the hub after commit.
- Search folds case and accents with `translate(lower(col), FOLD_FROM, FOLD_TO)` in SQL and `foldText` in JS: the same table, defined once in `shared/src/search.ts`. `%`, `_` and `\` in the query are escaped (`escapeLike`). No `unaccent` extension.
- Limits: search 2–100 characters (`SEARCH_MIN_CHARS`, `SEARCH_MAX_CHARS`), at most 50 hits (`SEARCH_LIMIT`); favorites list at most 200 (`FAVORITES_LIMIT`); note text 1–4096 (the existing `editBody`); focus highlight 3 s (`FOCUS_HIGHLIGHT_MS`); search debounce 300 ms (`SEARCH_DEBOUNCE_MS`).
- UI copy is pt-BR, exactly as spec §8:
  - menu: "Favoritar", "Remover dos favoritos", "Editar nota", "Apagar nota";
  - note delete confirmation: title "Apagar nota?", body "A nota sai da conversa para todos.", button "Apagar nota";
  - event: "Nota apagada por <nome>";
  - refusals: "Só quem escreveu a nota pode editá-la", "Só quem escreveu a nota ou um administrador pode apagá-la", "Esta mensagem não é uma nota";
  - header button "Buscar na conversa"; search box "Buscar mensagens" (placeholder "Buscar nesta conversa…"); "Buscando…", "Não foi possível buscar", "Nenhum resultado", "1 resultado", "N resultados", "50+ resultados"; buttons "Resultado anterior", "Próximo resultado", "Fechar busca";
  - timeline: "Ir para as mensagens recentes", "Carregando mensagens seguintes…";
  - panel: section "Favoritas", "Nenhuma mensagem favorita.", "por <nome>"; bubble hint "Favoritada por <nome>";
  - preferences page "Preferências": "Enter envia a mensagem" / "Desligado: Enter quebra a linha e Ctrl+Enter envia.", "Sons" / "Um bipe quando chega mensagem de um contato, menos na conversa que você está vendo.", "Notificações do navegador" with "Sempre", "Só quando a aba está em segundo plano", "Nunca".
- Code identifiers are English.
- Theme tokens only (`bg-surface`, `bg-sunken`, `bg-panel`, `text-fg`, `text-muted`, `text-danger`, `border-border`, `border-field`, `ring-brass`, `text-brass`, `bg-sidebar-hover`, `accent-primary`). No raw colors.
- Reuse what exists: `confirmDialog` (`web/src/lib/confirm.ts`), `Section`/`ErrorText` (`web/src/components/settings/common.tsx`), `NotificationPermissionButton` and `beep` (`web/src/lib/notify.tsx`), `previewText` (`model.ts`), `escapeLike` (`server/src/inbox/queries.ts`), the edit flow in `editMessage` and the bubble's in-place editor.
- Commit after every task with a Conventional Commit message, staging only that task's files. Every commit command ends with `-m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`.

## Review Focus

These are inputs and conditions the spec implies but never tests, most likely first. The owning task adds the named test.

1. **Jumping to a message older than everything loaded.** The live timeline only pages backwards, so the web needs a page *around* the message and pages in both directions from it, while the live cache keeps receiving new messages. A WebSocket update must reach the anchored view, but a new message must not be inserted into it (it may not hold the present). **Owners: Task 4** `loads the page around a message and pages newer with after=<newest id> (Review Focus 1)`, **Task 6** `message.updated reaches an anchored timeline too; message.created only the live one (Review Focus 1)`, **Task 7** `loads the page around a message that is not loaded, then goes back to the recent ones (Review Focus 1)`.
2. **Accents under the C locale and LIKE wildcards.** PGlite's `lower()` does not lower `Ç`/`Ã`; a user typing `0%` or `o_1` must not match `100 reais` or `o 1`. **Owner: Task 4**, test `folds case and accents, and treats % and _ as plain text (Review Focus 2)`.
3. **The notes route removing something that is not a note, or a note someone else may not delete.** `DELETE /api/notes/:id` on a WhatsApp message must leave it alone; another agent who sees the chat gets 409; an admin may delete. **Owner: Task 3**, tests `an admin deletes anyone's note; another agent who sees the chat does not (Review Focus 3)` and `never removes a message that is not a note, and refuses in a closed chat (Review Focus 3)`.
4. **A note edit reaching Evolution, or the office edit no longer reaching it.** The note branch skips `viaWhatsApp`; the existing `edits the author text on WhatsApp and keeps the previous version` in `actions.test.ts` must keep passing unchanged. **Owner: Task 3**, test `the author edits a note: new text, the old one in the history, no WhatsApp call and no timeline event (Review Focus 4)`.
5. **Two tabs saving different preferences at once.** A read-modify-write in JS loses one field. **Owner: Task 5**, test `two saves at once keep both fields (Review Focus 5)`.
6. **A hidden chat leaking through the new reads.** Star, unstar, favorites list and search of a chat the user cannot see are all 404, and nothing is written. **Owners: Task 3** `404 for a hidden chat or an unknown message, in every route (Review Focus 6)`, **Task 4** `404 for a chat the user cannot see; 400 under 2 characters; 401 without a session (Review Focus 6)`.
7. **Beeping or notifying for the chat the user is reading.** "Sempre" and "Sons" must still stay quiet for the chat on screen in a visible tab. **Owner: Task 9**, test `stays quiet for the chat being read in a visible tab (Review Focus 7)`.

---

## File Structure

Each line gives the path, the task that creates or first modifies it, and its responsibility.

**Shared**
- `shared/src/preferences.ts` (T1, create): `BROWSER_NOTIFICATION_MODES`, `BrowserNotificationMode`, `UserPreferences`, `DEFAULT_PREFERENCES`.
- `shared/src/search.ts` (T1, create): `SEARCH_MIN_CHARS`, `SEARCH_MAX_CHARS`, `SEARCH_LIMIT`, `FOLD_FROM`, `FOLD_TO`, `foldText`.
- `shared/src/message-actions.ts` (T1): `FAVORITES_LIMIT`, `noteEditBlock`, `noteDeleteBlock`.
- `shared/src/index.ts` (T1): re-exports; `Me.preferences?`, `MessageDto.favorite?`, `ChatEventKind` gains `note_deleted`, `MessageSearchHit`.

**Server**
- `server/src/db/schema.ts` (T2): `users.preferences`, table `messageFavorites`.
- `server/drizzle/0006_conversa_dia_a_dia.sql`, `server/drizzle/meta/0006_snapshot.json`, `server/drizzle/meta/_journal.json` (T2): the generated migration.
- `server/src/messages/dto.ts` (T2): `toMessageDto` fills `favorite`.
- `server/src/messages/actions.ts` (T3): `editMessage` takes notes; new `deleteNote`, `setFavorite`, `listFavorites`.
- `server/src/inbox/queries.ts` (T4): `getTimeline` with `after`/`around`; new `searchChat`, `snippetOf`.
- `server/src/chats/routes.ts` (T3): note delete and favorite routes; (T4) timeline cursors and the search route.
- `server/src/auth/preferences.ts` (T5, create): `preferencesSchema`, `readPreferences`.
- `server/src/inbox/visibility.ts` (T5): `AuthUser.preferences?`, filled by `loadAuthUser`.
- `server/src/auth/routes.ts` (T5): `PUT /api/auth/me/preferences`.

**Server tests**
- `server/test/messages/action-rules.test.ts` (T1), `server/test/messages/search-fold.test.ts` (T1, create).
- `server/test/db/schema.test.ts`, `server/test/messages/dto.test.ts`, `server/test/realtime/hub.test.ts` (T2).
- `server/test/messages/notes-favorites.test.ts` (T3, create).
- `server/test/chats/search.test.ts` (T4, create), `server/test/chats/list-and-timeline.test.ts` (T4).
- `server/test/auth/routes.test.ts` (T5).

**Web**
- `web/src/components/conversation/model.ts` (+ `model.test.ts`): (T1) `eventText` for `note_deleted`; (T7) `TimelineFocus`, `FOCUS_HIGHLIGHT_MS`, `olderCursor`, `newerCursor`; (T8) `resultsLabel`, `shortDateTime`; (T9) `isSendKey`.
- `web/src/lib/api.ts` (+ `api.test.ts`) (T6): `TimelineCursor`, `AnchoredTimelineData`, `api.chats.timeline` cursors, `api.chats.search`, `api.chats.favorites`, `api.messages.favorite`, `api.notes.remove`, `api.auth.setPreferences`, `qk.timelineAnchors`, `qk.timelineAt`, `qk.chatSearch`, `qk.chatFavorites`.
- `web/src/lib/ws.ts` (+ `ws.test.ts`) (T6): anchored timelines get updates; the favorites list follows the stars.
- `web/src/components/conversation/MessageMenu.tsx` (T6): `favorite` and `deleteNote` actions, note items, `isAdmin`.
- `web/src/components/conversation/MessageBubble.tsx` (+ `MessageBubble.test.tsx`) (T6): star, favorite/unfavorite, note delete, `highlighted`, `data-message-id`.
- `web/src/components/conversation/Timeline.tsx` (+ `Timeline.test.tsx`) (T7): `focus` prop, anchored mode, highlight.
- `web/src/components/conversation/ConversationView.tsx`: (T7) `focus` prop and prefix invalidation; (T8) search bar and `onFocusMessage`.
- `web/src/components/conversation/ChatSearchBar.tsx` (+ test) (T8, create).
- `web/src/components/conversation/FavoritesList.tsx` (+ test) (T8, create).
- `web/src/components/conversation/ConversationHeader.tsx` (+ test) (T8): "Buscar na conversa".
- `web/src/pages/Conversation.tsx` (T8): the focus state.
- `web/src/components/contacts/ContactPanel.tsx` (T8): "Favoritas" in "Detalhes da conversa".
- `web/src/lib/auth.tsx` (T9): `usePreferences`, `preferencesOf`.
- `web/src/lib/notify.tsx` (+ `notify.test.ts`, create) (T9): `browserNotificationAllowed`, `messageAlerts`, `showBrowserNotification`.
- `web/src/components/layout/NotificationToasts.tsx` (+ test) (T9).
- `web/src/components/conversation/Composer.tsx` (+ test) (T9).
- `web/src/pages/settings/PreferencesSettings.tsx` (+ test) (T9, create), `web/src/pages/settings/SettingsPage.tsx` (T9).

---

## Shared contract

Every name below is defined in exactly one task and used with this spelling everywhere.

**`shared/src/preferences.ts` (Task 1)**
```ts
export const BROWSER_NOTIFICATION_MODES: readonly ['always', 'background', 'never'];
export type BrowserNotificationMode = 'always' | 'background' | 'never';
export interface UserPreferences { enterSends: boolean; sounds: boolean; browserNotifications: BrowserNotificationMode }
export const DEFAULT_PREFERENCES: Readonly<UserPreferences>; // { enterSends: true, sounds: true, browserNotifications: 'background' }
```

**`shared/src/search.ts` (Task 1)**
```ts
export const SEARCH_MIN_CHARS: number; // 2
export const SEARCH_MAX_CHARS: number; // 100
export const SEARCH_LIMIT: number;     // 50
export const FOLD_FROM: string;        // accented letters, lower then upper case
export const FOLD_TO: string;          // their plain lower-case letters, same length
export function foldText(s: string): string;
```

**`shared/src/message-actions.ts` (Task 1)**
```ts
export const FAVORITES_LIMIT: number; // 200
export function noteEditBlock(m: ActionTarget, userId: string | null): ActionBlock | null;
export function noteDeleteBlock(m: ActionTarget, userId: string | null, isAdmin: boolean): ActionBlock | null;
```

**`shared/src/index.ts` (Task 1)**
```ts
// Me gains (optional): preferences?: UserPreferences;
// MessageDto gains (optional): favorite?: { at: string; byName: string | null } | null;
// ChatEventKind gains: 'note_deleted'   (data: {}; authorName = who deleted it)
export interface MessageSearchHit { messageId: string; kind: MessageDto['kind']; direction: 'in' | 'out'; snippet: string; sentAt: string }
```

**`server/src/db/schema.ts` (Task 2):** `users.preferences` (`jsonb`, `$type<Partial<UserPreferences>>()`, not null, default `{}`) and table `messageFavorites` with `messageId` (primary key, → messages cascade), `userId` (→ users set null) and `createdAt`.

**`server/src/messages/actions.ts`**
```ts
export async function editMessage(ctx, user, messageId, text): Promise<MessageDto>;                       // existing; Task 3 accepts notes
export async function deleteNote(ctx: AppCtx, user: AuthUser, messageId: string): Promise<void>;          // Task 3
export async function setFavorite(ctx: AppCtx, user: AuthUser, messageId: string, on: boolean): Promise<MessageDto>; // Task 3
export async function listFavorites(ctx: AppCtx, user: AuthUser, chatId: string): Promise<MessageDto[]>;  // Task 3
```

**`server/src/inbox/queries.ts` (Task 4)**
```ts
export async function getTimeline(ctx, user, chatId, q: { before?: string; after?: string; around?: string; limit?: number }): Promise<TimelineItem[]>;
export async function searchChat(ctx: AppCtx, user: AuthUser, chatId: string, q: string): Promise<MessageSearchHit[]>;
export function snippetOf(text: string, needle: string): string;
```

**`server/src/auth/preferences.ts` (Task 5)**
```ts
export const preferencesSchema; // z.strictObject({ enterSends, sounds, browserNotifications }).partial()
export function readPreferences(stored: unknown): UserPreferences;
```
`AuthUser` gains `preferences?: UserPreferences` (Task 5).

**HTTP**
| Route | Body / query | Answer | Task |
|---|---|---|---|
| `PATCH /api/messages/:id` (a note) | `{ text }` | `MessageDto` | 3 |
| `DELETE /api/notes/:id` | none | 204 | 3 |
| `PUT /api/messages/:id/favorite` | none | `MessageDto` | 3 |
| `DELETE /api/messages/:id/favorite` | none | `MessageDto` | 3 |
| `GET /api/chats/:id/favorites` | none | `MessageDto[]` (newest star first) | 3 |
| `GET /api/chats/:id/timeline` | `before` \| `after` \| `around` (at most one), `limit` | `TimelineItem[]` ascending | 4 |
| `GET /api/chats/:id/search` | `q` (2–100) | `MessageSearchHit[]` (newest first, ≤ 50) | 4 |
| `PUT /api/auth/me/preferences` | partial `UserPreferences` (strict) | `Me` | 5 |

**Web**
- `web/src/lib/api.ts` (Task 6):
  - `export type TimelineCursor = { before: string } | { after: string } | { around: string };`
  - `export type AnchoredTimelineData = InfiniteData<TimelineItem[], TimelineCursor>;`
  - `api.chats.timeline(id, q?: { before?; after?; around?; limit? })`, `api.chats.search(id, q)`, `api.chats.favorites(id)`, `api.messages.favorite(id, on)`, `api.notes.remove(id)`, `api.auth.setPreferences(patch)`;
  - `qk.timelineAnchors(chatId)` = `['chats','timeline',chatId,'at']`, `qk.timelineAt(chatId, messageId)` = `[...timelineAnchors, messageId]`, `qk.chatSearch(chatId, q)` = `['chats','search',chatId,q]`, `qk.chatFavorites(chatId)` = `['chats','favorites',chatId]`.
- `web/src/components/conversation/model.ts`: `TimelineFocus { messageId: string; seq: number }`, `FOCUS_HIGHLIGHT_MS`, `olderCursor(page, param, size)`, `newerCursor(page, param, size)` (Task 7); `resultsLabel(n)`, `shortDateTime(iso)` (Task 8); `isSendKey(e, enterSends)` (Task 9).
- `MenuAction` gains `'favorite' | 'deleteNote'`; `menuItems(m, meId, chatOpen, now, isAdmin = false)` (Task 6).
- `MessageBubble` gains `highlighted?: boolean` (Task 6). `Timeline` gains `focus?: TimelineFocus | null` (Task 7). `ConversationView` gains `focus?` (Task 7) and `onFocusMessage?` (Task 8). `ConversationHeader` gains `searchOpen?`, `onToggleSearch?` (Task 8). `ContactPanel` gains `onJumpToMessage?` (Task 8).
- `ChatSearchBar({ chatId, onFocusMessage, onClose })`, `SEARCH_DEBOUNCE_MS` (Task 8); `FavoritesList({ chatId, onJump })` (Task 8).
- `web/src/lib/auth.tsx`: `usePreferences(): UserPreferences`, `preferencesOf(qc): UserPreferences` (Task 9).
- `web/src/lib/notify.tsx`: `browserNotificationAllowed(mode, hidden)`, `messageAlerts(prefs, { hidden, chatOnScreen })`, `showBrowserNotification(title, body, tag, open)` (Task 9).
- `PreferencesSettings` (Task 9).

---
### Task 1: Shared rules, fold, preference defaults and DTO fields

The new `ChatEventKind` value forces a new case in `eventText` (its `switch` is exhaustive), so the web text belongs to this task: without it `npm run typecheck` fails.

**Files:**
- Create: `shared/src/preferences.ts`, `shared/src/search.ts`
- Modify: `shared/src/message-actions.ts` (constants block; new functions at the end)
- Modify: `shared/src/index.ts` (imports and re-exports at lines 4-17, `Me` at line 20, `MessageDto` at lines 40-49, `ChatEventKind` at lines 51-55, new DTO after `RecentStickerDto` at line 60)
- Modify: `web/src/components/conversation/model.ts` (`eventText`, after `case 'contact_merged'`)
- Test: `server/test/messages/action-rules.test.ts` (import block; new `describe` at the end)
- Test: `server/test/messages/search-fold.test.ts` (create)
- Test: `web/src/components/conversation/model.test.ts` (new `describe` at the end)

**Interfaces:**
- Consumes: `ActionTarget`, `ActionBlock` (existing, `message-actions.ts`).
- Produces: everything under `shared/src/preferences.ts`, `shared/src/search.ts`, `shared/src/message-actions.ts` and `shared/src/index.ts` in the Shared contract; `eventText` for `note_deleted`.

- [ ] **Step 1: Write the failing tests**

In `server/test/messages/action-rules.test.ts`, replace

```ts
import {
  DELETE_WINDOW_MS, EDIT_WINDOW_MS, deleteBlock, editBlock, forwardBlock, isSingleEmoji, reactBlock, replyBlock,
  type ActionTarget,
} from '@talk/shared';
```

with

```ts
import {
  DELETE_WINDOW_MS, EDIT_WINDOW_MS, deleteBlock, editBlock, forwardBlock, isSingleEmoji, noteDeleteBlock, noteEditBlock,
  reactBlock, replyBlock, type ActionTarget,
} from '@talk/shared';
```

and append at the end of the file:

```ts
describe('note rules (spec 2026-10-19 §3)', () => {
  const note = (over: Partial<ActionTarget> = {}) => out({ kind: 'note', ...over });
  const notAuthor = { reason: 'Só quem escreveu a nota pode editá-la', expired: false };
  const notANote = { reason: 'Esta mensagem não é uma nota', expired: false };

  it('only the author edits a note, with no time limit', () => {
    expect(noteEditBlock(note({ sentAt: ago(30 * 24 * 3_600_000) }), 'u1')).toBeNull();
    expect(noteEditBlock(note(), 'u2')).toEqual(notAuthor);
    expect(noteEditBlock(note({ authorId: null }), null)).toEqual(notAuthor);
    expect(noteEditBlock(out(), 'u1')).toEqual(notANote);
  });

  it('the author or an admin deletes a note; nobody deletes a message that is not a note through it', () => {
    expect(noteDeleteBlock(note(), 'u1', false)).toBeNull();
    expect(noteDeleteBlock(note(), 'u2', true)).toBeNull();
    expect(noteDeleteBlock(note(), 'u2', false)).toEqual({
      reason: 'Só quem escreveu a nota ou um administrador pode apagá-la', expired: false,
    });
    expect(noteDeleteBlock(out(), 'u1', true)).toEqual(notANote);
  });
});
```

Create `server/test/messages/search-fold.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { FOLD_FROM, FOLD_TO, foldText } from '@talk/shared';

describe('foldText (spec 2026-10-19 §4)', () => {
  it('lowers the case and drops the Portuguese accents, one character for one', () => {
    expect(foldText('AÇÃO de Cobrança em São Paulo')).toBe('acao de cobranca em sao paulo');
    expect(foldText('Ñandú, ÉPOCA, über, à vista')).toBe('nandu, epoca, uber, a vista');
    const s = 'Atenção: prazo até 15/10';
    expect(foldText(s)).toHaveLength(s.length);
  });

  it('pairs every accented letter with a plain one, so SQL translate() folds the same way', () => {
    expect([...FOLD_FROM]).toHaveLength([...FOLD_TO].length);
    expect(foldText(FOLD_FROM)).toBe(FOLD_TO);
    expect(FOLD_TO).toMatch(/^[a-z]+$/);
  });
});
```

Append at the end of `web/src/components/conversation/model.test.ts`:

```ts
describe('note texts (spec 2026-10-19 §3)', () => {
  it('names who deleted a note', () => {
    const names = new Map<string, string>();
    expect(eventText(event({ kind: 'note_deleted', authorName: 'Bia' }), names)).toBe('Nota apagada por Bia');
    expect(eventText(event({ kind: 'note_deleted' }), names)).toBe('Nota apagada');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w server -- test/messages/action-rules.test.ts test/messages/search-fold.test.ts`
Expected: FAIL with `TypeError: noteEditBlock is not a function` and `TypeError: foldText is not a function`.

Run: `npm test -w web -- src/components/conversation/model.test.ts`
Expected: FAIL, `expected undefined to be 'Nota apagada por Bia'`.

- [ ] **Step 3: Create the two shared modules**

Create `shared/src/preferences.ts`:

```ts
// Personal preferences (spec 2026-10-19 §6), stored per user on the server (users.preferences jsonb).
// Runtime code with no imports: tsx (server) and Vite (web) load this source directly.

export const BROWSER_NOTIFICATION_MODES = ['always', 'background', 'never'] as const;
/** "Sempre" | "Só quando a aba está em segundo plano" | "Nunca". */
export type BrowserNotificationMode = (typeof BROWSER_NOTIFICATION_MODES)[number];

export interface UserPreferences {
  /** On: Enter sends, Shift+Enter breaks the line. Off: Enter breaks the line, Ctrl/Cmd+Enter sends. */
  enterSends: boolean;
  /** A short beep for a new contact message (never for the chat on screen in a visible tab). */
  sounds: boolean;
  browserNotifications: BrowserNotificationMode;
}

/** What a user who never changed anything gets. 'background' keeps the old message behavior. */
export const DEFAULT_PREFERENCES: Readonly<UserPreferences> = {
  enterSends: true,
  sounds: true,
  browserNotifications: 'background',
};
```

Create `shared/src/search.ts`:

```ts
// "Buscar na conversa" (spec 2026-10-19 §4): case- and accent-insensitive matching. The server folds the column with
// translate(lower(col), FOLD_FROM, FOLD_TO) and the query with foldText: one table for both sides.
// Runtime code with no imports: tsx (server) and Vite (web) load this source directly.

export const SEARCH_MIN_CHARS = 2;
export const SEARCH_MAX_CHARS = 100;
export const SEARCH_LIMIT = 50;

const LOWER = 'áàâãäåéèêëíìîïóòôõöúùûüçñý';
const UPPER = 'ÁÀÂÃÄÅÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑÝ';
const PLAIN = 'aaaaaa' + 'eeee' + 'iiii' + 'ooooo' + 'uuuu' + 'cny';
/** Upper case too: under the C locale Postgres lower() leaves accented capitals as they are. */
export const FOLD_FROM = LOWER + UPPER;
export const FOLD_TO = PLAIN + PLAIN;

const FOLD = new Map([...FOLD_FROM].map((c, i) => [c, FOLD_TO[i]!] as const));

/**
 * Lower case without accents ("Ação" → "acao"), one character for one, so an index in the fold is an index in the text.
 * ponytail: the few letters whose toLowerCase grows (e.g. "İ") shift the snippet a little; map them if anyone notices.
 */
export function foldText(s: string): string {
  return [...s.toLowerCase()].map((c) => FOLD.get(c) ?? c).join('');
}
```

- [ ] **Step 4: Add the note rules and the favorites limit**

In `shared/src/message-actions.ts`, replace

```ts
export const DELETED_REASON = 'Mensagem apagada';
```

with

```ts
export const DELETED_REASON = 'Mensagem apagada';
/** Spec 2026-10-19 §5: the "Favoritas" list of one chat shows at most this many. */
export const FAVORITES_LIMIT = 200;
```

and append at the end of the file:

```ts
const NOT_A_NOTE = 'Esta mensagem não é uma nota';

/** Spec 2026-10-19 §3: only the author edits a note, any time; nothing goes to WhatsApp. */
export function noteEditBlock(m: ActionTarget, userId: string | null): ActionBlock | null {
  if (m.kind !== 'note') return block(NOT_A_NOTE);
  if (m.authorId === null || m.authorId !== userId) return block('Só quem escreveu a nota pode editá-la');
  return null;
}

/** Spec 2026-10-19 §3: the author or an admin deletes a note for the whole team. */
export function noteDeleteBlock(m: ActionTarget, userId: string | null, isAdmin: boolean): ActionBlock | null {
  if (m.kind !== 'note') return block(NOT_A_NOTE);
  if (!isAdmin && (m.authorId === null || m.authorId !== userId)) {
    return block('Só quem escreveu a nota ou um administrador pode apagá-la');
  }
  return null;
}
```

- [ ] **Step 5: Export them and extend the DTOs**

In `shared/src/index.ts`, replace

```ts
import type { MessageChangeSource } from './message-actions.js';
```

with

```ts
import type { MessageChangeSource } from './message-actions.js';
import type { UserPreferences } from './preferences.js';
```

replace

```ts
export {
  EDIT_WINDOW_MS, DELETE_WINDOW_MS, QUICK_REACTIONS, RECENT_STICKERS_LIMIT, STICKER_MAX_BYTES, DELETED_REASON,
  reactBlock, replyBlock, editBlock, deleteBlock, forwardBlock, isSingleEmoji,
} from './message-actions.js';
export type * from './message-actions.js';
```

with

```ts
export {
  EDIT_WINDOW_MS, DELETE_WINDOW_MS, QUICK_REACTIONS, RECENT_STICKERS_LIMIT, STICKER_MAX_BYTES, DELETED_REASON, FAVORITES_LIMIT,
  reactBlock, replyBlock, editBlock, deleteBlock, forwardBlock, isSingleEmoji, noteEditBlock, noteDeleteBlock,
} from './message-actions.js';
export type * from './message-actions.js';
export { BROWSER_NOTIFICATION_MODES, DEFAULT_PREFERENCES } from './preferences.js';
export type * from './preferences.js';
export { SEARCH_MIN_CHARS, SEARCH_MAX_CHARS, SEARCH_LIMIT, FOLD_FROM, FOLD_TO, foldText } from './search.js';
```

replace

```ts
export interface Me { id: string; name: string; email: string; role: Role; signature: string | null; sectorIds: string[]; seeAllSectors: boolean; avatarUrl: string | null }
```

with

```ts
export interface Me { id: string; name: string; email: string; role: Role; signature: string | null; sectorIds: string[]; seeAllSectors: boolean; avatarUrl: string | null;
  // spec 2026-10-19 §6, optional so existing literals compile; the server always fills it (Task 5)
  preferences?: UserPreferences }
```

replace

```ts
  mediaExpired?: boolean }
```

with

```ts
  mediaExpired?: boolean;
  // the team's shared star (spec 2026-10-19 §5), optional for the same reason; toMessageDto always fills it (Task 2)
  favorite?: { at: string; byName: string | null } | null }
```

replace

```ts
  | 'history_imported' | 'contact_merged'; // data: { count } | {}
```

with

```ts
  | 'history_imported' | 'contact_merged' // data: { count } | {}
  | 'note_deleted'; // data: {} (spec 2026-10-19 §3); the event author is who deleted the note
```

and replace

```ts
export interface RecentStickerDto { messageId: string; url: string }
```

with

```ts
export interface RecentStickerDto { messageId: string; url: string }
/** GET /api/chats/:id/search (spec 2026-10-19 §4): one hit, newest first. */
export interface MessageSearchHit { messageId: string; kind: MessageDto['kind']; direction: 'in' | 'out'; snippet: string; sentAt: string }
```

- [ ] **Step 6: Add the event text**

In `web/src/components/conversation/model.ts`, replace

```ts
    case 'contact_merged':
      return 'Contato sem número juntado a este contato';
```

with

```ts
    case 'contact_merged':
      return 'Contato sem número juntado a este contato';
    case 'note_deleted':
      return `Nota apagada${by}`;
```

- [ ] **Step 7: Run the tests and the type check**

Run: `npm test -w server -- test/messages/action-rules.test.ts test/messages/search-fold.test.ts`
Expected: PASS.

Run: `npm test -w web -- src/components/conversation/model.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: exit 0 in all three workspaces.

- [ ] **Step 8: Commit**

```bash
git add shared/src/preferences.ts shared/src/search.ts shared/src/message-actions.ts shared/src/index.ts web/src/components/conversation/model.ts server/test/messages/action-rules.test.ts server/test/messages/search-fold.test.ts web/src/components/conversation/model.test.ts
git commit -m "feat(shared): note rules, accent fold, preference defaults and the new DTO fields" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 2: Database (`users.preferences`, `message_favorites`) and the DTO star

**Files:**
- Modify: `server/src/db/schema.ts` (the `@talk/shared` type import at lines 17-19, `users` at lines 25-36, new table after `messageEdits` at line 346)
- Create (generated): `server/drizzle/0006_conversa_dia_a_dia.sql`, `server/drizzle/meta/0006_snapshot.json`; modify (generated) `server/drizzle/meta/_journal.json`
- Modify: `server/src/messages/dto.ts` (schema import at line 4; a lookup and a field in `toMessageDto`)
- Test: `server/test/db/schema.test.ts`, `server/test/messages/dto.test.ts`, `server/test/realtime/hub.test.ts`

**Interfaces:**
- Consumes: Task 1 `UserPreferences`, `MessageDto.favorite`.
- Produces: `users.preferences`, `messageFavorites`; `toMessageDto` fills `favorite`.

- [ ] **Step 1: Write the failing tests**

In `server/test/db/schema.test.ts`, replace

```ts
import { botRuns, botVersions, bots, chats, contacts, historyImports, messageEdits, messages, sectors } from '../../src/db/schema.js';
```

with

```ts
import {
  botRuns, botVersions, bots, chats, contacts, historyImports, messageEdits, messageFavorites, messages, sectors,
} from '../../src/db/schema.js';
```

replace

```ts
    expect(tables).toHaveLength(23);
```

with

```ts
    expect(tables).toHaveLength(24);
```

and add, right after the `'applies the migration: every schema table and column exists'` test:

```ts
  it('message_favorites: one star per message, gone with the message; users.preferences starts empty (spec 2026-10-19)', async () => {
    const [c] = await db.insert(contacts).values({ phone: '5565999990003' }).returning({ id: contacts.id });
    const [chat] = await db
      .insert(chats)
      .values({ contactId: c!.id, channelId: s.channelId, sectorId: s.defaultSector })
      .returning({ id: chats.id });
    const [m] = await db
      .insert(messages)
      .values({ chatId: chat!.id, channelId: s.channelId, direction: 'out', kind: 'note', body: 'nota', status: 'sent', sentAt: new Date() })
      .returning({ id: messages.id });
    expect(await pgCode(db.insert(messageFavorites).values({ messageId: m!.id, userId: s.agentA.id }))).toBeNull();
    expect(await pgCode(db.insert(messageFavorites).values({ messageId: m!.id, userId: s.agentB.id }))).toBe(UNIQUE_VIOLATION);
    await db.delete(messages).where(eq(messages.id, m!.id));
    expect(await db.select().from(messageFavorites)).toEqual([]);
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, s.agentA.id));
    expect(u!.preferences).toEqual({});
  });
```

In `server/test/messages/dto.test.ts` and in `server/test/realtime/hub.test.ts`, replace (one occurrence in each file)

```ts
      officeReaction: null, deleted: null, edited: null, forwarded: false,
```

with

```ts
      officeReaction: null, deleted: null, edited: null, forwarded: false, favorite: null,
```

In `server/test/messages/dto.test.ts`, replace

```ts
import { chats, contacts, messageEdits, messages } from '../../src/db/schema.js';
```

with

```ts
import { chats, contacts, messageEdits, messageFavorites, messages } from '../../src/db/schema.js';
```

and append inside `describe('toMessageDto', …)`, after its last test:

```ts
  it('fills the shared star with who marked it (spec 2026-10-19 §5)', async () => {
    const { ctx, s, chatId } = await setup();
    const [row] = await ctx.db.insert(messages).values({
      id: randomUUID(), chatId, channelId: s.channelId, direction: 'in', kind: 'text', body: 'Prazo: 20/10',
      externalId: 'ext-fav', status: 'sent', sentAt: new Date('2026-10-19T10:00:00Z'),
    }).returning();
    expect((await toMessageDto(ctx.db, row!)).favorite).toBeNull();
    await ctx.db.insert(messageFavorites).values({ messageId: row!.id, userId: s.agentA.id, createdAt: new Date('2026-10-19T11:00:00Z') });
    expect((await toMessageDto(ctx.db, row!)).favorite).toEqual({ at: '2026-10-19T11:00:00.000Z', byName: s.agentA.name });
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w server -- test/db/schema.test.ts test/messages/dto.test.ts test/realtime/hub.test.ts`
Expected: FAIL (`messageFavorites` is undefined, 23 tables instead of 24, `favorite` missing from the DTO).

- [ ] **Step 3: Add the column and the table**

In `server/src/db/schema.ts`, replace

```ts
import type {
  BotGraph, BotRunState, BotRunStep, BotRunVars, ChatEventKind, HistoryImportState, HistoryPeriod, MessageChangeSource,
} from '@talk/shared';
```

with

```ts
import type {
  BotGraph, BotRunState, BotRunStep, BotRunVars, ChatEventKind, HistoryImportState, HistoryPeriod, MessageChangeSource,
  UserPreferences,
} from '@talk/shared';
```

replace

```ts
  avatarPath: text('avatar_path'),
  createdAt: createdAt(),
});

export const sessions = pgTable('sessions', {
```

with

```ts
  avatarPath: text('avatar_path'),
  createdAt: createdAt(),
  // Spec 2026-10-19 §6: only what the user changed; readPreferences (auth/preferences.ts) fills in the defaults.
  preferences: jsonb('preferences').$type<Partial<UserPreferences>>().notNull().default({}),
});

export const sessions = pgTable('sessions', {
```

and after the closing `);` of `messageEdits` add:

```ts
/** Spec 2026-10-19 §5: the team's shared star. The primary key makes it one star per message; the first who marks it stays. */
export const messageFavorites = pgTable('message_favorites', {
  messageId: uuid('message_id').primaryKey().references(() => messages.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
});
```

- [ ] **Step 4: Generate the migration**

Run: `npm run db:generate -w server -- --name conversa_dia_a_dia`
Expected: `server/drizzle/0006_conversa_dia_a_dia.sql` with exactly a `CREATE TABLE "message_favorites"` (`message_id` uuid primary key, `user_id` uuid, `created_at` timestamptz default now() not null), `ALTER TABLE "users" ADD COLUMN "preferences" jsonb DEFAULT '{}'::jsonb NOT NULL` and the two foreign keys (`ON DELETE cascade` to messages, `ON DELETE set null` to users). Anything else in the file means the schema drifted from `0005`: stop and report it. Never edit the generated SQL.

- [ ] **Step 5: Fill the star in the DTO**

In `server/src/messages/dto.ts`, replace

```ts
import { botRuns, bots, messageEdits, messages, users } from '../db/schema.js';
```

with

```ts
import { botRuns, bots, messageEdits, messageFavorites, messages, users } from '../db/schema.js';
```

replace

```ts
        .orderBy(desc(messageEdits.editedAt))
        .limit(1)
    : [];
```

with

```ts
        .orderBy(desc(messageEdits.editedAt))
        .limit(1)
    : [];
  // ponytail: one primary-key lookup per message; join it into the timeline query if a page of 100 ever gets slow.
  const [favorite] = await db
    .select({ at: messageFavorites.createdAt, byName: users.name })
    .from(messageFavorites)
    .leftJoin(users, eq(users.id, messageFavorites.userId))
    .where(eq(messageFavorites.messageId, row.id));
```

and replace

```ts
    forwarded: row.forwardedFromId !== null,
  };
```

with

```ts
    forwarded: row.forwardedFromId !== null,
    favorite: favorite ? { at: favorite.at.toISOString(), byName: favorite.byName ?? null } : null,
  };
```

- [ ] **Step 6: Run the tests and the type check**

Run: `npm test -w server -- test/db/schema.test.ts test/messages/dto.test.ts test/realtime/hub.test.ts`
Expected: PASS.

Run: `npm test -w server`
Expected: PASS. A failure that only misses `favorite: null` in a full-DTO `toEqual` gets that field added; anything else is a real regression.

Run: `npm run typecheck -w server`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add server/src/db/schema.ts server/drizzle/0006_conversa_dia_a_dia.sql server/drizzle/meta/0006_snapshot.json server/drizzle/meta/_journal.json server/src/messages/dto.ts server/test/db/schema.test.ts server/test/messages/dto.test.ts server/test/realtime/hub.test.ts
git commit -m "feat(server): message_favorites table, users.preferences and the star in the message DTO" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 3: Edit and delete notes; star messages (API)

**Files:**
- Modify: `server/src/messages/actions.ts` (import block at lines 4-10, `editMessage`, new functions at the end)
- Modify: `server/src/chats/routes.ts` (the actions import at lines 15-17; new routes after the forward route)
- Test: `server/test/messages/notes-favorites.test.ts` (create)

**Interfaces:**
- Consumes: Task 1 `noteEditBlock`, `noteDeleteBlock`, `FAVORITES_LIMIT`, `ChatEventKind` `note_deleted`; Task 2 `messageFavorites`, `toMessageDto` with `favorite`. Existing: `loadTarget`, `refuse`, `asTarget`, `viaWhatsApp`, `rollbackQuietly`, `addEvent`, `getChatForUser`, `setupActions`, `seedMsg`, `enableSeeAll`, `eventsOf`.
- Produces: `deleteNote`, `setFavorite`, `listFavorites`; `editMessage` for notes; the routes `DELETE /api/notes/:id`, `PUT|DELETE /api/messages/:id/favorite`, `GET /api/chats/:id/favorites`.

- [ ] **Step 1: Write the failing tests**

Create `server/test/messages/notes-favorites.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chats, messageEdits, messageFavorites, messages, userSectors } from '../../src/db/schema.js';
import { enableSeeAll, loginAs } from '../helpers.js';
import { eventsOf } from '../inbox/fixtures.js';
import { seedMsg, setupActions, type ActionsWorld } from './actions-seed.js';

let w: ActionsWorld;
beforeEach(async () => {
  w = await setupActions();
});
afterEach(async () => {
  await w.app.close();
});

const call = (method: 'GET' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object, headers = w.headers) =>
  w.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
const note = (extra: Partial<typeof messages.$inferInsert> = {}) =>
  seedMsg(w, { kind: 'note', externalId: null, body: 'Cliente pede retorno', ...extra });
const row = async (id: string) => (await w.ctx.db.select().from(messages).where(eq(messages.id, id)))[0];
const eventsOfKind = async (kind: string) => (await eventsOf(w.ctx, w.chatId)).filter((e) => e.kind === kind);
const closeChat = () => w.ctx.db.update(chats).set({ state: 'closed', closedAt: new Date() }).where(eq(chats.id, w.chatId));
/** Bruno (agentB) is not in sector A: he cannot see the chat. */
const outsider = async () => (await loginAs(w.app, w.s.agentB.email)).headers;
/** Bruno joins sector A: he sees the chat but wrote nothing in it. */
const brunoInSectorA = async () => {
  await w.ctx.db.insert(userSectors).values({ userId: w.s.agentB.id, sectorId: w.s.sectorA });
  return (await loginAs(w.app, w.s.agentB.email)).headers;
};
const adminSeeingAll = async () => {
  await enableSeeAll(w.ctx, w.s.admin);
  return (await loginAs(w.app, w.s.admin.email)).headers;
};

describe('PATCH /api/messages/:id on a note (spec 2026-10-19 §3)', () => {
  it('the author edits a note: new text, the old one in the history, no WhatsApp call and no timeline event (Review Focus 4)', async () => {
    const id = await note();

    const res = await call('PATCH', `/api/messages/${id}`, { text: 'Cliente pede retorno amanhã' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      kind: 'note', body: 'Cliente pede retorno amanhã', edited: { source: 'office', newTextUnavailable: false },
    });
    expect((await call('GET', `/api/messages/${id}/edits`)).json()).toMatchObject([
      { previousBody: 'Cliente pede retorno', source: 'office', editedByName: w.s.agentA.name },
    ]);
    expect(w.ctx.wa.sent).toEqual([]);
    expect(await eventsOfKind('message_edited')).toEqual([]);
    expect(w.ctx.hub.events).toContainEqual({ type: 'message.updated', chatId: w.chatId, messageId: id });
  });

  it('nobody else edits it, not even an admin; a hidden chat is 404 and a closed chat 409', async () => {
    const id = await note();
    expect((await call('PATCH', `/api/messages/${id}`, { text: 'x' }, await outsider())).statusCode).toBe(404);
    for (const headers of [await brunoInSectorA(), await adminSeeingAll()]) {
      const res = await call('PATCH', `/api/messages/${id}`, { text: 'outro texto' }, headers);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'Só quem escreveu a nota pode editá-la' });
    }
    await closeChat();
    expect((await call('PATCH', `/api/messages/${id}`, { text: 'tarde' })).json()).toEqual({ error: 'Conversa finalizada' });
    expect((await row(id))!.body).toBe('Cliente pede retorno');
    expect(await w.ctx.db.select().from(messageEdits)).toEqual([]);
  });
});

describe('DELETE /api/notes/:id (spec 2026-10-19 §3)', () => {
  it('the author deletes a note: the row, its history and its star go; the timeline says who did it', async () => {
    const id = await note();
    await call('PATCH', `/api/messages/${id}`, { text: 'Cliente pede retorno amanhã' });
    await call('PUT', `/api/messages/${id}/favorite`);

    const res = await call('DELETE', `/api/notes/${id}`);

    expect(res.statusCode).toBe(204);
    expect(await row(id)).toBeUndefined();
    expect(await w.ctx.db.select().from(messageEdits)).toEqual([]);
    expect(await w.ctx.db.select().from(messageFavorites)).toEqual([]);
    expect(await eventsOfKind('note_deleted')).toMatchObject([{ authorId: w.s.agentA.id, data: {} }]);
    expect(w.ctx.hub.events).toContainEqual({ type: 'chat', chatId: w.chatId });
    expect(w.ctx.wa.sent).toEqual([]);
    expect((await call('DELETE', `/api/notes/${id}`)).statusCode).toBe(404); // a second click
  });

  it("an admin deletes anyone's note; another agent who sees the chat does not (Review Focus 3)", async () => {
    const id = await note();
    const refused = await call('DELETE', `/api/notes/${id}`, undefined, await brunoInSectorA());
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: 'Só quem escreveu a nota ou um administrador pode apagá-la' });
    expect(await row(id)).toBeDefined();
    expect((await call('DELETE', `/api/notes/${id}`, undefined, await adminSeeingAll())).statusCode).toBe(204);
    expect(await eventsOfKind('note_deleted')).toMatchObject([{ authorId: w.s.admin.id }]);
  });

  it('never removes a message that is not a note, and refuses in a closed chat (Review Focus 3)', async () => {
    const text = await seedMsg(w);
    const res = await call('DELETE', `/api/notes/${text}`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'Esta mensagem não é uma nota' });
    expect(await row(text)).toBeDefined();

    const id = await note();
    await closeChat();
    expect((await call('DELETE', `/api/notes/${id}`)).json()).toEqual({ error: 'Conversa finalizada' });
    expect(await row(id)).toBeDefined();
    expect(await eventsOfKind('note_deleted')).toEqual([]);
  });
});

describe('favorites (spec 2026-10-19 §5)', () => {
  const star = (id: string, headers = w.headers) => call('PUT', `/api/messages/${id}/favorite`, undefined, headers);
  const unstar = (id: string, headers = w.headers) => call('DELETE', `/api/messages/${id}/favorite`, undefined, headers);
  const list = async (headers = w.headers) => {
    const res = await call('GET', `/api/chats/${w.chatId}/favorites`, undefined, headers);
    expect(res.statusCode).toBe(200);
    return res.json() as Array<{ id: string; favorite: unknown }>;
  };

  it('one shared star per message: the first who marks it keeps the name; anyone who sees the chat removes it', async () => {
    const id = await seedMsg(w, { direction: 'in', authorId: null, body: 'Prazo dia 20' });

    const res = await star(id);

    expect(res.statusCode).toBe(200);
    expect(res.json().favorite).toMatchObject({ byName: w.s.agentA.name });
    const bruno = await brunoInSectorA();
    expect((await star(id, bruno)).json().favorite).toMatchObject({ byName: w.s.agentA.name });
    expect((await list(bruno)).map((m) => m.id)).toEqual([id]);
    expect((await unstar(id, bruno)).json().favorite).toBeNull();
    expect(await list()).toEqual([]);
    expect(w.ctx.hub.events.filter((e) => e.type === 'message.updated' && e.messageId === id)).toHaveLength(3);
    expect(w.ctx.wa.sent).toEqual([]);
  });

  it('lists the newest star first; a message deleted for everyone and a closed chat count', async () => {
    const older = await seedMsg(w, { direction: 'in', authorId: null, deletedAt: new Date(), deletedSource: 'contact' });
    const newer = await seedMsg(w);
    await star(older);
    await star(newer);
    await closeChat();
    const last = await seedMsg(w);
    expect((await star(last)).statusCode).toBe(200);
    expect((await list()).map((m) => m.id)).toEqual([last, newer, older]);
  });

  it('404 for a hidden chat or an unknown message, in every route (Review Focus 6)', async () => {
    const id = await seedMsg(w);
    const bruno = await outsider();
    expect((await star(id, bruno)).statusCode).toBe(404);
    expect((await unstar(id, bruno)).statusCode).toBe(404);
    expect((await call('GET', `/api/chats/${w.chatId}/favorites`, undefined, bruno)).statusCode).toBe(404);
    expect((await star(randomUUID())).statusCode).toBe(404);
    expect(await w.ctx.db.select().from(messageFavorites)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w server -- test/messages/notes-favorites.test.ts`
Expected: FAIL: the note PATCH answers 409 `Só dá para editar mensagens enviadas por você`; the other routes answer 404 `Route DELETE:/api/notes/… not found` and `Route PUT:/api/messages/…/favorite not found`.

- [ ] **Step 3: Accept notes in `editMessage` and add the new functions**

In `server/src/messages/actions.ts`, replace

```ts
import {
  DELETED_REASON, RECENT_STICKERS_LIMIT, deleteBlock, editBlock, isSingleEmoji, reactBlock,
  type ActionBlock, type BotAction, type MessageDto, type MessageEditDto, type RecentStickerDto,
} from '@talk/shared';
import type { AppCtx } from '../ctx.js';
import { chats, messageEdits, messages, users } from '../db/schema.js';
```

with

```ts
import {
  DELETED_REASON, FAVORITES_LIMIT, RECENT_STICKERS_LIMIT, deleteBlock, editBlock, isSingleEmoji, noteDeleteBlock, noteEditBlock,
  reactBlock, type ActionBlock, type BotAction, type MessageDto, type MessageEditDto, type RecentStickerDto,
} from '@talk/shared';
import type { AppCtx } from '../ctx.js';
import { chats, messageEdits, messageFavorites, messages, users } from '../db/schema.js';
```

replace

```ts
export async function editMessage(ctx: AppCtx, user: AuthUser, messageId: string, text: string): Promise<MessageDto> {
  const { msg, chat } = await loadTarget(ctx, user, messageId);
  refuse(editBlock(asTarget(msg), user.id, Date.now()));
```

with

```ts
export async function editMessage(ctx: AppCtx, user: AuthUser, messageId: string, text: string): Promise<MessageDto> {
  const { msg, chat } = await loadTarget(ctx, user, messageId);
  // Spec 2026-10-19 §3: a note is edited by its author, any time, with the same history; it never reaches WhatsApp
  // and adds no timeline event ("Mensagem editada" would be wrong for a note).
  const isNote = msg.kind === 'note';
  refuse(isNote ? noteEditBlock(msg, user.id) : editBlock(asTarget(msg), user.id, Date.now()));
```

replace

```ts
  try {
    await viaWhatsApp('edit', msg.id, async () => {
      const { instance, key } = await keyOf(ctx, msg);
      await ctx.wa.editText(instance, { ...key, fromMe: true }, text);
    });
  } catch (err) {
    await rollbackQuietly(msg.id, () =>
      ctx.db.transaction(async (tx) => {
        await tx.delete(messageEdits).where(eq(messageEdits.id, edit.id));
        await tx.update(messages).set({ body: msg.body, editedAt: msg.editedAt }).where(eq(messages.id, msg.id));
      }),
    );
    throw err;
  }
  // ponytail: chats.last_message_preview keeps the old text when the last message is edited; refresh it if anyone notices.
  await addEvent(ctx.db, chat.id, 'message_edited', { messageId: msg.id, source: 'office' }, user.id);
  await ctx.hub.publishMessage(chat.id, 'message.updated', msg.id);
  await ctx.hub.publishChat(chat.id);
```

with

```ts
  if (!isNote) {
    try {
      await viaWhatsApp('edit', msg.id, async () => {
        const { instance, key } = await keyOf(ctx, msg);
        await ctx.wa.editText(instance, { ...key, fromMe: true }, text);
      });
    } catch (err) {
      await rollbackQuietly(msg.id, () =>
        ctx.db.transaction(async (tx) => {
          await tx.delete(messageEdits).where(eq(messageEdits.id, edit.id));
          await tx.update(messages).set({ body: msg.body, editedAt: msg.editedAt }).where(eq(messages.id, msg.id));
        }),
      );
      throw err;
    }
    // ponytail: chats.last_message_preview keeps the old text when the last message is edited; refresh it if anyone notices.
    await addEvent(ctx.db, chat.id, 'message_edited', { messageId: msg.id, source: 'office' }, user.id);
  }
  await ctx.hub.publishMessage(chat.id, 'message.updated', msg.id);
  if (!isNote) await ctx.hub.publishChat(chat.id); // the timeline shows the new event
```

and append at the end of the file:

```ts
/**
 * Spec 2026-10-19 §3: the author or an admin removes a note for the whole team (its history and star go with it, by
 * cascade). The timeline keeps "Nota apagada por <nome>"; the event carries no text.
 */
export async function deleteNote(ctx: AppCtx, user: AuthUser, messageId: string): Promise<void> {
  const { msg, chat } = await loadTarget(ctx, user, messageId);
  refuse(noteDeleteBlock(msg, user.id, user.role === 'admin'));
  await ctx.db.transaction(async (tx) => {
    // kind = 'note' again in the WHERE: whatever slips past the rule, this route never removes a WhatsApp message.
    const [gone] = await tx
      .delete(messages)
      .where(and(eq(messages.id, msg.id), eq(messages.kind, 'note')))
      .returning({ id: messages.id });
    if (!gone) throw notFound(); // another tab removed it first
    await addEvent(tx, chat.id, 'note_deleted', {}, user.id);
  });
  // There is no message event for a row that is gone: chat.updated makes every open timeline refetch.
  await ctx.hub.publishChat(chat.id);
}

/**
 * Spec 2026-10-19 §5: the team's shared star. Anyone who sees the chat marks or unmarks it, in any chat state; marking
 * an already starred message keeps who marked it first.
 */
export async function setFavorite(ctx: AppCtx, user: AuthUser, messageId: string, on: boolean): Promise<MessageDto> {
  const [msg] = await ctx.db.select().from(messages).where(eq(messages.id, messageId));
  if (!msg) throw notFound();
  await getChatForUser(ctx, user, msg.chatId);
  if (on) await ctx.db.insert(messageFavorites).values({ messageId: msg.id, userId: user.id }).onConflictDoNothing();
  else await ctx.db.delete(messageFavorites).where(eq(messageFavorites.messageId, msg.id));
  await ctx.hub.publishMessage(msg.chatId, 'message.updated', msg.id);
  return toMessageDto(ctx.db, msg);
}

/** GET /api/chats/:id/favorites: the chat's starred messages, newest star first. */
export async function listFavorites(ctx: AppCtx, user: AuthUser, chatId: string): Promise<MessageDto[]> {
  await getChatForUser(ctx, user, chatId);
  const rows = await ctx.db
    .select({ msg: messages })
    .from(messageFavorites)
    .innerJoin(messages, eq(messages.id, messageFavorites.messageId))
    .where(eq(messages.chatId, chatId))
    .orderBy(desc(messageFavorites.createdAt), desc(messageFavorites.messageId))
    .limit(FAVORITES_LIMIT);
  return Promise.all(rows.map((r) => toMessageDto(ctx.db, r.msg)));
}
```

- [ ] **Step 4: Add the routes**

In `server/src/chats/routes.ts`, replace

```ts
import {
  deleteMessageForEveryone, editMessage, forwardMessage, listMessageEdits, listRecentStickers, reactToMessage,
} from '../messages/actions.js';
```

with

```ts
import {
  deleteMessageForEveryone, deleteNote, editMessage, forwardMessage, listFavorites, listMessageEdits, listRecentStickers,
  reactToMessage, setFavorite,
} from '../messages/actions.js';
```

and replace

```ts
    r.post('/api/messages/:id/forward', async (req) =>
      forwardMessage(ctx, req.user, idParams.parse(req.params).id, forwardBody.parse(req.body)),
    );
```

with

```ts
    r.post('/api/messages/:id/forward', async (req) =>
      forwardMessage(ctx, req.user, idParams.parse(req.params).id, forwardBody.parse(req.body)),
    );

    // Spec 2026-10-19 §3: a note leaves the chat for everyone. Editing it is the PATCH above.
    r.delete('/api/notes/:id', async (req, reply) => {
      await deleteNote(ctx, req.user, idParams.parse(req.params).id);
      return reply.code(204).send();
    });

    // Spec 2026-10-19 §5: the shared star.
    r.put('/api/messages/:id/favorite', async (req) => setFavorite(ctx, req.user, idParams.parse(req.params).id, true));
    r.delete('/api/messages/:id/favorite', async (req) => setFavorite(ctx, req.user, idParams.parse(req.params).id, false));
    r.get('/api/chats/:id/favorites', async (req) => listFavorites(ctx, req.user, idParams.parse(req.params).id));
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w server -- test/messages/notes-favorites.test.ts test/messages/actions.test.ts`
Expected: PASS (`actions.test.ts` unchanged: the office edit still calls `editText`, Review Focus 4).

Run: `npm run typecheck -w server`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add server/src/messages/actions.ts server/src/chats/routes.ts server/test/messages/notes-favorites.test.ts
git commit -m "feat(server): edit and delete internal notes, and the team's shared message star" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 4: Search one chat; timeline `after` and `around` cursors (API)

**Files:**
- Modify: `server/src/inbox/queries.ts` (imports at lines 1-3; `getTimeline` at lines 168-241 replaced; new functions at the end)
- Modify: `server/src/chats/routes.ts` (imports; `timelineQuery` at lines 34-37; a new route after the timeline route)
- Test: `server/test/chats/search.test.ts` (create)
- Test: `server/test/chats/list-and-timeline.test.ts` (new `describe` at the end)

**Interfaces:**
- Consumes: Task 1 `foldText`, `FOLD_FROM`, `FOLD_TO`, `SEARCH_LIMIT`, `SEARCH_MIN_CHARS`, `SEARCH_MAX_CHARS`, `MessageSearchHit`. Existing: `escapeLike`, `clampLimit`, `toMessageDto`, `getChatForUser`, `seedChat`, `seedMessage`, `seedEvent`.
- Produces: `getTimeline` with `after`/`around`, `searchChat`, `snippetOf`, `GET /api/chats/:id/search`.

- [ ] **Step 1: Write the failing tests**

Create `server/test/chats/search.test.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SEARCH_LIMIT, type MessageSearchHit } from '@talk/shared';
import { loginAs, makeTestApp, makeTestCtx, seedBasics } from '../helpers.js';
import { seedChat, seedMessage } from './seed.js';

let app: FastifyInstance;
let ctx: Awaited<ReturnType<typeof makeTestCtx>>;
let s: Awaited<ReturnType<typeof seedBasics>>;
let chatId: string;
let headers: Record<string, string>;

beforeEach(async () => {
  ctx = await makeTestCtx();
  s = await seedBasics(ctx);
  ({ app } = await makeTestApp(ctx));
  ({ chatId } = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA }));
  ({ headers } = await loginAs(app, s.agentA.email));
});
afterEach(async () => {
  await app.close();
});

const t = (min: number) => new Date(Date.UTC(2026, 9, 18, 12, min));
const msg = (min: number, extra: Parameters<typeof seedMessage>[4]) => seedMessage(ctx, chatId, s.channelId, t(min), extra);
const search = (q: string, h = headers) =>
  app.inject({ method: 'GET', url: `/api/chats/${chatId}/search?q=${encodeURIComponent(q)}`, headers: h });
async function hits(q: string): Promise<MessageSearchHit[]> {
  const res = await search(q);
  expect(res.statusCode).toBe(200);
  return res.json();
}
const ids = async (q: string) => (await hits(q)).map((h) => h.messageId);

describe('GET /api/chats/:id/search (spec 2026-10-19 §4)', () => {
  it('finds texts, captions, notes and file names of this chat only, newest first', async () => {
    const text = await msg(1, { body: 'Segue o contrato de honorários' });
    const caption = await msg(2, { kind: 'image', body: 'Foto do contrato assinado', mediaPath: '2026/10/a.jpg', mediaMime: 'image/jpeg' });
    const note = await msg(3, { direction: 'out', kind: 'note', body: 'Conferir CONTRATO amanhã', authorId: s.agentA.id, status: 'sent' });
    const file = await msg(4, {
      kind: 'document', body: null, mediaName: 'Contrato-Final.pdf', mediaPath: '2026/10/b.pdf', mediaMime: 'application/pdf',
    });
    await msg(5, { body: 'nada a ver' });
    const other = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA });
    await seedMessage(ctx, other.chatId, s.channelId, t(6), { body: 'outro contrato' });

    const found = await hits('contrato');

    expect(found.map((h) => h.messageId)).toEqual([file, note, caption, text]);
    expect(found[0]).toEqual({ messageId: file, kind: 'document', direction: 'in', snippet: 'Contrato-Final.pdf', sentAt: t(4).toISOString() });
    expect(found[1]).toMatchObject({ kind: 'note', direction: 'out', snippet: 'Conferir CONTRATO amanhã' });
  });

  it('folds case and accents, and treats % and _ as plain text (Review Focus 2)', async () => {
    const accents = await msg(1, { body: 'AÇÃO de cobrança: São Paulo' });
    const percent = await msg(2, { body: 'Desconto de 10% no boleto' });
    await msg(3, { body: 'Desconto de 100 reais' });
    const under = await msg(4, { body: 'arquivo processo_123' });
    await msg(5, { body: 'processo 1234' });

    expect(await ids('acao')).toEqual([accents]);
    expect(await ids('COBRANCA')).toEqual([accents]);
    expect(await ids('são paulo')).toEqual([accents]);
    expect(await ids('0%')).toEqual([percent]);
    expect(await ids('o_1')).toEqual([under]);
  });

  it('cuts a long text around the match and keeps the newest 50', async () => {
    await msg(0, { body: `${'a'.repeat(100)} prazo final ${'b'.repeat(200)}` });
    expect((await hits('prazo final'))[0]!.snippet).toBe(`…${'a'.repeat(39)} prazo final ${'b'.repeat(79)}…`);

    for (let i = 1; i <= 55; i++) await msg(i, { body: `prazo ${i}` });
    const many = await hits('prazo');
    expect(many).toHaveLength(SEARCH_LIMIT);
    expect(many[0]!.snippet).toBe('prazo 55');
  });

  it('404 for a chat the user cannot see; 400 under 2 characters; 401 without a session (Review Focus 6)', async () => {
    await msg(1, { body: 'contrato' });
    const bruno = await loginAs(app, s.agentB.email);
    expect((await search('contrato', bruno.headers)).statusCode).toBe(404);
    expect((await search('a')).statusCode).toBe(400);
    expect((await search(' a ')).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/api/chats/${chatId}/search?q=contrato` })).statusCode).toBe(401);
  });
});
```

Append at the end of `server/test/chats/list-and-timeline.test.ts`:

```ts
describe('GET /api/chats/:id/timeline around and after (spec 2026-10-19 §4)', () => {
  it('loads the page around a message and pages newer with after=<newest id> (Review Focus 1)', async () => {
    const chat = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA });
    const m: string[] = [];
    for (let i = 0; i < 7; i++) m.push(await seedMessage(ctx, chat.chatId, s.channelId, t(i)));
    const ev = await seedEvent(ctx, chat.chatId, 'assigned', new Date(t(3).getTime() + 30_000));
    const { headers } = await loginAs(app, s.agentA.email);
    const get = async (q: string) => {
      const res = await app.inject({ method: 'GET', url: `/api/chats/${chat.chatId}/timeline${q}`, headers });
      expect(res.statusCode).toBe(200);
      return (res.json() as TimelineItem[]).map((i) => i.id);
    };

    expect(await get(`?around=${m[3]}&limit=4`)).toEqual([m[1], m[2], m[3], ev, m[4]]);
    expect(await get(`?around=${m[0]}&limit=4`)).toEqual([m[0], m[1], m[2]]);
    expect(await get(`?after=${m[4]}&limit=2`)).toEqual([m[5], m[6]]);
    expect(await get(`?after=${ev}&limit=10`)).toEqual([m[4], m[5], m[6]]);
    expect(await get(`?after=${m[6]}`)).toEqual([]);
    expect(await get('?limit=3')).toEqual([m[4], m[5], m[6]]); // no cursor: the newest, as before
  });

  it('refuses an around that is an event or another chat message, and two cursors at once', async () => {
    const chat = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA });
    const mine = await seedMessage(ctx, chat.chatId, s.channelId, t(1));
    const ev = await seedEvent(ctx, chat.chatId, 'created', t(0));
    const other = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA });
    const theirs = await seedMessage(ctx, other.chatId, s.channelId, t(2));
    const { headers } = await loginAs(app, s.agentA.email);
    const status = async (q: string, h = headers) =>
      (await app.inject({ method: 'GET', url: `/api/chats/${chat.chatId}/timeline${q}`, headers: h })).statusCode;

    expect(await status(`?around=${ev}`)).toBe(400);
    expect(await status(`?around=${theirs}`)).toBe(400);
    expect(await status(`?before=${mine}&after=${mine}`)).toBe(400);
    expect(await status(`?around=${mine}&before=${mine}`)).toBe(400);
    const bruno = await loginAs(app, s.agentB.email);
    expect(await status(`?around=${mine}`, bruno.headers)).toBe(404);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w server -- test/chats/search.test.ts test/chats/list-and-timeline.test.ts`
Expected: FAIL: the search route is 404 `Route GET:/api/chats/…/search not found`; `around`/`after` are ignored (the newest page comes back) and two cursors are not refused.

- [ ] **Step 3: Rewrite `getTimeline` with three cursors and add the search**

In `server/src/inbox/queries.ts`, replace

```ts
import { and, asc, desc, eq, gte, ilike, inArray, isNull, like, lte, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { ChatDetail, ChatListFilters, ChatListItem, TimelineItem } from '@talk/shared';
```

with

```ts
import {
  and, asc, desc, eq, gte, ilike, inArray, isNull, like, lte, notInArray, or, sql, type AnyColumn, type SQL,
} from 'drizzle-orm';
import { z } from 'zod';
import { FOLD_FROM, FOLD_TO, SEARCH_LIMIT, foldText } from '@talk/shared';
import type { ChatDetail, ChatListFilters, ChatListItem, MessageSearchHit, TimelineItem } from '@talk/shared';
```

Replace the whole `getTimeline` function (from `export async function getTimeline(` to the end of the file) with:

```ts
type TimelineEntry = { t: number; c: number; id: string; build: () => Promise<TimelineItem> };
/** A position in the timeline: (time, createdAt) as Postgres text, so microseconds survive the round trip. */
type TimelineKey = { at: string; created: string; id: string };

const messageEntry = (db: Db | Tx, row: typeof messages.$inferSelect): TimelineEntry => ({
  t: row.sentAt.getTime(),
  c: row.createdAt.getTime(),
  id: row.id,
  build: async () => ({ type: 'message', ...(await toMessageDto(db, row)) }),
});

/** The key of a message or event of this chat; 400 when the id is not in it. */
async function timelineKey(db: Db | Tx, chatId: string, id: string): Promise<TimelineKey> {
  const [m] = await db
    .select({ t: sql<string>`${messages.sentAt}::text`, c: sql<string>`${messages.createdAt}::text` })
    .from(messages)
    .where(and(eq(messages.id, id), eq(messages.chatId, chatId)));
  const [e] = m
    ? []
    : await db
        .select({ t: sql<string>`${chatEvents.createdAt}::text` })
        .from(chatEvents)
        .where(and(eq(chatEvents.id, id), eq(chatEvents.chatId, chatId)));
  const at = m?.t ?? e?.t;
  if (!at) throw badRequest('Cursor inválido');
  return { at, created: m?.c ?? at, id };
}

/**
 * Up to `limit` items strictly older ('before') or newer ('after') than `key` — the newest ones without a key —
 * ascending. Timeline order is (time, createdAt, id): sentAt has 1 s resolution on inbound bursts, createdAt keeps
 * arrival order.
 */
async function timelinePage(
  db: Db | Tx,
  chatId: string,
  dir: 'before' | 'after',
  key: TimelineKey | null,
  limit: number,
): Promise<TimelineEntry[]> {
  if (limit === 0) return [];
  const older = dir === 'before';
  const order = older ? desc : asc;
  const k = key && sql`(${key.at}::timestamptz, ${key.created}::timestamptz, ${key.id}::uuid)`;
  const side = (cols: SQL) => (k ? (older ? sql`${cols} < ${k}` : sql`${cols} > ${k}`) : undefined);

  const msgRows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.chatId, chatId), side(sql`(${messages.sentAt}, ${messages.createdAt}, ${messages.id})`)))
    .orderBy(order(messages.sentAt), order(messages.createdAt), order(messages.id))
    .limit(limit);
  const evRows = await db
    .select({ ev: chatEvents, authorName: users.name })
    .from(chatEvents)
    .leftJoin(users, eq(users.id, chatEvents.authorId))
    .where(and(eq(chatEvents.chatId, chatId), side(sql`(${chatEvents.createdAt}, ${chatEvents.createdAt}, ${chatEvents.id})`)))
    .orderBy(order(chatEvents.createdAt), order(chatEvents.id))
    .limit(limit);

  const entries: TimelineEntry[] = [
    ...msgRows.map((row) => messageEntry(db, row)),
    ...evRows.map(({ ev, authorName }) => ({
      t: ev.createdAt.getTime(),
      c: ev.createdAt.getTime(),
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
  // Same (time, createdAt, id) order as the SQL, ascending; keep the `limit` nearest to the key.
  // ponytail: compares at ms, Postgres at µs; only rows inserted within the same ms can disagree. Fetch µs keys if that ever shows.
  entries.sort((a, b) => a.t - b.t || a.c - b.c || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return older ? entries.slice(-limit) : entries.slice(0, limit);
}

export async function getTimeline(
  ctx: AppCtx,
  user: AuthUser,
  chatId: string,
  q: { before?: string; after?: string; around?: string; limit?: number },
): Promise<TimelineItem[]> {
  await getChatForUser(ctx, user, chatId);
  const db = ctx.db;
  const limit = clampLimit(q.limit);
  let entries: TimelineEntry[];
  if (q.around) {
    // Spec 2026-10-19 §4 "ir até a mensagem": half a page on each side of one message of this chat; the web pages on
    // with before=<oldest id> and after=<newest id>.
    const [row] = await db.select().from(messages).where(and(eq(messages.id, q.around), eq(messages.chatId, chatId)));
    if (!row) throw badRequest('Cursor inválido');
    const key = await timelineKey(db, chatId, row.id);
    const half = Math.floor(limit / 2);
    entries = [
      ...(await timelinePage(db, chatId, 'before', key, half)),
      messageEntry(db, row),
      ...(await timelinePage(db, chatId, 'after', key, half)),
    ];
  } else if (q.after) {
    entries = await timelinePage(db, chatId, 'after', await timelineKey(db, chatId, q.after), limit);
  } else {
    entries = await timelinePage(db, chatId, 'before', q.before ? await timelineKey(db, chatId, q.before) : null, limit);
  }
  return Promise.all(entries.map((e) => e.build()));
}

const SNIPPET_BEFORE = 40;
const SNIPPET_AFTER = 80;

/** The SQL side of foldText: same table, so "AÇÃO" and "acao" meet. coalesce: a null column never matches. */
const folded = (col: AnyColumn) => sql`translate(lower(coalesce(${col}, '')), ${FOLD_FROM}, ${FOLD_TO})`;

/**
 * Spec 2026-10-19 §4: texts, captions, notes and file names of this chat that contain `q`, ignoring case and accents,
 * newest first, at most SEARCH_LIMIT. `%`, `_` and `\` in `q` are plain text.
 */
export async function searchChat(ctx: AppCtx, user: AuthUser, chatId: string, q: string): Promise<MessageSearchHit[]> {
  await getChatForUser(ctx, user, chatId);
  const needle = foldText(q.trim());
  const pattern = `%${escapeLike(needle)}%`;
  // ponytail: scans one chat's rows (messages_chat_sent_idx narrows to the chat); add a trigram index if a chat reaches 100k.
  const rows = await ctx.db
    .select({
      id: messages.id,
      kind: messages.kind,
      direction: messages.direction,
      body: messages.body,
      mediaName: messages.mediaName,
      sentAt: messages.sentAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.chatId, chatId),
        or(sql`${folded(messages.body)} like ${pattern}`, sql`${folded(messages.mediaName)} like ${pattern}`),
      ),
    )
    .orderBy(desc(messages.sentAt), desc(messages.createdAt), desc(messages.id))
    .limit(SEARCH_LIMIT);
  return rows.map((r) => ({
    messageId: r.id,
    kind: r.kind,
    direction: r.direction,
    sentAt: r.sentAt.toISOString(),
    snippet: snippetOf(r.body && foldText(r.body).includes(needle) ? r.body : (r.mediaName ?? ''), needle),
  }));
}

/** One line: up to SNIPPET_BEFORE characters before the match and SNIPPET_AFTER after it, "…" where it cuts. */
export function snippetOf(text: string, needle: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const at = Math.max(0, foldText(flat).indexOf(needle));
  const start = Math.max(0, at - SNIPPET_BEFORE);
  const end = Math.min(flat.length, at + needle.length + SNIPPET_AFTER);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}
```

- [ ] **Step 4: Accept the cursors and add the search route**

In `server/src/chats/routes.ts`, replace

```ts
import { z } from 'zod';
```

with

```ts
import { z } from 'zod';
import { SEARCH_MAX_CHARS, SEARCH_MIN_CHARS } from '@talk/shared';
```

replace

```ts
import { getChatDetail, getTimeline, listChats, toChatDetail } from '../inbox/queries.js';
```

with

```ts
import { getChatDetail, getTimeline, listChats, searchChat, toChatDetail } from '../inbox/queries.js';
```

replace

```ts
const timelineQuery = z.object({
  before: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
```

with

```ts
/** before = older than, after = newer than, around = centered on a message (spec 2026-10-19 §4); one at a time. */
const timelineQuery = z
  .object({
    before: z.uuid().optional(),
    after: z.uuid().optional(),
    around: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .refine((q) => [q.before, q.after, q.around].filter(Boolean).length <= 1, 'Use um cursor só');
const searchQuery = z.object({ q: z.string().trim().min(SEARCH_MIN_CHARS).max(SEARCH_MAX_CHARS) });
```

and replace

```ts
    r.get('/api/chats/:id/timeline', async (req) => {
      const { id } = idParams.parse(req.params);
      return getTimeline(ctx, req.user, id, timelineQuery.parse(req.query));
    });
```

with

```ts
    r.get('/api/chats/:id/timeline', async (req) => {
      const { id } = idParams.parse(req.params);
      return getTimeline(ctx, req.user, id, timelineQuery.parse(req.query));
    });

    r.get('/api/chats/:id/search', async (req) =>
      searchChat(ctx, req.user, idParams.parse(req.params).id, searchQuery.parse(req.query).q),
    );
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w server -- test/chats/search.test.ts test/chats/list-and-timeline.test.ts`
Expected: PASS (the existing `before` tests pass unchanged).

Run: `npm test -w server` and `npm run typecheck -w server`
Expected: PASS and exit 0.

- [ ] **Step 6: Commit**

```bash
git add server/src/inbox/queries.ts server/src/chats/routes.ts server/test/chats/search.test.ts server/test/chats/list-and-timeline.test.ts
git commit -m "feat(server): search inside a conversation and timeline pages around or after a message" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 5: Personal preferences (API)

**Files:**
- Create: `server/src/auth/preferences.ts`
- Modify: `server/src/inbox/visibility.ts` (imports at lines 1-4, `AuthUser` at lines 6-15, `loadAuthUser` return at lines 59-68)
- Modify: `server/src/auth/routes.ts` (imports at lines 1-11; a new route after `PUT /api/auth/me/view`)
- Test: `server/test/auth/routes.test.ts` (imports; the login `toEqual` at lines 39-48; new `describe` at the end)

**Interfaces:**
- Consumes: Task 1 `BROWSER_NOTIFICATION_MODES`, `DEFAULT_PREFERENCES`, `UserPreferences`; Task 2 `users.preferences`.
- Produces: `preferencesSchema`, `readPreferences`, `AuthUser.preferences`, `PUT /api/auth/me/preferences`.

- [ ] **Step 1: Write the failing tests**

In `server/test/auth/routes.test.ts`, replace

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
```

with

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PREFERENCES } from '@talk/shared';
```

in the test `'returns Me and sets an HttpOnly SameSite=Lax sid cookie'`, replace

```ts
      seeAllSectors: false,
      avatarUrl: null,
    });
```

with

```ts
      seeAllSectors: false,
      avatarUrl: null,
      preferences: DEFAULT_PREFERENCES,
    });
```

and append at the end of the file:

```ts
describe('PUT /api/auth/me/preferences (spec 2026-10-19 §6)', () => {
  const put = (headers: Record<string, string>, payload: object) =>
    app.inject({ method: 'PUT', url: '/api/auth/me/preferences', headers, payload });
  const meOf = async (cookie: string) => (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).json();
  const stored = async (id: string) => (await ctx.db.select().from(users).where(eq(users.id, id)))[0]!.preferences;

  it('starts from the defaults and changes only the named fields, for this user only', async () => {
    const ana = await loginAs(app, seed.agentA.email);
    expect((await meOf(ana.cookie)).preferences).toEqual(DEFAULT_PREFERENCES);

    const first = await put(ana.headers, { sounds: false });
    expect(first.statusCode).toBe(200);
    expect(first.json().preferences).toEqual({ ...DEFAULT_PREFERENCES, sounds: false });
    expect((await put(ana.headers, { browserNotifications: 'never' })).json().preferences).toEqual({
      enterSends: true, sounds: false, browserNotifications: 'never',
    });
    expect(await stored(seed.agentA.id)).toEqual({ sounds: false, browserNotifications: 'never' });

    const bruno = await loginAs(app, seed.agentB.email);
    expect((await meOf(bruno.cookie)).preferences).toEqual(DEFAULT_PREFERENCES);
  });

  it('two saves at once keep both fields (Review Focus 5)', async () => {
    const ana = await loginAs(app, seed.agentA.email);
    await Promise.all([put(ana.headers, { enterSends: false }), put(ana.headers, { sounds: false })]);
    expect(await stored(seed.agentA.id)).toEqual({ enterSends: false, sounds: false });
  });

  it('a stored value the schema no longer accepts falls back to the defaults', async () => {
    await ctx.db.update(users).set({ preferences: { browserNotifications: 'old' } as never }).where(eq(users.id, seed.agentA.id));
    const ana = await loginAs(app, seed.agentA.email);
    expect((await meOf(ana.cookie)).preferences).toEqual(DEFAULT_PREFERENCES);
  });

  it('refuses unknown fields, bad values, a request without Origin and one without a session', async () => {
    const ana = await loginAs(app, seed.agentA.email);
    expect((await put(ana.headers, { theme: 'dark' })).statusCode).toBe(400);
    expect((await put(ana.headers, { browserNotifications: 'sometimes' })).statusCode).toBe(400);
    expect((await put(ana.headers, { sounds: 'no' })).statusCode).toBe(400);
    expect((await put({ cookie: ana.cookie }, { sounds: false })).statusCode).toBe(403);
    expect((await put({ origin: TEST_ORIGIN }, { sounds: false })).statusCode).toBe(401);
    expect(await stored(seed.agentA.id)).toEqual({});
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w server -- test/auth/routes.test.ts`
Expected: FAIL: `preferences` missing from Me, and 404 `Route PUT:/api/auth/me/preferences not found`.

- [ ] **Step 3: Create the preferences module**

Create `server/src/auth/preferences.ts`:

```ts
// Spec 2026-10-19 §6: per-user preferences. users.preferences holds only what the user changed.
import { z } from 'zod';
import { BROWSER_NOTIFICATION_MODES, DEFAULT_PREFERENCES, type UserPreferences } from '@talk/shared';

/** Every field optional (a PUT names only what changed); an unknown field is refused. */
export const preferencesSchema = z
  .strictObject({
    enterSends: z.boolean(),
    sounds: z.boolean(),
    browserNotifications: z.enum(BROWSER_NOTIFICATION_MODES),
  })
  .partial();

/** The stored jsonb over the defaults. Anything the schema does not accept (an old value) falls back to the defaults. */
export function readPreferences(stored: unknown): UserPreferences {
  const parsed = preferencesSchema.safeParse(stored ?? {});
  return { ...DEFAULT_PREFERENCES, ...(parsed.success ? parsed.data : {}) };
}
```

- [ ] **Step 4: Fill `AuthUser.preferences`**

In `server/src/inbox/visibility.ts`, replace

```ts
import { and, eq, inArray, or, type SQL } from 'drizzle-orm';
```

with

```ts
import { and, eq, inArray, or, type SQL } from 'drizzle-orm';
import type { UserPreferences } from '@talk/shared';
import { readPreferences } from '../auth/preferences.js';
```

replace

```ts
  seeAllSectors: boolean; // only meaningful for admins ("Ver todos os setores")
  avatarUrl: string | null;
}
```

with

```ts
  seeAllSectors: boolean; // only meaningful for admins ("Ver todos os setores")
  avatarUrl: string | null;
  preferences?: UserPreferences; // spec 2026-10-19 §6: optional so literals compile; loadAuthUser always fills it
}
```

and replace

```ts
    seeAllSectors: u.seeAllSectors,
    avatarUrl: userAvatarUrl(u),
  };
```

with

```ts
    seeAllSectors: u.seeAllSectors,
    avatarUrl: userAvatarUrl(u),
    preferences: readPreferences(u.preferences),
  };
```

- [ ] **Step 5: Add the route**

In `server/src/auth/routes.ts`, replace

```ts
import { hashPassword, verifyPassword } from './password.js';
```

with

```ts
import { hashPassword, verifyPassword } from './password.js';
import { preferencesSchema } from './preferences.js';
```

and after the `app.put('/api/auth/me/view', …)` block add:

```ts
  // Spec 2026-10-19 §6: any user, own preferences. jsonb || merges the named fields in one UPDATE, so two tabs
  // saving different fields at the same time both stick (no read-modify-write).
  app.put('/api/auth/me/preferences', { preHandler: requireUser }, async (req) => {
    const patch = preferencesSchema.parse(req.body);
    const id = authUser(req).id;
    await ctx.db
      .update(users)
      .set({ preferences: sql`${users.preferences} || ${JSON.stringify(patch)}::jsonb` })
      .where(eq(users.id, id));
    return loadAuthUser(ctx.db, id);
  });
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -w server -- test/auth/routes.test.ts test/inbox/visibility.test.ts`
Expected: PASS.

Run: `npm test -w server` and `npm run typecheck -w server`
Expected: PASS and exit 0. A failure that only misses `preferences` in a full-`Me` `toEqual` gets `preferences: DEFAULT_PREFERENCES` added.

- [ ] **Step 7: Commit**

```bash
git add server/src/auth/preferences.ts server/src/inbox/visibility.ts server/src/auth/routes.ts server/test/auth/routes.test.ts
git commit -m "feat(server): per-user preferences merged field by field" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 6: Web API client, WebSocket cache, and the bubble (notes, star, highlight)

**Files:**
- Modify: `web/src/lib/api.ts` (type imports at lines 2-34, types after `TimelineData` at line 71, `auth`, `chats`, `messages`, a new `notes` group, `qk`)
- Modify: `web/src/lib/ws.ts` (imports at lines 3-4, `upsertTimeline` at lines 33-48, the message case at lines 75-82)
- Modify: `web/src/components/conversation/MessageMenu.tsx` (imports at lines 3-5, `MenuAction` at line 7, `menuItems` at lines 11-33)
- Modify: `web/src/components/conversation/MessageBubble.tsx` (icon import, props, menu items, actions, star, highlight)
- Test: `web/src/lib/api.test.ts`, `web/src/lib/ws.test.ts`, `web/src/components/conversation/MessageBubble.test.tsx`

**Interfaces:**
- Consumes: Task 1 `noteEditBlock`, `noteDeleteBlock`, `MessageSearchHit`, `UserPreferences`, `MessageDto.favorite`; the routes of Tasks 3-5.
- Produces: `TimelineCursor`, `AnchoredTimelineData`, the new `api.*` calls and `qk.*` keys of the Shared contract; `MenuAction` `'favorite' | 'deleteNote'`; `menuItems(…, isAdmin)`; `MessageBubble` `highlighted` and the root's `data-message-id` / `data-highlighted`.

- [ ] **Step 1: Write the failing tests**

Append inside the top-level of `web/src/lib/api.test.ts` (a new `describe` at the end):

```ts
describe('api routes of the 2026-10-19 delivery', () => {
  it('calls the timeline cursors, search, favorites, notes and preferences routes', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json(200, []));
    vi.stubGlobal('fetch', fetchMock);
    await api.chats.timeline('c1', { around: 'm1', limit: 50 });
    await api.chats.timeline('c1', { after: 'm2' });
    await api.chats.search('c1', 'ação 10%');
    await api.chats.favorites('c1');
    await api.messages.favorite('m1', true);
    await api.messages.favorite('m1', false);
    await api.notes.remove('m1');
    await api.auth.setPreferences({ sounds: false });
    expect(fetchMock.mock.calls.map(([url, init]) => `${init?.method} ${String(url)}`)).toEqual([
      'GET /api/chats/c1/timeline?around=m1&limit=50',
      'GET /api/chats/c1/timeline?after=m2',
      'GET /api/chats/c1/search?q=a%C3%A7%C3%A3o+10%25',
      'GET /api/chats/c1/favorites',
      'PUT /api/messages/m1/favorite',
      'DELETE /api/messages/m1/favorite',
      'DELETE /api/notes/m1',
      'PUT /api/auth/me/preferences',
    ]);
    expect(fetchMock.mock.calls.at(-1)![1]!.body).toBe('{"sounds":false}');
  });
});
```

In `web/src/lib/ws.test.ts`, replace

```ts
import { qk, type ChatListData, type TimelineData } from './api';
```

with

```ts
import { qk, type AnchoredTimelineData, type ChatListData, type TimelineData } from './api';
```

and append inside `describe('applyWsEvent', …)`, after its last test:

```ts
  it('message.updated reaches an anchored timeline too; message.created only the live one (Review Focus 1)', () => {
    const qc = new QueryClient();
    qc.setQueryData<TimelineData>(qk.timeline('c1'), { pages: [[item(msg('m9', '2026-10-14T10:00:00.000Z'))]], pageParams: [undefined] });
    qc.setQueryData<AnchoredTimelineData>(qk.timelineAt('c1', 'm1'), {
      pages: [[item(msg('m1', '2026-10-01T10:00:00.000Z'))]], pageParams: [{ around: 'm1' }],
    });
    const anchored = () => qc.getQueryData<AnchoredTimelineData>(qk.timelineAt('c1', 'm1'))!.pages.flat();

    applyWsEvent(qc, {
      type: 'message.updated',
      message: msg('m1', '2026-10-01T10:00:00.000Z', { favorite: { at: '2026-10-19T12:00:00.000Z', byName: 'Ana' } }),
    });
    expect(anchored()[0]).toMatchObject({ id: 'm1', favorite: { byName: 'Ana' } });

    applyWsEvent(qc, { type: 'message.created', message: msg('m10', '2026-10-14T11:00:00.000Z') });
    expect(anchored().map((i) => i.id)).toEqual(['m1']);
    expect(qc.getQueryData<TimelineData>(qk.timeline('c1'))!.pages[0]!.map((i) => i.id)).toEqual(['m9', 'm10']);
  });

  it('keeps the favorites list in step: a new star goes first, a removed one leaves, an update replaces', () => {
    const qc = new QueryClient();
    const star = { at: '2026-10-19T12:00:00.000Z', byName: 'Ana' };
    qc.setQueryData<MessageDto[]>(qk.chatFavorites('c1'), [msg('m1', '2026-10-14T08:00:00.000Z', { favorite: star })]);
    const list = () => qc.getQueryData<MessageDto[]>(qk.chatFavorites('c1'))!;

    applyWsEvent(qc, { type: 'message.updated', message: msg('m2', '2026-10-14T09:00:00.000Z', { favorite: star }) });
    expect(list().map((m) => m.id)).toEqual(['m2', 'm1']);
    applyWsEvent(qc, { type: 'message.updated', message: msg('m1', '2026-10-14T08:00:00.000Z', { favorite: null }) });
    expect(list().map((m) => m.id)).toEqual(['m2']);
    applyWsEvent(qc, { type: 'message.updated', message: msg('m2', '2026-10-14T09:00:00.000Z', { favorite: star, status: 'read' }) });
    expect(list()).toHaveLength(1);
    expect(list()[0]!.status).toBe('read');
  });
```

In `web/src/components/conversation/MessageBubble.test.tsx`, replace

```ts
function renderBubble(m: MessageDto, opts: { chatOpen?: boolean } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(qk.me, ME);
  return render(
    <QueryClientProvider client={qc}>
      <MessageBubble m={m} onReply={() => {}} chatOpen={opts.chatOpen ?? false} />
    </QueryClientProvider>,
  ).container;
}
```

with

```ts
function renderBubble(m: MessageDto, opts: { chatOpen?: boolean; me?: Me; highlighted?: boolean } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(qk.me, opts.me ?? ME);
  return render(
    <QueryClientProvider client={qc}>
      <MessageBubble m={m} onReply={() => {}} chatOpen={opts.chatOpen ?? false} highlighted={opts.highlighted} />
    </QueryClientProvider>,
  ).container;
}
```

In the test `'offers every action on my recent text in an open chat'`, replace

```ts
    expect(labels()).toEqual(['Reagir', 'Responder', 'Encaminhar', 'Copiar', 'Editar', 'Apagar para todos']);
```

with

```ts
    expect(labels()).toEqual(['Reagir', 'Responder', 'Encaminhar', 'Copiar', 'Favoritar', 'Editar', 'Apagar para todos']);
```

In the test `'leaves out what does not apply: inbound, deleted and closed-chat messages'`, replace

```ts
    expect(labels()).toEqual(['Reagir', 'Responder', 'Encaminhar', 'Copiar']);
```

with

```ts
    expect(labels()).toEqual(['Reagir', 'Responder', 'Encaminhar', 'Copiar', 'Favoritar']);
```

and replace both occurrences (use replace-all) of

```ts
    expect(labels()).toEqual(['Copiar']);
```

with

```ts
    expect(labels()).toEqual(['Copiar', 'Favoritar']);
```

Then append at the end of the file:

```ts
describe('MessageBubble notes, favorites and focus (spec 2026-10-19 §3, §4, §5)', () => {
  const note: MessageDto = { ...base, kind: 'note', body: 'Cliente pediu retorno', sentAt: new Date(Date.now() - 60_000).toISOString() };
  const openMenu = () => fireEvent.click(screen.getByRole('button', { name: 'Ações da mensagem' }));
  const labels = () => screen.getAllByRole('menuitem').map((b) => b.firstChild?.textContent);
  const item = (name: string) => screen.getByRole('menuitem', { name: new RegExp(`^${name}`) }) as HTMLButtonElement;

  it('offers Editar nota and Apagar nota to the author, only Apagar nota to an admin, neither to another agent', () => {
    renderBubble(note, { chatOpen: true });
    openMenu();
    expect(labels()).toEqual(['Copiar', 'Favoritar', 'Editar nota', 'Apagar nota']);
    cleanup();
    renderBubble({ ...note, authorId: 'u2' }, { chatOpen: true, me: { ...ME, role: 'admin' } });
    openMenu();
    expect(labels()).toEqual(['Copiar', 'Favoritar', 'Apagar nota']);
    cleanup();
    renderBubble({ ...note, authorId: 'u2' }, { chatOpen: true });
    openMenu();
    expect(labels()).toEqual(['Copiar', 'Favoritar']);
    cleanup();
    renderBubble(note, { chatOpen: false });
    openMenu();
    expect(labels()).toEqual(['Copiar', 'Favoritar']);
  });

  it('edits a note in place through the same PATCH', async () => {
    stubFetch({ 'PATCH /api/messages/m1': { ...note, body: 'Cliente pediu retorno amanhã' } });
    renderBubble(note, { chatOpen: true });
    openMenu();
    fireEvent.click(item('Editar nota'));
    const box = screen.getByLabelText('Editar mensagem') as HTMLTextAreaElement;
    expect(box.value).toBe('Cliente pediu retorno');
    fireEvent.change(box, { target: { value: 'Cliente pediu retorno amanhã' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() =>
      expect(calls).toEqual([{ method: 'PATCH', path: '/api/messages/m1', body: { text: 'Cliente pediu retorno amanhã' } }]),
    );
  });

  it('asks before deleting a note, with the spec text, then calls DELETE /api/notes/:id', async () => {
    stubFetch({ 'DELETE /api/notes/m1': null });
    renderBubble(note, { chatOpen: true });
    openMenu();
    fireEvent.click(item('Apagar nota'));
    await waitFor(() => expect(calls).toEqual([{ method: 'DELETE', path: '/api/notes/m1', body: undefined }]));
    expect(confirmDialog).toHaveBeenCalledWith({
      title: 'Apagar nota?', body: 'A nota sai da conversa para todos.', confirmLabel: 'Apagar nota',
    });
  });

  it('stars and unstars, also in a closed chat, and shows the star with who marked it', async () => {
    const starred = { ...base, favorite: { at: base.sentAt, byName: 'Bia' } };
    stubFetch({ 'PUT /api/messages/m1/favorite': starred, 'DELETE /api/messages/m1/favorite': base });
    renderBubble(base);
    expect(document.querySelector('[data-tag="favorite"]')).toBeNull();
    openMenu();
    fireEvent.click(item('Favoritar'));
    await waitFor(() => expect(calls).toEqual([{ method: 'PUT', path: '/api/messages/m1/favorite', body: undefined }]));
    cleanup();
    renderBubble(starred);
    expect(screen.getByTitle('Favoritada por Bia')).toBeTruthy();
    openMenu();
    fireEvent.click(item('Remover dos favoritos'));
    await waitFor(() => expect(calls.at(-1)).toEqual({ method: 'DELETE', path: '/api/messages/m1/favorite', body: undefined }));
  });

  it('marks the focused message for the timeline', () => {
    const c = renderBubble(base, { highlighted: true });
    const root = c.querySelector('[data-message-id="m1"]');
    expect(root?.getAttribute('data-highlighted')).toBe('true');
    cleanup();
    expect(renderBubble(base).querySelector('[data-message-id="m1"]')?.hasAttribute('data-highlighted')).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w web -- src/lib/api.test.ts src/lib/ws.test.ts src/components/conversation/MessageBubble.test.tsx`
Expected: FAIL: `api.chats.search is not a function`, `qk.timelineAt is not a function`, and the menus have no "Favoritar" / "Editar nota".

- [ ] **Step 3: Extend the API client**

In `web/src/lib/api.ts`, in the `import type { … } from '@talk/shared'` list, replace

```ts
  MessageEditDto,
```

with

```ts
  MessageEditDto,
  MessageSearchHit,
```

and replace

```ts
  UserDto,
} from '@talk/shared';
```

with

```ts
  UserDto,
  UserPreferences,
} from '@talk/shared';
```

replace

```ts
export type TimelineData = InfiniteData<TimelineItem[], string | undefined>;
```

with

```ts
export type TimelineData = InfiniteData<TimelineItem[], string | undefined>;
/** One page of a timeline anchored on a message (spec 2026-10-19 §4): older than, newer than, or around an item. */
export type TimelineCursor = { before: string } | { after: string } | { around: string };
/** Anchored timeline (qk.timelineAt): pages[0] = newest loaded, each ascending; next pages are older, previous pages newer. */
export type AnchoredTimelineData = InfiniteData<TimelineItem[], TimelineCursor>;
```

replace

```ts
    removeAvatar: () => request<Me>('DELETE', '/api/auth/me/avatar'),
  },
```

with

```ts
    removeAvatar: () => request<Me>('DELETE', '/api/auth/me/avatar'),
    /** Spec 2026-10-19 §6: only the fields that changed. */
    setPreferences: (patch: Partial<UserPreferences>) => request<Me>('PUT', '/api/auth/me/preferences', patch),
  },
```

replace

```ts
    timeline: (id: string, q: { before?: string; limit?: number } = {}) =>
      request<TimelineItem[]>('GET', `/api/chats/${enc(id)}/timeline${qs(q)}`),
```

with

```ts
    timeline: (id: string, q: { before?: string; after?: string; around?: string; limit?: number } = {}) =>
      request<TimelineItem[]>('GET', `/api/chats/${enc(id)}/timeline${qs(q)}`),
    /** Spec 2026-10-19 §4: newest first, at most 50. */
    search: (id: string, q: string) => request<MessageSearchHit[]>('GET', `/api/chats/${enc(id)}/search${qs({ q })}`),
    /** Spec 2026-10-19 §5: newest star first. */
    favorites: (id: string) => request<MessageDto[]>('GET', `/api/chats/${enc(id)}/favorites`),
```

replace

```ts
    forward: (messageId: string, input: ForwardInput) =>
      request<MessageDto>('POST', `/api/messages/${enc(messageId)}/forward`, input),
  },
```

with

```ts
    forward: (messageId: string, input: ForwardInput) =>
      request<MessageDto>('POST', `/api/messages/${enc(messageId)}/forward`, input),
    /** The team's shared star: true marks, false removes. */
    favorite: (messageId: string, on: boolean) =>
      request<MessageDto>(on ? 'PUT' : 'DELETE', `/api/messages/${enc(messageId)}/favorite`),
  },
  notes: {
    /** Spec 2026-10-19 §3: the note leaves the chat for everyone (editing is api.messages.edit). */
    remove: (messageId: string) => request<void>('DELETE', `/api/notes/${enc(messageId)}`),
  },
```

and replace

```ts
  timeline: (id: string) => ['chats', 'timeline', id] as const,
```

with

```ts
  timeline: (id: string) => ['chats', 'timeline', id] as const,
  /** Every anchored timeline of a chat (prefix); one per message jumped to (spec 2026-10-19 §4). */
  timelineAnchors: (chatId: string) => ['chats', 'timeline', chatId, 'at'] as const,
  timelineAt: (chatId: string, messageId: string) => ['chats', 'timeline', chatId, 'at', messageId] as const,
  chatSearch: (chatId: string, q: string) => ['chats', 'search', chatId, q] as const,
  chatFavorites: (chatId: string) => ['chats', 'favorites', chatId] as const,
```

- [ ] **Step 4: Update the anchored timelines and the favorites list from WebSocket events**

In `web/src/lib/ws.ts`, replace

```ts
import type { ChannelDto, ChatDetail, ChatListItem, TimelineItem, WsEvent } from '@talk/shared';
import { qk, type ChatListData, type TimelineData } from './api';
```

with

```ts
import type { ChannelDto, ChatDetail, ChatListItem, MessageDto, TimelineItem, WsEvent } from '@talk/shared';
import { qk, type AnchoredTimelineData, type ChatListData, type TimelineData } from './api';
```

replace

```ts
function upsertTimeline(d: TimelineData, next: TimelineItem, insert: boolean): TimelineData {
```

with

```ts
function upsertTimeline<D extends { pages: TimelineItem[][] }>(d: D, next: TimelineItem, insert: boolean): D {
```

after the closing `}` of `upsertTimeline` add:

```ts
/** Spec 2026-10-19 §5: the chat's favorites list follows the stars without a refetch (newest star first). */
function favoritesAfter(list: MessageDto[], m: MessageDto): MessageDto[] {
  if (!m.favorite) return list.filter((f) => f.id !== m.id);
  return list.some((f) => f.id === m.id) ? list.map((f) => (f.id === m.id ? m : f)) : [m, ...list];
}
```

and replace

```ts
    case 'message.created':
    case 'message.updated': {
      const item: TimelineItem = { type: 'message', ...ev.message };
      qc.setQueryData<TimelineData>(qk.timeline(ev.message.chatId), (d) =>
        d && upsertTimeline(d, item, ev.type === 'message.created'),
      );
      return;
    }
```

with

```ts
    case 'message.created':
    case 'message.updated': {
      const item: TimelineItem = { type: 'message', ...ev.message };
      const { chatId } = ev.message;
      qc.setQueryData<TimelineData>(qk.timeline(chatId), (d) => d && upsertTimeline(d, item, ev.type === 'message.created'));
      // An anchored view (search hit, favorite) takes updates only: a new message belongs at the present, which it may not hold.
      qc.setQueriesData<AnchoredTimelineData>({ queryKey: qk.timelineAnchors(chatId) }, (d) => d && upsertTimeline(d, item, false));
      qc.setQueryData<MessageDto[]>(qk.chatFavorites(chatId), (list) => list && favoritesAfter(list, ev.message));
      return;
    }
```

- [ ] **Step 5: Add the menu items**

In `web/src/components/conversation/MessageMenu.tsx`, replace

```ts
import {
  QUICK_REACTIONS, deleteBlock, editBlock, forwardBlock, isSingleEmoji, reactBlock, replyBlock, type ActionBlock, type MessageDto,
} from '@talk/shared';

export type MenuAction = 'react' | 'reply' | 'forward' | 'copy' | 'download' | 'edit' | 'delete';
```

with

```ts
import {
  QUICK_REACTIONS, deleteBlock, editBlock, forwardBlock, isSingleEmoji, noteDeleteBlock, noteEditBlock, reactBlock, replyBlock,
  type ActionBlock, type MessageDto,
} from '@talk/shared';

export type MenuAction = 'react' | 'reply' | 'forward' | 'copy' | 'download' | 'favorite' | 'edit' | 'delete' | 'deleteNote';
```

and replace

```ts
/**
 * Spec §9: Reagir · Responder · Encaminhar · Copiar · Baixar arquivo · Editar · Apagar para todos. An action that does not apply to
 * this message is left out; one whose time is over stays, disabled, with its hint. A closed chat only offers Copiar and Baixar arquivo.
 */
export function menuItems(m: MessageDto, meId: string | null, chatOpen: boolean, now: number): MenuItem[] {
```

with

```ts
/**
 * Spec §9 (2026-10-16) and §8 (2026-10-19): Reagir · Responder · Encaminhar · Copiar · Baixar arquivo · Favoritar · Editar ·
 * Apagar para todos; a note offers Editar nota · Apagar nota instead of the last two. An action that does not apply to this
 * message is left out; one whose time is over stays, disabled, with its hint. A closed chat only offers Copiar, Baixar arquivo
 * and Favoritar.
 */
export function menuItems(m: MessageDto, meId: string | null, chatOpen: boolean, now: number, isAdmin = false): MenuItem[] {
```

and replace

```ts
  if (m.media) items.push({ action: 'download', label: 'Baixar arquivo', hint: null }); // only a file the server has
  if (chatOpen) {
    add('edit', 'Editar', editBlock(m, meId, now));
    add('delete', 'Apagar para todos', deleteBlock(m, now));
  }
  return items;
```

with

```ts
  if (m.media) items.push({ action: 'download', label: 'Baixar arquivo', hint: null }); // only a file the server has
  // Spec 2026-10-19 §5: any message, any chat state: a team bookmark, not a WhatsApp action
  items.push({ action: 'favorite', label: m.favorite ? 'Remover dos favoritos' : 'Favoritar', hint: null });
  if (chatOpen && m.kind === 'note') {
    add('edit', 'Editar nota', noteEditBlock(m, meId));
    add('deleteNote', 'Apagar nota', noteDeleteBlock(m, meId, isAdmin));
  } else if (chatOpen) {
    add('edit', 'Editar', editBlock(m, meId, now));
    add('delete', 'Apagar para todos', deleteBlock(m, now));
  }
  return items;
```

- [ ] **Step 6: Wire the bubble**

In `web/src/components/conversation/MessageBubble.tsx`, replace

```ts
import { Check, Checks, Clock, DownloadSimple, FileText, ImageBroken, Robot, ShareFat, WarningCircle } from '@phosphor-icons/react';
```

with

```ts
import { Check, Checks, Clock, DownloadSimple, FileText, ImageBroken, Robot, ShareFat, Star, WarningCircle } from '@phosphor-icons/react';
```

replace

```ts
  /** Spec §2: no action in a closed chat (only Copiar). */
  chatOpen?: boolean;
}

export function MessageBubble({ m, onReply, chatOpen = false }: MessageBubbleProps) {
```

with

```ts
  /** Spec §2: no action in a closed chat (only Copiar). */
  chatOpen?: boolean;
  /** Spec 2026-10-19 §4: the search hit or favorite the timeline just jumped to. */
  highlighted?: boolean;
}

export function MessageBubble({ m, onReply, chatOpen = false, highlighted = false }: MessageBubbleProps) {
```

replace

```ts
  const meId = qc.getQueryData<Me | null>(qk.me)?.id ?? null;
  const items = menuItems(m, meId, chatOpen, Date.now());
```

with

```ts
  const me = qc.getQueryData<Me | null>(qk.me);
  const items = menuItems(m, me?.id ?? null, chatOpen, Date.now(), me?.role === 'admin');
```

replace

```ts
    if (ok) await act(() => api.messages.remove(m.id));
  }

  function onAction(action: Exclude<MenuAction, 'react'>) {
    if (action === 'reply') onReply(m);
    else if (action === 'forward') setForwarding(true);
    else if (action === 'copy') void copy();
    else if (action === 'download') {
      if (m.media) saveFile(m.media.url, m.media.name);
    }
    else if (action === 'edit') {
      setDraft(m.body ?? '');
      setActionError(null);
      setEditing(true);
    } else void remove();
  }
```

with

```ts
    if (ok) await act(() => api.messages.remove(m.id));
  }

  /** Spec 2026-10-19 §3: the row goes away, so reload the timeline (chat.updated does the same on the other screens). */
  async function removeNote() {
    const ok = await confirmDialog({ title: 'Apagar nota?', body: 'A nota sai da conversa para todos.', confirmLabel: 'Apagar nota' });
    if (!ok) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.notes.remove(m.id);
      void qc.invalidateQueries({ queryKey: qk.timeline(m.chatId) });
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function onAction(action: Exclude<MenuAction, 'react'>) {
    switch (action) {
      case 'reply':
        return onReply(m);
      case 'forward':
        return setForwarding(true);
      case 'copy':
        return void copy();
      case 'download':
        if (m.media) saveFile(m.media.url, m.media.name);
        return;
      case 'favorite':
        return void act(() => api.messages.favorite(m.id, !m.favorite));
      case 'edit':
        setDraft(m.body ?? '');
        setActionError(null);
        setEditing(true);
        return;
      case 'delete':
        return void remove();
      case 'deleteNote':
        return void removeNote();
    }
  }
```

replace

```tsx
    <div className={`group flex px-4 py-1 ${right ? 'justify-end' : 'justify-start'}`}>
```

with

```tsx
    <div
      data-message-id={m.id}
      data-highlighted={highlighted || undefined}
      className={`group flex px-4 py-1 ${right ? 'justify-end' : 'justify-start'}`}
    >
```

replace

```tsx
        className={`relative max-w-[70%] px-3 py-2 ${tone} ${m.reaction || m.officeReaction ? 'mb-3' : ''}`}
```

with

```tsx
        className={`relative max-w-[70%] px-3 py-2 ${tone} ${m.reaction || m.officeReaction ? 'mb-3' : ''} ${
          highlighted ? 'ring-2 ring-brass' : ''
        }`}
```

and replace

```tsx
          <time dateTime={m.sentAt}>{timeOfDay(m.sentAt)}</time>
```

with

```tsx
          {m.favorite && (
            <span data-tag="favorite" title={`Favoritada por ${m.favorite.byName ?? 'atendente'}`} className="text-brass">
              <Star size={12} weight="fill" aria-label="Favorita" />
            </span>
          )}
          <time dateTime={m.sentAt}>{timeOfDay(m.sentAt)}</time>
```

- [ ] **Step 7: Run the tests and the type check**

Run: `npm test -w web -- src/lib/api.test.ts src/lib/ws.test.ts src/components/conversation/MessageBubble.test.tsx`
Expected: PASS.

Run: `npm test -w web` and `npm run typecheck -w web`
Expected: PASS and exit 0.

- [ ] **Step 8: Commit**

```bash
git add web/src/lib/api.ts web/src/lib/ws.ts web/src/components/conversation/MessageMenu.tsx web/src/components/conversation/MessageBubble.tsx web/src/lib/api.test.ts web/src/lib/ws.test.ts web/src/components/conversation/MessageBubble.test.tsx
git commit -m "feat(web): edit and delete notes, the shared star and the focused bubble" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 7: Timeline focus and the anchored mode

**Files:**
- Modify: `web/src/components/conversation/model.ts` (import at line 2; new exports after `TIMELINE_PAGE_SIZE`)
- Modify: `web/src/components/conversation/Timeline.tsx` (whole file)
- Modify: `web/src/components/conversation/ConversationView.tsx` (import from `./model`; props; two timeline invalidations; the `Timeline` element)
- Test: `web/src/components/conversation/model.test.ts` (import block; new `describe` at the end), `web/src/components/conversation/Timeline.test.tsx` (imports; new `describe` at the end)

**Interfaces:**
- Consumes: Task 4 `around`/`after`; Task 6 `TimelineCursor`, `AnchoredTimelineData`, `qk.timelineAt`, `qk.chatFavorites`, `MessageBubble` `highlighted` and `data-message-id`.
- Produces: `TimelineFocus`, `FOCUS_HIGHLIGHT_MS`, `olderCursor`, `newerCursor`; `Timeline` `focus` prop; `ConversationView` `focus` prop.

- [ ] **Step 1: Write the failing tests**

In `web/src/components/conversation/model.test.ts`, replace

```ts
import {
  buildTimelineRows, dayLabel, deletedTag, editedTag, errorMessage, eventText, isConflict, mergeTimelinePages, previewText,
} from './model';
```

with

```ts
import {
  buildTimelineRows, dayLabel, deletedTag, editedTag, errorMessage, eventText, isConflict, mergeTimelinePages, newerCursor,
  olderCursor, previewText,
} from './model';
```

and append at the end of the file:

```ts
describe('anchored timeline cursors (spec 2026-10-19 §4)', () => {
  const page = (...ids: string[]) => ids.map((id, i) => msg(id, at(2026, 10, 14, 9, i)));

  it('the page around a message pages on from an end only when that half came back full', () => {
    const full = page('a', 'b', 'c', 'd', 'e'); // size 4 → half 2: two older, the target, two newer
    expect(olderCursor(full, { around: 'c' }, 4)).toEqual({ before: 'a' });
    expect(newerCursor(full, { around: 'c' }, 4)).toEqual({ after: 'e' });
    expect(olderCursor(page('c', 'd', 'e'), { around: 'c' }, 4)).toBeUndefined(); // nothing older than c
    expect(newerCursor(page('a', 'b', 'c', 'd'), { around: 'c' }, 4)).toBeUndefined(); // one newer: the present
  });

  it('before and after pages stop when one comes back short', () => {
    expect(olderCursor(page('a', 'b', 'c', 'd'), { before: 'x' }, 4)).toEqual({ before: 'a' });
    expect(olderCursor(page('a', 'b'), { before: 'x' }, 4)).toBeUndefined();
    expect(newerCursor(page('a', 'b', 'c', 'd'), { after: 'x' }, 4)).toEqual({ after: 'd' });
    expect(newerCursor(page('a'), { after: 'x' }, 4)).toBeUndefined();
    expect(olderCursor([], { before: 'x' }, 4)).toBeUndefined();
  });
});
```

In `web/src/components/conversation/Timeline.test.tsx`, replace

```ts
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TimelineItem } from '@talk/shared';
import { Timeline } from './Timeline';
```

with

```ts
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TimelineItem } from '@talk/shared';
import type { TimelineFocus } from './model';
import { Timeline } from './Timeline';
```

and append at the end of the file:

```ts
describe('Timeline focus (spec 2026-10-19 §4)', () => {
  const m = (id: string, min: number): TimelineItem => ({
    type: 'message', id, chatId: 'c1', direction: 'in', kind: 'text', body: `texto ${id}`, media: null, mediaUnavailable: false,
    authorId: null, authorName: null, authorAvatarUrl: null, replyTo: null, reaction: null, status: 'read', error: null,
    sentAt: new Date(Date.UTC(2026, 9, 18, 12, min)).toISOString(),
  });
  const LIVE = [m('m8', 8), m('m9', 9)];
  const AROUND = [m('m1', 1), m('m2', 2), m('m3', 3)];
  const urls: string[] = [];

  function stub() {
    urls.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'http://localhost');
        urls.push(url.pathname + url.search);
        const body = url.pathname === '/api/chats/c1/timeline' ? (url.searchParams.has('around') ? AROUND : LIVE) : [];
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
  }

  function renderTimeline(): (focus: TimelineFocus | null) => void {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const ui = (focus: TimelineFocus | null) => (
      <QueryClientProvider client={qc}>
        <Timeline chatId="c1" onReply={() => {}} focus={focus} />
      </QueryClientProvider>
    );
    const view = render(ui(null));
    return (focus) => view.rerender(ui(focus));
  }
  const bubble = (id: string) => document.querySelector(`[data-message-id="${id}"]`);

  it('highlights a loaded message without asking the server again', async () => {
    stub();
    const focus = renderTimeline();
    await screen.findByText('texto m9');
    focus({ messageId: 'm8', seq: 1 });
    await waitFor(() => expect(bubble('m8')?.getAttribute('data-highlighted')).toBe('true'));
    expect(urls.filter((u) => u.includes('around'))).toEqual([]);
  });

  it('loads the page around a message that is not loaded, then goes back to the recent ones (Review Focus 1)', async () => {
    stub();
    const focus = renderTimeline();
    await screen.findByText('texto m9');

    focus({ messageId: 'm2', seq: 1 });

    await waitFor(() => expect(bubble('m2')?.getAttribute('data-highlighted')).toBe('true'));
    expect(urls).toContain('/api/chats/c1/timeline?around=m2&limit=50');
    expect(screen.queryByText('texto m9')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Ir para as mensagens recentes' }));
    expect(await screen.findByText('texto m9')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ir para as mensagens recentes' })).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w web -- src/components/conversation/model.test.ts src/components/conversation/Timeline.test.tsx`
Expected: FAIL: `olderCursor is not a function`; the Timeline ignores `focus` (no `data-highlighted`, no `around` request).

- [ ] **Step 3: Add the focus types and the cursors**

In `web/src/components/conversation/model.ts`, replace

```ts
import { ApiError } from '../../lib/api';

export const TIMELINE_PAGE_SIZE = 50;
```

with

```ts
import { ApiError, type TimelineCursor } from '../../lib/api';

export const TIMELINE_PAGE_SIZE = 50;

/** Spec 2026-10-19 §4: a message to bring into view; a new `seq` jumps again to the same message. */
export interface TimelineFocus { messageId: string; seq: number }
export const FOCUS_HIGHLIGHT_MS = 3000;

/**
 * Anchored timeline: the cursor of the next older page, or undefined at the start of the chat. The page around a message
 * asked for half a page on each side, so a full older half means there may be more.
 */
export function olderCursor(page: TimelineItem[], param: TimelineCursor, size: number): TimelineCursor | undefined {
  const first = page[0];
  if (!first) return undefined;
  if ('around' in param) {
    const i = page.findIndex((it) => it.id === param.around);
    return i >= Math.floor(size / 2) ? { before: first.id } : undefined;
  }
  return page.length < size ? undefined : { before: first.id };
}

/** Anchored timeline: the cursor of the next newer page, or undefined once the present is loaded. */
export function newerCursor(page: TimelineItem[], param: TimelineCursor, size: number): TimelineCursor | undefined {
  const last = page.at(-1);
  if (!last) return undefined;
  if ('around' in param) {
    const i = page.findIndex((it) => it.id === param.around);
    return i >= 0 && page.length - 1 - i >= Math.floor(size / 2) ? { after: last.id } : undefined;
  }
  return page.length < size ? undefined : { after: last.id };
}
```

- [ ] **Step 4: Rewrite the Timeline**

Replace the whole content of `web/src/components/conversation/Timeline.tsx` with:

```tsx
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ArrowDown, Info, Robot } from '@phosphor-icons/react';
import type { MessageDto } from '@talk/shared';
import { api, qk, type TimelineCursor } from '../../lib/api';
import { MessageBubble } from './MessageBubble';
import {
  FOCUS_HIGHLIGHT_MS, TIMELINE_PAGE_SIZE, buildTimelineRows, eventText, mergeTimelinePages, newerCursor, olderCursor, timeOfDay,
  type TimelineFocus,
} from './model';

const EDGE_PX = 80;

export function Timeline({
  chatId,
  onReply,
  chatOpen = false,
  focus = null,
}: {
  chatId: string;
  onReply: (m: MessageDto) => void;
  /** Spec §2: message actions only in an open chat. */
  chatOpen?: boolean;
  /** Spec 2026-10-19 §4: a search hit or a favorite to bring into view. */
  focus?: TimelineFocus | null;
}) {
  const live = useInfiniteQuery({
    queryKey: qk.timeline(chatId),
    queryFn: ({ pageParam }) => api.chats.timeline(chatId, { before: pageParam, limit: TIMELINE_PAGE_SIZE }),
    initialPageParam: undefined as string | undefined,
    // next = older: `before` is the id of the oldest item already loaded (Task 13)
    getNextPageParam: (last) => (last.length < TIMELINE_PAGE_SIZE ? undefined : last[0]?.id),
  });
  // Anchored mode: the page around a message that is not loaded, paged older (top) and newer (bottom) from there.
  // Its own cache, so the live timeline keeps receiving new messages meanwhile.
  const [anchor, setAnchor] = useState<string | null>(null);
  const anchored = useInfiniteQuery({
    queryKey: qk.timelineAt(chatId, anchor ?? ''),
    queryFn: ({ pageParam }) => api.chats.timeline(chatId, { ...pageParam, limit: TIMELINE_PAGE_SIZE }),
    initialPageParam: { around: anchor ?? '' } as TimelineCursor,
    getNextPageParam: (page, _all, param) => olderCursor(page, param, TIMELINE_PAGE_SIZE),
    getPreviousPageParam: (page, _all, param) => newerCursor(page, param, TIMELINE_PAGE_SIZE),
    enabled: anchor !== null,
  });
  const view = anchor ? anchored : live;
  const sectors = useQuery({ queryKey: qk.sectors, queryFn: api.sectors.list });
  const users = useQuery({ queryKey: qk.users, queryFn: api.users.list });

  const names = useMemo(
    () => new Map([...(sectors.data ?? []), ...(users.data ?? [])].map((x) => [x.id, x.name] as [string, string])),
    [sectors.data, users.data],
  );
  const rows = useMemo(() => buildTimelineRows(mergeTimelinePages(view.data?.pages ?? []), new Date()), [view.data]);

  const ref = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const loadingOlder = useRef(false);
  const prevHeight = useRef(0);
  const pendingScroll = useRef<string | null>(null); // a focused message to center once it is rendered
  const [highlight, setHighlight] = useState<string | null>(null);

  const findBubble = (id: string) => ref.current?.querySelector(`[data-message-id="${id}"]`) ?? null;

  // A new focus: center it if it is on screen already, otherwise load the timeline around it.
  useEffect(() => {
    if (!focus) return;
    const id = focus.messageId;
    setHighlight(id);
    stickToBottom.current = false;
    const target = findBubble(id);
    if (target) target.scrollIntoView?.({ block: 'center' });
    else {
      pendingScroll.current = id;
      setAnchor(id);
    }
    const timer = setTimeout(() => setHighlight((h) => (h === id ? null : h)), FOCUS_HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [focus]);

  // Opening, new messages while at the bottom → scroll to the end.
  // Older page prepended → keep the same message under the user's eyes. A focused message → center it.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const target = pendingScroll.current ? findBubble(pendingScroll.current) : null;
    if (target) {
      target.scrollIntoView?.({ block: 'center' });
      pendingScroll.current = null;
    } else if (loadingOlder.current) {
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

  function backToLive() {
    setAnchor(null);
    pendingScroll.current = null;
    stickToBottom.current = true;
  }

  function onScroll() {
    const el = ref.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < EDGE_PX;
    stickToBottom.current = anchor === null && nearBottom;
    if (el.scrollTop < EDGE_PX && view.hasNextPage && !view.isFetchingNextPage) {
      loadingOlder.current = true;
      prevHeight.current = el.scrollHeight;
      void view.fetchNextPage();
    }
    if (anchor !== null && nearBottom && !anchored.isFetchingPreviousPage) {
      // the newest loaded item of the anchored view: load newer, or hand back to the live timeline at the present
      if (anchored.hasPreviousPage) void anchored.fetchPreviousPage();
      else if (anchored.isSuccess) backToLive();
    }
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={ref} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto bg-sunken px-2 py-4">
        {view.isFetchingNextPage && <p className="py-2 text-center text-xs text-muted">Carregando mensagens anteriores…</p>}
        {view.isPending && <p className="py-6 text-center text-sm text-muted">Carregando…</p>}
        {view.isError && <p className="py-6 text-center text-sm text-danger">Não foi possível carregar a conversa.</p>}
        {rows.map((row) => {
          if (row.kind === 'date') {
            return (
              <div key={row.key} className="my-3 flex justify-center">
                <span className="rounded-full border border-border bg-surface px-3 py-1 text-xs font-semibold text-muted">{row.label}</span>
              </div>
            );
          }
          const item = row.item;
          if (item.type === 'event') {
            return (
              <p key={row.key} className="my-2 flex items-center justify-center gap-1 px-4 text-center text-xs text-muted">
                {item.kind.startsWith('bot_') ? (
                  <Robot size={14} aria-hidden data-bot-event className="shrink-0" />
                ) : (
                  <Info size={14} className="shrink-0" />
                )}
                {eventText(item, names)} · {timeOfDay(item.createdAt)}
              </p>
            );
          }
          return <MessageBubble key={row.key} m={item} onReply={onReply} chatOpen={chatOpen} highlighted={item.id === highlight} />;
        })}
        {anchor !== null && anchored.isFetchingPreviousPage && (
          <p className="py-2 text-center text-xs text-muted">Carregando mensagens seguintes…</p>
        )}
      </div>
      {anchor !== null && (
        <button
          type="button"
          onClick={backToLive}
          className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-surface px-3.5 py-1.5 text-sm font-medium text-fg shadow-lg hover:bg-sidebar-hover"
        >
          <ArrowDown size={14} aria-hidden /> Ir para as mensagens recentes
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Pass the focus through the conversation and refresh anchored views too**

In `web/src/components/conversation/ConversationView.tsx`, replace

```ts
import { errorMessage } from './model';
```

with

```ts
import { errorMessage, type TimelineFocus } from './model';
```

replace

```ts
  onOpenChat: (chatId: string) => void;
}
```

with

```ts
  onOpenChat: (chatId: string) => void;
  /** Spec 2026-10-19 §4/§5: the message to bring into view (a search hit or a favorite). */
  focus?: TimelineFocus | null;
}
```

replace

```ts
function ConversationPane({ chatId, contactPanelOpen, onToggleContactPanel, onOpenChat }: ConversationViewProps) {
```

with

```ts
function ConversationPane({ chatId, contactPanelOpen, onToggleContactPanel, onOpenChat, focus = null }: ConversationViewProps) {
```

replace

```ts
    if (lastEventFields.current && eventFields && lastEventFields.current !== eventFields) {
      void qc.invalidateQueries({ queryKey: qk.timeline(chatId), exact: true });
    }
```

with

```ts
    if (lastEventFields.current && eventFields && lastEventFields.current !== eventFields) {
      void qc.invalidateQueries({ queryKey: qk.timeline(chatId) }); // prefix: the anchored views too
    }
```

replace

```ts
  // the server may drop an echo duplicate row without a message event: refetch the timeline on chat.updated
  useWsEvent((ev) => {
    if (ev.type === 'chat.updated' && ev.chat.id === chatId) void qc.invalidateQueries({ queryKey: qk.timeline(chatId), exact: true });
  });
```

with

```ts
  // the server may drop an echo duplicate row (or a deleted note) without a message event: refetch on chat.updated,
  // the anchored views and the favorites list included
  useWsEvent((ev) => {
    if (ev.type !== 'chat.updated' || ev.chat.id !== chatId) return;
    void qc.invalidateQueries({ queryKey: qk.timeline(chatId) });
    void qc.invalidateQueries({ queryKey: qk.chatFavorites(chatId), exact: true });
  });
```

and replace

```tsx
      <Timeline chatId={chatId} onReply={setReplyTo} chatOpen={chat.state === 'open'} />
```

with

```tsx
      <Timeline chatId={chatId} onReply={setReplyTo} chatOpen={chat.state === 'open'} focus={focus} />
```

- [ ] **Step 6: Run the tests and the type check**

Run: `npm test -w web -- src/components/conversation/model.test.ts src/components/conversation/Timeline.test.tsx`
Expected: PASS.

Run: `npm test -w web` and `npm run typecheck -w web`
Expected: PASS and exit 0.

- [ ] **Step 7: Commit**

```bash
git add web/src/components/conversation/model.ts web/src/components/conversation/Timeline.tsx web/src/components/conversation/ConversationView.tsx web/src/components/conversation/model.test.ts web/src/components/conversation/Timeline.test.tsx
git commit -m "feat(web): jump to any message with an anchored timeline that pages both ways" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 8: Search bar, favorites list and the jump wiring

**Files:**
- Create: `web/src/components/conversation/ChatSearchBar.tsx`, `web/src/components/conversation/FavoritesList.tsx`
- Modify: `web/src/components/conversation/model.ts` (import; new exports after `previewText`)
- Modify: `web/src/components/conversation/ConversationHeader.tsx` (icon import, props, a button before "Contato")
- Modify: `web/src/components/conversation/ConversationView.tsx` (imports, props, search state, header props, the bar)
- Modify: `web/src/pages/Conversation.tsx` (whole file)
- Modify: `web/src/components/contacts/ContactPanel.tsx` (import, props, `ChatDetailsTab`)
- Test: `web/src/components/conversation/ChatSearchBar.test.tsx` (create), `web/src/components/conversation/FavoritesList.test.tsx` (create), `web/src/components/conversation/ConversationHeader.test.tsx`, `web/src/components/conversation/model.test.ts`

**Interfaces:**
- Consumes: Task 1 `SEARCH_MIN_CHARS`, `SEARCH_MAX_CHARS`, `SEARCH_LIMIT`, `MessageSearchHit`; Task 6 `api.chats.search`, `api.chats.favorites`, `qk.chatSearch`, `qk.chatFavorites`; Task 7 `TimelineFocus`, `ConversationView` `focus`.
- Produces: `ChatSearchBar`, `SEARCH_DEBOUNCE_MS`, `FavoritesList`, `resultsLabel`, `shortDateTime`; `ConversationHeader` `searchOpen`/`onToggleSearch`; `ConversationView` `onFocusMessage`; `ContactPanel` `onJumpToMessage`.

- [ ] **Step 1: Write the failing tests**

Create `web/src/components/conversation/ChatSearchBar.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MessageSearchHit } from '@talk/shared';
import { ChatSearchBar, SEARCH_DEBOUNCE_MS } from './ChatSearchBar';

const HITS: MessageSearchHit[] = [
  { messageId: 'm2', kind: 'text', direction: 'in', snippet: 'o contrato novo', sentAt: '2026-10-18T12:02:00.000Z' },
  { messageId: 'm1', kind: 'note', direction: 'out', snippet: 'contrato antigo', sentAt: '2026-10-18T12:01:00.000Z' },
];
const urls: string[] = [];

function stub(hits: MessageSearchHit[]) {
  urls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      urls.push(url.pathname + url.search);
      return new Response(JSON.stringify(hits), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
}

function renderBar() {
  const onFocusMessage = vi.fn();
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ChatSearchBar chatId="c1" onFocusMessage={onFocusMessage} onClose={onClose} />
    </QueryClientProvider>,
  );
  return { onFocusMessage, onClose, box: screen.getByLabelText('Buscar mensagens') };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ChatSearchBar (spec 2026-10-19 §4)', () => {
  it('searches after a pause, jumps to the newest hit and steps with the arrows; Esc closes', async () => {
    stub(HITS);
    const { onFocusMessage, onClose, box } = renderBar();

    fireEvent.change(box, { target: { value: 'contrato' } });

    expect(await screen.findByText('2 resultados')).toBeTruthy();
    expect(urls).toEqual(['/api/chats/c1/search?q=contrato']);
    await waitFor(() => expect(onFocusMessage).toHaveBeenLastCalledWith('m2'));
    expect(screen.getByText('1/2')).toBeTruthy();
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    await waitFor(() => expect(onFocusMessage).toHaveBeenLastCalledWith('m1'));
    expect(screen.getByText(/contrato antigo/)).toBeTruthy();
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    await waitFor(() => expect(onFocusMessage).toHaveBeenLastCalledWith('m2'));
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not search under 2 characters and says when nothing was found', async () => {
    stub([]);
    const { onFocusMessage, box } = renderBar();
    fireEvent.change(box, { target: { value: 'c' } });
    await new Promise((r) => setTimeout(r, SEARCH_DEBOUNCE_MS + 50));
    expect(urls).toEqual([]);
    fireEvent.change(box, { target: { value: 'xyz' } });
    expect(await screen.findByText('Nenhum resultado')).toBeTruthy();
    expect(onFocusMessage).not.toHaveBeenCalled();
  });
});
```

Create `web/src/components/conversation/FavoritesList.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MessageDto } from '@talk/shared';
import { FavoritesList } from './FavoritesList';

const fav = (id: string, over: Partial<MessageDto>): MessageDto => ({
  id, chatId: 'c1', direction: 'in', kind: 'text', body: null, media: null, mediaUnavailable: false, authorId: null,
  authorName: null, authorAvatarUrl: null, replyTo: null, reaction: null, status: 'read', error: null,
  sentAt: '2026-10-18T12:00:00.000Z', ...over,
});

function stub(list: MessageDto[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(list), { status: 200, headers: { 'content-type': 'application/json' } })),
  );
}

function renderList(onJump = vi.fn()) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <FavoritesList chatId="c1" onJump={onJump} />
    </QueryClientProvider>,
  );
  return onJump;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('lists the favorites with who marked them and jumps on click (spec 2026-10-19 §5)', async () => {
  stub([
    fav('m2', { body: 'Proposta enviada', favorite: { at: '2026-10-19T09:00:00.000Z', byName: 'Bia' } }),
    fav('m1', { kind: 'image', favorite: { at: '2026-10-19T08:00:00.000Z', byName: 'Ana' } }),
  ]);
  const onJump = renderList();
  fireEvent.click(await screen.findByRole('button', { name: /Proposta enviada/ }));
  expect(onJump).toHaveBeenCalledWith('m2');
  expect(screen.getByRole('button', { name: /📷 Imagem/ }).textContent).toContain('por Ana');
});

it('says when there is none', async () => {
  stub([]);
  renderList();
  expect(await screen.findByText('Nenhuma mensagem favorita.')).toBeTruthy();
});
```

In `web/src/components/conversation/ConversationHeader.test.tsx`, replace

```tsx
function renderHeader(chat: ChatDetail = CHAT, opts: { path?: string; me?: Me } = {}) {
```

with

```tsx
function renderHeader(chat: ChatDetail = CHAT, opts: { path?: string; me?: Me; onToggleSearch?: () => void } = {}) {
```

replace

```tsx
        <ConversationHeader chat={chat} contactPanelOpen={false} onToggleContactPanel={() => {}} onOpenChat={() => {}} />
```

with

```tsx
        <ConversationHeader
          chat={chat}
          contactPanelOpen={false}
          onToggleContactPanel={() => {}}
          onOpenChat={() => {}}
          onToggleSearch={opts.onToggleSearch}
        />
```

and append at the end of the file:

```tsx
describe('ConversationHeader search (spec 2026-10-19 §4)', () => {
  it('toggles the search bar, also in a closed chat', () => {
    stubFetch();
    const onToggleSearch = vi.fn();
    renderHeader({ ...CHAT, state: 'closed' }, { onToggleSearch });
    fireEvent.click(screen.getByRole('button', { name: 'Buscar na conversa' }));
    expect(onToggleSearch).toHaveBeenCalledTimes(1);
  });
});
```

In `web/src/components/conversation/model.test.ts`, replace

```ts
  olderCursor, previewText,
} from './model';
```

with

```ts
  olderCursor, previewText, resultsLabel,
} from './model';
```

and append at the end of the file:

```ts
describe('resultsLabel (spec 2026-10-19 §4)', () => {
  it('counts the hits; a full page reads 50+', () => {
    expect(resultsLabel(0)).toBe('Nenhum resultado');
    expect(resultsLabel(1)).toBe('1 resultado');
    expect(resultsLabel(12)).toBe('12 resultados');
    expect(resultsLabel(50)).toBe('50+ resultados');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w web -- src/components/conversation/ChatSearchBar.test.tsx src/components/conversation/FavoritesList.test.tsx src/components/conversation/ConversationHeader.test.tsx src/components/conversation/model.test.ts`
Expected: FAIL: `ChatSearchBar.tsx` and `FavoritesList.tsx` do not exist, no "Buscar na conversa" button, `resultsLabel is not a function`.

- [ ] **Step 3: Add the text helpers**

In `web/src/components/conversation/model.ts`, replace

```ts
import type { ChatEventDto, MessageDto, TimelineItem } from '@talk/shared';
```

with

```ts
import { SEARCH_LIMIT, type ChatEventDto, type MessageDto, type TimelineItem } from '@talk/shared';
```

and replace

```ts
export function previewText(body: string | null, kind: string): string {
  return body?.trim() || KIND_PREVIEW[kind] || 'Mensagem';
}
```

with

```ts
export function previewText(body: string | null, kind: string): string {
  return body?.trim() || KIND_PREVIEW[kind] || 'Mensagem';
}

/** "Buscar na conversa" counter (spec 2026-10-19 §4). The server stops at SEARCH_LIMIT, so a full page reads "50+". */
export function resultsLabel(n: number): string {
  if (n === 0) return 'Nenhum resultado';
  if (n === 1) return '1 resultado';
  // ponytail: exactly 50 matches also reads "50+"; ask the server for one more row if that ever confuses someone
  return n >= SEARCH_LIMIT ? `${n}+ resultados` : `${n} resultados`;
}

/** dd/mm/aaaa hh:mm in the browser's time zone. */
export function shortDateTime(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}
```

- [ ] **Step 4: Create the search bar and the favorites list**

Create `web/src/components/conversation/ChatSearchBar.tsx`:

```tsx
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CaretDown, CaretUp, MagnifyingGlass, X } from '@phosphor-icons/react';
import { SEARCH_MAX_CHARS, SEARCH_MIN_CHARS } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { resultsLabel, shortDateTime } from './model';

export const SEARCH_DEBOUNCE_MS = 300;

export interface ChatSearchBarProps {
  chatId: string;
  /** Jump to this message in the timeline (spec 2026-10-19 §4). */
  onFocusMessage: (messageId: string) => void;
  onClose: () => void;
}

/**
 * "Buscar na conversa" (spec 2026-10-19 §4): searches 300 ms after the last key and goes to the newest hit;
 * ↑ or Enter goes older, ↓ or Shift+Enter newer (wrapping around); Esc closes.
 */
export function ChatSearchBar({ chatId, onFocusMessage, onClose }: ChatSearchBarProps) {
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [index, setIndex] = useState(0);
  // the latest callback without re-running the jump effect when the parent re-renders
  const focusRef = useRef(onFocusMessage);
  focusRef.current = onFocusMessage;

  useEffect(() => {
    const timer = setTimeout(() => setQ(text.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const enabled = q.length >= SEARCH_MIN_CHARS;
  const search = useQuery({ queryKey: qk.chatSearch(chatId, q), queryFn: () => api.chats.search(chatId, q), enabled });
  const hits = enabled ? (search.data ?? []) : [];
  const current = hits[index];
  const currentId = current?.messageId;

  useEffect(() => setIndex(0), [search.data]);
  useEffect(() => {
    if (currentId) focusRef.current(currentId);
  }, [currentId]);

  function step(delta: number) {
    if (hits.length > 0) setIndex((i) => (i + delta + hits.length) % hits.length);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowUp' || (e.key === 'Enter' && !e.shiftKey)) {
      e.preventDefault();
      step(1); // newest first: the next index is older
    } else if (e.key === 'ArrowDown' || (e.key === 'Enter' && e.shiftKey)) {
      e.preventDefault();
      step(-1);
    }
  }

  const iconButton =
    'flex size-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-sidebar-hover hover:text-fg disabled:opacity-40';

  return (
    <div className="border-b border-border bg-surface px-6 py-2">
      <div role="search" className="flex items-center gap-2">
        <MagnifyingGlass size={16} aria-hidden className="shrink-0 text-muted" />
        <input
          autoFocus
          aria-label="Buscar mensagens"
          placeholder="Buscar nesta conversa…"
          maxLength={SEARCH_MAX_CHARS}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          className="min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-muted"
        />
        {enabled && (
          <span aria-live="polite" className="shrink-0 text-xs text-muted">
            {search.isPending ? 'Buscando…' : search.isError ? 'Não foi possível buscar' : resultsLabel(hits.length)}
          </span>
        )}
        {current && (
          <span className="shrink-0 text-xs font-medium text-fg">
            {index + 1}/{hits.length}
          </span>
        )}
        <button type="button" aria-label="Resultado anterior" title="Resultado anterior (↑)" disabled={hits.length < 2} onClick={() => step(1)} className={iconButton}>
          <CaretUp size={16} />
        </button>
        <button type="button" aria-label="Próximo resultado" title="Próximo resultado (↓)" disabled={hits.length < 2} onClick={() => step(-1)} className={iconButton}>
          <CaretDown size={16} />
        </button>
        <button type="button" aria-label="Fechar busca" title="Fechar busca (Esc)" onClick={onClose} className={iconButton}>
          <X size={16} />
        </button>
      </div>
      {current && (
        <p className="mt-1 truncate pl-6 text-xs text-muted">
          {shortDateTime(current.sentAt)} · {current.snippet}
        </p>
      )}
    </div>
  );
}
```

Create `web/src/components/conversation/FavoritesList.tsx`:

```tsx
import { useQuery } from '@tanstack/react-query';
import { api, qk } from '../../lib/api';
import { previewText, shortDateTime } from './model';

/** Spec 2026-10-19 §5: the chat's starred messages, newest star first; a click jumps to the message. */
export function FavoritesList({ chatId, onJump }: { chatId: string; onJump: (messageId: string) => void }) {
  const favorites = useQuery({ queryKey: qk.chatFavorites(chatId), queryFn: () => api.chats.favorites(chatId) });
  if (favorites.isPending) return <p className="text-sm text-muted">Carregando…</p>;
  if (favorites.isError) return <p className="text-sm text-danger">Não foi possível carregar as favoritas.</p>;
  if (favorites.data.length === 0) return <p className="text-sm text-muted">Nenhuma mensagem favorita.</p>;
  return (
    <ul className="divide-y divide-border">
      {favorites.data.map((m) => (
        <li key={m.id}>
          <button type="button" onClick={() => onJump(m.id)} className="block w-full rounded px-1 py-2 text-left hover:bg-sidebar-hover">
            <span className="line-clamp-2 text-sm text-fg">{previewText(m.body, m.kind)}</span>
            <span className="mt-0.5 block text-xs text-muted">
              {shortDateTime(m.sentAt)}
              {m.favorite?.byName ? ` · por ${m.favorite.byName}` : ''}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 5: Add the header button**

In `web/src/components/conversation/ConversationHeader.tsx`, replace

```ts
import { ArrowBendUpRight, ArrowCounterClockwise, CheckCircle, LockSimple, LockSimpleOpen, User, UserPlus } from '@phosphor-icons/react';
```

with

```ts
import {
  ArrowBendUpRight, ArrowCounterClockwise, CheckCircle, LockSimple, LockSimpleOpen, MagnifyingGlass, User, UserPlus,
} from '@phosphor-icons/react';
```

replace

```ts
  onOpenChat: (chatId: string) => void;
}

export function ConversationHeader({ chat, contactPanelOpen, onToggleContactPanel, onOpenChat }: ConversationHeaderProps) {
```

with

```ts
  onOpenChat: (chatId: string) => void;
  /** Spec 2026-10-19 §4: the search bar under the header. */
  searchOpen?: boolean;
  onToggleSearch?: () => void;
}

export function ConversationHeader({
  chat, contactPanelOpen, onToggleContactPanel, onOpenChat, searchOpen = false, onToggleSearch,
}: ConversationHeaderProps) {
```

and replace

```tsx
        <HeaderButton label="Contato" pressed={contactPanelOpen} onClick={onToggleContactPanel}>
```

with

```tsx
        <HeaderButton label="Buscar na conversa" pressed={searchOpen} onClick={() => onToggleSearch?.()}>
          <MagnifyingGlass size={20} />
        </HeaderButton>
        <HeaderButton label="Contato" pressed={contactPanelOpen} onClick={onToggleContactPanel}>
```

- [ ] **Step 6: Open the bar from the conversation**

In `web/src/components/conversation/ConversationView.tsx`, replace

```ts
import { Composer } from './Composer';
```

with

```ts
import { ChatSearchBar } from './ChatSearchBar';
import { Composer } from './Composer';
```

replace

```ts
  /** Spec 2026-10-19 §4/§5: the message to bring into view (a search hit or a favorite). */
  focus?: TimelineFocus | null;
}
```

with

```ts
  /** Spec 2026-10-19 §4/§5: the message to bring into view (a search hit or a favorite). */
  focus?: TimelineFocus | null;
  /** Asks the page to focus a message (the search bar's hits). */
  onFocusMessage?: (messageId: string) => void;
}
```

replace

```ts
function ConversationPane({ chatId, contactPanelOpen, onToggleContactPanel, onOpenChat, focus = null }: ConversationViewProps) {
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: qk.chat(chatId), queryFn: () => api.chats.get(chatId) });
  const [replyTo, setReplyTo] = useState<MessageDto | null>(null);
```

with

```ts
function ConversationPane({
  chatId, contactPanelOpen, onToggleContactPanel, onOpenChat, focus = null, onFocusMessage,
}: ConversationViewProps) {
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: qk.chat(chatId), queryFn: () => api.chats.get(chatId) });
  const [replyTo, setReplyTo] = useState<MessageDto | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
```

and replace

```tsx
      <ConversationHeader
        chat={chat}
        contactPanelOpen={contactPanelOpen}
        onToggleContactPanel={onToggleContactPanel}
        onOpenChat={onOpenChat}
      />
```

with

```tsx
      <ConversationHeader
        chat={chat}
        contactPanelOpen={contactPanelOpen}
        onToggleContactPanel={onToggleContactPanel}
        onOpenChat={onOpenChat}
        searchOpen={searchOpen}
        onToggleSearch={() => setSearchOpen((o) => !o)}
      />
      {searchOpen && (
        <ChatSearchBar chatId={chatId} onFocusMessage={(id) => onFocusMessage?.(id)} onClose={() => setSearchOpen(false)} />
      )}
```

- [ ] **Step 7: Hold the focus in the page and list the favorites in the panel**

Replace the whole content of `web/src/pages/Conversation.tsx` with:

```tsx
import { useState, useSyncExternalStore } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ConversationView } from '../components/conversation/ConversationView';
import type { TimelineFocus } from '../components/conversation/model';
import { ContactPanel } from '../components/contacts/ContactPanel';
import { api, qk } from '../lib/api';

// Wide enough for list + conversation + a 340px contact column.
const WIDE = '(min-width: 1280px)';
const wideNow = () => window.matchMedia?.(WIDE).matches ?? false; // jsdom has no matchMedia
function subscribeWide(onChange: () => void) {
  const mq = window.matchMedia?.(WIDE);
  mq?.addEventListener('change', onChange);
  return () => mq?.removeEventListener('change', onChange);
}

export default function ConversationPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const wide = useSyncExternalStore(subscribeWide, wideNow);
  const [contactPanelOpen, setContactPanelOpen] = useState(wideNow); // survives switching chats
  // Spec 2026-10-19 §4/§5: a search hit or a favorite to bring into view; it belongs to the chat it was asked in.
  const [focus, setFocus] = useState<(TimelineFocus & { chatId: string }) | null>(null);
  const chat = useQuery({ queryKey: qk.chat(id), queryFn: () => api.chats.get(id), enabled: !!id });
  const focusMessage = (messageId: string) => setFocus((f) => ({ chatId: id, messageId, seq: (f?.seq ?? 0) + 1 }));
  if (!id) return null;
  return (
    <div className="flex h-full min-w-0">
      <ConversationView
        chatId={id}
        contactPanelOpen={contactPanelOpen}
        onToggleContactPanel={() => setContactPanelOpen((o) => !o)}
        // sibling route, relative to the inbox path (works whatever prefix Task 16 registered)
        onOpenChat={(chatId) => navigate(`../${chatId}`, { relative: 'path' })}
        focus={focus?.chatId === id ? focus : null}
        onFocusMessage={focusMessage}
      />
      {contactPanelOpen && chat.data && (
        <ContactPanel
          contactId={chat.data.contact.id}
          chatId={id}
          docked={wide}
          onClose={() => setContactPanelOpen(false)}
          onJumpToMessage={focusMessage}
        />
      )}
    </div>
  );
}
```

In `web/src/components/contacts/ContactPanel.tsx`, replace

```ts
import { confirmDialog } from '../../lib/confirm';
```

with

```ts
import { confirmDialog } from '../../lib/confirm';
import { FavoritesList } from '../conversation/FavoritesList';
```

replace

```ts
  /** A column beside the conversation instead of a modal drawer (wide screens). */
  docked?: boolean;
}

export function ContactPanel({ contactId, chatId, onClose, docked = false }: Props) {
```

with

```ts
  /** A column beside the conversation instead of a modal drawer (wide screens). */
  docked?: boolean;
  /** Spec 2026-10-19 §5: a click in "Favoritas" brings that message into view. */
  onJumpToMessage?: (messageId: string) => void;
}

export function ContactPanel({ contactId, chatId, onClose, docked = false, onJumpToMessage }: Props) {
```

replace

```tsx
        {tab === 'chat' && chatId ? (
          <ChatDetailsTab chatId={chatId} />
```

with

```tsx
        {tab === 'chat' && chatId ? (
          <ChatDetailsTab
            chatId={chatId}
            onJump={(messageId) => {
              onJumpToMessage?.(messageId);
              if (!docked) onClose(); // a drawer covers the conversation: get out of the way
            }}
          />
```

replace

```tsx
function ChatDetailsTab({ chatId }: { chatId: string }) {
```

with

```tsx
function ChatDetailsTab({ chatId, onJump }: { chatId: string; onJump: (messageId: string) => void }) {
```

and replace

```tsx
  if (c.closedAt) rows.push(['Finalizada em', dateTime(c.closedAt)]);
  return <Rows rows={rows} />;
}
```

with

```tsx
  if (c.closedAt) rows.push(['Finalizada em', dateTime(c.closedAt)]);
  return (
    <div className="space-y-6">
      <Rows rows={rows} />
      <Section title="Favoritas">
        <FavoritesList chatId={chatId} onJump={onJump} />
      </Section>
    </div>
  );
}
```

- [ ] **Step 8: Run the tests and the type check**

Run: `npm test -w web -- src/components/conversation/ChatSearchBar.test.tsx src/components/conversation/FavoritesList.test.tsx src/components/conversation/ConversationHeader.test.tsx src/components/conversation/model.test.ts`
Expected: PASS.

Run: `npm test -w web` and `npm run typecheck -w web`
Expected: PASS and exit 0.

- [ ] **Step 9: Commit**

```bash
git add web/src/components/conversation/ChatSearchBar.tsx web/src/components/conversation/FavoritesList.tsx web/src/components/conversation/model.ts web/src/components/conversation/ConversationHeader.tsx web/src/components/conversation/ConversationView.tsx web/src/pages/Conversation.tsx web/src/components/contacts/ContactPanel.tsx web/src/components/conversation/ChatSearchBar.test.tsx web/src/components/conversation/FavoritesList.test.tsx web/src/components/conversation/ConversationHeader.test.tsx web/src/components/conversation/model.test.ts
git commit -m "feat(web): search inside the conversation and the Favoritas list that jump to the message" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 9: Preferences in the web (Enter, sounds, browser notifications, the page)

**Files:**
- Modify: `web/src/lib/auth.tsx` (imports at lines 1-5; new exports after `useCurrentUser`)
- Modify: `web/src/components/conversation/model.ts` (new export at the end)
- Modify: `web/src/components/conversation/Composer.tsx` (imports; the send key in `onKeyDown`)
- Modify: `web/src/lib/notify.tsx` (everything above `NotificationPermissionButton`)
- Modify: `web/src/components/layout/NotificationToasts.tsx` (imports; the browser notification)
- Create: `web/src/pages/settings/PreferencesSettings.tsx`
- Modify: `web/src/pages/settings/SettingsPage.tsx` (import; `SECTIONS`)
- Test: `web/src/lib/notify.test.ts` (create), `web/src/components/layout/NotificationToasts.test.tsx`, `web/src/components/conversation/Composer.test.tsx`, `web/src/components/conversation/model.test.ts`, `web/src/pages/settings/PreferencesSettings.test.tsx` (create)

**Interfaces:**
- Consumes: Task 1 `DEFAULT_PREFERENCES`, `UserPreferences`, `BrowserNotificationMode`; Task 5 the route; Task 6 `api.auth.setPreferences`.
- Produces: `usePreferences`, `preferencesOf`, `isSendKey`, `browserNotificationAllowed`, `messageAlerts`, `showBrowserNotification`, `PreferencesSettings`.

- [ ] **Step 1: Write the failing tests**

Create `web/src/lib/notify.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFERENCES, type UserPreferences } from '@talk/shared';
import { browserNotificationAllowed, messageAlerts } from './notify';

const p = (over: Partial<UserPreferences> = {}): UserPreferences => ({ ...DEFAULT_PREFERENCES, ...over });

describe('message alerts (spec 2026-10-19 §6)', () => {
  it('stays quiet for the chat being read in a visible tab (Review Focus 7)', () => {
    expect(messageAlerts(p({ browserNotifications: 'always' }), { hidden: false, chatOnScreen: true })).toEqual({
      sound: false, browser: false,
    });
  });

  it('beeps for another chat or a hidden tab while Sons is on, never with it off', () => {
    expect(messageAlerts(p(), { hidden: false, chatOnScreen: false }).sound).toBe(true);
    expect(messageAlerts(p(), { hidden: true, chatOnScreen: true }).sound).toBe(true);
    expect(messageAlerts(p({ sounds: false }), { hidden: true, chatOnScreen: false }).sound).toBe(false);
  });

  it('follows Sempre, Só quando a aba está em segundo plano and Nunca', () => {
    expect(messageAlerts(p({ browserNotifications: 'always' }), { hidden: false, chatOnScreen: false }).browser).toBe(true);
    expect(messageAlerts(p(), { hidden: false, chatOnScreen: false }).browser).toBe(false);
    expect(messageAlerts(p(), { hidden: true, chatOnScreen: true }).browser).toBe(true);
    expect(messageAlerts(p({ browserNotifications: 'never' }), { hidden: true, chatOnScreen: false }).browser).toBe(false);
    expect(browserNotificationAllowed('background', true)).toBe(true);
    expect(browserNotificationAllowed('never', true)).toBe(false);
  });
});
```

In `web/src/components/layout/NotificationToasts.test.tsx`, replace

```ts
import { QueryClient } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { NotificationDto } from '@talk/shared';
import { connectWs } from '../../lib/ws';
```

with

```ts
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { DEFAULT_PREFERENCES, type BrowserNotificationMode, type Me, type NotificationDto } from '@talk/shared';
import { qk } from '../../lib/api';
import { connectWs } from '../../lib/ws';
```

replace

```ts
function setup(permission: NotificationPermission) {
```

with

```ts
const ME: Me = {
  id: 'u1', name: 'Ana Lima', email: 'ana@teste.local', role: 'agent', signature: null, sectorIds: [], seeAllSectors: false, avatarUrl: null,
};

/** `mode`: the user's "Notificações do navegador" (spec 2026-10-19 §6); 'always' keeps the older tests' meaning. */
function setup(permission: NotificationPermission, mode: BrowserNotificationMode = 'always') {
```

replace

```tsx
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
```

with

```tsx
  stopWs = connectWs(new QueryClient(), 'ws://test/ws');
  const qc = new QueryClient();
  qc.setQueryData(qk.me, { ...ME, preferences: { ...DEFAULT_PREFERENCES, browserNotifications: mode } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/chats']}>
        <NotificationToasts />
        <Routes>
          <Route path="/chats" element={<p>Lista</p>} />
          <Route path="/chats/:id" element={<p>Conversa aberta</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
```

and append inside `describe('NotificationToasts', …)`, after its last test:

```ts
  it('"Nunca" keeps the toast and skips the browser notification (spec 2026-10-19 §6)', () => {
    setup('granted', 'never');
    emit({ type: 'notification', notification: NOTE });
    expect(screen.getByRole('link')).toBeTruthy();
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it('"Só quando a aba está em segundo plano" skips it while the tab is visible', () => {
    setup('granted', 'background'); // jsdom: document.hidden is false
    emit({ type: 'notification', notification: NOTE });
    expect(FakeNotification.instances).toHaveLength(0);
  });
```

In `web/src/components/conversation/Composer.test.tsx`, replace

```ts
import type { MessageDto, QuickAnswerDto } from '@talk/shared';
```

with

```ts
import { DEFAULT_PREFERENCES, type Me, type MessageDto, type QuickAnswerDto } from '@talk/shared';
```

and append inside `describe('Composer', …)`, after the `'Shift+Enter keeps the newline and sends nothing'` test:

```ts
  it('with "Enter envia a mensagem" off, Enter breaks the line and Ctrl+Enter sends (spec 2026-10-19 §6)', async () => {
    stubFetch({ 'POST /api/chats/c1/messages': message() });
    const { qc } = renderComposer();
    const me: Me = {
      id: 'u1', name: 'Ana', email: 'ana@teste.local', role: 'agent', signature: null, sectorIds: [], seeAllSectors: false,
      avatarUrl: null, preferences: { ...DEFAULT_PREFERENCES, enterSends: false },
    };
    qc.setQueryData(qk.me, me);
    fireEvent.change(box(), { target: { value: 'linha 1' } });
    expect(fireEvent.keyDown(box(), { key: 'Enter' })).toBe(true); // not prevented → the browser breaks the line
    expect(posts('/api/chats/c1/messages')).toEqual([]);
    expect(fireEvent.keyDown(box(), { key: 'Enter', ctrlKey: true })).toBe(false);
    await waitFor(() => expect(posts('/api/chats/c1/messages').map((c) => c.body)).toEqual([{ text: 'linha 1', signature: true }]));
  });
```

In `web/src/components/conversation/model.test.ts`, replace

```ts
  olderCursor, previewText, resultsLabel,
} from './model';
```

with

```ts
  isSendKey, olderCursor, previewText, resultsLabel,
} from './model';
```

and append at the end of the file:

```ts
describe('isSendKey (spec 2026-10-19 §6)', () => {
  const key = (over: Partial<{ key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; composing: boolean }> = {}) => ({
    key: over.key ?? 'Enter', shiftKey: !!over.shiftKey, ctrlKey: !!over.ctrlKey, metaKey: !!over.metaKey,
    nativeEvent: { isComposing: !!over.composing },
  });

  it('on: Enter sends, Shift+Enter does not; off: only Ctrl or Cmd+Enter sends; never while composing', () => {
    expect(isSendKey(key(), true)).toBe(true);
    expect(isSendKey(key({ shiftKey: true }), true)).toBe(false);
    expect(isSendKey(key(), false)).toBe(false);
    expect(isSendKey(key({ ctrlKey: true }), false)).toBe(true);
    expect(isSendKey(key({ metaKey: true }), false)).toBe(true);
    expect(isSendKey(key({ composing: true }), true)).toBe(false);
    expect(isSendKey(key({ key: 'a' }), true)).toBe(false);
  });
});
```

Create `web/src/pages/settings/PreferencesSettings.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DEFAULT_PREFERENCES, type Me, type UserPreferences } from '@talk/shared';
import { qk } from '../../lib/api';
import { PreferencesSettings } from './PreferencesSettings';

const ME: Me = {
  id: 'u1', name: 'Ana Lima', email: 'ana@teste.local', role: 'agent', signature: null, sectorIds: [], seeAllSectors: false,
  avatarUrl: null, preferences: { ...DEFAULT_PREFERENCES },
};
const calls: Array<{ method: string; path: string; body: unknown }> = [];
let saved: UserPreferences;

beforeEach(() => {
  calls.length = 0;
  saved = { ...DEFAULT_PREFERENCES };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ method, path, body });
      if (method === 'PUT' && path === '/api/auth/me/preferences') {
        saved = { ...saved, ...body };
        return new Response(JSON.stringify({ ...ME, preferences: saved }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: 'inesperado' }), { status: 500 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('saves each change at once, only the field that changed (spec 2026-10-19 §6)', async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  qc.setQueryData(qk.me, ME);
  render(
    <QueryClientProvider client={qc}>
      <PreferencesSettings />
    </QueryClientProvider>,
  );

  const enter = screen.getByRole('checkbox', { name: /Enter envia a mensagem/ }) as HTMLInputElement;
  expect(enter.checked).toBe(true);
  expect((screen.getByRole('radio', { name: 'Só quando a aba está em segundo plano' }) as HTMLInputElement).checked).toBe(true);

  fireEvent.click(enter);
  await waitFor(() => expect(enter.checked).toBe(false));
  fireEvent.click(screen.getByRole('radio', { name: 'Nunca' }));
  fireEvent.click(screen.getByRole('checkbox', { name: /Sons/ }));

  await waitFor(() =>
    expect(calls.map((c) => c.body)).toEqual([{ enterSends: false }, { browserNotifications: 'never' }, { sounds: false }]),
  );
  expect(calls.every((c) => c.method === 'PUT' && c.path === '/api/auth/me/preferences')).toBe(true);
  await waitFor(() =>
    expect(qc.getQueryData<Me>(qk.me)?.preferences).toEqual({ enterSends: false, sounds: false, browserNotifications: 'never' }),
  );
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w web -- src/lib/notify.test.ts src/components/layout/NotificationToasts.test.tsx src/components/conversation/Composer.test.tsx src/components/conversation/model.test.ts src/pages/settings/PreferencesSettings.test.tsx`
Expected: FAIL: `messageAlerts is not a function`, the toasts still raise a browser notification under 'never', Enter still sends with `enterSends: false`, `isSendKey is not a function`, `PreferencesSettings.tsx` does not exist.

- [ ] **Step 3: Read the preferences**

In `web/src/lib/auth.tsx`, replace

```ts
import type { Me } from '@talk/shared';
```

with

```ts
import { DEFAULT_PREFERENCES, type Me, type UserPreferences } from '@talk/shared';
```

and after the `useCurrentUser` function add:

```ts
/** The signed-in user's preferences over the defaults (spec 2026-10-19 §6). Reactive; only valid below <RequireAuth>. */
export function usePreferences(): UserPreferences {
  return { ...DEFAULT_PREFERENCES, ...useCurrentUser().preferences };
}

/** The same, read from the cache at the moment of use (a key press, a WebSocket event); the defaults before login. */
export function preferencesOf(qc: QueryClient): UserPreferences {
  return { ...DEFAULT_PREFERENCES, ...qc.getQueryData<Me | null>(qk.me)?.preferences };
}
```

In `web/src/components/conversation/model.ts`, append at the end of the file:

```ts
/** Spec 2026-10-19 §6 "Enter envia a mensagem": on, Enter sends (Shift+Enter breaks the line); off, Ctrl/Cmd+Enter sends. */
export function isSendKey(
  e: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; nativeEvent: { isComposing: boolean } },
  enterSends: boolean,
): boolean {
  if (e.key !== 'Enter' || e.nativeEvent.isComposing) return false;
  return enterSends ? !e.shiftKey : e.ctrlKey || e.metaKey;
}
```

- [ ] **Step 4: The composer follows "Enter envia a mensagem"**

In `web/src/components/conversation/Composer.tsx`, replace

```ts
import { api, botRunningRuns, qk } from '../../lib/api';
```

with

```ts
import { api, botRunningRuns, qk } from '../../lib/api';
import { preferencesOf } from '../../lib/auth';
```

replace

```ts
import { errorMessage, previewText } from './model';
```

with

```ts
import { errorMessage, isSendKey, previewText } from './model';
```

and replace

```ts
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
```

with

```ts
    // read at the key press: the composer stays mounted while the preference changes on another page
    if (isSendKey(e, preferencesOf(qc).enterSends)) {
      e.preventDefault();
      void send();
    }
```

- [ ] **Step 5: Sounds and browser notifications by preference**

In `web/src/lib/notify.tsx`, replace everything above `/** Avatar-menu item that asks the browser for notification permission. */` with:

```tsx
import { useEffect, useRef, useState } from 'react';
import { useMatch, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { BrowserNotificationMode, UserPreferences } from '@talk/shared';
import { preferencesOf } from './auth';
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

/** "Notificações do navegador" (spec 2026-10-19 §6): Sempre, Só quando a aba está em segundo plano, Nunca. */
export function browserNotificationAllowed(mode: BrowserNotificationMode, hidden: boolean): boolean {
  return mode === 'always' || (mode === 'background' && hidden);
}

/** What a new contact message sets off. Nothing for the chat the user is reading in a visible tab. */
export function messageAlerts(
  prefs: UserPreferences,
  s: { hidden: boolean; chatOnScreen: boolean },
): { sound: boolean; browser: boolean } {
  const reading = s.chatOnScreen && !s.hidden;
  return { sound: prefs.sounds && !reading, browser: !reading && browserNotificationAllowed(prefs.browserNotifications, s.hidden) };
}

/** A browser notification, when the browser allows it, that focuses the tab and runs `open` on click. */
export function showBrowserNotification(title: string, body: string, tag: string, open: () => void): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const n = new Notification(title, { body, tag });
  n.onclick = () => {
    window.focus();
    open();
    n.close();
  };
}

/** Sound + browser notification for new contact messages, by the user's preferences. Mount once in the layout. */
export function useMessageNotifications(): void {
  const navigate = useNavigate();
  const qc = useQueryClient();
  // the chat on screen; through a ref so the subscription never restarts on navigation
  const openChatId = useMatch('/chats/:id')?.params.id;
  const openRef = useRef(openChatId);
  openRef.current = openChatId;
  useEffect(
    () =>
      onWsEvent((e) => {
        if (e.type !== 'message.created' || e.message.direction !== 'in') return;
        const { chatId, body } = e.message;
        const alerts = messageAlerts(preferencesOf(qc), { hidden: document.hidden, chatOnScreen: openRef.current === chatId });
        if (alerts.sound) beep();
        if (alerts.browser) {
          showBrowserNotification('Nova mensagem', body ? body.slice(0, 120) : 'Mídia recebida', chatId, () => navigate(`/chats/${chatId}`));
        }
      }),
    [navigate, qc],
  );
}

```

(`NotificationPermissionButton` below stays as it is.)

In `web/src/components/layout/NotificationToasts.tsx`, replace

```ts
import type { NotificationDto } from '@talk/shared';
import { useWsEvent } from '../../lib/ws';
```

with

```ts
import { useQueryClient } from '@tanstack/react-query';
import type { NotificationDto } from '@talk/shared';
import { preferencesOf } from '../../lib/auth';
import { browserNotificationAllowed, showBrowserNotification } from '../../lib/notify';
import { useWsEvent } from '../../lib/ws';
```

replace

```ts
  const navigate = useNavigate();
  const [items, setItems] = useState<NotificationDto[]>([]);
```

with

```ts
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [items, setItems] = useState<NotificationDto[]>([]);
```

and replace

```ts
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const browser = new Notification(titleOf(n), { body: n.text, tag: n.id });
    browser.onclick = () => {
      window.focus();
      navigate(`/chats/${n.chatId}`);
      browser.close();
    };
```

with

```ts
    // Spec 2026-10-19 §6: the browser notification follows the user's choice; the toast above always shows.
    if (browserNotificationAllowed(preferencesOf(qc).browserNotifications, document.hidden)) {
      showBrowserNotification(titleOf(n), n.text, n.id, () => navigate(`/chats/${n.chatId}`));
    }
```

- [ ] **Step 6: The Preferences page**

Create `web/src/pages/settings/PreferencesSettings.tsx`:

```tsx
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DEFAULT_PREFERENCES, type BrowserNotificationMode, type Me, type UserPreferences } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { usePreferences } from '../../lib/auth';
import { NotificationPermissionButton } from '../../lib/notify';
import { ErrorText, Section } from '../../components/settings/common';

const MODES: Array<{ value: BrowserNotificationMode; label: string }> = [
  { value: 'always', label: 'Sempre' },
  { value: 'background', label: 'Só quando a aba está em segundo plano' },
  { value: 'never', label: 'Nunca' },
];

function Toggle(props: { label: string; hint: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="flex items-start gap-3">
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(e) => props.onChange(e.target.checked)}
        className="mt-0.5 size-4 accent-primary"
      />
      <span>
        <span className="block text-sm font-medium">{props.label}</span>
        <span className="block text-xs text-muted">{props.hint}</span>
      </span>
    </label>
  );
}

/** Spec 2026-10-19 §6: every user's own choices. Each change saves at once, only the field that changed. */
export function PreferencesSettings() {
  const qc = useQueryClient();
  const prefs = usePreferences();
  const save = useMutation({
    mutationFn: (patch: Partial<UserPreferences>) => api.auth.setPreferences(patch),
    // optimistic: the control flips now; the answer (or a refetch after an error) settles it
    onMutate: (patch) =>
      qc.setQueryData<Me | null>(qk.me, (me) => me && { ...me, preferences: { ...DEFAULT_PREFERENCES, ...me.preferences, ...patch } }),
    onSuccess: (me) => qc.setQueryData(qk.me, me),
    onError: () => void qc.invalidateQueries({ queryKey: qk.me }),
  });

  return (
    <Section title="Preferências">
      <div className="space-y-6">
        <Toggle
          label="Enter envia a mensagem"
          hint="Desligado: Enter quebra a linha e Ctrl+Enter envia."
          checked={prefs.enterSends}
          onChange={(enterSends) => save.mutate({ enterSends })}
        />
        <Toggle
          label="Sons"
          hint="Um bipe quando chega mensagem de um contato, menos na conversa que você está vendo."
          checked={prefs.sounds}
          onChange={(sounds) => save.mutate({ sounds })}
        />
        <fieldset>
          <legend className="text-sm font-medium">Notificações do navegador</legend>
          <div className="mt-2 space-y-1.5">
            {MODES.map((m) => (
              <label key={m.value} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="browser-notifications"
                  value={m.value}
                  checked={prefs.browserNotifications === m.value}
                  onChange={() => save.mutate({ browserNotifications: m.value })}
                  className="accent-primary"
                />
                {m.label}
              </label>
            ))}
          </div>
          <div className="-mx-3 mt-2">
            <NotificationPermissionButton />
          </div>
        </fieldset>
        <ErrorText error={save.error} />
      </div>
    </Section>
  );
}
```

In `web/src/pages/settings/SettingsPage.tsx`, replace

```ts
import { ProfileSettings } from './ProfileSettings';
```

with

```ts
import { ProfileSettings } from './ProfileSettings';
import { PreferencesSettings } from './PreferencesSettings';
```

and replace

```ts
  { path: 'perfil', label: 'Perfil', group: 'Você', adminOnly: false, page: ProfileSettings },
```

with

```ts
  { path: 'perfil', label: 'Perfil', group: 'Você', adminOnly: false, page: ProfileSettings },
  { path: 'preferencias', label: 'Preferências', group: 'Você', adminOnly: false, page: PreferencesSettings },
```

- [ ] **Step 7: Run the tests, the whole suite and the type check**

Run: `npm test -w web -- src/lib/notify.test.ts src/components/layout/NotificationToasts.test.tsx src/components/conversation/Composer.test.tsx src/components/conversation/model.test.ts src/pages/settings/PreferencesSettings.test.tsx`
Expected: PASS.

Run: `npm test`
Expected: PASS in `server` and `web`.

Run: `npm run typecheck`
Expected: exit 0 in all three workspaces.

- [ ] **Step 8: Commit**

```bash
git add web/src/lib/auth.tsx web/src/components/conversation/model.ts web/src/components/conversation/Composer.tsx web/src/lib/notify.tsx web/src/components/layout/NotificationToasts.tsx web/src/pages/settings/PreferencesSettings.tsx web/src/pages/settings/SettingsPage.tsx web/src/lib/notify.test.ts web/src/components/layout/NotificationToasts.test.tsx web/src/components/conversation/Composer.test.tsx web/src/components/conversation/model.test.ts web/src/pages/settings/PreferencesSettings.test.tsx
git commit -m "feat(web): Preferências page with Enter to send, sounds and browser notifications" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Manual acceptance (after Task 9)

Run against the dev server already running from this folder (do not start or stop it); follow spec §10. Two browser profiles help: one agent, one admin or a second agent of the same sector.

1. Write a note, edit it (tag "editada", versions), delete it; the other tab shows "Nota apagada por …" without a reload. As another agent, the note menu has no "Editar nota" nor "Apagar nota"; as admin, "Apagar nota" only.
2. In a long imported history chat, search "contrato" and "acao": "N resultados", ↑/↓ walk the hits, a far one opens the anchored view with the outline and "Ir para as mensagens recentes"; scroll down to the present and the button goes away.
3. Star a message in one tab: the star and the "Favoritas" entry show in the other tab; a click in "Favoritas" jumps to it (on a narrow window the drawer closes).
4. Turn "Enter envia a mensagem" off and send with Ctrl+Enter; with another chat open, a contact message beeps; with "Nunca", no browser notification (the chatbot toast still shows).
